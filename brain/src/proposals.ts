// Every change goes propose → spoken readback → heard gate → user's yes → confirm → receipt.
// The spike showed the voice model can drop or shorten the backend's readback, and thread text can
// try to steer the model, so the brain itself checks (1) that the readback's entities and the gist
// of any message were spoken after the proposal was made, and (2) that the user started a new turn
// after hearing it, and that turn agrees.
import { randomUUID } from "node:crypto";
import type { Action, Adapter, LaunchProfile, CodingModel, Place, Receipt, WorkItem } from "./adapter.ts";
import { DONE, type ClutterGroup } from "./briefing.ts";
import { dictatedParts, DRAFT_MAX, draftState, isNewThread, newThreadName, newThreadTarget, parseNewThread, type NewThread } from "./drafts.ts";
import { inGroup, isMark, keyWords, nameKey, norm, pick, resolve, sayKey, saysHead, speechTokens, spokenTitle, withGroup, type Named } from "./handles.ts";
import { TAP, WROTE_CLAIM, type Approved, type KeptReply, type Proposal, type ProposalTarget, type Store } from "./store.ts";
import type { Titler } from "./titles.ts";
import { confirmUnder, privacyOf } from "./privacy.ts";
import { followNewOf } from "./follow.ts";
import { LIMITS, NOT_FROM_NOTE, NOTHING_SET_UP, type Limits } from "./levels.ts";
import { afterStart, AHEAD_MS, finishedSince, listedOn, ranSince, runningNow, SENT_MS, viewLags, type JustSent, type Later, type StopSaid } from "./later.ts";
import {
  ACCESS_SHOWN, chainCard, chainEndsBefore, chainNotRunning, chainNotSetUp, chainReadback, clip, DAY_AGAIN, LATER_NO_COMPUTER, laterCard, MIDNIGHT_AGAIN, NOTHING_WAITING, sendReadback,
  startReadback, tailShown, TAP_SCHEDULE, TAP_SCHEDULE_CAR, threadsNamed, TIME_AGAIN, TOO_FAR, WHEN_AGAIN, type ChainStep, type Tail,
} from "./later-lines.ts";
import { NO_REPEATS, NO_ZONE, TIME_PASSED, watchingAnswer } from "./watch-lines.ts";
import { answering, letsRun, NOT_BY_VOICE, NO_LONGER as HELD_NO_LONGER, sentStopped, stopsIt, stopsReadback, TAP_TO_RUN, toldNo, type Where } from "./held-lines.ts";
import { RUN_ENDS_MS } from "./reads.ts";
import { mapLimit } from "./util.ts";
import { phoneInCarIn, phoneZoneIn } from "./ring.ts";
import { clockOf, localInstant, parseWhen, shownClock, spokenClock, validZone, whyUnread } from "./zone.ts";
import { APPS, NO_DEFAULTS, otherNames, placeParts, preferred, spokenPlaces, type NewThreadDefaults } from "./places.ts";
import { defaultModel, isUsual, keptName, matchModel, saidProvider, sameName, sayNames, USUAL, withProvider } from "./thread-models.ts";
import type { Track } from "./analytics.ts";
import { CAR_KEPT, faceIdAsk, faceIdRefusal, type At } from "./faceid.ts";

export type ProposeAction = "follow_up" | "settle" | "snooze" | "archive" | "settle_subagents" | "start_work";
/**
 * What a tap on the phone changes in a thread (`Proposals.tap`): a reply sent with Send is a `follow_up`. Following one
 * is the brain's own (`noted`).
 */
export type TapAction = "settle" | "unsettle" | "snooze" | "unsnooze" | "follow_up";

/**
 * `project`, `profile` and `model` are for start_work: where, which launch profile, and a model the user named, in their
 * words. The thread is titled as it starts.
 */
export type ProposeInput = {
  action: ProposeAction;
  handles: string[];
  message: string | null;
  until: string | null;
  project?: string | null;
  profile?: string | null;
  model?: string | null;
  /** start_work: what it uses where the user didn't say (Settings → New threads); absent: nothing, so Driver asks. */
  defaults?: NewThreadDefaults;
  /**
   * follow_up or start_work set up for later (stage 4b): the time as the user said it ("at 3", "tomorrow at 2", "in 2
   * hours"), read on the phone's clock (zone.ts `parseWhen`). Nothing is sent now: the yes hands it to the computer.
   */
  at?: string | null;
  /**
   * follow_up or start_work when another thread finishes (4-J's chains): the thread it waits for, as said. With it, `at`
   * is a time it mustn't go before ("but not before 6"), `then` the steps after it (each sent when the thread before it
   * finishes), and `tail` how "and call me when that's done" would reach them (the engine's `tailVerb`), or null.
   */
  after?: string | null;
  then?: { handle: string; message: string }[] | null;
  tail?: Tail | null;
};

/** Set up for later: at a time (stage 4b) or when another thread finishes (4-J). Nothing is sent now; its yes schedules it. */
export const forLater = (p: Pick<Proposal, "fields">) => p.fields.at !== undefined || !!p.fields.chain;

/** A refusal said instead of a readback, word for word, with nothing set up (Fable's 4-C), and what would change it. */
const sayOnly = (line: string, asked?: string) => ({
  error: `Nothing is set up and nothing is sent. Say only "${line}", word for word, then carry on with the call.${asked ? ` Only if they ask what would change it, say only "${asked}".` : ""}`,
  refused: line,
});
/**
 * The thread a chain waits for isn't running (Fable's review of 4-J): its fixed line, and the model told that a send they
 * still want now is an ordinary one, with its own readback.
 */
const notRunning = (after: string) => {
  const line = chainNotRunning(after);
  return {
    error: `Nothing is set up and nothing is sent. Say only "${line}", word for word, then carry on with the call. If they then say they still want it sent or started, that's an ordinary follow_up or start_work now: propose it again without after, and say its own readback.`,
    refused: line,
  };
};
export type ToolResult = Record<string, unknown>;
/** The user's latest turn and how much the assistant had said when it began. */
export type UserTurn = { text: string; atSpoken: number };

/**
 * What the user said, without the sounds speech-to-text writes in brackets: "[sniff", "[hum]", "[cough]". On 5 November a
 * sniff right after "Do it" became the user's latest turn, the yes was refused, and the voice said "Sent." anyway.
 */
export const spokenWords = (text: string) => text.replace(/\[[^\][\n]{0,40}(?:\]|$)/g, " ").replace(/\s+/g, " ").trim();

/**
 * The result of a reply proposal kept for later (`Proposals.keep`): closed as "cancelled", since nothing was sent, with
 * this result, so its receipt says kept (callview.ts).
 */
export const KEPT = "Kept for later.";

/**
 * What a reply to a thread does in a call (the phone's setting, "Ask each time" by default there): "ask" whether to send
 * it now or keep it for later, "keep" it for later at once (no readback, no yes: nothing is sent), or "send" it on a
 * spoken yes. Only replies to existing threads; any other change is proposed as ever.
 */
export type KeepReplies = "ask" | "keep" | "send";

/**
 * How the user agrees to a change in a call (the phone's setting `confirm`, per kind of change): "none" carries it out
 * as soon as it's proposed; "yes" on a clear yes after it was proposed; "readback" on a yes after the readback was heard
 * in full (every change, before 7 November); "tap" only with the phone's Send.
 */
export type Level = "none" | "yes" | "readback" | "tap";
export type ConfirmLevels = { reply: Level; start: Level; archive: Level; settle: Level; snooze: Level; tidy: Level };
/** What a call gets for any kind of change its phone doesn't say (an older phone says none). */
export const DEFAULT_CONFIRM: ConfirmLevels = { reply: "yes", start: "yes", archive: "yes", settle: "none", snooze: "none", tidy: "none" };
/** Every change read back and heard: a session told nothing (tests, a session made before levels, taken back after a restart). */
export const READBACK_ALL: ConfirmLevels = { reply: "readback", start: "readback", archive: "readback", settle: "readback", snooze: "readback", tidy: "readback" };
const LEVELS: readonly Level[] = ["none", "yes", "readback", "tap"];
/** Which setting a proposed action follows. */
export const CONFIRM_KEY = { follow_up: "reply", start_work: "start", archive: "archive", settle: "settle", snooze: "snooze", settle_subagents: "tidy" } as const satisfies Record<ProposeAction, keyof ConfirmLevels>;

/** The phone's `confirm` (an object, or one encoded as JSON): each kind it says, the default for the rest. */
export function confirmOf(raw: unknown): ConfirmLevels {
  let given: any = raw;
  if (typeof raw === "string") {
    try {
      given = JSON.parse(raw);
    } catch {
      given = null;
    }
  }
  const out = { ...DEFAULT_CONFIRM };
  if (!given || typeof given !== "object") return out;
  for (const k of Object.keys(out) as (keyof ConfirmLevels)[]) if (LEVELS.includes(given[k])) out[k] = given[k];
  return out;
}

/** What a spoken confirm the brain refused would have done, as a receipt says it: "Not sent". */
export const NOT_DONE: Record<string, string> = {
  follow_up: "Not sent", start_work: "Not started", archive: "Not archived", settle: "Not settled", snooze: "Not snoozed", settle_subagents: "Not settled",
};

/** A reply to one thread, or a dictated prompt, which `keep` can keep for later in Drafts. */
export const keepable = (p: Pick<Proposal, "action" | "targets" | "fields">) => (p.action === "follow_up" && p.targets.length === 1) || (p.action === "start_work" && !!p.fields.keptId);
/**
 * A spoken yes, or a change at once, that the user's settings (`Level` `tap`) carry out only with Send on the phone, below
 * Privacy's Face ID every time (Before it acts' own Tap Send). One that can be kept offers that too, so a driver has a
 * way on that needs no hands (Fable, 18 November). One set up for later has Schedule on the phone, and no keeping
 * (Fable's 4-A). At Face ID every time the line is by where the phone is (`Proposals.refusal`, stage 2b).
 */
const tapRefusal = (p: Pick<Proposal, "action" | "targets" | "fields">) => forLater(p)
  ? { error: `The user's settings set this up only with a tap: say only "${TAP_SCHEDULE}", word for word. Nothing is set up yet; never call confirm or keep for it.`, refused: "tap Schedule on your phone" }
  : {
    error: keepable(p)
      ? `The user's settings carry this out only with a tap: say "That needs your tap on Send. Or say keep it, and it'll be in Drafts." If they say keep it, call keep.`
      : "The user's settings carry this out only with a tap: tell them to tap Send on their phone to go ahead.",
    refused: "tap Send on your phone",
  };

/** A send waiting for Face ID that "Approve to send" asks about (stage 2b; engine.ts `approve`): its id, a proposal's or a kept reply's. */
export type Approval = { id: string; start: boolean; name: string | null; message: string; expiresAt: number; conversationId?: string };

const EXPIRY_MS = 120_000;
/** Sends kept in the car: their calls' "Approve to send" (stage 2b), kv. */
const CAR_KEPT_KEY = "car_kept";
/** How long Apple keeps an "Approve to send" for a send kept in the car, for a phone that's off: a day, as news is kept. */
const KEPT_APPROVE_MS = 24 * 3600_000;
/** An outcome lost to a dropped connection may be retried (same keys) for a while longer. */
const RETRY_MS = 10 * 60_000;
const MAX_TARGETS = 10;
/** How long a carried-out change stays in `/api/updates` for the phone's tone (it polls every 3 s). */
const DONE_MS = 30_000;

export type ProposalDeps = {
  store: Store;
  adapter: Adapter;
  /** Items the user can name, with their spoken handles: unsettled ones only. */
  named: () => (Named & { item: WorkItem })[];
  /** Settled items, so a name that fits one gets "that's settled" rather than "no match". */
  settled?: () => Named[];
  clutter: () => ClutterGroup[];
  /** Where new work can start (the adapter's places), and what it may run with: the first profile is the default. */
  places?: () => Place[];
  profiles?: LaunchProfile[];
  /**
   * A new thread was started: let the briefing know it (and what Driver calls it, where), so it can be named straight
   * away. Gives the name the work system gave it, once it lists it, else null.
   */
  started?: (itemId: string, started: { title: string; group: string }) => Promise<string | null | void>;
  /** Titles a new thread from its prompt as it starts. Without it, or when it fails, the work system names the thread. */
  title?: Titler;
  /** Everything the assistant has said aloud in this conversation. */
  spoken: (conversationId: string) => string;
  lastUserTurn: (conversationId: string) => UserTurn;
  now?: () => number;
  log?: (m: string) => void;
  /** Analytics (contracts §5): a reply kept for later is `reply_kept`. */
  track?: Track;
  /**
   * The account's level's limits now (levels.ts; the cloud's `limitsOf`, the engine's too), read just before a send:
   * an answer from a notification's button goes only while the level answers from one. None (Lattice): Long Haul's.
   */
  limits?: () => Limits;
  /** Sends and starts set up for later (later.ts, stage 4b): without it (a demo world), none can be. */
  later?: Later;
};

/** The hold a call's user asked to let run by voice, shown as its card in Call mode with both buttons (callview.ts). */
export const heldAskedKey = (conversationId: string) => `held_asked:${conversationId}`;

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** A name as heard, without the marks inside it ("TestFlight, Quartz" is said either way). */
const nameTokens = (s: string) => speechTokens(s).filter((w) => !isMark(w));

/**
 * A target as its readback says it, with its project: "Agent Reel, in sd". Proposals made before targets kept their
 * project say the name alone.
 */
const said = (t: { handle: string; group?: string }) => (t.group === undefined ? t.handle : withGroup(t.handle, t.group));
/** The same, before what follows it in a sentence: "Send Agent Reel, in sd, this message". */
const saidBefore = (t: { handle: string; group?: string }) => (t.group === undefined ? t.handle : withGroup(t.handle, t.group, true));
type MustHear = Omit<Proposal["mustHear"][number], "from">;
/**
 * The coding model a new thread starts on: its id (sent), its name and the provider said with it (`saidProvider`), and
 * whether the user named it, or Settings did.
 */
type ChosenModel = NonNullable<Proposal["fields"]["model"]>;
/**
 * What the user said for a new thread's coding model, and Settings' default (`NewThreadDefaults.codingModel`, and its
 * `codingProvider`), each maybe.
 */
type ModelAsk = { said?: string | null; fallback?: string | null; fallbackProvider?: string | null };

/** A place's project, as heard: "in driver" of "in driver, on Lattice". */
const projectTokens = (name: string) => {
  const t = speechTokens(`in ${name}`);
  const m = t.findIndex(isMark);
  return { project: m < 0 ? t : t.slice(0, m), rest: m < 0 ? [] : t.slice(m) };
};

/**
 * What a new thread's readback must be heard saying, before "with this message": "Start a new thread in <project>" word
 * for word, then its profile and its model, each a clause of its own. The machine may be left out when no other machine
 * has a project of that name, the profile when it's the default, and the model when Settings chose it; a profile or a
 * model the user asked for is heard. On 5 November the voice said "…, in Driver, with this message" four times over and
 * each "yes" was refused. One group, so the whole readback said word for word passes on its own, whatever the profile
 * (until 20 November another profile's was its own group, and its readback never passed alone).
 */
function startHeard(place: Place, places: Place[], profile: LaunchProfile, isDefault: boolean, model: ChosenModel | null): MustHear[] {
  const { project, rest } = projectTokens(place.name);
  const key = project.join(" ");
  const shared = places.some((o) => o.id !== place.id && projectTokens(o.name).project.join(" ") === key);
  const named = nameTokens("Start a new thread");
  const head = shared ? [...named, ...project, ...rest.filter((w) => !isMark(w))] : [...named, ...project];
  const clauses = [
    { words: nameTokens(`with the ${profile.name} profile`), optional: isDefault },
    ...(model ? [{ words: nameTokens(`using ${withProvider(model)}`), optional: !model.said }] : []),
  ];
  return [{ words: [], need: 0, head, where: shared ? [] : rest, clauses, next: ["with", "this"] }];
}

/** The project a readback says after the name, as heard: optional there, since the name alone is unique. */
const whereTokens = (t: { handle: string; group?: string }) => {
  if (said(t) === t.handle) return [];
  // Clause marks are kept between words, so the place may be heard up to one of them ("in sd" of "in sd, on Quartz").
  const words = speechTokens(inGroup(t.group!));
  while (words.length && isMark(words[0])) words.shift();
  while (words.length && isMark(words.at(-1)!)) words.pop();
  return words.filter((w, i) => !isMark(w) || !isMark(words[i - 1]));
};

/**
 * Another thread, open or settled, whose own readback would pass for a target's: "Archive Agent Reel: Dashboard."
 * says "Archive Agent Reel." No wording tells those apart by voice. One thread: whole readbacks are compared (so "Docs:
 * Agent Reel" is fine). Several: each name is its own clause, so a name that starts another at a clause break clashes.
 * A name that sounds exactly the same (`sayKey`) can only be a settled thread, since open names are made unique, and a
 * settled thread can't be acted on: not a clash.
 */
function lookalike(targets: { itemId: string; handle: string; group?: string }[], verb: string, next: string | null, open: Named[], settled: Named[]): { target: string; other: string } | null {
  const others = [...open, ...settled];
  const isOpen = new Set(open.map((o) => o.id));
  const one = targets.length === 1;
  for (const t of targets) {
    for (const o of others) {
      if (o.id === t.itemId || sayKey(o.handle) === sayKey(t.handle)) continue;
      const mine = one ? nameTokens(`${verb} ${t.handle}`) : nameTokens(t.handle);
      // An open thread's readback, said with its project or without, and with "the thread called" before the name (the
      // setting threadNames). A settled one is never read back, so only its bare name could be taken for this one's.
      const read = isOpen.has(o.id) ? [said(o)] : [];
      for (const name of new Set([o.handle, ...read, ...read.flatMap((r) => [`the thread called ${o.handle}`, `the thread called ${r}`])])) {
        // In a list, each name ends its clause ("…: Agent Reel; Dashboard.").
        const theirs = one ? speechTokens(`${verb} ${name}${next ? ` ${next}` : "."}`) : speechTokens(`${name};`);
        // Where the name starts, as `heard` allows "the thread called" there.
        if (saysHead(theirs, mine, one ? next : null, whereTokens(t), one ? 1 : 0)) return { target: t.handle, other: o.handle };
      }
    }
  }
  return null;
}

/** T3 won't settle a thread while a run is going, so Driver doesn't offer to. */
const stillWorking = (t: { handle: string; group?: string }) =>
  `${saidBefore(t)} is still working, and T3 can't settle a thread while it runs. Say so: it can be settled once it finishes.`;

const tooAlike = (c: { target: string; other: string }) =>
  `${c.target} and ${c.other} are named too alike for the app to tell apart by voice. Tell the user to do this in T3 Code, or to rename one of them.`;

/**
 * Parses the model's `until`: a date (8 AM) or a local date-time, in the future, within 90 days; or one with its own
 * offset. Local on the clock in `zone` (stage 3.8: the phone's, else the thread's computer's: zone.ts `localInstant`),
 * else in the runtime's own zone, as before.
 */
export function parseUntil(until: string, now: number, zone?: string | null): Date | null {
  const z = validZone(zone);
  let t: number;
  if (z) t = localInstant(until, z) ?? NaN;
  else {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until.trim());
    t = (dateOnly ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3], 8, 0) : new Date(until)).getTime();
  }
  if (Number.isNaN(t) || t <= now || t > now + 90 * 86_400_000) return null;
  return new Date(t);
}

/**
 * A snooze's date as said ("Friday 20 November at 8 AM"), and the words that must be heard: on the clock in `zone`
 * (stage 3.8: where `parseUntil` read it), else the runtime's own, in the same words either way.
 */
