// A watch as the iPhone shows it (docs/launch/engine.md §2, §11 stage 5; Fable's decisions for stage 5, topics 1 to 7,
// binding for words): the card in Call mode and on the hold, the sheet that changes it (one, from the card, Watching and
// a thread's page), and what's said once one is set by hand or by Siri. Every sentence the user reads about a watch is
// built here and sent as a string, so the phone never composes one and Android can show the same later.
//
// Users read "call", "Call me back", "a notification"; never "ring", "rule", "draft" or "arm". Nothing here is said by
// the voice model: in a call the card rides on today's readbacks (watch-lines.ts, levels.ts), word for word.

import type { WorkItem } from "./adapter.ts";
import type { LevelName } from "./levels.ts";
import { possessive } from "./receipts.ts";
import { START_GRACE_MS } from "./rules.ts";
import { ago } from "./util.ts";

/** What a watch waits for, as the sheet offers it for one thread; a time made by voice is its own (`deadline`, `check`). */
export type When = "replies" | "tests" | "fails" | "trouble";
export const WHENS: readonly When[] = ["replies", "tests", "fails", "trouble"];

/** What was asked: a call, or a notification. */
export type Then = "call" | "notify";

/**
 * What it will really do over its whole watch, as things are now: call; on Commute, a call for whichever of two comes
 * first (`either`); a notification as asked (`notify`), or in a call's place (`used`: today's call-back on Commute is
 * used; `held`: held back by a night rule, Quiet or a Focus; `off`: Call me back is off); or keep its news for the
 * next call (`kept`: neither can reach the phone).
 */
export type How = "call" | "either" | "notify" | "used" | "held" | "off" | "kept";

/** A time as the card shows it: a clock on the phone's ("21:40", "03:00 tomorrow"), or with no zone a length from now. */
export type Shown = { clock: string } | { length: string };

/** A watch as the card reads it. `threads`: the names as the app shows them. `cut`: the level cut the length asked for. */
export type Spec = {
  threads: string[];
  all: boolean;
  when: When | "deadline" | "check";
  /** A deadline's or check-in's time. */
  at?: Shown;
  /** A not-before still ahead, as shown ("19:00"). */
  notBefore: string | null;
  then: Then;
  how: How;
  /** Why a call is held back now when `how` is "held" ("Quiet until 19:40", "your rules hold calls until 07:00"). */
  held?: string;
  until: Shown;
  cut?: { level: LevelName; named: boolean };
};

export type Line = { label: string; value: string };
export type Card = { title: string; lines: Line[] };

/** Names as Watching shows them: "API", "API and Docs", "API, Docs and Schema"; four or more by count. */
function named(threads: string[], or = false): string {
  const j = or ? "or" : "and";
  if (threads.length === 1) return threads[0];
  if (threads.length === 2) return `${threads[0]} ${j} ${threads[1]}`;
  if (threads.length === 3) return `${threads[0]}, ${threads[1]} ${j} ${threads[2]}`;
  return or ? `one of ${threads.length} threads` : `${threads.length} threads`;
}

/** "18:00" for a clock, "in 2 hours" for a length. */
const at = (s: Shown) => ("clock" in s ? s.clock : `in ${s.length}`);

/**
 * The card's title (Fable, topic 2): Watching's sentence for the same watch, in the imperative and without its ", from
 * 19:00" tail (that's in When): what was asked. "Call me when API's tests pass", "Tell me only if API fails".
 */
