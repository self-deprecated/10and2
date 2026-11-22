import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./store.ts";
import { validZone } from "./zone.ts";

/**
 * Which brain this is: the revision Nix baked into the package (`revision`, next to `src/`), or else the commit of the
 * checkout it runs from, or "dev". Read once at start.
 */
export function brainRev(root = fileURLToPath(new URL("..", import.meta.url).href)): string {
  try {
    const baked = readFileSync(join(root, "revision"), "utf8").trim();
    if (baked) return baked;
  } catch {}
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}
/** Runs `f` over `xs` with at most `n` in flight. */
export async function mapLimit<T>(xs: T[], n: number, f: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) {
      const k = i++;
      await f(xs[k], k);
    }
  }));
}

/** Runs at most `n` of the calls given to it at once; the rest wait their turn. */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await f();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** A pending timer, as `Clock` hands it out. */
export type Timer = { unref(): unknown };

/** Time and timers for a voice session and the waits: tests move a fake one on instead of sleeping. */
export type Clock = {
  now(): number;
  setTimeout(f: () => void, ms: number): Timer;
  setInterval(f: () => void, ms: number): Timer;
  clear(t: Timer): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  setInterval: (f, ms) => setInterval(f, ms),
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
};

/** The first try again after a timed step threw (docs/launch/engine.md §7, "No hot loops"). */
export const BACKOFF_MS = 5_000;
/** The longest wait between tries of a step that keeps throwing. */
export const BACKOFF_MAX_MS = 5 * 60_000;
/** The backoff after another failed try, from the one before (0 for none): 5 s doubling to 5 minutes. */
export const backoffAfter = (prev: number) => (prev > 0 ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_MS);

/**
 * Due times a wake left due (docs/launch/engine.md §7, "No hot loops", for every due time at once): one still due after
 * a wake at or after it (nothing delivered, dropped, deferred or moved later) wakes nothing again before a backoff, 5 s
 * doubling to 5 minutes, and is logged once; one that moves or goes is progress, and its backoff goes with it. The
 * engine's and the Ringer's `due()` hold their times to it, so neither their timers nor the cloud's alarm can spin on a
 * time nothing moves, whatever the reason. A wake still looks at everything due; only when to wake is held. The held
 * times (each due time, its next wake and its backoff) are kept in the store (`stuck_<who>`) and read back when it's
 * made, as the alarm keeps its own backoff, so a restart, or the cloud's object evicted between alarms, goes on with the
 * backoff instead of starting it over at 5 s.
 */
export class Stuck {
  private readonly held = new Map<number, { backoff: number; until: number }>();
  private readonly who: string;
  private readonly log: (m: string) => void;
  private readonly kv: Pick<Store, "get" | "set">;
  private readonly key: string;
  /** The row as last read or written: an unchanged one isn't written again. */
  private saved: string;

  /** `now`: when it's built, so a row read back holds nothing longer than the longest backoff from then (a damaged row, or a
   * clock gone back since it was written, can't hold a due time for longer). */
  constructor(who: string, log: (m: string) => void, kv: Pick<Store, "get" | "set">, now: number) {
    this.who = who;
    this.log = log;
    this.kv = kv;
    this.key = `stuck_${who}`;
    this.saved = "[]";
    try {
      this.saved = kv.get(this.key) ?? "[]";
      const rows: unknown = JSON.parse(this.saved);
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r && [r.at, r.backoff, r.until].every(Number.isFinite)) {
          this.held.set(r.at, { backoff: Math.min(r.backoff, BACKOFF_MAX_MS), until: Math.min(r.until, now + BACKOFF_MAX_MS) });
        }
      }
    } catch (e) {
      // Unreadable, nothing is held: each time a wake leaves due starts at 5 s again, and the next wake writes the row anew.
      this.log(`${who}: couldn't read what was held (${describe(e)})`);
    }
  }

  /** A wake at `woke` is over: `times`, every due time as it left them (before any backoff), read at `now`. */
  woke(times: readonly number[], woke: number, now: number) {
    const left = new Set(times.filter((t) => t <= woke));
    for (const t of [...this.held.keys()]) if (!left.has(t)) this.held.delete(t);
    for (const t of left) {
      const had = this.held.get(t);
      const backoff = backoffAfter(had?.backoff ?? 0);
      if (!had) this.log(`${this.who}: what was due at ${new Date(t).toISOString()} is still due after a look; looked at again in ${backoff / 1000} s, then less often`);
      this.held.set(t, { backoff, until: now + backoff });
    }
    const row = JSON.stringify([...this.held].map(([at, { backoff, until }]) => ({ at, backoff, until })));
    if (row === this.saved) return;
    this.kv.set(this.key, row);
    this.saved = row;
  }

  /** `times`, each one a wake left due no sooner than its backoff. */
  hold(times: readonly number[]): number[] {
    return times.map((t) => Math.max(t, this.held.get(t)?.until ?? t));
  }
}

