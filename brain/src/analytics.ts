// Usage analytics to PostHog (docs/launch/contracts.md §5): counts, durations, enums, ids and versions only, never
// what was said, anything from a thread, a path or an error's message. Runs on Node and in a Durable Object alike: it
// uses only fetch, crypto.randomUUID and timers, and `flush()` gives a DO a promise for `ctx.waitUntil()`.

export type Value = string | number | boolean | null | string[];
export type Props = Record<string, Value | undefined>;
/** Sends one event for whoever this brain is serving (§5's events). */
export type Track = (event: string, props?: Props) => void;

export type AnalyticsOptions = {
  /** The project's capture key (`phc_…`). Empty: nothing is ever sent. */
  key: string;
  host: string;
  env: string;
  runtime: "lattice" | "durable_object";
  brainRev: string;
  /** The account's mode on every event; a function when it can change while the brain runs (a cloud account setting its own key). */
  mode: string | (() => string);
  /** The account's allowance label (`tester`, `presenter`) on every event, when it has one (a cloud account). */
  allowance?: () => string | null;
  /** The account's consent (`ConsentHolder`), shared with its owner, who changes it; a fresh one (sharing) if not given. */
  consent?: ConsentHolder;
  log: (m: string) => void;
  fetch?: typeof fetch;
  /** How long the first queued event waits for others before a batch goes (default 10 s). */
  flushMs?: number;
  /** A batch goes at once at this many events (default 50). */
  batchSize?: number;
  /** Past this many waiting (PostHog unreachable), the oldest are dropped (default 1000). */
  maxQueue?: number;
};

type Event = { event: string; distinct_id: string; uuid: string; timestamp: string; properties: Record<string, unknown> };

/** A distinct id as the phone sends it: PostHog's anonymous UUID, or a Clerk user id after sign-in. */
const DISTINCT_ID = /^[\w.:@-]{1,128}$/;

/** The account's analytics consent as it's kept (contracts §5): see `ConsentHolder`. */
export type Consent = { off: boolean; explicit: boolean; seq: number };
/** A `PUT /api/analytics`'s place: which arrival it was, and the consent's number then. */
export type Ticket = { arrival: number; seq: number };

/**
 * An account's analytics consent (contracts §5), one per account object, made before anything else in it. Changed only
 * synchronously, as each request arrives (never after an await, so a request that started earlier can't land later),
 * and read by `Analytics.track` when each event is recorded.
 *
 * - `heard(header)`: a request's `x-driver-analytics`. `off` turns it off at once; an id shares again only for an account
 *   whose phone never used `PUT /api/analytics` (`explicit`: an older app goes by its last header).
 * - `PUT /api/analytics`: `next()` as it arrives, then `set(share, ticket)` once its body is read, which counts only if
 *   nothing changed in between (an `off` from any request, or a later `PUT`).
 * - `adopt(off, seq)`: what the account's brain says, in its Demo object; an older one is ignored.
 *
 * `seq` moves on with every change; `onChange` is told after each, to keep the latest or pass it on.
 */
export class ConsentHolder {
  off = false;
  explicit = false;
  seq = 0;
  onChange: (() => void) | null = null;

  get value(): Consent {
    return { off: this.off, explicit: this.explicit, seq: this.seq };
  }

  restore(kept: Consent | null) {
    if (kept) [this.off, this.explicit, this.seq] = [kept.off, kept.explicit, kept.seq];
  }

  heard(header: unknown) {
    if (header === "off") this.change(true, this.explicit);
    else if (typeof header === "string" && DISTINCT_ID.test(header) && !this.explicit && this.off) this.change(false, false);
  }

  /** `PUT /api/analytics` arrivals so far: a later one wins over an earlier one whose body is read last. */
  private arrivals = 0;

  /** A `PUT /api/analytics` arriving: its ticket for `set`. It changes nothing, so `seq` (the number passed on with
   *  the consent) only ever names a consent that was committed. */
  next(): Ticket {
    return { arrival: ++this.arrivals, seq: this.seq };
  }

  /** The `PUT`'s choice, once its body is read: false (ignored) when a later `PUT` arrived or anything changed since
   *  its `next()`. Committed as a change of its own number. */
  set(share: boolean, ticket: Ticket): boolean {
    if (ticket.arrival !== this.arrivals || ticket.seq !== this.seq) return false;
    this.change(!share, true);
    return true;
  }

  /** The account's consent as its brain passed it on: each change has its own number, so one not newer is old news. */
  adopt(off: boolean, seq: number) {
    if (seq <= this.seq) return;
    [this.off, this.explicit, this.seq] = [off, true, seq];
    this.onChange?.();
  }

  private change(off: boolean, explicit: boolean) {
    [this.off, this.explicit] = [off, explicit];
    this.seq++;
    this.onChange?.();
  }
}