export function spokenDate(d: Date, now: number, zone?: string | null): { text: string; words: string[]; timeWords: string[] } {
  const z = validZone(zone);
  const tz = z ? { timeZone: z } : {};
  const c = z ? clockOf(d.getTime(), z) : { hour: d.getHours(), minute: d.getMinutes() };
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long", ...tz });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", ...tz });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: c.minute ? "2-digit" : undefined, ...tz });
  const withinWeek = d.getTime() - now < 6.5 * 86_400_000;
  // Within a week the weekday is unambiguous; further out the month has to be heard too.
  const words = withinWeek ? [weekday.toLowerCase()] : [weekday.toLowerCase(), d.toLocaleDateString("en-GB", { month: "long", ...tz }).toLowerCase()];
  const timeWords = [String(c.hour % 12 || 12)];
  if (c.minute) timeWords.push(String(c.minute));
  timeWords.push(c.hour < 12 ? "am" : "pm");
  return { text: `${weekday} ${date} at ${time}`, words, timeWords };
}

/** Contractions share their negation with the expanded form, independently of stop words. */
function messageText(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\b(do|does|did|is|are|was|were|have|has|had|could|should|would|must|need|dare|might|wo|ca|sha|ai)nt\b/g, "$1n't")
    .replace(/\b(won't|can't|shan't|ain't)\b/g, (w) => ({ "won't": "will not", "can't": "can not", "shan't": "shall not", "ain't": "is not" })[w]!)
    .replace(/n't\b/g, " not")
    .replace(/\bcannot\b/g, "can not");
}
const negations = (s: string) => messageText(s).match(/\b(not|no|never|without|nothing|none|nobody)\b/g) ?? [];
const messageWords = (s: string) => speechTokens(messageText(s)).flatMap((w) => keyWords(w, true));

/** Locate a cut in the proposed message only when its heard key words form an exact prefix. */
function messagePrefix(message: string, words: string[]): string | null {
  for (const token of message.matchAll(/\S+/g)) {
    const prefix = message.slice(0, token.index + token[0].length);
    const keys = messageWords(prefix);
    if (keys.length === words.length && keys.every((w, i) => w === words[i])) return prefix;
  }
  return null;
}

/** Longest common subsequence: repeated words count only when heard in the same order. */
function inOrder(wanted: string[], said: string[]): number {
  const counts = new Array(said.length + 1).fill(0);
  for (const word of wanted) {
    let previous = 0;
    for (let j = 1; j <= said.length; j++) {
      const old = counts[j];
      counts[j] = word === said[j - 1] ? previous + 1 : Math.max(counts[j], counts[j - 1]);
      previous = old;
    }
  }
  return counts[said.length];
}

