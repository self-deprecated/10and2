// Your rules (docs/launch/engine.md §2, Your rules; §11 stage 3.4; Fable's decisions for 3.4, binding for words): one
// markdown file per account, kept in the account's brain store (kv `rules_file`, Jordan, 20 November), edited in the app.
// Each line that isn't a heading is one rule in the user's own words. An example runs at once: each has a fixed reading
// built here. Stage 3.5 (reader.ts): a line in your own words is read once by the rules reader, where the brain has one,
// and runs once you say Use these rules; without a reader it's kept and shown "Not read yet", as in 3.4.
//
// A line becomes a rule where it's stored (table `rules`, `made.via: "file"`, keyed by its normalised text), so an
// unchanged line keeps its rule and state across saves, a new one is a new rule from then (no catch-up), and a removed
// one's rule stops with what it hadn't sent. What a line does is the engine's (engine.ts); what it says is here.
import { createHash } from "node:crypto";
import type { Checked, Project, Scope } from "./reader.ts";
import { INPUT_JUDGED, INPUT_NOT_CAUGHT, JUDGED_TAIL, PAUSED, sentenceOf, judgedOf } from "./reader.ts";
import type { Joined } from "./rules.ts";
import type { Store } from "./store.ts";
import { clockOf, instantOf, nextDate, parseClock, parseLength, prevDate, weekdayOf, type Heard } from "./zone.ts";

/** The most rules a file may hold, and the longest a rule may be (Fable, topic 1). */
export const RULES_MAX = 30;
export const LINE_MAX = 200;

const FILE_KEY = "rules_file";
const REMOVED_KEY = "rules_removed";

/** The file as kept: its version (0 for never saved), its text, when and from where it was saved. */
export type RulesFile = { v: number; text: string; savedAt: number; by: "app" | "voice" };

export const NO_FILE: RulesFile = { v: 0, text: "", savedAt: 0, by: "app" };

export function fileOf(store: Pick<Store, "get">): RulesFile {
  try {
    const f = JSON.parse(store.get(FILE_KEY) ?? "null");
    return f && Number.isInteger(f.v) && f.v > 0 && typeof f.text === "string" && Number.isFinite(f.savedAt) ? { v: f.v, text: f.text, savedAt: f.savedAt, by: f.by === "voice" ? "voice" : "app" } : NO_FILE;
  } catch {
    return NO_FILE;
  }
}

export function saveFile(store: Pick<Store, "set">, f: RulesFile) {
  store.set(FILE_KEY, JSON.stringify(f));
}

/**
 * How long a removed line's rule can come back as it was (Undo, which the phone offers for 5 s, over a slow network):
 * after that a line put back is a new rule from then, with no catch-up (the reviews of 3.4).
 */
export const UNDO_MS = 2 * 60_000;

/**
 * Rules a save took away, kept for the next save only, within `UNDO_MS` of it (Fable, topic 1: Undo puts the same line
 * back in the same place, its rule keeping its id and state if no other save came between). `at`: when.
 */
export function removedOf(store: Pick<Store, "get">): { v: number; at?: number; rows: { id: string; rule: string }[] } | null {
  try {
    const r = JSON.parse(store.get(REMOVED_KEY) ?? "null");
    return r && Number.isInteger(r.v) && Array.isArray(r.rows) ? r : null;
  } catch {
    return null;
  }
}

export function saveRemoved(store: Pick<Store, "set">, r: { v: number; at: number; rows: { id: string; rule: string }[] }) {
  store.set(REMOVED_KEY, JSON.stringify(r));
}

/** A line of the file: a rule (its words, without a list marker), a heading (as written) or blank. */
export type Line = { at: number; kind: "rule" | "heading" | "blank"; text: string };

/**
 * The file's lines (Fable, topic 2): every non-empty line that doesn't start with "#" is a rule, with a leading "- ",
 * "* ", "+ " or "1. " and the spaces round it dropped, so plain sentences typed in Edit as text are rules too. Also a
 * markdown file's other markers (the eighth reviews): "1) ", "• ", a quote's "> " and a task's "[ ] " or "[x] ".
 */
