// Away's history and its words (docs/launch/engine.md §11 stage 3.9; Fable's decisions 3.9-F and 3.9-G): each time Away
// was on, until when, and how it ended, kept for the Timeline (kv `away_log`, 30 days), and every line that says so,
// built here and shown or said word for word. The rule itself, and when it ends, are the engine's (rules.ts `AwayRule`,
// engine.ts); its "Away ended" notification is reach.ts's `awayNoteOf`.
import type { Store } from "./store.ts";
import { shownClock, spokenDay } from "./zone.ts";
import { wroteIn } from "./reach.ts";

/**
 * How Away ended: at its set time, by your message typed at a computer (the thread as it was named then, its computer as
 * said, and when you wrote), or by Stop.
 */
export type AwayEnd = { at: number; why: "time" | "wrote" | "stop"; thread?: string; machine?: string };
/** One time Away was on: its rule, when it was turned on, until when, and how it ended once it did. */
export type AwayEntry = { id: string; on: number; until: number; ended?: AwayEnd };

const KEY = "away_log";
/** How long the Timeline keeps Away's lines, as it keeps the rest. */
const KEPT_MS = 30 * 86_400_000;

const validEnd = (e: any): e is AwayEnd => !!e && Number.isFinite(e.at) && ["time", "wrote", "stop"].includes(e.why)
  && (e.thread === undefined || typeof e.thread === "string") && (e.machine === undefined || typeof e.machine === "string");

/** Away's history, oldest first; anything unreadable in it is left out. */
export function awayLog(store: Pick<Store, "get">): AwayEntry[] {
  try {
    const all = JSON.parse(store.get(KEY) ?? "[]");
    return Array.isArray(all) ? all.filter((e): e is AwayEntry => !!e && typeof e.id === "string" && Number.isFinite(e.on) && Number.isFinite(e.until) && (e.ended === undefined || validEnd(e.ended))) : [];
  } catch {
    return [];
  }
}

/** Keeps `entry` in Away's history (its id's earlier entry replaced), and lets go of what's older than the Timeline keeps. */
export function logAway(store: Pick<Store, "get" | "set">, entry: AwayEntry, now: number) {
  const kept = awayLog(store).filter((e) => e.id !== entry.id && (e.ended?.at ?? e.until) >= now - KEPT_MS);
  store.set(KEY, JSON.stringify([...kept, entry]));
}

/** What the words need to know: thread names shown (Privacy), how many computers the account has, the phone's zone. */
export type AwayWords = { names: boolean; computers: number; zone: string };

/**
 * Away's Timeline lines (Fable, 3.9-G), each with its time: "Away on until Monday 08:00" (as shown when it was turned
 * on), then "Away ended", "Away ended: you wrote in Migration on Lattice" or "Away ended: you stopped it"; names hidden,
 * "…you wrote in a thread on Lattice".
 */
export function awayLines(e: AwayEntry, o: AwayWords): { at: number; key: string; text: string }[] {
  const lines = [{ at: e.on, key: "on", text: `Away on until ${shownClock(e.until, o.zone, e.on)}` }];
  const end = e.ended;
  if (end) {
    const why = end.why === "wrote" && end.thread ? `: you wrote in ${wroteIn({ thread: end.thread, machine: end.machine }, o.names, o.computers)}` : end.why === "stop" ? ": you stopped it" : "";
    lines.push({ at: end.at, key: "ended", text: `Away ended${why}` });
  }
  return lines;
}

/**
 * What the voice says, word for word, only when asked what's being watched or whether Away is on (Fable, 3.9-G;
 * unmeasured): "Away is on until Monday at 8 in the morning."; once it's ended, for a day, "Away ended at 2 in the
 * afternoon, when you wrote in Migration on Lattice." or "Away ended at 8 in the morning." (its time, or Stop). Null
 * when there's nothing to say.
 */
export function awaySaid(e: AwayEntry | undefined, on: boolean, o: AwayWords, now: number): string | null {
  if (!e) return null;
  if (on && !e.ended) return `Away is on until ${spokenDay(e.until, o.zone, now)}.`;
  const end = e.ended;
  if (!end || now - end.at > 86_400_000) return null;
  // A time led by its day takes no "at" of its own (Fable on 3.9): "Away ended yesterday at 10 in the evening", never
  // "ended at yesterday at"; today's is "Away ended at 2 in the afternoon".
  const day = spokenDay(end.at, o.zone, now);
  const when = day.includes(" at ") ? day : `at ${day}`;
  return end.why === "wrote" && end.thread ? `Away ended ${when}, when you wrote in ${wroteIn({ thread: end.thread, machine: end.machine }, o.names, o.computers)}.` : `Away ended ${when}.`;
}
