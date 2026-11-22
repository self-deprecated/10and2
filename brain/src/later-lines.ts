// What sends and starts set up for later say (docs/launch/engine.md §5, §11 stage 4b; Fable's decisions 4-0 to 4-G,
// binding for words): each line built here and said or shown word for word, never the model's own, in the style of
// watch-lines.ts. Spoken times are zone.ts `spokenClock`'s ("3 tomorrow morning"), shown ones `shownClock`'s ("03:00
// tomorrow"). The user's words are in straight double quotes when said, curly on screen. A computer is named only when the
// account has more than one (`computers`); with one it's "your computer". Thread names leave notifications only when
// Privacy hides them (`names`); Watching, the card, the Timeline and a call always name the thread.
import type { Fact } from "./later.ts";
import type { LaunchProfile } from "./adapter.ts";
import { CATEGORY, ruleCollapse, type Note, type ReachOut } from "./reach.ts";
import { possessive } from "./receipts.ts";
import { NOTHING_SET_UP, type LevelName } from "./levels.ts";
import { clockOf, nextDate, prevDate, shownClock, spokenClock, spokenDay, spokenLength } from "./zone.ts";

/** Cut at a word to `max` characters, with "…". */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  const chars = [...one];
  if (chars.length <= max) return one;
  const head = chars.slice(0, max - 1).join("");
  const word = head.replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "");
  return `${word || head}…`;
}

/** At most `n` words, with "…" when there were more (the waiting one named in a refusal: Fable's 4-C). */
export function fewWords(text: string, n = 5): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length <= n ? words.join(" ").replace(/[.!?]+$/, "") : `${words.slice(0, n).join(" ").replace(/[,;:.!?]+$/, "")}…`;
}

/** Threads as named: "API", "API and Docs", "API, Docs and Schema"; four or more, null (said by count). */
export function threadsNamed(threads: string[]): string | null {
  if (threads.length === 1) return threads[0];
  if (threads.length === 2) return `${threads[0]} and ${threads[1]}`;
  if (threads.length === 3) return `${threads[0]}, ${threads[1]} and ${threads[2]}`;
  return null;
}

/** A computer as a line names it: its name with more than one, else "your computer" ("Your computer" to start one). */
export const computerOf = (machine: string, computers: number, start = false) => (computers > 1 ? machine : start ? "Your computer" : "your computer");