const MARKERS = /^(?:(?:[-*+•]|\d+[.)])\s+|>\s*(?=\S))*(?:\[[ xX]\]\s+)?/;
export function linesOf(text: string): Line[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((raw, at) => {
    const t = raw.trim();
    if (!t) return { at, kind: "blank", text: "" };
    if (t.startsWith("#")) return { at, kind: "heading", text: t };
    return { at, kind: "rule", text: t.replace(MARKERS, "").trim() };
  });
}

/** The rules' lines only, in file order. */
export const rulesOf = (text: string) => linesOf(text).filter((l) => l.kind === "rule" && l.text);

/**
 * A line as compared (Fable, topic 2): lower case, whitespace collapsed, straight quotes, one trailing ".", "!" or ";"
 * dropped. Two lines the same after this say the same thing.
 */
export function normal(line: string): string {
  return line.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().replace(/[.!;]$/, "").trim();
}

/** A line's key: its normalised text, digested (a rule's `made.key`). */
export const keyOf = (line: string) => createHash("sha256").update(normal(line)).digest("hex").slice(0, 16);

/** The examples' numbers (§2, Examples; example 5 dropped: Fable, topic 0; example 2 from stage 3.5). */
export type ExampleN = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** The examples' words, as offered (Fable, topic 4). */
export const EXAMPLE_TEXT: Record<ExampleN, string> = {
  1: "Let me know when anything needs my input.",
  2: "Tell me when the last running <Project> thread finishes.",
  3: "Tell me when anything fails: tests, a build, or a thread that stops with an error.",
  4: "Tell me if a computer goes offline while threads are running on it.",
  6: "Every weekday at 8, have a briefing ready of what happened overnight.",
  7: "Between 11 at night and 7 in the morning, keep everything for the morning.",
  8: "When I'm in a meeting, don't call; send a notification I can answer.",
  9: "When I'm driving, send nothing I'd have to read. Call me if an agent is waiting on an answer; keep the rest for my next call.",
  10: "At weekends, only tell me about failures and questions.",
  11: "If I haven't answered a question in 15 minutes, call me.",
  12: "Call me, even at night, if a thread I follow fails.",
};

/** Where each example is offered (Add a rule's sections) and how its row reads. */
export const EXAMPLE_SECTION: Record<ExampleN, "tell" | "hold" | "call"> = { 1: "tell", 2: "tell", 3: "tell", 4: "tell", 6: "tell", 7: "hold", 8: "hold", 9: "hold", 10: "hold", 11: "call", 12: "call" };

/**
 * The examples this build offers, in Add a rule's order: each one whose mechanism is built (Fable, topic 4). Example 2
 * goes second, with the account's busiest project in its words, when it has one (Fable, topic 4: `exampleText`).
 */
export const OFFERED: ExampleN[] = [1, 3, 4, 6, 7, 8, 9, 10, 11, 12];

/** Example 2's words with a project's spoken name ("Tell me when the last running driver thread finishes."). */
export const exampleText = (n: ExampleN, project?: string) => (n === 2 ? EXAMPLE_TEXT[2].replace("<Project>", project ?? "") : EXAMPLE_TEXT[n]);

/**
 * An example's numbers as written: a briefing's time, a night's hours ("23:00", "07:00"), escalation's minutes; example
 * 2's project (`scope`). Stage 3.5, a line in your own words read into the same mechanism (reader.ts `Checked`): its
 * scope (example 1, 3, 12 and 13: any thread, the ones you follow, or a project), what of "needs my input" it runs
 * (`needs`: the question as a fact only, "none"; that and the judged half, "also"; the judged half only, "only"; an
 * example 1 row without it is "also"), a judged clause of your own on a reply (`judge`), the reminder it says (`say`),
 * whether a call rings through the night line (`night`), whether the car line calls a question (`calls`), a briefing's
 * days (`days`, 0 Sunday to 6).
 */
export type Params = {
  time?: string; from?: string; to?: string; minutes?: number;
  scope?: Scope; needs?: "none" | "also" | "only"; judge?: string; say?: string; night?: boolean; calls?: boolean; days?: number[];
};
export type Example = { n: ExampleN; params: Params };

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

