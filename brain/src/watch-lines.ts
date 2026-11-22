// What a call-back asked for with a mode says (docs/launch/engine.md §11, stage 3.6; Fable's decisions, topics 0 to 8,
// binding for words): built here, said word for word (never the model's own), as levels.ts's readbacks are. A plain
// "call me when API replies" keeps the model's one short sentence, with nothing from here.
//
// A request with a mode (all of several threads, only trouble or a failure, not before a time, a length) gets a fixed
// statement, then the hang-up: no "OK?". A question that waits for a yes only when what will happen is less than asked:
// the level's length, a time the watch can't reach, Commute's day's call-back used. A level is named only to an account
// on its plan (`named`); the lines saying what would change it name levels to everyone, as `NO_LIMIT` does.
//
// Stage 3.8 (§11 item 8; Fable's topics 13 and 14): a deadline ("I'll call you at 6 in the evening if API isn't done, or
// sooner if it fails or asks you something.") and a check-in ("I'll call you at 3 in the afternoon about API."), said the
// same way, with no "I'll watch for up to…" (the time is the end); a time past what the level watches is offered at the
// furthest it can keep, and that waits for a yes.
//
// Stage 3.10 (§11 item 10; Fable's 3.10-B and 3.10-G): "call me when API's tests pass" is one more mode, its clause
// dropped into every statement and readback ("…when API's tests pass, or if it stops before they do…").

import { NOTHING_SET_UP, type LevelName } from "./levels.ts";
import { possessive } from "./receipts.ts";
import { spokenLength } from "./zone.ts";

/**
 * How it will reach them over the watch: a call; a notification (it can't call, Notifications on); kept for the next
 * call (neither); staying on the call, told in it.
 */
export type Verb = "call" | "notify" | "kept" | "tell";

/**
 * A time asked for (stage 3.8): a deadline or a check-in, when as said, on the clock ("6 in the evening") when it was
 * said as a time of day, else as a length from now ("2 hours").
 */
export type AskTime = { kind: "deadline" | "check"; clock: string | null; length: string };

/**
 * What was asked: the threads as the user named them, waiting for all of them, only for trouble or a failure, not before
 * a time (as said: "7 in the evening"), how long it watches, and a time (stage 3.8).
 */
export type Ask = { threads: string[]; all: boolean; only: "failed" | "trouble" | null; notBefore: string | null; watchMs: number; time?: AskTime; tests?: boolean };

/** When a time falls, after a verb: "at 6 in the evening", "in 2 hours". */
const whenOf = (t: AskTime) => (t.clock ? `at ${t.clock}` : `in ${t.length}`);

/** A deadline's condition: "API isn't done", "API and Docs aren't both done", "API, Docs and Schema aren't all done". */
function notDone(threads: string[], counted: string): string {
  const n = threads.length;
  if (n === 1) return `${threads[0]} isn't done`;
  if (n === 2) return `${named(threads)} aren't both done`;
  return n === 3 ? `${named(threads)} aren't all done` : `${counted} aren't all done`;
}

/** Threads as named: "API", "API and Docs", "API, Docs and Schema"; four or more, null (said by count). */
function named(threads: string[], or = false): string | null {
  const j = or ? "or" : "and";
  if (threads.length === 1) return threads[0];
  if (threads.length === 2) return `${threads[0]} ${j} ${threads[1]}`;
  if (threads.length === 3) return `${threads[0]}, ${threads[1]} ${j} ${threads[2]}`;
  return null;
}

const all = (a: Ask) => a.all && a.threads.length > 1;

/**
 * The mode's clause, after its verb: "when API and Docs are both done", "only if API fails or is stopped", "only if
 * API fails, is stopped or asks you something, or if it's still working after 4 hours", "when API replies".
 */