export function titleOf(s: Spec): string {
  const verb = s.then === "call" ? "Call me" : "Tell me";
  const n = s.threads.length;
  if (s.when === "deadline") {
    const cond = n === 1 ? `${s.threads[0]} isn't done` : n === 2 ? `${named(s.threads)} aren't both done` : `${named(s.threads)} aren't all done`;
    return s.at && "clock" in s.at ? `${verb} at ${s.at.clock} if ${cond}` : `${verb} if ${cond} in time`;
  }
  if (s.when === "check") return s.at && "clock" in s.at ? `${verb} at ${s.at.clock} about ${named(s.threads)}` : `${verb} about ${named(s.threads)}`;
  if (s.when === "tests") return `${verb} when ${possessive(s.threads[0])} tests pass`;
  if (s.when === "fails" || s.when === "trouble") return `${verb} only if ${named(s.threads, true)} ${s.when === "fails" ? "fails" : "fails or asks"}`;
  if (s.all && n > 1) return `${verb} when ${n === 2 ? `${named(s.threads)} are both done` : n === 3 ? `${named(s.threads)} are all done` : `all ${n} threads are done`}`;
  return `${verb} when ${named(s.threads)} ${n === 1 ? "replies" : "reply"}`;
}

/** The card's When (Fable, topic 2): the thread is "it", several are "they" or "one". */
export function whenOf(s: Spec, withNotBefore = true): string {
  const one = s.threads.length === 1;
  const it = one ? "it" : "one";
  const base = s.when === "deadline" ? `${s.at ? at(s.at) : "in time"}, if ${one ? "it isn't done" : "they aren't all done"} · sooner if ${it} fails or asks`
    : s.when === "check" ? (s.at ? at(s.at) : "")
    : s.when === "tests" ? "its tests pass, or it stops first"
    : s.when === "fails" ? `${it} fails or is stopped`
    : s.when === "trouble" ? `${it} fails, is stopped or asks you something`
    : s.all && !one ? "they're all done, or sooner if one fails or asks"
    : `${it} replies or asks you something`;
  return withNotBefore && s.notBefore ? `${base} · not before ${s.notBefore}` : base;
}

/** How, only when it won't simply be what Then says (Fable, topic 2). */
export function howOf(s: Spec): string | null {
  if (s.how === "kept") return "kept for your next call; Notifications are off";
  if (s.then === "notify") return null;
  if (s.how === "either") return "a call for whichever comes first";
  if (s.how === "used") return "a notification; today's call-back is used";
  if (s.how === "held") return s.held ? `a notification; ${s.held}` : "a notification";
  if (s.how === "off") return "a notification; Call me back is off";
  return null;
}

/** Until: the clock as Watching shows it, or "for 4 hours" with no zone; the level's cut said only when it cut. */
export function untilOf(s: Spec): string {
  const shown = "clock" in s.until ? s.until.clock : `for ${s.until.length}`;
  if (!s.cut) return shown;
  return `${shown}, ${s.cut.named ? `the longest on ${s.cut.level}` : "the longest I can watch"}`;
}

/** The card: a title and at most four lines, When, Then, How (only when it differs) and Until. */
export function cardOf(s: Spec): Card {
  const how = howOf(s);
  return {
    title: titleOf(s),
    lines: [
      { label: "When", value: whenOf(s) },
      { label: "Then", value: s.then === "call" ? "call me" : "send a notification" },
      ...(how ? [{ label: "How", value: how }] : []),
      { label: "Until", value: untilOf(s) },
    ],
  };
}

// --- the sheet (Fable, topic 3) ---

/** One of a row's choices; `at`, for Until, when it ends (ms), so the phone keeps a not-before before it. */
export type Choice = { id: string; label: string; at?: number };

/**
 * The sheet, as the brain fills it: each row's choices with the current one (`value`), a row that can't be changed
 * (`fixed`) and why (`footer`). `blocked`: neither a call nor a notification reaches this phone, so nothing can be set.
 * `notBefore`: the not-before set (ms) and how it's shown, or none ("Any time"); the phone offers Later's own times.
 */
export type Form = {
  title: string;
  when: { value: string; choices: Choice[]; fixed?: true };
  notBefore: { value: number | null; label: string };
  then: { value: Then; choices: Choice[]; fixed?: true; footer?: string };
  until: { value: string; choices: Choice[]; footer: string; fixed?: true };
  blocked?: string;
};