/** A recurring line's time (example 6): a bare 7 to 11 is the morning, 12 noon, 1 to 6 the afternoon. */
function daily(h: Heard): string {
  const hour = h.half !== null ? h.hour : h.hour === 12 ? 12 : h.hour >= 7 ? h.hour : h.hour + 12;
  return hm(hour, h.minute);
}

/** A night's start (example 7): a bare 6 to 11 is the evening, 12 midnight, 1 to 5 the small hours. */
const nightFrom = (h: Heard) => hm(h.half !== null ? h.hour : h.hour === 12 ? 0 : h.hour >= 6 ? h.hour + 12 : h.hour, h.minute);
/** A night's end: a bare hour is the morning, 12 noon. */
const nightTo = (h: Heard) => hm(h.half !== null ? h.hour : h.hour % 12 === 0 ? 12 : h.hour, h.minute);

/**
 * Which example a line is (Fable, topic 2): its normalised text the same as an example's, or three of them with their
 * numbers changed, read in code (zone.ts): example 6's time, example 7's two times (which must differ), example 11's
 * minutes (5 to 120), said as a length and nothing else (the seventh reviews of 3.5: "in 15 minutes on quoth, call me"
 * rang for every question with no Allow). Anything that can't be read isn't an example. Null for a line in the user's
 * own words.
 */
export function exampleOf(line: string, projects: Project[] = []): Example | null {
  const s = normal(line);
  // Example 2 with any project the account has, by its name as said (Fable, topic 2).
  const last = /^tell me when the last running (.+) thread finishes$/.exec(s);
  if (last) {
    const name = last[1].trim();
    const ps = projects.filter((p) => p.said.toLowerCase() === name || p.names.includes(name));
    return ps.length === 1 ? { n: 2, params: { scope: { project: ps[0] } } } : null;
  }
  for (const n of OFFERED) if (n !== 6 && n !== 7 && n !== 11 && s === normal(EXAMPLE_TEXT[n])) return { n, params: {} };
  const every = /^every weekday at (.+), have a briefing ready of what happened overnight$/.exec(s);
  if (every) {
    const h = parseClock(every[1]);
    return h && !h.tomorrow ? { n: 6, params: { time: daily(h) } } : null;
  }
  const night = /^between (.+) and (.+), keep everything for the morning$/.exec(s);
  if (night) {
    const a = parseClock(night[1]);
    const b = parseClock(night[2]);
    if (!a || !b || a.tomorrow || b.tomorrow) return null;
    const from = nightFrom(a);
    const to = nightTo(b);
    return from !== to ? { n: 7, params: { from, to } } : null;
  }
  const late = /^if i haven't answered a question in (.+), call me$/.exec(s);
  if (late) {
    const ms = /\bminutes?\b|\bhours?\b|\bhour\b/.test(late[1]) ? parseLength(late[1], true) : null;
    const minutes = ms === null ? NaN : ms / 60_000;
    return Number.isInteger(minutes) && minutes >= 5 && minutes <= 120 ? { n: 11, params: { minutes } } : null;
  }
  return null;
}

/**
 * A line's rule in table `rules` (every example but 6, whose rule is a repeating time's, rules.ts `EveryRule`):
 * `made.said` is the line as written (its why), `made.key` its normalised text's digest. `items`: for examples 1, 3 and
 * 12, each thread from when the rule first saw it (as Away's are), so nothing from before it was added is news.
 * Older code reads table `rules` only for following's, a repeating time's and Away's rows, and leaves these alone.
 */
export type LineRule = {
  v: 1;
  id: string;
  made: { by: "user"; via: "file"; at: number; said: string; key: string };
  /**
   * The mechanism: an example's number (but 6, a repeating time's), or 13 for a line's replies (stage 3.5: a line in
   * your own words, "tell me when any quoth thread replies"; no example has it).
   */
  example: Exclude<ExampleN, 6> | 13;
  params: Params;
  ring: boolean;
  /** Stage 3.5: a line in your own words, read by the reader (its reading is `sentenceOf` its `Checked`, kv `rules_read`). */
  read?: true;
  /**
   * `earlier` (stage 3.5): the line was reworded in your own words, and this, its earlier wording, runs until the new
   * one is put in use (Use these rules), by the new line's key. `idle` (example 2): whether a thread in its project was
   * running or waiting at the last look, and since when none has been. `runsFrom` (example 1's judged half, a clause of
   * your own): from when it looks at turns' ends, so a turn that ended before (a 3.4 line) is never judged.
   */
  state: { status: "watching"; items: Record<string, Joined>; n: number; joining?: true; earlier?: string; idle?: { busy: boolean; since?: number }; runsFrom?: number };
};

