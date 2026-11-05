// "Call me back when it replies": the voice session hangs up, the phone holds, and the brain watches the threads until
// one of their runs is over. A wait covers one thread (wait_for, a pause) or every starred thread with news coming
// (when a conversation ends). One wait per conversation. Waits are kept in the store, so a brain restart (a deploy, a
// crash) picks them up again and the holding phone finds its wait when it next asks.
import type { Adapter, WorkItem } from "./adapter.ts";
import type { Track } from "./analytics.ts";
import type { Seen, Store } from "./store.ts";
import { describe, realClock, type Clock, type Timer } from "./util.ts";

export type Outcome = "finished" | "question" | "never started" | "timed out";

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
  replies: (Watched & { outcome: Outcome; seen: Seen })[];
};

/** A run the user just asked for (a follow-up) may take a moment to show as running. */
export const START_GRACE_MS = 3 * 60_000;
export const MAX_WAIT_MS = 60 * 60_000;
/**
 * How long a wait that's over keeps its call-back. A holding phone calls back within seconds; this is for one that
 * lost track of its hold (a crash), whose next Start still gets the news. After that the news is stale and dropped.
 */
export const READY_MS = 60 * 60_000;

/** Whether one thread's wait is over, given its current state. Pure, for tests. */
export function settle(w: Watched, item: WorkItem | undefined, startedAt: number, now: number): Outcome | null {
  if (!item) return "finished";
  if (item.pendingQuestion && !(w.heardQuestion != null && w.heardQuestion === item.questionId)) return "question";
  const running = item.status === "running";
  if (!running && (w.sawRunning || (item.lastRunAt != null && Date.parse(item.lastRunAt) > w.since))) return "finished";
  const elapsed = now - (w.startedAt ?? startedAt);
  if (elapsed > MAX_WAIT_MS) return "timed out";
  if (!running && !w.sawRunning && !w.patient && elapsed > START_GRACE_MS) return "never started";
  return null;
}

/**
 * Which threads end the wait: every one with a reply or a question, so news arriving together is told together.
 * Otherwise the wait is over only once every thread has run out of time (the first is reported).
 */
export function decide(outcomes: (Outcome | null)[]): number[] {
  const news = outcomes.flatMap((o, i) => (o === "finished" || o === "question" ? [i] : []));
  if (news.length) return news;
  return outcomes.length && outcomes.every((o) => o !== null) ? [0] : [];
}

export class Waits {
  /** Bumped by every cancel: work that started before one checks it before starting a wait. */
  generation = 0;
  private readonly waits = new Map<string, Wait>();
  private readonly listeners = new Set<() => void>();
  private timer: Timer | null = null;
  private readonly adapter: Adapter;
  private readonly log: (m: string) => void;
  private readonly pollMs: number;
  private readonly store: Store | null;
  private readonly clock: Clock;

  /** With a `store`, waits are saved as they change and the ones saved before a restart are watched again. */
  /** Usage analytics: waits starting, coming to an end, being called off or called back (contracts §5). */
  private readonly track: Track;

  constructor(deps: { adapter: Adapter; log: (m: string) => void; pollMs?: number; store?: Store; clock?: Clock; track?: Track }) {
    this.track = deps.track ?? (() => {});
    this.adapter = deps.adapter;
    this.clock = deps.clock ?? realClock;
    this.log = deps.log;
    this.pollMs = deps.pollMs ?? 2000;
    this.store = deps.store ?? null;
    let saved: Wait[] = [];
    try {
      saved = this.store?.waits() ?? [];
    } catch (e) {
      this.log(`wait: COULDN'T READ THE SAVED WAITS (${describe(e)})`);
    }
    for (const w of saved) {
      this.waits.set(w.conversationId, w);
      this.log(`wait ${w.conversationId}: ${w.ready ? `still to call back (${w.ready})` : `waiting again for ${w.items.map((i) => i.handle).join(", ")}`}`);
    }
    if (this.waits.size) this.poll();
  }