/** What a start may do, as its readback says it (Fable's 4-B: the access is always said, it's what the yes agrees to). */
const ACCESS_SAID: Record<LaunchProfile["runtimeMode"], string> = {
  "full-access": "with full access", "auto": "in auto mode", "auto-accept-edits": "accepting edits", "approval-required": "asking first",
};
/** The same, as the card and Watching show it: "full access". */
export const ACCESS_SHOWN: Record<LaunchProfile["runtimeMode"], string> = {
  "full-access": "full access", "auto": "auto mode", "auto-accept-edits": "accepting edits", "approval-required": "asking first",
};
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * A new thread's access as Drafts shows it beside its prompt ("Full access"), so a start missed at its time, opened
 * there from Start now, is never started without its access shown (Fable's 4-G; the review of stage 4).
 */
export const accessLine = (mode: LaunchProfile["runtimeMode"]) => upper(ACCESS_SHOWN[mode]);

// --- the readback and the card (4-A, 4-B) ---

/**
 * A send's readback (4-A): `Schedule "carry on" to API for 3 tomorrow morning?`. `to`: the target as today's readback
 * names it, or the threads ("API, Docs and Schema", "the 4 threads"). The day and the half of the day are always in
 * `when`, and it always waits for a yes, so a guessed half needs no question of its own.
 */
export const sendReadback = (words: string, to: string, when: string) => `Schedule "${words}" to ${to} for ${when}?`;

/**
 * A start's (4-B): `Schedule a new thread in driver on Quartz, with full access, for 2 tomorrow afternoon: "Update the
 * dependencies"?`, with the model chosen for it as a start now says it (", using Claude Opus 5.5", with its provider
 * where one is said; thread-model.md).
 */
export const startReadback = (project: string, computer: string | null, mode: LaunchProfile["runtimeMode"], when: string, prompt: string, model: string | null = null) =>
  `Schedule a new thread in ${project}${computer ? ` on ${computer}` : ""}, ${ACCESS_SAID[mode]}${model ? `, using ${model}` : ""}, for ${when}: "${prompt}"?`;

/** At Face ID every time, after the readback (4-A, 2a's tap line with its verb for this case). */
export const TAP_SCHEDULE = "Tap Schedule on your phone to go ahead.";
/**
 * The same in the car (stage 4's review, Fable): untapped, nothing is kept to approve later (2b's "Approve to schedule"
 * isn't built), so a driver hears that the call ending first sets nothing up.
 */
export const TAP_SCHEDULE_CAR = `${TAP_SCHEDULE} If the call ends first, nothing is set up.`;

// --- asked about by voice: what's waiting (4-D's spoken lines) and Stop (4-E) ---

/**
 * One send, start or chain still to go, as the voice names it: its words (a start's prompt), the threads it still goes to
 * (a send's), a start's project, its time and the phone's zone, a chain's thread it waits for (4-J's `after`, whose time
 * isn't said), a computer offline that doesn't have it yet (as named: "Quartz", or "your computer"), and else what its
 * computer said when it didn't take it (`notTaken`'s sentence). `late`: its time has passed and it hasn't gone, so it goes
 * as Watching's second line says: the end of its window as said ("5 this morning"), its computer as named, and that
 * computer when it's offline (`back`). `tail`: a chain's, when its step on now is its last.
 */
export type LaterSaid = {
  words: string; threads: string[]; project?: string; at: number; zone: string; after?: string; offline?: string; notTaken?: string;
  late?: { until: string; computer: string; back: string | null }; tail?: Tail;
};

/** The threads a send goes to, said: "API", "API, Docs and Schema", four or more "the 4 threads" (4-A's readback). */
const toSaid = (threads: string[]) => threadsNamed(threads) ?? `the ${threads.length} threads`;

/**
 * Asked "what are you watching for me?" (Fable's 4-D), one sentence each: `I'll send "carry on" to API at 3 tomorrow
 * morning.` / `I'll start a thread in driver at 2 tomorrow afternoon.`, adding, only when true, ` Quartz is offline, so
 * it gets it when it's back.`, or that its computer didn't take it, as after the yes (4-A: `notTaken`). The words as
 * the list says them (at most 12). A chain (4-J) as its readback leads: `When Schema finishes, I'll send API "rebase and
 * run the tests".` (a start: `When Schema finishes, I'll start a thread in driver.`), its last step with its tail as the
 * readback says it (`tailSaid`: `…, and call you when API replies.`; Fable's nit on pass B1's review). Past its time and
 * not gone (`late`, Fable's ruling on the review of 4-E), as Watching's second line says it: `I'll send "carry on" to API
 * as soon as it's free, until 5 this morning.` (several, "as soon as they're free"), `I'll start a thread in driver as
 * soon as Quartz can, until 4 this afternoon.`, its computer offline `… when Quartz is back, until 5 this morning.`
 */
export function laterSentence(o: LaterSaid, now: number): string {
  const what = o.project !== undefined ? `I'll start a thread in ${o.project}` : `I'll send "${fewWords(o.words, 12)}" to ${toSaid(o.threads)}`;
  const late = o.late;
  const when = !late ? `at ${spokenClock(o.at, o.zone, now)}`
    : late.back ? `when ${late.back} is back, until ${late.until}`
    : o.project !== undefined ? `as soon as ${late.computer} can, until ${late.until}`
    : `as soon as ${o.threads.length === 1 ? "it's" : "they're"} free, until ${late.until}`;
  const tail = o.tail ? `, ${tailSaid(o.tail, o.project !== undefined ? "the new thread" : toSaid(o.threads))}` : "";
  const main = o.after !== undefined
    ? o.project !== undefined ? `When ${o.after} finishes, I'll start a thread in ${o.project}${tail}.` : `When ${o.after} finishes, I'll send ${toSaid(o.threads)} "${fewWords(o.words, 12)}"${tail}.`
    : `${what} ${when}.`;
  return o.offline && !late ? `${main} ${upper(o.offline)} is offline, so it gets it when it's back.` : o.notTaken ? `${main} ${o.notTaken}` : main;
}

/** Asked to stop one, or what's set up for later, with none waiting (4-E). */
export const NOTHING_WAITING = "Nothing is waiting to be sent.";
/** Its computer answered that it won't be sent (4-E): "Nothing will be sent to API." */
export const nothingSentTo = (threads: string[]) => `Nothing will be sent to ${toSaid(threads)}.`;
/** Stopped, and its computer answered (4-E): a send's, "Stopped. Nothing will be sent to API." */
export const stoppedSend = (threads: string[]) => `Stopped. ${nothingSentTo(threads)}`;
/** A start's. */
export const STOPPED_START = "Stopped. Nothing will be started.";
/** Stopped with its computer offline (4-E): "Stopped. Quartz won't send it." (one computer: "Your computer…"). */
export const stoppedWont = (computer: string) => `Stopped. ${upper(computer)} won't send it.`;
/** A start's (Fable's nit on the fifth review of 4-E): "Stopped. Quartz won't start it." */
export const stoppedWontStart = (computer: string) => `Stopped. ${upper(computer)} won't start it.`;
/**
 * Stopped past its time while the computer that holds it is offline: it may have gone first (the skeptic's review of
 * stage 4, Watching's `stoppedMaybeSent`, said): never "won't send it", which could be untrue.
 */
export const stoppedMaybeSaid = (computer: string) => `${stoppedMaybeSent(computer)}.`;
/** No answer from its computer within 5 s (4-E). */
export const STOPPING_NOW = "Stopping it now.";
/**
 * A stop that named nothing stopped the only one waiting (4-E's "or only one exists", kept only there by the rule on
 * the seventh review of 4-E): 4-E's lines with where it goes, so each names what was stopped: `Stopped. Quartz won't
 * send it to API.`, `Stopped, but your computer may have sent it to API already. You'll hear if it did.`, `Stopping
 * API's now.` (Fable's form for the rest of a send, `stoppingRest`).
 */
export const stoppedWontTo = (computer: string, threads: string[]) => `Stopped. ${upper(computer)} won't send it to ${toSaid(threads)}.`;
export const stoppedMaybeTo = (computer: string, threads: string[]) => `Stopped, but ${computer} may have sent it to ${toSaid(threads)} already. You'll hear if it did.`;
export const stoppingTo = (threads: string[]) => `Stopping ${possessive(toSaid(threads))} now.`;
/** It went before the stop (4-E): `Too late: it went to API at 3 this morning.` (a start: `Too late: it started at 2 this afternoon.`). */
export const tooLateSaid = (start: boolean, threads: string[], when: string) => (start ? `Too late: it started at ${when}.` : `Too late: it went to ${toSaid(threads)} at ${when}.`);
/**
 * A send to several threads that went to some before the stop, which stopped the rest (Fable's ruling on the review of
 * 4-E): `Too late for API: it went at 3 this morning.`, then what became of the rest ("Nothing will be sent to Docs.").
 */
export const tooLateFor = (threads: string[], when: string) => `Too late for ${toSaid(threads)}: it went at ${when}.`;
/**
 * The rest of a send to several threads that went to some first, as a stop says it after `tooLateFor` (Fable's nit on
 * the second review of 4-E: "it" would read as the thread it already went to, so the rest is named): no answer yet,
 * `Stopping Docs' now.` (four or more, `Stopping the other 4 now.`: Fable's nit on the third review); offline past its
 * time, `Stopped for Docs, but your computer may have sent it already. You'll hear if it did.`; offline before it,
 * `Stopped for Docs. Prism won't send it.`
 */
export const stoppingRest = (threads: string[]) => (threads.length > 3 ? `Stopping the other ${threads.length} now.` : `Stopping ${possessive(toSaid(threads))} now.`);
export const stoppedRestMaybe = (threads: string[], computer: string) => `Stopped for ${toSaid(threads)}, but ${computer} may have sent it already. You'll hear if it did.`;
export const stoppedRestWont = (threads: string[], computer: string) => `Stopped for ${toSaid(threads)}. ${upper(computer)} won't send it.`;
/**
 * Stopped, and another send still waits for a thread it went to (Fable's ruling on the second review of 4-E: "Nothing
 * will be sent to API" would be untrue then): `Stopped the one at 4. 3 more are waiting for API.` (one left: `Stopped
 * the one at 4. One more is waiting for API.`; a chain's, "the one when Schema finishes"). `what`: "the one at 4", the
 * time as `whichTimes` says it beside the ones left; after a too-late part, the rest by name, "for Docs" (Fable's nit on
 * the third review: "the one at 3" right after "it went at 3" reads as the one that went).
 */
export const stoppedOneOf = (what: string, more: number, threads: string[]) => `Stopped ${what}. ${moreWaiting(more, threads)}`;
/**
 * How many more still wait for those threads, said after a stop its computer hasn't confirmed ("Stopped. Quartz won't
 * send it. One more is waiting for Docs."; Fable's ruling on the ninth review of 4-E).
 */
export const moreWaiting = (more: number, threads: string[]) => `${more === 1 ? "One more is" : `${more} more are`} waiting for ${toSaid(threads)}.`;
/** `stoppedOneOf`'s "for Docs": the rest of a send that went to some first, by name. */
export const forRest = (threads: string[]) => `for ${toSaid(threads)}`;
/**
 * A send whose window is over while the computer holding it is offline (Fable's should on the third review of 4-E, the
 * words for 4-G's missed alarm): it never goes now, so the list says it hasn't, never "I'll send…": `Quartz hasn't come
 * back, so "carry on" hasn't gone to API.` (one computer: `Your computer hasn't come back, …`).
 */
export const notBack = (computer: string, words: string, threads: string[]) =>
  `${upper(computer)} hasn't come back, so "${fewWords(words, 12)}" hasn't gone to ${toSaid(threads)}.`;
/** A start's (Fable's should on the fourth review of 4-E): `Quartz hasn't come back, so your thread in driver hasn't started.` */
export const notStarted = (computer: string, project: string) => `${upper(computer)} hasn't come back, so your thread in ${project} hasn't started.`;
/**
 * A stop at a readback's no that named one in words it can't read (Fable's should on the fifth review of 4-E): nothing
 * is stopped, and what's still waiting is said with it, so it never sounds like a yes to the one named. One: `Nothing's
 * set up. "aaa" to API at 6 is still waiting.` (a start: `Nothing's set up. The new thread in driver at 2 tomorrow is
 * still waiting.`), named as `whichOne` names it, its bare hour with its day when that isn't today; two or more:
 * `Nothing's set up. 2 are still waiting.`; none: `Nothing's set up.`.
 */
export function notSetUpWaiting(open: LaterSaid[], now: number): string {
  if (!open.length) return NOTHING_SET_UP;
  if (open.length > 1) return `${NOTHING_SET_UP} ${open.length} are still waiting.`;
  return `${NOTHING_SET_UP} ${stillWaiting(open[0], now)}`;
}

/**
 * `notSetUpWaiting`'s tail: `"aaa" to API at 6 is still waiting.`; also said last after "stop watching everything", which
 * stops only call-backs, with one still waiting (Fable's ruling on pass B1's review; engine.ts `stopWatching`).
 */
export function stillWaiting(o: LaterSaid, now: number): string {
  const what = o.project !== undefined ? `the new thread in ${o.project}` : `"${fewWords(o.words)}" to ${toSaid(o.threads)}`;
  const c = clockOf(o.at, o.zone);
  const today = clockOf(now, o.zone).date;
  const day = c.date === today ? "" : c.date === nextDate(today) ? " tomorrow" : ` on ${c.weekday}`;
  const when = o.after !== undefined ? `when ${o.after} finishes` : `at ${bareHour(o.at, o.zone)}${day}`;
  return `${upper(what)} ${when} is still waiting.`;
}

/** After "stop watching everything" with two or more still waiting (Fable's ruling on pass B1's review). */
export const stillWaitingCount = (n: number) => `${n} are still waiting to be sent.`;

/**
 * A stop naming a thread or a time that fits nothing waiting, with one waiting (Fable's ruling on the seventh review of
 * 4-E): `That one isn't waiting. "zzz" to Docs at 4 tomorrow is still waiting.` (a start: `That one isn't waiting. The
 * new thread in driver at 2 tomorrow is still waiting.`). It's about that one, so "stop that" after it stops it.
 */
export const notWaiting = (o: LaterSaid, now: number) => `That one isn't waiting. ${stillWaiting(o, now)}`;
/**
 * A stop that could mean one gone offline while sending and the one still waiting (Fable's ruling on the eighth review
 * of 4-E): both, `Too late: it went to API at 3 this morning. "zzz" to Docs at 5 is still waiting.` (`late`, its
 * `tooLateSaid`). It's about the one waiting, so "stop that" after it stops it.
 */
export const tooLateWaiting = (late: string, o: LaterSaid, now: number) => `${late} ${stillWaiting(o, now)}`;

/** More than three could be meant (4-E). */
export const manyWaiting = (n: number) => `You have ${n} waiting. Which thread's?`;
/** More than three for the one thread named (Fable's ruling on the review of 4-E): `You have 4 waiting for API. Which time?` */
export const manyFor = (n: number, thread: string) => `You have ${n} waiting for ${thread}. Which time?`;

/**
 * Times as a stop's question names them, together (4-E, and Fable's rulings on its review): each its bare hour ("3",
 * "3:30", "noon"); "tomorrow" or its weekday only when they aren't all on one day, and never today ("2 tomorrow", "8 on
 * Saturday"); and the half of the day when another on that day has the same bare hour in the other half, as `spokenClock`
 * says it ("3 in the morning", "3 in the afternoon", "3 tomorrow morning"), so no two read the same.
 */
export function whichTimes(ats: number[], zone: string, now: number): string[] {
  const cs = ats.map((at) => clockOf(at, zone));
  const today = clockOf(now, zone).date;
  const oneDay = new Set(cs.map((c) => c.date)).size === 1;
  const bare = ats.map((at) => bareHour(at, zone));
  return ats.map((_, i) => {
    const c = cs[i];
    const day = oneDay || c.date === today ? "" : c.date === nextDate(today) ? "tomorrow" : `on ${c.weekday}`;
    // The half only when one on that day reads the same in the other half (Fable's nit on the second review of 4-E).
    const twin = bare.some((b, j) => j !== i && b === bare[i] && cs[j].date === c.date && cs[j].hour !== c.hour);
    if (!twin || bare[i] === "noon" || bare[i] === "midnight") return day ? `${bare[i]} ${day}` : bare[i];
    const part = c.hour < 12 ? "morning" : c.hour < 18 ? "afternoon" : "evening";
    return day ? `${bare[i]} ${day} ${part}` : `${bare[i]} in the ${part}`;
  });
}

/**
 * Two or three could be meant (4-E): `Which one: "carry on" to API at 3, or the new thread in driver at 2 tomorrow?`,
 * each by its words clipped to 5 words, where it goes and its time as `whichTimes` says them together (a chain's: "when
 * Schema finishes"). All one send's words to the same threads (Fable's ruling on the review of 4-E), said once: `Which
 * one, "run the whole test suite…" to API: at 3, at 4, or at 5?`
 */
export function whichOne(open: LaterSaid[], now: number): string {
  const timed = open.filter((o) => o.after === undefined);
  const times = new Map(whichTimes(timed.map((o) => o.at), open[0].zone, now).map((t, i) => [timed[i], t]));
  const what = (o: LaterSaid) => (o.project !== undefined ? `the new thread in ${o.project}` : `"${fewWords(o.words)}" to ${toSaid(o.threads)}`);
  const or = (said: string[]) => `${said.slice(0, -1).join(", ")}, or ${said.at(-1)}`;
  if (open.every((o) => o.after === undefined && o.project === undefined && what(o) === what(open[0]))) {
    return `Which one, ${what(open[0])}: ${or(open.map((o) => `at ${times.get(o)}`))}?`;
  }
  return `Which one: ${or(open.map((o) => (o.after !== undefined ? `${what(o)} when ${o.after} finishes` : `${what(o)} at ${times.get(o)}`)))}?`;
}

/** One row of the pending card (4-A): its label and what it says. */
export type CardRow = { label: string; text: string };
/**
 * The pending card for a schedule (Call mode; 4-A, 4-B): its title, rows and the button that agrees (never "Send"), and
 * what Face ID's sheet says for it at Face ID every time (`reason`).
 */
export type LaterCard = { title: string; rows: CardRow[]; button: "Schedule"; reason: string };

/**
 * The card: "Schedule for 03:00 tomorrow" (a start: "Start a thread at 14:00 tomorrow"), with "(21:00 on Quartz)" after the
 * time only when that computer's zone differs; To, Say, On (only with more than one computer) and what happens if it's
 * asleep, until the end of its window.
 */
export function laterCard(o: {
  start: boolean; to: string; words: string; machine: string; computers: number; at: number; until: number; zone: string; now: number;
  machineZone: string | null; mode?: LaunchProfile["runtimeMode"]; project?: string; threads?: string;
}): LaterCard {
  // One computer is "your computer" (4-0 (4)), here too.
  const there = o.machineZone && o.machineZone !== o.zone ? ` (${shownClock(o.at, o.machineZone, o.now)} on ${computerOf(o.machine, o.computers)})` : "";
  const when = `${shownClock(o.at, o.zone, o.now)}${there}`;
  const who = computerOf(o.machine, o.computers, true);
  const asleep = { label: `If ${o.computers > 1 ? o.machine : "your computer"} is asleep`, text: `It ${o.start ? "starts" : "goes"} when it wakes, until ${shownClock(o.until, o.zone, o.at)}. After that I'll ask you.` };
  if (o.start) {
    // With one computer the row is only the access, so it's labelled so (Fable's nit on stage 4).
    const on = o.computers > 1 ? { label: "On", text: `${o.machine} · ${ACCESS_SHOWN[o.mode!]}` } : { label: "Access", text: upper(ACCESS_SHOWN[o.mode!]) };
    return { title: `Start a thread at ${when}`, rows: [{ label: "In", text: o.project! }, on, { label: "Say", text: `“${o.words}”` }, asleep], button: "Schedule", reason: `Schedule a new thread in ${o.project}` };
  }
  return {
    title: `Schedule for ${when}`,
    rows: [{ label: "To", text: o.to }, { label: "Say", text: `“${o.words}”` }, ...(o.computers > 1 ? [{ label: "On", text: who }] : []), asleep],
    button: "Schedule",
    reason: `Schedule “${clip(o.words, 60)}” for ${o.threads ?? o.to}`,
  };
}

// --- after the yes (4-A) ---

/**
 * How each computer took the handover at the yes: it answered holding it (`held`), it's offline, it didn't answer within
 * 3 s (`quiet`), its clock is off (`clock`, by `minutes`), or it didn't take it (`refused`).
 */
export type Handed = { machine: string; state: "held" | "offline" | "quiet" | "clock" | "refused"; minutes?: number };

const minutesOff = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * A computer that didn't take its set, as its own sentence (4-A's, after the yes with several computers): "Quartz's clock
 * is 7 minutes off, so it won't send anything until that's fixed." (its clock, by `minutes`), else "Quartz didn't take
 * it. Watching says why."
 */