export const LINE_PREFIX = "R-line-";

export function lineRule(id: string, said: string, ex: Example, at: number): LineRule {
  return {
    v: 1, id, made: { by: "user", via: "file", at, said, key: keyOf(said) }, example: ex.n as LineRule["example"], params: { ...ex.params },
    ring: ex.n === 9 || ex.n === 11 || ex.n === 12, state: { status: "watching", items: {}, n: 0, joining: true },
  };
}

const DAY_SETS = { weekdays: [1, 2, 3, 4, 5], every_day: [0, 1, 2, 3, 4, 5, 6], weekends: [0, 6] } as const;

/**
 * A line in your own words, read (reader.ts `Checked`), as the mechanism it runs on: an example's (with its scope and
 * the rest in `params`), or 13, a line's replies. Example 6's (a briefing) is a repeating time's, `everyOf`. Null for
 * none (a briefing).
 */
export function readRule(id: string, said: string, r: Checked, at: number): LineRule | null {
  const scope = r.scope;
  const base = (example: LineRule["example"], params: Params, ring = false): LineRule => ({
    v: 1, id, made: { by: "user", via: "file", at, said, key: keyOf(said) }, example, params, ring, read: true, state: { status: "watching", items: {}, n: 0, joining: true },
  });
  const say = r.say ? { say: r.say } : {};
  switch (r.on) {
    case "asks": return base(1, { scope, needs: "none", ...say }, r.does === "call");
    case "needs_input": return base(1, { scope, needs: "also", ...say });
    case "needs_you": return base(1, { scope, needs: "only", ...say });
    case "failed": return r.does === "call" ? base(12, { scope, night: !!r.night }, true) : base(3, { scope, ...say });
    case "replied": return base(13, { scope, ...(r.judge ? { judge: r.judge } : {}), ...say });
    case "offline": return base(4, {});
    case "idle": return base(2, { scope, ...say });
    case "night": return base(7, { from: r.from, to: r.to });
    case "weekend": return base(10, {});
    case "focus": return base(8, {});
    case "car": return base(9, { calls: r.does === "call" }, r.does === "call");
    case "unanswered": return base(11, { minutes: r.minutes }, true);
    case "briefing": return null;
  }
}

/** A read briefing's repeating time (example 6's mechanism): its days and time. */
export const everyOf = (r: Checked) => ({ days: [...DAY_SETS[r.days ?? "weekdays"]], time: r.at ?? "08:00" });

export function validLine(x: unknown): x is LineRule {
  const r = x as LineRule | null;
  return !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && r.id.startsWith(LINE_PREFIX) && r.made?.via === "file" && typeof r.made.said === "string"
    && typeof r.made.key === "string" && Number.isFinite(r.made.at) && [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13].includes(r.example) && !!r.params && typeof r.params === "object"
    && r.state?.status === "watching" && !!r.state.items && typeof r.state.items === "object" && Number.isFinite(r.state.n);
}

// --- what each line says (Fable, topics 1, 5 and 7: exact words, built here) ---

const DAYS_ALL = "Saturday and Sunday";

/** What a line's row says under it, before its detail (Fable, topic 1). */
export type Status = "Tells you" | "Holds back" | "Can call you" | "Not read yet" | "Not in use yet" | "Needs one step" | "Needs Call me back" | "Needs an answer" | "Needs your OK to call" | "Can't call you" | "Can't do yet" | "Paused" | `Same as line ${number}`;

