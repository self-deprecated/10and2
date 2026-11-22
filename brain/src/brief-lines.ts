// Brief me since a time, and the morning briefing (docs/launch/engine.md §11 stage 4; Fable's 4-I, binding for words).
// Every line here is built in code and said word for word; the model writes none of them. What they count is facts
// (`happenedOf`: a question the work system holds open, a run that ended failed, stopped or with a
// reply), never what an agent says it did. Spoken times are `spokenSince`'s ("6 this morning", "11 last night").
import type { WorkItem } from "./adapter.ts";
import { countsLine } from "./reach.ts";
import { clockOf, spokenSince, type Every } from "./zone.ts";

/** What happened since a time, by thread: asking, failed (or stopped), replied. */
export type Counts = { asks: number; failed: number; replied: number };

/**
 * What happened between `since` and `until`, by thread, from the facts the work systems report (no model call, never
 * what an agent's reply says it did): each top-level thread not settled, once: asking (a question it holds open, from
 * after `since`), else its last run ended in that time, failed (or stopped) or with a reply. Each group oldest first.
 */
export type Happened = { asks: WorkItem[]; failed: WorkItem[]; replied: WorkItem[] };

export function happenedOf(items: Iterable<WorkItem>, since: number, until: number): Happened {
  const h: Happened = { asks: [], failed: [], replied: [] };
  for (const i of items) {
    if (i.parentId !== null || i.settled) continue;
    const runAt = i.lastRunAt ? Date.parse(i.lastRunAt) : NaN;
    if (i.pendingQuestion && Date.parse(i.updatedAt) > since) h.asks.push(i);
    else if (runAt > since && runAt <= until) (i.status === "failed" || i.status === "cancelled" ? h.failed : h.replied).push(i);
  }
  const at = (i: WorkItem) => Date.parse(i.pendingQuestion ? i.updatedAt : (i.lastRunAt ?? i.updatedAt));
  for (const g of [h.asks, h.failed, h.replied]) g.sort((a, b) => at(a) - at(b));
  return h;
}

export const countsOf = (h: Happened): Counts => ({ asks: h.asks.length, failed: h.failed.length, replied: h.replied.length });

/** The threads in the order a briefing tells them (Fable's 4-I): asking, failed, then replied, oldest first in each. */
export const toldOrder = (h: Happened): WorkItem[] => [...h.asks, ...h.failed, ...h.replied];

/** Said when the since isn't one of Fable's (4-I): nothing is briefed, and nothing more is said. */
export const SINCE_WHEN = "Since when?";

/** Said instead of `SINCE_WHEN` when the one before it in the call missed too (Fable's ruling on 4-I's review). */
export const SINCE_WHEN_AGAIN = "Since when? Say a time, like this morning or 3.";

/**
 * Said when no time zone is known, the phone's or a computer's (Fable's ruling on 4-I's review, NO_ZONE's style): the
 * since was understood, but it can't be said, so nothing is briefed, "my last call" included.
 */
export const NO_ZONE_BRIEF = "I don't have your time zone, so I can't brief you since a time yet.";

/** Said after the opening when the replies are read in full, as they are. */
export const IN_FULL = "Here they are in full.";

/** In full, after a thread's name line, when its reply can't be read from its computer (Fable's ruling on 4-I's review). */
export const REPLY_UNREAD = "Its reply couldn't be read.";

/** Said before a summary's opening when the replies were asked for in full and none can be read (Fable's ruling). */
export const NONE_READ = "I can't read the replies right now.";

/**
 * In full, after a thread's name line, for a thread that failed or was stopped: what the facts say, never an older
 * reply read as if it were the news (the skeptic's finding on 4-I); with a reply since, said before it (Fable's ruling
 * on 4-I's second review: "API, in driver. It failed. <reply>"). Words of the builder's, from 3.6's caller lines,
 * approved by Fable on 4-I's second review.
 */
export const endedWith = (status: string) => (status === "cancelled" ? "It was stopped." : "It failed.");

/**
 * In full, after a thread's name line, for a run that ended since the since with no reply of its own since then (its
 * report was read, and its last reply is older): Fable's words on 4-I's second review. "Its reply couldn't be read." is
 * only for a report that couldn't be.
 */
export const NO_REPLY = "It finished with no reply.";

/** The most threads a summary tells, as today's briefing (callview.ts `AGENDA_MAX`); the counts stay whole. */
export const SUMMARY_MAX = 8;

/** Said after a summary cut at `SUMMARY_MAX`, how many more there are (Fable's ruling on 4-I's review): "And 4 more.". */
export const andMore = (n: number) => `And ${n} more.`;

/**
 * In a call, the opening said word for word before the briefing (Fable's 4-I, `countsLine`'s groups and order, zero
 * groups left out): "Since 6 this morning: 2 threads ask, 1 failed, 5 replied."; nothing, "Nothing happened since 6 this
 * morning." and nothing more.
 */
export const sinceOpening = (c: Counts, since: string) => countsLine(c, since);

/** Whether anything happened. */
export const anything = (c: Counts) => c.asks + c.failed + c.replied > 0;

/**
 * About how many words the reading voice says a minute: briefing-reading.ts's 850 characters a minute, at about 5.7
 * characters a word with its space.
 */
export const WORDS_PER_MINUTE = 150;