export const notTaken = (computer: string, minutes?: number) => minutes !== undefined
  ? `${upper(possessive(computer))} clock is ${minutesOff(minutes)} off, so it won't send anything until that's fixed.`
  : `${upper(computer)} didn't take it. Watching says why.`;

/**
 * What's said after the yes, word for word (4-A): "Scheduled. Quartz has it.", "Scheduled. Quartz is offline, so it
 * gets it when it's back.", "Scheduled." (no answer in 3 s, or one computer online), "Scheduled, but Quartz's clock is 7
 * minutes off, so it won't send anything until that's fixed.", "Scheduled, but Quartz didn't take it. Watching says
 * why." Several computers: "Scheduled." and one sentence for each computer offline or that didn't take it. Never "Sent",
 * "Done" or "Queued".
 */
export function scheduledLine(handed: Handed[], computers: number): string {
  const machines = [...new Map(handed.map((h) => [h.machine, h])).values()];
  if (machines.length === 1) {
    const h = machines[0];
    const c = computerOf(h.machine, computers);
    if (h.state === "held") return computers > 1 ? `Scheduled. ${h.machine} has it.` : "Scheduled.";
    if (h.state === "offline") return `Scheduled. ${upper(c)} is offline, so it gets it when it's back.`;
    if (h.state === "clock") return `Scheduled, but ${possessive(c)} clock is ${minutesOff(h.minutes ?? 0)} off, so it won't send anything until that's fixed.`;
    if (h.state === "refused") return `Scheduled, but ${c} didn't take it. Watching says why.`;
    return "Scheduled.";
  }
  const more = machines.flatMap((h) =>
    h.state === "offline" ? [`${h.machine} is offline, so it gets it when it's back.`]
      : h.state === "clock" ? [notTaken(h.machine, h.minutes ?? 0)]
      : h.state === "refused" ? [notTaken(h.machine)] : []);
  return ["Scheduled.", ...more].join(" ");
}