/**
 * How I read your rules' sections (Fable, topics 7 and 11): in use (`tells`, `holds`, `calls`); stage 3.5's read but not
 * in use yet (`pending`), needing an answer (`ask`), a call in your own words in use quietly until you allow it
 * (`allow`), can't be done yet (`cant`), paused by the level (`paused`); not read (`unread`); said already (`same`).
 */
export type Section = "tells" | "holds" | "calls" | "unread" | "same" | "pending" | "ask" | "allow" | "cant" | "paused";

/**
 * What the brain knows that changes a line's reading: Call me back, the level's call-backs, the zone, the Focus filter;
 * `judged` (stage 3.5): the level has lines judged by AI and this brain can check them (true), the level hasn't (false),
 * or this brain has nothing to check with (null: a demo world, a test), when nothing is said of them.
 */
export type Context = { canRing: boolean; perDay: number | null; named: boolean; zone: string | null; focusEver: boolean; judged?: boolean | null };

/** Each example's fixed reading (Fable, topic 5), its times shown on a 24-hour clock. */
export function readingOf(ex: Example): string {
  const p = ex.params;
  switch (ex.n) {
    case 1: return "A notification, at once, when an agent on any thread asks you a question or waits for your OK.";
    case 2: return sentenceOf({ does: "tell", on: "idle", scope: p.scope ?? { any: true } });
    case 3: return "A notification, at once, when a thread's run ends with an error, or ends with its tests or build failing, on any thread. Not when you stop it yourself.";
    case 4: return "A notification when a computer goes offline while a thread is running on it, usually within 20 minutes, and a quiet one when it's back. Any thread, not only the ones you follow.";
    case 6: return `On weekdays at ${p.time ?? "08:00"}, your phone's time: a notification that your briefing is ready, with what happened since the last one. Nothing on a morning when nothing happened. Tap it to hear the briefing.`;
    case 7: return `From ${p.from ?? "23:00"} to ${p.to ?? "07:00"}, your phone's time: no calls, and notifications arrive with no sound and the screen dark. At ${p.to ?? "07:00"}, one notification with a sound if anything is still unheard. Holds everything: threads you follow, Away, and calls you asked for unless you said call me anyway.`;
    case 8: return "While a Focus that has 10 & 2's filter is on: no calls. What would have called comes as a notification you can answer. I can't see your calendar.";
    case 9: return "For 30 minutes after a 10 & 2 call through CarPlay: a question calls you, and everything else is kept and told first in your next call. Otherwise I can't tell you're in the car.";
    case 10: return "On Saturday and Sunday, your phone's time: only questions, failures and a computer offline notify you. Replies wait for your next call, and no briefing is sent. Calls you asked for still call, except the later call for a question you haven't answered.";
    case 11: return `A call ${p.minutes ?? 15} minutes after a question's notification, if you haven't answered or opened it. Not while a hold-back rule or Quiet for a while is on.`;
    case 12: return NIGHT_CALL;
  }
}

/**
 * Example 12's reading, and a call read as "even at night" (reader.ts): it rings through the night line only, never a
 * Focus or Quiet for a while (Fable, topic 8; the reviews of 3.4: "your hold-back rules" said more than it does).
 */
export const NIGHT_CALL = "A call, at once, when a thread you follow fails, at night too. It rings through your night rule, not through a Focus or Quiet for a while.";
export const NO_CALL_ME_BACK = "Call me back is off in Settings → Calls, so this sends a notification instead of calling.";
export const NO_CALL_ME_BACK_CAR = "Call me back is off in Settings → Calls, so questions are kept for your next call too.";
/** The Focus filter's one step, with its switch (Fable, the reviews of 3.4: as the iPhone's sheet says it). */
export const ONE_STEP = "One step first: in iPhone Settings → Focus, choose a Focus, tap Add Filter, choose 10 & 2 and turn on Tell my rules.";
export const NO_ZONE_YET = "Open 10 & 2 on your phone once so it knows your time zone.";
export const NOT_READ = "10 & 2 can follow the examples for now. This line is kept, and does nothing yet.";
/** Stage 3.5, with a reader: a line it couldn't read yet (failed, timed out, or past today's reads). */
export const NOT_READ_YET = "Not read yet. It's kept, and does nothing until it's read.";
/** A line read but not in use yet (Fable, topic 11): it runs once you say Use these rules. */
export const NOT_IN_USE = "Not in use yet. It runs once you tap Use these rules.";
/** A reworded line's earlier wording, still running until the new one is in use (Fable, topic 11). */
export const EARLIER = "Earlier wording, still in use";
/** What a judged line did in the last day (Fable, topic 12): "Last day: 50 checked, 9 told, 12 told unchecked." */
export const checksLine = (c: { checked: number; told: number; unchecked: number }) =>
  `Last day: ${c.checked} checked, ${c.told} told${c.unchecked ? `, ${c.unchecked} told unchecked` : ""}.`;