/** True when every must-hear group appears in what was spoken after that group's starting point. */
export function heard(p: Pick<Proposal, "mustHear">, spoken: string, atSpoken = spoken.length): boolean {
  return p.mustHear.every((g) => {
    if (g.head) return saysHead(speechTokens(spoken.slice(g.from)), g.head, g.next ?? null, g.where, g.named, g.clauses);
    if (g.message !== undefined) {
      // Only an empty message prefix may carry into the immediately following utterance. Either question after a
      // readback ends it: its words are never the message's.
      const parts = spoken.slice(g.from).split(/(\uE000|\bshall\s+i\s+go\s+ahead\b|\bsend\s+it\s+now\W+or\s+keep\s+it\s+for\s+later\b)/i);
      let end = g.from;
      for (let i = 0; i < parts.length; i += 2) {
        const readFrom = end;
        let read = parts[i];
        let boundary = parts[i + 1] ?? "";
        if (boundary === "\uE000" && /\bthis\s+message[^\p{L}\p{N}]*$/iu.test(read) &&
          parts[i + 2] && !/\bthis\s+message\b/i.test(parts[i + 2])) {
          read += boundary + parts[i + 2];
          boundary = parts[i + 3] ?? "";
          i += 2;
        }
        end = readFrom + read.length + boundary.length;
        const start = [...read.matchAll(/\bthis\s+message\s*:?\s*/gi)].at(-1);
        if (!start) continue;
        const messageFrom = start.index + start[0].length;
        const said = read.slice(messageFrom);
        const cut = Math.max(0, Math.min(said.length, atSpoken - readFrom - messageFrom));
        const before = said.slice(0, cut);
        const midWord = /[a-z0-9'’]$/i.test(before) && /^[a-z0-9'’]/i.test(said.slice(cut));
        const completeWords = midWord ? before.replace(/[a-z0-9'’]+$/i, "") : before;
        const words = messageWords(completeWords);
        // A message with no key words ("on it") has nothing to count, so all of its words must have been heard.
        if (g.words.length === 0) {
          const whole = speechTokens(messageText(g.message));
          if (inOrder(whole, speechTokens(messageText(completeWords))) < whole.length) continue;
        }
        let expected = g.message;
        let need = g.words.length - Math.floor(g.words.length / 10);
        // A continuation proves a cut-in only if we can map the heard prefix and its next word.
        // Words after the cut never count toward the threshold or supply a missing negation.
        const allWords = messageWords(said);
        if (!midWord && words.length > 0 && words.length < g.words.length && allWords.length > words.length &&
          allWords.slice(0, words.length + 1).every((w, j) => w === g.words[j]) &&
          words.every((w, j) => w === g.words[j])) {
          const prefix = messagePrefix(g.message, words);
          if (prefix !== null) {
            expected = prefix;
            need = g.need;
          }
        }
        const wantedNo = negations(expected);
        const saidNo = negations(completeWords);
        if (saidNo.length === wantedNo.length && inOrder(wantedNo, saidNo) === wantedNo.length &&
          inOrder(g.words, words) >= need) return true;
      }
      return false;
    }
    if (g.sequence) {
      const said = speechTokens(norm(spoken.slice(g.from)));
      return said.some((_, i) => g.sequence!.every((w, j) => said[i + j] === w));
    }
    // Every number reads as digits here, "one" included: these are the readback's words, not a name someone chose.
    const said = new Set(keyWords(spoken.slice(g.from), true));
    const words = [...new Set(g.words.flatMap((w) => keyWords(w, true)))];
    return words.filter((w) => said.has(w)).length >= Math.min(g.need, words.length);
  });
}

const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|send it|please do|confirm|confirmed|correct|absolutely|definitely|sounds good|make it so)\b/i;
// "Send it now, or keep it for later?" (a dictated reply, `keepReplies: "ask"`): "Send it now" (or "Send", 7 November) as the whole answer is a yes;
// inside anything longer ("do you need me to say send now?") it isn't, and "send it later" never is.
const SEND_NOW = /^\W*(?:yes\W+)?send(?: it)?(?: now)?(?:\W+please)?\W*$/i;
const NO = /\b(no|nope|don't|do not|wait|hold on|hang on|stop|cancel|never ?mind|not yet|actually|not|maybe|perhaps|I guess|I think|probably|unsure|hm+|but|unless|except|only if|instead|rather|later|keep)\b/i;
// A question is never a yes, whatever words it has (21 November): "Are you sure?", "Is that okay?", "Is that correct?",
// "Sure?" carry YES's words but ask, and a default level of `yes` must not carry the change out on them.
const QUESTION = /\?\s*$|\b(are you|is that|is it|was that|will that|would that|should (i|we|you)|do you|did you|can you|could you|am i)\b/i;
const asks = (said: string) => QUESTION.test(spokenWords(said));
/** The user's own words must agree: the model's judgement alone is not consent (thread text can inject). */
export const agrees = (said: string) => {
  if (asks(said)) return false;
  const s = messageText(spokenWords(said)).replace(/\bno (problem|worries)\b/gi, "");
  return (YES.test(s) || SEND_NOW.test(s)) && !NO.test(s);
};

// The plainest answers to "OK?" that `agrees` doesn't take (18 November, eval): "That's fine.", "Alright.". Only for
// `wait_for`'s readback, which sets up how a reply reaches the user, never a message to an agent: a send's yes stays
// `agrees`'s. NO still wins ("that's not fine", "fine, but…", "I guess that's fine"); "Mm-hm." is no answer.
const READBACK_YES = /\b(fine|alright|all right|that works|works for me|that'll do|that will do|go on)\b/i;
/** The user's own words agree to `wait_for`'s readback: `agrees`, or one of `READBACK_YES` with nothing of NO. */
export const agreesToReadback = (said: string) => {
  if (asks(said)) return false;
  const s = messageText(spokenWords(said)).replace(/\bno (problem|worries)\b/gi, "");
  return agrees(said) || (READBACK_YES.test(s) && !NO.test(s));
};

/**
 * The user's words answer `wait_for`'s readback one way or the other: a yes's words or anything of NO. " please." doesn't:
 * it's the rest of an answer split by the voice's quick reply ("Yes", "Done.", " please.", 18 November, eval).
 */
export const answersReadback = (said: string) => {
  const s = messageText(spokenWords(said)).replace(/\bno (problem|worries)\b/gi, "");
  return YES.test(s) || SEND_NOW.test(s) || READBACK_YES.test(s) || NO.test(s);
};

// "Keep it", "later", "not now": the backend's `keep`, for a reply asked about with "Send it now, or keep it for later?".
const KEEP_IT = /\b(keep|later|not now|save)\b/i;
/**
 * The user's answer to a readback is neither a yes (`agrees`, the only answer a spoken confirm takes) nor a keep: "No",
 * "No, on Quartz", "What's in it?". The change waiting for it is cancelled (`VoiceSession.notAgreed`), as the backend is
 * told to do for a decline, a hesitation or a change, and proposed again if they want it.
 */
export const notAYes = (said: string) => {
  const s = spokenWords(said);
  return s !== "" && !agrees(s) && !KEEP_IT.test(s);
};

/** What a spoken message can't contain, or null: the readback's own markers, and more than a voice follow-up holds. */
function badMessage(message: string): string | null {
  if (!message) return "What should the message say? Ask the user.";
  if (/\bshall\s+i\s+go\s+ahead\b/i.test(message)) return 'Please rephrase the message without "shall I go ahead", so I can tell it apart from the confirmation question.';
  if (/\bthis\s+message\b/i.test(message)) return 'Please rephrase the message without "this message", so I can tell it apart from the readback prefix.';
  if (message.length > 1000) return "That message is too long for a voice follow-up. Offer to let the user dictate it instead.";
  return null;
}

/**
 * Which place the user means: their words for a project, with or without its machine ("driver", "expo on Quartz"). The
 * same project on two machines is theirs to settle, unless they already did: their latest words (`hint.said`) name one
 * of its machines ("start a thread in driver on Lattice", which the backend passed on as "driver" on 14 November), or
 * it's the place the prompt was dictated for (`hint.placeId`). Pure, for tests.
 */
export function pickPlace(spoken: string, given: Place[], hint: { said?: string; placeId?: string | null } = {}): { place: Place } | { error: string } {
  // Said as the user can say them: no two alike (places.ts).
  const places = spokenPlaces(given);
  if (!places.length) return { error: "The app can't see any projects right now: their machines may be unreachable. Say so." };
  const found = lookUp(spoken, places);
  if ("place" in found) return found;
  const settled = settle(found.options, hint);
  if (settled) return { place: settled };
  // Each option a clause of its own: names have commas in them ("nix, on Lattice").
  if (found.options.length > 1) return { error: `"${spoken}" could mean ${found.options.map((o) => o.name).join("; or ")}. Ask the user which, in those words.` };
  const recent = [...places].sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? "")).slice(0, 6).map((p) => p.name);
  return { error: `${found.words ? `No project matches "${spoken}".` : "Which project?"} Projects active lately: ${recent.join("; ")}. Ask the user which.` };
}

/**
 * The places the user's words for a project could be when `pickPlace` can't settle them without asking: the same project
 * on two machines ("driver, on Lattice" and "driver, on Quartz"), as said among `given`. Empty for one match or none.
 */
export function placeOptions(spoken: string, given: Place[]): string[] {
  const found = lookUp(spoken, spokenPlaces(given));
  return "options" in found && found.options.length > 1 ? found.options.map((o) => o.name) : [];
}

/** The place the user's words name, or the ones they could mean (`places` as `spokenPlaces` says them). */
function lookUp(spoken: string, places: Place[]): { place: Place } | { options: Place[]; words: string } {
  const words = spoken.replace(/\b(project|repo|repository|machine)\b/gi, " ").trim();
  const named = places.map((p) => ({ id: p.id, handle: p.name, group: "", title: p.name.replace(/, on [\w-]+$/, "") }));
  const r = words ? resolve(words, named) : { kind: "none" as const };
  if (r.kind === "match") return { place: places.find((p) => p.id === r.item.id)! };
  if (r.kind === "ambiguous") return { options: r.options.map((o) => places.find((p) => p.id === o.id)!), words };
  // Another name for it: its repository's or its folder's ("mono nix" is the project "nix" in mono/nix), with the machine
  // if they said one.
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const machine = / on ([\w-]+)$/i.exec(words.replace(/,/g, ""))?.[1]?.toLowerCase();
  const said = key(machine ? words.replace(/,?\s+on\s+[\w-]+$/i, "") : words);
  const also = said ? places.filter((p) => otherNames(p).some((n) => key(n) === said) && (!machine || p.name.toLowerCase().endsWith(`, on ${machine}`))) : [];
  return also.length === 1 ? { place: also[0] } : { options: also, words };
}

/**
 * One project on several machines (`options`, "driver, on Lattice" and "driver, on Quartz"), settled by the user's own
 * words naming exactly one of those machines ("… on Lattice"), else by the place it was meant for already. Options that
 * are different projects are never settled here.
 */
function settle(options: Place[], hint: { said?: string; placeId?: string | null }): Place | null {
  const project = (p: Place) => sayKey(p.name.replace(/, on [\w-]+$/, ""));
  if (options.length < 2 || options.some((o) => project(o) !== project(options[0]))) return null;
  const said = ` ${(hint.said ?? "").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ")} `;
  const byWords = options.filter((o) => {
    const machine = /, on ([\w-]+)$/.exec(o.name)?.[1]?.toLowerCase();
    return machine && said.includes(` on ${machine} `);
  });
  if (byWords.length === 1) return byWords[0];
  return options.find((o) => o.id === hint.placeId) ?? null;
}

/** How long a dictated draft is, as its readback says it: "about 310 words in 3 parts". */
const size = (words: number, parts: number) =>
  `${words < 20 ? `${words} ${words === 1 ? "word" : "words"}` : `about ${Math.round(words / 10) * 10} words`}${parts > 1 ? ` in ${parts} parts` : ""}`;

/** A message may be paraphrased, but its gist must be heard. */
const messageNeed = (n: number) => Math.min(n, Math.max(2, Math.ceil(n * 0.4)));

export class Proposals {
  private readonly d: ProposalDeps;
  private stopped = 0;
  private readonly proposing = new Map<string, number>();
  /** Whether Privacy is at Face ID every time: the account's own setting (server.ts sets it for a demo world's). */
  faceid: () => boolean;
  /**
   * Where the phone is in the live call (stage 2b), as its call-board poll last said (server.ts sets it): picks the line
   * said after a send's readback at Face ID every time, and what a spoken yes gets. Null: not known.
   */
  at: () => At | null = () => null;
  /**
   * Where the phone is in the live call, as its call-board poll last said, Notifications on or off (server.ts sets it):
   * where a tap the call asks for is (`whereOf`). Null: not known.
   */
  place: () => At | null = () => null;
  /** Sends "Approve to send" for a send waiting for Face ID (server.ts sets it: the engine's `approve`); none, nothing. */
  approve: (a: Approval) => void = () => {};
  constructor(deps: ProposalDeps) {
    this.d = deps;
    this.faceid = () => privacyOf(deps.store).security === "faceid";
  }
  /**
   * The level a change goes at now: the one it was made or proposed with, under Privacy as it is now (`confirmUnder`),
   * so Face ID every time, chosen during a call, holds at once for a reply or a start, a proposal already open included.
   */
  private levelNow(action: string, level: Level): Level {
    const key: keyof ConfirmLevels | undefined = CONFIRM_KEY[action as ProposeAction];
    return key && this.faceid() ? confirmUnder({ ...READBACK_ALL, [key]: level }, { security: "faceid" })[key] : level;
  }
  /**
   * A new proposal in `conversationId` replaces those still open there, so "yes" can't land on a stale one: each is
   * cancelled as superseded, except a send waiting for Face ID (stage 2b: Face ID every time, a reply to one thread or a
   * new thread), which is kept in Drafts waiting for it, so its words aren't lost and its "Approve to send" still sends
   * it. `same`: the new one is its revision (only the message changed), which replaces it.
   */
  private supersede(conversationId: string, same: (p: Proposal) => boolean = () => false) {
    for (const old of this.d.store.openProposals(conversationId)) {
      if (this.faceid() && !same(old) && this.levelNow(old.action, old.fields.confirm ?? "readback") === "tap" && this.keepForFaceId(old)) continue;
      this.d.store.putProposal({ ...old, state: "cancelled", result: "superseded" });
    }
  }
  private preparing(conversationId: string): () => boolean {
    const stopped = this.stopped;
    const revision = (this.proposing.get(conversationId) ?? 0) + 1;
    this.proposing.set(conversationId, revision);
    return () => this.stopped === stopped && this.proposing.get(conversationId) === revision;
  }
  private async check(actions: Action[]): Promise<string | null> {
    for (const action of actions) {
      try {
        const reason = await this.d.adapter.check?.(action);
        if (reason) return reason;
      } catch { return "The app couldn't check whether that action is allowed right now. Please try again."; }
    }
    return null;
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * A change the user asked for, prepared to agree to as its `levels` say (`Level`): read back and asked about, or
   * (`none`) carried out at once, its result returned.
   */
  async propose(conversationId: string, input: ProposeInput, keepReplies: KeepReplies = "send", levels: ConfirmLevels = READBACK_ALL): Promise<ToolResult> {
    // A reply kept straight away isn't sent, so it needs no readback, and nothing is asked of the computer (it may be asleep).
    const keeping = keepReplies === "keep" && input.action === "follow_up";
    // A reply the user's settings ask about ("Send it now, or keep it for later?") is still asked about, whatever its
    // level: then their "send it now" is the yes. Its level is Privacy's now, so it's asked again after the check below.
    const levelOf = (): Level => {
      const asked = this.levelNow(input.action, levels[CONFIRM_KEY[input.action]] ?? "readback");
      return asked === "none" && keepReplies === "ask" && input.action === "follow_up" ? "yes" : asked;
    };
    let level = levelOf();
    const current = this.preparing(conversationId);
    const now = this.now();
    if (input.action !== "settle_subagents" && !this.d.adapter.actions.includes(input.action)) {
      return { error: `This system can't ${input.action.replace("_", " ")}.` };
    }
    // A send or a start when another thread finishes (4-J's chains): its own readback, and the yes hands it over.
    if ((input.action === "follow_up" || input.action === "start_work") && typeof input.after === "string" && input.after.trim()) {
      return this.proposeChain(conversationId, input, levelOf, current, now);
    }
    // A send or a start at a later time (stage 4b; §5): its own readback, and the yes hands it to the computer.
    if ((input.action === "follow_up" || input.action === "start_work") && typeof input.at === "string" && input.at.trim()) {
      return this.proposeLater(conversationId, input, levelOf, current, now);
    }
    const createdFrom = this.d.spoken(conversationId).length;
    let targets: Proposal["targets"] = [];
    let readback: string;
    const fields: Proposal["fields"] = {};
    // Entity groups (verb, names, date) may carry over from a superseded proposal; see below.
    const entities: Omit<Proposal["mustHear"][number], "from">[] = input.action === "settle_subagents" ? [{ words: ["settle"], need: 1 }] : [];
    let messageGroup: Proposal["mustHear"][number] | null = null;
    // Threads holding a command on their computer's list (Commands that wait), as named.
    const holding = new Map<string, WorkItem>();

    if (input.action === "settle_subagents") {
      const groups = this.d.clutter();
      const ids = groups.flatMap((g) => g.ids);
      if (ids.length === 0) return { error: "There are no finished subagent threads to settle." };
      targets = groups.flatMap((g) => g.ids.map((itemId) => ({ itemId, handle: "subagent", parentId: g.parentIds?.[itemId] ?? g.parentId })));
      readback = `Settle ${ids.length} finished subagent ${ids.length === 1 ? "thread" : "threads"} under ${groups.length} parent ${groups.length === 1 ? "thread" : "threads"}.`;
      entities.push({ words: ["subagent", "sub", "agent", "review", "finish"], need: 1 });
    } else if (input.action === "start_work") {
      const start = this.newThread({ project: input.project ?? "", conversationId, defaults: input.defaults }, input.profile ?? null, { said: input.model, fallback: input.defaults?.codingModel, fallbackProvider: input.defaults?.codingProvider });
      if ("error" in start) return start;
      const message = (input.message ?? "").trim();
      const bad = badMessage(message);
      if (bad) return { error: bad };
      // The model is kept as chosen now, so a retry under the same key sends the same one.
      Object.assign(fields, { placeId: start.place.id, place: start.place.name, profile: start.profile, ...(start.model ? { model: start.model } : {}), message });
      // Place, profile and model are heard word for word, up to "with this message"; the message as a follow-up's.
      readback = `${start.head}, with this message: "${message}"`;
      entities.push(...start.heard);
      const words = messageWords(message);
      messageGroup = { words, need: messageNeed(words.length), from: createdFrom, message };
    } else {
      if (input.handles.length === 0) return { error: "Which thread? Ask the user." };
      if (input.handles.length > MAX_TARGETS) return { error: `At most ${MAX_TARGETS} threads at once.` };
      const named = this.d.named();
      for (const h of input.handles) {
        const r = pick(h, named, this.d.settled?.() ?? [], this.d.store.aliasFor(conversationId, nameKey(h)));
        if (r.kind === "none") return { error: `No thread matches "${h}". Ask the user which one.` };
        if (r.kind === "settled") return { error: `${saidBefore(r.item)} is settled, so the app leaves it alone. Say so, and ask whether they meant another thread.` };
        if (r.kind === "ambiguous") return { error: `"${h}" could mean ${r.options.map((o, i, all) => withGroup(o.handle, o.group, i < all.length - 1)).join(" or ")}. Ask the user which one.` };
        const item = r.item as Named & { item: WorkItem };
        if (input.action === "settle" && item.item.status === "running") return { error: stillWorking(item) };
        if (item.item.gate && item.item.questionId) holding.set(item.id, item.item);
        this.d.store.alias(conversationId, nameKey(item.handle), item.id);
        if (!targets.some((t) => t.itemId === item.id)) targets.push({ itemId: item.id, handle: item.handle, group: item.group });
      }
      // Every name in a readback is heard word for word, as a clause of its own: "Archive Agent Reel." for one thread,
      // "Settle 2 threads: Agent Reel; Fix login." for several. Counting words can't tell "Agent Reel" from "Agent Reel
      // Dashboard", a swapped pair, or a thread renamed since; an exact name can. Dates and messages stay tolerant. Each
      // name is read back with its project ("Archive Agent Reel, in sd."), which may be left out when heard.
      const one = targets.length === 1;
      const verb = { follow_up: "Send", snooze: "Snooze", settle: "Settle", archive: "Archive" }[input.action];
      const listed = targets.map(said).join("; ");
      let next: string | null = null;
      if (input.action === "follow_up") {
        const message = (input.message ?? "").trim();
        const bad = badMessage(message);
        if (bad) return { error: bad };
        if (!one) return { error: "Follow up one thread at a time." };
        const held = holding.get(targets[0].itemId);
        // A thread holding a command (Commands that wait; Fable's 4-H3): never let run by voice, a no stops it at once, and
        // any other message says it stops it.
        if (held?.gate && held.questionId) {
          if (letsRun(message)) return this.notByVoice(conversationId, held);
          if (stopsIt(message)) return this.stopHeld(targets[0], held);
        }
        const repeat = this.sentAlready(conversationId, targets[0], message, now);
        if (repeat) return { error: repeat };
        fields.message = message;
        const words = messageWords(message);
        // Keep the 40% gist for interruptions, but preserve word order and every negation.
        messageGroup = { words, need: messageNeed(words.length), from: createdFrom, message };
        readback = `Send ${saidBefore(targets[0])} this message: "${message}"`;
        next = "this";
        if (held?.gate && held.questionId) {
          readback = stopsReadback(held.gate.matched, targets[0].handle, message);
          fields.held = { matched: held.gate.matched, questionId: held.questionId };
          // Its words are heard in full and in order: this readback has no "this message:" for the gist to start from.
          messageGroup = null;
          entities.push({ words: [], need: 0, sequence: speechTokens(norm(message)) });
        }
      } else if (input.action === "snooze") {
        // On the user's clock (stage 3.8): the phone's zone, else the thread's computer's, else the runtime's.
        const zone = phoneZoneIn(this.d.store) ?? validZone(this.d.adapter.timeZone?.(targets[0].itemId));
        const until = input.until ? parseUntil(input.until, now, zone) : null;
        if (!until) return { error: "Snooze until when? Give a future date (YYYY-MM-DD) or date-time within 90 days." };
        fields.until = until.toISOString();
        if (zone) fields.tz = zone;
        const sd = spokenDate(until, now, zone);
        entities.push({ words: sd.words, need: sd.words.length });
        entities.push({ words: [], need: 0, sequence: sd.timeWords });
        readback = one ? `Snooze ${saidBefore(targets[0])} until ${sd.text}.` : `Snooze ${targets.length} threads until ${sd.text}: ${listed}.`;
        next = "until";
      } else {
        readback = one ? `${verb} ${listed}.` : `${verb} ${targets.length} threads: ${listed}.`;
      }
      if (one && fields.held) {
        // "That stops terraform apply and tells API: …": heard by its own words, the thread's name among them.
        entities.push({ words: [], need: 0, sequence: speechTokens(norm("that stops")) }, { words: [], need: 0, sequence: speechTokens(norm(targets[0].handle)) });
      } else if (one) {
        entities.push({ words: [], need: 0, head: nameTokens(`${verb} ${targets[0].handle}`), named: 1, where: whereTokens(targets[0]), next });
      } else {
        entities.push({ words: [], need: 0, head: nameTokens(`${verb} ${targets.length} threads`), next: input.action === "snooze" ? "until" : null });
        for (const t of targets) entities.push({ words: [], need: 0, head: nameTokens(t.handle), named: 0, where: whereTokens(t), next: null });
      }
      const clash = lookalike(targets, verb, next, named, this.d.settled?.() ?? []);
      if (clash) return { error: tooAlike(clash) };
    }

    const actions: Action[] = input.action === "start_work"
      ? [{ kind: "start_work", placeId: fields.placeId!, message: fields.message!, profile: fields.profile!, ...(fields.model ? { model: fields.model.id } : {}) }]
      : targets.map((t) => toAction({ action: input.action, fields } as Proposal, t.itemId));
    const reason = keeping ? null : await this.check(actions);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    // Face ID every time chosen while the computer was asked: it waits for Send on the phone.
    level = levelOf();
    // Words to a thread holding a command stop it: always read back and heard in full, never sent at once, so the user
    // hears that their words stop it, and after the yes how it ended (Fable's 4-H3).
    if (fields.held && level !== "tap") level = "readback";
    const atOnce = !keeping && level === "none";
    fields.confirm = level;

    // A new proposal replaces any still open in this conversation, so "yes" can't land on a stale one.
    // If it changes nothing but the message, the names and verb already spoken still count (the voice
    // model often starts reading before a revision lands); the message itself never carries over.
    // One carried out at once asks for no yes, so a change still waiting for one stays open.
    let entitiesFrom = createdFrom;
    const sameEntities = (o: Proposal) =>
      o.action === input.action && o.fields.until === fields.until && o.fields.at === fields.at && o.fields.placeId === fields.placeId &&
      o.fields.profile?.name === fields.profile?.name && o.fields.model?.id === fields.model?.id &&
      JSON.stringify(o.targets.map((t) => t.itemId).sort()) === JSON.stringify(targets.map((t) => t.itemId).sort());
    if (!atOnce) {
      for (const old of this.d.store.openProposals(conversationId)) if (sameEntities(old)) entitiesFrom = Math.min(entitiesFrom, old.createdFrom);
      // Its revision replaces a send waiting for Face ID; anything else keeps it (`supersede`).
      this.supersede(conversationId, sameEntities);
    }
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: input.action,
      targets,
      fields,
      readback,
      mustHear: [...entities.map((g) => ({ ...g, from: entitiesFrom })), ...(messageGroup ? [messageGroup] : [])],
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      // Carried out at once: claimed now, so nothing else can confirm or cancel it meanwhile.
      state: atOnce ? "executing" : "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    if (keeping) {
      const kept = this.keep(conversationId, p.id);
      const words = fields.message!.split(/\s+/);
      const first = words.length <= 6 ? `${fields.message!.replace(/[\s.!?,;:]+$/, "")}.` : `${words.slice(0, 6).join(" ").replace(/[\s.!?,;:]+$/, "")}…`;
      return { kept: true, kept_id: kept.kept_id, result: `Kept your reply to ${targets[0].handle}, unsent: it's in Drafts on the phone.`, instruction: `Say only "Kept: ${first} It's in Drafts." (no readback: nothing was sent), then carry on with what they want next.` };
    }
    if (atOnce) {
      // The user's settings ask no yes for this: asking for it was enough.
      const r = await this.execute(p, false);
      // Unless Face ID every time was chosen while it was being prepared: then nothing went, and it waits for Send.
      if (this.d.store.proposal(p.id)?.state !== "proposed") {
        return "error" in r ? r : { ...r, proposal_id: p.id, instruction: "It's been carried out already, with no readback and no question: tell the user this result in a few words, adding nothing that isn't in it. Never call confirm for it." };
      }
      level = "tap";
    }
    // At Send on the phone, a line in place of the yes (`askForTap`).
    if (level === "tap") return this.askForTap(p);
    // Stopping a held command: the readback asks its own question ("Send it?").
    if (p.fields.held) {
      return { proposal_id: p.id, readback, instruction: "Say the readback word for word (it asks the question) and stop. Nothing has happened yet: the command is still waiting. Never offer to let it run." };
    }
    const ask = keepReplies === "ask" && input.action === "follow_up" ? "\"Send it now, or keep it for later?\"" : "\"Shall I go ahead?\"";
    return { proposal_id: p.id, readback, instruction: `Say the readback word for word, then ask ${ask} and stop. Nothing has happened yet.` };
  }

  /**
   * A send proposed at the tap level, read back: the line said after it in place of asking for a yes. At Face ID every
   * time (stage 2b; Fable's 2b topic 4) it's chosen here by where the phone is: on screen it asks by itself; at the ear,
   * take it away; in the car it's kept at once ("It's on your phone to approve when you can look."), nothing asked, and
   * "Approve to send" follows at the call's end; locked, "Approve to send" goes now. Below it, or with the place not known,
   * today's "Tap Send on your phone to go ahead".
   */
  private askForTap(p: Proposal): ToolResult {
    const keeps = keepable(p);
    const at = this.faceid() ? this.at() : null;
    if (at === "car") {
      const kept = this.keepForFaceId(p, true);
      if (kept) {
        return {
          kept: true, kept_id: kept.id, readback: p.readback, line: CAR_KEPT,
          instruction: `Say the readback word for word, then say "${CAR_KEPT}", word for word, and stop: don't ask for a yes. Nothing was sent: it's kept, waiting for their Face ID on the phone. Never call confirm for it.`,
        };
      }
    }
    // One that can't be kept in the car (a reply to several threads) gets today's line.
    const line = faceIdAsk(at === "car" ? null : at, { start: p.action === "start_work", keeps });
    if (at === "locked") this.approve(this.approvalOf(p));
    return {
      proposal_id: p.id, readback: p.readback, line,
      instruction: `Say the readback word for word, then say "${line}", word for word, and stop: don't ask for a yes. Nothing has happened yet: only their tap on Send carries it out, so never call confirm for it.${keeps ? " If they say keep it, call keep." : ""}`,
    };
  }

  /**
   * "Send it" for a reply or prompt kept waiting for Face ID asks again, with the line for where the phone is now (stage
   * 2b; Fable's 2b topic 6): only at Face ID every time, with the phone's place known. Otherwise it waits for Send in
   * Drafts, as before.
   */
  private asksAgain(): boolean {
    return this.faceid() && this.at() !== null;
  }

  /** "Approve to send"'s for proposal `p` (a reply to one thread, or a new thread). */
  private approvalOf(p: Proposal): Approval {
    const start = p.action === "start_work";
    return { id: p.id, start, name: start ? p.fields.place ?? null : p.targets[0]?.handle ?? null, message: p.fields.message ?? "", expiresAt: p.expiresAt, conversationId: p.conversationId };
  }

  /**
   * A spoken yes the user's settings carry out only with Send on the phone (`tapRefusal`). At Face ID every time (stage
   * 2b; Fable's 2b topic 5) its line is by where the phone is, said word for word; in the car the send is kept at once
   * ("That needs Face ID, so I've kept it…"). `line`: what's said.
   */
  private refusal(p: Proposal): ToolResult {
    // One set up for later is Schedule on the phone, never kept (Fable's 4-A).
    if (!this.faceid() || forLater(p)) return tapRefusal(p);
    const keeps = keepable(p);
    const at = this.at();
    const kept = at === "car" ? this.keepForFaceId(p, true) : null;
    const line = faceIdRefusal(kept ? "car" : at === "car" ? null : at, keeps, !!kept);
    return {
      error: kept
        ? `Nothing was sent: it's kept, waiting for their Face ID on the phone. Say exactly "${line}", word for word.`
        : `The user's settings carry this out only with a tap and Face ID on their phone: say exactly "${line}", word for word.${keeps ? " If they say keep it, call keep." : ""}`,
      refused: "tap Send on your phone",
      line,
      ...(kept ? { kept: true, kept_id: kept.id } : {}),
    };
  }

  /**
   * A send or a start set up for later (stage 4b; Fable's 4-A to 4-C): the time read on the phone's clock (else the
   * computer's), the threads or the place, then what would refuse it (the level, each computer), as a fixed line said
   * instead of a readback; else its readback, which always says the day and the half of the day and always waits for a
   * yes, heard in full (or, at Face ID every time, Schedule on the phone). Several threads are one rule, a schedule each.
   */
  private async proposeLater(conversationId: string, input: ProposeInput, levelOf: () => Level, current: () => boolean, now: number): Promise<ToolResult> {
    const later = this.d.later;
    const say = sayOnly;
    if (!later) return say(LATER_NO_COMPUTER);
    const createdFrom = this.d.spoken(conversationId).length;
    const message = (input.message ?? "").trim();
    const bad = badMessage(message);
    if (bad) return { error: bad };
    const targets: Proposal["targets"] = [];
    let start: { place: Place; profile: LaunchProfile; model: ChosenModel | null } | null = null;
    if (input.action === "start_work") {
      // The model as a start now picks it (thread-models.ts): the one named, else Settings', else the coding app's own.
      const found = this.newThread({ project: input.project ?? "", conversationId, defaults: input.defaults }, input.profile ?? null, { said: input.model, fallback: input.defaults?.codingModel, fallbackProvider: input.defaults?.codingProvider });
      if ("error" in found) return found;
      start = { place: found.place, profile: found.profile, model: found.model };
    } else {
      if (input.handles.length === 0) return { error: "Which thread? Ask the user." };
      if (input.handles.length > MAX_TARGETS) return { error: `At most ${MAX_TARGETS} threads at once.` };
      const named = this.d.named();
      for (const h of input.handles) {
        const r = pick(h, named, this.d.settled?.() ?? [], this.d.store.aliasFor(conversationId, nameKey(h)));
        if (r.kind === "none") return { error: `No thread matches "${h}". Ask the user which one.` };
        if (r.kind === "settled") return { error: `${saidBefore(r.item)} is settled, so the app leaves it alone. Say so, and ask whether they meant another thread.` };
        if (r.kind === "ambiguous") return { error: `"${h}" could mean ${r.options.map((o, i, all) => withGroup(o.handle, o.group, i < all.length - 1)).join(" or ")}. Ask the user which one.` };
        this.d.store.alias(conversationId, nameKey(r.item.handle), r.item.id);
        if (!targets.some((t) => t.itemId === r.item.id)) targets.push({ itemId: r.item.id, handle: r.item.handle, group: r.item.group });
      }
      const clash = lookalike(targets, "Schedule", null, named, this.d.settled?.() ?? []);
      if (clash) return { error: tooAlike(clash) };
    }
    const ids = start ? [start.place.id] : targets.map((t) => t.itemId);
    // On the user's clock (stage 3.8): the phone's zone, else the computer's.
    const zone = phoneZoneIn(this.d.store) ?? validZone(this.d.adapter.timeZone?.(ids[0]));
    // A day named too ("Friday at 8", "in 2 days"): the readback always says the day and the half of the day.
    const when = parseWhen(input.at!, zone, now, { days: true });
    if (when === "repeats") return say(NO_REPEATS);
    if (when === "zone") return say(NO_ZONE);
    // Today's time already past ("today at 5" at 17:40): what happened, not the same question again (Fable's nit on fix6).
    if (when === "passed") return say(TIME_PASSED);
    if (!when) return say({ day: DAY_AGAIN, midnight: MIDNIGHT_AGAIN, time: TIME_AGAIN, none: WHEN_AGAIN }[whyUnread(input.at!) ?? "none"]);
    if (when.at - now > AHEAD_MS) return say(TOO_FAR);
    const z = zone ?? "UTC";
    const actions: Action[] = start
      ? [{ kind: "start_work", placeId: start.place.id, message, profile: start.profile, ...(start.model ? { model: start.model.id } : {}) }]
      : targets.map((t) => ({ kind: "follow_up" as const, itemId: t.itemId, message }));
    const no = later.refusal({ actions, ids });
    if (no) return "error" in no ? { error: no.error } : say(no.line, no.asked);
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    // Privacy's level now; never carried out at once, and heard in full unless only a tap will do (Fable's 4-A).
    const level: Level = levelOf() === "tap" ? "tap" : "readback";
    const computers = later.computers();
    const link = later.linkOf(ids[0]);
    const machine = link?.machine ?? "your computer";
    const spoken = spokenClock(when.at, z, now);
    const seq = (text: string) => ({ words: [], need: 0, sequence: speechTokens(norm(text)) });
    let readback: string;
    let heardGroups: MustHear[];
    let card;
    if (start) {
      const project = start.place.name.replace(/, on [\w-]+$/, "");
      const computer = computers > 1 ? machine : null;
      readback = startReadback(project, computer, start.profile.runtimeMode, spoken, message, start.model ? withProvider(start.model) : null);
      // The model is heard only when the user named it, as a start now hears it (startHeard).
      heardGroups = [seq("schedule a new thread in"), seq(project), ...(computer ? [seq(computer)] : []), seq(ACCESS_SHOWN[start.profile.runtimeMode]), ...(start.model?.said ? [seq(withProvider(start.model))] : []), seq(spoken), seq(message)];
      card = laterCard({ start: true, to: project, words: message, machine, computers, at: when.at, until: when.at + 2 * 3600_000, zone: z, now, machineZone: validZone(this.d.adapter.timeZone?.(ids[0])), mode: start.profile.runtimeMode, project });
    } else {
      // The target as today's readback names it, with its project where that adds it, never its computer (Fable's 4-A).
      const to = targets.length === 1 ? saidBefore({ handle: targets[0].handle, group: targets[0].group?.replace(/, on [\w-]+$/, "") }) : (threadsNamed(targets.map((t) => t.handle)) ?? `the ${targets.length} threads`);
      readback = sendReadback(message, to, spoken);
      const names = targets.length > 3 ? [seq(`${targets.length} threads`)] : targets.map((t) => seq(t.handle));
      heardGroups = [seq("schedule"), seq(message), ...names, seq(spoken)];
      const shownTo = targets.length === 1 ? (targets[0].group ? `${targets[0].handle} · ${targets[0].group.replace(/, on [\w-]+$/, "")}` : targets[0].handle) : targets.map((t) => t.handle).join(", ");
      card = laterCard({ start: false, to: shownTo, words: message, machine, computers, at: when.at, until: when.at + 2 * 3600_000, zone: z, now, machineZone: validZone(this.d.adapter.timeZone?.(ids[0])), threads: threadsNamed(targets.map((t) => t.handle)) ?? `${targets.length} threads` });
    }
    const fields: Proposal["fields"] = {
      message, at: when.at, tz: z, confirm: level, card,
      ...(start ? { placeId: start.place.id, place: start.place.name, profile: start.profile, ...(start.model ? { model: start.model } : {}) } : {}),
    };
    this.supersede(conversationId);
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: input.action, targets, fields, readback,
      mustHear: heardGroups.map((g) => ({ ...g, from: createdFrom })), createdFrom, expiresAt: now + EXPIRY_MS, state: "proposed", createdAt: now, result: null,
    };
    this.d.store.putProposal(p);
    // In the car, untapped, nothing is kept to approve later: the driver hears so (2b's "Approve to schedule" isn't built).
    const tap = this.whereOf() === "car" ? TAP_SCHEDULE_CAR : TAP_SCHEDULE;
    // "…and call me when it replies" on a send at a time (Fable's nit on 4-J): no call-back comes with it, so none is promised.
    const noTail = input.tail ? " No call-back comes with a send at a time: never say you'll call or tell them when it replies." : "";
    return {
      proposal_id: p.id,
      readback,
      instruction: (level === "tap"
        ? `Say the readback word for word, then say "${tap}" and stop. Nothing is set up yet: only their tap on Schedule on their phone sets it up, so never call confirm for it.`
        : `Say the readback word for word (it asks the question) and stop. Nothing is set up yet. If they clearly say yes, call confirm; if they say no, call cancel and say only "${NOTHING_SET_UP}", word for word.`) + noTail,
    };
  }

  /**
   * A chain (4-J; Fable's decisions binding for words): "when Schema's done, tell API to rebase, and call me when that's
   * done". The thread it waits for, then each step (a send to one thread, each after the first sent when the thread before
   * it finishes; or a new thread, only on its own), then what would refuse it (the level's steps and its sends, each
   * computer), as a fixed line said instead of a readback; the thread it waits for asking now sets nothing up. Else its
   * readback, which always waits for a yes, heard in full (or, at Face ID every time, Schedule on the phone).
   */
  private async proposeChain(conversationId: string, input: ProposeInput, levelOf: () => Level, current: () => boolean, now: number): Promise<ToolResult> {
    const later = this.d.later;
    const say = sayOnly;
    if (!later) return say(LATER_NO_COMPUTER);
    const createdFrom = this.d.spoken(conversationId).length;
    const message = (input.message ?? "").trim();
    const bad = badMessage(message);
    if (bad) return { error: bad };
    const named = this.d.named();
    const settled = this.d.settled?.() ?? [];
    const find = (h: string): (Named & { item: WorkItem }) | { error: string } => {
      const r = pick(h, named, settled, this.d.store.aliasFor(conversationId, nameKey(h)));
      if (r.kind === "none") return { error: `No thread matches "${h}". Ask the user which one.` };
      if (r.kind === "settled") return { error: `${saidBefore(r.item)} is settled, so the app leaves it alone. Say so, and ask whether they meant another thread.` };
      if (r.kind === "ambiguous") return { error: `"${h}" could mean ${r.options.map((o, i, all) => withGroup(o.handle, o.group, i < all.length - 1)).join(" or ")}. Ask the user which one.` };
      this.d.store.alias(conversationId, nameKey(r.item.handle), r.item.id);
      return r.item as Named & { item: WorkItem };
    };
    const a = find(input.after!);
    if ("error" in a) return a;
    const steps: { itemId: string; handle: string; group?: string; message: string }[] = [];
    let start: { place: Place; profile: LaunchProfile; model: ChosenModel | null } | null = null;
    if (input.action === "start_work") {
      if (input.then?.length) return { error: "A new thread can only be the last step of a chain, and on its own: set up the steps before it first, or ask the user which they want." };
      // The model as a start now picks it (thread-models.ts): the one named, else Settings', else the coding app's own.
      const found = this.newThread({ project: input.project ?? "", conversationId, defaults: input.defaults }, input.profile ?? null, { said: input.model, fallback: input.defaults?.codingModel, fallbackProvider: input.defaults?.codingProvider });
      if ("error" in found) return found;
      start = { place: found.place, profile: found.profile, model: found.model };
    } else {
      if (input.handles.length !== 1) return { error: "Each step of a chain goes to one thread. Ask the user which one." };
      const b = find(input.handles[0]);
      if ("error" in b) return b;
      steps.push({ itemId: b.id, handle: b.handle, group: b.group, message });
    }
    for (const s of input.then ?? []) {
      const words = (s.message ?? "").trim();
      const no = badMessage(words);
      if (no) return { error: no };
      const t = find(s.handle);
      if ("error" in t) return t;
      steps.push({ itemId: t.id, handle: t.handle, group: t.group, message: words });
    }
    const clash = lookalike([a, ...steps].map((s) => ({ itemId: "itemId" in s ? s.itemId : s.id, handle: s.handle, group: s.group })), "Schedule", null, named, settled);
    if (clash) return { error: tooAlike(clash) };
    const ids = start ? [start.place.id] : steps.map((s) => s.itemId);
    const actions: Action[] = start
      ? [{ kind: "start_work", placeId: start.place.id, message, profile: start.profile, ...(start.model ? { model: start.model.id } : {}) }]
      : steps.map((s) => ({ kind: "follow_up" as const, itemId: s.itemId, message: s.message }));
    const no = later.refusal({ actions, ids, steps: actions.length });
    if (no) return "error" in no ? { error: no.error } : say(no.line, no.asked);
    // The thread it waits for as it is now (its run, past which a clean finish is the trigger). Asking now, it can't
    // finish without an answer; not at work now (finished earlier, failed, stopped or never run), there's no finish to
    // wait for (Fable's review of 4-J): nothing is set up either way. Sent a follow-up just now, it's at work, though its
    // computer's view may not say so yet (the skeptic's review of 4-J).
    const listed = await this.d.adapter.list().catch(() => [] as WorkItem[]);
    const live = listed.find((i) => i.id === a.id) ?? a.item;
    const fresh = !!this.justSent(live, now);
    if (live.pendingQuestion && !fresh) return say(chainNotSetUp(a.handle, "asked"));
    if (!runningNow(live, listed, now) && !fresh) {
      if (live.status === "failed") return say(chainNotSetUp(a.handle, "failed"));
      if (live.status === "cancelled") return say(chainNotSetUp(a.handle, "stopped"));
      return notRunning(a.handle);
    }
    const limits = this.d.limits?.() ?? LIMITS["Long Haul"];
    const watchMs = limits.watchHours * 3600_000;
    // A time it mustn't go before (4-J), on the user's clock: within the watch, else nothing is set up.
    const zone = phoneZoneIn(this.d.store) ?? validZone(this.d.adapter.timeZone?.(ids[0]));
    const z = zone ?? "UTC";
    let notBefore: number | undefined;
    if (typeof input.at === "string" && input.at.trim()) {
      const when = parseWhen(input.at, zone, now);
      if (when === "repeats") return say(NO_REPEATS);
      if (when === "zone") return say(NO_ZONE);
      if (!when) return { error: "Nothing is set up: that time couldn't be read. Ask the user when, as a time of day (\"not before 6\")." };
      // Today's time already past ("but not before 5" at 17:40, parseWhen's "passed"): nothing to wait for.
      if (when !== "passed" && when.at > now) {
        if (when.at - now > AHEAD_MS) return say(TOO_FAR);
        if (when.at >= now + watchMs) return say(chainEndsBefore(watchMs, spokenClock(when.at, z, now), limits.level, limits.named));
        notBefore = when.at;
      }
    }
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    const level: Level = levelOf() === "tap" ? "tap" : "readback";
    const tail = input.tail ?? null;
    const computers = later.computers();
    const machine = later.linkOf(ids[0])?.machine ?? "your computer";
    const seq = (text: string) => ({ words: [], need: 0, sequence: speechTokens(norm(text)) });
    const spokenNb = notBefore !== undefined ? spokenClock(notBefore, z, now) : null;
    let chain: ChainStep[];
    const heardGroups: MustHear[] = [seq(a.handle)];
    let card;
    if (start) {
      const project = start.place.name.replace(/, on [\w-]+$/, "");
      const computer = computers > 1 ? machine : null;
      // Its model as a start set up for later says it, heard only when the user named it.
      const model = start.model ? withProvider(start.model) : null;
      chain = [{ after: a.handle, start: { project, computer, mode: start.profile.runtimeMode, prompt: message, model } }];
      heardGroups.push(seq(project), ...(computer ? [seq(computer)] : []), seq(ACCESS_SHOWN[start.profile.runtimeMode]), ...(start.model?.said ? [seq(model!)] : []), seq(message));
      card = chainCard({
        after: a.handle, to: null, words: message, machine, computers, watchMs, notBefore: notBefore !== undefined ? shownClock(notBefore, z, now) : null, then: [],
        tail: tail ? tailShown(tail, "the new thread") : null, reason: `Schedule a new thread in ${project}`, start: { project, mode: start.profile.runtimeMode },
      });
    } else {
      chain = steps.map((s, i) => ({ after: i === 0 ? a.handle : steps[i - 1].handle, to: s.handle, words: s.message }));
      heardGroups.push(...steps.flatMap((s) => [seq(s.handle), seq(s.message)]));
      const first = steps[0];
      card = chainCard({
        after: a.handle, to: first.group ? `${first.handle} · ${first.group.replace(/, on [\w-]+$/, "")}` : first.handle, words: message, machine, computers, watchMs,
        notBefore: notBefore !== undefined ? shownClock(notBefore, z, now) : null, then: steps.slice(1).map((s, i) => ({ to: s.handle, after: steps[i].handle, words: s.message })),
        tail: tail ? tailShown(tail, steps.at(-1)!.handle) : null, reason: `Schedule “${clip(message, 60)}” for ${first.handle}`,
      });
    }
    if (spokenNb) heardGroups.push(seq(spokenNb));
    const readback = chainReadback(chain, { tail, notBefore: spokenNb, watchMs, level: limits.level, named: limits.named });
    const fields: Proposal["fields"] = {
      message, tz: z, confirm: level, card,
      chain: { after: { itemId: a.id, handle: a.handle, lastRunAt: live.lastRunAt ?? null }, ...(notBefore !== undefined ? { notBefore } : {}), next: steps.slice(1), tail, watchMs },
      ...(start ? { placeId: start.place.id, place: start.place.name, profile: start.profile, ...(start.model ? { model: start.model } : {}) } : {}),
    };
    this.supersede(conversationId);
    const targets: Proposal["targets"] = start ? [] : [{ itemId: steps[0].itemId, handle: steps[0].handle, group: steps[0].group }];
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: input.action, targets, fields, readback,
      mustHear: heardGroups.map((g) => ({ ...g, from: createdFrom })), createdFrom, expiresAt: now + EXPIRY_MS, state: "proposed", createdAt: now, result: null,
    };
    this.d.store.putProposal(p);
    const tap = this.whereOf() === "car" ? TAP_SCHEDULE_CAR : TAP_SCHEDULE;
    return {
      proposal_id: p.id,
      readback,
      instruction: level === "tap"
        ? `Say the readback word for word, then say "${tap}" and stop. Nothing is set up yet: only their tap on Schedule on their phone sets it up, so never call confirm for it.`
        : `Say the readback word for word (it asks the question) and stop. Nothing is set up yet. If they clearly say yes, call confirm; if they say no, call cancel and say only "${NOTHING_SET_UP}", word for word.`,
    };
  }

  /**
   * The readback in this conversation still waiting for its answer (the newest: a new proposal supersedes the rest), or
   * null. Not once it has expired: it can't be carried out then, so a stop that names nothing isn't its no (Fable's
   * should on the fourth review of 4-E).
   */
  answering(conversationId: string): Proposal | null {
    const p = this.d.store.openProposals(conversationId).at(-1);
    return p && this.now() <= p.expiresAt ? p : null;
  }

  /**
   * Asked in a call what's set up for later, or to stop one (the `later` tool): fixed lines, never the model's own words.
   * What's still to go, one sentence each as "what are you watching for me?" says it (Fable's 4-D); a stop at once, never
   * read back, never a yes (Fable's 4-E, `Later.stopSaid`), `stopped` when one was stopped now (the claim check's).
   * `only`: "stop that" straight after a line about these rules (`Later.stopSaid`, with `readback` and `refused`); null
   * when the stop is the turn's own no, or it named none to stop and others wait, so it only cut the voice off. A line
   * that names one waiting (`That one isn't waiting. …`) is about it (`waiting`, `only`), as the session reads it.
   */
  async laterSaid(stop: boolean, ask: Parameters<Later["stopSaid"]>[0] = { thread: null, at: null }): Promise<ToolResult | null> {
    const later = this.d.later;
    if (stop) {
      const r: StopSaid | null = later ? await later.stopSaid(ask) : { line: NOTHING_WAITING, stopped: false };
      if (!r) return null;
      return {
        result: r.line, ...(r.stopped ? { stopped: true } : {}), ...(r.only ? { waiting: true, only: r.only } : {}),
        instruction: `Say only "${r.line}", word for word, then carry on with the call.${r.stopped ? "" : " Nothing was stopped: never say it was."}${r.line.endsWith("?") ? " Once they answer, call later again with stop true and what they named." : ""}`,
      };
    }
    const said = later?.said() ?? [];
    const line = said.length ? watchingAnswer(said, false) : NOTHING_WAITING;
    // `waiting`: it names one still to go, so "stop that" after it is about them (Fable's nit on the third review of 4-E).
    return { result: line, ...(later?.anyWaiting() ? { waiting: true } : {}), instruction: `Say only this, every sentence of it, word for word, then carry on with the call: "${line}"` };
  }

  /**
   * A readback's no that named one in words a stop can't read (the `later` tool; Fable's should on the fifth review of
   * 4-E): nothing is stopped, and what's still waiting is said with "Nothing's set up." (`Later.notSetUp`). `waiting`
   * and `only` make it a line about sends for later, as the session reads it: the one it names, or any.
   */
  notSetUpSaid(): ToolResult {
    const r = this.d.later?.notSetUp() ?? { line: NOTHING_SET_UP, only: null, waiting: false };
    return {
      result: r.line, ...(r.waiting ? { waiting: true } : {}), ...(r.only ? { only: r.only } : {}),
      instruction: `Say only "${r.line}", word for word, then carry on with the call. Nothing was stopped: never say it was.`,
    };
  }

  /**
   * The yes to a send or a start for later (stage 4b; §5's flow): nothing goes to the agent now. A start is titled now
   * (the title its thread shows before it exists is the one made at the yes); then the rule is written, the proposal
   * closed as scheduled, the schedules handed to their computers, and what's said after the yes is their answer's, word
   * for word. A time passed by the yes sets nothing up.
   */
  private async schedule(p: Proposal, by: "voice" | "tap"): Promise<ToolResult> {
    const later = this.d.later!;
    const now = this.now();
    const f = p.fields;
    const ch = f.chain;
    if (!ch && f.at! <= now) {
      this.d.store.putProposal({ ...p, state: "cancelled", result: TIME_PASSED });
      return { error: `Nothing is set up. Say only "${TIME_PASSED}", word for word.`, refused: TIME_PASSED };
    }
    const message = f.message ?? "";
    let title = f.title ?? null;
    // A start is titled first (a model call, seconds), so the thread a chain waits for is judged as it is after that.
    if (p.action === "start_work" && !title && this.d.title) title = await this.d.title(message, f.place!).catch(() => null);
    // A chain (4-J): the thread it waits for as it is at the yes. Stopped to ask, failed, stopped or gone since the
    // readback, or no longer at work with no run since (Fable's review of 4-J): nothing is set up. Finished cleanly since:
    // it's set up, and goes now. Missing while its computer's view isn't loaded, its reply unreadable, or sent a follow-up
    // just now whose run its view doesn't show yet (`justSent`, kept on the rule for a judge here): as at work.
    let finished = false;
    let sent: JustSent | null = null;
    if (ch) {
      const items = await this.d.adapter.list().catch(() => [] as WorkItem[]);
      const a = items.find((i) => i.id === ch.after.itemId);
      const at = this.now();
      sent = a ? this.justSent(a, at) : null;
      const judged = await finishedSince(a, ch.after.lastRunAt, items, at, (id) => this.d.adapter.report(id), listedOn(this.d.adapter, ch.after.itemId));
      const v = sent && judged !== "met" ? "working" : judged;
      const idle = v === "working" && !sent && !!a && !runningNow(a, items, at) && !ranSince(a, ch.after.lastRunAt);
      if ((v !== "met" && v !== "working" && v !== "unread") || idle) {
        const line = idle ? chainNotRunning(ch.after.handle) : chainNotSetUp(ch.after.handle, v as Exclude<typeof v, "met" | "working" | "unread" | "unseen">);
        this.d.store.putProposal({ ...p, state: "cancelled", result: line });
        return { error: `Nothing is set up. Say only "${line}", word for word.`, refused: line };
      }
      finished = v === "met";
    }
    const via = by === "tap" ? (this.faceid() ? "faceid" : "tap") : "voice";
    const when = ch ? ` when ${ch.after.handle} finishes` : "";
    const said = p.action === "start_work" ? `Start a thread in ${f.place!.replace(/, on [\w-]+$/, "")}${when}: “${message}”` : `Send “${message}” to ${p.targets.map((t) => t.handle).join(", ")}${when}`;
    const made = await later.make({
      proposalId: p.id, conversationId: p.conversationId, via, at: f.at ?? now, zone: f.tz ?? "UTC", said,
      ...(p.action === "start_work" ? { start: { placeId: f.placeId!, place: f.place!, title, message, profile: f.profile!, ...(f.model ? { model: f.model } : {}) } } : { send: { message, targets: p.targets } }),
      ...(ch ? { chain: { ...ch, finished, ...(sent ? { sent } : {}) } } : {}),
    }, () => this.d.store.putProposal({ ...p, state: "scheduled", result: "Scheduled.", fields: { ...f, ...(title ? { title } : {}) } }));
    if ("refused" in made) {
      this.d.store.putProposal({ ...p, state: "cancelled", result: made.refused });
      return { error: `Nothing is set up. Say only "${made.refused}", word for word.`, refused: made.refused };
    }
    // The thread a chain waits for finished during its readback (4-J): `make` says when it goes, by how its computer took it.
    const line = made.line;
    const fresh = this.d.store.proposal(p.id);
    if (fresh) this.d.store.putProposal({ ...fresh, result: line });
    this.d.log?.(`proposal ${p.id} ${p.action} → scheduled (${made.rule.id})`);
    const until = ch ? "the app tells them when it goes" : "nothing goes until its time";
    return { done: true, scheduled: true, result: line, instruction: `Say only "${line}", word for word, then carry on with the call. Never say it was sent or done: ${until}.` };
  }

  /**
   * Where a new thread starts, with which profile and on which model, from the user's words (`project`) or, for a
   * dictated start, the place it was dictated for (`placeId`). `head` is the readback up to its message, all heard word
   * for word. The thread is titled as it starts (`start`), after the yes. `defaults` (Settings → New threads) fill in
   * what the user didn't say: the project when they named none, and the machine and coding app of a project in several
   * (`preferred`). The model (`modelOf`): the one they named (`ask.said`), else Settings' (`ask.fallback`), else none.
   */
  newThread(where: { project: string; conversationId?: string; defaults?: NewThreadDefaults } | { placeId: string }, asked: string | null, ask: ModelAsk = {}): { place: Place; profile: LaunchProfile; model: ChosenModel | null; head: string; heard: MustHear[] } | { error: string } {
    const profiles = this.d.profiles ?? [];
    let profile = this.profileOf(asked);
    // "As usual" names no model: Settings' where the place has it, else the coding app's own.
    let said = isUsual(ask.said) ? null : ask.said?.trim() || null;
    const given = this.d.places?.() ?? [];
    const places = spokenPlaces(given);
    let place: Place;
    if ("project" in where) {
      // The user's latest words may settle a project on two machines that the backend passed on without its machine.
      const words = where.conversationId ? this.d.lastUserTurn(where.conversationId).text : "";
      const found = this.pickWithDefaults(where.project, given, words, null, where.defaults);
      // A model passed as the profile is settled once the place is: until then, the place is what's asked.
      if ("error" in found) return "error" in profile && !this.asModel(asked, said, given.map((p) => p.models ?? [])) ? profile : found;
      place = found.place;
    } else {
      const found = places.find((p) => p.id === where.placeId);
      if (!found) return "error" in profile ? profile : { error: "That project isn't reachable now (its machine may be asleep), or it's gone from T3, so nothing was started. The prompt is still on the phone." };
      place = found;
    }
    if ("error" in profile) {
      // A model anywhere: the place's own answer for it (it may not have it); none anywhere, it's a profile asked for.
      const model = this.asModel(asked, said, given.map((p) => p.models ?? []));
      if (!model || !profiles[0]) return profile;
      [profile, said] = [profiles[0], model];
    }
    // Two places said alike ("agent-hearth" and "agent hearth" on one machine) can't be told apart by any readback.
    const twin = places.find((o) => o.id !== place.id && sayKey(o.name) === sayKey(place.name));
    if (twin) return { error: tooAlike({ target: place.name, other: twin.name }) };
    const chosen = this.modelOf(place, said, ask.fallback ?? null, ask.fallbackProvider ?? null);
    if ("error" in chosen) return chosen;
    const { model } = chosen;
    return {
      place, profile, model,
      head: `Start a new thread in ${place.name}, with the ${profile.name} profile${model ? `, using ${withProvider(model)}` : ""}`,
      heard: startHeard(place, places, profile, profile === profiles[0], model),
    };
  }

  /**
   * The model a new thread in `place` starts on: the one the user named (`said`), matched with the place's models
   * (thread-models.ts), else Settings' default (`fallback`, on `fallbackProvider` where the place has it) where the place
   * offers a model of that name, else none: its coding app's own, as before, and nothing said about it. A model named
   * where none can be chosen (an older connector, or a coding app that offers no choice) is for the user to settle:
   * start it as usual, or not. Its provider is said where the place has its name on several, or the user named it.
   */
  modelOf(place: Place, said: string | null, fallback: string | null = null, fallbackProvider: string | null = null): { model: ChosenModel | null } | { error: string } {
    if (!said?.trim()) {
      const d = defaultModel(fallback, fallbackProvider, place.models);
      return { model: d && { id: d.id, name: d.name, said: false, ...saidProvider(d, place.models!, false) } };
    }
    const { machine, app } = placeParts(place);
    if (!place.models) {
      return { error: `A new thread in ${place.name} can't start on a chosen model until 10 & 2 on ${machine ?? "that computer"} is updated. Ask the user whether to start it as usual, on ${APPS[app]}'s own model.` };
    }
    if (!place.models.length) {
      return { error: `A new thread in ${place.name} starts on ${APPS[app]}'s own model: 10 & 2 can't choose one there. Ask the user whether to start it as usual.` };
    }
    const m = matchModel(said, place.models);
    if (m.kind === "several") return { error: `"${said.trim()}" could mean ${sayNames(m.names)}. Ask the user which, in those words, and pass the one they pick as it's written here.` };
    if (m.kind === "none") return { error: `${place.name} has no model called "${said.trim()}"; it can start on ${sayNames(m.names)}. Ask the user which.` };
    // Named without a provider, the model Settings has on one: on that one (Settings' "Opus on Claude Proxy", and "Opus").
    const d = m.viaProvider ? null : defaultModel(fallback, fallbackProvider, place.models);
    const pick = d && sameName(d.name, m.model.name) ? d : m.model;
    return { model: { id: pick.id, name: pick.name, said: true, ...(m.viaProvider ? { named: true } : {}), ...saidProvider(pick, place.models, m.viaProvider) } };
  }

  /**
   * A launch profile asked for that isn't one but is a model's name in `models` (a place's lists), as the model: on 20
   * November the backend passed a model as the profile and the user heard "there's no such profile". Null otherwise, or
   * when a model was named as well.
   */
  asModel(asked: string | null, said: string | null, models: CodingModel[][]): string | null {
    const name = asked?.trim().replace(/\s+profile$/i, "");
    return !said?.trim() && name && models.some((m) => m.length && matchModel(name, m).kind !== "none") ? name : null;
  }

  /**
   * `pickPlace` with the user's defaults: the default project when they named none, and of a project's places only those
   * on the default machine and in the default coding app (`preferred`), unless their words (`said`, and the project as
   * passed on) name another. The place comes back as `spokenPlaces` says it among all of them ("nix (Claude Code), on
   * Lattice"), so the readback says which one was picked.
   */
  private pickWithDefaults(project: string, given: Place[], said: string, placeId: string | null, defaults: NewThreadDefaults = NO_DEFAULTS): { place: Place } | { error: string } {
    const words = project.trim() || defaults.project || "";
    const found = pickPlace(words, spokenPlaces(preferred(given, defaults, `${project} ${said}`, placeId)), { said, placeId });
    if ("error" in found) return found;
    return { place: spokenPlaces(given).find((p) => p.id === found.place.id) ?? found.place };
  }

  /** The launch profile the user asked for by name, or with none, the default. */
  profileOf(asked: string | null): LaunchProfile | { error: string } {
    const profiles = this.d.profiles ?? [];
    const named = asked?.trim().replace(/\s+profile$/i, "");
    const profile = named ? profiles.find((p) => nameKey(p.name) === nameKey(named)) : profiles[0];
    return profile ?? { error: profiles.length ? `There's no ${named} profile; there are ${list(profiles.map((p) => p.name))}. Ask the user which.` : "The app has no launch profiles set up." };
  }

  /** Whether a dictated draft may be proposed: not if it's been sent or is being sent; its own lost proposal again, here. */
  private draftAgain(conversationId: string, draftId: string, now: number, what = "reply"): { proposal: Proposal } | { error: string } | null {
    const earlier = this.d.store.draftProposals(draftId);
    if (earlier.some((p) => p.state === "executed" || p.state === "partial")) return { error: `That ${what} has already been sent.` };
    if (earlier.some((p) => p.state === "executing")) return { error: `That ${what} is being sent right now.` };
    const lost = earlier.find((p) => p.state === "unknown");
    if (lost) {
      if (lost.conversationId === conversationId && now <= lost.createdAt + RETRY_MS) return { proposal: lost };
      return { error: `That ${what} may already have gone through. Check T3 before sending it again.` };
    }
    return null;
  }

  /**
   * A new thread's opening prompt, dictated on the phone (and kept for later as `keptId`, if it is): a start to agree to,
   * read back as one said aloud is, with "your dictated prompt" in place of the message. Sent once, like a dictated
   * reply. `profile`: a launch profile's name, or null for the default; `model`: what the user said for its model, and
   * Settings' default (`newThread`).
   */
  async proposeDraftStart(conversationId: string, d: { draftId: string | null; placeId: string; profile: string | null; model?: ModelAsk; message: string; words: number; parts: number; keptId?: string }, level: Level = "readback"): Promise<{ proposal: Proposal } | { error: string }> {
    const current = this.preparing(conversationId);
    const now = this.now();
    if (!this.d.adapter.actions.includes("start_work")) return { error: "This system can't start work." };
    if (d.message.length > DRAFT_MAX + 2000) return { error: "That prompt is too long to send." };
    const again = d.draftId ? this.draftAgain(conversationId, d.draftId, now, "prompt") : null;
    if (again) return again;
    const start = this.newThread({ placeId: d.placeId }, d.profile, d.model);
    if ("error" in start) return start;
    const reason = await this.check([{ kind: "start_work", placeId: start.place.id, message: d.message, profile: start.profile, ...(start.model ? { model: start.model.id } : {}) }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    this.supersede(conversationId);
    const createdFrom = this.d.spoken(conversationId).length;
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: "start_work",
      targets: [],
      fields: {
        placeId: start.place.id, place: start.place.name, profile: start.profile, ...(start.model ? { model: start.model } : {}), message: d.message, confirm: draftLevel(level),
        ...(d.draftId ? { draftId: d.draftId } : {}), ...(d.keptId ? { keptId: d.keptId } : {}),
      },
      readback: `${start.head}, with your dictated prompt, ${size(d.words, d.parts)}.`,
      // "…, with your dictated prompt": the head (with its profile and model) is followed by "with your", not "with this".
      mustHear: start.heard.map((g) => ({ ...g, from: createdFrom, ...(Array.isArray(g.next) ? { next: ["with", "your"] } : {}) })),
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      state: "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    return { proposal: p };
  }

  /**
   * A reply the user dictated on the phone, already heard back there in full, made into a follow-up to agree to. Its
   * words are the user's own, so only the verb and the name are read back and heard ("Send Agent Reel your dictated
   * reply, …"), as for any follow-up; the message itself was heard on the phone. One already sent, or whose outcome
   * was lost in another conversation, isn't proposed again; one lost in this conversation is that proposal again, so a
   * yes retries it with the same keys.
   */
  async proposeDraft(conversationId: string, d: { draftId: string; itemId: string; message: string; words: number; parts: number }, level: Level = "readback"): Promise<{ proposal: Proposal } | { error: string }> {
    const current = this.preparing(conversationId);
    const now = this.now();
    if (!this.d.adapter.actions.includes("follow_up")) return { error: "This system can't take follow-ups." };
    if (d.message.length > DRAFT_MAX + 2000) return { error: "That reply is too long to send." };
    const again = this.draftAgain(conversationId, d.draftId, now);
    if (again) return again;
    const target = this.d.named().find((n) => n.id === d.itemId);
    if (!target) return { error: "That thread is settled or gone, so the reply wasn't sent. It's still on your phone." };
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const clash = lookalike(targets, "Send", "your", this.d.named(), this.d.settled?.() ?? []);
    if (clash) return { error: tooAlike(clash) };
    const reason = await this.check([{ kind: "follow_up", itemId: target.id, message: d.message }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That proposal was stopped or replaced; nothing was proposed." };
    this.supersede(conversationId);
    const createdFrom = this.d.spoken(conversationId).length;
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`,
      conversationId,
      action: "follow_up",
      targets,
      fields: { message: d.message, draftId: d.draftId, confirm: draftLevel(level) },
      readback: `Send ${saidBefore(targets[0])} your dictated reply, ${size(d.words, d.parts)}.`,
      mustHear: [{ words: [], need: 0, from: createdFrom, head: nameTokens(`Send ${target.handle}`), named: 1, where: whereTokens(targets[0]), next: "your" }],
      createdFrom,
      expiresAt: now + EXPIRY_MS,
      state: "proposed",
      createdAt: now,
      result: null,
    };
    this.d.store.putProposal(p);
    return { proposal: p };
  }

  /**
   * A dictated reply kept for later as the call opens (the phone's setting `keepReplies: "keep"`), rather than proposed:
   * nothing is sent, and nothing is asked of the computer (it may be asleep: that's what later is for). Kept as a
   * proposal closed as kept, for the call's receipt, and as the kept reply the phone lists. Not if it's been sent, or may
   * have been.
   */
  keepDraft(conversationId: string, d: { draftId: string; itemId: string; message: string; words: number; parts: number }): { proposal: Proposal } | { error: string } {
    const now = this.now();
    const was = draftState(this.d.store.draftProposals(d.draftId)).state;
    if (was === "sent") return { error: "That reply has already been sent." };
    if (was === "unknown") return { error: "That reply may already have gone through. Check T3 before sending it again." };
    const target = this.d.named().find((n) => n.id === d.itemId);
    if (!target) return { error: "That thread is settled or gone, so the reply wasn't kept. It's still on your phone." };
    this.supersede(conversationId);
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const p: Proposal = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: "follow_up", targets, fields: { message: d.message, draftId: d.draftId },
      readback: `Send ${saidBefore(targets[0])} your dictated reply, ${size(d.words, d.parts)}.`, mustHear: [], createdFrom: this.d.spoken(conversationId).length,
      expiresAt: now + EXPIRY_MS, state: "proposed", createdAt: now, result: null,
    };
    this.d.store.putProposal(p);
    this.keep(conversationId, p.id);
    return { proposal: this.d.store.proposal(p.id)! };
  }

  /**
   * The user's "keep it for later" for open proposal `id`, a reply to one thread (`keep`): nothing is sent. The reply is
   * kept, unsent, for the phone's Drafts (a dictated one without its first line, which goes back on when it's sent),
   * and the proposal is closed as kept (`KEPT`). The same dictated draft kept again replaces the one kept before.
   */
  keep(conversationId: string, id: string): ToolResult {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) {
      // A reply or a new thread's prompt kept already (its kept id, "K-…"): "keep it" is done. On 8 November the backend
      // passed a dictated prompt's kept id and got "No such proposal.".
      const kept = /^K-/.test(id) ? this.d.store.keptReply(id) : null;
      if (kept) return { kept: true, already: true, kept_id: kept.id, result: "It's kept already, in Drafts on the phone.", instruction: "Say only that it's kept, in Drafts on their phone (\"Kept. It's in Drafts on your phone.\"), then carry on with what they want next." };
      return { error: "No such proposal." };
    }
    if (p.action === "start_work" && p.fields.keptId) return this.keepStart(p);
    // Set up for later (stage 4b): it isn't a reply to keep; it's scheduled with a yes, or not at all.
    if (forLater(p)) return { error: "That's set up for later: it can't be kept as a reply. Ask whether to schedule it; if they say no, call cancel." };
    if (p.action !== "follow_up" || p.targets.length !== 1) return { error: "Only a reply to a thread or a dictated prompt can be kept for later. Say so, and ask whether to go ahead or leave it." };
    const target = p.targets[0];
    const said = `Kept your reply to ${target.handle}. It's in Drafts on the phone.`;
    const instruction = "Say only that it's kept, in Drafts on their phone (\"Kept. It's in Drafts on your phone.\"), then carry on with what they want next.";
    const keptBefore = p.fields.keptId ? this.d.store.keptReply(p.fields.keptId) : null;
    if (p.state === "cancelled" && p.result === KEPT) return { kept: true, ...(keptBefore ? { kept_id: keptBefore.id } : {}), result: said, instruction };
    if (p.state !== "proposed") return { error: `That reply can't be kept: it's already ${p.state}${p.result ? ` (${p.result})` : ""}.` };
    this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT });
    // A kept reply proposed to send (`sendKept`) and kept again is the same one, still kept.
    if (keptBefore) return { kept: true, kept_id: keptBefore.id, result: said, instruction };
    const { note, text } = dictatedParts(p.fields.message ?? "");
    const kept = this.d.store.keepReply({
      id: `K-${randomUUID().slice(0, 8)}`, threadId: target.itemId, threadName: target.handle, project: target.group ?? "", text, note,
      draftId: p.fields.draftId ?? null, conversationId, keptAt: this.now(),
    });
    this.d.log?.(`proposal ${p.id} kept for later`);
    this.d.track?.("reply_kept", { action: "kept", count: 1 });
    return { kept: true, kept_id: kept.id, result: said, instruction };
  }

  /** "Keep it for later" for a kept prompt proposed to start (`sendKept`): it stays kept, and nothing is started. */
  private keepStart(p: Proposal): ToolResult {
    const kept = this.d.store.keptReply(p.fields.keptId!);
    const instruction = "Say only that it's kept, in Drafts on their phone (\"Kept. It's in Drafts on your phone.\"), then carry on with what they want next.";
    if (p.state === "proposed") this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT });
    else if (!(p.state === "cancelled" && p.result === KEPT)) return { error: `That prompt can't be kept: it's already ${p.state}${p.result ? ` (${p.result})` : ""}.` };
    if (!kept) return { error: "That prompt isn't kept any more: it was started or discarded. Say so." };
    return { kept: true, kept_id: kept.id, result: "Kept your prompt for a new thread. It's in Drafts on the phone.", instruction };
  }

  /** Follow-ups whose repeat the backend was told of once already (`sentAlready`): conversation, thread and words. */
  private readonly repeatsTold = new Set<string>();

  /** The follow-up this brain last sent each thread, and the thread as it was then (`justSent`), for `SENT_MS`. Kept in memory only. */
  private readonly sentAt = new Map<string, JustSent>();

  /**
   * The follow-up this brain sent `item` within `SENT_MS`, while its computer's view may only not show that run yet (it
   * reaches the brain a moment after the send is taken; `viewLags`): no run finished since, asking nothing or only the
   * question it answered, not failed or stopped since. At work, then: a chain on it waits for that run, from its run
   * before (the reviews of 4-J). Null otherwise.
   */
  private justSent(item: WorkItem, now: number): JustSent | null {
    const s = this.sentAt.get(item.id);
    return s && viewLags(item, s, now) ? s : null;
  }

  /**
   * The same words went to this thread earlier in this conversation (in the last half hour): the backend is told so
   * once, to say so and ask; proposed again after that, it's proposed as usual, since the user wants it sent again. On
   * 10 November the backend proposed "Stop; this was sent to the wrong place." a minute after sending "Stop, this was
   * sent to the wrong place.", for "That wasn't sent to the right place", and the user's "Send it" sent it twice.
   */
  private sentAlready(conversationId: string, target: { itemId: string; handle: string; group?: string }, message: string, now: number): string | null {
    const words = messageWords(message).join(" ");
    const sent = this.d.store.proposalsFor(conversationId).findLast((p) =>
      p.action === "follow_up" && p.state === "executed" && p.targets[0]?.itemId === target.itemId && now - p.createdAt < 30 * 60_000 &&
      messageWords(String(p.fields.message ?? "")).join(" ") === words);
    const key = `${conversationId}|${target.itemId}|${words}`;
    if (!sent || this.repeatsTold.has(key)) return null;
    this.repeatsTold.add(key);
    const minutes = Math.round((now - sent.createdAt) / 60_000);
    const ago = minutes < 1 ? "just now" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
    return `Nothing was proposed: ${saidBefore(target)} was sent these same words ${ago}. Say so, and ask whether they want it sent again; only if they do, propose it again.`;
  }

  /** Kept replies being sent by voice now (`sendKept`): each goes once at a time. */
  private readonly sendingKept = new Set<string>();

  /**
   * The user asked to send reply `keptId`, kept for later (the backend's `send_kept`), at their reply level (`levels`):
   * asking is the yes for "none" and "yes", so it's sent now; "readback" proposes it, to read back and agree to; "tap"
   * sends nothing (Send on it in Drafts does). Sent, it's no longer kept; the call's receipt is a change like any.
   */
  async sendKept(conversationId: string, keptId: string, levels: ConfirmLevels = READBACK_ALL, where: { project?: string | null; profile?: string | null; model?: string | null; defaults?: NewThreadDefaults } = {}): Promise<ToolResult> {
    const kept = this.d.store.keptReply(keptId);
    if (!kept) return { error: "That reply isn't kept any more: it was sent or discarded. Say so." };
    const start = parseNewThread(kept.threadId);
    if (start) return this.startKept(conversationId, kept, start, levels, where);
    const onlyByTap = { sent: false, result: "Nothing was sent.", instruction: "Nothing was sent: the user's settings send replies only with a tap. Tell them to tap Send on it in Drafts on their phone." };
    if (this.levelNow("follow_up", levels.reply ?? "readback") === "tap" && !this.asksAgain()) {
      this.waitingForFaceId(kept.id);
      return onlyByTap;
    }
    if (this.sendingKept.has(kept.id)) return { error: "That reply is being sent right now." };
    if (!this.d.adapter.actions.includes("follow_up")) return { error: "This system can't take follow-ups." };
    const target = this.d.named().find((n) => n.id === kept.threadId);
    if (!target) return { error: "That thread is settled or gone, so nothing was sent. Say so: the reply is still in Drafts on their phone." };
    const targets = [{ itemId: target.id, handle: target.handle, group: target.group }];
    const message = kept.note ? `${kept.note}\n\n${kept.text}` : kept.text;
    const current = this.preparing(conversationId);
    const reason = await this.check([{ kind: "follow_up", itemId: target.id, message }]);
    if (reason) return { error: reason };
    if (!current()) return { error: "That was stopped or replaced; nothing was sent." };
    // Privacy as it is now, after asking the computer: Face ID every time chosen meanwhile leaves it for Send in Drafts.
    const level = this.levelNow("follow_up", levels.reply ?? "readback");
    if (level === "tap" && !this.asksAgain()) {
      this.waitingForFaceId(kept.id);
      return onlyByTap;
    }
    const now = this.now();
    const createdFrom = this.d.spoken(conversationId).length;
    const words = kept.text.split(/\s+/).filter(Boolean).length;
    // Read back as a dictated reply is: its name, and how long it is (its words are on the phone, in Drafts).
    const readback = `Send ${saidBefore(targets[0])} your kept reply, ${size(words, 1)}.`;
    const base = {
      id: `P-${randomUUID().slice(0, 8)}`, conversationId, action: "follow_up", targets, readback, createdFrom, expiresAt: now + EXPIRY_MS, createdAt: now, result: null,
      fields: { message, keptId: kept.id, ...(kept.draftId ? { draftId: kept.draftId } : {}), confirm: level },
    };
    // At Face ID every time, asked again by where the phone is (`asksAgain`): proposed for Send on the phone, with its line.
    if (level === "tap") {
      this.supersede(conversationId);
      const p: Proposal = { ...base, state: "proposed", mustHear: [] };
      this.d.store.putProposal(p);
      this.waitingForFaceId(kept.id);
      return this.askForTap(p);
    }
    if (level === "readback") {
      const clash = lookalike(targets, "Send", "your", this.d.named(), this.d.settled?.() ?? []);
      if (clash) return { error: tooAlike(clash) };
      this.supersede(conversationId);
      this.d.store.putProposal({ ...base, state: "proposed", mustHear: [{ words: [], need: 0, from: createdFrom, head: nameTokens(`Send ${target.handle}`), named: 1, where: whereTokens(targets[0]), next: "your" }] });
      return { proposal_id: base.id, readback, instruction: "Say the readback word for word, then ask \"Shall I go ahead?\" and stop. Nothing has been sent yet." };
    }
    this.sendingKept.add(kept.id);
    try {
      const p: Proposal = { ...base, state: "executing", mustHear: [] };
      this.d.store.putProposal(p);
      this.d.log?.(`kept ${kept.id}: sent by voice as ${p.id}`);
      const r = await this.execute(p, false);
      return "error" in r ? r : { ...r, proposal_id: p.id };
    } finally {
      this.sendingKept.delete(kept.id);
    }
  }

  /**
   * The user asked to start the new thread whose prompt they dictated and kept (`sendKept`), at their start level: in
   * the project they name now (`where.project`), else the one it was dictated for; with neither, they're asked which.
   * Placed, the kept prompt says where from then on, so Send in Drafts can start it too. Then, as for a kept reply:
   * asking is the yes for "none" and "yes", "readback" reads it back first, and "tap" waits for Send in Drafts. Its
   * model: one named now, else the one named as it was dictated, else this call's default, else the default then.
   */
  private async startKept(conversationId: string, kept: KeptReply, start: NewThread, levels: ConfirmLevels, where: { project?: string | null; profile?: string | null; model?: string | null; defaults?: NewThreadDefaults }): Promise<ToolResult> {
    if (!this.d.adapter.actions.includes("start_work")) return { error: "This system can't start work." };
    if (this.sendingKept.has(kept.id)) return { error: "That prompt is being started right now." };
    const places = spokenPlaces(this.d.places?.() ?? []);
    // A place no longer there (its machine asleep, or gone from T3) is asked about again, as none is.
    let placeId = places.some((p) => p.id === start.placeId) ? start.placeId : null;
    // With no project named and none dictated for, the default project (Settings → New threads), if there is one.
    if (where.project?.trim() || (!placeId && where.defaults?.project)) {
      // "driver" for a prompt dictated for "driver, on Lattice" is that place (14 November: Driver asked which machine).
      const found = this.pickWithDefaults(where.project ?? "", this.d.places?.() ?? [], this.d.lastUserTurn(conversationId).text, placeId, where.defaults);
      if ("error" in found) return found;
      placeId = found.place.id;
    }
    if (!placeId) {
      const recent = [...places].sort((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? "")).slice(0, 6).map((p) => p.name);
      // Not "ask the user" outright: on 9 November the backend called this for "keep it for later", was told to ask, and
      // asked again and again ("I already said keep it for later").
      return {
        sent: false,
        kept: true,
        result: "Nothing was started: it has no project yet. It stays kept, in Drafts on the phone.",
        instruction: `If the user wanted it kept, or didn't clearly ask to start it, say only "Kept. It's in Drafts on your phone." and don't ask about a project. If they asked to start it, ask which project.${recent.length ? ` Projects active lately: ${recent.join("; ")}.` : ""}`,
      };
    }
    // What's said now: a model, one passed as the profile (`asModel`; 20 November), which is a model named now, or "as
    // usual" (`USUAL`), which sets aside the one named as it was dictated: the user's answer, so kept so.
    const place = places.find((p) => p.id === placeId)!;
    const usual = isUsual(where.model);
    const askedProfile = where.profile?.trim() || null;
    const asked = askedProfile ? this.profileOf(askedProfile) : null;
    const asProfile = asked && "error" in asked ? this.asModel(askedProfile, usual ? null : where.model ?? null, places.map((p) => p.models ?? [])) : null;
    if (asked && "error" in asked && !asProfile) return asked;
    // "As usual" wins over a model passed as the profile too: that profile is dropped either way.
    const saidNow = usual ? null : where.model?.trim() || asProfile;
    const profile = asProfile ? start.profile : askedProfile || start.profile;
    // A model this place can't have, named now or as it was dictated: the user is asked, and nothing is kept differently
    // until they answer. With one dictated, no model named would bring it back, so a yes to "as usual" comes back as
    // `USUAL`; another model comes back as itself.
    const dictated = saidNow || usual ? null : start.model ?? null;
    // This call's Settings, else those it was dictated with: a name and its provider together, never one of each.
    const fallback = where.defaults?.codingModel ? { fallback: where.defaults.codingModel, fallbackProvider: where.defaults.codingProvider } : { fallback: start.defaultModel, fallbackProvider: start.defaultProvider };
    const tried = saidNow || dictated ? this.modelOf(place, saidNow || dictated, fallback.fallback ?? null, fallback.fallbackProvider ?? null) : null;
    if (tried && "error" in tried) return { error: start.model ? `${tried.error} If they say to start it as usual, call send_kept again with project "${place.name}" and model "${USUAL}".` : tried.error };
    const model: ModelAsk = { said: saidNow || dictated, ...fallback };
    const placed = this.newThread({ placeId }, profile, model);
    if ("error" in placed) return placed;
    // Kept with what was said now: a model by its name (and the provider said with it), or none for "as usual" (a tap
    // on Send carries it out later).
    // With the Settings this start read back from, so a tap on Send later starts what was said.
    const keptModel = usual ? null : saidNow && placed.model?.said ? keptName(placed.model) : start.model ?? null;
    if (placeId !== start.placeId || (profile ?? null) !== start.profile || keptModel !== (start.model ?? null)) {
      const target = newThreadTarget({ placeId, profile, model: keptModel, defaultModel: fallback.fallback, defaultProvider: fallback.fallbackProvider });
      this.d.store.keepReply({ ...kept, threadId: target, threadName: place.name, project: place.name });
    }
    const level = this.levelNow("start_work", levels.start ?? "readback");
    const onlyByTap = { sent: false, result: "Nothing was started.", instruction: `Nothing was started: the user's settings start threads only with a tap. Tell them it's set to start in ${placed.place.name}: they tap Send on it in Drafts on their phone.` };
    if (level === "tap" && !this.asksAgain()) {
      this.waitingForFaceId(kept.id);
      return onlyByTap;
    }
    const message = kept.note ? `${kept.note}\n\n${kept.text}` : kept.text;
    const words = kept.text.split(/\s+/).filter(Boolean).length;
    const made = await this.proposeDraftStart(conversationId, { draftId: kept.draftId, keptId: kept.id, placeId, profile, model, message, words, parts: 1 }, level);
    if ("error" in made) return made;
    const p = made.proposal;
    // Privacy as it is now, after asking the computer: Face ID every time chosen meanwhile leaves it for Send in Drafts.
    if (this.levelNow("start_work", level) === "tap") {
      if (this.asksAgain()) {
        this.waitingForFaceId(kept.id);
        return this.askForTap(p);
      }
      this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT });
      this.waitingForFaceId(kept.id);
      return onlyByTap;
    }
    if (level === "readback") return { proposal_id: p.id, readback: p.readback, instruction: "Say the readback word for word, then ask \"Shall I go ahead?\" and stop. Nothing has been started yet." };
    // Asking was the yes.
    this.sendingKept.add(kept.id);
    try {
      this.d.store.putProposal({ ...p, state: "executing" });
      this.d.log?.(`kept ${kept.id}: started by voice as ${p.id}`);
      const r = await this.execute(p, false);
      return "error" in r ? r : { ...r, proposal_id: p.id };
    } finally {
      this.sendingKept.delete(kept.id);
    }
  }

  /** Stop: every change not yet under way is called off. One already executing finishes and keeps its receipt. */
  /** Cancels every open proposal, or with `conversationId`, that conversation's. */
  cancelOpen(reason: string, conversationId?: string) {
    this.stopped++;
    // One being carried out isn't open, so this end passes it over: it's told, in case it's held after all (`waitForTap`).
    for (const e of this.executing.values()) if (conversationId === undefined || e.conversationId === conversationId) e.ended ??= reason;
    this.endFor(conversationId === undefined ? this.d.store.allOpenProposals() : this.d.store.openProposals(conversationId), reason);
    this.afterCall(conversationId);
  }

  /**
   * A call over with no live session for the phone's stop to end (server.ts, `endsCall`: the time limit, a dropped
   * connection, the server closing it): at Face ID every time its conversation's tap-only sends are kept in Drafts,
   * waiting for Face ID (`keepUntapped`), and each of its sends being carried out is told the call ended, so one held
   * after is kept too (`waitForTap`), as the phone's stop does (`cancelOpen`). Nothing is called off: below Face ID every
   * time a change waiting for a yes stays as it was, and so does any other at that level.
   */
  callEnded(conversationId: string) {
    for (const e of this.executing.values()) if (e.conversationId === conversationId) e.ended ??= "the call ended";
    this.keepUntapped(conversationId, true);
    this.afterCall(conversationId);
  }

  /** The call's end for proposals `open`, still waiting for a yes: each is kept (`keepUntapped`) or called off (`reason`). */
  private endFor(open: Proposal[], reason: string) {
    // A send waiting for Send on the phone (Face ID every time) isn't lost with its call: it's kept, waiting for Face ID.
    if (this.faceid()) this.keepEach(open, true);
    for (const p of open) {
      const now = this.d.store.proposal(p.id);
      if (now?.state === "proposed") this.d.store.putProposal({ ...now, state: "cancelled", result: reason });
    }
  }

  /**
   * At Privacy's Face ID every time, a reply or a start that goes only with Send on the phone (`confirm` `tap`), not tapped
   * within its 120 s (`EXPIRY_MS`), or by the call's end (`ended`), is kept in Drafts as "Waiting for your Face ID",
   * never lost (docs/launch/engine.md §6; stage 2a item 12). Nothing is sent. Its level is the one now (`levelNow`): one
   * proposed at yes or readback before Face ID every time was chosen mid-call goes only with Send now, so it's kept too.
   */
  keepUntapped(conversationId?: string, ended = false): KeptReply[] {
    // Below Face ID every time a `tap` is Before it acts' own choice (Tap Send), and goes as today when it isn't tapped.
    if (!this.faceid()) return [];
    return this.keepEach(conversationId === undefined ? this.d.store.allOpenProposals() : this.d.store.openProposals(conversationId), ended);
  }

  /** `keepUntapped` for proposals `open`, at Face ID every time: what was kept. */
  private keepEach(open: Proposal[], ended: boolean): KeptReply[] {
    const now = this.now();
    const kept: KeptReply[] = [];
    for (const p of open) {
      // A kept reply or prompt proposed to send (`sendKept`) is in Drafts already: it's marked waiting for Face ID. One
      // set up for later isn't a reply to keep: untapped, nothing is set up (stage 4b).
      if (this.levelNow(p.action, p.fields.confirm ?? "readback") !== "tap" || forLater(p) || (!ended && now <= p.expiresAt)) continue;
      const k = this.keepForFaceId(p);
      if (k) kept.push(k);
    }
    return kept;
  }

  /**
   * Proposal `p`, open, kept in Drafts as "Waiting for your Face ID" in its place (a reply to one thread, or a new
   * thread): nothing is sent. `car` (stage 2b): kept in the car, so "Approve to send" goes for it at the call's end
   * (`afterCall`). A kept reply proposed to send (`sendKept`) is kept already: it's only marked. Null when it can't be kept.
   */
  private keepForFaceId(p: Proposal, car = false): KeptReply | null {
    if (forLater(p)) return null;
    const now = this.now();
    const message = p.fields.message ?? "";
    let kept: KeptReply | null = null;
    if (p.fields.keptId) {
      kept = this.d.store.keptReply(p.fields.keptId);
      if (kept) kept = this.d.store.keepReply({ ...kept, waiting: "faceid" });
    } else if (p.action === "follow_up" && p.targets.length === 1) {
      const { note, text } = dictatedParts(message);
      const t = p.targets[0];
      kept = { id: `K-${randomUUID().slice(0, 8)}`, threadId: t.itemId, threadName: t.handle, project: t.group ?? "", text, note, draftId: p.fields.draftId ?? null, conversationId: p.conversationId, keptAt: now, waiting: "faceid" };
    } else if (p.action === "start_work" && p.fields.placeId && p.fields.profile) {
      const place = p.fields.place ?? "";
      // With the model its readback said, so Send in Drafts starts that: one named as `sendKept` keeps it, else
      // Settings' default as it was then.
      const m = p.fields.model;
      const model = !m ? {} : m.said ? { model: keptName(m) } : { defaultModel: m.name, defaultProvider: m.provider ?? null };
      kept = { id: `K-${randomUUID().slice(0, 8)}`, threadId: newThreadTarget({ placeId: p.fields.placeId, profile: p.fields.profile.name, ...model }), threadName: place, project: place, text: message, note: null, draftId: null, conversationId: p.conversationId, keptAt: now, waiting: "faceid" };
    }
    if (!kept) return null;
    const made = p.fields.keptId ? kept : this.d.store.keepReply(kept);
    // Its kept reply named on it, so "Approve to send" for the proposal finds what it became (server.ts `approvalAnswer`).
    this.d.store.putProposal({ ...p, state: "cancelled", result: KEPT, fields: { ...p.fields, keptId: made.id } });
    if (car) this.approveAfter(made.id, p.conversationId);
    this.d.log?.(`proposal ${p.id} ${car ? "proposed in the car" : "wasn't tapped"}: kept as ${made.id}, waiting for Face ID`);
    if (!p.fields.keptId) this.d.track?.("reply_kept", { action: "kept", count: 1 });
    return made;
  }

  /**
   * Face ID asked on the phone's screen for proposal `id` didn't see the user (stage 2b; Fable's 2b topic 6): it's kept
   * in Drafts as "Waiting for your Face ID", and nothing is sent. The kept reply, or null when it isn't waiting for Send.
   */
  unseen(id: string): KeptReply | null {
    const p = this.d.store.proposal(id);
    if (!p || p.state !== "proposed" || !this.faceid() || this.levelNow(p.action, p.fields.confirm ?? "readback") !== "tap") return null;
    return this.keepForFaceId(p);
  }

  /** Sends kept in the car (stage 2b), "Approve to send" at their call's end: kept ids, with their conversation. */
  private approveAfter(keptId: string, conversationId: string) {
    const all = this.carKept().filter((k) => k.keptId !== keptId);
    this.d.store.set(CAR_KEPT_KEY, JSON.stringify([...all, { keptId, conversationId }]));
  }
  private carKept(): { keptId: string; conversationId: string }[] {
    try {
      const all = JSON.parse(this.d.store.get(CAR_KEPT_KEY) ?? "[]");
      return Array.isArray(all) ? all.filter((k) => typeof k?.keptId === "string" && typeof k?.conversationId === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * A call over (`conversationId`; every one with none): "Approve to send" for each send kept in the car in it that still
   * waits for Face ID (stage 2b; Fable's 2b topic 7), one each, never merged.
   */
  afterCall(conversationId?: string) {
    const all = this.carKept();
    const due = all.filter((k) => conversationId === undefined || k.conversationId === conversationId);
    if (!due.length) return;
    this.d.store.set(CAR_KEPT_KEY, JSON.stringify(all.filter((k) => !due.includes(k))));
    for (const k of due) {
      const kept = this.d.store.keptReply(k.keptId);
      if (!kept || kept.waiting !== "faceid") continue;
      const start = isNewThread(kept.threadId);
      const message = kept.note ? `${kept.note}\n\n${kept.text}` : kept.text;
      this.approve({ id: kept.id, start, name: start ? kept.threadName || null : kept.threadName, message, expiresAt: this.now() + KEPT_APPROVE_MS, conversationId: k.conversationId });
    }
  }

  cancel(conversationId: string, id: string): ToolResult {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) return { error: "No such proposal." };
    switch (p.state) {
      case "proposed":
        this.d.store.putProposal({ ...p, state: "cancelled", result: "cancelled by user" });
        return { cancelled: true, result: "Nothing was changed." };
      case "executing":
        return { cancelled: false, result: "It's already being carried out and can't be stopped now." };
      case "unknown":
        this.d.store.putProposal({ ...p, state: "cancelled", result: p.result });
        return { cancelled: true, result: "I won't retry it, but it may already have gone through." };
      case "cancelled":
      case "expired":
        return { cancelled: true, result: "Nothing was changed." };
      default:
        return { cancelled: false, result: `Too late: ${p.result ?? "it already happened."}` };
    }
  }

  /** Changes carried out lately, newest last, for the phone's "done" tone (`/api/updates`). Kept in memory only. */
  private carried: { id: string; at: number }[] = [];

  /** The changes carried out in the last `withinMs`, with how long ago. */
  recentlyDone(withinMs = DONE_MS): { id: string; ageMs: number }[] {
    const now = this.now();
    this.carried = this.carried.filter((c) => now - c.at <= withinMs);
    return this.carried.map((c) => ({ id: c.id, ageMs: now - c.at }));
  }

  /**
   * The user's yes to proposal `id`: said aloud (`voice`, the backend's confirm, checked against what was heard), or a
   * tap on the phone's Send in the live call (`tap`: a signed-in tap is the yes, so there's no heard check). Either way
   * it's carried out the same, with the same checks of the threads, keys and receipt.
   */
  async confirm(conversationId: string, id: string, by: "voice" | "tap" = "voice"): Promise<ToolResult> {
    const r = await this.confirmOnce(conversationId, id, by);
    const state = this.d.store.proposal(id)?.state;
    if ("error" in r && state === "proposed") {
      // On 5 November a refused confirm was answered "Sent." Say it outright: nothing happened.
      return { ...r, error: `Nothing was done: nothing was sent, started or changed. ${r.error} Never say it was done.` };
    }
    return r;
  }

  /**
   * Carries out a proposal, claimed already ("executing"): it starts a thread or sends its commands. One that went
   * through rings the phone's done tone (`recentlyDone`), and a kept reply it sent is no longer kept.
   */
  private async execute(p: Proposal, retry: boolean, byTap = false): Promise<ToolResult> {
    this.executing.set(p.id, { conversationId: p.conversationId, ended: null });
    try {
      const r = p.action === "start_work" ? await this.start(p, retry, byTap) : await this.carryOut(p, retry, byTap);
      const state = this.d.store.proposal(p.id)?.state;
      if (state === "executed" || state === "partial") {
        if (!this.carried.some((c) => c.id === p.id)) this.carried.push({ id: p.id, at: this.now() });
        if (p.fields.keptId) this.d.store.dropKept(p.fields.keptId);
      }
      return r;
    } finally {
      this.executing.delete(p.id);
    }
  }

  /** Proposals being carried out now (`execute`), by id, with their conversation, and why its call ended meanwhile, if it did (`cancelOpen`). */
  private readonly executing = new Map<string, { conversationId: string; ended: string | null }>();

  private async confirmOnce(conversationId: string, id: string, by: "voice" | "tap"): Promise<ToolResult> {
    const p = this.d.store.proposal(id);
    if (!p || p.conversationId !== conversationId) return { error: "No such proposal. Propose the change first." };
    const retry = p.state === "unknown";
    if (p.state !== "proposed" && !retry) return { error: `That proposal is already ${p.state}${p.result ? `: ${p.result}` : ""}.` };
    if (this.now() > (retry ? p.createdAt + RETRY_MS : p.expiresAt)) {
      this.d.store.putProposal({ ...p, state: "expired" });
      return { error: "That proposal expired. Propose it again and read it back." };
    }
    // The readback named each target by its name at the time. Names can shift before the yes (a rename, or a
    // duplicate settled so "Fix login in driver 2" now means another thread): then the readback no longer names the
    // target for certain, so it's called off. A retry of an unknown outcome re-sends the same commands to the same
    // threads, already agreed to, so it's exempt.
    if (p.action !== "settle_subagents" && !retry) {
      // A thread moved to another project since is named differently too: the readback said where it was.
      const now = new Map(this.d.named().map((n) => [n.id, n]));
      const nowSaid = (t: Proposal["targets"][number]) => {
        const n = now.get(t.itemId);
        return n && said({ handle: n.handle, group: t.group === undefined ? undefined : n.group });
      };
      const moved = p.targets.find((t) => sayKey(nowSaid(t) ?? "") !== sayKey(said(t)));
      if (moved) {
        this.d.store.putProposal({ ...p, state: "cancelled", result: "a name changed" });
        const current = nowSaid(moved);
        return {
          error: `${saidBefore(moved)} ${current ? `is now called ${current}` : "has been settled or archived"} since the readback, so nothing was changed. ${current ? "Propose it again with the new name." : "Tell the user."}`,
        };
      }
    }
    // A thread renamed since the proposal may now sound like a target: then nothing heard can tell them apart.
    if (p.action !== "settle_subagents" && p.action !== "start_work" && !retry) {
      const verb = { follow_up: "Send", snooze: "Snooze", settle: "Settle", archive: "Archive" }[p.action as Exclude<ProposeAction, "settle_subagents" | "start_work">];
      const next = p.fields.draftId ? "your" : p.action === "follow_up" ? "this" : p.action === "snooze" ? "until" : null;
      const clash = lookalike(p.targets, verb, next, this.d.named(), this.d.settled?.() ?? []);
      if (clash) {
        this.d.store.putProposal({ ...p, state: "cancelled", result: "a name changed" });
        return { error: tooAlike(clash) };
      }
    }
    // A tap on Send is the yes, with the proposal on the screen. A spoken one counts as the user's settings say
    // (`Level`): any clear yes after it was proposed; only after the readback was heard in full; or never (tap only).
    // `refused` says why, for the call's receipt.
    if (by === "voice") {
      const level = this.levelNow(p.action, p.fields.confirm ?? "readback");
      const spoken = this.d.spoken(conversationId);
      const user = this.d.lastUserTurn(conversationId);
      if (level === "tap") return this.refusal(p);
      if (level === "readback" && !heard(p, spoken, user.atSpoken)) {
        return { error: `The user has not heard the full readback yet. Say exactly this, then ask again: ${p.readback}`, refused: "it hadn't been read back yet" };
      }
      // Message groups already used the user's cutoff above; the names and dates must precede it too.
      if (user.atSpoken <= p.createdFrom || (level === "readback" && !heard({ mustHear: p.mustHear.filter((g) => g.message === undefined) }, spoken.slice(0, user.atSpoken)))) {
        return { error: `The user has not answered the readback yet. Ask them: ${p.readback} Shall I go ahead?`, refused: "you hadn't answered yet" };
      }
      if (!agrees(user.text)) {
        return { error: `The user has not clearly said yes. Ask them: ${p.readback} Shall I go ahead?`, refused: "you hadn't said yes" };
      }
    }
    // Claim it before the first await: a second confirm or a cancel now sees "executing". How a send was agreed to is
    // kept with it (the Timeline's "how each send was approved"): a spoken yes, or Send tapped in the call, with Face ID
    // where Privacy asks for it. A retry keeps the yes it had.
    const approved: Approved = by === "voice" ? "voice" : this.levelNow(p.action, p.fields.confirm ?? "readback") === "tap" ? "faceid" : "tap";
    const send = (p.action === "follow_up" || p.action === "start_work") && !retry;
    const claimed: Proposal = send ? { ...p, fields: { ...p.fields, approved } } : p;
    this.d.store.putProposal({ ...claimed, state: "executing" });
    // Set up for later (stage 4b): the yes hands it to its computer; nothing is sent now.
    if (forLater(p)) return this.schedule(claimed, by);
    // Stopping a held command with words (Fable's 4-H3): said as that, if it was still held as it went.
    const held = p.fields.held && this.d.named().find((n) => n.id === p.targets[0]?.itemId)?.item.questionId === p.fields.held.questionId ? p.fields.held : null;
    const r = await this.execute(claimed, retry, by === "tap");
    if (held && by === "voice" && this.d.store.proposal(p.id)?.state === "executed") {
      const line = sentStopped(held.matched);
      return { ...r, result: line, instruction: `Say only "${line}", word for word, then carry on with the call.` };
    }
    return r;
  }

  /**
   * A spoken "let it run" for a thread holding a command (Commands that wait; Fable's 4-H3): refused before any readback,
   * and it stays held. The line says where the button is, by where the phone is (`whereOf`); with Call mode on screen,
   * or at the ear for when it comes away, the hold is the call's to show, its card with Let it run and Stop it.
   */
  private notByVoice(conversationId: string, item: WorkItem): ToolResult {
    const where = this.whereOf();
    if (where !== "car") this.d.store.set(heldAskedKey(conversationId), JSON.stringify({ itemId: item.id, questionId: item.questionId, at: this.now() }));
    const line = NOT_BY_VOICE[where];
    return { error: `Nothing was sent: the command is still waiting. Say only "${line}", word for word, then carry on with the call. Never offer to let it run, and never send it any words that would.`, refused: line };
  }

  /**
   * Where a tap the call asks for is (Fable's 4-H3), by where the phone is (`place`, stage 2b): on screen, at the ear,
   * or in the car or locked, for when they can look. Not known: the car if the phone's last call was in it, else the
   * screen.
   */
  private whereOf(): Where {
    const at = this.place();
    return at === "screen" || at === "ear" ? at : at === "car" || at === "locked" ? "car" : phoneInCarIn(this.d.store) ? "car" : "screen";
  }

  /** A spoken no to a held command: stopped at once, with no readback and no yes (saying no never asks). */
  private async stopHeld(target: ProposalTarget, item: WorkItem): Promise<ToolResult> {
    const undo = answering(this.d.store, target.itemId, item.questionId!, false, undefined, this.now());
    const r = await this.d.adapter.answerHold?.(target.itemId, item.questionId!, false).catch((e): Receipt => ({ ok: false, unknown: true, error: String(e) })) ?? "unsupported";
    if (r === "unsupported" || (!r.ok && !r.unknown)) {
      undo();
      const why = r === "unsupported" || /^No longer waiting/.test(r.error) ? HELD_NO_LONGER : r.error;
      return { error: `Nothing was sent. ${why} Tell the user in a few words.` };
    }
    const line = r.ok ? toldNo(target.handle) : `I couldn't tell whether it reached ${target.handle}: the connection dropped. Check its computer.`;
    this.d.log?.(`held ${target.itemId}: stopped by voice${r.ok ? "" : " (may not have arrived)"}`);
    return { done: r.ok, ...(r.ok ? { stopped: true } : {}), result: line, instruction: `Say only "${line}", word for word, then carry on with the call.` };
  }

  /**
   * Whether a send or a start must wait for Send on the phone, asked just before it's dispatched, after every await in
   * preparing it: one a tap carries out goes (the phone asked for Face ID first if Privacy wanted it), any other only
   * below Privacy's level as it is now (`levelNow`). So Face ID every time chosen while a yes or a send at once was being
   * prepared (the threads looked up, the computer asked, the title written) stops it before anything is sent, on Lattice
   * and in the cloud alike.
   */
  private tapOnly(p: Proposal, tapped: boolean): boolean {
    return !tapped && this.levelNow(p.action, p.fields.confirm ?? "readback") === "tap";
  }

  /** Whether the level answers from a notification's button now (§8, §12 5: Road Trip and up; Lattice always). */
  private answersFromNotification(): boolean {
    return this.d.limits?.().answerFromNotification ?? true;
  }

  /**
   * A send or a start stopped just before it was dispatched (`tapOnly`), nothing sent: it waits for Send on the phone in
   * the call, as one proposed at Face ID every time does, then in Drafts as "Waiting for your Face ID" (`keepUntapped`),
   * never lost or left `executing`; a kept one is in Drafts already, marked so. A retry stays as it was, for a tap to retry.
   * One whose call ended while it was prepared, passed over by that end, gets it now: it's in Drafts at once.
   */
  private waitForTap(p: Proposal, retry: boolean): ToolResult {
    const held: Proposal = retry ? { ...p, state: "unknown" } : { ...p, state: "proposed", fields: { ...p.fields, confirm: "tap" } };
    this.d.store.putProposal(held);
    if (p.fields.keptId) this.waitingForFaceId(p.fields.keptId);
    this.d.log?.(`proposal ${p.id}: Privacy asks for Face ID now, so nothing was sent; it waits for Send on the phone`);
    // A retry stays a lost outcome, as the call's end leaves one: it may have gone through, so it isn't made a new send.
    const ended = this.executing.get(p.id)?.ended;
    if (ended && !retry) this.endFor([held], ended);
    return ended || retry ? tapRefusal(p) : this.refusal(held);
  }

  /** A kept reply or prompt the voice couldn't send at Face ID every time: Drafts says it's waiting for Face ID. */
  private waitingForFaceId(keptId: string) {
    const kept = this.d.store.keptReply(keptId);
    if (kept && this.faceid() && kept.waiting !== "faceid") this.d.store.keepReply({ ...kept, waiting: "faceid" });
  }

  /**
   * A change the user made with a tap on the phone, signed in: the tap is their yes, so there's no readback. Carried out
   * as an agreed proposal is (the same checks, keys and receipt), and kept as a tap (`TAP`) for the timeline.
   */
  async tap(action: TapAction, target: ProposalTarget, fields: Pick<Proposal["fields"], "until" | "message" | "keptId" | "draftId" | "questionId" | "afterReply" | "approved" | "noted">, requestId?: string): Promise<Proposal> {
    const now = this.now();
    const p: Proposal = {
      id: tapId(requestId), conversationId: TAP, action, targets: [target], fields,
      readback: `${action} ${target.handle}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executing", createdAt: now, result: null,
    };
    return this.runTap(p, () => this.carryOut(p, false));
  }

  /**
   * A new thread started with a tap: a prompt for it, dictated or typed on the phone, sent with Send to its `new:`
   * target (`target`, as the phone sent it, so a retry is matched on exactly what was tapped). Checked as a dictated
   * start is (`proposeDraftStart`: the place and profile), then started once, as a yes would. One with no project yet
   * is started in a call, where Driver asks which. `keptId`: a prompt kept for later in a call, no longer kept once started.
   * Its model is the one named as it was dictated, else Settings' default then, on its provider where the place has it
   * (a tap has no call's settings).
   */
  async tapStart(target: string, message: string, requestId?: string, keptId?: string, how: Pick<Proposal["fields"], "approved" | "noted"> = {}): Promise<Proposal | { error: string }> {
    const start = parseNewThread(target);
    if (!start) return { error: "That new thread couldn't be read, so nothing was started." };
    if (!start.placeId) return { error: "Nothing was started: it has no project yet. Choose one, or start it in a call." };
    if (!(spokenPlaces(this.d.places?.() ?? [])).some((x) => x.id === start.placeId)) return { error: "That project isn't reachable now (its computer may be asleep), or it's gone, so nothing was started." };
    const s = this.newThread({ placeId: start.placeId }, start.profile);
    if ("error" in s) return { error: "That new thread can't be started from here. Start it in a call instead." };
    const chosen = this.modelOf(s.place, start.model ?? null, start.defaultModel ?? null, start.defaultProvider ?? null);
    // A tap can't ask: what's wrong with the model named as it was dictated, and a call, which asks what to do instead.
    if ("error" in chosen) {
      const m = s.place.models?.length ? matchModel(start.model!, s.place.models) : null;
      const why = !m ? `10 & 2 can't choose a model in ${s.place.name}` : m.kind === "several" ? `“${start.model}” could mean ${sayNames(m.names)}` : `${s.place.name} doesn't offer “${start.model}” now`;
      return { error: `${why}, so nothing was started. Start it in a call instead.` };
    }
    const now = this.now();
    const p: Proposal = {
      id: tapId(requestId), conversationId: TAP, action: "start_work", targets: [],
      fields: { placeId: s.place.id, place: s.place.name, profile: s.profile, ...(chosen.model ? { model: chosen.model } : {}), message, target, ...(keptId ? { keptId } : {}), ...how },
      readback: `start a new thread in ${s.place.name}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executing", createdAt: now, result: null,
    };
    return this.runTap(p, () => this.start(p, false));
  }

  /** Keeps a tap, claimed already ("executing"), and carries it out; the same tap sent meanwhile joins this run. */
  private async runTap(p: Proposal, go: () => Promise<ToolResult>): Promise<Proposal> {
    this.d.store.putProposal(p);
    const run = go().then(() => this.d.store.proposal(p.id)!);
    this.tapping.set(p.id, run);
    try {
      return await run;
    } finally {
      this.tapping.delete(p.id);
    }
  }

  /** Taps being carried out now, by id: the same tap sent again joins its run rather than run twice. */
  private readonly tapping = new Map<string, Promise<Proposal>>();

  /** The tap the phone sent before with this request id, once it's done (its answer was lost, or it's sent twice at once); null if none. */
  earlierTap(requestId: string): { proposal: Proposal; done: Promise<Proposal> } | null {
    const p = this.d.store.proposal(tapId(requestId));
    return p ? { proposal: p, done: this.tapping.get(p.id) ?? Promise.resolve(p) } : null;
  }

  /** A tap the brain carries out itself (following a thread or not), kept like any tap for the timeline. */
  noted(action: "follow" | "unfollow", target: ProposalTarget): Proposal {
    const now = this.now();
    const p: Proposal = {
      id: `T-${randomUUID().slice(0, 8)}`, conversationId: TAP, action, targets: [target], fields: {},
      readback: `${action} ${target.handle}, tapped on the phone`, mustHear: [], createdFrom: 0, expiresAt: now, state: "executed", createdAt: now,
      result: action === "follow" ? `Following ${target.handle}.` : `Stopped following ${target.handle}.`,
    };
    this.d.store.putProposal(p);
    return p;
  }

  /**
   * Claims each reply of thread `itemId` the brain has noted (its reach-outs, told or not) for message `by`, unless a
   * write already took it: a write from its notification is then refused as moved on (`writeCheck`). The ones it took.
   */
  private claimReplies(itemId: string, by: string): string[] {
    const keys = this.d.store.reachOuts().filter((r) => r.kind === "reply" && r.news.itemId === itemId).map((r) => wroteClaim(r.key));
    const free = keys.filter((k) => !this.d.store.get(k));
    for (const k of free) this.d.store.set(k, by);
    return free;
  }

  /**
   * Note-reply's still-latest (Fable's 4-K): a write from a reply's notification goes only while that reply is still its
   * thread's latest (no run of it has ended since, and its computer's own report, read now, still has that message), the
   * thread isn't running or asking, you haven't written in it since (at the computer, or through 10 & 2), and no other
   * write after that reply went (`wroteClaim`: one from that notification, or any message to the thread from the app, a
   * call or Drafts, which claims every reply of it that it follows: `claimReplies`). It fails closed (4-K's review): a
   * report that can't be read, or names no
   * message, when the notification knew its message, is moved on; so, with no time for the reply's run, is a run ended
   * since at all. Null when it may go, else the reason; a thread gone or its computer offline is the caller's to say.
   */
  private async writeCheck(p: Proposal, items: WorkItem[]): Promise<string | null> {
    const t = p.targets[0];
    const item = items.find((i) => i.id === t?.itemId);
    if (!t || !item || !this.d.adapter.connected(t.itemId)) return null;
    const moved = "has moved on since that reply";
    const r = this.d.store.reachOut(p.fields.afterReply!);
    if (!r || r.kind !== "reply" || r.news.itemId !== t.itemId) return moved;
    const claim = wroteClaim(r.key);
    const had = this.d.store.get(claim);
    if (had && had !== p.id) return moved;
    if (item.status === "running" || item.pendingQuestion) return moved;
    const runAt = r.news.seen.runAt;
    const ms = (x: string | null | undefined) => (x ? Date.parse(x) || 0 : 0);
    // With no time for the reply's run, any run's end since is newer, and what you wrote is compared with when the
    // brain saw the reply.
    if (runAt ? ms(item.lastRunAt) > runAt + RUN_ENDS_MS : ms(item.lastRunAt) > 0) return moved;
    if (Math.max(ms(item.typed?.at), ms(item.wroteAt)) > (runAt ? runAt + RUN_ENDS_MS : r.at)) return moved;
    // Claimed before the report's await, so a second write from the same notification meanwhile finds it taken.
    this.d.store.set(claim, p.id);
    const messageId = r.reply?.messageId;
    if (messageId && this.d.adapter.report) {
      const rep = await this.d.adapter.report(t.itemId).catch(() => null);
      if (rep?.reply?.messageId !== messageId) return moved;
    }
    return null;
  }

  /**
   * How many computers the account has, counted as the server's `notWrittenLine` counts them: the live links, else the
   * machines of the threads, live and as the briefing last had them.
   */
  private computers(items: WorkItem[]): number {
    return this.d.adapter.connectionStatus?.().length || new Set([...items, ...this.d.named().map((n) => n.item)].map((i) => i.machine ?? "")).size;
  }

  /**
   * Sends an agreed proposal's commands, claimed already ("executing"), and records how it went. `byTap`: the phone's
   * Send in a call carried it out, as a tap from outside a call (`TAP`) does.
   */
  private async carryOut(p: Proposal, retry: boolean, byTap = false): Promise<ToolResult> {
    // A tap's outcome is read on the phone, not said by Driver.
    const tapped = p.conversationId === TAP;
    // Re-read live targets after claiming the proposal, before dispatching any operation.
    let items: WorkItem[];
    try {
      items = await this.d.adapter.list();
    } catch {
      const error = retry
        ? "I couldn't check the threads right now. Part of this may already have gone through; try again when the connection is back."
        : tapped ? "Couldn't reach your threads just now, so nothing was changed. Try again." : "I couldn't check the threads just now, so I called this off. Please try again.";
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
      return { error };
    }
    // A write from a reply's notification (Fable's 4-K) is checked against its computer's own report, read just before
    // it goes, not only the view: that reply must still be the thread's latest.
    const after = p.fields.afterReply && !retry ? await this.writeCheck(p, items) : null;
    // That notification's claim, and those this message takes (`claimReplies`), each freed when nothing went to its thread.
    const claims = new Map<string, string[]>();
    if (p.fields.afterReply && !retry && p.targets[0]) claims.set(p.targets[0].itemId, [wroteClaim(p.fields.afterReply)]);
    const unclaim = (went = new Set<string>()) => {
      for (const [itemId, keys] of claims) for (const claim of went.has(itemId) ? [] : keys) if (this.d.store.get(claim) === p.id) this.d.store.set(claim, "");
    };
    for (const t of p.targets) {
      const key = `${p.id}:${t.itemId}`;
      if (this.d.store.operation(key)?.state === "done") continue;
      const item = items.find((i) => i.id === t.itemId);
      const connected = this.d.adapter.connected(t.itemId);
      if (retry && connected && ((p.action === "archive" && !item) ||
        ((p.action === "settle" || p.action === "settle_subagents") && item?.settled))) {
        this.d.store.beginOperation(p.id, t.itemId, toAction(p, t.itemId).kind, key);
        this.d.store.finishOperation(key, "done", null);
        continue;
      }
      // Legacy subagent proposals without parentId fail closed; their short expiry bounds this transition.
      const reason = !connected ? "is on a disconnected machine" : !item ? "no longer exists" :
        p.action === "unsettle" ? (item.settled ? null : "isn't settled") : item.settled ? "is already settled" :
        p.action === "settle" && item.status === "running" ? "is working again" :
        p.action === "settle_subagents" && !DONE.has(item.status) ? "is not finished now" :
        p.action === "settle_subagents" && (!t.parentId || item.parentId !== t.parentId) ? "no longer has the same parent" :
        // An answer to one question (a tap on a notification's button) goes only while the thread asks that question; the
        // computer looks again just before it sends (stage 2a).
        p.fields.questionId && !(item.pendingQuestion && item.questionId === p.fields.questionId) ? "isn't asking that any more" :
        // Never a held command's release (Fable's 4-K, 4-H3): only its card's Let it run (`answer_hold`) lets it run, so
        // no answer from a notification goes to a thread holding one, whatever its words.
        p.fields.questionId && item.gate ? "is holding a command" :
        after ? after : null;
      if (reason) {
        const error = retry
          ? `${t.handle} ${reason}, so I can't safely retry it right now. Part of this may already have gone through; try again after checking the thread and its connection.`
          : reason === "is holding a command" ? TAP_TO_RUN
          // A write from a reply's notification: its thread moved on since that reply (it's gone, settled, replied again,
          // runs or asks, or you wrote in it), or its computer is offline (Fable's 4-K; the server says which).
          : p.fields.afterReply ? (connected ? MOVED_ON : WRITE_OFFLINE)
          // A question's thread that's gone or settled has moved on from it too (as the server's own look says).
          : p.fields.questionId && (reason === "isn't asking that any more" || reason === "no longer exists" || reason === "is already settled") ? ANSWERED
          // Its computer named as the live list has it, else as the briefing last did (a remote computer that fails is
          // left out of the live list), and only with more than one (Fable's 4-0 (4); the skeptic, 4-K's third review).
          : p.fields.questionId && !connected ? answerOffline(item?.machine ?? this.d.named().find((n) => n.id === t.itemId)?.item.machine, this.computers(items))
          : tapped ? `${t.handle} ${reason}, so nothing was changed.` : `${t.handle} ${reason}, so I called this off without sending any commands.`;
        unclaim();
        // Refused because its computer is offline (`offline`): the server keeps a typed answer's words by it, never by
        // matching the line (the skeptic, 4-K's second review).
        this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error, ...(connected ? {} : { fields: { ...p.fields, offline: true as const } }) });
        return { error };
      }
    }
    // A message to a thread is written after each of its replies so far: a write from any of their notifications then
    // finds it claimed and isn't sent (Fable's 4-K: "the user hasn't written in it since"; 4-K's review).
    if (p.action === "follow_up" && !retry) for (const t of p.targets) claims.set(t.itemId, [...(claims.get(t.itemId) ?? []), ...this.claimReplies(t.itemId, p.id)]);

    const actions: Action[] = p.targets.map((t) => toAction(p, t.itemId));
    let done = 0;
    const failures: { handle: string; error: string }[] = [];
    const unknown: string[] = [];
    let held = false;
    let refused = false;
    // The threads it went to, or may have: their claims stay.
    const went = new Set<string>();
    await mapLimit(actions, 4, async (action, i) => {
      const key = `${p.id}:${p.targets[i].itemId}`;
      const prior = this.d.store.operation(key);
      const fresh = this.d.store.beginOperation(p.id, p.targets[i].itemId, action.kind, key);
      if (!fresh && this.d.store.operation(key)?.state === "done") {
        done++;
        went.add(p.targets[i].itemId);
        return;
      }
      // Re-sending a key is safe: the adapter must make it idempotent (T3 dedupes by commandId).
      const reason = fresh ? await this.check([action]) : null;
      // The last look before it goes, after every await (a reply is one thread, so nothing else went): the level now,
      // for an answer from a notification's button (a plan lapsing or a downgrade while it was prepared stops it, a
      // retry too); then Privacy now.
      if (!reason && (p.fields.questionId || p.fields.afterReply) && !this.answersFromNotification()) {
        if (fresh) this.d.store.dropOperation(key);
        refused = true;
        return;
      }
      if (!reason && this.tapOnly(p, byTap || tapped)) {
        if (fresh) this.d.store.dropOperation(key);
        held = true;
        return;
      }
      const r: Receipt = reason ? { ok: false as const, error: reason } : await this.d.adapter.execute(action, key).catch((e) => ({ ok: false as const, error: String(e), unknown: true }));
      if (r.ok) {
        this.d.store.finishOperation(key, "done", null);
        done++;
        went.add(p.targets[i].itemId);
        if (action.kind === "follow_up") {
          // The thread as it was before the send: its question then is the one it answered (the reviews of 4-J).
          const at = this.now();
          const was = items.find((x) => x.id === p.targets[i].itemId);
          for (const [id, t] of this.sentAt) if (at - t.at > SENT_MS) this.sentAt.delete(id);
          this.sentAt.set(p.targets[i].itemId, { at, asking: !!was?.pendingQuestion, questionId: was?.pendingQuestion ? (was.questionId ?? null) : null, status: was?.status ?? "idle" });
        }
      } else if (r.unknown || prior?.state === "unknown") {
        this.d.store.finishOperation(key, "unknown", r.error);
        unknown.push(p.targets[i].handle);
        went.add(p.targets[i].itemId);
      } else {
        this.d.store.finishOperation(key, "failed", r.error);
        failures.push({ handle: p.targets[i].handle, error: r.error });
      }
    });
    unclaim(refused || held ? new Set() : went);
    if (refused) {
      // Nothing sent: one retried stays as it was (it may have gone through before), a new one is called off.
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: NOT_FROM_NOTE });
      this.d.log?.(`proposal ${p.id}: the level doesn't answer from a notification now, so nothing was sent`);
      return { error: NOT_FROM_NOTE };
    }
    if (held) return this.waitForTap(p, retry);
    const state = unknown.length ? "unknown" : failures.length === 0 ? "executed" : done === 0 ? "failed" : "partial";
    const result = unknown.length
      ? tapped ? `Couldn't tell whether that went through: the connection dropped. Check ${unknown[0]} before trying again.`
        : `I couldn't confirm whether it went through for ${list([...new Set(unknown)].slice(0, 3))}: the connection dropped. Saying yes again retries it safely.`
      // An answer to a question the computer refused as moved on (its `ANSWERED`): those words, as the note in the
      // notification's place says them.
      : p.fields.questionId && !done && failures[0]?.error === ANSWERED ? ANSWERED
      : receiptText(p, done, failures);
    this.d.store.putProposal({ ...p, state, result });
    this.d.log?.(`proposal ${p.id} ${p.action} → ${state} (${done}/${actions.length})`);
    return { done: state === "executed", result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
  }

  /**
   * Starts the proposal's new thread, once: the key is `<proposal>:start`, so a yes after a lost answer launches with the
   * same key and gets the same thread back. The place is checked live first. The thread is titled from its prompt first
   * (`title`), and the title kept on the proposal, so a retry sends the same one; without one the work system names it.
   * Once started, the thread is named in the conversation by its title (or the work system's name for it) and as "your
   * new thread in <project>", counted as messaged there (so `wait_for` takes it), and starred, so Driver calls back when
   * it replies, unless Follow new threads is Never (follow.ts; engine.md §11, 3.1), which leaves it unstarred and says
   * nothing of a star. Its first message and when it started are kept for its purpose (purposes.ts).
   */
  private async start(p: Proposal, retry: boolean, byTap = false): Promise<ToolResult> {
    // A tap's outcome is read on the phone, not said by Driver.
    const tapped = p.conversationId === TAP;
    let f = p.fields;
    const key = `${p.id}:start`;
    const place = (spokenPlaces(this.d.places?.() ?? [])).find((x) => x.id === f.placeId);
    const reason = !this.d.adapter.connected(f.placeId!) ? "is on a machine that isn't connected right now" : !place ? "is no longer in T3" :
      sayKey(place.name) !== sayKey(f.place!) ? `is now called ${place.name}` : null;
    if (reason) {
      const error = retry
        ? `${f.place} ${reason}, so I can't safely retry it now. The thread may already have been started; check T3 first.`
        : tapped ? `${f.place} ${reason}, so nothing was started.` : `${f.place} ${reason}, so I called this off without starting anything.`;
      this.d.store.putProposal(retry ? p : { ...p, state: "cancelled", result: error });
      return { error };
    }
    const prior = this.d.store.operation(key);
    // Titled once, before anything is sent: a key already used goes again exactly as it went (the connector refuses the
    // same key with another title), and a title already kept (or one from before 8 November) is used as it is. The
    // proposal is executing (it was claimed before `start`), so it's written back as executing.
    if (!prior && !f.title && this.d.title) {
      const title = await this.d.title(f.message!, place!.name).catch((e) => {
        this.d.log?.(`proposal ${p.id}: no title (${String(e)})`);
        return null;
      });
      if (title) {
        f = { ...f, title };
        p = { ...p, state: "executing", fields: f };
        this.d.store.putProposal(p);
      }
    }
    const fresh = this.d.store.beginOperation(p.id, f.placeId!, "start_work", key);
    // The model as it was chosen before the yes: a retry under the same key sends the same one.
    const action: Action = { kind: "start_work", placeId: f.placeId!, ...(f.title ? { title: f.title } : {}), message: f.message!, profile: f.profile!, ...(f.model ? { model: f.model.id } : {}) };
    // What the thread is called until it's started: by its title, with its place, once it has one.
    const name = f.title ? `${f.title} in ${f.place}` : newThreadName(f.place);
    const checked = fresh ? await this.check([action]) : null;
    // The last look before it goes, after the title and the check: Privacy now.
    if (!checked && this.tapOnly(p, byTap || tapped)) {
      if (fresh) this.d.store.dropOperation(key);
      return this.waitForTap(p, retry);
    }
    const r: Receipt = checked ? { ok: false as const, error: checked } : await this.d.adapter.execute(action, key).catch((e) => ({ ok: false as const, error: String(e), unknown: true }));
    if (!r.ok) {
      if (prior?.state === "unknown") r.unknown = true;
      this.d.store.finishOperation(key, r.unknown ? "unknown" : "failed", r.error);
      const result = r.unknown
        ? tapped ? `Couldn't tell whether ${name} was started: the connection dropped. Check ${f.place} before trying again.`
          : `I couldn't confirm whether ${name} was started: the connection dropped. Saying yes again retries it safely.`
        : `Nothing was started. ${f.place} said: ${r.error}${f.model && !tapped && !this.d.places?.().find((x) => x.id === f.placeId)?.models?.some((m) => m.id === f.model!.id) ? " Ask the user which model, or whether to start it as usual." : ""}`;
      this.d.store.putProposal({ ...p, state: r.unknown ? "unknown" : "failed", result });
      this.d.log?.(`proposal ${p.id} start_work → ${r.unknown ? "unknown" : "failed"}`);
      return { done: false, result, instruction: "Tell the user this result in your own short words. Add no details that are not in it." };
    }
    this.d.store.finishOperation(key, "done", null);
    const itemId = r.itemId ?? null;
    // Follow new threads: a thread 10 & 2 starts is followed, set to Replies and questions, unless it's Never.
    const follows = followNewOf(this.d.store).choice !== "never";
    const starred = itemId && follows ? ", and starred it" : "";
    let called: string | null = null;
    // What it was started to do and when, kept for its purpose; named in this conversation by its title, as Driver called
    // it before it had one, and by the work system's name for it; followed (later.ts `afterStart`, shared with a start
    // set up for later).
    if (itemId) called = (await afterStart(this.d, { itemId, title: f.title ?? null, place: f.place!, message: f.message!, conversationId: tapped ? null : p.conversationId, at: this.now() })).called;
    // 14 November: "Started your new thread in driver" and then "what's it called?" got "it isn't in the list yet",
    // twice. Titled, the result says the title; untitled, the work system names it from its first words, and once it
    // lists it, the result says that name.
    // A model chosen is said once more, as the readback said it: the user hears what it started on.
    const using = f.model ? `, using ${withProvider(f.model)}` : "";
    const result = f.title ? `Started ${name}${using}${starred}.`
      : called ? `Started your new thread in ${f.place}${using}, called “${called}”${starred}.`
      : `Started ${name}${using}${starred}.`;
    this.d.store.putProposal({ ...p, state: "executed", result, fields: { ...f, ...(itemId ? { itemId } : {}) } });
    this.d.log?.(`proposal ${p.id} start_work → executed`);
    return {
      done: true,
      result,
      // Not "Driver … calls back with its reply": on 3 November the voice read that out as it stood, or said "I'll call back
      // with its reply", which hangs up as a promise to (endPolicy) when the user was carrying on.
      instruction: `Tell the user this result in your own short words${f.title || called ? ", with its name" : ""}: it has started${starred ? " and the user follows it, so they'll hear its reply" : ""}. You stay on the call: don't say you'll hang up or call back. Add no details that are not in it.`,
    };
  }
}