// --- refusals when it's set up (4-C): said instead of the readback, and nothing is set up ---

/** None on the level (Commute's): names levels to everyone, since it says what would change it. */
export const LATER_NONE = "Sending later comes with Road Trip and Long Haul.";
/** Only if asked what would change Road Trip's one. */
export const LATER_LONGER = "Long Haul holds 20.";
/** Long Haul's 20 are all waiting. */
export const LATER_MOST = "You have 20 waiting, which is the most. Stop one in Watching first.";
/** More than three days ahead. */
export const TOO_FAR = "I can schedule up to 3 days ahead.";
/** A send's thread not in the list at the yes (gone, or the list unreadable): nothing is set up. */
export const notFound = (thread: string) => `I can't find ${thread} right now, so nothing's set up.`;
/** A time that can't be read (Fable's review of stage 4): asked again in fixed words, never the model's own. */
export const WHEN_AGAIN = "When? Say a time, like at 3 or in 2 hours.";
/**
 * One with a day or a date heard that can't be placed ("next Friday at 8", "on the 22nd at 3", "in a couple of days"):
 * which day, and what works (Fable's nit on stage 4's fix4: "When?" alone has them say the same words again). Each line
 * here is asked by why it wasn't read (zone.ts `whyUnread`).
 */
export const DAY_AGAIN = "Which day? Say it like tomorrow at 8 or Friday at 8.";
/** A day it can place, with no time read ("tomorrow morning", "Friday", "Saturday at 8 30"): what time (Fable's should on fix4). */
export const TIME_AGAIN = "What time? Say it like tomorrow at 8 or Friday at half past 8.";
/**
 * Midnight with a day ("Friday at midnight", "tomorrow at 12 am"): the start of that day or its end can't be told, so
 * a time that can (Fable's should on fix4: asking which day had them say it again, and again).
 */
export const MIDNIGHT_AGAIN = "Midnight is between two days. Say it like Friday night at 11:59.";

/** A time as a refusal or a stop names it: its bare hour ("3", "3:30", "noon", "midnight"). */
export function bareHour(at: number, zone: string): string {
  const c = clockOf(at, zone);
  if (c.hour === 0 && c.minute === 0) return "midnight";
  if (c.hour === 12 && c.minute === 0) return "noon";
  return c.minute ? `${c.hour % 12 || 12}:${String(c.minute).padStart(2, "0")}` : `${c.hour % 12 || 12}`;
}

/**
 * Road Trip's one is waiting (4-C): `Road Trip holds one for later, and "carry on" to API at 3 is waiting. Stop that…`;
 * a chain's, by what it waits for: `… "rebase and run the tests" to API when Schema finishes is waiting. …` (4-J).
 */
export const laterFull = (named: boolean, waiting: { words: string; to: string; hour: string; after?: string }) =>
  `${named ? "Road Trip holds" : "I can hold"} one for later, and "${fewWords(waiting.words)}" to ${waiting.to} ${waiting.after !== undefined ? `when ${waiting.after} finishes` : `at ${waiting.hour}`} is waiting. ${STOP_FIRST}`;
const STOP_FIRST = "Stop that in Watching first, then ask again.";

/**
 * A refusal said in place of a readback that is about the sends already waiting (Road Trip's one, `laterFull`; Long
 * Haul's 20, `LATER_MOST`; more threads than room is left for, `roomLeft`), so "stop that" after it is about them; any
 * other refusal set nothing up and names nothing waiting (the skeptic's should on the second review of 4-E).
 */
export const namesWaiting = (line: string) => line.endsWith(STOP_FIRST) || line === LATER_MOST || ROOM_LEFT.test(line);

/** Long Haul's room, nearly used ("tell all three" with 18 of 20 waiting): `You have 18 waiting, and 20 is the most. Which 2 threads?` */
export const roomLeft = (waiting: number, room: number) =>
  `You have ${waiting} waiting, and ${room} is the most. Which ${room - waiting === 1 ? "thread" : `${room - waiting} threads`}?`;
const ROOM_LEFT = /^You have \d+ waiting, and \d+ is the most\. Which /;

/** More threads than the level has room for ("tell all three" on Road Trip). */
export const whichThread = (named: boolean) => `${named ? "Road Trip holds" : "I can hold"} one for later, so which thread?`;

/**
 * No computer that could hold it: a world with none (demo mode, its own made-up threads) or none known here. Fable's
 * review of stage 4: never "too old", which asks a demo user to update something they don't have.
 */
export const LATER_NO_COMPUTER = "Sending later needs your own computer connected.";
/** Its 10and2 lists no `set_schedules` (spoken: "Ten and Two", no command names). */
export const tooOld = (machine: string, computers: number) => `Ten and Two on ${computerOf(machine, computers)} is too old to send later. Update it there.`;
/** The same, shown. */
export const tooOldShown = (machine: string, computers: number) => {
  const c = computerOf(machine, computers);
  return `${upper(possessive(c))} 10and2 is too old to send later. Update 10and2 on ${c}.`;
};
/** Its policy's `rules` is off. */
export const rulesOff = (machine: string, computers: number) => `${upper(computerOf(machine, computers))} isn't set to send messages for later. Turn it on at ${computerOf(machine, computers)}.`;
/** A start where its policy's `rules` is send only. */
export const startsOff = (machine: string, computers: number) => `${upper(computerOf(machine, computers))} isn't set to start threads for later. Turn it on at ${computerOf(machine, computers)}.`;
/** The same two, shown: with `10and2 agents` in code style. */
export const shownWithAgents = (line: string) => `${line.replace(/\.$/, "")} with \`10and2 agents\`.`;
/** A start's access above that computer's ceiling: never lowered by offer (the user asks again with the access they want). */
export const tooMuchAccess = (machine: string, computers: number) => `${upper(computerOf(machine, computers))} doesn't allow that much access for a thread started later.`;

// --- chains (4-J): "when Schema's done, tell API to rebase, and call me when that's done" ---

/**
 * "And call me when that's done", the chain's tail: how the last step's reply will truly reach them over the watch, as
 * watch-lines' verbs say it: a call while Call me back rings, else a notification, else kept for the next call.
 */
