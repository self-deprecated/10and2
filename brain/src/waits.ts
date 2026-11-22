// "Call me back when it replies": the voice session hangs up, the phone holds, and the brain watches the threads until
// one of their runs is over. A wait covers one thread (wait_for, a pause) or every starred thread with news coming
// (when a conversation ends). One wait per conversation. Waits are kept in the store, so a brain restart (a deploy, a
// crash) picks them up again and the holding phone finds its wait when it next asks.
//
// Nothing here polls (docs/launch/engine.md §11, stage 3.2): a wait is looked at when it starts or changes, when a
// machine reports (`changed`, world.ts), when a holding phone asks (`until`), and at its own exact due times (`due`),
// which the engine keeps on its one timer and the cloud's alarm.
//
// Stage 3.6 (docs/launch/engine.md §11, item 6; Fable's decisions): a failed or stopped run is its own outcome, from
// the thread's status alone (never its words, §13); a call-back asked for in words watches as long as the level allows
// (its rule's `watchMs`, given by `start`'s caller), or the shorter length asked for; and it can wait for all of several
// threads, only for trouble or a failure, and not before a time of day (`Mode`).
//
// Stage 3.8 (§11 item 8; Fable's topics 13 to 16): time as a trigger. A deadline ("call me if it isn't done by 6") is a
// set end with only trouble: still working then is news, a failure, a stop or a question sooner, a clean finish nothing.
// A check-in ("call me at 3 about API") is news at its time, whatever the threads are doing, and nothing before. Both
// are one-off instants fixed when made; each thread's own clock ends there, not at the rule's length.
//
// Stage 3.10 (§11 item 10; Fable's decisions 3.10-A to 3.10-G): tests passed or failed, from the computer (the
// connector's `Report.checks` and `running`), never a reply's words. "Call me when API's tests pass" (`Mode.tests`) ends
// at a real pass after the change: looked at once a minute while the run that took your latest words goes on (its last
// test run passed, a file was changed before it in that run and none since), else at the run's end, on its final state,
// whatever that is; or sooner if it stops another way (a question, a failure, a stop), as it says when it's set up. A
// plain call-back's or an only-trouble watch's reply whose last test run or build failed says so, and on an only-trouble
// watch it's trouble.
import type { Adapter, Checks, Report, WorkItem } from "./adapter.ts";
import { greenAfterChange, red, testsOf, type PassRun, type TestsFact } from "./receipts.ts";
import type { Track } from "./analytics.ts";
import { headFor, headOf, MAX_WAIT_MS, todaysWatch, type Made, type RuleHead, type Watch } from "./rules.ts";
import type { Seen, Store } from "./store.ts";
import { describe, realClock, type Clock } from "./util.ts";
import { instantOf, validZone } from "./zone.ts";

/** `failed` (stage 3.6): a run whose status is failed or cancelled (`stopped` on its reply), never its words. */
export type Outcome = "finished" | "failed" | "question" | "never started" | "timed out";

/**
 * What a call-back asked for in words waits for beyond the first news (stage 3.6), each part only when asked: `until`
 * all of its threads (two or more); `only` trouble (a failure, a stop, a question, or still working when its time runs
 * out) or a failure (failed or stopped); not before a time on the user's clock (`notBefore`, a local date and time, read
 * in the phone's zone of the moment); `hours`, a length the user asked for; `notify`, never a call for its whole life:
 * agreed to as a notification (a not-before its watch can't reach, Fable's topic 4B; a statement or readback saying "I'll
 * send a notification"; Commute's day used, a plain ask too) or promised for the next call (the kept statement, "…and
 * tell you in your next call.", a notification only if Notifications are turned on meanwhile); `modal`, asked for with a
 * mode none of which is kept (4B's not-before, dropped for its notification), so its running out is still news (Fable,
 * topic 7). Older code ignores them.
 *
 * Stage 3.8: `deadline`, the instant a deadline falls (with `only: "trouble"`, so 3.6's code reads it as a trouble watch
 * of that length); `checkIn`, the instant a check-in falls. Each is fixed when made: a flight moves the clock, not it.
 */
export type Mode = {
  until?: "all";
  only?: "failed" | "trouble";
  notBefore?: { date: string; time: string };
  hours?: number;
  notify?: true;
  modal?: true;
  deadline?: number;
  checkIn?: number;
  /**
   * Stage 3.10: "call me when API's tests pass" (one thread): a real pass after the change, or the thread stopping before
   * one. Older code ignores it, so it's a plain call-back there (it calls at the run's end).
   */
  tests?: true;
  /**
   * Stage 3.4: "call me anyway" (Fable, topic 10): it rings through your hold-back lines and Quiet for a while. Older
   * code ignores it (it rings, having no hold-backs).
   */
  anyway?: true;
};

/** When a thread's watch ends: its deadline or check-in (stage 3.8), else its own start plus the rule's length. */
export function endOf(w: Wait, it: Watched, life: Watch = headOf(w).lifetime): number {
  return w.mode?.deadline ?? w.mode?.checkIn ?? (it.startedAt ?? w.startedAt) + life.watchMs;
}

/**
 * How a thread stands at its check-in (stage 3.8; Fable, topic 14), whatever it is: gone from the list (a reply seen,
 * `gone`, as `settle` has it), asking (a question open now, heard or not), still working ("timed out", holding a
 * command too: `settle`), a run ended since it was asked (finished, or failed or stopped), or not running since ("never
 * started": "API isn't running").
 */
export function standing(w: Watched, item: WorkItem | undefined): Outcome {
  if (!item) return "finished";
  if (item.pendingQuestion && !item.gate) return "question";
  if (item.status === "running" || item.gate) return "timed out";
  if (w.sawRunning || (item.lastRunAt != null && Date.parse(item.lastRunAt) > w.since)) return item.status === "failed" || item.status === "cancelled" ? "failed" : "finished";
  return "never started";
}

/**
 * Which computer an item's id is from: what it carries before "|" (machines.ts, the cloud's links.ts), or "" for the
 * brain's own machine's, which carry nothing.
 */
const machineOf = (id: string) => {
  const at = id.indexOf("|");
  return at < 0 ? "" : id.slice(0, at);
};