export { JUDGED_TAIL };
export const sameAs = (n: number) => `Says the same as line ${n}, so it makes no rule of its own.`;

const CALLS = new Set<ExampleN>([9, 11, 12]);
const TIMED = new Set<ExampleN>([6, 7, 10]);

/** An example's reading with the tails that are true now (Fable, topic 5), and its row's status. */
export function readingNow(ex: Example, c: Context): { reading: string; status: Status } {
  const tails: string[] = [];
  // Example 1's judged half (stage 3.5; Fable, topic 5): said where the level has it, and where it hasn't.
  if (ex.n === 1 && c.judged === true) tails.push(INPUT_JUDGED);
  if (ex.n === 1 && c.judged === false) tails.push(INPUT_NOT_CAUGHT);
  let status: Status = EXAMPLE_SECTION[ex.n] === "tell" ? "Tells you" : EXAMPLE_SECTION[ex.n] === "hold" ? "Holds back" : "Can call you";
  if (CALLS.has(ex.n)) {
    if (!c.canRing) {
      tails.push(ex.n === 9 ? NO_CALL_ME_BACK_CAR : NO_CALL_ME_BACK);
      status = "Needs Call me back";
    } else if (c.perDay !== null) tails.push(c.named ? "On Commute this uses your one call-back a day." : "This uses your one call-back a day.");
  }
  if (ex.n === 8 && !c.focusEver) {
    tails.push(ONE_STEP);
    status = "Needs one step";
  }
  if (TIMED.has(ex.n) && !c.zone) {
    tails.push(NO_ZONE_YET);
    status = "Not in use yet";
  }
  return { reading: [readingOf(ex), ...tails].join(" "), status };
}

/**
 * A line in your own words as read (stage 3.5): its reading with the tails true now (as an example's), its row's status
 * and its section. A wholly judged line on a level without judged lines is paused (Fable, topic 12); "needs my input"
 * there keeps its fact half, and says so.
 */
export function readNow(r: Checked, c: Context): { reading: string; status: Status; section: Section } {
  const judged = judgedOf(r);
  if (judged === "only" && c.judged === false) return { reading: PAUSED, status: "Paused", section: "paused" };
  let reading = sentenceOf(r);
  if (judged === "also" && c.judged === false) reading = reading.replace(INPUT_JUDGED, INPUT_NOT_CAUGHT);
  const tails: string[] = [];
  const section: Section = r.does === "call" ? "calls" : r.does === "hold" ? "holds" : "tells";
  let status: Status = section === "calls" ? "Can call you" : section === "holds" ? "Holds back" : "Tells you";
  if (r.does === "call") {
    if (!c.canRing) {
      tails.push(r.on === "car" ? NO_CALL_ME_BACK_CAR : NO_CALL_ME_BACK);
      status = "Needs Call me back";
    } else if (c.perDay !== null) tails.push(c.named ? "On Commute this uses your one call-back a day." : "This uses your one call-back a day.");
  }
  if (r.on === "focus" && !c.focusEver) {
    tails.push(ONE_STEP);
    status = "Needs one step";
  }
  if ((r.on === "briefing" || r.on === "night" || r.on === "weekend") && !c.zone) {
    tails.push(NO_ZONE_YET);
    status = "Not in use yet";
  }
  return { reading: [reading, ...tails].join(" "), status, section };
}