/** The sheet's lines (Fable, topic 3), each built here; a refusal shows under its rows, and the sheet stays. */
export const SHEET = {
  /** Nothing can reach the phone: Call me back and Notifications are both off. */
  blocked: "Turn on Call me back or Notifications first.",
  /**
   * Nothing can reach the phone though Call me back is on: today's call-back on Commute is used and Notifications are off,
   * so only Notifications would help (the third review of stage 5).
   */
  usedNotesOff: "Today's call-back is used. Turn on Notifications first.",
  off: "Call me back is off. Turn it on in Settings → Calls to be called.",
  /**
   * Notifications are off and a call can be made: Then is a call, and a notification asked for is refused, since it would
   * reach nothing (the second review of stage 5). "Sent one instead": a notification, not the call under it (the third).
   */
  notesOff: "Notifications are off. Turn them on in Settings → Notifications to be sent one instead.",
  /** A thread already watched for a notification, with Notifications off and a call possible: what to do (the third). */
  watchedNotesOff: "It's watched for a notification, but Notifications are off. Turn them on in Settings → Notifications, or change it to a call.",
  used: "Today's call-back is used. It's back at midnight.",
  anyTime: "Any time",
  /** A watch gone meanwhile (Stop, or over): as Watching's Stop says it. */
  gone: "That isn't being watched any more.",
  /** What a watch on several threads, or a time made by voice, waits for: its row is fixed, so only an older phone asks. */
  fixed: "That can't be changed here.",
  noZone: "Your phone hasn't sent its time zone yet. Try again in a moment.",
  past: "Pick a time that's still ahead.",
  late: "Pick a time before it stops watching.",
  /**
   * A watch over already but held for its not-before (its thread replied before that time): what it waits for and how
   * long have done their part, so only those two can change (the Skeptic's finding on stage 5).
   */
  over: "It already has news for you, so only Not before and Then can change.",
} as const;

/** The card's OK in a call, refused (Fable, topic 4): the card moved on, the call ended, or it waited too long. */
export const CARD = {
  gone: "That's no longer waiting, so nothing was set.",
  ended: "That call has ended, so nothing was set.",
  expired: "That waited too long, so nothing was set. Ask again.",
} as const;

const WHEN_LABEL: Record<When, string> = { replies: "It replies or asks", tests: "Its tests pass", fails: "It fails", trouble: "It fails or asks" };
const THEN_CHOICES: Choice[] = [{ id: "call", label: "Call me" }, { id: "notify", label: "Send a notification" }];

/** Whole hours, as the sheet says them: "1 hour", "4 hours". */
const hours = (h: number) => `${h} ${h === 1 ? "hour" : "hours"}`;
/** Until's lengths, from now, up to the level's longest. */
export const LENGTHS_H = [1, 2, 4, 12];

/** Until's footer: "Road Trip watches for up to 4 hours." to an account on that plan, else "Up to 4 hours." */
export const untilFooter = (level: LevelName, levelHours: number, isNamed: boolean) => (isNamed ? `${level} watches for up to ${hours(levelHours)}.` : `Up to ${hours(levelHours)}.`);

export type FormInput = {
  /** The thread's name, or "3 threads". */
  title: string;
  spec: Spec;
  /** What can reach the phone for a watch set now. */
  can: Reach;
  /** The not-before set, if still ahead (ms). */
  notBeforeAt: number | null;
  /** When it stops watching now (ms); a deadline's or a check-in's time (`fixed`), which the sheet can't move. */
  until: number;
  fixed?: boolean;
  /** Over already, held for its not-before: When and Until are fixed (`SHEET.over`). */
  over?: boolean;
  now: number;
  /** "18:40" from an instant on the phone's clock; null with no zone. */
  clock: (at: number) => string | null;
  level: LevelName;
  levelHours: number;
  named: boolean;
  /** Notifications on: without them, a call is all that can be asked for. */
  notifies: boolean;
  /** Call me back on (a phone can be rung): with `can` "kept", today's call-back is used, so the line names Notifications. */
  rings: boolean;
};

/** What can reach the phone for a watch set now: a call, a notification in a call's place, or neither. */
export type Reach = "call" | "used" | "off" | "kept";