export function clauseOf(a: Ask): string {
  const n = a.threads.length;
  // A time (stage 3.8): "at 6 in the evening if API isn't done, or sooner if it fails or asks you something"; "at 3 in
  // the afternoon about API".
  if (a.time?.kind === "deadline") return `${whenOf(a.time)} if ${notDone(a.threads, `the ${n} threads`)}, or sooner if ${n === 1 ? "it" : "one"} fails or asks you something`;
  if (a.time) return `${whenOf(a.time)} about ${named(a.threads) ?? `the ${n} threads`}`;
  // A thread's tests (stage 3.10, one thread): the stop it also calls for is said, so that call is one they asked for.
  if (a.tests) return `when ${possessive(a.threads[0])} tests pass, or if it stops before they do`;
  const or = named(a.threads, true);
  const length = spokenLength(a.watchMs);
  if (a.only === "failed") return or ? `only if ${or} fails or is stopped` : `only if one of the ${n} threads fails or is stopped`;
  if (a.only === "trouble") {
    const who = or ?? `one of the ${n} threads`;
    return `only if ${who} fails, is stopped or asks you something, or if ${n === 1 ? "it's" : "one is"} still working after ${length}`;
  }
  if (all(a)) return n === 2 ? `when ${named(a.threads)} are both done` : n === 3 ? `when ${named(a.threads)} are all done` : `when all ${n} threads are done`;
  return or ? `when ${or} replies` : `when one of the ${n} threads replies`;
}

const VERB: Record<Exclude<Verb, "kept">, string> = { call: "I'll call you", notify: "I'll send a notification", tell: "I'll tell you" };

/** The main sentence (Fable, topic 3): the verb, the mode's clause, all's "or sooner…", and a not-before. */
export function mainOf(a: Ask, verb: Exclude<Verb, "kept">): string {
  const sooner = all(a) && !a.only && !a.time ? ", or sooner if one fails or asks you something" : "";
  const notBefore = a.notBefore ? `, but not before ${a.notBefore}` : "";
  return `${VERB[verb]} ${clauseOf(a)}${sooner}${notBefore}.`;
}

/**
 * The statement for a call-back asked for with a mode, said word for word, then the hang-up (no yes: it's what they
 * asked for). Every mode but trouble (whose length is in its clause) adds "I'll watch for up to <length>." Kept (it can't
 * call, Notifications off): one sentence naming no mode, since nothing will reach them.
 */
export function statementOf(a: Ask, verb: Verb): string {
  const who = named(a.threads) ?? `the ${a.threads.length} threads`;
  // A time (stage 3.8): the time is the end, so no "I'll watch for up to…"; kept, until then.
  if (a.time) return verb === "kept" ? `I'll watch ${who} ${a.time.clock ? `until ${a.time.clock}` : `for ${a.time.length}`} and tell you in your next call.` : mainOf(a, verb);
  if (verb === "kept") return `I'll watch ${who} for up to ${spokenLength(a.watchMs)} and tell you in your next call.`;
  return a.only === "trouble" ? mainOf(a, verb) : `${mainOf(a, verb)} I'll watch for up to ${spokenLength(a.watchMs)}.`;
}

/** What's said after a yes to a time's readback (Fable, topic 14): "I'll call at 11:40 in the evening." */
function agreedAt(t: AskTime, verb: Exclude<Verb, "kept">): string {
  return `${verb === "call" ? "I'll call" : verb === "notify" ? "I'll send a notification" : "I'll tell you"} ${whenOf(t)}.`;
}

/**
 * A time past what the level watches (Fable, topic 14): the offer is the furthest it can keep (`a.time`, now plus the
 * level's length), since an earlier check does no harm, unlike a not-before. Said as a time of day, the time asked for
 * is named ("I can watch for up to 4 hours on Road Trip, so not until 6 tomorrow morning. I'll call you at 11:40 in the
 * evening if API isn't done, or sooner if it fails or asks you something. OK?"; a check-in's ends "…about API instead.
 * OK?"); said as a length, never echoed, as topic 4A's ("I can watch for up to 4 hours. I'll call you in 4 hours about
 * API. OK?"). Yes: "I'll call at 11:40 in the evening."
 */
export function timeReadback(a: Ask & { time: AskTime }, verb: Exclude<Verb, "kept">, levelMs: number, asked: string | null, level: LevelName, isNamed: boolean): { readback: string; agreed: string } {
  const head = `I can watch for up to ${spokenLength(levelMs)}${on(level, isNamed)}${asked ? `, so not until ${asked}` : ""}.`;
  return { readback: `${head} ${VERB[verb]} ${clauseOf(a)}${asked && a.time.kind === "check" ? " instead" : ""}. OK?`, agreed: agreedAt(a.time, verb) };
}