/** A dictated reply or prompt is asked about as the call opens, whatever the level: a yes is the least it needs. */
const draftLevel = (level: Level): Level => (level === "none" ? "yes" : level);

/** A tap's id: from the phone's request id, so the same tap sent again is the same one, with the same keys. */
const tapId = (requestId?: string) => `T-${requestId ?? randomUUID().slice(0, 8)}`;

function toAction(p: Proposal, itemId: string): Action {
  switch (p.action) {
    case "follow_up":
      return { kind: "follow_up", itemId, message: p.fields.message!, ...(p.fields.questionId ? { questionId: p.fields.questionId } : {}) };
    case "snooze":
      return { kind: "snooze", itemId, until: p.fields.until! };
    case "archive":
      return { kind: "archive", itemId };
    case "unsnooze":
      return { kind: "unsnooze", itemId };
    case "unsettle":
      return { kind: "unsettle", itemId };
    default:
      return { kind: "settle", itemId };
  }
}

export function receiptText(p: Pick<Proposal, "action" | "targets" | "fields">, done: number, failures: { handle: string; error: string }[]): string {
  const total = p.targets.length;
  const verb = { follow_up: p.fields.draftId ? "Sent your reply to" : "Sent the message to", settle: "Settled", archive: "Archived", snooze: "Snoozed", settle_subagents: "Settled", unsnooze: "Unsnoozed", unsettle: "Unsettled" }[p.action] ?? "Did";
  const what =
    p.action === "settle_subagents"
      ? `${done} of ${total} finished subagent threads`
      : list(p.targets.filter((t) => !failures.some((f) => f.handle === t.handle)).map((t) => t.handle));
  if (failures.length === 0) {
    const suffix = p.action === "snooze" && p.fields.until ? ` until ${spokenDate(new Date(p.fields.until), Date.now(), p.fields.tz).text}` : "";
    return `${verb} ${p.action === "settle_subagents" ? `all ${total} finished subagent threads` : what}${suffix}.`;
  }
  const failed = `Failed for ${list(failures.slice(0, 3).map((f) => f.handle))}: ${failures[0].error}`;
  return done === 0 ? `Nothing changed. ${failed}` : `${verb} ${what}. ${failed}`;
}