  /**
   * Watches `items`, each counting a run that finishes after its `since` (default: now). `label` is what the phone
   * shows for more than one thread; `auto` marks a watch on starred threads.
   */
  start(
    conversationId: string,
    items: { item: WorkItem; handle: string; since?: number; patient?: boolean; heardQuestion?: string | null }[],
    opts: { label?: string; auto?: boolean } = {},
    now = this.clock.now(),
  ): Wait {
    const watched = items.map(({ item, handle, since, patient, heardQuestion }) => ({
      itemId: item.id, handle, since: since ?? now, sawRunning: item.status === "running", patient, heardQuestion,
    }));
    const handle = watched.length === 1 ? watched[0].handle : (opts.label ?? `${watched.length} threads`);
    const w: Wait = { conversationId, handle, startedAt: now, items: watched, auto: opts.auto ?? false, ready: null, replies: [] };
    this.waits.set(conversationId, w);
    this.save(w);
    this.log(`wait ${conversationId}: waiting for ${watched.map((i) => i.handle).join(", ")}`);
    this.track("wait_started", { conversation_id: conversationId, threads: watched.length, patient: watched.some((i) => i.patient), via: w.auto ? "goodbye" : "wait_for" });
    this.poll();
    return w;
  }

  get(conversationId: string): Wait | null {
    return this.waits.get(conversationId) ?? null;
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
    if (!this.waits.has(conversationId)) return;
    this.generation++;
    this.log(`wait ${conversationId}: cancelled, the user stayed on`);
    this.track("wait_cancelled", { conversation_id: conversationId, by: "stay_on", wait_s: this.waitedS(conversationId) });
    this.drop(conversationId);
    this.notify();
  }

  cancelAll() {
    this.generation++;
    for (const id of [...this.waits.keys()]) {
      this.log(`wait ${id}: cancelled`);
      this.track("wait_cancelled", { conversation_id: id, by: "stop", wait_s: this.waitedS(id) });
      this.drop(id);
    }
    this.notify();
  }

  /** Resolves when the conversation's wait is over or gone, or after `ms`. */
  async until(conversationId: string, ms: number): Promise<Wait | null> {
    const done = () => {
      const w = this.waits.get(conversationId);
      return !w || w.ready !== null;
    };
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

  /** Drops waits that were over more than `READY_MS` ago and never called back. */
  expire(now = this.clock.now()) {
    for (const w of [...this.waits.values()]) {
      if (!w.ready || now - (w.readyAt ?? w.startedAt) <= READY_MS) continue;
      this.log(`wait ${w.conversationId}: no call-back within ${READY_MS / 60_000} minutes of the reply; dropped unheard`);
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
    // While T3 answered, Stop or a cancel may have ended waits, and a new wait may have replaced one: only a wait that's
    // still the conversation's own, and still open, is looked at (or saved, which would bring a cancelled one back).
    if (this.generation !== generation) return;
    let changed = false;
    for (const w of open) {
      if (this.waits.get(w.conversationId) !== w || w.ready) continue;
      let saw = false;
      const outcomes = w.items.map((it) => {
        const item = items.get(it.itemId);
        if (item?.status === "running" && !it.sawRunning) saw = it.sawRunning = true;
        if (items.size) return settle(it, item, w.startedAt, now);
        // No threads at all: T3 is unreachable (or answered with nothing). Keep waiting rather than call back with
        // nothing, but not past each thread's own time limit.
        return now - (it.startedAt ?? w.startedAt) > MAX_WAIT_MS ? "timed out" : null;
      });
      const ready = decide(outcomes);
      if (!ready.length) {
        if (saw) this.save(w);
        continue;
      }
      w.replies = ready.map((i) => {
        const item = items.get(w.items[i].itemId);
        return { ...w.items[i], outcome: outcomes[i]!, seen: { runAt: item?.lastRunAt ? Date.parse(item.lastRunAt) : 0, question: item?.questionId ?? null } };
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

  private poll() {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => void this.check(), this.pollMs);
    this.timer.unref();
  }

  /**
   * Saves a wait after it changed (callers that change one in place, like `wait_for` adding a thread, call this).
   * Saving is a record for after a restart: a failing store is logged, and the wait carries on in memory.
   */
  save(w: Wait) {
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
    if (!this.waits.size && this.timer) {
      this.clock.clear(this.timer);
      this.timer = null;
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