export type Tail = "call" | "notify" | "kept";

/** One step as the readback says it: when which thread finishes, a send to a thread, or a new thread (only ever the last). */
export type ChainStep = { after: string } & ({ to: string; words: string } | { start: { project: string; computer: string | null; mode: LaunchProfile["runtimeMode"]; prompt: string; model?: string | null } });

/** The tail as the readback's last clause says it: "and call you when API replies"; after a start, "the new thread". */
export const tailSaid = (tail: Tail, thread: string) =>
  tail === "call" ? `and call you when ${thread} replies` : tail === "notify" ? `and send a notification when ${thread} replies` : "and tell you in your next call";

/**
 * A chain's readback (4-J), built here and waiting for a yes, one sentence per step: `When Schema finishes, I'll send API
 * "rebase and run the tests", and call you when API replies. I'll watch Schema for up to 4 hours. OK?`; a start, `When
 * Schema finishes, I'll start a thread in driver on Quartz, with full access: "Review the schema change". …`; a time it
 * mustn't go before, after the first step's words (`, but not before 6 in the evening`); several steps, `… I'll watch
 * for up to 12 hours. OK?`. The level's name (" on Road Trip") only to an account on its plan, as watch-lines' `on()`.
 * A start's model as `startReadback` says it (", using Claude Opus 5.5"; thread-model.md).
 */
export function chainReadback(steps: ChainStep[], o: { tail: Tail | null; notBefore: string | null; watchMs: number; level: LevelName; named: boolean }): string {
  const said = steps.map((s, i) => {
    const what = "start" in s
      ? `I'll start a thread in ${s.start.project}${s.start.computer ? ` on ${s.start.computer}` : ""}, ${ACCESS_SAID[s.start.mode]}${s.start.model ? `, using ${s.start.model}` : ""}: "${s.start.prompt}"`
      : `I'll send ${s.to} "${s.words}"`;
    const nb = i === 0 && o.notBefore ? `, but not before ${o.notBefore}` : "";
    const tail = i === steps.length - 1 && o.tail ? `, ${tailSaid(o.tail, "start" in s ? "the new thread" : s.to)}` : "";
    return `When ${s.after} finishes, ${what}${nb}${tail}.`;
  });
  return `${said.join(" ")} I'll watch${steps.length === 1 ? ` ${steps[0].after}` : ""} for up to ${spokenLength(o.watchMs)}${o.named ? ` on ${o.level}` : ""}. OK?`;
}

/** After the yes, what a chain adds to `scheduledLine` (4-J): "If Schema fails or asks something, nothing is sent and I'll tell you." */
export const ifFails = (after: string) => `If ${after} fails or asks something, nothing is sent and I'll tell you.`;

/**
 * What's said after the yes to a chain (4-J): "Scheduled. Quartz has it. If Schema fails…", offline "Scheduled. Quartz is
 * offline, so it gets it when it's back. If Schema fails…"; the thread it waits for on another computer than the one it
 * goes to (nothing handed over: the brain watches it), "Scheduled. If Schema fails or asks something, nothing is sent and
 * I'll tell you."
 */
export const chainScheduledLine = (handed: Handed[], computers: number, after: string) => `${scheduledLine(handed, computers)} ${ifFails(after)}`;

/**
 * The thread it waits for finished during the readback (4-J; Fable's reviews of 4-J): "Schema has just finished, so it
 * goes to API now." (a start: "…so the new thread starts now."), said only when its computer answered that it holds it
 * (`h` held) with no time it mustn't go before still ahead. Else what's true: no answer within 3 s, "Schema has just
 * finished. Scheduled." (4-A: no answer gets only "Scheduled."); its computer offline, "…so it goes to API when Quartz is
 * back." ("when your computer is back"), and with a time still ahead too, "…so it goes to API at 9 in the evening, once
 * Quartz is back."; a time ahead, "…so it goes to API at 9 in the evening." (`notBefore`, spokenClock); refused there,
 * "Schema has just finished." and 4-A's refused ending ("Scheduled, but Quartz's clock is 7 minutes off, so it won't send
 * anything until that's fixed.").
 */
export function justFinished(after: string, to: string | null, h: Handed | null = null, computers = 1, notBefore: string | null = null): string {
  const goes = to === null ? "the new thread starts" : `it goes to ${to}`;
  if (h && (h.state === "clock" || h.state === "refused")) return `${after} has just finished. ${scheduledLine([h], computers)}`;
  if (h?.state === "quiet") return `${after} has just finished. Scheduled.`;
  if (h?.state === "offline") return `${after} has just finished, so ${goes} ${notBefore ? `at ${notBefore}, once` : "when"} ${computerOf(h.machine, computers)} is back.`;
  if (notBefore) return `${after} has just finished, so ${goes} at ${notBefore}.`;
  return `${after} has just finished, so ${goes} now.`;
}

/**
 * The thread it waits for isn't running when the chain is asked for (finished earlier, or never run), or at the yes with
 * no run since (Fable's review of 4-J): there's no finish to wait for, so nothing is set up.
 */
export const chainNotRunning = (after: string) => `${after} isn't running now, so there's nothing to wait for. Nothing's set up.`;

/**
 * Why a chain's step wasn't sent, as its thread did it (the connector's codes): failed, stopped, asked, gone, still
 * working; or, judged here, at the watch's end: its computer's view not loaded, so nobody could tell (`unseen`), or its
 * reply unreadable at the latest look (`unread`).
 */
export type ChainWhy = "failed" | "stopped" | "asked" | "vanished" | "working" | "unseen" | "unread";
export const CHAIN_WHYS: readonly string[] = ["failed", "stopped", "asked", "vanished", "working", "unseen", "unread"] satisfies ChainWhy[];

/**
 * What the thread it waited for did, as a clause: "Schema failed", "Schema stopped to ask something", "Schema was still
 * working after 4 hours". Fable's reviews of 4-J: its computer (`on`) offline through the watch's end, "Prism was offline,
 * so I couldn't tell when Build finished" (no computer known, "Its computer …"); linked with its work app (`on.app`) not
 * connected, "T3 Code wasn't running on Prism, so I couldn't tell when Build finished"; its reply unreadable, "I couldn't
 * tell if Build finished".
 */
export function chainDid(after: string, why: ChainWhy, watchMs: number, on?: { machine: string; computers: number; app?: string }): string {
  switch (why) {
    case "failed": return `${after} failed`;
    case "stopped": return `${after} was stopped`;
    case "asked": return `${after} stopped to ask something`;
    case "vanished": return `${after} is gone`;
    case "working": return `${after} was still working after ${spokenLength(watchMs)}`;
    case "unseen": return on?.app
      ? `${on.app} wasn't running on ${computerOf(on.machine, on.computers)}, so I couldn't tell when ${after} finished`
      : `${on ? computerOf(on.machine, on.computers, true) : "Its computer"} was offline, so I couldn't tell when ${after} finished`;
    case "unread": return `I couldn't tell if ${after} finished`;
  }
}

/**
 * The thread it waits for stopped to ask, failed, was stopped or is gone during the readback (4-J): "Schema stopped to ask
 * something, so nothing's set up." / "Schema failed, so nothing's set up."
 */
export const chainNotSetUp = (after: string, why: Exclude<ChainWhy, "working" | "unseen" | "unread">) => `${chainDid(after, why, 0)}, so nothing's set up.`;

/** Road Trip's one step, asked for more (4-J): the level named only to an account on its plan. */
export const chainsOne = (named: boolean) => `${named ? "Road Trip chains" : "I can chain"} one step. Which one?`;
/** Only if asked what would change Road Trip's one step. */
export const CHAIN_LONGER = "Long Haul chains three.";
/** Long Haul's three, asked for a fourth. */
export const CHAIN_MOST = "Three steps is the most. Which three?";
/**
 * A chain with more steps than the level has room left for (Long Haul's 20, some waiting): "You have 19 waiting, and 20
 * is the most. Which step?" ("Which 2 steps?"), as the sends' line, which asks which thread.
 */