export type Watched = {
  itemId: string;
  handle: string;
  /** A run that finished after this counts as the reply: when the follow-up went, or the last reply already heard. */
  since: number;
  /** When this item was added; defaults to the wait's start for its original items. */
  startedAt?: number;
  /** The thread has been seen running since the wait began. */
  sawRunning: boolean;
  /** It was idle with subagents working when the wait began: it replies once they report back, so no start grace. */
  patient?: boolean;
  /** The open question the user has already heard: still being open isn't news. */
  heardQuestion?: string | null;
  /**
   * A thread the user asked to hear about (docs/launch/engine.md, stage 2a item 10): only these ring. `holdAfter` sets
   * it, false for the starred threads it merges in. Unset (a row from before, every other start) counts as asked.
   */
  asked?: boolean;
  /**
   * Stage 3.10, a tests watch: when this conversation's last follow-up to it went, if one did (however long ago), so a
   * run still going that it's queued behind isn't taken for its run. None: you asked about a thread already at work.
   */
  sentAt?: number;
  /**
   * Stage 3.10: its finished run's report as read (`runAt`, the run it was read for): that run's checks, and whether its
   * test runs could be read at all (its connector reads them, the report came, and it was that run's).
   */
  read?: { runAt: number; checks: Checks | null; readable: boolean };
  /** Stage 3.10: when its finished run's report was first found not yet that run's (T3 behind): read again a while. */
  unreadSince?: number;
};

export type Wait = {
  conversationId: string;
  /** What the phone shows: the thread's name, or how many starred threads. */
  handle: string;
  /** When the wait began: the default start for each item's grace and time limit. */
  startedAt: number;
  items: Watched[];
  /** Started for starred threads (not asked for): unstarring a thread drops it. */
  auto: boolean;
  /** Why the wait is over, once it is, and every thread with news at that moment, with what the news was. */
  ready: Outcome | null;
  /** When it was over: a call-back not made within `READY_MS` of this is dropped. */
  readyAt?: number;
  /** When the brain rang the phone for it (ring.ts), so it rings once. */
  rungAt?: number;
  /**
   * `gone`: the thread was missing from the list (closed, or a machine's partial view), not a reply seen. `stopped`: a
   * failed run whose status was cancelled ("was stopped"). `offline`: still working as last seen when its time ran out
   * or its check-in came, on a computer offline then (its name): whether it's still working isn't known (the Skeptic's
   * finding on 3.6 to 3.8). Older code reads it as still working. `late`: a deadline's thread whose run ended after the
   * deadline, seen by a look that came after it (a late wake, a restart): its outcome is "timed out", since it wasn't
   * done by then, but it's done now, and never said to be still working (the fourth review of 3.6 to 3.8). `held`: its
   * outcome is "timed out" while it holds a command for the user (Commands that wait, stage 4c): it's waiting for them,
   * never said to be still working (Fable's ruling on pass B1's review).
   */
  replies: (Watched & { outcome: Outcome; seen: Seen; gone?: boolean; stopped?: true; offline?: string; late?: true; held?: true; tests?: TestsFact; checks?: Checks; midRun?: true })[];
  /**
   * The rule this wait is (docs/launch/engine.md §10): written by `start` alone, and saved with the wait as it was read.
   * A row without one, or with one this version can't trust, is read as the rule it implies (`headOf`).
   */
  rule?: RuleHead;
  /** What it waits for beyond the first news, as asked for in words (stage 3.6); absent for a plain one. */
  mode?: Mode;
};

/**
 * A wait as the voice and the backend are told it: a goodbye's on several threads the user follows (`auto`) as how many
 * ("2 threads the user follows"), as the app says Follow (the stage 3 staging run), or by its one thread's name once
 * unfollowing leaves one; its `handle` ("2 starred threads") stays what the phone shows. Any other wait by its handle.
 */
export const toldHandle = (w: Pick<Wait, "handle" | "auto" | "items">) =>
  !w.auto || !w.items.length ? w.handle : w.items.length === 1 ? w.items[0].handle : `${w.items.length} threads the user follows`;

/** Stage 3.10: a tests watch's run still going is looked at this often (Fable, 3.10-A: once a minute). */
export const LOOK_MS = 60_000;
/** Stage 3.10: a finished run's report not yet that run's is read again this often, for at most `REREAD_MS`. */
export const REREAD_STEP_MS = 30_000;
export const REREAD_MS = 5 * 60_000;

/**
 * Stage 3.10: whether a wait words a reply by its run's checks (a failed last test run or build says so, 3.10-C): a tests
 * watch, and a call-back asked for that's plain (a length or a not-before only) or only for trouble (where such a reply
 * is trouble). Not starred threads at a goodbye, waiting for all, only a failure, a deadline or a check-in.
 */
export function readsChecks(w: Wait): boolean {
  if (w.auto || !headOf(w).ring) return false;
  const m = w.mode ?? {};
  return !!m.tests || (m.until === undefined && m.deadline === undefined && m.checkIn === undefined && (m.only === undefined || m.only === "trouble"));
}

/** A finished run's checks as read for a look, and whether its test runs could be read at all. */
type Ran = { checks: Checks | null; readable: boolean };
/** What one look found of a wait's threads' test runs (`Waits.receipts`). */
/** `greenNow`: a pass mid-run, its checks and its run (the review of 45ec9eccdf6f, F6: told later, that run's end is told). */
type Receipts = { greenNow: Map<string, { checks: Checks; run: PassRun }>; unread: Set<string>; ran: Map<string, Ran> };

/** The run a thread's current state is from, for its report (`lastRunAt`; 0 for none). */
const runOf = (item: WorkItem | undefined) => (item?.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0);

/**
 * Whether a report's reply is the run that just finished, so its checks are that run's (spike/run-receipts): one that
 * finished before the run did, or before the wait's `since`, is an older run's, its work system not caught up yet. A
 * report that says nothing of its reply is taken as it is.
 */
function caughtUp(rep: Report, it: Watched, runAt: number): boolean {
  if (!rep.reply) return true;
  const at = Date.parse(rep.reply.at);
  return !Number.isFinite(at) || (at >= it.since && (!runAt || at + 1000 >= runAt));
}

// Today's lifetime lives with the rule's head (rules.ts), which reads it; it's still importable from here.
export { MAX_WAIT_MS, READY_MS, START_GRACE_MS } from "./rules.ts";