export class Analytics {
  private readonly o: Required<Omit<AnalyticsOptions, "fetch" | "allowance" | "consent">> & Pick<AnalyticsOptions, "allowance"> & { fetch: typeof fetch };
  /** The distinct id the phone gave last (`x-driver-analytics`). */
  private phoneId: string | null = null;
  /** The account's consent, read at each event (`ConsentHolder`): its owner changes it, never this. */
  readonly consent: ConsentHolder;
  /** The verified account (the Clerk user id), which wins over the phone's id. */
  private accountId: string | null = null;
  private appBuild: string | null = null;
  private queue: Event[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();

  constructor(options: AnalyticsOptions) {
    this.o = { flushMs: 10_000, batchSize: 50, maxQueue: 1000, fetch: (...a) => fetch(...a), ...options, host: options.host.replace(/\/+$/, "") };
    this.consent = options.consent ?? new ConsentHolder();
  }

  get enabled(): boolean {
    return this.o.key !== "";
  }

  /** Who events are about now: null when there's nobody to say (no id yet) or they opted out. */
  get person(): string | null {
    return this.consent.off ? null : (this.accountId ?? this.phoneId);
  }

  /**
   * Who a request says events are about (`x-driver-analytics`, an id) and the phone's build (`x-driver-build`). Its
   * consent isn't this's to change: the account object's `ConsentHolder` takes it as the request arrives.
   */
  heard(header: unknown, appBuild?: string | null) {
    if (appBuild) this.appBuild = appBuild;
    if (typeof header === "string" && header !== "off" && DISTINCT_ID.test(header)) this.phoneId = header;
  }

  /** The account this brain belongs to, from its verified token (a cloud brain); the phone's id is then only a fallback. */
  account(userId: string | null) {
    this.accountId = userId;
  }

  readonly track: Track = (event, props = {}) => {
    const who = this.person;
    // The account's consent as it is now, when the event is recorded (`person`): the one check (contracts §5).
    if (!this.enabled || !who) return;
    const properties: Record<string, unknown> = {
      source: "brain", env: this.o.env, runtime: this.o.runtime, brain_rev: this.o.brainRev, mode: typeof this.o.mode === "function" ? this.o.mode() : this.o.mode,
      ...(this.appBuild ? { app_build: this.appBuild } : {}),
      ...(this.o.allowance?.() ? { allowance: this.o.allowance() } : {}),
      $lib: "driver-brain", $geoip_disable: true,
    };
    for (const [k, v] of Object.entries(props)) if (v !== undefined) properties[k] = v;
    properties.distinct_id = who;
    if (this.queue.length >= this.o.maxQueue) this.queue.shift();
    this.queue.push({ event, distinct_id: who, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), properties });
    if (this.queue.length >= this.o.batchSize) void this.flush();
    else this.timer ??= unref(setTimeout(() => void this.flush(), this.o.flushMs));
  };

  /** An error for PostHog's Error Tracking: its type, code and stack frames, never its message (§5 Errors). */
  exception(area: string, error: unknown, props: Props = {}) {
    this.track("$exception", { ...props, area, $exception_list: exceptionList(error) as unknown as Value });
  }

  /** Sends what's waiting. Never rejects; a batch that fails twice is dropped with a log line (no payload). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue.splice(0);
    if (!batch.length) return this.sending;
    this.sending = this.sending.then(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await this.o.fetch(`${this.o.host}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ api_key: this.o.key, batch }),
          });
          if (res.ok) return;
          // A batch PostHog refuses as malformed won't be taken on a retry either.
          if (res.status >= 400 && res.status < 500) return this.o.log(`analytics: PostHog refused ${batch.length} events (${res.status})`);
          if (attempt === 2) this.o.log(`analytics: dropped ${batch.length} events (PostHog answered ${res.status})`);
        } catch (e) {
          if (attempt === 2) this.o.log(`analytics: dropped ${batch.length} events (${e instanceof Error ? e.name : "error"})`);
        }
      }
    });
    return this.sending;
  }
}

function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/**
 * PostHog's `$exception_list` for an error: its class or code as the type, its code (or "withheld") as the value, and
 * V8's stack as frames, oldest first, each file named from the repository (`src/voice/session.ts`), never a home
 * directory. The message is left out: it can quote a thread's title, a path or what was said.
 */
export function exceptionList(error: unknown) {
  const e = error instanceof Error ? (error as Error & { code?: unknown; status?: unknown }) : null;
  const code = typeof e?.code === "string" ? e.code : null;
  const status = typeof e?.status === "number" ? e.status : null;
  const type = e ? (code ?? (status ? `${e.name} ${status}` : e.name)) : typeof error;
  const frames = (e?.stack ?? "").split("\n").flatMap((line) => {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) return [];
    const filename = repoPath(m[2]);
    return [{ platform: "node:javascript", function: m[1] ?? "<anonymous>", filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: filename.startsWith("src/") }];
  }).reverse();
  return [{ type, value: code ?? (status ? String(status) : "withheld"), mechanism: { handled: true, synthetic: false }, stacktrace: { type: "raw", frames } }];
}

/** A stack frame's file as the repository names it: `src/…` for the brain's own, else the module's name alone. */
function repoPath(file: string): string {
  const path = file.replace(/^file:\/\//, "");
  const own = /\/brain\/(src\/.+)$/.exec(path) ?? /^.*?\/(src\/[^/].+)$/.exec(path);
  if (own && !path.includes("/node_modules/")) return own[1];
  const mod = /\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
  if (mod) return `node_modules/${mod[1]}`;
  return path.startsWith("node:") ? path : (path.split("/").pop() ?? "unknown");
}

/** What the rest of the brain uses: the `Analytics` itself, or a view of it that adds properties (`tagged`). */
export type AnalyticsSink = Pick<Analytics, "track" | "exception" | "heard">;

/** The same person and queue, with `extra` on every event: a demo world's events say `mode: "demo"`. */
export function tagged(sink: AnalyticsSink, extra: Props): AnalyticsSink {
  return {
    track: (event, props = {}) => sink.track(event, { ...props, ...extra }),
    exception: (area, error, props = {}) => sink.exception(area, error, { ...props, ...extra }),
    heard: (header, appBuild) => sink.heard(header, appBuild),
  };
}