export const chainRoom = (waiting: number, room: number) => {
  const left = room - waiting;
  return `You have ${waiting} waiting, and ${room} is the most. Which ${left === 1 ? "step" : `${left} steps`}?`;
};

/**
 * A time it mustn't go before that the watch ends before (4-J's not-before; the call-back's own line for it, watch-lines'
 * `notBeforeReadback` with nothing to offer instead): "I can watch for up to 4 hours on Road Trip, and that ends before
 * 7 in the evening. Nothing's set up."
 */
export const chainEndsBefore = (watchMs: number, notBefore: string, level: LevelName, named: boolean) =>
  `I can watch for up to ${spokenLength(watchMs)}${named ? ` on ${level}` : ""}, and that ends before ${notBefore}. Nothing's set up.`;

/**
 * A chain's card (Call mode; 4-A's card, with what it waits for): "Schedule for when Schema finishes" (a start: "Start a
 * thread when Schema finishes"), To (In and On for a start), Say, each step after it and the tail ("Then"), its time not
 * before, On (only with more than one computer), and what happens if the thread it waits for fails or asks.
 */
export function chainCard(o: {
  after: string; to: string | null; words: string; machine: string; computers: number; watchMs: number; notBefore: string | null;
  then: { to: string; after: string; words: string }[]; tail: string | null; reason: string; start?: { project: string; mode: LaunchProfile["runtimeMode"] };
}): LaterCard {
  const then = [...o.then.map((s) => ({ label: "Then", text: `“${s.words}” to ${s.to}, when ${s.after} finishes` })), ...(o.tail ? [{ label: "Then", text: o.tail }] : [])];
  const rest = [
    ...(o.notBefore ? [{ label: "Not before", text: o.notBefore }] : []),
    { label: `If ${o.after} fails or asks`, text: `Nothing is sent, and I'll tell you. I'll watch it for up to ${spokenLength(o.watchMs)}.` },
  ];
  if (o.start) {
    const on = o.computers > 1 ? `${o.machine} · ${ACCESS_SHOWN[o.start.mode]}` : upper(ACCESS_SHOWN[o.start.mode]);
    return { title: `Start a thread when ${o.after} finishes`, rows: [{ label: "In", text: o.start.project }, { label: "On", text: on }, { label: "Say", text: `“${o.words}”` }, ...then, ...rest], button: "Schedule", reason: o.reason };
  }
  return {
    title: `Schedule for when ${o.after} finishes`,
    rows: [{ label: "To", text: o.to! }, { label: "Say", text: `“${o.words}”` }, ...then, ...(o.computers > 1 ? [{ label: "On", text: o.machine }] : []), ...rest],
    button: "Schedule",
    reason: o.reason,
  };
}

/** Watching's sentence for a chain's step (4-J): `Sending “rebase and run the tests” to API when Schema finishes`. */
export const chainSentence = (words: string, thread: string, after: string) => `Sending “${clip(words, 40)}” to ${thread} when ${after} finishes`;
/** A start as the step: `Starting a thread in driver when Schema finishes`. */
export const chainStartSentence = (project: string, after: string) => `Starting a thread in ${project} when ${after} finishes`;
/**
 * The second line's start (4-J): the tail as it would reach them now, "Then calling you when API replies" ("Then telling
 * you…", or kept "Then watching API for your next call"); a step still to come after this one, "Then 1 more step".
 */
export const thenLine = (doing: "calling" | "telling" | "kept", thread: string) => (doing === "kept" ? `Then watching ${thread} for your next call` : `Then ${doing} you when ${thread} replies`);
export const moreSteps = (n: number) => `Then ${n} more step${n === 1 ? "" : "s"}`;
/** The tail on the card ("Then" row), as Watching's call-back rows say it: "Calling you when API replies", "Telling you…", "Watching API for your next call". */
export const tailShown = (tail: Tail, thread: string) => (tail === "call" ? `Calling you when ${thread} replies` : tail === "notify" ? `Telling you when ${thread} replies` : `Watching ${thread} for your next call`);

// --- Watching (4-D) ---

/** A send's sentence: `Sending “carry on” to API at 03:00 tomorrow` (several by name, four or more by count). */
export const sendSentence = (words: string, threads: string[], shown: string) => `Sending “${clip(words, 40)}” to ${threadsNamed(threads) ?? `${threads.length} threads`} at ${shown}`;
/** A start's: `Starting a thread in driver at 14:00 tomorrow`. */
export const startSentence = (project: string, shown: string) => `Starting a thread in ${project} at ${shown}`;
/** Stop too late (shown until it goes): `Sent “carry on” to API at 03:00`. */
export const tooLateSentence = (words: string, threads: string[], shown: string) => `Sent “${clip(words, 40)}” to ${threadsNamed(threads) ?? `${threads.length} threads`} at ${shown}`;

export const STOPPING = "Stopping…";
export const TOO_LATE = "Too late to stop";
/** Too late for some of its threads, stopped for the rest (Fable's ruling on the review of 4-E): `Too late to stop for API · stopped for Docs`. */
export const tooLateStopped = (sent: string[], stopped: string[]) =>
  `${TOO_LATE} for ${threadsNamed(sent) ?? `${sent.length} threads`} · stopped for ${threadsNamed(stopped) ?? `${stopped.length} threads`}`;
/**
 * The same before the rest's computer answered (the skeptic's should on the second review of 4-E: "stopped for Docs" only
 * once it's cancelled), as 4-D's row says the rest: `Too late to stop for API · Stopping…`; offline past its time, `Too
 * late to stop for API · stopped for Docs, but Prism may have sent it already. You'll hear if it did`; offline before
 * it, `Too late to stop for API · stopped for Docs. Prism won't send it: it checks with 10 & 2 before sending anything`.
 */
export const tooLateStopping = (sent: string[]) => `${TOO_LATE} for ${threadsNamed(sent) ?? `${sent.length} threads`} · ${STOPPING}`;
export const tooLateMaybe = (sent: string[], stopped: string[], computer: string) =>
  `${tooLateStopped(sent, stopped)}, but ${computer} may have sent it already. You'll hear if it did`;
export const tooLateWont = (sent: string[], stopped: string[], computer: string) =>
  `${tooLateStopped(sent, stopped)}. ${upper(computer)} won't send it: it checks with 10 & 2 before sending anything`;
export const clockOff = (machine: string, minutes: number) => `${possessive(machine)} clock is ${minutesOff(minutes)} off, so it won't send until that's fixed`;
export const updateToSend = (machine: string) => `Update 10and2 on ${machine} to send this`;
export const waitingOnline = (machine: string) => `Waiting for ${machine} to come online`;
/** Its computer linked, its work app not connected (Fable's review of 4-J): `Waiting for T3 Code on Prism`. */
export const waitingApp = (app: string, machine: string) => `Waiting for ${app} on ${machine}`;
export const hasIt = (machine: string, mode?: LaunchProfile["runtimeMode"]) => `${mode ? `${upper(ACCESS_SHOWN[mode])} · ` : ""}${machine} has it`;
export const waitingFree = (thread: string, until: string) => `Waiting for ${thread} to be free, until ${until}`;
export const waitingOn = (machine: string, until: string) => `Waiting on ${machine}, until ${until}`;
export const offlineGoes = (machine: string, until: string) => `${machine} is offline. It goes when it's back, until ${until}`;
/** Past the end of its window, its computer offline (Fable's should on the third review of 4-E): `Quartz is offline. It wasn't sent by 05:00`. */
export const offlineNotSent = (machine: string, until: string) => `${machine} is offline. It wasn't sent by ${until}`;
/** A start's (Fable's should on the fourth review of 4-E): `Quartz is offline. It wasn't started by 16:00`. */
export const offlineNotStarted = (machine: string, until: string) => `${machine} is offline. It wasn't started by ${until}`;
export const stoppedOffline = (machine: string) => `Stopped. ${machine} won't send it: it checks with 10 & 2 before sending anything`;
/** A start's (Fable's nit on the fifth review of 4-E): `Stopped. Quartz won't start it: it checks with 10 & 2 before starting anything`. */
export const stoppedOfflineStart = (machine: string) => `Stopped. ${machine} won't start it: it checks with 10 & 2 before starting anything`;
/**
 * Its computer said it was sending it, then went offline, inside its window or past it (Fable's words on the fifth review
 * of 4-E): `Quartz went offline while sending it` (one computer: `Your computer went offline while sending it`), with no
 * Stop. It isn't waiting, so it's never said in a call; what became of it is told when that computer is back.
 */