/** A timed hold-back's detail on its row (Fable, topic 1): "23:00 to 07:00", "Saturday and Sunday". */
export function holdDetail(ex: Example): string | null {
  if (ex.n === 7) return `${ex.params.from} to ${ex.params.to}`;
  if (ex.n === 10) return DAYS_ALL;
  return null;
}

/** "3 in the last day" (Fable, topic 1): none for 0, or a rule under a day old (null). */
export const countDetail = (n: number | null) => (n ? `${n} in the last day` : null);

/**
 * One line as Settings → Notifications and How I read show it: a heading, or a rule with its number (`n`, rules only),
 * which example it is, its row's status and detail, its reading and section, and its count for the last day (null under
 * a day old: "Last day" is left out).
 */
export type LineView = {
  at: number;
  kind: "rule" | "heading";
  text: string;
  n?: number;
  example?: ExampleN;
  status?: Status;
  detail?: string;
  reading?: string;
  section?: Section;
  /** Example 9: listed again under Can call you (Fable, topic 5). */
  also?: "calls";
  lastDay?: number | null;
  /** Stage 3.5: a line read in your own words. */
  read?: true;
  /** Needs an answer: its question and choices (Fable, topic 11), the choice taken back by `POST /api/rules/answer`. */
  question?: string;
  choices?: string[];
  /** A judged line's checks in the last day (Fable, topic 12). */
  checks?: { checked: number; told: number; unchecked: number };
  /** A reworded line's earlier wording, still in use until this one is (Fable, topic 11): its words and reading. */
  earlier?: { text: string; reading: string; section: Section };
  /**
   * A call in your own words in use quietly until you allow it: the question Allow answers, the reading's digest that
   * `POST /api/rules/allow` sends back, and whether it says the night (Only by day then too). `allowed`, once you have:
   * whether through the night.
   */
  allow?: { ask: string; reading: string; night: boolean };
  allowed?: { night: boolean };
};

/**
 * Whether `text` may be saved (Fable, topic 1): at most 30 rules of at most 200 characters each. The words said to the
 * phone, which checks the same before it sends.
 */
export function fileProblem(text: string): string | null {
  const rules = rulesOf(text);
  if (rules.length > RULES_MAX) return `Your rules are full at ${RULES_MAX}. Remove one to add another.`;
  if (rules.some((r) => [...r.text].length > LINE_MAX)) return `Keep each rule under ${LINE_MAX} characters.`;
  return null;
}

/**
 * "Your rule: <the line as written>" (Fable, topic 16), the why of a line's notification, clipped at a word to 60
 * characters in all with no ellipsis of its own ("Your rule: Between 11 at night and 7 in the morning, keep", Fable's
 * topic 9): iOS adds its own where it cuts the banner. With thread names hidden (`names` false), "Your rule." alone: a
 * line may name a project (the final reviews of 3.5).
 */
export function ruleWhy(said: string, names = true): string {
  if (!names) return "Your rule.";
  const why = `Your rule: ${said}`;
  const chars = [...why];
  if (chars.length <= 60) return why;
  const head = chars.slice(0, 60).join("");
  return head.replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "") || head;
}

// --- holding back (Fable, topics 8 to 10, 15 and 19) ---

/** Quiet for a while (the account's: kv `quiet`) and the Focus filter's report (kv `focus`), kept apart. */
export const QUIET_KEY = "quiet";
export const FOCUS_KEY = "focus";
/** Quiet for a while lasts at most 12 hours; a Focus's report ends by itself after 12 (the spike's safety end). */
export const QUIET_MAX_MS = 12 * 3600_000;
export const FOCUS_MAX_MS = 12 * 3600_000;
/** "Driving" is a 10 & 2 call or hold through CarPlay in the last 30 minutes (§2; example 9). */
export const CAR_MS = 30 * 60_000;
/** A hold-back's end is told for this long after it (an object asleep through it, a restart), then not at all. */
export const HOLD_END_MS = 12 * 3600_000;
/** A repeating time's rule made from example 6 (rules.ts `EveryRule`). */
export const EVERY_PREFIX = "R-every-";

/** What holds back now, the first that applies (`by`), and the weekend line apart: a filter on what, not how. */
export type Hold = { by: "quiet" | "focus" | "car" | "night" | null; quiet: { at: number; until: number } | null; night: LineRule | null; weekend: LineRule | null };

