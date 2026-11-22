// One identity per fact, for the whole account (docs/launch/engine.md §3, Events; stage 2a item 2). A fact's key is what
// stops it firing a rule twice: a question `${itemId}:q:${questionId}`, a finished run `${itemId}:run:${lastRunAt}`.
// Adapters don't always give those ids: `questionId` can be null (OpenCode) or come later, and `lastRunAt` is null on
// T3 and Codex until a run completes. Then the key is the thread's, not whichever rule saw it first: the first look that
// sees a question (or a stopped run) with no id gives it a key, kept here per thread, so two rules made at different
// times see one fact and merge. An id that arrives later is kept as an alias of that key, never a second fact. A
// question that clears and comes back is a new fact.
import type { WorkItem } from "./adapter.ts";
import type { Store } from "./store.ts";

export type Observation = {
  v: 1;
  itemId: string;
  /** A run seen to end with no `lastRunAt`: its key, while it's the thread's last. */
  run?: { key: string; seenAt: number };
  /** The open question: its key, from when it was first seen, and its id once there is one. */
  question?: { key: string; seenAt: number; id: string | null };
  /** A real key that arrived later → the key first given. */
  aliases: Record<string, string>;
};

/** The most aliases a thread keeps: the oldest go first (a thread asks a handful of questions a day). */
const ALIASES_MAX = 50;

export const questionKey = (itemId: string, questionId: string) => `${itemId}:q:${questionId}`;
export const runKey = (itemId: string, runAt: number) => `${itemId}:run:${runAt}`;

export class Observations {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** The thread's observation; a row this version can't read is started again (it only names facts). */
  get(itemId: string): Observation {
    try {
      const o = JSON.parse(this.store.observation(itemId) ?? "null");
      if (o && o.v === 1 && o.itemId === itemId && o.aliases && typeof o.aliases === "object") return o;
    } catch {
      // started again below
    }
    return { v: 1, itemId, aliases: {} };
  }

  private save(o: Observation) {
    const keys = Object.keys(o.aliases);
    for (const k of keys.slice(0, Math.max(0, keys.length - ALIASES_MAX))) delete o.aliases[k];
    this.store.saveObservation(o.itemId, JSON.stringify(o));
  }

  /**
   * The key of `item`'s open question now, or null when it asks nothing: the same key for one question however many
   * rules see it, and however late its id comes. Every look at the view passes each thread through here, so a question
   * that's gone between two looks is forgotten, and its return is a new fact.
   */
  question(item: Pick<WorkItem, "id" | "pendingQuestion" | "questionId">, now: number): string | null {
    const o = this.get(item.id);
    const id = item.questionId ?? null;
    if (!item.pendingQuestion) {
      if (o.question) {
        delete o.question;
        this.save(o);
      }
      return null;
    }
    if (id !== null) {
      const real = questionKey(item.id, id);
      if (o.question && o.question.id === id) return o.question.key;
      // The id came for a question already seen without one: the same question, the key it was given.
      if (o.question && o.question.id === null) {
        o.aliases[real] = o.question.key;
        o.question.id = id;
        this.save(o);
        return o.question.key;
      }
      const key = o.aliases[real] ?? real;
      o.question = { key, seenAt: now, id };
      this.save(o);
      return key;
    }
    // No id: the question seen before (with or without one) while it stays open, else a new one from now.
    if (o.question) return o.question.key;
    o.question = { key: `${item.id}:q:k${now}`, seenAt: now, id: null };
    this.save(o);
    return o.question.key;
  }

  /**
   * The key of question `questionId` (null: one with no id) a wait saw open on `itemId` just now, without taking it for
   * the thread's current one unless it's the one observed, or the only one: an id arriving for a question observed
   * without one is that question.
   */
  keyOf(itemId: string, questionId: string | null, now: number): string {
    const o = this.get(itemId);
    if (!o.question || o.question.id === null || o.question.id === questionId) return this.question({ id: itemId, pendingQuestion: true, questionId }, now)!;
    return questionId === null ? o.question.key : (o.aliases[questionKey(itemId, questionId)] ?? questionKey(itemId, questionId));
  }

  /** When the open question was first seen, if it's the one with `key`. */
  seenAt(itemId: string, key: string): number | null {
    const q = this.get(itemId).question;
    return q && q.key === key ? q.seenAt : null;
  }

  /**
   * The key of the run that finished at `runAt` (ms; 0 when the work system doesn't say), for a reply seen at `now`. A
   * run with no time gets a key from when it was first seen to end, kept while it's the thread's last; the time it gets
   * later is an alias of it. `running`: the thread runs again, so the next run without a time is a new fact.
   */
  run(itemId: string, runAt: number, now: number, running = false): string {
    const o = this.get(itemId);
    if (running) {
      if (o.run) {
        delete o.run;
        this.save(o);
      }
      return "";
    }
    if (runAt) {
      const real = runKey(itemId, runAt);
      if (o.aliases[real]) return o.aliases[real];
      if (o.run) {
        o.aliases[real] = o.run.key;
        const key = o.run.key;
        delete o.run;
        this.save(o);
        return key;
      }
      return real;
    }
    if (o.run) return o.run.key;
    o.run = { key: `${itemId}:run:k${now}`, seenAt: now };
    this.save(o);
    return o.run.key;
  }
}