/** A tap's answer to a question that has moved on (the computer's own words for it, connector `ANSWERED`). */
export const ANSWERED = "Already answered, so nothing was sent.";

/**
 * A write from a reply's notification refused (Fable's 4-K): the thread moved on since that reply, or its computer is
 * offline. Kept as its result (the log's); the line the phone shows in the notification's place is reach.ts
 * `notWrittenLine`'s, which the server builds from these.
 */
export const MOVED_ON = "It has moved on since that reply, so nothing was sent.";
export const WRITE_OFFLINE = "Its computer is offline, so nothing was sent.";

/**
 * The claim on a reply's notification that one write from it takes, so two quick replies tapped at once can't both go;
 * it goes with its reach-out (`Store.pruneReachOuts`).
 */
export const wroteClaim = (reachOut: string) => `${WROTE_CLAIM}${reachOut}`;

/**
 * A question's answer refused because its computer is offline: a button's line. Typed words (Reply…) are kept in Drafts
 * instead, by the proposal's `offline` mark, with `notWrittenLine`'s line (Fable, 4-K's review).
 */
const answerOffline = (machine: string | null | undefined, computers: number) =>
  `${computers > 1 && machine ? machine : "Your computer"} isn't connected right now, so nothing was sent.`;

/**
 * How a reply reached its thread, as `reply_sent.via` (contracts §5): a yes in a call is "voice"; a reply sent from the
 * phone says how in its request's `via` (Send tapped, held, on the lock screen, or "Driver, send it" in the reader); one
 * a rule sent (a send or a start set up for later, sent by its computer at its time: stage 4) is "rule".
 */