/**
 * Whether one thread's wait is over, given its current state, over the rule's lifetime (`life`). Pure, for tests. A
 * command its computer holds (Commands that wait, stage 4c) is neither its question nor its end, as for following: the
 * hold is news of its own (engine.ts `watchHeld`), never rung for, and the thread, still at work, is watched on.
 */
export function settle(w: Watched, item: WorkItem | undefined, startedAt: number, now: number, life: Watch = todaysWatch()): Outcome | null {
  if (!item) return "finished";
  if (item.pendingQuestion && !item.gate && !(w.heardQuestion != null && w.heardQuestion === item.questionId)) return "question";
  const running = item.status === "running" || !!item.gate;
  if (!running && (w.sawRunning || (item.lastRunAt != null && Date.parse(item.lastRunAt) > w.since))) return item.status === "failed" || item.status === "cancelled" ? "failed" : "finished";
  const elapsed = now - (w.startedAt ?? startedAt);
  if (elapsed > life.watchMs) return "timed out";
  if (!running && !w.sawRunning && !w.patient && elapsed > life.graceMs) return "never started";
  return null;
}

/**
 * One thread's outcome as a wait that's only for trouble or a failure reads it (stage 3.6): what isn't news isn't an
 * outcome until the thread's time is out (`over`), and then it's over with nothing to tell (`quiet`). Trouble is a
 * failure, a stop, a question, or still working when its time runs out; a failure, only a failed or stopped run.
 */
export function inMode(o: Outcome | null, over: boolean, only: Mode["only"], running = false, redRun = false): Outcome | "quiet" | null {
  if (!only || o === null || o === "failed") return o;
  if (only === "trouble" && (o === "question" || (o === "timed out" && running))) return o;
  // Stage 3.10: a reply whose last test run or build failed on the computer is trouble, whatever it says.
  if (only === "trouble" && o === "finished" && redRun) return o;
  // A clean finish, or idle (one that replied before the wait, watched on from that reply), until its time is out.
  return over || o === "timed out" ? "quiet" : null;
}

/**
 * Which threads end the wait: every one with news (a reply, a failure or a question), so news arriving together is
 * told together. Otherwise the wait is over only once every thread has run out of time (the first is reported).
 * `until: "all"` (two or more threads, stage 3.6): a failure or a question from any ends it at once, with the replies in
 * so far; else once every thread is over, each one. `only`: only its news ends it (a wait every thread of which is
 * over quietly is the caller's to end with nothing).
 */
export function decide(outcomes: (Outcome | "quiet" | null)[], mode: Mode = {}): number[] {
  const at = (keep: (o: Outcome | "quiet" | null) => boolean) => outcomes.flatMap((o, i) => (keep(o) ? [i] : []));
  // A finish reaches here only as trouble (`inMode`: its last test run or build failed, stage 3.10).
  if (mode.only) return at((o) => o === "failed" || o === "question" || o === "timed out" || o === "finished");
  if (mode.until === "all" && outcomes.length > 1) {
    const early = at((o) => o === "failed" || o === "question");
    if (early.length) return [...early, ...at((o) => o === "finished")];
    return outcomes.every((o) => o !== null) ? at((o) => o !== "never started").concat(outcomes.every((o) => o === "never started") ? [0] : []) : [];
  }
  const news = at((o) => o === "finished" || o === "question" || o === "failed");
  if (news.length) return news;
  return outcomes.length && outcomes.every((o) => o !== null) ? [0] : [];
}

/**
 * Whether a wait was asked for with a mode, or watches longer than an hour: its running out is news (Fable, topic 7).
 * `notify` alone isn't a mode asked for: a plain hour agreed to as a notification (Commute's day used) still runs out
 * silently; 4B's, its not-before dropped for a notification, was asked with one (`modal`), so it tells.
 */
export function watchedLong(w: Wait): boolean {
  return Object.keys(w.mode ?? {}).some((k) => k !== "notify") || headOf(w).lifetime.watchMs > MAX_WAIT_MS;
}

/** The threads still working when a wait ran out, as it ended. */
export const stillWorking = (w: Wait) => w.replies.filter((r) => r.outcome === "timed out");

/**
 * When a wait may first reach the user (stage 3.6): its not-before on the clock in `zone` (the phone's now), or null
 * for none (no zone, or none asked: at once).
 */
export function notBeforeAt(w: Wait, zone: string | null | undefined): number | null {
  const nb = w.mode?.notBefore;
  const z = validZone(zone ?? undefined);
  return nb && z ? instantOf(nb.date, nb.time, z) : null;
}

const OUTCOMES: unknown[] = ["finished", "failed", "question", "never started", "timed out"] satisfies Outcome[];
const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const thread = (i: unknown) => record(i) && typeof i.itemId === "string" && typeof i.handle === "string";

/**
 * Why a saved wait (a row `Store.waits` passed) can't be watched, or null: every field the code reads, before it's
 * watched (docs/launch/engine.md §10). Fields a version may leave out are checked where present.
 */
function unwatchable(w: Wait): string | null {
  const bad = w.items.findIndex((i) => !(thread(i) && finite(i.since) && typeof i.sawRunning === "boolean" && (i.startedAt === undefined || finite(i.startedAt))
    && (i.patient === undefined || typeof i.patient === "boolean") && (i.heardQuestion === undefined || i.heardQuestion === null || typeof i.heardQuestion === "string")
    && (i.asked === undefined || typeof i.asked === "boolean") && (i.sentAt === undefined || finite(i.sentAt)) && (i.unreadSince === undefined || finite(i.unreadSince))
    && (i.read === undefined || (record(i.read) && finite(i.read.runAt) && typeof i.read.readable === "boolean" && (i.read.checks === null || record(i.read.checks))))));
  if (bad >= 0) return `its thread ${bad + 1} isn't one`;
  if (w.auto !== undefined && typeof w.auto !== "boolean") return `auto is ${JSON.stringify(w.auto)}`;
  if (w.ready != null && !OUTCOMES.includes(w.ready)) return `ready is ${JSON.stringify(w.ready)}`;
  if (w.readyAt !== undefined && !finite(w.readyAt)) return `readyAt is ${JSON.stringify(w.readyAt)}`;
  if (w.rungAt !== undefined && !finite(w.rungAt)) return `rungAt is ${JSON.stringify(w.rungAt)}`;
  if (!Array.isArray(w.replies) || !w.replies.every((r) => thread(r) && OUTCOMES.includes(r.outcome) && record(r.seen))) return "its replies aren't";
  if (w.mode !== undefined && !validMode(w.mode)) return `its mode is ${JSON.stringify(w.mode)}`;
  return null;
}