/**
 * Until's choices: lengths from now up to the level's longest, each with its clock ("21:40 · 4 hours"); first, when
 * it's none of them, when it stops as it is (`keep`). A time made by voice keeps its own, and only that.
 */
function untilChoices(i: FormInput): { value: string; choices: Choice[] } {
  const keep = { id: "keep", label: i.clock(i.until) ?? "As it is", at: i.until };
  if (i.fixed || i.over) return { value: "keep", choices: [keep] };
  const lengths = LENGTHS_H.filter((h) => h < i.levelHours).concat(i.levelHours);
  const choices = lengths.map((h) => {
    const end = i.now + h * 3600_000;
    const clock = i.clock(end);
    return { id: String(h * 3600_000), label: clock ? `${clock} · ${hours(h)}` : hours(h), at: end };
  });
  // A minute either way is the same choice: the sheet's clocks are to the minute.
  const same = choices.find((c) => Math.abs(c.at - i.until) < 60_000);
  return same ? { value: same.id, choices } : { value: "keep", choices: [keep, ...choices] };
}

/** The sheet for `i.spec` (Fable, topic 3). */
export function formOf(i: FormInput): Form {
  const s = i.spec;
  const one = s.threads.length === 1;
  const time = s.when === "deadline" || s.when === "check";
  // Several threads, or a time made by voice: When shows what it is and can't be changed.
  const fixedWhen = time ? `${s.at && "clock" in s.at ? `At ${s.at.clock}` : s.at ? `In ${s.at.length}` : "In time"}${s.when === "deadline" ? `, if ${one ? "it isn't done" : "they aren't all done"}` : ""}` : cap(whenOf({ ...s, notBefore: null }));
  const when = !one || time || i.over
    ? { value: s.when, choices: [{ id: s.when, label: fixedWhen }], fixed: true as const }
    : { value: s.when, choices: WHENS.map((w) => ({ id: w, label: WHEN_LABEL[w] })) };
  // A call that can't be is a fixed notification. With Notifications off (the second review of stage 5), "Send a
  // notification" is offered only to a watch that already asks for one, so it can be made a call; never as a new choice
  // that would reach nothing.
  const then = i.can === "off" || i.can === "used"
    ? { value: "notify" as const, choices: THEN_CHOICES.slice(1), fixed: true as const, footer: i.can === "off" ? SHEET.off : SHEET.used }
    : !i.notifies && s.then === "call"
    ? { value: "call" as const, choices: THEN_CHOICES.slice(0, 1), fixed: true as const, footer: SHEET.notesOff }
    : { value: s.then, choices: THEN_CHOICES, ...(i.notifies ? {} : { footer: SHEET.notesOff }) };
  const until = untilChoices(i);
  return {
    title: i.title,
    when,
    notBefore: { value: i.notBeforeAt, label: i.notBeforeAt !== null ? (i.clock(i.notBeforeAt) ?? SHEET.anyTime) : SHEET.anyTime },
    then,
    until: { ...until, footer: i.over ? SHEET.over : untilFooter(i.level, i.levelHours, i.named), ...(i.fixed || i.over ? { fixed: true as const } : {}) },
    ...(i.can === "kept" ? { blocked: keptLine(i.rings, false, i.named) } : {}),
  };
}

/**
 * Why nothing can be set when nothing can reach the phone (`Reach` "kept"), naming only a switch that's off (the third
 * review of stage 5): Call me back or Notifications; with Call me back on (`rings`), today's call-back is used, so
 * Notifications. `siri`: as Siri says it. Commute's day names the level only to an account on its plan.
 */