/** " on Road Trip" to an account on that level's plan, else nothing (3.3's `named`). */
const on = (level: LevelName, isNamed: boolean) => (isNamed ? ` on ${level}` : "");

/**
 * Asked for longer than the level watches (Fable, topic 4A): what it can do, then the statement's main sentence at the
 * level's length, and "OK?". Never the length they asked for ("overnight" has none).
 */
export function lengthReadback(a: Ask, verb: Exclude<Verb, "kept">, level: LevelName, isNamed: boolean): { readback: string; agreed: string } {
  const length = spokenLength(a.watchMs);
  return { readback: `I can watch for up to ${length}${on(level, isNamed)}. ${mainOf(a, verb)} OK?`, agreed: `I'll watch for ${length}.` };
}

/**
 * Not before a time the watch ends before (Fable, topic 4B): never the call at the time they asked not to be called.
 * With Notifications on, a notification instead, for the watch's whole length; with them off, nothing is set up. A
 * tests ask's clause ends "…before they do", so "instead" goes before it ("I can send a notification instead, when
 * API's tests pass, or if it stops before they do. OK?"; Fable on 3.9 and 3.10).
 */
export function notBeforeReadback(a: Ask, notifications: boolean, level: LevelName, isNamed: boolean): { readback: string; agreed: string } | { refused: string } {
  const head = `I can watch for up to ${spokenLength(a.watchMs)}${on(level, isNamed)}, and that ends before ${a.notBefore}.`;
  if (!notifications) return { refused: `${head} ${NOTHING_SET_UP}` };
  const offer = a.tests && !a.time ? `instead, ${clauseOf(a)}` : `${clauseOf(a)} instead`;
  return { readback: `${head} I can send a notification ${offer}. OK?`, agreed: "I'll send a notification." };
}

/**
 * A bare hour whose half was guessed and lands in the small hours, 00:00 to 05:59 ("call me at 3 about API" said at
 * 17:40 is 3 tomorrow morning; Fable's finding on 3.6 to 3.8, the one exception to topic 0's rule 1): the statement,
 * waiting for a yes, so a wrong guess is heard while it can still be answered. Yes: the time it agrees to ("I'll call at
 * 3 tomorrow morning."; a not-before, "I won't call before 3 tomorrow morning."; kept, "I'll tell you in your next
 * call."). No: `NOTHING_SET_UP`, as every readback's.
 */
export function smallHoursReadback(a: Ask, verb: Verb, statement: string): { readback: string; agreed: string } {
  const agreed = verb === "kept" ? NEXT_CALL
    : a.time ? agreedAt(a.time, verb)
    : `I won't ${verb === "call" ? "call" : verb === "notify" ? "send a notification" : "tell you"} before ${a.notBefore}.`;
  return { readback: `${statement} OK?`, agreed };
}

/** ", but not before 7 in the evening" when one was asked for and is kept. */
const notBeforeOf = (a: Ask) => (a.notBefore ? `, but not before ${a.notBefore}` : "");

/** Said after a yes to a readback whose news waits for the next call (Commute's day used, Notifications off, a mode). */
export const NEXT_CALL = "I'll tell you in your next call.";

/**
 * Commute's call-back used, with a mode (Fable, topic 4C), and with a length over its hour as well (4D: one readback,
 * the ring first). A plain ask keeps `commuteReadback`'s words, and this is them with the mode's clause, so no "instead"
 * either (the voice evals, 19 November). A not-before kept is said ("…, but not before 7 in the evening. OK?", Fable's
 * finding on 3.6 to 3.8). With Notifications off, nothing reaches them before their next call: the kept statement, which
 * says the length it keeps, and the time asked for when it was said as one.
 */