/** How long ago, for the ear: "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
/** This machine as it's said: its host name, capitalized ("Lattice"). */
export function spokenHost(): string {
  const here = hostname().split(".")[0];
  return here.charAt(0).toUpperCase() + here.slice(1);
}

export function ago(at: string | number, now: number): string {
  const m = Math.round((now - (typeof at === "number" ? at : Date.parse(at))) / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} ${h === 1 ? "hour" : "hours"} ago` : `${Math.round(h / 24)} days ago`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A moment's calendar day, weekday and time of day in `zone`. */
function local(at: number, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const [year, month, day, hour, minute] = [parts.year, parts.month, parts.day, parts.hour, parts.minute].map(Number);
  // The day as a count of days, so two moments' days are told apart by subtraction, across a DST change too.
  const days = Date.UTC(year, month - 1, day) / 86_400_000;
  return { year, month, day, hour: hour % 24, minute, days, weekday: new Date(days * 86_400_000).getUTCDay() };
}

/**
 * When something happened, for the ear, in the time zone of the computer it happened on: "just now", "12 minutes ago",
 * "today at 4 PM", "yesterday at 8:05 AM", "on Monday at 4 PM" (within the last 6 days), "on 3 November" (and the year,
 * when it isn't this one). Without a zone, how long ago (`ago`): "20 hours ago".
 */
export function spokenWhen(at: string | number, now: number, zone: string | null | undefined): string {
  const t = typeof at === "number" ? at : Date.parse(at);
  const z = validZone(zone);
  if (!z) return ago(t, now);
  const m = Math.round((now - t) / 60_000);
  if (m < 2) return "just now";
  if (now - t < 3600_000) return `${Math.min(m, 59)} minutes ago`;
  const then = local(t, z);
  const today = local(now, z);
  const clock = `${then.hour % 12 || 12}${then.minute ? `:${String(then.minute).padStart(2, "0")}` : ""} ${then.hour < 12 ? "AM" : "PM"}`;
  const back = today.days - then.days;
  if (back <= 0) return `today at ${clock}`;
  if (back === 1) return `yesterday at ${clock}`;
  if (back <= 6) return `on ${WEEKDAYS[then.weekday]} at ${clock}`;
  return `on ${then.day} ${MONTHS[then.month - 1]}${then.year === today.year ? "" : ` ${then.year}`}`;
}

/**
 * An error for the log. Socket failures often have no message of their own: Node's `AggregateError` keeps the reasons in
 * `errors` (one per address tried), and the OpenAI SDK copies the empty message and keeps the original in `cause`.
 * Credentials that a nested message can quote (a URL's password, a token in its query, a bearer token) are masked, and
 * describing never throws, so it can't hide the failure it describes.
 */
export function describe(e: unknown): string {
  try {
    return redact(explain(e, 0));
  } catch {
    return "(an error that couldn't be described)";
  }
}

function explain(e: unknown, depth: number): string {
  if (!(e instanceof Error)) return String(e);
  const { code, errors, cause } = e as Error & { code?: unknown; errors?: unknown[]; cause?: unknown };
  let text = e.message || (typeof code === "string" ? code : e.name);
  if (typeof code === "string" && !text.includes(code)) text += ` (${code})`;
  if (depth < 3 && Array.isArray(errors) && errors.length) text += `: ${errors.map((x) => explain(x, depth + 1)).join("; ")}`;
  else if (depth < 3 && cause !== undefined && cause !== e) text += `: ${explain(cause, depth + 1)}`;
  return text;
}

/** A query parameter that holds a credential: the name has one of these as a whole word ("auth[token]", "api_key"). */
const SECRET_PARAM =
  /(?:^|[^a-z])(?:access_?token|token|api_?key|key|secret|password|passwd|pwd|auth|authorization|cookie|sig|signature)(?:[^a-z]|$)/i;

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Names that hold a credential, case-insensitive, with `-`/`_` or camelCase: api_key, apiKey, x-api-key, client_secret,
 * password/passwd/pwd, any *_token or *Token (access_token, refreshToken, id_token…), authorization, cookie/set-cookie,
 * secret, private_key, the access code. `redact` and the session recordings' field filter both use it. A name is one
 * word of at most 64 characters, so testing one takes no time.
 */
const CREDENTIAL_END = /(?:api[-_]?key|secret|password|passwd|pwd|token|authorization|cookie|private[-_]?key|access[-_]?code|driver[-_]access)$/i;
export const credentialName = (name: string) => name.length <= 64 && /^[\w-]+$/.test(name) && CREDENTIAL_END.test(name);

/** `name: value` or `name=value`, the name quoted or not: where a credential's value may follow. */
const KEYED = /(?<![\w-])(["']?)([\w-]{1,64})\1([ \t]*[:=][ \t]*)/g;
/** Header names whose whole value is the credential (an auth scheme and its credential, every cookie). */
const WHOLE_HEADER = /(?:authorization|cookie)$/i;

/**
 * Where a credential's value starting at `i` ends. A quoted value is the whole quoted string, escapes and all. As a
 * header (`Authorization: …`, `Cookie: …`) it runs to the end of the line, or to the quote the header sits in
 * (`-H 'Authorization: …'`); as prose (`password: two words`) to the end of the line, sentence or clause; given with
 * `=` (`api_key=…`) to the next space or separator. One pass over the value, so the whole of `redact` stays linear.
 */
function valueEnd(text: string, i: number, name: string, colon: boolean, outer: string | undefined): number {
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === quote) return j + 1;
      else if (text[j] === "\n" || text[j] === "\r") return j;
    }
    return text.length;
  }
  const header = colon && WHOLE_HEADER.test(name);
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\n" || c === "\r" || c === outer) return j;
    if (!colon) {
      if (/[\s"'&,;}#]/.test(c)) return j;
    } else if (!header) {
      if (",;}]".includes(c)) return j;
      if (".!?".includes(c) && (j + 1 === text.length || /\s/.test(text[j + 1]))) return j;
    }
  }
  return text.length;
}

/** Masks the value of every `name: value` or `name=value` whose name is a credential's. */
function maskKeyed(text: string): string {
  let out = "";
  let from = 0;
  KEYED.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = KEYED.exec(text)); ) {
    const [all, quote, name, sep] = m;
    if (!credentialName(name)) continue;
    const start = m.index + all.length;
    // A header inside a quoted string ends at that string's closing quote.
    const before = text[m.index - 1];
    const end = valueEnd(text, start, name, sep.includes(":"), !quote && (before === '"' || before === "'") ? before : undefined);
    if (end === start) continue;
    const q = text[start] === '"' || text[start] === "'" ? text[start] : "";
    out += text.slice(from, start) + (q ? `${q}***${end - start > 1 && text[end - 1] === q ? q : ""}` : "***");
    from = KEYED.lastIndex = end;
  }
  return out + text.slice(from);
}

/** The most of one string `redact` looks at: the rest is cut, so no text, however odd, can hold up the brain. */
export const REDACT_MAX = 16 * 1024;

/** A string cut to `REDACT_MAX` at most, its marker ("[truncated N bytes]") included, so cutting it again changes nothing. */
export function truncate(text: string): string {
  if (text.length <= REDACT_MAX) return text;
  const keep = REDACT_MAX - 32;
  return `${copied(text.slice(0, keep))}[truncated ${Buffer.byteLength(text.slice(keep))} bytes]`;
}

/** A string in storage of its own: a slice of a long string would otherwise keep all of it in memory. */
export const copied = (text: string) => Buffer.from(text, "utf8").toString("utf8");

/**
 * Masks credentials a text may quote: URL userinfo, secret query parameters, keyed values (see `valueEnd`), bearer,
 * OpenAI and Stripe keys. Text past `REDACT_MAX` is cut first. Every rule is linear in the text's length.
 */
export function redact(text: string): string {
  return redactWhole(truncate(text));
}

/**
 * `redact` without the cut: for text that must be kept whole (a reply read out in full). The rules are linear, so this
 * is bounded by the text's own length; callers bound that.
 */
export function redactWhole(text: string): string {
  return maskKeyed(
    text
      // Userinfo runs to the authority's last "@": a password can contain one.
      .replace(/(\/\/)[^\s/?#]*@/g, "$1***@")
      .replace(/([?&])([^=&?\s#]+)=([^&\s#]*)/g, (all, sep, name, value) => (SECRET_PARAM.test(decoded(name)) && value ? `${sep}${name}=***` : all))
      .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1***"),
  )
    .replace(/\bsk-[\w-]{8,}/g, "sk-***")
    // Stripe's secret, restricted and webhook signing keys.
    .replace(/\b(sk|rk)_(live|test)_\w{8,}/g, "$1_$2_***")
    .replace(/\bwhsec_\w{8,}/g, "whsec_***")
    // OpenAI's ephemeral client secrets.
    .replace(/\bek_[\w-]{8,}/g, "ek_***");
}