/** How long replies of `words` words take to read, in whole minutes, rounded up. */
export const readMinutes = (words: number) => Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));

/** More replies than this read in full waits for a yes first. */
export const FULL_WITHOUT_ASKING = 5;

/** Asked before reading more than five replies in full (Fable's 4-I): "8 replies in full is about 12 minutes. Go ahead?". */
export const fullLength = (replies: number, minutes: number) => `${replies} replies in full is about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Go ahead?`;

/** The words in a line of your rules, or in an ask, that choose the replies read in full; anything else is a summary. */
const FULL = /\b(?:in full|word for word|read me the replies|the whole replies|full replies)\b/gi;

/**
 * Said just before those words, in the same clause, they don't choose full: "not in full", "without the replies in
 * full", "don't read me the replies"; "no" only a word before ("no replies in full"). A comma, semicolon, colon, full
 * stop or spaced dash between ends it ("not a summary, in full", "never mind, read them in full": Fable's and the
 * skeptic's findings on 4-I's second review; "don't shorten them: in full": Fable's on its fourth), as does "no"
 * further off ("no I want them in full"), and "but" ("not the summary but in full"). "Don't" and "do not" reach to the
 * end of their clause ("please don't read it all out word for word"): Fable's finding on 4-I's third review.
 */
const WORD = String.raw`\s+(?!but\b|[-–—]+(?:\s|$))[^\s,;.:]+`;
const NOT = new RegExp(String.raw`(?:\b(?:don['’]?t|do not)\b(?:${WORD})*|\b(?:not|without|never)\b(?:${WORD}){0,3}|\bno\b(?:${WORD})?)\s*$`, "i");

/**
 * A summary, or each reply read as it is (Fable's 4-I: only "in full", "word for word", "read me the replies"; "full
 * replies" may stay), never when they're negated ("not in full": Fable's ruling on 4-I's review).
 */
export const briefingAs = (said: string): "summary" | "full" => ([...said.matchAll(FULL)].some((m) => !NOT.test(said.slice(0, m.index))) ? "full" : "summary");

/**
 * What a briefing made ahead says first when it's played (Fable's 4-I): before noon "Good morning.", else no greeting;
 * then since when, and what happened: "Good morning. Since 11 last night, 6 threads replied, and 2 are waiting on you.";
 * a failure is said as one, never counted as a reply ("6 threads replied, 1 failed, and 2 are waiting on you."); "and N
 * are waiting on you" only when N > 0. Nothing happened: "Good morning. Nothing happened since 11 last night.".
 * `hour`: the local hour it's made for.
 */
export function playedOpening(c: Counts, since: string, hour: number): string {
  const greeting = hour >= 0 && hour < 12 ? "Good morning. " : "";
  if (!anything(c)) return `${greeting}Nothing happened since ${since}.`;
  const threads = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;
  const parts: string[] = [];
  if (c.replied) parts.push(`${threads(c.replied)} replied`);
  if (c.failed) parts.push(parts.length ? `${c.failed} failed` : `${threads(c.failed)} failed`);
  if (c.asks) parts.push(parts.length ? `${c.asks} ${c.asks === 1 ? "is" : "are"} waiting on you` : `${threads(c.asks)} ${c.asks === 1 ? "is" : "are"} waiting on you`);
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `${greeting}Since ${since}, ${said}.`;
}

/**
 * What a briefing since a time opens with, and what it's made from, so the opening can be said again as of when it's
 * played (the skeptic's and Fable's findings on 4-I: made at 08:00 Friday and played Saturday, "yesterday" is Thursday):
 * a call's (`sinceOpening`) or one played from a notification or Siri (`playedOpening`, its greeting by the hour it's
 * played).
 */
export type Opening = { said: "call" | "played"; since: number } & Counts;

/** `o`'s opening as said at `now` on the clock in `zone`. */
export const openingAt = (o: Opening, zone: string, now: number): string =>
  o.said === "call" ? sinceOpening(o, spokenSince(o.since, zone, now)) : playedOpening(o, spokenSince(o.since, zone, now), clockOf(now, zone).hour);

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A repeating time's days as shown: "on weekdays", "every day", "at weekends", "on Mondays and Thursdays". */
function daysShown(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return "every day";
  if (d.join() === "1,2,3,4,5") return "on weekdays";
  if (d.join() === "0,6") return "at weekends";
  const names = d.map((x) => DAY_NAMES[x]);
  return `on ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
}

/**
 * How I read a briefing's line in your rules (Fable's 4-I; example 6): "At 08:00 on weekdays, your phone's time: a
 * briefing of what happened since the last one, as a summary. A notification when it's ready." or "…, with each reply
 * read in full. A notification when it's ready.". Shown, never said.
 */
export function briefingReading(every: Every, as: "summary" | "full"): string {
  return `At ${every.time} ${daysShown(every.days)}, your phone's time: a briefing of what happened since the last one, ${as === "full" ? "with each reply read in full" : "as a summary"}. A notification when it's ready.`;
}

/** The two example lines offered for a morning briefing (Fable's 4-I; example 6), summary and full. */
export const BRIEFING_EXAMPLES = [
  "Every weekday at 8, have a briefing ready of what happened overnight.",
  "Every weekday at 8, have a briefing ready of what happened overnight, with the replies in full.",
] as const;