export const wentOffline = (machine: string) => `${machine} went offline while sending it`;
/** Stopped past its time while the computer holding it is offline: it may have gone first (told if it did). */
export const stoppedMaybeSent = (machine: string) => `Stopped, but ${machine} may have sent it already. You'll hear if it did`;

// --- told after (4-F) and not sent (4-G) ---

/** "You scheduled it.": a send or a start the user set up. */
export const WHY_SCHEDULED = "You scheduled it.";

/** A time today said as past: "3 this morning", "4:31 this afternoon", "noon"; yesterday's "3 yesterday morning". */
export function spokenPast(at: number, zone: string, now: number): string {
  const c = clockOf(at, zone);
  const today = clockOf(now, zone).date;
  const hm = bareHour(at, zone);
  const part = c.hour < 12 ? "morning" : c.hour < 18 ? "afternoon" : "evening";
  if (hm === "noon" || hm === "midnight") return c.date === today ? hm : c.date === prevDate(today) ? `${hm} yesterday` : spokenDay(at, zone, now);
  if (c.date === today) return `${hm} this ${part}`;
  if (c.date === prevDate(today)) return `${hm} yesterday ${part}`;
  return c.date === nextDate(today) ? spokenClock(at, zone, now) : spokenDay(at, zone, now);
}

/** Why it went late, shown (4-F): "Quartz was asleep at 03:00.", "API was busy at 03:00.", "T3 Code wasn't running on Quartz at 03:00." */
function lateShown(f: Fact, thread: string, at: string): string {
  const c = upper(computerOf(f.machine, f.computers));
  if (f.code === "asleep") return `${c} was asleep at ${at}.`;
  if (f.code === "busy") return `${thread} was busy at ${at}.`;
  if (f.code === "app") return `${f.app ?? "Its app"} wasn't running on ${computerOf(f.machine, f.computers)} at ${at}.`;
  return `${c} couldn't be reached at ${at}.`;
}

/** Why it wasn't sent, by the computer's checks (4-G), exact. */
function reasonShown(f: Fact): string {
  const c = upper(computerOf(f.machine, f.computers));
  switch (f.code) {
    case "wrote": return "You wrote in it after you scheduled this.";
    case "ran": return "It ran again after you scheduled this.";
    case "asking": return "It's asking something else now.";
    case "gone": return "The thread is gone.";
    case "settled": return "The thread is settled.";
    case "policy": return `${c} no longer allows it.`;
    case "ceiling": return `${c} now allows less access than you agreed.`;
    case "place": return `Its folder is gone on ${computerOf(f.machine, f.computers)}.`;
    case "dropped": return `${c} no longer has it.`;
    default: return `${c} didn't send it.`;
  }
}

/** A late send is one that went more than this after its time (4-F): under it, the on-time note. */
export const LATE_MS = 2 * 60_000;
/** A chain's step goes when the thread it waited for finished, so it's never late (4-J). */
const late = (f: Fact) => f.after === undefined && f.firedAt !== undefined && f.firedAt - f.at > LATE_MS;
/** A chain's step not sent for what the thread it waited for did (4-J): its clause's why, else null. */
const chainWhy = (f: Fact): ChainWhy | null => (f.after !== undefined && f.code !== undefined && CHAIN_WHYS.includes(f.code) ? (f.code as ChainWhy) : null);
/** The computer of the thread a chain's step waited for, and its work app when it was linked, when it's told (`unseen`). */
const afterOn = (f: Fact) => (f.afterOn ? { machine: f.afterOn, computers: f.computers, ...(f.app ? { app: f.app } : {}) } : undefined);

/**
 * A send's or a start's outcome as its notification says it (4-F, 4-G; 4-L's table): what happened, each part on its own
 * line, then why ("You scheduled it."). Sent: passive, no sound, no buttons, a tap opens the thread. Missed past its
 * window: Send now (Start now) and Don't, active with sound; not sent by the computer's checks, or an outcome not known:
 * no buttons, active with sound.
 */
export function laterNoteOf(r: ReachOut, o: { names: boolean; zone: string; now: number }): Note {
  const f = r.news.later!;
  const name = o.names ? r.news.handle : null;
  const shown = (at: number) => shownClock(at, o.zone, o.now);
  const base = { type: "alert" as const, kind: "later" as const, collapseId: ruleCollapse(r.key), expiresAt: r.keepUntil, why: WHY_SCHEDULED, reachOut: r.key, choices: [] as string[], ...(name ? { thread: name } : {}) };
  const body = (...lines: (string | null | false | undefined)[]) => lines.filter(Boolean).join("\n");
  const words = clip(f.words, 150);
  const at = shown(f.at);
  if (f.outcome === "sent") {
    const when = shown(f.firedAt ?? f.at);
    // A chain's step says what it waited for (4-J): "Schema finished." ("Another thread finished." with names hidden).
    const why = late(f) ? lateShown(f, name ?? "The thread", at) : f.after !== undefined ? `${o.names ? f.after : "Another thread"} finished.` : null;
    const item = f.newItem ?? (f.start ? undefined : r.news.itemId);
    const quiet = { ...base, category: CATEGORY.sent, interruption: "passive" as const, ...(item ? { item } : {}) };
    if (f.start) {
      const where = f.computers > 1 ? `In ${f.project} on ${f.machine}.` : `In ${f.project}.`;
      return o.names
        ? { ...quiet, title: `Started at ${when}: ${clip(f.title ?? f.words, 40)}`, body: body(where, why) }
        : { ...quiet, title: `Started a thread at ${when}`, body: body(why) };
    }
    return name ? { ...quiet, title: `Sent to ${name} at ${when}`, body: body(words, why) } : { ...quiet, title: `Sent to a thread at ${when}`, body: body(why) };
  }
  const loud = { ...base, interruption: "active" as const, sound: "default" as const };
  if (f.outcome === "unknown") {
    const c = upper(computerOf(f.machine, f.computers));
    if (f.start) {
      return { ...loud, category: CATEGORY.notSent, title: "A new thread may not have started", body: body(`${c} stopped while starting it at ${at}.`, o.names ? `Check ${f.project} before starting it again.` : null) };
    }
    return name
      ? { ...loud, category: CATEGORY.notSent, title: `${name} may not have your message`, body: body(`${c} stopped while sending it at ${at}.`, `Check ${name} before sending it again.`) }
      : { ...loud, category: CATEGORY.notSent, title: "A thread may not have your message", body: body(`${c} stopped while sending it at ${at}.`) };
  }
  const kept = f.kept ? { kept: f.kept } : {};
  // A chain's step not sent for what the thread it waited for did (4-J, 4-L): Send now and Don't, as a missed one's.
  const did = chainWhy(f);
  if (did) {
    // Names hidden, the thread it waited for is "another thread" mid-sentence (4-0 (5)); its computer stays named.
    const line = `${chainDid(o.names ? f.after! : did === "unseen" || did === "unread" ? "another thread" : "Another thread", did, f.watchMs ?? 0, afterOn(f))}.`;
    const category = f.start ? CATEGORY.missedStart : CATEGORY.missedSend;
    if (f.start) {
      return o.names
        ? { ...loud, ...kept, category, title: `Not started: ${clip(f.title ?? f.words, 40)}`, body: body(line) }
        : { ...loud, ...kept, category, title: "A thread wasn't started", body: body(line) };
    }
    return name
      ? { ...loud, ...kept, category, title: `Not sent to ${name}`, body: body(line, words), words: clip(f.words, 60) }
      : { ...loud, ...kept, category, title: "Not sent to a thread", body: body(line) };
  }
  if (f.outcome === "missed") {
    const c = upper(computerOf(f.machine, f.computers));
    const line = f.code === "never" ? `${c} didn't come online before ${shown(f.until)}.` : lateShown(f, name ?? "The thread", at);
    const category = f.start ? CATEGORY.missedStart : CATEGORY.missedSend;
    if (f.start) {
      return o.names
        ? { ...loud, ...kept, category, title: `Not started: ${clip(f.title ?? f.words, 40)}`, body: body(line) }
        : { ...loud, ...kept, category, title: "A thread wasn't started", body: body(line) };
    }
    return name
      ? { ...loud, ...kept, category, title: `Not sent to ${name}`, body: body(line, words), words: clip(f.words, 60) }
      : { ...loud, ...kept, category, title: "Not sent to a thread", body: body(line) };
  }
  // Not sent by the computer's checks: the reason usually needs a look, so a tap opens it in Drafts.
  const reason = reasonShown(f);
  if (f.start) {
    return o.names
      ? { ...loud, ...kept, category: CATEGORY.notSent, title: `Not started: ${clip(f.title ?? f.words, 40)}`, body: body(reason) }
      : { ...loud, ...kept, category: CATEGORY.notSent, title: "A thread wasn't started", body: body(reason) };
  }
  return name
    ? { ...loud, ...kept, category: CATEGORY.notSent, title: `Not sent to ${name}`, body: body(reason, words) }
    : { ...loud, ...kept, category: CATEGORY.notSent, title: "Not sent to a thread", body: body(reason) };
}