export function commuteModeReadback(a: Ask, longer: boolean, isNamed: boolean, asked: string | null = null, notifications = true): { readback: string; agreed: string } {
  const head = `You've had today's call-back${isNamed ? " on Commute" : ""}`;
  if (!notifications) {
    const cut = longer && asked ? `, and I can watch for up to ${spokenLength(a.watchMs)}, so not until ${asked}` : "";
    return { readback: `${head}${cut}. ${statementOf(a, "kept")} OK?`, agreed: NEXT_CALL };
  }
  if (longer) {
    // A time past its hour (stage 3.8): the furthest it can keep, the time asked for named when it was said as one.
    return {
      readback: `${head}, and I can watch for up to ${spokenLength(a.watchMs)}${asked ? `, so not until ${asked}` : ""}. I'll send a notification ${clauseOf(a)}${notBeforeOf(a)}. OK?`,
      agreed: a.time ? agreedAt(a.time, "notify") : "I'll send a notification.",
    };
  }
  return { readback: `${head}. I'll send a notification ${clauseOf(a)}${notBeforeOf(a)}. OK?`, agreed: `I'll send a notification ${clauseOf(a)}${notBeforeOf(a)}.` };
}

/**
 * Commute's one call-back a day held by another call-back asked for that hasn't rung yet (3.3's "second"), with a mode
 * (Fable's finding on 3.6 to 3.8): 3.3's line with the mode's main sentence before "OK?"; when the level cuts a length or
 * a time, one readback says both, the call-back first: "I'll call for whichever comes first, and I can watch for up to an
 * hour, so not until 6 in the evening. Commute has one call-back a day. I'll call you at 3 in the afternoon if API isn't
 * done, or sooner if it fails or asks you something. OK?" (without the level's name, "There's one call-back a day.").
 */
export function secondReadback(a: Ask, longer: boolean, levelMs: number, asked: string | null, notifications: boolean, isNamed: boolean): { readback: string; agreed: string } {
  const day = isNamed ? "Commute has one call-back a day." : "There's one call-back a day.";
  const first = longer
    ? `I'll call for whichever comes first, and I can watch for up to ${spokenLength(levelMs)}${asked ? `, so not until ${asked}` : ""}.`
    : `I'll call for whichever comes first; the other ${notifications ? "will be a notification" : "will wait for your next call"}.`;
  return { readback: `${first} ${day} ${mainOf(a, "call")} OK?`, agreed: "I'll call for whichever comes first." };
}

/**
 * `wait_for` in a conversation whose call-back is already watching, asked for something else (a mode, a time or a length
 * the open one doesn't have, or none where it has one: Fable's finding on 3.6 to 3.8, "safest for now"): one wait per
 * conversation, so nothing is merged or changed and nothing is set up. From stage 2b a call-back can be stopped by voice
 * (`stop_watching`), so it says how (Fable's 2b topic 2).
 */
export function alreadyWatching(threads: string[]): string {
  const who = named(threads);
  return `I'm already watching ${who ?? `${threads.length} threads`}. Say stop watching ${who ?? "them"}, then ask again.`;
}

// --- Stage 2b: "What are you watching for me?" and "Stop watching API" (Fable's 2b topics 1 and 2; stage 4's 4-D adds
// sends, starts and held commands), said word for word ---

/**
 * A Watching row as the voice says it (Fable's 2b topic 1): the app's sentence (`said`, its times on the spoken clock)
 * with its first words changed for speech and nothing else reworded; then, unless the sentence has a time of its own (a
 * deadline, a check-in, a not-before: `timed`), the time left (", for the next 40 minutes"); then of the row's second
 * line only how many are done and a computer offline, each its own short sentence. Away's row (`away`) is its own line.
 */
export type SpokenRow = { said: string; threads: string[]; timed: boolean; leftMs: number; done?: { n: number; total: number }; offline: string[] } | { away: string };

export function sayRow(r: SpokenRow): string {
  if ("away" in r) return r.away;
  const s = r.said.startsWith("Calling you ") ? `I'll call you ${r.said.slice("Calling you ".length)}`
    : r.said.startsWith("Telling you ") ? `I'll notify you ${r.said.slice("Telling you ".length)}`
    // Kept for the next call: "I'm keeping API's news…", several "I'm keeping news from API, Docs and Schema…".
    : r.said.startsWith("Watching ") && r.said.endsWith(" for your next call")
    ? (r.threads.length === 1 ? `I'm keeping ${possessive(r.threads[0])} news for your next call` : `I'm keeping news from ${named(r.threads) ?? `${r.threads.length} threads`} for your next call`)
    : r.said;
  // Two times in one heard sentence don't survive: no time left after a sentence with a time of its own.
  // "for the next hour", not "the next an hour".
  const left = r.timed ? "" : `, for the next ${spokenLength(r.leftMs).replace(/^an? /, "")}`;
  return [`${s}${left}.`, ...(r.done ? [`${r.done.n} of ${r.done.total} done so far.`] : []), ...r.offline.map((m) => `${m} is offline.`)].join(" ");
}