const clockTime = (x: unknown) => typeof x === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
const localDate = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);

/** A mode this version reads (stage 3.6). */
function validMode(m: unknown): m is Mode {
  if (!record(m)) return false;
  const nb = m.notBefore;
  return (m.until === undefined || m.until === "all") && (m.only === undefined || m.only === "failed" || m.only === "trouble")
    && (nb === undefined || (record(nb) && localDate(nb.date) && clockTime(nb.time))) && (m.hours === undefined || (finite(m.hours) && (m.hours as number) > 0))
    && (m.notify === undefined || m.notify === true) && (m.modal === undefined || m.modal === true) && (m.deadline === undefined || finite(m.deadline)) && (m.checkIn === undefined || finite(m.checkIn))
    && (m.tests === undefined || m.tests === true);
}

export class Waits {
  /** Bumped by every cancel: work that started before one checks it before starting a wait. */
  generation = 0;
  /** Whether a phone is holding for a conversation now (the Ringer sets it): a holding phone takes a wait as it's over. */
  held: (conversationId: string) => boolean = () => false;
  /**
   * A wait the user called off (their Stop, staying on, Stop in Watching), or a thread unstarred out of one (`itemId`):
   * what its rule queued and hasn't told goes with it (the engine sets it, engine.ts). Not for a wait taken (its
   * call-back owns its news), told, or kept past its own hour (a Call back still tells that news).
   */
  calledOff: (w: Wait, itemId?: string) => void = () => {};
  /** The phone's zone (the Ringer sets it), where a not-before is read; none, and nothing is held for one. */
  zone: () => string | null = () => null;
  /**
   * News a phone holding for this conversation takes though its wait goes on (the engine sets it): its threads' computer
   * gone offline (stage 3.7). A holding phone's ask ends for it as for a wait that's over.
   */
  news: (conversationId: string) => boolean = () => false;
  /**
   * The computer holding a thread, by name, while it's offline past its grace (the engine sets it, stage 3.7's
   * `offlineSince`); else null. A thread still working there as last seen isn't said to be (`Wait.replies`' `offline`).
   */
  offline: (itemId: string) => string | null = () => null;
  private readonly waits = new Map<string, Wait>();
  private readonly listeners = new Set<() => void>();
  /** When the last whole look was: a due time at or before it was looked at already (`due`). In memory only. */
  private lookedAt = -Infinity;
  /**
   * Stage 3.10: when each tests watch's thread was last looked at mid-run (`${conversationId}\n${itemId}`), so it's
   * looked at once a minute (`LOOK_MS`) and no more; in memory, so a restart looks at once.
   */
  private readonly midLooks = new Map<string, number>();
  private readonly adapter: Adapter;
  private readonly log: (m: string) => void;
  private readonly store: Store | null;
  private readonly clock: Clock;

  /** With a `store`, waits are saved as they change and the ones saved before a restart are watched again. */
  /** Usage analytics: waits starting, coming to an end, being called off or called back (contracts §5). */
  private readonly track: Track;

  constructor(deps: { adapter: Adapter; log: (m: string) => void; store?: Store; clock?: Clock; track?: Track }) {
    this.track = deps.track ?? (() => {});
    this.adapter = deps.adapter;
    this.clock = deps.clock ?? realClock;
    this.log = deps.log;
    this.store = deps.store ?? null;
    let saved: Wait[] = [];
    // A row that isn't a wait this version can watch is logged and left in the table as it is (docs/launch/engine.md §10).
    const leave = (id: string, why: string) => this.log(`wait ${id}: left as it is (${why})`);
    try {
      saved = this.store?.waits(leave) ?? [];
    } catch (e) {
      this.log(`wait: COULDN'T READ THE SAVED WAITS (${describe(e)})`);
    }
    for (const w of saved) {
      const why = unwatchable(w);
      if (why) {
        leave(w.conversationId, why);
        continue;
      }
      this.waits.set(w.conversationId, w);
      this.log(`wait ${w.conversationId}: ${w.ready ? `still to call back (${w.ready})` : `waiting again for ${w.items.map((i) => i.handle).join(", ")}`}`);
    }
  }

  /**
   * Watches `items`, each counting a run that finishes after its `since` (default: now). `label` is what the phone
   * shows for more than one thread; `auto` marks a watch on starred threads; `via`, how it was asked for (its rule's head).
   */
  start(
    conversationId: string,
    items: { item: WorkItem; handle: string; since?: number; patient?: boolean; heardQuestion?: string | null; asked?: boolean; sentAt?: number | null }[],
    opts: { label?: string; auto?: boolean; via?: Made["via"]; watchMs?: number; mode?: Mode } = {},
    now = this.clock.now(),
  ): Wait {
    const watched = items.map(({ item, handle, since, patient, heardQuestion, asked, sentAt }) => ({
      itemId: item.id, handle, since: since ?? now, sawRunning: item.status === "running", patient, heardQuestion, ...(asked !== undefined ? { asked } : {}),
      ...(sentAt != null && opts.mode?.tests ? { sentAt } : {}),
    }));
    const handle = watched.length === 1 ? watched[0].handle : (opts.label ?? `${watched.length} threads`);
    const auto = opts.auto ?? false;
    const mode = opts.mode && Object.keys(opts.mode).length ? { ...opts.mode, ...(opts.mode.until === "all" && watched.length < 2 ? { until: undefined } : {}) } : undefined;
    if (mode && mode.until === undefined) delete mode.until;
    const w: Wait = {
      conversationId, handle, startedAt: now, items: watched, auto, ready: null, replies: [], rule: headFor(conversationId, now, auto, opts.via, opts.watchMs),
      ...(mode && Object.keys(mode).length ? { mode } : {}),
    };
    this.waits.set(conversationId, w);
    this.save(w);
    this.log(`wait ${conversationId}: waiting for ${watched.map((i) => i.handle).join(", ")}`);
    this.track("wait_started", { conversation_id: conversationId, threads: watched.length, patient: watched.some((i) => i.patient), via: w.auto ? "goodbye" : "wait_for" });
    this.notify();
    // Looked at once now: a reply that came between the follow-up and the wait (`since`) ends it with no report to come.
    void this.check(now).catch((e) => this.log(`wait: check failed (${describe(e)})`));
    return w;
  }