/**
 * Several sends told in one look, as one notification (4-F): "3 messages sent", a line for each ("API at 03:00"; none
 * with names hidden), then why.
 */
export function sentBatchNoteOf(rs: ReachOut[], o: { names: boolean; zone: string; now: number }, collapseId: string): Note {
  const lines = o.names ? rs.map((r) => `${r.news.handle} at ${shownClock(r.news.later!.firedAt ?? r.news.later!.at, o.zone, o.now)}`) : [];
  return {
    type: "alert", kind: "later", category: CATEGORY.sent, collapseId, interruption: "passive", expiresAt: Math.max(...rs.map((r) => r.keepUntil)),
    title: `${rs.length} messages sent`, body: lines.join("\n"), why: WHY_SCHEDULED, reachOut: rs[0].key, choices: [],
  };
}

/** Why it went late, said (4-F): "Quartz was asleep at 3.", "API was busy at 3." */
function lateSaid(f: Fact, thread: string, hour: string): string {
  const c = upper(computerOf(f.machine, f.computers));
  if (f.code === "asleep") return `${c} was asleep at ${hour}.`;
  if (f.code === "busy") return `${thread} was busy at ${hour}.`;
  if (f.code === "app") return `${f.app ?? "Its app"} wasn't running on ${computerOf(f.machine, f.computers)} at ${hour}.`;
  return `${c} couldn't be reached at ${hour}.`;
}

/**
 * Why it wasn't sent, as a clause said in a call (4-G), and as the Timeline says it: after a colon, so one computer is
 * "your computer" (Fable's nit on fix4).
 */
export function reasonSaid(f: Pick<Fact, "code" | "app" | "machine" | "computers">, thread: string): string {
  const c = computerOf(f.machine, f.computers);
  switch (f.code) {
    case "asleep": return `${c} was asleep`;
    case "never": return `${c} didn't come online in time`;
    case "busy": return `${thread} was busy`;
    case "app": return `${f.app ?? "its app"} wasn't running on ${computerOf(f.machine, f.computers)}`;
    case "wrote": return "you wrote in it after scheduling";
    case "ran": return "it ran again after you scheduled";
    case "asking": return "it's asking something else now";
    case "gone": return "the thread is gone";
    case "settled": return "the thread is settled";
    case "policy": return `${c} no longer allows it`;
    case "ceiling": return `${c} now allows less access than you agreed`;
    case "place": return `its folder is gone on ${computerOf(f.machine, f.computers)}`;
    case "unreached": return `${c} couldn't be reached`;
    case "dropped": return `${c} no longer has it`;
    default: return `${c} didn't send it`;
  }
}

/**
 * What a call says of an outcome, word for word, told first (4-F, 4-G): `Sent to API at 3 this morning: "carry on".`;
 * late, `Sent to API at 4:31 this morning. Quartz was asleep at 3.`; a start, `Your thread in driver started at 2 this
 * afternoon.`; not sent, `"carry on" wasn't sent to API at 3 this morning: Quartz was asleep. It's in Drafts.`; unknown,
 * `Your message to API at 3 this morning may not have arrived. Check API before sending it again.`
 */
export function laterSaid(r: ReachOut, zone: string, now: number): string {
  const f = r.news.later!;
  const thread = r.news.handle;
  const when = spokenPast(f.at, zone, now);
  // A chain's step (4-J): `Schema finished, so I sent API: "rebase and run the tests".`; not sent for what that thread
  // did, `Schema failed, so "rebase and run the tests" wasn't sent to API. It's in Drafts.`
  const did = chainWhy(f);
  if (f.after !== undefined && f.outcome === "sent") {
    return f.start ? `${f.after} finished, so your thread in ${f.project} started.` : `${f.after} finished, so I sent ${thread}: "${f.words}".`;
  }
  if (did) {
    const drafts = f.kept ? " It's in Drafts." : "";
    const clause = chainDid(f.after!, did, f.watchMs ?? 0, afterOn(f));
    // "Prism was offline, so I couldn't tell when Build finished, and "rebase" wasn't sent to API." (Fable's review of 4-J).
    const so = did === "unseen" ? "and" : "so";
    return f.start ? `${clause}, ${so} your new thread in ${f.project} wasn't started.${drafts}` : `${clause}, ${so} "${f.words}" wasn't sent to ${thread}.${drafts}`;
  }
  if (f.outcome === "sent") {
    const fired = spokenPast(f.firedAt ?? f.at, zone, now);
    if (f.start) return `Your thread in ${f.project} started at ${fired}.${late(f) ? ` ${lateSaid(f, thread, bareHour(f.at, zone))}` : ""}`;
    return late(f) ? `Sent to ${thread} at ${fired}. ${lateSaid(f, thread, bareHour(f.at, zone))}` : `Sent to ${thread} at ${fired}: "${f.words}".`;
  }
  if (f.outcome === "unknown") {
    return f.start
      ? `Your new thread in ${f.project} at ${when} may not have started. Check ${f.project} before starting it again.`
      : `Your message to ${thread} at ${when} may not have arrived. Check ${thread} before sending it again.`;
  }
  const drafts = f.kept ? " It's in Drafts." : "";
  // Its computer no longer has it before its time: said as what won't happen (Fable's nit on fix4).
  if (f.code === "dropped" && f.at > now) {
    return f.start
      ? `Your new thread in ${f.project} won't start at ${when}: ${reasonSaid(f, thread)}.${drafts}`
      : `"${f.words}" won't go to ${thread} at ${when}: ${reasonSaid(f, thread)}.${drafts}`;
  }
  return f.start
    ? `Your new thread in ${f.project} wasn't started at ${when}: ${reasonSaid(f, thread)}.${drafts}`
    : `"${f.words}" wasn't sent to ${thread} at ${when}: ${reasonSaid(f, thread)}.${drafts}`;
}

// --- the Timeline (4-F) ---

/** How it was agreed to, as the Timeline says it. */
export const VIA_SAID = { voice: "spoken yes", tap: "tap", faceid: "Face ID" } as const;