const COUNTS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const counted = (n: number) => COUNTS[n - 1] ?? String(n);

/** Nothing watched (Fable's 2b topic 1). */
export const NOTHING_WATCHED = "Nothing right now.";
/** Nothing watched, while the threads they follow notify them. */
export const FOLLOWED_STILL = "The threads you follow still notify you.";

/** "And " before the last row: a sentence of the app's own that starts "When" (a chain's) goes on in lower case. */
const and = (row: string) => `And ${/^When\b/.test(row) ? `${row[0].toLowerCase()}${row.slice(1)}` : row}`;

/**
 * The whole answer to "What are you watching for me?" (Fable's 2b topic 1), from the rows as said (`sayRow`, and 4-D's
 * own sentences), in order: "One thing. …"; "Two things. … And …" ("And" before the last row only); more than three of
 * Watching's rows, the first three and "And 2 more, in Watching on your phone." A row Watching doesn't show (`{ whole }`:
 * a command held for them) is always said, outside the three, and never among the more (Fable's ruling on the review of
 * 4-E). `followed`: nothing watched, the threads they follow still notify them.
 */
export function watchingAnswer(rows: (string | { whole: string })[], followed: boolean): string {
  if (!rows.length) return followed ? `${NOTHING_WATCHED} ${FOLLOWED_STILL}` : NOTHING_WATCHED;
  const head = `${counted(rows.length)} ${rows.length === 1 ? "thing" : "things"}.`;
  let shown = 0;
  const said = rows.flatMap((r) => (typeof r !== "string" ? [r.whole] : shown++ < 3 ? [r] : []));
  const more = shown - 3;
  if (more <= 0) return [head, ...said.map((r, i) => (i > 0 && i === said.length - 1 ? and(r) : r))].join(" ");
  return [head, ...said, `And ${counted(more).toLowerCase()} more, in Watching on your phone.`].join(" ");
}

/** "Stopped watching API." ("…API and Docs.") */
export const stoppedWatching = (threads: string[]) => `Stopped watching ${named(threads) ?? `${threads.length} threads`}.`;
/** After `stoppedWatching`, for a thread they follow that still notifies them. */
export const STILL_FOLLOWED = "You still follow it, so it'll still notify you.";
/** A row about threads they didn't name too: it stops whole, so nothing's stopped until they say. */
export function stopWholeQuestion(threads: string[]): string {
  return threads.length === 2 ? `That one watches ${named(threads)} together. Stop both?` : `That one watches ${named(threads) ?? `${threads.length} threads`} together. Stop all of them?`;
}
/** A no to `stopWholeQuestion`. */
export const STILL_WATCHING = "Okay, still watching.";
/** "Stop watching everything": every call-back stopped (never Away). */
export const STOPPED_ALL = "Stopped. I'm not watching anything now.";
/** After `STOPPED_ALL` (or `NOTHING_TO_STOP`), with Away on: stopping everything doesn't end it. */
export const AWAY_STILL_ON = "Away is still on.";
/** A thread named that nothing watches: "I'm not watching API." ("…API or Docs.") */
export const notWatching = (threads: string[]) => `I'm not watching ${named(threads, true) ?? `those ${threads.length} threads`}.`;
/** Nothing watched at all. */
export const NOTHING_TO_STOP = "I'm not watching anything right now.";
/** The stop failed. */
export const STOP_FAILED = "I couldn't stop that. Try Stop in Watching on your phone.";