export function keptLine(rings: boolean, siri: boolean, isNamed: boolean): string {
  if (!rings) return siri ? SIRI_NEITHER : SHEET.blocked;
  return siri ? `You've had today's call-back${isNamed ? " on Commute" : ""}. Turn on Notifications in 10 & 2 first.` : SHEET.usedNotesOff;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --- what's said once a watch is set by hand or by Siri (Fable, topics 6 and 7) ---

/** "when API replies", "when API's tests pass", "only if API fails", "only if API fails or asks". */
function clause(handle: string, when: When): string {
  if (when === "tests") return `when ${possessive(handle)} tests pass`;
  if (when === "fails") return `only if ${handle} fails`;
  if (when === "trouble") return `only if ${handle} fails or asks`;
  return `when ${handle} replies`;
}

/**
 * The toast on a thread's page once it's set (Fable, topic 6): "I'll call when API replies.", "I'll send a notification
 * only if API fails.", a not-before as Watching shows it (", from 19:00").
 */
export function setLine(handle: string, when: When, how: How, notBefore: string | null, notifies = true): string {
  const verb = how === "call" || how === "either" ? "I'll call" : "I'll send a notification";
  // On Commute with more watches than calls left, only the first to have news calls (the third review of stage 5): the
  // line says what the other gets, as the call's readback does (levels.ts `commuteReadback`).
  const either = how === "either" ? `, unless another watch calls first; then ${notifies ? "I'll send a notification" : "it waits for your next call"}` : "";
  return `${verb} ${clause(handle, when)}${notBefore ? `, from ${notBefore}` : ""}${either}.`;
}

/**
 * What Siri says once it's set (Fable, topic 7), each one line: what will happen, so nothing is made quieter without
 * being said. Commute's day used names the level only to an account on its plan.
 */
export function siriLine(handle: string, how: How, isNamed: boolean, notifies = true, held?: string): string {
  if (how === "used") return `You've had today's call-back${isNamed ? " on Commute" : ""}. I'll send a notification when ${handle} replies.`;
  if (how === "held" && held) return `${held}. I'll send a notification when ${handle} replies.`;
  if (how === "off") return `Call me back is off, so I'll send a notification when ${handle} replies.`;
  return setLine(handle, "replies", how, null, notifies);
}

/** Siri, when neither a call nor a notification can reach the phone and Call me back is off: nothing is set. */
export const SIRI_NEITHER = "Turn on Call me back in 10 & 2 first.";
/** Siri, when a call can be made but what's watched asks for a notification, and Notifications are off. */
export const SIRI_NOTES_OFF = "Turn on Notifications in 10 & 2 first.";


/**
 * When the run going now started, if the work system says: the user's last message, when it's after the last finished
 * run. Null when it can't be known (a run the agent started itself, or a system that doesn't say).
 */
export function runStart(item: Pick<WorkItem, "wroteAt" | "lastRunAt">): number | null {
  const wrote = Date.parse(item.wroteAt ?? "");
  if (!Number.isFinite(wrote)) return null;
  const ran = Date.parse(item.lastRunAt ?? "");
  return Number.isFinite(ran) && ran >= wrote ? null : wrote;
}

/**
 * Whether a thread can be watched by hand now (`spike/arm-without-call`'s `armable`; Fable, topic 6), and from when: it's
 * working, or waiting for its subagents, or the user wrote to it in the last few minutes (a run that may not show yet).
 * Otherwise why not, in a line for the sheet or Siri.
 */
export function armable(s: { item: WorkItem; handle: string; connected: boolean; patient: boolean }, now: number): { since: number } | { refused: string } {
  const { item } = s;
  if (!s.connected) return { refused: `${item.machine ?? "Your computer"} isn't connected, so I can't tell how ${s.handle} is doing.` };
  if (item.pendingQuestion) return { refused: `${s.handle} is already asking you something.` };
  if (item.status === "running" || s.patient) return { since: now };
  const wrote = runStart(item);
  if (wrote !== null && now - wrote < START_GRACE_MS) return { since: wrote };
  const ran = item.lastRunAt ? Date.parse(item.lastRunAt) : NaN;
  if (Number.isFinite(ran)) return { refused: `${s.handle} already replied, ${ago(ran, now)}.` };
  return { refused: `${s.handle} isn't working on anything, so there's nothing to wait for.` };
}