  /**
   * A phone on hold with nothing watched: returns once a wait starts for the conversation (a call-back armed), or after
   * `ms` with none.
   */
  async started(conversationId: string, ms: number): Promise<Wait | null> {
    if (!this.waits.has(conversationId) && ms > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.clock.clear(timer);
          this.listeners.delete(check);
          resolve();
        };
        const check = () => this.waits.has(conversationId) && finish();
        const timer = this.clock.setTimeout(finish, ms);
        this.listeners.add(check);
      });
    }
    return this.get(conversationId);
  }

  get(conversationId: string): Wait | null {
    return this.waits.get(conversationId) ?? null;
  }

  all(): Wait[] {
    return [...this.waits.values()];
  }

  /** Calls `l` whenever a wait starts, ends or is over; returns what stops it. */
  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** A machine reported a change (or a wait started, or a holding phone asks): the open waits are looked at now. */
  changed() {
    if ([...this.waits.values()].some((w) => !w.ready)) void this.check().catch((e) => this.log(`wait: check failed (${describe(e)})`));
  }

  /**
   * When a wait's time next changes something (docs/launch/engine.md §7, "Due means true"): the first millisecond a
   * thread can have never started or run out of time, or a wait's news is stale (each limit is strict, so its threshold
   * plus 1 ms). A time a whole look has passed (`check`) isn't due again, so one that changed nothing (a thread that never
   * started while another is still watched) isn't looked at again and again. Null for nothing to look at. As it is, a
   * time already past included: the engine holds it to now, and to a backoff if a look left it due (util.ts `Stuck`).
   */
  due(): number | null {
    const times: number[] = [];
    for (const w of this.waits.values()) {
      const life = headOf(w).lifetime;
      if (w.ready) {
        times.push(this.readyFrom(w) + life.keepNewsMs + 1);
        continue;
      }
      for (const i of w.items) {
        const start = i.startedAt ?? w.startedAt;
        // A check-in's threads aren't looked at before its time (stage 3.8): no start grace.
        if (!i.sawRunning && !i.patient && w.mode?.checkIn === undefined) times.push(start + life.graceMs + 1);
        times.push(endOf(w, i, life) + 1);
      }
      // A check-in still unlisted once its news would be stale is dropped then (`check`).
      if (w.mode?.checkIn !== undefined) times.push(w.mode.checkIn + life.keepNewsMs + 1);
      // A tests watch looks at its thread once a minute (stage 3.10), from its not-before when one is ahead; a finished
      // run's report not yet that run's, again shortly.
      const nb = notBeforeAt(w, this.zone()) ?? 0;
      for (const i of w.items) {
        const looked = this.midLooks.get(`${w.conversationId}\n${i.itemId}`) ?? w.startedAt;
        if (w.mode?.tests) times.push(Math.max(looked + LOOK_MS, nb));
        if (i.unreadSince !== undefined) times.push(looked + REREAD_STEP_MS);
      }
    }
    const next = times.filter((t) => t > this.lookedAt);
    return next.length ? Math.min(...next) : null;
  }

  /** The latest wait that's over, not yet called back and not stale, in any conversation. */
  newestReady(): Wait | null {
    this.expire();
    return [...this.waits.values()].filter((w) => w.ready && w.replies.length).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }

  /** Hands over a finished wait (the call-back session uses it) and forgets it. */
  take(conversationId: string): Wait | null {
    const w = this.waits.get(conversationId);
    if (!w?.ready) return null;
    this.drop(conversationId);
    this.track("callback_started", { conversation_id: conversationId, threads: w.replies.length, delay_s: Math.round((this.clock.now() - (w.readyAt ?? w.startedAt)) / 1000) });
    return w;
  }

  /** The user unstarred a thread: automatic watches stop following it, even if it already replied, and end if nothing is left. */
  unwatch(itemId: string) {
    let changed = false;
    for (const w of [...this.waits.values()]) {
      if (!w.auto || !w.items.some((i) => i.itemId === itemId)) continue;
      w.items = w.items.filter((i) => i.itemId !== itemId);
      w.replies = w.replies.filter((r) => r.itemId !== itemId);
      if (!w.replies.length) {
        w.ready = null;
        delete w.readyAt;
      }
      this.callOff(w, itemId);
      changed = true;
      if (!w.items.length) {
        this.log(`wait ${w.conversationId}: nothing starred left to wait for`);
        this.drop(w.conversationId);
      } else this.save(w);
    }
    if (changed) this.notify();
  }

  /** The user stayed on the call after all: this conversation's wait is dropped, and the session watches instead. */
  cancel(conversationId: string) {
    const w = this.waits.get(conversationId);
    if (!w) return;
    this.generation++;
    this.log(`wait ${conversationId}: cancelled, the user stayed on`);
    this.track("wait_cancelled", { conversation_id: conversationId, by: "stay_on", wait_s: this.waitedS(conversationId) });
    this.drop(conversationId);
    this.callOff(w);
    this.notify();
  }

  /** Stop in Watching (`DELETE /api/rules/:id`): this conversation's wait is called off, whatever it was. */
  stop(conversationId: string) {
    const w = this.waits.get(conversationId);
    if (!w) return;
    this.generation++;
    this.log(`wait ${conversationId}: stopped in Watching`);
    this.track("wait_cancelled", { conversation_id: conversationId, by: "watching", wait_s: this.waitedS(conversationId) });
    this.drop(conversationId);
    this.callOff(w);
    this.notify();
  }

  /**
   * The wait's news was told another way (in a live call, another call-back, a tap), or answered at the computer
   * (engine.ts): there's nothing left to call back with.
   */
  told(conversationId: string, w: Wait) {
    if (this.waits.get(conversationId) !== w || !w.ready) return;
    this.log(`wait ${conversationId}: its news was told or answered another way; nothing to call back with`);
    this.drop(conversationId);
    this.notify();
  }

  /** `keep`: waits that outlive a Stop (one that rings the phone, ring.ts `keepsThroughStop`). */
  cancelAll(keep: (w: Wait) => boolean = () => false) {
    this.generation++;
    for (const [id, w] of [...this.waits]) {
      if (keep(w)) {
        this.log(`wait ${id}: kept through the stop; it rings the phone`);
        continue;
      }
      this.log(`wait ${id}: cancelled`);
      this.track("wait_cancelled", { conversation_id: id, by: "stop", wait_s: this.waitedS(id) });
      this.drop(id);
      this.callOff(w);
    }
    this.notify();
  }

  /** Resolves when the conversation's wait is over or gone, or after `ms`. A holding phone's ask looks at the waits once. */
  async until(conversationId: string, ms: number): Promise<Wait | null> {
    const done = () => {
      const w = this.waits.get(conversationId);
      return !w || (w.ready !== null && !this.early(w)) || this.news(conversationId);
    };
    if (!done()) this.changed();
    if (!done() && ms > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.clock.clear(timer);
          this.listeners.delete(check);
          resolve();
        };
        const check = () => done() && finish();
        const timer = this.clock.setTimeout(finish, ms);
        this.listeners.add(check);
      });
    }
    return this.get(conversationId);
  }

  /**
   * A wait that's over before its not-before (stage 3.6): nothing reaches the user for it yet, a holding phone included
   * (it's still waiting, as the phone is told).
   */
  early(w: Wait, now = this.clock.now()): boolean {
    const at = notBeforeAt(w, this.zone());
    return at !== null && now < at;
  }

  /**
   * A watch longer than an hour that has watched an hour, still open (stage 3.6, Fable's topic 7): a holding phone that
   * can be called is let go, as any hold was let go at an hour before.
   */
  heldAnHour(w: Wait, now = this.clock.now()): boolean {
    return !w.ready && headOf(w).lifetime.watchMs > MAX_WAIT_MS && now - w.startedAt >= MAX_WAIT_MS;
  }

  /** When a wait that's over may first reach the user: then, or at its not-before (stage 3.6), its news kept from then. */
  private readyFrom(w: Wait): number {
    return Math.max(w.readyAt ?? w.startedAt, notBeforeAt(w, this.zone()) ?? 0);
  }

  /** Drops waits that were over more than their rule keeps news (`READY_MS`) ago and never called back. */
  expire(now = this.clock.now()) {
    for (const w of [...this.waits.values()]) {
      if (!w.ready) continue;
      const keep = headOf(w).lifetime.keepNewsMs;
      if (now - this.readyFrom(w) <= keep) continue;
      this.log(`wait ${w.conversationId}: no call-back within ${keep / 60_000} minutes of the reply; dropped unheard`);
      this.track("news_dropped", { conversation_id: w.conversationId, what: "ready" });
      this.drop(w.conversationId);
    }
  }

  async check(now = this.clock.now()) {
    this.expire(now);
    const open = [...this.waits.values()].filter((w) => !w.ready);
    if (!open.length) return;
    const generation = this.generation;
    const items = new Map((await this.adapter.list().catch(() => null))?.map((i) => [i.id, i]) ?? []);
    // The computers that listed anything this time (a machine whose list failed gives none: `machines.ts`).
    const answered = new Set([...items.keys()].map(machineOf));
    // While T3 answered, Stop or a cancel may have ended waits, and a new wait may have replaced one: only a wait that's
    // still the conversation's own, and still open, is looked at (or saved, which would bring a cancelled one back).
    if (this.generation !== generation) return;
    this.lookedAt = Math.max(this.lookedAt, now);
    let changed = false;
    for (const w of open) {
      if (this.waits.get(w.conversationId) !== w || w.ready) continue;
      let saw = false;
      const life = headOf(w).lifetime;
      const only = w.mode?.only;
      const checkIn = w.mode?.checkIn;
      // A check-in (stage 3.8): nothing before its time; then how each thread stands, whatever that is, is the news. With
      // no threads listed (T3 unreachable), it waits for a list that has them.
      if (checkIn !== undefined && (now <= checkIn || !items.size)) {
        // No threads listed (T3 unreachable) until its news would be stale: it's over, with nothing to tell (the code
        // review's finding on 3.8: else it would never end).
        if (now > checkIn + life.keepNewsMs) {
          this.log(`wait ${w.conversationId}: its check-in's threads couldn't be listed by then; dropped`);
          this.track("wait_ready", { conversation_id: w.conversationId, outcome: "quiet", wait_s: Math.round((now - w.startedAt) / 1000) });
          this.drop(w.conversationId);
          changed = true;
          continue;
        }
        for (const it of w.items) if (items.get(it.itemId)?.status === "running" && !it.sawRunning) saw = it.sawRunning = true;
        if (saw) this.save(w);
        continue;
      }
      // Stage 3.10: what the computer says of its threads' test runs, read from their reports (never their words).
      const looked = readsChecks(w) ? this.receipts(w, items, now) : null;
      const { greenNow, unread, ran }: Receipts = looked instanceof Promise ? await looked : (looked ?? { greenNow: new Map(), unread: new Set(), ran: new Map() });
      if (this.generation !== generation || this.waits.get(w.conversationId) !== w || w.ready) continue;
      // Still working as last seen, its computer offline now: not known to be (the Skeptic's finding on 3.6 to 3.8).
      const offline: (string | null)[] = w.items.map(() => null);
      // Done after its deadline, seen by a look that came after it (the fourth review of 3.6 to 3.8): not done by then.
      const late: boolean[] = w.items.map(() => false);
      const unknown = (i: number, o: Outcome | null, item: WorkItem | undefined) => {
        if (o === "timed out" && item?.status === "running") offline[i] = this.offline(item.id);
      };
      const outcomes: (Outcome | "quiet" | null)[] = w.items.map((it, i) => {
        const item = items.get(it.itemId);
        if (item?.status === "running" && !it.sawRunning) saw = it.sawRunning = true;
        if (checkIn !== undefined) {
          const o = standing(it, item);
          unknown(i, o, item);
          return o;
        }
        // Each thread's own clock ends at its deadline (stage 3.8), else at its start plus the rule's length.
        const end = endOf(w, it, life);
        const over = now > end;
        // No threads at all: T3 is unreachable (or answered with nothing). Keep waiting rather than call back with
        // nothing, but not past each thread's own time limit.
        if (!items.size) return over ? (only ? "quiet" : "timed out") : null;
        // Missing, and nothing listed from its computer: that computer didn't answer (a partial list, others did), so
        // nothing is known of the thread. It's waited for as with no list at all, never told as finished.
        if (!item && !answered.has(machineOf(it.itemId))) return over ? (only ? "quiet" : "timed out") : null;
        const settled = settle(it, item, w.startedAt, now, { ...life, watchMs: end - (it.startedAt ?? w.startedAt) });
        // A tests watch's pass mid-run (stage 3.10): the thread is still working, and that's the news.
        if (settled === null && greenNow.has(it.itemId)) {
          this.log(`wait ${w.conversationId}: ${it.handle}'s tests pass while it's still working`);
          return "finished";
        }
        // Its finished run's report not yet that run's: nothing is decided about it yet (stage 3.10).
        if (settled === "finished" && unread.has(it.itemId)) return null;
        const o = settled;
        unknown(i, o, item);
        // A clean finish after its deadline (a look that came late: an alarm, a restart): it wasn't done by then, so
        // it's the deadline's news, as still working then would have been. One with no time of its own is taken as on
        // time.
        const ranAt = item?.lastRunAt ? Date.parse(item.lastRunAt) : NaN;
        if (w.mode?.deadline !== undefined && o === "finished" && item && ranAt > w.mode.deadline) {
          late[i] = true;
          return "timed out";
        }
        // Done by its deadline (stage 3.8): nothing from this, at once; it isn't watched on as a trouble watch is.
        const redRun = o === "finished" && red(ran.get(it.itemId)?.checks ?? undefined) !== null;
        // Holding a command for the user at the time asked is trouble too, as still working is (engine.md's 4c note).
        return inMode(o, over || (w.mode?.deadline !== undefined && o === "finished"), only, item?.status === "running" || !!item?.gate, redRun);
      });
      // A starred thread merged into a wait the user asked for (`asked: false`) doesn't end it on its own while a thread
      // they asked about is still watched: its news is told with theirs (stage 2a item 10, so it never rings by itself).
      // A phone holding for the conversation hears it at once, as before: holding, nothing rings.
      const asked = (i: number) => w.items[i].asked !== false;
      let ready = checkIn !== undefined ? outcomes.map((_, i) => i) : decide(outcomes, w.mode);
      if (ready.length && !ready.some(asked) && outcomes.some((o, i) => o === null && asked(i)) && !this.held(w.conversationId)) ready = [];
      // Over with nothing to tell: only for trouble or a failure, and every thread over quietly (Fable, topic 7).
      if (only && !ready.length && outcomes.length && outcomes.every((o) => o !== null)) {
        this.log(`wait ${w.conversationId}: over with nothing to tell (only ${only === "failed" ? "a failure" : "trouble"} was asked for)`);
        this.track("wait_ready", { conversation_id: w.conversationId, outcome: "quiet", wait_s: Math.round((now - w.startedAt) / 1000) });
        this.drop(w.conversationId);
        changed = true;
        continue;
      }
      // A long or asked-for-with-a-mode wait that ran out says every thread still working, not only the first.
      if (ready.length === 1 && outcomes[ready[0]] === "timed out" && watchedLong(w)) ready = outcomes.flatMap((o, i) => (o === "timed out" ? [i] : []));
      if (!ready.length) {
        if (saw) this.save(w);
        continue;
      }
      w.replies = ready.map((i) => {
        const item = items.get(w.items[i].itemId);
        const { read: _read, unreadSince: _unread, ...watched } = w.items[i];
        // Stage 3.10: what it says of its tests, decided now from the computer's facts, and those facts for the voice.
        const mid = greenNow.get(watched.itemId);
        const run = ran.get(watched.itemId);
        const checks = mid?.checks ?? run?.checks ?? undefined;
        const fact = outcomes[i] === "finished" && item && readsChecks(w) ? testsOf(checks, { watch: !!w.mode?.tests, readable: !!mid || !!run?.readable, running: !!mid }) : null;
        const tests = fact && mid ? { ...fact, run: mid.run } : fact;
        return {
          // A pass mid-run is no run's end: hearing it marks no reply heard.
          ...watched, outcome: outcomes[i] as Outcome, seen: mid ? { runAt: 0, question: null } : { runAt: item?.lastRunAt ? Date.parse(item.lastRunAt) : 0, question: item?.questionId ?? null },
          ...(tests ? { tests } : {}), ...(checks && outcomes[i] === "finished" ? { checks } : {}), ...(mid ? { midRun: true as const } : {}),
          ...(item ? {} : { gone: true }), ...(outcomes[i] === "failed" && item?.status === "cancelled" ? { stopped: true as const } : {}),
          ...(outcomes[i] === "timed out" && offline[i] ? { offline: offline[i]! } : {}), ...(late[i] ? { late: true as const } : {}),
          ...(outcomes[i] === "timed out" && !late[i] && item?.gate ? { held: true as const } : {}),
        };
      });
      w.ready = w.replies[0].outcome;
      w.readyAt = now;
      this.save(w);
      changed = true;
      this.log(`wait ${w.conversationId}: ${w.replies.map((r) => `${r.handle} ${r.outcome}`).join(", ")}`);
      this.track("wait_ready", { conversation_id: w.conversationId, outcome: w.ready.replace(" ", "_"), wait_s: Math.round((now - w.startedAt) / 1000) });
    }
    if (changed) this.notify();
  }

  /**
   * Stage 3.10: each thread's test runs as the computer reports them, for a wait that goes by them (`readsChecks`). A
   * tests watch's run still going is looked at once a minute (`LOOK_MS`), from its not-before, and is a pass (`greenNow`,
   * with that run's checks so far) when its last test run passed after a change it made and nothing changed since, and
   * it's the run that took the user's latest words (not one this conversation's follow-up is queued behind). A finished
   * run's report is read once for its checks (`Watched.read`), whatever the wait, so a plain call-back whose finished
   * thread doesn't end it (a starred thread merged in, the asked one still working) isn't read again at every look (the
   * code review of 3.9 and 3.10). One not yet that run's (its work system behind) is read again every `REREAD_STEP_MS`
   * for `REREAD_MS`, then taken as unreadable: where it decides (a tests watch, only trouble), nothing is decided
   * meanwhile (`unread`); elsewhere it's never waited for, unreadable until it's read.
   */
  private receipts(w: Wait, items: Map<string, WorkItem>, now: number): Receipts | Promise<Receipts> {
    const got: Receipts = { greenNow: new Map(), unread: new Set(), ran: new Map() };
    const tests = !!w.mode?.tests, decides = tests || w.mode?.only === "trouble";
    // What needs a report read; a look that needs none answers at once, with no await (a wait's own look as it starts).
    const reads: { it: Watched; item: WorkItem; mid: boolean }[] = [];
    for (const it of w.items) {
      const item = items.get(it.itemId);
      if (!item) continue;
      const key = `${w.conversationId}\n${it.itemId}`;
      const looked = this.midLooks.get(key) ?? -Infinity;
      // An older connector says nothing of test runs (`testRuns`): none is read, and none is taken as seen or passing.
      const readable = item.testRuns === true;
      if (tests && item.status === "running") {
        if (now - looked < LOOK_MS) continue;
        this.midLooks.set(key, now);
        // Nothing is fixed before a not-before (Fable, 3.10-A): from then, the state as it is.
        if (readable && !item.pendingQuestion && !this.early(w, now)) reads.push({ it, item, mid: true });
        continue;
      }
      if (tests) this.midLooks.set(key, now);
      if (settle(it, item, w.startedAt, now, headOf(w).lifetime) !== "finished") continue;
      // Read once for this run (kept with the wait).
      if (it.read?.runAt === runOf(item)) got.ran.set(it.itemId, { checks: it.read.checks, readable: it.read.readable });
      else if (!readable) got.ran.set(it.itemId, { checks: null, readable: false });
      else if (it.unreadSince !== undefined && now - looked < REREAD_STEP_MS && now - it.unreadSince < REREAD_MS) {
        if (decides) got.unread.add(it.itemId);
        else got.ran.set(it.itemId, { checks: null, readable: false });
      } else {
        this.midLooks.set(key, now);
        reads.push({ it, item, mid: false });
      }
    }
    return reads.length ? this.read(w, reads, got, decides, now) : got;
  }

  /** `receipts`' reports, read one after another. */
  private async read(w: Wait, reads: { it: Watched; item: WorkItem; mid: boolean }[], got: Receipts, decides: boolean, now: number): Promise<Receipts> {
    let changed = false;
    for (const { it, item, mid } of reads) {
      const rep = await this.adapter.report(it.itemId).catch((e) => {
        this.log(`wait ${w.conversationId}: couldn't read ${it.handle}'s report (${describe(e)})`);
        return null;
      });
      if (mid) {
        const began = rep?.runningSince ? Date.parse(rep.runningSince) : NaN;
        const queuedBehind = it.sentAt !== undefined && began + 1000 < it.sentAt;
        if (rep?.running && greenAfterChange(rep.running) && !queuedBehind) {
          got.greenNow.set(it.itemId, { checks: rep.running, run: { ...(rep.runningId ? { id: rep.runningId } : {}), after: item.lastRunAt ? Date.parse(item.lastRunAt) : 0 } });
        }
        continue;
      }
      const runAt = runOf(item);
      // A report whose checks its computer couldn't read this time (`checksUnread`) is read again as one behind is: its
      // silence isn't "no test ran" (the review's finding on 3.10).
      const fresh = !!rep && caughtUp(rep, it, runAt) && rep.checksUnread !== true;
      if (!fresh && now - (it.unreadSince ??= now) < REREAD_MS) {
        if (decides) got.unread.add(it.itemId);
        else got.ran.set(it.itemId, { checks: null, readable: false });
        changed = true;
        continue;
      }
      if (!fresh) this.log(`wait ${w.conversationId}: ${it.handle}'s last run's report ${!rep ? "couldn't be read" : rep.checksUnread ? "had checks its computer couldn't read" : "wasn't that run's"}; its test runs aren't known`);
      const ran = { checks: fresh ? (rep!.checks ?? null) : null, readable: fresh };
      got.ran.set(it.itemId, ran);
      it.read = { runAt, ...ran };
      delete it.unreadSince;
      changed = true;
    }
    if (changed && this.waits.get(w.conversationId) === w && !w.ready) this.save(w);
    return got;
  }

  /**
   * `wait_for` added threads to an open wait in place: it's kept, what keeps its time is told (its due times changed),
   * and it's looked at now (an added thread may have replied before the wait took it in, with no report to come).
   */
  extended(w: Wait) {
    this.save(w);
    this.notify();
    this.changed();
  }

  /** Something a holding phone may take changed without a wait changing (`news`): every listener looks again. */
  wake() {
    this.notify();
  }

  /**
   * Saves a wait after it changed in place.
   * Saving is a record for after a restart: a failing store is logged, and the wait carries on in memory.
   */
  save(w: Wait) {
    // A wait taken, cancelled or replaced while its saver awaited something isn't brought back (stage 2a item 10).
    if (this.waits.get(w.conversationId) !== w) return;
    try {
      this.store?.saveWait(w);
    } catch (e) {
      this.log(`wait ${w.conversationId}: couldn't save it (${describe(e)}); a restart would lose it`);
    }
  }

  private drop(conversationId: string) {
    this.waits.delete(conversationId);
    try {
      this.store?.deleteWait(conversationId);
    } catch (e) {
      this.log(`wait ${conversationId}: couldn't delete it (${describe(e)}); a restart would bring it back`);
    }
  }

  /** `calledOff`, whose failure is logged: the wait is called off either way. */
  private callOff(w: Wait, itemId?: string) {
    try {
      this.calledOff(w, itemId);
    } catch (e) {
      this.log(`wait ${w.conversationId}: couldn't drop what it queued (${describe(e)})`);
    }
  }

  private waitedS(conversationId: string): number | null {
    const w = this.waits.get(conversationId);
    return w ? Math.round((this.clock.now() - w.startedAt) / 1000) : null;
  }

  private notify() {
    for (const l of [...this.listeners]) l();
  }
}