/** Said only if they ask what would change the length (Fable, topic 4A): naming levels to everyone, as `NO_LIMIT` does. */
export const LONGER: Record<LevelName, string> = {
  Commute: "Road Trip watches for 4 hours, and Long Haul for 12.",
  "Road Trip": "Long Haul watches for 12 hours.",
  "Long Haul": "12 hours is the longest I can watch.",
};

/**
 * Asked to watch wider than the threads they name ("anything I follow", "everything"). 3.6 builds the named scope only,
 * so every wide ask is answered with this, word for word, and nothing is set up (Fable, topic 5's fallback).
 */
export const WHICH_THREADS = "Which threads should I watch?";

/** A time whose yes came after it (Fable, topic 14): nothing is set up. */
export const TIME_PASSED = "That time has passed, so nothing's set up.";

/** A repeating time asked for by voice (Fable, topic 13): nothing is set up (the `every` trigger is built, for your rules). */
export const NO_REPEATS = "I can't set up repeating times by voice yet.";

/** A deadline's Watching row's note, the second line's start (Fable, topic 16). */
export const SOONER = "Sooner if it fails or asks";

/** A time of day asked for with no zone from the phone (Fable, topic 1; "phone's" dropped, Fable after the eval: the voice left it out 5 times in 6): nothing is set up. */
export const NO_ZONE = "I don't have your time zone, so I can't set a time of day. Say it as a length instead, like in 2 hours.";

/** Watching's verbs (Fable, 3.3 and topic 8): it would call, it would send a notification, or it's kept. */
export type Doing = "calling" | "telling" | "kept";

/**
 * Watching's sentence for a call-back with a mode (Fable, topic 8), names as the app shows them: "Calling you when API
 * and Docs are both done", "Calling you only if API fails", "Telling you only if API fails or asks", and the kept form
 * "Watching API, Docs and Schema for your next call" (never with a not-before). `from`: a not-before still ahead, as shown ("19:00"). For all
 * of several threads or only some news; a plain one's sentence is 3.3's, with `from` after it.
 */
export function watchingOf(threads: string[], mode: { all: boolean; only: "failed" | "trouble" | null; tests?: boolean }, doing: Doing, from: string | null): string {
  const n = threads.length;
  const tail = from ? `, from ${from}` : "";
  // Kept: nothing reaches them before their next call, so a not-before means nothing (Fable).
  if (doing === "kept") return `Watching ${named(threads) ?? `${n} threads`} for your next call`;
  const verb = doing === "calling" ? "Calling you" : "Telling you";
  // A thread's tests (stage 3.10; Fable, 3.10-G): one short sentence, nothing about "or if it stops".
  if (mode.tests) return `${verb} when ${possessive(threads[0])} tests pass${tail}`;
  const or = named(threads, true) ?? `one of ${n} threads`;
  if (mode.only) return `${verb} only if ${or} ${mode.only === "failed" ? "fails" : "fails or asks"}${tail}`;
  return `${verb} when ${n === 2 ? `${named(threads)} are both done` : n === 3 ? `${named(threads)} are all done` : `all ${n} threads are done`}${tail}`;
}

/**
 * Watching's sentence for a time (stage 3.8; Fable, topic 16), names as the app shows them: a deadline, "Calling you at
 * 18:00 if API isn't done" ("…if API and Docs aren't both done", "…if 4 threads aren't all done"); a check-in, "Calling
 * you at 15:00 about API" ("about 4 threads"). `at`: the time as shown now ("03:00 tomorrow"); null with no zone ("Calling
 * you if API isn't done in time", "Calling you about API": the time left carries the when). Kept, as ever, "Watching API
 * for your next call". `from`: a not-before still ahead.
 */
export function timeWatchingOf(threads: string[], kind: "deadline" | "check", at: string | null, doing: Doing, from: string | null): string {
  const n = threads.length;
  const tail = from ? `, from ${from}` : "";
  if (doing === "kept") return `Watching ${named(threads) ?? `${n} threads`} for your next call`;
  const verb = doing === "calling" ? "Calling you" : "Telling you";
  const when = at ? ` at ${at}` : "";
  if (kind === "deadline") return `${verb}${when} if ${notDone(threads, `${n} threads`)}${at ? "" : " in time"}${tail}`;
  return `${verb}${when} about ${named(threads) ?? `${n} threads`}${tail}`;
}