export type ReplyVia = "tap" | "hold" | "lock_screen" | "voice" | "kept" | "rule";
const PHONE_VIAS: ReplyVia[] = ["tap", "hold", "lock_screen", "voice"];

/** A request's `via` as the phone sent it (contracts §3), "kept" for a kept reply, else (an older phone) "tap". */
export function tapVia(sent: unknown, kept = false): ReplyVia {
  return kept ? "kept" : PHONE_VIAS.find((v) => v === sent) ?? "tap";
}

/**
 * How a send tapped on the phone was agreed to (the Timeline's "how each send was approved"), from its request: from a
 * notification (`via: lock_screen`, `noted`), with Face ID where the phone asked for it first (`faceId`), else on the
 * lock screen; in the app, with Face ID or a tap; "Driver, send it" in the reader, a spoken one.
 */
export function approvedOf(body: { via?: unknown; faceId?: unknown }): Pick<Proposal["fields"], "approved" | "noted"> {
  // A kept reply's item in Send all's batch carries strings only ("true").
  const faceid = body.faceId === true || body.faceId === "true";
  if (body.via === "lock_screen") return { approved: faceid ? "faceid" : "lock_screen", noted: true };
  return { approved: faceid ? "faceid" : body.via === "voice" ? "voice" : "tap" };
}

/**
 * What a change that went through did, for analytics (contracts §5): a reply or a new thread is `reply_sent`, anything
 * else `thread_action`. `via` "voice": proposed in a call (agreed aloud or with Send); "rule": sent by a rule, its
 * computer at its time (later.ts); else the phone's tap. Nothing for one that didn't go through.
 */
export function trackChange(track: Track, p: Pick<Proposal, "state" | "action" | "fields" | "targets">, via: ReplyVia, dictated = false) {
  if (p.state !== "executed" && p.state !== "partial") return;
  if (p.action === "follow_up" || p.action === "start_work") {
    track("reply_sent", { via, dictated: dictated || !!p.fields.draftId, new_thread: p.action === "start_work" });
    return;
  }
  const action = ({ settle: "settle", settle_subagents: "settle", snooze: "snooze", archive: "archive", unsnooze: "undo", unsettle: "undo", follow: "follow", unfollow: "unfollow" } as Record<string, string>)[p.action];
  if (action) track("thread_action", { action, via: via === "voice" ? "voice" : "tap", threads: p.targets.length });
}