/** A hold-back stretch that ended: its once-only key, its start and end, and its notification's title and why. */
export type HeldStretch = { key: string; from: number; end: number; title: string; why: string };

const minutesOf = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * The night line's stretch `now` is inside (example 7), on the phone's clock of the moment: it may wrap midnight, and
 * its ends are read with zone.ts's clock changes. Null outside it.
 */
export function nightAt(p: Params, zone: string, now: number): { from: number; end: number } | null {
  if (!p.from || !p.to) return null;
  const c = clockOf(now, zone);
  const m = c.hour * 60 + c.minute;
  const f = minutesOf(p.from);
  const t = minutesOf(p.to);
  if (!(f < t ? m >= f && m < t : m >= f || m < t)) return null;
  const end = instantOf(f < t || m < t ? c.date : nextDate(c.date), p.to, zone);
  const from = instantOf(f < t || m >= f ? c.date : prevDate(c.date), p.from, zone);
  return { from, end };
}

/**
 * The night your night lines hold `now` in, each line's stretch running on into any that starts by its end (23:00 to
 * 07:00 and 06:00 to 09:00 hold until 09:00: the reviews of 3.4, a file may have two). Null outside every one.
 */
export function nightOf(ps: Params[], zone: string, now: number): { from: number; end: number } | null {
  const inside = ps.flatMap((p) => nightAt(p, zone, now) ?? []);
  if (!inside.length) return null;
  let end = Math.max(...inside.map((n) => n.end));
  for (let i = 0; i < ps.length; i++) {
    const more = Math.max(end, ...ps.flatMap((p) => nightAt(p, zone, end)?.end ?? []));
    if (more === end) break;
    end = more;
  }
  return { from: Math.min(...inside.map((n) => n.from)), end };
}

/** Whether night lines hold every minute from 23:00 to 07:00, example 7's hours (by day only's night: the ninth reviews). */
export function nightCovers(ps: Params[]): boolean {
  const inside = (p: Params, m: number) => {
    const f = minutesOf(p.from!);
    const t = minutesOf(p.to!);
    return f < t ? m >= f && m < t : m >= f || m < t;
  };
  for (let m = 23 * 60; m < 31 * 60; m++) if (!ps.some((p) => !!p.from && !!p.to && inside(p, m % 1440))) return false;
  return true;
}

/** The next time the night line begins after `now`, on the phone's clock. */
export function nightNext(p: Params, zone: string, now: number): number | null {
  if (!p.from) return null;
  const today = clockOf(now, zone).date;
  for (const date of [today, nextDate(today)]) {
    const at = instantOf(date, p.from, zone);
    if (at > now) return at;
  }
  return null;
}

/** Saturday 00:00 to Monday 00:00 on the phone's clock (example 10). */
export const weekendAt = (zone: string, now: number) => {
  const d = weekdayOf(clockOf(now, zone).date);
  return d === 0 || d === 6;
};

// --- Quiet for a while by voice (Fable, topic 10; fixed lines, unmeasured) ---

export const QUIET_ENDED = "Quiet ended.";
export const NOT_QUIET = "It wasn't quiet.";
const SILENT = "I won't call, and notifications will be silent.";
/** "Quiet until 3 in the afternoon. I won't call, and notifications will be silent." */
export const quietUntil = (time: string) => `Quiet until ${time}. ${SILENT}`;
/** Asked for longer than 12 hours. */
export const quietCapped = (time: string) => `Quiet lasts up to 12 hours, so until ${time}. ${SILENT}`;
/**
 * A call-back that would ring is being watched: one, or several; with Notifications off, what it's about waits for your
 * next call (the final reviews of 3.4: no promise of a notification that can't come).
 */
export const quietCalls = (n: number, notifies = true) =>
  !notifies ? (n === 1 ? " Until then, the call you asked for will wait for your next call." : n > 1 ? " Until then, the calls you asked for will wait for your next call." : "")
  : n === 1 ? " The call you asked for will be a notification until then." : n > 1 ? " The calls you asked for will be notifications until then." : "";
