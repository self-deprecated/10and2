// The engine (docs/launch/engine.md): when something happens, do something. Stage 2a builds its first standing rule,
// following (the threads you follow tell you when an agent there asks something), and the reach policy's first steps
// (reach.ts) for it and for today's call-backs: each fact becomes a reach-out, kept in the store until it's heard or
// expires, and each attempt on a channel a delivery, at most one per (fact, channel). The call-back waits (waits.ts)
// and the Ringer (ring.ts) stay; a wait that's over adds its duty to its facts' reach-outs, and its ring is one channel.
//
// Stage 3.1 adds following's replies, batched (the first at its grace, then the others in its window together, then a
// gap; each notification says every reply still unheard), each thread's own setting (follow.ts: Replies and questions,
// Questions only, Nothing, or As my rules say), which decides what following tells and lets a thread you don't follow
// tell you, and Follow new threads.
//
// It wakes on a machine's report (`changed`), on its own due times (`due`, `tick`: the cloud's alarm, and one timer while
// the brain is awake), and on the phone's requests. Stage 3.2 makes it keep the call-back waits' time too: its `due()`
// takes their exact times and its tick looks at them, so nothing polls (§7). What decides a firing, a delivery or "told"
// is in SQLite, written as §3 says: the firing and its reach-out in one transaction; an attempt row before each push,
// its result after; told only on proof (said in a call, or a call-back owning it).
//
// Stage 3.3 makes levels limits (levels.ts, §8): the engine is on for every account (stage 2a's gate is gone), and its
// `limits()` decide what the level changes: Commute rings once a day, the day starting at midnight on the phone's clock,
// kept for a call-back asked for in words, and anything it doesn't ring for is a notification; a question's buttons are
// Road Trip's and up; Watching says which. A ring is counted from its delivery rows, so nothing else keeps the count.
//
// Stage 3.6 (§11 item 6; Fable's decisions): a call-back asked for in words watches as long as the level allows, can
// wait for all of several threads, only for trouble or a failure, and not before a time; a failed or stopped run is news
// from its status; a long watch running out with a thread still working is one notification (a call when it was only
// for trouble); its readback says what it will do, word for word (watch-lines.ts), and asks for a yes only when that's
// less than asked.
//
// Stage 3.7 (§11 item 7; Fable's topics 9 to 12): a computer gone offline (no ping for 75 s, then a 3-minute grace) while
// threads something tells you about are running there is one fact per time it goes down, `${machine}:down:${since}`: a
// notification by default, a call only for a call-back asked for in words, which goes on watching; and when it's back,
// a quiet notification in its place, only if the first went out. Its checks are exact due times, only while it holds a
// watched running thread (§7: a wake about every 4 minutes where it may call, every 15 where it can only notify, none
// otherwise).
//
// Stage 3.8 (§11 item 8; Fable's topics 13 to 16): time. A deadline and a check-in are call-backs asked for in words with
// a set end (waits.ts `Mode`), their statements, readbacks, calls, notifications and Watching rows saying when; a
// repeating time (`every`, a standing rule in table `rules`) fires once per local date on the phone's clock, with a
// briefing's notification of what happened since its last occurrence, only when something did.
//
// Stage 3.9 (§11 item 9; Fable's decisions 3.9-A to 3.9-G): you wrote in a thread (`WorkItem.typed`, which the connector
// reports, never from a message's words). Typed at a computer or in T3 Code's phone app, it means you read the thread
// up to there: its news from before (a reply, a failure, a stop) still untold is dropped, quietly (`seenByYou`). Typed at
// a computer, it also ends Away (`AwayRule`, a preset's rule with a set end: every thread on every computer, questions,
// failures and a computer offline told by notification, never a call), which otherwise ends at its time or by Stop.
//
// Stage 3.4 and 3.5 (§11 items 4 and 5; Fable's decisions): your rules (my-rules.ts), a line taking effect on its own.
// 3.5 reads a line in your own words once (reader.ts, where the brain has a reader: `READER_SHIPS`), puts it in use at
// Use these rules, its earlier wording running meanwhile; example 2 (nothing left running in a project, `watchIdle`),
// a line's replies (13), its scope, and lines judged by AI: "needs my input"'s judged half (the briefing's card for that
// run) and a clause of your own on a reply (op `rules_judge`), checked a minute after a turn ends, at most 50 a day,
// told at once on a yes and in following's batch, marked "Not checked.", when it can't be checked; a wholly judged line
// paused on a level without judged lines.
import { createHash } from "node:crypto";
import type { Adapter, Link, Report, WorkItem } from "./adapter.ts";
import { STALE_MS } from "./connector-client.ts";
import type { Track } from "./analytics.ts";
import { followNewOf, notifyOf, tellsQuestions, tellsReplies, type ThreadNotify } from "./follow.ts";
import { AWAY_LONG_HAUL, AWAY_NOTIFICATIONS, awayFooter, awayOn, awayReadback, commuteAgreed, commuteReadback, LIMITS, localDay, WATCHING_NOTE, type LevelName, type Limits } from "./levels.ts";
import { awayLog, awaySaid, logAway, type AwayEnd } from "./away.ts";
import { Observations } from "./observations.ts";
import { privacyOf } from "./privacy.ts";
import { RUN_ENDS_MS } from "./reads.ts";
import { cantSeeTests, passOver, passReplied, testsFirst, testsOf, testsTitle, tooOldForTests } from "./receipts.ts";
import { answeredOf, askShown, awayNoteOf, backNoteOf, briefNoteOf, holdEndNoteOf, idleNoteOf, judgedNoteOf, wroteIn, BATCH_GAP_MS, BATCH_WINDOW_MS, batched, callBackWords, collapseOf, CONNECTING_MS, dueNow, dueOf, endsAsking, GRACE_MS, heldAsk, KEPT_MS, MISSED_MS, missedNoteOf, NEWS_MS, noteOf, offlineMissedOf, offlineNoteOf, openingOf, reach, replyNoteOf, ruleCollapse, standingNow, waitingCaller, whyOf, WROTE_RULE, type AlertPhone, type Delivery, type Duty, type News, type Note, type NoteSend, type ReachOut, type Situation, type Standing } from "./reach.ts";
import { callerOf, ringingNews, rings, type RingChannel, type Ringer } from "./ring.ts";
import { AWAY_PREFIX, AWAY_SAID, awayRule, everyRule, FOLLOWING, FOLLOWING_SAID, followRule, headOf, ROLLBACK_MARK, validAway, validEvery, validFollow, type AwayRule, type EveryRule, type FollowRule, type Joined } from "./rules.ts";
import type { Seen, Store } from "./store.ts";
import { backoffAfter, describe, mapLimit, realClock, Stuck, type Clock, type Timer } from "./util.ts";
import { notBeforeAt, settle, stillWorking, watchedLong, type Mode, type Wait, type Waits } from "./waits.ts";
import { AWAY_STILL_ON, commuteModeReadback, lengthReadback, mainOf, NO_REPEATS, NO_ZONE, notBeforeReadback, NOTHING_TO_STOP, notWatching, sayRow, secondReadback, smallHoursReadback, SOONER, statementOf, STILL_FOLLOWED, STOP_FAILED, STOPPED_ALL, stoppedWatching, stopWholeQuestion, TIME_PASSED, timeReadback, timeWatchingOf, watchingAnswer, watchingOf, type Ask, type SpokenRow, type Verb } from "./watch-lines.ts";
import { cardOf, formOf, keptLine, setLine, SHEET, SIRI_NOTES_OFF, siriLine, type Card, type Form, type How, type Reach, type Shown, type Spec, type Then, type When } from "./watch-card.ts";
import { clockOf, instantOf, nextClock, nextDate, nextEvery, parseClock, parseWhen, prevDate, shownClock, shownSince, spokenClock, spokenDay, spokenLength, validZone } from "./zone.ts";
import {
  CAR_MS, checksLine, countDetail, EARLIER, everyOf, EVERY_PREFIX, EXAMPLE_SECTION, exampleOf, exampleText, fileOf, fileProblem, FOCUS_KEY, FOCUS_MAX_MS, holdDetail, HOLD_END_MS, keyOf, LINE_MAX, LINE_PREFIX, lineRule, linesOf,
  nightAt, nightCovers, nightNext, nightOf, normal, NOT_IN_USE, NOT_READ, NOT_READ_YET, OFFERED, QUIET_KEY, QUIET_MAX_MS, quietCalls, quietCapped, quietUntil, readingNow, readNow, readRule, removedOf, ruleWhy, RULES_MAX, UNDO_MS, rulesOf, sameAs, saveFile, saveRemoved, validLine, weekendAt,
  type Context, type Example, type ExampleN, type HeldStretch, type Hold, type LineRule, type LineView, type Section,
} from "./my-rules.ts";
import { anything, countsOf, happenedOf, toldOrder, type Opening } from "./brief-lines.ts";
import { approveNoteOf } from "./faceid.ts";
import { OFFLINE_MS, offlineAgo, offlineAt, offlineCaller, offlineFor, offlineNote, offlineOpening, offlineSince } from "./offline.ts";
import { accountOf, allowAsk, allowDigest, ANY_HOUR, BY_DAY, BY_VOICE, byDayHours, CANT_CALL, cantCallOf, checkRaw, draftOf, JUDGE_AFTER_MS, JUDGE_MS, JUDGED_PER_DAY, judgedOf, NEEDS_OK, noZoneDay, notYetOf, projectsOf, READ_MS, sameNameOf, sentenceOf, validDraft, VOICE_NIGHT, type Account, type Checked, type Judge, type Project, type Read, type RulesReader } from "./reader.ts";
import { LATER_PREFIX, type Later } from "./later.ts";
import { laterNoteOf, laterSaid, sentBatchNoteOf } from "./later-lines.ts";
import { answering, HELD_MS, heldNoteOf, heldOverOf, heldSaid, type HeldCommand, type HeldEnd } from "./held-lines.ts";

/** Commands that wait's rule (§11 stage 4): every command a computer holds is news, on every level. It has no row of its own. */
export const HELD_RULE = "R-held";
/** The threads written to from a notification whose next reply notifies once (reach.ts `WROTE_RULE`), in kv. */
const WROTE = "engine_wrote";

/**
 * A fact the live call tells through its own arrival queue (§3, In a call: one path). `at`: the thread's last reply; a
 * question (`kind`) is told by the question itself, since one asked mid-run leaves `at` at the reply before it. A
 * computer gone offline, or back (stage 3.7): `offline`, its name, how long ago, the threads that were running there,
 * and once it's back how long it was away and how they stand now; `handle` is the computer's name.
 */
export type CallFact = {
  key: string; itemId: string; handle: string; group: string; at: string; ask: string | null; seen: Seen; kind: Exclude<ReachOut["kind"], "brief"> | "back";
  offline?: { machine: string; ago: string; names: string[]; back?: { length: string; standing: string[] } };
  status?: StatusFact;
  /**
   * Stage 3.10: what its tests did, from the computer, said first and word for word (Fable, 3.10-D); `passing`, a tests
   * watch's pass while the thread still works (no reply yet).
   */
  first?: string;
  passing?: true;
  /** Stage 4b: what became of a send or a start set up for later (kind `later`), said word for word (later-lines.ts). */
  said?: string;
};

/**
 * A call-back's fact that isn't a reply, as a live call tells it in the call-back's own words (Fable's finding on 3.6 to
 * 3.8; session.ts `tellFact`): each thread's standing (a failed or stopped run; still working when a long watch or a
 * deadline ran out, after how long; how it stood at a check-in), and how many of several were done.
 */
export type StatusFact = { lines: { handle: string; state: Standing; waited?: string; offline?: string; said?: string }[]; done?: { done: number; total: number } };

/** The live call, as the engine reaches it: its conversation, and its arrival queue. */
export type LiveCall = {
  conversationId: string;
  /** Queues `f` to be told at the call's next quiet moment; `said` runs once it was said. False if the call is ending. */
  tell(f: CallFact, said: () => void): boolean;
};

export type EngineDeps = {
  /**
   * `report`: a followed thread's reply, for its opening words (stage 3.1). `link`: a thread's computer (stage 3.7).
   * `timeZone`: a thread's computer's zone, where a not-before is read once the phone's is gone (§7).
   */
  adapter: Pick<Adapter, "list" | "connected"> & Partial<Pick<Adapter, "report" | "link" | "timeZone" | "connectionStatus" | "places">>;
  store: Store;
  waits: Waits;
  /** The phone record and the ring channel; without one (a demo world) nothing rings or is notified. */
  ringer?: Ringer;
  /** The alert sender (cloud/src/apns.ts); without one, notifications can't go and their news is kept. */
  notify?: NoteSend;
  /** The account's level's limits (levels.ts; cloud/src/plan.ts `limitsOf`), read each time; Lattice's are Long Haul's. */
  limits?: () => Limits;
  /** A thread's name, as the briefing gives it. */
  name?: (item: WorkItem) => string;
  /** A question's words and its own options (`questionReader`): the agent's own, else its card's ask; `Report.choices`. */
  read?: (itemId: string) => Promise<{ ask: string | null; choices: string[] | null }>;
  /** The live call, if one is on. */
  call?: () => LiveCall | null;
  /**
   * Makes a briefing ahead and keeps it (briefing-reading.ts `prepareSince`, as the level's `briefing` says), for a
   * repeating time's notification to play (stage 4; Fable's 4-I): its id. Without one, the notification goes without.
   */
  brief?: (ask: { threads: WorkItem[]; opening: Opening; zone: string; as: "summary" | "full"; at: number }) => Promise<string | null>;
  /**
   * Sends and starts set up for later (later.ts, stage 4b): their rows in Watching, their Stop, their due times, and
   * what became of each, told as a reach-out of kind `later`.
   */
  later?: Later;
  /**
   * Stage 3.5: the rules reader (reader.ts `modelReader`, op `rules_reader`), where this brain reads lines in your own
   * words; without it they're kept and shown "Not read yet", as in 3.4. `needsYou`: a thread's turn judged by its card
   * (the briefing's classifier for that thread, `Briefing.needsYou`): yes, no, or null for unchecked. `judge`: a clause
   * of your own on a reply (op `rules_judge`). Without either, a line's judged half isn't run, and nothing is said of it.
   */
  reader?: RulesReader;
  needsYou?: (itemId: string) => Promise<{ yes: boolean; reason: string | null } | null>;
  judge?: Judge;
  log: (m: string) => void;
  track?: Track;
  clock?: Clock;
};

/**
 * A row in Watching (`GET /api/rules`): a sentence built in code, and the time left; `note`, what the level changes, the
 * second line's start before the time left (stage 3.3); `ring`, whether it calls you, as things are now; `wouldRing`,
 * whether it would with Call me back on and a phone registered (its rule rings and the level lets it now), so a hold
 * for it may offer to turn Call me back on (Fable, 18 November): false for a pause's on Commute, and for any once
 * today's ring is used.
 *
 * Stage 5 (Fable's topics 1, 3 and 5): a watch the user asked for on named threads, by voice, a tap, Siri or the app
 * (`canChange`), has Change: its threads (`threadIds`), its card as the hold shows it, and its sheet.
 */
export type Watching = {
  id: string; said: string; note?: string; leftMs: number; until: number; ring: boolean; wouldRing: boolean; conversationId?: string;
  /**
   * Stage 4b (Fable's 4-D): a send or start for later, whose time is in its sentence, so the row shows no time left
   * (`timed`); no Stop while it's stopping or too late (`stop` false); greyed once stopped while its computer is offline.
   * `stopping`: stopped, its computer's answer still to come, so the phone reads Watching again until it has (4-E).
   */
  timed?: true; stop?: false; grey?: true; stopping?: true;
  canChange?: true; threadIds?: string[]; card?: Card; form?: Form;
};

/**
 * What the sheet sets (`PUT /api/rules/:id`, `POST /api/rules`; Fable's topic 3): each part only when given. `notBefore`:
 * an instant, or null for any time; `forMs`: how long from now it watches (one of the sheet's lengths).
 */
export type Choices = { when?: When; notBefore?: number | null; then?: Then; forMs?: number };

/** The card of a watch read back in a call and waiting for its yes (stage 5): beside `pending` in the call's snapshot. */
export type DraftCard = Card & { form: Form };

/**
 * A watch the sheet may change (Fable's topic 5): one the user asked for on named threads, by voice, a tap, Siri or the
 * app. Not starred threads at a goodbye, nor the call-back a hang-up set up by itself (a pause).
 */
export function changeable(w: Wait): boolean {
  const head = headOf(w);
  return !w.auto && head.ring && head.made.by === "user" && head.made.via !== "pause" && head.made.via !== "goodbye";
}

/** What a wait's mode waits for, as the card and the sheet say it. */
export function whenOfMode(m: Mode): Spec["when"] {
  return m.deadline !== undefined ? "deadline" : m.checkIn !== undefined ? "check" : m.tests ? "tests" : m.only === "failed" ? "fails" : m.only === "trouble" ? "trouble" : "replies";
}

/** The sheet's title (Fable, topic 3): the thread's name, or "3 threads". */
const sheetTitle = (threads: string[]) => (threads.length === 1 ? threads[0] : `${threads.length} threads`);

/** `callBackPlan`'s readback, waiting for a yes: what the call's card shows (stage 5). */
export type Readback = Extract<ReturnType<Engine["callBackPlan"]>, { say: "readback" }>;

/**
 * What `GET /api/account` says of Call me back (stage 3.3): whether this brain rings a phone at all, and the level's
 * day. `level`: the level's name for Settings' section, only to an account on that level's plan and only with a limit
 * (Fable, 18 November); null otherwise, and the section has no header.
 */
export type CallMeBack = { push: boolean; perDay: number | null; usedToday: boolean; level: LevelName | null };

const QUIET = new Set(["call", "ring", "notification", "kept"]);
/** A judged line's duty still to be checked (stage 3.5). */
const isJudged = (d: Duty) => d.judged === "needs_you" || d.judged === "judge";
/** How often a computer whose offline news can only be a notification is checked while it's up (§7, Offline checks). */
const NOTIFY_CHECK_MS = 15 * 60_000;
/** A push Apple hasn't answered in this long may or may not have gone: it's `unknown`, and the engine goes on. */
const PUSH_MS = 30_000;
/** How long a time read back for a yes (stage 3.8) is the one a yes to it agrees to. */
const ASKED_MS = 15 * 60_000;
/** The longest a briefing's notification waits for the briefing to be made ahead before it goes without (stage 4). */
export const MAKE_MS = 2 * 60_000;
/** A message typed at a computer this soon after Away was turned on is you leaving, not back (Fable, 3.9-D). */
export const LEAVING_MS = 10 * 60_000;
/** Away ended by your message with this long or more left is told with a sound, and asks to turn it on again (3.9-D). */
export const HOUR_LEFT_MS = 3600_000;
/**
 * Nobody reads a reply and types this soon after its run ended: a write dated sooner was typed while the run went and
 * dated when the work system took it (Codex's Tab, Pi's Enter and Alt+Enter, measured: dated as the reply ends), so it
 * isn't "you read the reply" (Fable on 3.9 and 3.10, 3.9-A: in doubt, tell). A quick reader's reply is told once more.
 */
export const READ_TAKES_MS = 15_000;

/** What a line's look found to fire: a question, a run's end (red, judged, batched), or example 2's project gone idle. */
type Fire = { item?: WorkItem; key: string; kind: "question" | "reply" | "idle"; red?: true; judged?: "needs_you" | "judge"; batched?: true };
/** Example 2: a project counts as idle once none of its threads has run or waited for 90 s (§3, `none_running`). */
export const IDLE_MS = 90_000;

/** Stage 3.5's keys: each line's reading by its text, the answers to their questions, today's reads, the judged checks. */
const READ_KEY = "rules_read";
const ANSWERS_KEY = "rules_answers";
const READS_KEY = "rules_reads";
const CHECKS_KEY = "rules_checks";
/**
 * Calls in your own words you allowed (engine.md §11, 3.5, "Allowing a call"), by the line's key: the reading's digest
 * you allowed, whether through the night, when, how (a tap in the app, or a spoken yes to the readback) and the question
 * as it was shown or said. Never in the file, never in a rule's params.
 */
const ALLOWED_KEY = "rules_allowed";
/**
 * Where a call in your own words that can't call shows in How I read: with what it does meanwhile (a notification tells,
 * the car line holds back, an unanswered question's call does nothing).
 */
/** What a call's sentence says holds it (reader.ts `sentenceOf`). */
const HELD_BACK = "Not while a hold-back rule or Quiet for a while is on.";
const quietSection = (r: Checked): Section => (r.on === "car" ? "holds" : r.on === "unanswered" ? "cant" : "tells");
export type Allowed = { reading: string; night: boolean; at: number; by: "app" | "voice"; said: string; tapped?: "Allow" | "Only by day" };
/** A judged line's check as kept (kv `rules_checks`, `checksKept`). */
type Check = { at: number; rule: string; r: "yes" | "no" | "unchecked" | "dropped"; calls?: number };
/** How many judged checks go at once, after a turn's other deliveries (the reviews of 3.5). */
const JUDGE_AT_ONCE = 3;
/** The most saves read a day per account (Fable, topic 11's daily reader limit), each one call over its changed lines. */
export const READS_PER_DAY = 20;
/** A turn that ended longer ago than this isn't judged (a brain asleep through it, a line just made): it's past. */
const JUDGE_STALE_MS = 10 * 60_000;

/**
 * Lines taken out of the file paired with lines put in where they were (a rewording), by order: the longest run the
 * two versions share is kept, and what each side has between two kept lines is paired in turn.
 */
export function reworded(before: string[], after: string[]): [string, string][] {
  const m = before.length, n = after.length;
  const lcs = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs: [string, string][] = [];
  let out: string[] = [], put: string[] = [];
  const flush = () => {
    for (let k = 0; k < Math.min(out.length, put.length); k++) pairs.push([out[k], put[k]]);
    out = [];
    put = [];
  };
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if (j < n && (i >= m || lcs[i][j + 1] >= lcs[i + 1][j])) put.push(after[j++]);
    else out.push(before[i++]);
  }
  flush();
  return pairs;
}

/**
 * When you last wrote in a thread yourself (`WorkItem.typed`, stage 3.9): `at`, at a computer or in T3 Code's phone app;
 * `desk`, at a computer; as instants, null for none. Nulls from a connector that doesn't say: nothing is taken as you
 * writing (Fable, 3.9-A: in doubt, not yours).
 */
export function typedOf(item: WorkItem | undefined): { at: number | null; desk: number | null } {
  const ms = (x: unknown) => (typeof x === "string" ? Date.parse(x) : NaN);
  const at = ms(item?.typed?.at), desk = ms(item?.typed?.desk);
  return { at: Number.isFinite(at) ? at : null, desk: Number.isFinite(desk) ? desk : null };
}

/**
 * A time `wait_for` was asked for (stage 3.8), as read back: what was said, what for, when it was read, the time it
 * names and whether as a time of day, the length asked for, and the time it will keep (`capped`: no later than the
 * level watches).
 */
type TimeAsked = { said: string; kind: "deadline" | "check"; made: number; at: number; clock: boolean; ms?: number; capped: number; guessed?: true };

export class Engine implements RingChannel {
  readonly observations: Observations;
  private readonly d: EngineDeps;
  private readonly clock: Clock;
  private readonly track: Track;
  private looking: Promise<void> | null = null;
  private again = false;
  private ticking: Promise<boolean> | null = null;
  private timer: Timer | null = null;
  private timerAt = Infinity;
  /** After a tick that threw: the backoff, and its timer isn't set before `retryAt` (§7, "No hot loops"). */
  private retry = 0;
  private retryAt = 0;
  /** Due times a tick left due: none wakes it again before its backoff (§7, "No hot loops"; util.ts `Stuck`). */
  private readonly stuck: Stuck;
  /** Reach-outs a holding phone may take: not looked at again before this. */
  private readonly deferred = new Map<string, number>();
  /** The threads as last seen, for a fact told in a call; `viewed`, once a look has seen them. */
  private items = new Map<string, WorkItem>();
  private viewed = false;
  /** Deliveries whose push this brain is waiting on now (`${channel}\n${key}`): recovery leaves these alone. */
  private readonly flying = new Set<string>();
  /**
   * Briefings being made ahead, by their reach-out, outside the engine's turn (the skeptic's and the review's finding on
   * 4-I: made inside it, every other notification and ring waited for the writer): when each began, and its promise.
   */
  private readonly making = new Map<string, { at: number; done: Promise<void> }>();
  /** A tests watch's mid-run pass whose run has ended, its report being read before a live call is told it (`toCall`). */
  private readonly endedReads = new Set<string>();
  /** A time read back for a yes, per conversation (stage 3.8): the yes agrees to that time. In memory only. */
  private readonly timesAsked = new Map<string, TimeAsked>();
  /** The zone the phone last sent (§7: the brain keeps the latest), for a not-before once its record has none. In memory. */
  private lastZone: string | null = null;
  /** Away's "Away ended" push while Apple answers (stage 3.9): looks and ticks wait for it, as tests do (`settled`). */
  private ending: Promise<void> | null = null;
  /** Closed (`close`): a demo world thrown away. */
  private closed = false;

  constructor(d: EngineDeps) {
    this.d = d;
    this.clock = d.clock ?? realClock;
    this.track = d.track ?? (() => {});
    this.observations = new Observations(d.store);
    this.stuck = new Stuck("engine", d.log, d.store, this.clock.now());
    this.recover();
    this.heardBefore();
    if (d.ringer) d.ringer.channel = this;
    // A call-back called off (the user's Stop, staying on, Stop in Watching, a thread unstarred out of it): what its
    // rule queued goes, so a later Call back from another notification never tells it.
    d.waits.calledOff = (w, itemId) => this.d.store.db.transaction(() => this.dropQueued(headOf(w).id, itemId));
    // A phone holding for a call-back takes its computer gone offline as it takes a reply (stage 3.7), and a held command
    // as it takes a question (stage 4c).
    d.waits.news = (conversationId) => !!this.offlineFor(conversationId) || !!this.heldFor(conversationId);
    // A thread's computer offline past its grace, by name: a thread working there as last seen isn't known to be (the
    // Skeptic's finding on 3.6 to 3.8).
    d.waits.offline = (itemId) => {
      const link = this.link(itemId);
      return offlineSince(link, this.clock.now()) !== null ? link!.machine : null;
    };
    d.waits.onChange(() => {
      this.fromWaits();
      this.soon();
    });
    // A zone change moves every not-before still ahead (`rezone`): what's due then is set again.
    this.lastZone = this.phoneZone();
    d.ringer?.onPhone(() => {
      this.lastZone = this.phoneZone() ?? this.lastZone;
      this.follow();
      if (this.rezone()) this.soon();
    });
    // What became of a send or a start for later, or a handover's window ending: told, or due, from now.
    d.later?.onNews(() => this.soon());
    this.follow();
    this.fromWaits();
    this.rezone();
    this.soon();
  }

  /** The account's level's limits now (§8): Long Haul's where none are given (Lattice). */
  limits(): Limits {
    return this.d.limits?.() ?? LIMITS["Long Haul"];
  }

  /** The live call, as the server knows it (server.ts sets it). */
  useCall(call: () => LiveCall | null) {
    this.d.call = call;
  }

  // --- following (stage 2a item 3) ---

  /** Following's rule, if it's made and this version reads it. */
  following(): FollowRule | null {
    const row = this.d.store.ruleRows().find((r) => r.id === FOLLOWING);
    if (!row) return null;
    try {
      const r = JSON.parse(row.rule);
      return validFollow(r) ? r : null;
    } catch {
      return null;
    }
  }

  /** Whether the phone record asks for notifications: on, with an alert token. */
  private alertPhone(): AlertPhone | null {
    const p = this.d.ringer?.record();
    return p?.alertToken && p.notifications === true ? { token: p.alertToken, env: p.env } : null;
  }

  /** Whether a notification can go now: a sender, and a phone with Notifications on. */
  notifies(): boolean {
    return !!this.d.notify && !!this.alertPhone();
  }

  /**
   * Following's rule follows the phone record: made when the phone says Notifications are on with an alert token; ended
   * when that stops (a DELETE of the alert token, Notifications off, another install replacing the record). Returns
   * whether it's on.
   */
  follow(): boolean {
    const wants = !!this.alertPhone();
    const had = this.d.store.ruleRows().some((r) => r.id === FOLLOWING);
    if (wants && !had) {
      // Its threads join at its making (`joining`): from the view as last seen, else at its first look (a brain just
      // started), so a reply from while it was gone isn't news.
      const now = this.clock.now();
      const rule = followRule(now);
      rule.state.joining = true;
      this.d.store.saveRule(FOLLOWING, rule);
      if (this.viewed) {
        // A question still open then is news (it still asks): its grace needs the timer.
        this.watchFollowed(rule, new Map([...this.items.values()].map((i) => [i.id, this.observations.question(i, now)])), now);
        this.soon();
      }
      this.d.log("engine: the threads you follow tell you when they reply or ask");
    } else if (!wants && had) {
      this.end(FOLLOWING);
      this.d.log("engine: the threads you follow no longer tell you anything");
    } else if (wants) {
      // Made before replies were told (stage 2a): it tells them now, from each thread's next reply (`Joined.ran`).
      const rule = this.following();
      if (rule && !rule.when.some((w) => w.on === "replied")) {
        this.d.store.saveRule(FOLLOWING, { ...rule, made: { ...rule.made, said: FOLLOWING_SAID }, when: [...rule.when, { on: "replied" }] });
        this.d.log("engine: the threads you follow tell you when they reply too");
      }
    }
    return wants;
  }

  /** A thread's own setting (follow.ts): the one it was given, else its default by its star. */
  private notifyFor(itemId: string, stars = this.d.store.stars()): ThreadNotify {
    return notifyOf(this.d.store.threadNotify(itemId), stars.has(itemId));
  }

  /**
   * A thread was followed, unfollowed or set by hand (tools.ts `setStar`, `setNotify`): following's rule takes it in, or
   * lets it go, by its setting now. From the change on: a question it has open then, or a reply it has, isn't news, and
   * its next is. One that tells you less now loses what following queued for it and hasn't sent (a question still in its
   * grace sends nothing; a reply gathering for the batch leaves it).
   */
  scoped(item: WorkItem) {
    const rule = this.following();
    if (!rule) return;
    const now = this.clock.now();
    const notify = this.notifyFor(item.id);
    const had = rule.state.items[item.id];
    if (!tellsQuestions(notify)) {
      delete rule.state.items[item.id];
      this.d.store.db.transaction(() => {
        if (had) this.d.store.saveRule(FOLLOWING, rule);
        this.dropQueued(FOLLOWING, item.id);
      });
      return;
    }
    const joined: Joined = had ?? { at: now, heard: this.observations.question(item, now) };
    joined.ran = this.ranNow(item, now);
    joined.running = item.status === "running";
    rule.state.items[item.id] = joined;
    this.d.store.db.transaction(() => {
      this.d.store.saveRule(FOLLOWING, rule);
      if (!tellsReplies(notify)) this.dropQueued(FOLLOWING, item.id, "reply");
    });
  }

  /** The key of the run `item` last finished, while it isn't running: its reply. Null for none known. */
  private ranNow(item: WorkItem, now: number): string | null {
    if (item.status === "running") return null;
    const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
    return runAt ? this.observations.run(item.id, runAt, now) : (this.observations.get(item.id).run?.key ?? null);
  }

  // --- looking at the view ---

  /** A machine reported a change: the engine looks now (one look at a time; one more if another report came meanwhile). */
  changed() {
    if (this.looking) {
      this.again = true;
      return;
    }
    this.looking = this.look()
      .catch((e) => this.d.log(`engine: couldn't look (${describe(e)})`))
      .finally(() => {
        this.looking = null;
        if (this.again) {
          this.again = false;
          this.changed();
        }
      });
  }

  /** Every look under way, finished (tests, and the alarm). */
  async settled() {
    while (this.looking || this.ticking || this.ending || this.making.size) await (this.looking ?? this.ticking ?? this.ending ?? [...this.making.values()][0].done);
  }

  private async look() {
    this.follow();
    const items = await this.d.adapter.list().catch(() => null);
    if (items) this.see(items, this.clock.now());
    this.soon();
  }

  /** The view as it is now: each thread's open question gets its fact's key, followed threads fire, answered questions go. */
  private see(items: WorkItem[], now: number) {
    this.items = new Map(items.map((i) => [i.id, i]));
    this.viewed = true;
    // A thread running again: its next run with no time is a new fact, not the last one's (observations.ts `run`).
    for (const i of items) if (i.status === "running") this.observations.run(i.id, 0, now, true);
    const keys = new Map(items.map((i) => [i.id, this.observations.question(i, now)]));
    this.followNew(items, now);
    const rule = this.following();
    if (rule) this.watchFollowed(rule, keys, now);
    this.watchWrote(keys, now);
    this.tidyReplies();
    this.movedOn(keys, now);
    this.watchHeld(now);
    this.watchAway(keys, now);
    this.watchLines(keys, now);
    this.seenByYou(now);
    this.watchOffline(now);
  }

  /**
   * Follow new threads, at Every new thread (follow.ts): each top-level thread started after it was chosen is followed,
   * once, from its start, so its first reply and question are news. Never one with a setting already (followed,
   * unfollowed or set by hand since), nor one whose start its work system doesn't say. Nobody tapped: no toast, and no
   * line in the Timeline.
   */
  private followNew(items: WorkItem[], now: number) {
    const f = followNewOf(this.d.store);
    if (f.choice !== "every" || f.at === undefined) return;
    const stars = this.d.store.stars();
    const set = this.d.store.threadNotifies();
    for (const i of items) {
      const started = i.createdAt ? Date.parse(i.createdAt) : NaN;
      if (i.parentId !== null || i.settled || stars.has(i.id) || set.has(i.id) || !(started > f.at)) continue;
      this.d.store.db.transaction(() => {
        this.d.store.star(i.id, true, { runAt: 0, question: null }, started);
        this.d.store.setThreadNotify(i.id, "both", now);
      });
      this.d.log(`engine: ${i.id} started after Every new thread was chosen; it's followed`);
    }
  }

  /**
   * Following's look, over the threads whose own setting tells you something: each you follow (Replies and questions
   * unless set otherwise), and each you don't that you set by hand to Replies and questions or Questions only. Each is
   * joined at its star, or when it was set: the question it had then (or one first seen before), and the reply it had
   * then, aren't news. Then it fires once for each question it asks after (input or approval), and with Replies and
   * questions once for each run it finishes after (a reply): a turn that ends on a question its work system holds open
   * is that question, never also a reply. Threads that no longer tell you anything leave.
   */
  private watchFollowed(rule: FollowRule, keys: Map<string, string | null>, now: number) {
    const stars = this.d.store.starsSeen();
    const times = this.d.store.starTimes();
    const set = this.d.store.threadNotifies();
    const starred = new Set(stars.keys());
    let changed = false;
    const rolledBack = !rule.state.items[ROLLBACK_MARK];
    if (rolledBack) {
      // Run by stage 2a since (a rollback: it took the mark away) or made by it: what it saw meanwhile isn't news, so each
      // thread takes the reply it has now as told, below, one 2a dropped (set by hand, not followed) joining again too.
      // The questions it told stay told (`heard`), and the replies already kept stay as they are.
      for (const joined of Object.values(rule.state.items)) {
        delete joined.ran;
        delete joined.running;
      }
      rule.state.items[ROLLBACK_MARK] = { at: now, heard: null };
      this.d.store.saveRule(FOLLOWING, rule);
      this.d.log("engine: following's rule was run by older code since; each thread's reply now is taken as told");
    }
    const fire: { item: WorkItem; key: string; kind: "question" | "reply"; via: Duty["via"] }[] = [];
    const scope = new Set([...stars.keys(), ...set.keys()]);
    for (const id of scope) {
      const notify = notifyOf(set.get(id)?.notify, starred.has(id));
      if (!tellsQuestions(notify)) continue;
      const item = this.items.get(id);
      if (!item || item.parentId !== null || item.settled) continue;
      const key = keys.get(id) ?? null;
      const seen = stars.get(id) ?? { runAt: 0, question: null };
      let joined = rule.state.items[id];
      if (!joined) {
        const at = starred.has(id) ? (times.get(id) ?? now) : set.get(id)!.at;
        const q = this.observations.get(id).question;
        const open = !!key && !!q && q.key === key && ((seen.question != null && q.id === seen.question) || q.seenAt <= at);
        // A reply from before the star is the one the star recorded as seen (`stars.seen_run_at`, `heard`), never news;
        // a run's own time isn't compared with the brain's clock. Joining a rule made after its star or setting (made
        // again after Notifications were off, or by a roll-forward), at the rule's first look (`joining`), or at the first
        // look after older code ran it, the reply it has then, however old, isn't news; a question still open then still
        // asks, and is.
        const told = rolledBack || (!!rule.state.joining && at < rule.made.at);
        joined = rule.state.items[id] = {
          at, heard: open ? key : seen.question != null ? this.observations.keyOf(id, seen.question, now) : null, ran: told ? this.ranNow(item, now) : null, running: item.status === "running",
        };
        changed = true;
      }
      const via = starred.has(id) ? "follow" : "set";
      // A held command is news of its own (Commands that wait, `watchHeld`), never also this thread's question.
      if (key && key !== joined.heard && !item.gate) fire.push({ item, key, kind: "question", via });
      const running = item.status === "running";
      if (joined.ran === undefined || !tellsReplies(notify) || item.pendingQuestion) {
        // Joined before replies were told, set to tell no replies, or asking a question its work system holds open: the
        // run it shows is taken as told. That turn is the question's, and a reply from before replies were on isn't news.
        const ran = this.ranNow(item, now) ?? joined.ran ?? null;
        if (ran !== joined.ran || running !== !!joined.running) {
          Object.assign(joined, { ran, running });
          changed = true;
        }
      } else if (running) {
        if (!joined.running) changed = joined.running = true;
      } else {
        // Stopped: its finished run is its reply. One that ends with no time of its own, seen running, gets its key now,
        // from when it was first seen to end (observations.ts `run`).
        const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
        const ran = runAt ? this.observations.run(id, runAt, now) : joined.running ? this.observations.run(id, 0, now) : null;
        if (ran && ran !== joined.ran) fire.push({ item, key: ran, kind: "reply", via });
        else if (joined.running) {
          joined.running = false;
          changed = true;
        }
      }
    }
    for (const id of Object.keys(rule.state.items)) {
      if (id === ROLLBACK_MARK) continue;
      if (!scope.has(id) || !tellsQuestions(notifyOf(set.get(id)?.notify, starred.has(id)))) {
        delete rule.state.items[id];
        changed = true;
      }
    }
    if (rule.state.joining) {
      delete rule.state.joining;
      changed = true;
    }
    for (const f of fire) {
      try {
        if (f.kind === "question") this.fireFollowed(rule, f.item, f.key, f.via, now);
        else this.fireReply(rule, f.item, f.key, f.via, now);
        changed = false;
      } catch (e) {
        // Neither the firing nor its reach-out was written: the next look sees it again and fires then.
        this.d.log(`engine: couldn't keep ${f.item.id}'s ${f.kind} (${describe(e)}); it's looked at again`);
        const fresh = this.following();
        if (!fresh) return;
        rule = fresh;
      }
    }
    if (changed) this.d.store.saveRule(FOLLOWING, rule);
  }

  /** §3's fire, one transaction: the rule's baseline moves past the fact, its count goes up, and its reach-out is written. */
  private fireFollowed(rule: FollowRule, item: WorkItem, key: string, via: Duty["via"], now: number) {
    const handle = this.nameOf(item);
    this.d.store.db.transaction(() => {
      rule.state.items[item.id].heard = key;
      rule.state.n++;
      this.d.store.saveRule(FOLLOWING, rule);
      this.addDuty(key, "question", this.newsOf(item, handle, "question"), { rule: FOLLOWING, via, ring: false, tell: true, urgency: "urgent", from: now }, undefined, now);
    });
    this.d.log(`engine: ${handle} asks something (${item.questionKind ?? "a question"}); ${via === "follow" ? "you follow it" : "you set it to notify you"}`);
  }

  /**
   * A followed thread's reply, fired as a question is, but batched (§3, Batching): the first after a quiet spell goes at
   * its grace, and one in the window it opens waits for its close with any others. A reply already heard (read out,
   * told in a call: the heard tables) isn't news. The thread's older replies not yet heard, which only following had,
   * go: one entry per thread, its newest, in the older one's place in the batch.
   */
  private fireReply(rule: FollowRule, item: WorkItem, key: string, via: Duty["via"], now: number) {
    const handle = this.nameOf(item);
    const news = this.newsOf(item, handle, "reply");
    if (this.heard(news)) {
      rule.state.items[item.id].ran = key;
      this.d.store.saveRule(FOLLOWING, rule);
      return;
    }
    this.d.store.db.transaction(() => {
      rule.state.items[item.id].ran = key;
      rule.state.items[item.id].running = false;
      rule.state.n++;
      this.d.store.saveRule(FOLLOWING, rule);
      // Its place in the batch is kept: the window the older reply opened isn't opened again.
      let from = now;
      for (const r of this.d.store.reachOuts()) {
        if (r.state !== "untold" || r.kind !== "reply" || r.key === key || r.news.itemId !== item.id || !r.duties.every((d) => d.rule === FOLLOWING)) continue;
        if (!this.d.store.deliveries(r.key).some((d) => QUIET.has(d.channel))) from = Math.min(from, r.duties[0].from);
        this.d.store.saveReachOut({ ...r, state: "dropped" });
      }
      this.addDuty(key, "reply", news, { rule: FOLLOWING, via, ring: false, tell: false, urgency: "batched", from }, undefined, now);
    });
    this.d.log(`engine: ${handle} replied; ${via === "follow" ? "you follow it" : "you set it to notify you"}`);
  }

  /** Whether the user heard a reply already: its run is one the heard tables say was told (a call, a reading, a star's). */
  private heard(news: News): boolean {
    const runAt = news.seen.runAt;
    if (!runAt) return false;
    return (this.d.store.starsSeen().get(news.itemId)?.runAt ?? 0) >= runAt || this.d.store.heardAll(news.itemId).some((s) => s.runAt >= runAt);
  }

  /**
   * Following's replies not yet told, as they stand now: one the user heard is told; one whose thread now asks a
   * question (its notification is the news), or is set to tell no replies, leaves the batch (following's part goes).
   */
  private tidyReplies() {
    const stars = this.d.store.stars();
    for (const r of this.d.store.reachOuts()) {
      // A line's reply in the batch (stage 3.5), heard meanwhile, is told too.
      if (r.state === "untold" && r.kind === "reply" && !r.news.idle && r.duties.some((d) => d.via === "rule" && d.urgency === "batched") && this.heard(r.news)) {
        this.told(r.key);
        continue;
      }
      if (r.state !== "untold" || r.kind !== "reply" || !r.duties.some((d) => d.rule === FOLLOWING)) continue;
      if (this.heard(r.news)) {
        this.told(r.key);
        continue;
      }
      if (!tellsReplies(this.notifyFor(r.news.itemId, stars)) || this.items.get(r.news.itemId)?.pendingQuestion) this.dropQueued(FOLLOWING, r.news.itemId, "reply", r.key);
    }
  }

  private nameOf(item: WorkItem) {
    return this.d.name?.(item) ?? item.title;
  }

  private newsOf(item: WorkItem, handle: string, kind: ReachOut["kind"]): News {
    const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
    return {
      itemId: item.id, handle, ...(item.machine ? { machine: item.machine } : {}),
      ...(kind === "question" ? { question: { id: item.questionId ?? null, kind: item.questionKind ?? null } } : {}),
      seen: { runAt, question: kind === "question" ? (item.questionId ?? null) : null },
      // A followed thread's failed or stopped run is told as a reply is, worded by its status (stage 3.6).
      ...(kind === "reply" && (item.status === "failed" || item.status === "cancelled") ? { status: item.status === "cancelled" ? ("stopped" as const) : ("failed" as const) } : {}),
    };
  }

  /**
   * A rule's duty on the reach-out of fact `key`: the reach-out is written with it if it's new, else the duty is added
   * (two rules seeing one fact share one reach-out). Its news never changes after.
   */
  private addDuty(key: string, kind: ReachOut["kind"], news: News, duty: Duty, conversationId: string | undefined, now: number): ReachOut {
    const had = this.d.store.reachOut(key);
    if (had) {
      if (had.duties.some((d) => d.rule === duty.rule)) return had;
      const r: ReachOut = { ...had, duties: [...had.duties, duty], ...(conversationId && !had.conversationId ? { conversationId } : {}) };
      this.d.store.saveReachOut(r);
      return r;
    }
    const r: ReachOut = { v: 1, key, at: now, kind, news, duties: [duty], state: "untold", keepUntil: now + NEWS_MS, ...(conversationId ? { conversationId } : {}) };
    this.d.store.saveReachOut(r);
    return r;
  }

  /**
   * A question no longer asked (answered at the computer, by a tap, in a call, or gone): its untold news is dropped,
   * never told stale, and a notification that went for it is replaced by a quiet "Already answered.".
   */
  private movedOn(keys: Map<string, string | null>, now: number) {
    for (const r of this.d.store.reachOuts()) {
      if (r.kind !== "question" || keys.get(r.news.itemId) === r.key) continue;
      // Missing from the list, it's gone only if its computer is connected (deleted or archived there); one whose
      // computer isn't (asleep, offline, not heard from since a restart) may still be asking: its news is kept.
      if (!this.items.has(r.news.itemId) && !this.reachable(r.news.itemId)) continue;
      if (r.state === "untold" && r.tapped) {
        // Answered by a tap whose own answer hasn't come yet (the computer's report came first): the user had it.
        this.d.store.saveReachOut({ ...r, state: "told" });
        this.spent(r);
      } else if (r.state === "untold") {
        this.d.store.saveReachOut({ ...r, state: "dropped" });
        this.d.log(`engine: ${r.news.handle}'s question was answered or went; its news is dropped`);
        this.track("news_dropped", { what: "answered" });
        this.spent(r);
      }
      // Tapped: the phone's own line after the tap is in its notification's place already, and this would overwrite
      // it. Grouped: its notification was about several threads, under another collapse id; this would stand alone.
      if (r.tapped || r.grouped) continue;
      // Once: an earlier build's background push for it (`removal`) counts, so nothing answered before is replaced.
      const sent = this.d.store.deliveries(r.key);
      if (sent.some((d) => d.channel === "notification" && (d.state === "accepted" || d.state === "unknown")) && !sent.some((d) => d.channel === "answered" || d.channel === "removal")) void this.replace(r, now);
    }
  }

  /**
   * You wrote in a thread yourself, at a computer or in T3 Code's phone app (stage 3.9; Fable's 3.9-B): you read it up to
   * there, so its news from before still untold (a reply, a failure, a stop whose run ended before you wrote) is dropped,
   * whatever was holding it (a not-before, following's batch, the next call, the ring's grace), with nothing said or shown,
   * and a call-back over with nothing else left to tell goes with it (`spent`). Never news after it, nor a run still going
   * as you wrote (you hadn't seen its reply), nor a write dated within `READ_TAKES_MS` of the run's end (typed while it
   * went, dated when taken). A notification already on the lock screen stays as it is. 10 & 2's own sends and what
   * nobody typed never count: the connector leaves them out of `typed`.
   */
  private seenByYou(now: number) {
    for (const r of this.d.store.reachOuts()) {
      if (r.state !== "untold" || r.kind !== "reply" || r.news.still || r.news.check || r.news.brief) continue;
      const at = typedOf(this.items.get(r.news.itemId)).at;
      const runAt = r.news.seen.runAt;
      if (at === null || !runAt || at <= runAt + READ_TAKES_MS || at > now + 60_000) continue;
      this.d.store.saveReachOut({ ...r, state: "dropped" });
      this.d.log(`engine: ${r.news.handle}'s news is from before you wrote in it; dropped`);
      this.track("news_dropped", { what: "wrote" });
      this.spent(r);
    }
  }

  /** Whether the computer holding `itemId` is connected, so the list speaks for it. */
  private reachable(itemId: string): boolean {
    try {
      return this.d.adapter.connected(itemId);
    } catch {
      return false;
    }
  }

  /**
   * The answered question's notification replaced, under its own collapse id, by a quiet "Already answered." (§11,
   * Answered elsewhere): once per question. What became of it is logged either way (not sent, or Apple's answer), so
   * "never sent" can be told from "Apple dropped it".
   */
  private async replace(r: ReachOut, now: number) {
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "answered", state: "sending", at: now })) return;
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) {
      // Notifications were turned off (or another install took the record) since its notification went: nothing to send.
      this.d.store.updateDelivery({ key: r.key, channel: "answered", state: "refused", at: now });
      this.d.log(`engine: ${r.news.handle}'s answered question: not replaced, no phone takes notifications now`);
      return;
    }
    this.flying.add(`answered\n${r.key}`);
    const result = await this.pushed(this.d.notify(phone, answeredOf(r, privacyOf(this.d.store))));
    this.flying.delete(`answered\n${r.key}`);
    this.d.store.updateDelivery({ key: r.key, channel: "answered", state: result === "sent" ? "accepted" : result === "gone" ? "gone" : result === "unknown" ? "unknown" : "refused", at: now });
    this.d.log(`engine: ${r.news.handle}'s answered question: replaced by "Already answered." (${result === "failed" ? "refused" : result})`);
    if (result === "gone") this.d.ringer?.forgetAlert(phone.token);
  }

  // --- Commands that wait (§11 stage 4; Fable's 4-H2, 4-H3) ---

  /**
   * The held command `r` is news of, while its thread still holds it: a held command's own reach-out (kind `held`), or a
   * question that is a hold (its id the hold's: Away's, which sends nothing of its own; a call-back's never ends on one,
   * waits.ts `settle`, and rings for it as its own news, `ringHeld`). Null otherwise, or once it's over.
   */
  private heldOf(r: ReachOut): HeldCommand | null {
    if (r.kind !== "held" && r.kind !== "question") return null;
    const item = this.items.get(r.news.itemId);
    if (!item?.gate || !r.news.question?.id || item.questionId !== r.news.question.id) return null;
    return r.news.held ?? { command: item.gate.command, matched: item.gate.matched, since: Date.parse(item.gate.since) || r.at };
  }

  /**
   * A thread's line while it holds a command for the user (Fable's ruling on pass B1's review): where a watch that ran
   * out or a check-in would say it's still working, it's waiting for them, said as its hold is told (4-H3's `heldSaid`,
   * the same words, so a call tells it once). Null once it holds none.
   */
  heldLine(itemId: string): string | null {
    const item = this.items.get(itemId);
    return item?.gate && item.questionId ? heldSaid(this.nameOf(item), item.gate.matched, item.machine ?? "your computer", this.computers()) : null;
  }

  /**
   * Each command a computer holds is news once (key `held:<thread>:<hold>`), on every level, from any thread: it's on
   * the user's own list there. One that ended is marked so, with how (let run or stopped from the phone, told no after 6
   * hours, or anywhere else), and a notification that went for it is replaced by the line that says so, once. A thread
   * whose computer can't be reached now may still hold it: nothing is decided.
   */
  private watchHeld(now: number) {
    for (const item of this.items.values()) {
      if (!item.gate || !item.questionId || item.parentId !== null || this.d.store.reachOut(`held:${item.id}:${item.questionId}`)) continue;
      this.holdOf({ ...item, gate: item.gate, questionId: item.questionId }, now);
      this.d.log(`engine: ${this.nameOf(item)} holds a command on its computer's list`);
    }
    for (const r of this.d.store.reachOuts()) {
      if (r.kind !== "held" || r.ended || !r.news.held) continue;
      const item = this.items.get(r.news.itemId);
      if (item?.gate && item.questionId === r.news.question?.id) continue;
      if (!item && !this.reachable(r.news.itemId)) continue;
      const end: HeldEnd = r.answer ? (r.answer.run ? "run" : "stop") : now >= r.news.held.since + HELD_MS - 60_000 ? "timeout" : "elsewhere";
      const deliveries = this.d.store.deliveries(r.key);
      const sent = deliveries.some((d) => d.channel === "notification" && (d.state === "accepted" || d.state === "unknown"));
      // Told no after 6 hours goes on Road Trip's and Long Haul's limits whenever the hold was told, by any channel (a
      // call too: Fable's review of stage 4), not only in a notification's place.
      const told = sent || r.state === "told" || deliveries.some((d) => d.channel === "call" && d.state === "accepted");
      this.d.store.saveReachOut({ ...r, ended: { at: now, end }, state: r.state === "untold" ? "dropped" : r.state });
      this.d.log(`engine: ${r.news.handle}'s held command is over (${end})`);
      if (sent || (end === "timeout" && told && this.limits().heldNotes)) void this.heldOver(r, r.news.held, end, now);
    }
  }

  /** A held command's reach-out (kind `held`), written now. */
  private holdOf(item: WorkItem & { gate: NonNullable<WorkItem["gate"]>; questionId: string }, now: number, state: ReachOut["state"] = "untold"): ReachOut {
    const held: HeldCommand = { command: item.gate.command, matched: item.gate.matched, since: Date.parse(item.gate.since) || now };
    const news: News = { itemId: item.id, handle: this.nameOf(item), ...(item.machine ? { machine: item.machine } : {}), question: { id: item.questionId, kind: "input" }, seen: { runAt: 0, question: item.questionId }, held };
    const r = this.addDuty(`held:${item.id}:${item.questionId}`, "held", news, { rule: HELD_RULE, via: "list", ring: false, tell: true, urgency: "urgent", from: now }, undefined, now);
    // Each call-back watching the thread, asked about and still open, may call for it (Fable's ruling on pass B1's review);
    // one held back to a not-before from then (`rezone`), when it rings if the thread still holds it (`heldLater`).
    for (const w of this.d.waits.all()) {
      const head = headOf(w);
      if (w.ready || !head.ring || !w.items.some((i) => i.itemId === item.id && i.asked !== false)) continue;
      const pause = head.made.via === "pause" ? { pause: true as const } : {};
      this.addDuty(r.key, "held", news, { rule: head.id, via: "callback", ring: false, calls: true, tell: false, urgency: "urgent", from: now, ...pause }, w.conversationId, now);
    }
    if (state !== "untold" && r.state === "untold") this.d.store.saveReachOut({ ...r, state });
    return this.d.store.reachOut(r.key) ?? r;
  }

  /**
   * A held command's notification (Road Trip's and Long Haul's limits), and its line in a call. In a call it's told
   * there, and on those limits its notification goes at once too: the call's "It's on your phone for when you can look"
   * points at it (Fable's 4-H3), and its end's line replaces it. On Commute's, nothing is sent: the app shows it on its
   * thread, and it's told in the next call.
   */
  private async deliverHeld(r: ReachOut, held: HeldCommand, now: number) {
    const [channel] = reach(dueNow(r, now), this.situation(r, now));
    // Call me back rings for it, once (`ringHeld`), else a line that calls for a question, as the hold (`ringHeldLine`):
    // on Commute's limits that's all of it, and a missed ring its note.
    const rang = channel !== "call" && ((await this.ringHeld(r, now)) || (await this.ringHeldLine(r, now)));
    const phone = this.alertPhone();
    // A call-back a hold-back line or Quiet for a while kept from ringing: its notification in the ring's place, on
    // Commute's limits too (example 8's "What would have called comes as a notification"; the combinations review of
    // pass B2).
    const notes = (this.limits().heldNotes || (!rang && channel !== "call" && this.heldBack(r, now) && this.notifies())) && !!phone;
    if (channel === "call") {
      this.toCall(r, now);
      if (!notes) return;
    } else if (!notes) {
      if (rang) return;
      this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      this.d.log(`engine: ${r.news.handle}'s held command is on its thread in the app, and kept for the next call`);
      return;
    }
    const privacy = privacyOf(this.d.store);
    const shown = heldNoteOf(r, held, { names: privacy.names, computers: this.computers(), asks: privacy.asks });
    // In the car under a car line, silent (Fable's ruling on pass B2's review): it's on the phone for when you can look.
    const { sound: _, ...silent } = shown;
    const note: Note = this.holdNow(now).by === "car" ? { ...silent, interruption: "passive" } : shown;
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now })) return;
    this.flying.add(`notification\n${r.key}`);
    await this.sent([r.key], phone!, note, now);
  }

  /**
   * Call me back rings for a held command on a thread it watches, as for a question (Fable's ruling on pass B1's
   * review): once per hold, "API is waiting for you" ("A thread is waiting for you" with names hidden), into its
   * conversation, whose answer opens with the hold's line (server.ts `heldReply`). The wait goes on and still rings for
   * the reply after, as for a computer gone offline (stage 3.7): it can ring twice. Not when it may not ring now (agreed
   * to as a notification, only for a failure, held back to a not-before, which rings then, `heldLater`, or a check-in's
   * time, the level's rings), nor for a phone holding for it, which takes it (`heldFor`). Whether it rang.
   */
  private async ringHeld(r: ReachOut, now: number): Promise<boolean> {
    const w = this.d.ringer?.canRing() ? this.callsFor(dueNow(r, now), now) : null;
    if (!w) return false;
    if (this.d.ringer!.holdingFor(now).includes(w.conversationId)) {
      this.d.waits.wake();
      return false;
    }
    const at = this.clock.now();
    const claimed = this.d.store.db.transaction(() => {
      if (this.d.waits.get(w.conversationId) !== w || !this.offlineCalls(w, at) || !this.d.store.attemptDelivery({ key: r.key, channel: "ring", state: "sending", at })) return false;
      const fresh = this.d.store.reachOut(r.key);
      if (fresh) this.d.store.saveReachOut({ ...fresh, rangFor: w.conversationId });
      return true;
    });
    if (!claimed) return false;
    this.flying.add(`ring\n${r.key}`);
    const caller = waitingCaller(r.news.handle, privacyOf(this.d.store).names);
    const result = await this.d.ringer!.call(w.conversationId, caller);
    this.d.log(`engine: rang "${caller}" for ${w.conversationId}: ${result}`);
    this.rang([r.key], result, this.clock.now());
    return true;
  }

  /**
   * A line that calls for a question calls for a hold as it does for one, but as the hold (Fable's ruling on pass B2's
   * review): example 9's while driving, and one in your own words that calls when an agent asks (stage 3.5). "API is waiting for you", into no conversation, its push naming the hold, whose
   * call-back opens with the hold's line; missed, "You missed a call" with the rule as why, only where no held
   * notification went. The question a line made of it never rings (`heldOf`). Whether it rang.
   */
  private async ringHeldLine(r: ReachOut, now: number): Promise<boolean> {
    // A line's own call for a question (stage 3.5, `fireLine`), else the car's.
    const car = this.lineOf(9);
    if (this.lineCalls(r, now)) await this.ringLine([r], now);
    else if (car && this.carRings(r, now)) await this.ringLine([r], now, { rule: car.id, via: "rule", ring: false, calls: true, tell: false, urgency: "urgent", from: now, said: car.made.said });
    else return false;
    return this.d.store.deliveries(r.key).some((d) => d.channel === "ring");
  }

  /**
   * Whether a call-back would ring for this hold now but for a hold-back line or Quiet for a while (stage 3.4): watching
   * the thread, may call for it, Call me back on and the level letting it ring.
   */
  private heldBack(r: ReachOut, now: number): boolean {
    if (!this.d.ringer?.canRing()) return false;
    return dueNow(r, now).duties.some((d) => {
      const w = d.calls && d.via === "callback" ? this.waitOf(d.rule) : undefined;
      return !!w && !w.ready && !w.mode?.notify && w.mode?.only !== "failed" && this.heldUntil(w) <= now && headOf(w).ring && this.levelAllows(w, now) && !this.ringsThrough(now, { anyway: !!w.mode?.anyway });
    });
  }

  /**
   * Held commands a call-back's not-before kept it from ringing for as they came (Fable's ruling on pass B2's review):
   * still held and untold, sent or kept then, with nothing rung or told in a call for them since, the call-back still
   * watching. Then it rings, "API is waiting for you", as for a question still open (stage 3.6). Not a check-in's: it
   * tells the hold at its time (`heldLine`). `from`: its not-before.
   */
  private heldLater(now: number): { r: ReachOut; from: number }[] {
    return this.d.store.reachOuts().flatMap((r) => {
      if (r.kind !== "held" || r.state !== "untold") return [];
      const ds = this.d.store.deliveries(r.key);
      if (!ds.length || ds.some((d) => d.channel === "ring" || d.channel === "call")) return [];
      const first = Math.min(...ds.map((d) => d.at));
      const d = r.duties.find((x) => x.calls && x.via === "callback" && x.from > first);
      const w = d ? this.waitOf(d.rule) : undefined;
      return d && w && !w.ready && w.mode?.checkIn === undefined ? [{ r, from: d.from }] : [];
    });
  }

  /**
   * The held commands a call-back in `conversationId` opens with (Fable's ruling on pass B1's review): each untold and
   * still held that it rang for, or that its call-back may call for (a phone holding for it, `heldFor`).
   */
  heldIn(conversationId: string): ReachOut[] {
    return this.d.store.reachOuts().filter((r) => r.kind === "held" && r.state === "untold" && !!this.heldOf(r)
      && (r.rangFor === conversationId || r.duties.some((d) => d.calls && this.waitOf(d.rule)?.conversationId === conversationId)));
  }

  /** A held command a phone holding for this call-back takes once its grace is over, as it takes a question. */
  heldFor(conversationId: string): ReachOut | null {
    const now = this.clock.now();
    return this.heldIn(conversationId).find((r) => dueOf(r) <= now && !!this.callsFor(dueNow(r, now), now, true, conversationId)) ?? null;
  }

  /** The line in a held command's notification's place once it's over: once (its `answered` delivery). */
  private async heldOver(r: ReachOut, held: HeldCommand, end: HeldEnd, now: number) {
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "answered", state: "sending", at: now })) return;
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) {
      this.d.store.updateDelivery({ key: r.key, channel: "answered", state: "refused", at: now });
      return;
    }
    this.flying.add(`answered\n${r.key}`);
    // Inside the night line or Quiet for a while, silent (the combinations review of pass B2).
    const privacy = privacyOf(this.d.store);
    const result = await this.pushed(this.d.notify(phone, this.quietened(heldOverOf(r, held, end, { names: privacy.names, computers: this.computers(), now, asks: privacy.asks }), now)));
    this.flying.delete(`answered\n${r.key}`);
    this.d.store.updateDelivery({ key: r.key, channel: "answered", state: result === "sent" ? "accepted" : result === "gone" ? "gone" : result === "unknown" ? "unknown" : "refused", at: now });
    if (result === "gone") this.d.ringer?.forgetAlert(phone.token);
  }

  /**
   * The phone's answer to a held command is on its way (`POST /api/held`): kept on its reach-out first, so the hold's end
   * seen meanwhile says how it ended. `undo` takes it back when the computer didn't take it.
   */
  answeringHold(item: WorkItem, questionId: string, run: boolean, how: "faceid" | "unlocked" | undefined): () => void {
    const key = `held:${item.id}:${questionId}`;
    // The phone saw it before this brain's look did (its list is the briefing's): it's written now, the user having it.
    if (!this.d.store.reachOut(key) && item.gate && item.questionId === questionId) this.holdOf({ ...item, gate: item.gate, questionId }, this.clock.now(), "told");
    return answering(this.d.store, item.id, questionId, run, how, this.clock.now());
  }

  // --- call-backs' news (the waits) ---

  /**
   * Each wait that's over adds its duty to the reach-out of every fact it has news of: one for each reply or question
   * (a thread gone from the list isn't news). Only a call-back the user asked for rings, and only for a thread they
   * asked about (`Watched.asked`); none tells by notification in stage 2 (that's following's, and 3.1's replies).
   * A reply is named once, as its duty is written (§3's fire, kept in the store): never again from the thread as it is
   * now, which would make one with no id (a run with no time, a question with none) a second fact once it runs again.
   */
  private fromWaits(now = this.clock.now()) {
    const all = this.d.store.reachOuts();
    for (const w of this.d.waits.all()) {
      if (!w.ready) continue;
      const head = headOf(w);
      // A held command it may call for (stage 4c) names no reply: the one after is its news too.
      const named = new Set(all.filter((x) => x.kind !== "held" && x.duties.some((d) => d.rule === head.id)).map((x) => x.news.itemId));
      // What rings (ring.ts `ringingNews`): never news from a watch that ran out, unless it was only for trouble.
      const ringing = new Set(ringingNews(w).map((r) => r.itemId));
      // Not before its not-before, on the phone's clock (stage 3.6): every duty of its news is due from then.
      const from = Math.max(w.readyAt ?? now, notBeforeAt(w, this.notBeforeZone(w)) ?? 0);
      // Agreed to as a notification (`notify`), or a long watch's news that ran out: it tells by notification.
      const tell = !!w.mode?.notify || (head.ring && stillWorking(w).length > 0 && watchedLong(w));
      // A pause's call-back (set up by the hang-up, not asked for in words) says so: it never takes Commute's ring.
      const pause = head.made.via === "pause" ? { pause: true as const } : {};
      // A check-in (stage 3.8): one fact for its time, how each thread stands then, whatever that is; its threads' own
      // replies and questions aren't facts of its own (one call, one notification, "As of 15:00.").
      const checkIn = w.mode?.checkIn;
      if (checkIn !== undefined) {
        const told = w.replies.filter((r) => !r.gone);
        const key = `${head.id}:at:${checkIn}`;
        if (head.ring && told.length && !this.d.store.reachOut(key)?.duties.some((d) => d.rule === head.id)) {
          const news: News = {
            itemId: told[0].itemId, handle: told[0].handle, seen: { runAt: 0, question: null },
            check: { at: checkIn, standing: told.map((r) => ({ itemId: r.itemId, handle: r.handle, state: standingOf(r), ...(r.offline ? { offline: r.offline } : {}) })), total: w.items.length, waitedMs: head.lifetime.watchMs },
          };
          const ring = ringing.size > 0;
          this.addDuty(key, "reply", news, { rule: head.id, via: "callback", ring, tell: !ring, urgency: ring ? "urgent" : "normal", from, ...pause }, w.conversationId, now);
        }
        if (w.rungAt !== undefined) this.rungBefore(w, w.rungAt);
        continue;
      }
      for (const r of w.replies) {
        if ((r.outcome !== "finished" && r.outcome !== "question" && r.outcome !== "failed") || r.gone || named.has(r.itemId)) continue;
        const question = r.outcome === "question";
        // A tests watch's pass mid-run (stage 3.10) is no run's end: a fact of its own, once per watch, that marks no
        // reply heard and that nothing you write before it drops.
        const key = r.midRun ? `${head.id}:pass:${r.itemId}` : question ? this.observations.keyOf(r.itemId, r.seen.question, now) : this.observations.run(r.itemId, r.seen.runAt, now);
        const had = this.d.store.reachOut(key);
        if (had?.duties.some((d) => d.rule === head.id)) continue;
        const item = this.items.get(r.itemId);
        const news: News = {
          itemId: r.itemId, handle: r.handle, ...(item?.machine ? { machine: item.machine } : {}), ...(question ? { question: { id: r.seen.question, kind: item?.questionKind ?? null } } : {}), seen: r.seen,
          ...(r.outcome === "failed" ? { status: r.stopped ? ("stopped" as const) : ("failed" as const) } : {}),
          // What its tests did, from the computer (stage 3.10), as its wait decided.
          ...(r.tests ? { tests: r.tests } : {}),
        };
        const ring = head.ring && ringing.has(r.itemId);
        this.addDuty(key, question ? "question" : "reply", news, { rule: head.id, via: "callback", ring, tell: tell && r.asked !== false, urgency: ring ? "urgent" : "normal", from, ...pause }, w.conversationId, now);
      }
      // A long watch, or one with a mode, that ran out with threads still working (Fable, topic 7): one fact for the
      // wait, told once; a call only when it was only for trouble, else a notification.
      // One whose computer was offline then isn't known to be still working (the Skeptic's finding on 3.6 to 3.8): it's
      // named last, with its computer, and never rings for it (`ringingNews`). One done since a deadline it missed (the
      // fourth review of 3.6 to 3.8) before it, after those still working.
      const order = (r: Wait["replies"][number]) => (r.offline ? 2 : r.late ? 1 : 0);
      const still = stillWorking(w).filter((r) => !r.gone).sort((a, b) => order(a) - order(b));
      if (still.length && watchedLong(w) && head.ring && !named.has(still[0].itemId)) {
        const key = `${head.id}:still`;
        if (!this.d.store.reachOut(key)?.duties.some((d) => d.rule === head.id)) {
          // A deadline (stage 3.8): every thread not still working by then is done ("1 of 3 threads are done"), and it
          // says the time ("Not done by 18:00.").
          const deadline = w.mode?.deadline;
          // Done since a deadline it missed, looked at late (the fourth review of 3.6 to 3.8): done now, not working.
          const late = still.filter((r) => r.late).map((r) => r.handle);
          const done = deadline !== undefined ? w.items.length - still.length + late.length : w.replies.filter((r) => r.outcome === "finished").length;
          const offline = still.flatMap((r) => (r.offline ? [{ handle: r.handle, machine: r.offline }] : []));
          // Holding a command for the user (Commands that wait): waiting for them, not still working (Fable's ruling on
          // pass B1's review).
          const held = still.flatMap((r) => (r.held ? [{ itemId: r.itemId, handle: r.handle }] : []));
          const news: News = {
            itemId: still[0].itemId, handle: still[0].handle, seen: { runAt: 0, question: null },
            still: { working: still.map((r) => r.handle), done, total: w.items.length, waitedMs: head.lifetime.watchMs, ...(deadline !== undefined ? { by: deadline } : {}), ...(offline.length ? { offline } : {}), ...(late.length ? { late } : {}), ...(held.length ? { held } : {}), ...(w.mode?.tests ? { tests: true as const } : {}) },
          };
          const ring = still.some((r) => ringing.has(r.itemId));
          this.addDuty(key, "reply", news, { rule: head.id, via: "callback", ring, tell: !ring, urgency: ring ? "urgent" : "normal", from, ...pause }, w.conversationId, now);
        }
      }
      if (w.rungAt !== undefined) this.rungBefore(w, w.rungAt);
    }
  }

  /**
   * A call-back's not-before is a clock time read in the phone's zone of the moment (§7; the fourth review of 3.6 to
   * 3.8), not the zone its news came in: each untold reach-out's duty for a call-back with one is due from that time as
   * read now, so a flight between the news and the time moves it, a notification's as much as a call's. Run as the zone
   * changes, as the engine starts and before each delivery. Following's duties, and a call-back without a not-before,
   * never move; nor one with no zone to read it in (`notBeforeZone`): a duty keeps the time it had, held if a zone was
   * known as its news came. Returns whether any moved.
   */
  private rezone(): boolean {
    let moved = false;
    for (const r of this.d.store.reachOuts()) {
      if (r.state !== "untold") continue;
      const duties = r.duties.map((d) => {
        const w = d.via === "callback" ? this.waitOf(d.rule) : undefined;
        const zone = w?.mode?.notBefore ? this.notBeforeZone(w) : null;
        if (!w || !zone) return d;
        // As `fromWaits` and `fireOffline` set it: from the news (the wait over, the computer gone), its check-in.
        const offline = r.kind === "offline";
        const from = Math.max(offline ? r.at : (w.readyAt ?? r.at), notBeforeAt(w, zone) ?? 0, offline ? (w.mode?.checkIn ?? 0) : 0);
        return from === d.from ? d : { ...d, from };
      });
      if (duties.some((d, i) => d !== r.duties[i])) {
        this.d.store.saveReachOut({ ...r, duties });
        moved = true;
      }
    }
    return moved;
  }

  /**
   * Where call-back `w`'s not-before is read for the engine's duties (`fromWaits`, `rezone`, `heldUntil`) and `dealt`
   * (§7, Time zones): the phone's zone now; with none on its record (another install registered without one), the last
   * one it sent while this brain has run, else its threads' computer's (the Skeptic's finding on the fourth review of
   * 3.6 to 3.8: a notification held until noon went at once). Null with none of them: news arriving then isn't held for
   * its not-before (after a restart with no zone anywhere, it goes at once, as before). The Ringer's own hold for a call
   * and `/api/wait`'s read only the record's zone.
   */
  private notBeforeZone(w: Wait): string | null {
    return this.phoneZone() ?? this.lastZone ?? w.items.map((i) => validZone(this.d.adapter.timeZone?.(i.itemId))).find((z) => z !== null) ?? null;
  }

  /** The call-back wait whose rule is `id`, if it's still here. */
  private waitOf(id: string): Wait | undefined {
    return this.d.waits.all().find((w) => headOf(w).id === id);
  }

  /**
   * An old wait's `rungAt` reads as a ring delivery: one rung before stage 2, or by an older brain after a rollback, has
   * the marker and no ring rows (this brain writes both in one transaction, ring.ts). Each of its facts with no ring row
   * gets one whose outcome is unknown (§3's recovery), at the time it rang, so it's never rung again and its call-back is
   * missed 75 s after it (`MISSED_MS`), with its notification. A row there already, this brain's own, stays as it is.
   */
  private rungBefore(w: Wait, rungAt: number) {
    const keys = this.keysOf(w).filter((k) => !this.d.store.deliveries(k).some((d) => d.channel === "ring"));
    if (!keys.length) return;
    this.d.store.db.transaction(() => {
      for (const key of keys) this.d.store.attemptDelivery({ key, channel: "ring", state: "unknown", at: rungAt, missedAt: rungAt + MISSED_MS });
    });
    this.d.log(`engine: wait ${w.conversationId} rang before its ring was written as a delivery; it's read as one whose outcome is unknown`);
  }

  /**
   * The facts a wait has news of: the reach-outs its rule has a duty on. Not a computer gone offline while it watched
   * (stage 3.7), nor a held command (stage 4c): that's news inside the call-back, which goes on, never its end
   * (`offlineOf`, `ringHeld`).
   */
  private keysOf(w: Wait): string[] {
    const id = headOf(w).id;
    return this.d.store.reachOuts().filter((r) => r.kind !== "offline" && r.kind !== "held" && r.duties.some((d) => d.rule === id)).map((r) => r.key);
  }

  /**
   * Whether a ring rule's duty on `r` can still ring: its wait is there, still the conversation's own, rings, and the
   * level lets it now.
   */
  private ringsFor(r: ReachOut, now = this.clock.now()): boolean {
    const ids = new Set(r.duties.filter((d) => d.ring && d.from <= now).map((d) => d.rule));
    return !!ids.size && this.d.waits.all().some((w) => ids.has(headOf(w).id) && rings(w) && this.allows(w, now));
  }

  // --- the level's rings (stage 3.3; §8, §12 9) ---

  /** The phone's zone (its record's `tz`), else UTC: where Commute's day starts and ends. */
  private zone(): string {
    return this.phoneZone() ?? "UTC";
  }

  /** The zone the phone last sent, if it sent a valid one: a time of day is read there, and with none isn't guessed. */
  phoneZone(): string | null {
    return validZone(this.d.ringer?.record()?.tz) ?? null;
  }

  /**
   * Rings that used the day's count: one per attempt (one ring's rows share its time) on today's date in the phone's
   * zone, that Apple accepted, may have taken (unknown, a crash's), or is being asked now. One refused or gone doesn't
   * count, and nothing but a ring does: Call back on a notification, or on a missed call's, starts a call with no ring.
   */
  ringsToday(now = this.clock.now()): number {
    const zone = this.zone();
    const today = localDay(now, zone);
    const at = new Set<number>();
    for (const d of this.d.store.deliveries()) {
      if (d.channel === "ring" && (d.state === "accepted" || d.state === "unknown" || d.state === "sending") && localDay(d.at, zone) === today) at.add(d.at);
    }
    return at.size;
  }

  /**
   * Whether the level lets `w` ring now (§8): with no limit, always; on Commute, while today's ring is left, and only for
   * a call-back asked for in words: the one a hang-up set up by itself (a pause) never rings there.
   */
  allows(w: Wait, now: number): boolean {
    // Your hold-back lines and Quiet for a while (stage 3.4): no call unless it was asked for with "call me anyway".
    return this.levelAllows(w, now) && this.ringsThrough(now, { anyway: !!w.mode?.anyway });
  }

  /** The level alone (stage 3.3): with no limit, always; on Commute, today's ring left and not a pause's. */
  private levelAllows(w: Wait, now: number): boolean {
    const ring = this.limits().ring;
    return ring === true || (headOf(w).made.via !== "pause" && this.ringsToday(now) < ring.perDay);
  }

  // --- the ring as one channel (ring.ts `RingChannel`) ---

  /**
   * Each fact the wait has news of is told, dropped, queued in a live call, rung for already (another wait for the same
   * fact rang: one attempt per fact and channel), or went as a notification or was kept for a call in the ring's place
   * (the level didn't let it ring then, or Call me back was off): nothing in it is left to ring for, so Commute's day
   * coming back at midnight never rings for news already sent another way.
   */
  dealt(w: Wait): boolean {
    const keys = this.keysOf(w);
    // A notification or a kept before its not-before (following's, at 18:00) isn't its own: louder, later (§3), it still
    // rings at 19:00 while its news is untold (stage 3.6). Read where its duties' times are (`notBeforeZone`), so with no
    // zone on the phone's record, following's early notification still isn't (the Skeptic's finding on 1847d5c56e7a).
    const from = notBeforeAt(w, this.notBeforeZone(w)) ?? 0;
    return keys.length > 0 && keys.every((k) => this.d.store.reachOut(k)?.state !== "untold" || this.d.store.deliveries(k).some((d) => d.channel === "call" || d.channel === "ring" || ((d.channel === "notification" || d.channel === "kept") && d.at >= from)));
  }

  /**
   * As the wait would ring, its grace over: a question must still be open (§3, step 2), so the threads are looked at
   * again; with nothing of its news left untold (answered at the computer, by a tap), the wait is over and nothing rings
   * ("none"). In a call, its news is queued there ("call"); a call that's ending takes none (`LiveCall.tell` refuses),
   * so it rings after the call ("later"). Else it rings.
   */
  async route(w: Wait, now: number): Promise<"ring" | "call" | "later" | "none"> {
    this.fromWaits(now);
    if (this.keysOf(w).some((k) => this.d.store.reachOut(k)?.kind === "question")) {
      const items = await this.d.adapter.list().catch(() => null);
      now = this.clock.now();
      if (items) this.see(items, now);
    }
    const keys = this.keysOf(w);
    const untold = keys.flatMap((k) => {
      const r = this.d.store.reachOut(k);
      return r?.state === "untold" ? [r] : [];
    });
    if (keys.length && !untold.length) {
      this.d.waits.told(w.conversationId, w);
      return "none";
    }
    if (!this.d.call?.()) return "ring";
    for (const r of untold) this.toCall(r, now);
    return this.dealt(w) ? "call" : "later";
  }

  attempt(w: Wait, now: number): string[] {
    const claimed = this.keysOf(w).filter((key) => this.d.store.attemptDelivery({ key, channel: "ring", state: "sending", at: now }));
    for (const key of claimed) this.flying.add(`ring\n${key}`);
    return claimed;
  }

  unclaim(keys: string[]) {
    for (const key of keys) {
      this.flying.delete(`ring\n${key}`);
      this.d.store.unclaimDelivery(key, "ring");
    }
  }

  rang(keys: string[], result: "sent" | "gone" | "failed", now: number) {
    for (const key of keys) {
      this.flying.delete(`ring\n${key}`);
      const d = this.d.store.deliveries(key).find((x) => x.channel === "ring");
      if (!d || d.state !== "sending") continue;
      // Apple accepted it: its deadline starts from Apple's answer. Refused: missed at once (§3, Missed rings).
      this.d.store.updateDelivery(result === "sent" ? { ...d, state: "accepted", acceptedAt: now, missedAt: now + MISSED_MS } : { ...d, state: result === "gone" ? "gone" : "refused", missedAt: now });
      this.track("reach_sent", { channel: "ring", result, kind: this.d.store.reachOut(key)?.kind ?? "reply" });
    }
    this.soon();
  }

  // --- missed call-backs (stage 2a item 8; §3, Missed rings) ---

  /**
   * The facts rung for with `key`'s: every reach-out with a duty from a rule that rang for it (one ring carries a wait's
   * every fact).
   */
  private rungWith(key: string): string[] {
    // A line's call (stage 3.4) rang with its duty that calls.
    const rules = new Set(this.d.store.reachOut(key)?.duties.filter((d) => d.ring || (d.calls && d.via === "rule")).map((d) => d.rule) ?? []);
    const keys = this.d.store.reachOuts().filter((r) => r.duties.some((d) => rules.has(d.rule))).map((r) => r.key);
    return keys.length ? keys : [key];
  }

  /** Whether a ring's missed step is over: its notification went (or was tried), or its news was kept for a call. */
  private missedDealt(key: string): boolean {
    const ds = this.d.store.deliveries(key);
    const r = this.d.store.reachOut(key);
    // A line's call about news already notified (example 11's escalation, stage 3.4): only what came after the call. A held
    // command kept before its call-back's not-before (Commute's) has its missed call once it rings then.
    const ring = r?.kind === "held" || r?.duties.some((d) => d.calls && d.via === "rule") ? ds.find((d) => d.channel === "ring") : undefined;
    return ds.some((d) => (d.channel === "notification" && r?.kind === "held") || ((d.channel === "notification" || d.channel === "kept") && (!ring || d.at >= ring.at)));
  }

  /**
   * A call-back for a ring arrived (`POST /api/session {mode: "callback"}`, by its conversation or its reach-out): the
   * ring is connecting, and has `CONNECTING_MS` to be established, else it's missed. So a call-back that fails
   * validation, is refused or fails to start sends the missed notification then. Kept in the store: an eviction keeps it.
   */
  connecting(conversationId: string | null, reachOut: string | null, now = this.clock.now()) {
    const w = conversationId ? this.d.waits.get(conversationId) : null;
    const offline = conversationId ? this.d.store.reachOuts().filter((r) => this.offlineIn(r, conversationId)).map((r) => r.key) : [];
    const held = conversationId ? this.heldIn(conversationId).map((r) => r.key) : [];
    const keys = new Set([...(reachOut ? this.rungWith(reachOut) : []), ...(w ? this.keysOf(w) : []), ...offline, ...held]);
    let any = false;
    for (const key of keys) {
      const d = this.d.store.deliveries(key).find((x) => x.channel === "ring");
      if (!d || d.callback || d.state === "sending" || this.missedDealt(key)) continue;
      this.d.store.updateDelivery({ ...d, callback: "connecting", missedAt: now + CONNECTING_MS });
      any = true;
    }
    if (any) {
      this.d.log("engine: a call-back is connecting");
      this.soon();
    }
  }

  /** Rings whose deadline passed with no call-back established, and whose news is still untold. */
  private missedDue(): { d: Delivery; r: ReachOut }[] {
    return this.d.store.deliveries().flatMap((d) => {
      if (d.channel !== "ring" || d.missedAt === undefined || d.callback === "established" || this.missedDealt(d.key)) return [];
      const r = this.d.store.reachOut(d.key);
      return r?.state === "untold" ? [{ d, r }] : [];
    });
  }

  /**
   * Each ring missed by now (§3, Missed rings): one notification for what it rang about, "You missed a call", with the
   * question's buttons when its news is one; without a way to notify (Notifications off, the engine's gate, no sender),
   * its news is kept for the next call, as before.
   */
  private async missedRings(now: number) {
    const rings = new Map<string, ReachOut[]>();
    for (const { d, r } of this.missedDue()) {
      if (d.missedAt! > now) continue;
      const rule = r.duties.find((x) => x.ring || x.calls)?.rule ?? r.key;
      rings.set(rule, [...(rings.get(rule) ?? []), r]);
    }
    for (const [rule, rs] of rings) await this.missed(rule, rs, now);
  }

  private async missed(rule: string, rs: ReachOut[], now: number) {
    // A computer gone offline: its own missed call, under its down time's collapse id (stage 3.7).
    const offline = rs.filter((r) => r.kind === "offline");
    if (offline.length) {
      await this.missedOffline(offline, now);
      rs = rs.filter((r) => r.kind !== "offline");
      if (!rs.length) return;
    }
    // Its questions read first (once each): one thread's words and buttons; of several, which ask and which wait for an
    // OK, and the words of the one asking (reach.ts `missedNoteOf`).
    if (this.notifies()) {
      const read: ReachOut[] = [];
      for (const r of rs) read.push(await this.asked(r));
      rs = read;
    }
    // Its words were read meanwhile (seconds): news answered or dealt with since sends nothing, and the phone is the one
    // the account has now (another install may have taken the record).
    rs = rs.flatMap((r) => (this.d.store.reachOut(r.key)?.state === "untold" && !this.missedDealt(r.key) ? [r] : []));
    if (!rs.length) return;
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) {
      for (const r of rs) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      this.d.log(`engine: a call-back wasn't answered; ${rs.map((r) => r.news.handle).join(", ")}'s news is kept for the next call`);
      return;
    }
    // The call's caller line, as a sentence (stage 3.6: "All 3 threads are done.", "API failed."), while its wait is here.
    const w = this.waitOf(rule);
    const privacy = privacyOf(this.d.store);
    const note = missedNoteOf(rs, rule, { ...privacy, answers: this.limits().answerFromNotification, ...(w?.ready ? { caller: callerOf(w, privacy.names) } : {}) });
    this.d.store.db.transaction(() => {
      for (const r of rs) {
        this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now });
        // About several threads, under the call-back's collapse id: no notification of its own for "Already answered."
        const fresh = this.d.store.reachOut(r.key);
        if (fresh && note.collapseId !== collapseOf(fresh)) this.d.store.saveReachOut({ ...fresh, grouped: true });
      }
    });
    for (const r of rs) this.flying.add(`notification\n${r.key}`);
    await this.sent(rs.map((r) => r.key), phone, note, now);
  }

  // --- delivering ---

  /** What the policy knows of now, for `r`. */
  private situation(r: ReachOut, now: number): Situation {
    return {
      inCall: this.d.call?.()?.conversationId ?? null,
      holding: this.d.ringer?.holdingFor(now) ?? [],
      ring: !!this.d.ringer?.canRing() && this.ringsFor(r, now),
      notify: this.notifies(),
    };
  }

  /** Untold reach-outs with no delivery yet, which the engine itself delivers (a live ring is the Ringer's). */
  private pending(): ReachOut[] {
    return this.d.store.reachOuts().filter((r) => r.state === "untold" && !this.d.store.deliveries(r.key).some((d) => QUIET.has(d.channel)));
  }

  /**
   * When `r` may next go: its grace (or a permission wait's minute), later if a holding phone may take it or a call
   * refused it (one saying goodbye takes nothing: tried again a grace later, never at once); a reply gathering for
   * following's batch, when the batch closes, except in a call, which is told it at its grace as anything else is.
   */
  private readyAt(r: ReachOut, inCall: boolean, now: number): number {
    if (batched(r, now) && !inCall) return this.batchAt(now)?.at ?? Infinity;
    return Math.max(dueOf(r), this.deferred.get(r.key) ?? 0);
  }

  /** Following's replies gathering for their notification: untold, nothing sent for them yet, none asked for as well. */
  private gathering(now = this.clock.now()): ReachOut[] {
    return this.pending().filter((r) => batched(r, now));
  }

  /**
   * When following's batch goes (§3, Batching; the stage 3 staging run: a reply that waited out the whole window read
   * as a notification dropped). The first reply after a quiet spell (none sent yet, or the gap over when it came) goes at
   * its grace, as a question does, and opens a window (`opens`: its start); replies that come in that window go together
   * as it closes; any later, no sooner than the gap after the last reply notification. Null with nothing gathering: a
   * reply that leaves before it goes sends nothing, and opens no window and no gap.
   */
  private batchAt(now = this.clock.now()): { at: number; opens: number | null } | null {
    const gathering = this.gathering(now);
    if (!gathering.length) return null;
    const first = Math.min(...gathering.map((r) => r.duties.find((d) => d.urgency === "batched")?.from ?? r.at));
    const state = this.following()?.state;
    const opened = state?.openedAt;
    if (opened !== undefined && first < opened + BATCH_WINDOW_MS) return { at: opened + BATCH_WINDOW_MS, opens: null };
    const sent = state?.sentAt;
    if (sent === undefined || first >= sent + BATCH_GAP_MS) return { at: first + GRACE_MS, opens: first };
    return { at: sent + BATCH_GAP_MS, opens: null };
  }

  /**
   * The alarm's or the timer's turn, everything due once, one at a time: the call-back waits looked at (a thread's time
   * running out, or a reply no report told of), then the reach-outs. False when a step threw: the cloud's alarm then
   * backs off (cloud/src/alarm.ts), and so does the engine's own timer, 5 s doubling to 5 minutes (§7), even when what's
   * due is already past.
   */
  tick(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return (this.ticking ??= this.turn().finally(() => {
      this.ticking = null;
      this.soon();
    }));
  }

  private async turn(): Promise<boolean> {
    const woke = this.clock.now();
    let ok = true;
    const step = async (what: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        ok = false;
        this.d.log(`engine: couldn't ${what} (${describe(e)})`);
      }
    };
    await step("look at the waits", () => this.d.waits.check());
    await step("deliver", () => this.deliver());
    // What's due next unreadable is a step that threw too: else the timer, set at once for want of a time, would tick
    // every 50 ms while the steps themselves run. What this tick left due waits out a backoff before it wakes it again.
    await step("tell what's due", async () => this.stuck.woke(this.times(this.clock.now()), woke, this.clock.now()));
    this.retry = ok ? 0 : backoffAfter(this.retry);
    this.retryAt = ok ? 0 : this.clock.now() + this.retry;
    if (!ok) this.d.log(`engine: tried again in ${this.retry / 1000} s`);
    return ok;
  }

  private async deliver() {
    let now = this.clock.now();
    this.recover();
    this.expire(now);
    this.follow();
    this.fromWaits(now);
    this.rezone();
    // A handover its computer never took by the end of its window (stage 4b): missed, written to tell now.
    this.d.later?.tick(now);
    // In a call, a reply gathering for the batch is told there at its grace, as anything else is: no window.
    const inCall = !!this.d.call?.();
    const due = this.pending().filter((r) => (inCall || !batched(r, now)) && this.readyAt(r, inCall, now) <= now && !(this.d.ringer?.canRing() && this.ringsFor(r, now)));
    const missed = this.missedDue().some(({ d }) => d.missedAt! <= now);
    const batch = !inCall && (this.batchAt(now)?.at ?? Infinity) <= now;
    // A repeating time come round (stage 3.8): what happened since its last is read from the threads as they are now.
    const every = this.everyRules().some((rule) => (this.everyNext(rule, now)?.at ?? Infinity) <= now);
    // A watched computer's offline check, or one back to tell (stage 3.7): the threads and their computers are looked at;
    // so is a brain that can tell computers apart and hasn't looked yet (woken by the alarm its check set before it slept).
    const later = this.laterCalls(now).filter((x) => x.from <= now).map((x) => x.r);
    // Away's set time come (stage 3.9): the threads are looked at, so its end's counts are as they are now.
    const away = this.away();
    const awayOver = !!away && now >= away.lifetime.at;
    const computers = (!this.viewed && !!this.d.adapter.link) || this.offlineTimes(now).some((t) => t <= now) || this.backsDue(now).length > 0 || later.length > 0 || awayOver;
    // What became of a send for later, kept while no phone took notifications: told first thing in the next call.
    const keptLater = this.keptLater(now);
    // Your rules (stage 3.4): a question's escalation due (it must still be asked), a hold-back just ended.
    const escalating = this.escalations().some((e) => e.at <= now);
    const ended = this.holdEnds(now).past.length > 0;
    // Example 2's 90 s come round (stage 3.5): the threads are looked at, and its project is idle or busy again.
    const idle = this.idleTimes().some((t) => t <= now);
    // A held command its call-back's not-before kept from ringing for: it rings once that's come (`heldLater`).
    const heldLate = this.heldLater(now).filter((x) => x.from <= now).map((x) => x.r);
    if (due.length || missed || batch || computers || every || keptLater.length || escalating || ended || idle || heldLate.length) {
      // The grace is over: the question must still be open (an answer at the keyboard meanwhile sends nothing). So must
      // a missed ring's: one answered since its ring is dropped, with nothing to tell. And a computer gone offline must
      // still be: one back meanwhile tells nothing at all.
      const items = await this.d.adapter.list().catch(() => null);
      now = this.clock.now();
      if (items) this.see(items, now);
      if (items && every) this.fireEvery(now);
      const offline: ReachOut[] = [];
      const sends: ReachOut[] = [];
      // A line's calls this turn (example 12's failure; example 9's question while driving): one call for all of them.
      const lineRings: ReachOut[] = [];
      const carRings: ReachOut[] = [];
      // Judged lines' checks (stage 3.5), each up to 20 s: after everything else this turn has, so nothing waits on them.
      const judged: ReachOut[] = [];
      for (const was of due) {
        let r = this.d.store.reachOut(was.key);
        if (!r || r.state !== "untold" || this.d.store.deliveries(r.key).some((d) => QUIET.has(d.channel))) continue;
        // Read again after the look's await: a zone that moved meanwhile may have moved its not-before (`rezone`).
        if (r.kind !== "brief" && this.readyAt(r, inCall, now) > now) continue;
        if (r.kind === "brief") await this.deliverBrief(r, now);
        else if (r.kind === "offline") offline.push(r);
        else if (r.kind === "later") sends.push(r);
        else if (r.news.idle) await this.deliverIdle(r, now);
        else {
          // A run's end a line tells only if its tests or build failed: read now, once (stage 3.4).
          if (r.duties.some((d) => d.red)) {
            r = await this.checkRed(r, now);
            if (!r) continue;
          }
          // A judged duty keeps its own minute (the final reviews of 3.5: a call-back due at its grace sent it to its check
          // at 6 s). Another duty telling it now tells its news anyway: no check. Else it waits for its minute.
          const later = r.duties.filter((d) => isJudged(d) && d.from > now);
          if (later.length) {
            if (!r.duties.some((d) => !isJudged(d) && d.from <= now && d.urgency !== "batched")) {
              this.deferred.set(r.key, Math.min(...later.map((d) => d.from)));
              continue;
            }
            r = { ...r, duties: r.duties.filter((d) => !later.includes(d)) };
            this.d.store.saveReachOut(r);
            this.d.log(`engine: ${r.news.handle}'s turn is told by another rule now, so it isn't judged`);
          }
          if (r.duties.some(isJudged)) {
            this.deferred.delete(r.key);
            judged.push(r);
          } else await this.deliverDue(r, items !== null, inCall, now, lineRings, carRings);
        }
      }
      if (sends.length) await this.deliverLater(sends, now);
      for (const r of keptLater) this.toCall(r, now);
      await this.ringLines(lineRings, carRings, now);
      if (!this.d.call?.()) for (const r of heldLate) {
        const fresh = this.d.store.reachOut(r.key);
        if (fresh?.state === "untold" && this.heldOf(fresh)) await this.ringHeld(fresh, now);
      }
      if (offline.length || later.length) await this.deliverOffline(offline, now, later.filter((r) => !offline.some((o) => o.key === r.key)));
      if (batch) await this.deliverBatch(items !== null, now);
      await this.missedRings(now);
      await this.escalate(now);
      await this.endHolds(now);
      for (const r of this.backsDue(now)) await this.deliverBack(r, now);
      // Its time come with the threads unreadable: it ends all the same, its counts from them as last seen.
      const still = this.away();
      if (still && now >= still.lifetime.at) this.endAway(still, this.awayEnded(still, now)!, now);
      if (judged.length) {
        // A minute after each turn ended, a few at once (the reviews of 3.5): a yes goes now, unchecked with the batch.
        const checked: ReachOut[] = [];
        await mapLimit(judged, JUDGE_AT_ONCE, async (r) => {
          const next = await this.checkJudged(r, now);
          if (next) checked.push(next);
        });
        const at = this.clock.now();
        const rings: ReachOut[] = [];
        const cars: ReachOut[] = [];
        for (const r of checked) if (!batched(r, at)) await this.deliverDue(r, items !== null, !!this.d.call?.(), at, rings, cars);
        await this.ringLines(rings, cars, at);
        // A judged reply left unchecked just now may make the batch due in this turn too.
        if (!this.d.call?.() && (this.batchAt(at)?.at ?? Infinity) <= at) await this.deliverBatch(items !== null, at);
      }
      if (this.ending) await this.ending;
    }
  }

  /** A reach-out due now, to a line's call (example 12), the car's call (example 9), or `deliverOne`. */
  private async deliverDue(r: ReachOut, listed: boolean, inCall: boolean, now: number, lineRings: ReachOut[], carRings: ReachOut[]) {
    const gone = listed && !this.items.has(r.news.itemId);
    // A hold, and a question that is one, go as the hold (`deliverHeld`): a line's call for it rings as the hold.
    const held = !!this.heldOf(r);
    if (!inCall && !gone && !held && this.lineCalls(r, now)) lineRings.push(r);
    else if (!inCall && !gone && !held && this.carRings(r, now)) carRings.push(r);
    else await this.deliverOne(r, gone, now);
  }

  /** A turn's line calls and car calls (one call for each kind, several in it). */
  private async ringLines(lineRings: ReachOut[], carRings: ReachOut[], now: number) {
    if (lineRings.length) await this.ringLine(lineRings, now);
    const car = this.carLine(now);
    if (carRings.length && car) await this.ringLine(carRings, now, { rule: car.id, via: "rule", ring: false, calls: true, tell: false, urgency: "urgent", from: now, said: car.made.said });
  }

  /**
   * Following's batch goes (§3, Batching: the first reply after a quiet spell at its grace, the window it opened at its
   * close, then after the gap): every reply gathering goes in one notification, which lists every followed reply still
   * unheard (one per thread, its newest), not only these, since it takes the last one's place (one collapse id). What
   * left the batch meanwhile was taken out as the threads were looked at (`tidyReplies`): with nothing left, nothing
   * goes, and neither the window nor the gap starts. A call begun meanwhile tells them; a thread gone is kept; without a
   * phone that takes notifications, or a following rule this version reads, each is kept for the next call.
   */
  private async deliverBatch(listed: boolean, now: number) {
    let going = this.gathering(now);
    if (!going.length) return;
    // The first reply after a quiet spell opens the window the next ones gather in.
    const opens = this.batchAt(now)?.opens ?? null;
    if (this.d.call?.()) {
      for (const r of going) this.toCall(r, now);
      return;
    }
    for (const r of going.filter((x) => listed && !this.items.has(x.news.itemId))) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
    going = going.filter((r) => !listed || this.items.has(r.news.itemId));
    // The weekend line keeps the plain replies for your next call, the car line all of them (stage 3.4).
    const keeps = (r: ReachOut) => this.holdNow(now).by === "car" || this.weekendKeeps(r, now);
    for (const r of going.filter(keeps)) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
    going = going.filter((r) => !keeps(r));
    if (!going.length) return;
    // Following's rule row unreadable (another version's, or damaged) is as Notifications off: else the batch would stay
    // due, and nothing would ever send it.
    if (!this.notifies() || !this.following()) {
      for (const r of going) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      this.d.log(`engine: ${going.map((r) => r.news.handle).join(", ")} replied; kept for the next call`);
      return;
    }
    await this.words(this.unheardReplies());
    // Their words were read meanwhile (seconds): what's still to go, to the phone the account has now.
    going = going.flatMap((r) => {
      const fresh = this.d.store.reachOut(r.key);
      return fresh?.state === "untold" && !this.d.store.deliveries(r.key).some((d) => QUIET.has(d.channel)) ? [fresh] : [];
    });
    const phone = this.alertPhone();
    const rule = this.following();
    if (!going.length || !phone || !rule) return;
    const keys = new Set(going.map((r) => r.key));
    const listedNow = this.unheardReplies().filter((r) => !this.weekendKeeps(r, now));
    const all = [...listedNow, ...going.filter((r) => !listedNow.some((x) => x.news.itemId === r.news.itemId))];
    // About one thread, its write buttons where the level has them (Fable's 4-K), by how it stands now.
    const note = replyNoteOf(all, { ...privacyOf(this.d.store), answers: this.limits().answerFromNotification, writes: this.writes(), busy: all.length === 1 && this.busy(all[0].news.itemId) }, ruleCollapse(FOLLOWING));
    this.d.store.db.transaction(() => {
      for (const key of keys) this.d.store.attemptDelivery({ key, channel: "notification", state: "sending", at: now });
      this.d.store.saveRule(FOLLOWING, { ...rule, state: { ...rule.state, sentAt: now, ...(opens !== null ? { openedAt: opens } : {}) } });
    });
    for (const key of keys) this.flying.add(`notification\n${key}`);
    this.d.log(`engine: ${all.length} followed thread${all.length === 1 ? "" : "s"} replied, in one notification`);
    await this.sent([...keys], phone, note, now);
  }

  /**
   * Every followed reply the user hasn't heard yet, inside its news's time: one per thread (its newest), newest first,
   * each one a thread still on the list that tells you replies and asks no question. A reply asked for as well went on
   * its own.
   */
  private unheardReplies(): ReachOut[] {
    const stars = this.d.store.stars();
    const newest = new Map<string, ReachOut>();
    for (const r of this.d.store.reachOuts()) {
      // A line's replies (stage 3.5) are in the batch as following's are: each notification says every one still unheard.
      const line = r.duties.some((d) => d.via === "rule" && d.urgency === "batched");
      if (r.state !== "untold" || !batched(r, this.clock.now()) || (!line && !r.duties.some((d) => d.rule === FOLLOWING))) continue;
      const item = this.items.get(r.news.itemId);
      if (!item || item.pendingQuestion || (!line && !tellsReplies(this.notifyFor(r.news.itemId, stars))) || this.heard(r.news)) continue;
      const had = newest.get(r.news.itemId);
      if (!had || r.at >= had.at) newest.set(r.news.itemId, r);
    }
    return [...newest.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * Each reply's opening words, read once (the reply as its work system reports it: no model call) and kept on its
   * reach-out. None for a run that ended without a reply of its own (its report is still an older reply).
   */
  private async words(rs: ReachOut[]) {
    for (const r of rs) {
      if (r.asked || !this.d.adapter.report) continue;
      const rep = await this.d.adapter.report(r.news.itemId).catch(() => null);
      const at = rep?.reply?.at ? Date.parse(rep.reply.at) : NaN;
      const older = Number.isFinite(at) && r.news.seen.runAt > 0 && at < r.news.seen.runAt - 1000;
      const fresh = this.d.store.reachOut(r.key);
      if (!fresh) continue;
      // A followed reply whose run's last test run or build failed says so (stage 3.10; Fable, 3.10-C), from the
      // computer's facts in the same report; a call-back's reply has its wait's (`News.tests`).
      // A line's run's end told only if its tests or build failed (stage 3.4, `red`) reads them as following does.
      const followed = fresh.duties.some((d) => d.via === "follow" || d.via === "set" || d.red);
      const tests = followed && rep && !older && !fresh.news.status ? testsOf(rep.checks, { watch: false, readable: true }) : null;
      // Which message it is and whether it ends asking (Fable's 4-K): what its notification's write buttons go by.
      const reply = rep && !older ? { messageId: rep.reply?.messageId ?? null, asks: endsAsking(rep.text) } : null;
      this.d.store.saveReachOut({ ...fresh, asked: true, words: rep && !older ? openingOf(rep.text) : null, reply, ...(followed ? { tests } : {}) });
    }
  }

  private async deliverOne(r: ReachOut, gone: boolean, now: number) {
    // A held command (Commands that wait): its own notification, or its line. Away's question that is one sends nothing
    // more (Fable's ruling on pass B1's review: one hold, one push): Away is Long Haul's, whose limits send the hold's own.
    const held = this.heldOf(r);
    if (held && r.kind === "question") {
      // Marked as dealt with, so it isn't due again while it's held (the combinations review of pass B1).
      this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      return;
    }
    if (held) return this.deliverHeld(r, held, now);
    // Over within its grace (answered at the computer): nothing is sent (`watchHeld` marks how it ended).
    if (r.kind === "held") return;
    // Only the duties due now have a say (a call-back's not-before, stage 3.6).
    const [channel] = gone ? (["kept"] as const) : reach(dueNow(r, now), this.situation(r, now));
    if (!channel) {
      // A phone is holding for its conversation: the hold takes it. Looked at again after another grace.
      this.deferred.set(r.key, now + GRACE_MS);
      return;
    }
    this.deferred.delete(r.key);
    if (channel === "ring") return; // the Ringer's, at its wait's own grace
    if (channel === "call") return void this.toCall(r, now);
    // The weekend line keeps a plain reply for your next call; the car line keeps everything but a question it can't
    // call for, and a call-back (stage 3.4; Fable, topic 8). Inside the night line's hours, where the night holds those
    // calls, the car line's "send nothing I'd have to read" wins over the night's silent notification: kept too (the
    // third reviews of 3.4).
    const h = this.holdNow(now);
    const car = h.by === "car" && (h.night !== null || (!r.duties.some((d) => d.via === "callback") && (r.kind !== "question" || !this.d.ringer?.canRing() || !this.carLine(now))));
    const keep = channel === "kept" || this.weekendKeeps(r, now) || car;
    if (keep) {
      this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      this.d.log(`engine: ${r.news.handle}'s news is kept for the next call`);
      return;
    }
    await this.notifyOf(r, now);
  }

  /**
   * Example 9 (Fable, topic 8): while driving, a question something tells you calls you (subject to Call me back and
   * the level; several in one grace, one call), and everything else is kept for your next call.
   */
  private carRings(r: ReachOut, now: number): boolean {
    // A command a thread holds is an agent waiting on an answer too (Fable's ruling on pass B2's review).
    if ((r.kind !== "question" && r.kind !== "held") || this.holdNow(now).by !== "car" || !r.duties.some((d) => d.tell && d.via !== "callback")) return false;
    // A car line that doesn't say call (stage 3.5) keeps the question too.
    if (!this.carLine(now)) return false;
    const limit = this.limits().ring;
    // Inside the night line's hours, no call: a silent notification (the final reviews of 3.4).
    return !!this.d.ringer?.canRing() && (limit === true || this.ringsToday(now) < limit.perDay) && this.ringsThrough(now, {});
  }

  /**
   * In a call: told through the call's own arrival queue, under the fact's key, once; told when it's said. `ended`: a
   * tests watch's mid-run pass told after its run ended, with the report read then (or null, unreadable).
   */
  private toCall(r: ReachOut, now: number, ended?: Report | null) {
    const call = this.d.call?.();
    // A briefing's (stage 3.8) is a notification only, never told in a call.
    if (!call || r.kind === "brief" || this.d.store.deliveries(r.key).some((d) => d.channel === "call")) return;
    // What became of a send or a start for later (stage 4b): its own line, word for word (later-lines.ts `laterSaid`).
    if (r.kind === "later" && r.news.later) {
      const fact: CallFact = { key: r.key, itemId: r.news.itemId, handle: r.news.handle, group: "", at: new Date(r.at).toISOString(), ask: null, seen: r.news.seen, kind: "later", said: laterSaid(r, this.zone(), now) };
      if (!call.tell(fact, () => this.told(r.key))) {
        this.deferred.set(r.key, now + GRACE_MS);
        return;
      }
      this.d.store.attemptDelivery({ key: r.key, channel: "call", state: "accepted", at: now });
      this.track("reach_sent", { channel: "call", result: "queued", kind: r.kind });
      return;
    }
    // A held command (Commands that wait; Fable's 4-H3): its own line, word for word, never offered to run by voice.
    const held = this.heldOf(r);
    if (held) {
      const fact: CallFact = { key: r.key, itemId: r.news.itemId, handle: r.news.handle, group: "", at: new Date(r.at).toISOString(), ask: null, seen: r.news.seen, kind: "held", said: heldSaid(r.news.handle, held.matched, r.news.machine ?? "your computer", this.computers()) };
      if (!call.tell(fact, () => this.told(r.key))) {
        this.deferred.set(r.key, now + GRACE_MS);
        return;
      }
      this.d.store.attemptDelivery({ key: r.key, channel: "call", state: "accepted", at: now });
      this.track("reach_sent", { channel: "call", result: "queued", kind: r.kind });
      return;
    }
    const item = this.items.get(r.news.itemId);
    // A tests watch's pass mid-run told once its run has ended (kept for the next call, a call begun later): "it's
    // still working" is no longer true, so it's told as that run's end, from its report read now (Fable's finding on
    // 3.10: what it says must be true when it says it). Failed, stopped or asking a question, it's told as that, with no
    // first sentence (Fable on 3.9 and 3.10; 3.10-D): no report read.
    // Over though another run has begun (the review of 45ec9eccdf6f, F6: `passOver`), and told by that run's own end;
    // with its report read (`ended`), not over while that says its run is the one going (the skeptic on 7717d10f3219).
    const pass = r.news.tests?.run;
    const over = r.news.tests?.running && item && passOver(pass, item, ended)
      ? (item.status === "waiting" || item.pendingQuestion ? "asks" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "stopped" : "finished")
      : null;
    if (ended === undefined && over === "finished" && this.d.adapter.report) {
      if (this.endedReads.has(r.key)) return;
      this.endedReads.add(r.key);
      void this.d.adapter.report(r.news.itemId).catch(() => null).then((rep) => {
        this.endedReads.delete(r.key);
        const fresh = this.d.store.reachOut(r.key);
        if (fresh?.state === "untold") this.toCall(fresh, this.clock.now(), rep);
      });
      return;
    }
    const at = item?.lastRunAt ?? (r.news.seen.runAt ? new Date(r.news.seen.runAt).toISOString() : (item?.updatedAt ?? new Date(r.at).toISOString()));
    // A computer gone offline (stage 3.7): its fact, "Quartz went offline 4 minutes ago. API was running there…".
    const off = r.news.offline;
    const offline = off ? { offline: { machine: r.news.handle, ago: offlineAgo(off.since, now, this.phoneZone()), names: off.threads.map((t) => t.handle) } } : {};
    // A failed or stopped run, threads still working, a check-in (stage 3.6, 3.8): its own words, never as a reply.
    const status: StatusFact | undefined = over === "failed" || over === "stopped" ? { lines: [{ handle: r.news.handle, state: over }] } : statusOf(r.news, (id) => this.heldLine(id));
    // What its tests did (stage 3.10; Fable, 3.10-D): a call-back's own fact, said first, word for word; a mid-run pass
    // told after its run ended, that run's end's (B, or C to G) and its reply, heard as that run's; after it failed, was
    // stopped or asks, nothing of its tests first.
    // That run's reply (`passReplied`): its checks, and hearing it marks it heard; another run's, its tests not known and
    // nothing marked heard.
    const mine = !!ended && passReplied(pass, ended);
    const late = ended !== undefined && over === "finished" && r.news.tests ? testsOf(mine ? ended!.checks : undefined, { watch: true, readable: mine && ended!.checksUnread !== true }) : null;
    const tests = late ? { first: testsFirst(r.news.handle, late) } : over ? {} : r.news.tests ? { first: testsFirst(r.news.handle, r.news.tests), ...(r.news.tests.running ? { passing: true as const } : {}) } : {};
    const runAt = over === "finished" ? (mine ? Date.parse(ended!.reply!.at) || 0 : 0) : item?.lastRunAt ? Date.parse(item.lastRunAt) : 0;
    const seen = over === "asks" ? { runAt, question: item?.questionId ?? null } : over ? { runAt, question: null } : r.news.seen;
    const ok = call.tell({ key: r.key, itemId: r.news.itemId, handle: r.news.handle, group: item?.group ?? "", at, ask: askShown(r.ask), seen, kind: over === "asks" ? "question" : r.kind, ...offline, ...(status ? { status } : {}), ...tests }, () => this.told(r.key));
    if (!ok) {
      this.deferred.set(r.key, now + GRACE_MS);
      return;
    }
    this.d.store.attemptDelivery({ key: r.key, channel: "call", state: "accepted", at: now });
    this.track("reach_sent", { channel: "call", result: "queued", kind: r.kind });
  }

  /**
   * A notification: its words read first (once: a question's, or a reply's opening words), then the attempt row, the
   * push, and Apple's answer. A call-back's replies in its ring's place (the level didn't let it ring, or Call me back is
   * off) are one notification for all of them, as its ring would have been one call; a question in it is never merged
   * with them (§11, 3.1): it goes alone, with its words, its buttons where the level has them and its own collapse id.
   */
  private async notifyOf(r: ReachOut, now: number): Promise<void> {
    if (!this.notifies()) return;
    const rule = r.kind === "reply" ? r.duties.find((d) => d.ring || (d.tell && d.via === "callback"))?.rule : undefined;
    const all = rule ? this.pending().filter((x) => x.kind === "reply" && x.duties.some((d) => d.rule === rule)) : [];
    if (all.length > 1 || r.news.still || r.news.check) return this.notifyAll(rule!, all.length ? all : [r], now);
    r = await this.asked(r);
    if (r.kind === "reply") {
      await this.words([r]);
      r = this.d.store.reachOut(r.key) ?? r;
    }
    // Its words were read meanwhile (a classifier call, seconds): a question answered since sends nothing, and it goes
    // to the phone the account has now, if that still takes notifications (another install may have taken the record),
    // with no attempt spent otherwise.
    const phone = this.alertPhone();
    if (!phone || this.d.store.reachOut(r.key)?.state !== "untold") return;
    // A judged line's yes (stage 3.5): "API is waiting on you", with its check's reason.
    const yes = r.kind === "reply" && r.duties.some((d) => d.judged === "yes") ? r.duties.find((d) => d.judged === "yes")! : null;
    r = this.allowing(r);
    const said = yes ? judgedNoteOf(r, privacyOf(this.d.store), this.lineRules().find((x) => x.id === yes.rule)?.example === 1) : noteOf(r, { ...privacyOf(this.d.store), answers: this.limits().answerFromNotification, writes: this.writes(), busy: this.busy(r.news.itemId) });
    // A call in your own words not allowed yet (stage 3.5): its tap opens How I read your rules, with Allow; a question's
    // still opens its thread, where it's answered (the seventh reviews).
    const note: Note = r.kind !== "question" && r.duties.some((d) => d.allow) ? { ...said, allow: true } : said;
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now })) return;
    this.flying.add(`notification\n${r.key}`);
    await this.sent([r.key], phone, note, now);
  }

  /**
   * A reach-out's duties with `allow` as it is now, for its notification's why and tap (stage 3.5, "Allowing a call"):
   * on a call in your own words that waits for your OK, Stop calls between its fact and its call too; never on one
   * allowed, nor one whose reading no longer holds (the seventh reviews).
   */
  private allowing(r: ReachOut): ReachOut {
    let changed = false;
    const duties = r.duties.map((d) => {
      if (d.via !== "rule" || !(d.calls || d.allow)) return d;
      const rule = this.lineRules().find((x) => x.id === d.rule);
      if (!rule?.read) return d;
      const want = this.asksOK(rule);
      if (!!d.allow === want) return d;
      changed = true;
      const { allow: _, ...rest } = d;
      return want ? { ...rest, allow: true as const } : rest;
    });
    return changed ? { ...r, duties } : r;
  }

  /**
   * A call-back's replies from several threads, in its ring's place (Fable, 3.3): "2 threads replied", their lines, and
   * why ("You asked to hear back.", or for a pause's "You were waiting for them."), with Call back, under the call-back's
   * collapse id. Replies only: a question has its own notification (`notifyOf`).
   */
  private async notifyAll(rule: string, rs: ReachOut[], now: number): Promise<void> {
    await this.words(rs);
    const going = rs.flatMap((r) => {
      const fresh = this.d.store.reachOut(r.key);
      return fresh?.state === "untold" && !this.d.store.deliveries(r.key).some((d) => QUIET.has(d.channel)) ? [fresh] : [];
    });
    const phone = this.alertPhone();
    if (!going.length || !phone) return;
    // A call-back with a mode, a failure or a watch run out says so (stage 3.6: reach.ts `callBackWords`); else 3.1's.
    const w = this.waitOf(rule);
    const privacy = privacyOf(this.d.store);
    // A time's (stage 3.8) on the phone's clock: "As of 15:00.", "Not done by 18:00."; none with no zone.
    const zone = this.phoneZone();
    const shown = (at: number) => (zone ? shownClock(at, zone, this.clock.now()) : null);
    const words = callBackWords(going, { ...privacy, shown }, { all: w?.mode?.until === "all" && !w.mode.only, total: w?.items.length ?? going.length });
    if (going.length === 1 && !words) return this.notifyOf(going[0], now);
    going.sort((a, b) => b.at - a.at);
    const several = going.length > 1 || (going[0].news.still?.working.length ?? 0) > 1;
    // About several threads, a tap opens Home (a check-in's of several too).
    const home = going.length > 1 || (going[0].news.check?.total ?? 1) > 1;
    const note: Note = words
      ? { ...replyNoteOf(going, privacy, ruleCollapse(rule), whyOf(going.flatMap((r) => r.duties), several, privacy.names)), ...words, ...(home ? { item: undefined } : {}) }
      : replyNoteOf(going, privacy, ruleCollapse(rule), whyOf(going.flatMap((r) => r.duties), true, privacy.names));
    if (note.item === undefined) delete note.item;
    this.d.store.db.transaction(() => {
      for (const r of going) this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now });
    });
    for (const r of going) this.flying.add(`notification\n${r.key}`);
    await this.sent(going.map((r) => r.key), phone, note, now);
  }

  /** A question's words and its own options, read once (`questionReader`) and kept on its reach-out. */
  private async asked(r: ReachOut): Promise<ReachOut> {
    if (r.kind !== "question" || r.asked || !this.d.read) return r;
    const read = await this.d.read(r.news.itemId).catch(() => null);
    const fresh = this.d.store.reachOut(r.key) ?? r;
    // A wait's news written before the engine had listed the threads has no kind yet: the thread says it now.
    const q = fresh.news.question;
    const item = this.items.get(r.news.itemId);
    const kind = q && q.kind === null && item?.pendingQuestion && (item.questionId ?? null) === q.id ? item.questionKind ?? null : null;
    r = { ...fresh, ...(kind ? { news: { ...fresh.news, question: { ...q!, kind } } } : {}), asked: true, ask: read?.ask ?? null, ...(read?.choices?.length ? { choices: read.choices } : {}) };
    this.d.store.saveReachOut(r);
    return r;
  }

  /**
   * A notification's push, its attempt rows written for `keys` already (on `channel`: a notification, or a computer's
   * "back" in its place); then Apple's answer on each.
   */
  private async sent(keys: string[], phone: AlertPhone, note: Note, now: number, channel: "notification" | "back" = "notification") {
    // Inside Quiet for a while or your night line (stage 3.4): no sound, the screen dark, its buttons still there.
    const result = await this.pushed(this.d.notify!(phone, this.quietened(note, this.clock.now())));
    for (const key of keys) this.flying.delete(`${channel}\n${key}`);
    const at = this.clock.now();
    const state = result === "sent" ? "accepted" : result === "gone" ? "gone" : result === "unknown" ? "unknown" : "refused";
    for (const key of keys) this.d.store.updateDelivery({ key, channel, at: now, state, ...(result === "sent" ? { acceptedAt: at } : {}) });
    this.d.log(`engine: notification (${note.kind}): ${result}`);
    this.track("reach_sent", { channel: "notification", result: result === "unknown" ? "failed" : result, kind: note.kind });
    if (result === "gone") this.d.ringer?.forgetAlert(phone.token);
  }

  /** A push's answer, or `unknown` when Apple says nothing in `PUSH_MS` (one hung push never holds up the rest). */
  private pushed(p: Promise<"sent" | "gone" | "failed">): Promise<"sent" | "gone" | "failed" | "unknown"> {
    let timer: Timer | null = null;
    const late = new Promise<"unknown">((resolve) => (timer = this.clock.setTimeout(() => resolve("unknown"), PUSH_MS)));
    return Promise.race([p.catch((e) => (this.d.log(`engine: couldn't send a push (${describe(e)})`), "failed" as const)), late]).finally(() => timer && this.clock.clear(timer));
  }

  // --- told, kept, dropped ---

  /**
   * Proof the user had `key`'s news (said in a call, or a call-back owning it): it's told. A wait whose every fact was
   * told in a call has nothing left to call back with.
   */
  told(key: string) {
    const r = this.d.store.reachOut(key);
    if (!r || r.state !== "untold") return;
    this.d.store.saveReachOut({ ...r, state: "told" });
    this.spent(r);
  }

  /**
   * A wait that's over whose every fact `r` shares was told or dropped (answered at the computer meanwhile) has nothing
   * left to call back with: it goes, or with `later`, is put there for its caller to drop once its writes are kept.
   */
  private spent(r: ReachOut, later?: Set<Wait>) {
    for (const w of this.d.waits.all()) {
      const id = headOf(w).id;
      if (!w.ready || !r.duties.some((d) => d.rule === id)) continue;
      if (!this.keysOf(w).every((k) => this.d.store.reachOut(k)?.state !== "untold")) continue;
      if (later) later.add(w);
      else this.d.waits.told(w.conversationId, w);
    }
  }

  /**
   * The reach-outs a call-back owns once its session exists: told, so nothing else delivers them. A ring that led to it
   * is established, which alone cancels its missed notification. A wait elsewhere whose news it all took (Call back
   * tells every untold reach-out) goes with it, so the next Start doesn't open it again: its row now, with the rest of
   * these writes, which the caller keeps in one transaction with the call-back's own (server.ts); from memory only by
   * what this returns, run once that transaction is kept, so a write that fails leaves memory and the store agreeing.
   */
  owned(keys: string[]): () => void {
    const spent = new Set<Wait>();
    for (const k of keys) {
      const r = this.d.store.reachOut(k);
      if (r?.state === "untold") {
        this.d.store.saveReachOut({ ...r, state: "told" });
        this.spent(r, spent);
      }
      const ring = this.d.store.deliveries(k).find((d) => d.channel === "ring");
      if (ring && ring.callback !== "established") this.d.store.updateDelivery({ ...ring, callback: "established" });
    }
    for (const w of spent) this.d.store.deleteWait(w.conversationId);
    return () => {
      for (const w of spent) this.d.waits.told(w.conversationId, w);
    };
  }

  /**
   * A tap on one of a question's options reached the brain (`POST /api/reply` with `questionId`), before anything else
   * is done with it: whatever becomes of it, refused or sent, the line after the tap takes its notification's place, so
   * nothing takes that away, and the question moving on meanwhile (the computer's report can come before the send's own
   * answer) is news the user had, not news dropped.
   */
  tapping(itemId: string, questionId: string) {
    for (const r of this.d.store.reachOuts()) {
      if (r.kind === "question" && r.news.itemId === itemId && r.news.question?.id === questionId && !r.tapped) this.d.store.saveReachOut({ ...r, tapped: true });
    }
  }

  /**
   * A tap on one of a question's options went through (`POST /api/reply` with `questionId`): the user had its news, so
   * it's told (§3, Told), not dropped as answered elsewhere.
   */
  tapped(itemId: string, questionId: string) {
    for (const r of this.d.store.reachOuts()) {
      if (r.kind !== "question" || r.news.itemId !== itemId || r.news.question?.id !== questionId || (r.tapped && r.state !== "untold")) continue;
      const told: ReachOut = { ...r, state: r.state === "untold" ? "told" : r.state, tapped: true };
      this.d.store.saveReachOut(told);
      if (r.state === "untold") this.spent(told);
    }
  }

  /**
   * A thread running again, asking something, or gone, as last seen (Fable's 4-K): a write from its reply's notification
   * would steer it or answer nothing, so that notification has Call back alone.
   */
  private busy(itemId: string): boolean {
    const item = this.items.get(itemId);
    return !item || item.status === "running" || item.pendingQuestion;
  }

  /**
   * Whether the phone registers the write categories (Fable's 4-K: quick replies and Reply…), as its build said when it
   * registered (`PhoneRecord.writes`): an older build is sent the categories it has, so it keeps Call back.
   */
  private writes(): boolean {
    return this.d.ringer?.record()?.writes === true;
  }

  /** The threads written to from a notification whose next reply notifies once (`wrote`), by id. */
  private wroteMap(): Record<string, { at: number; until: number; ran?: true; answered?: string; runAt?: number }> {
    try {
      const all = JSON.parse(this.d.store.get(WROTE) ?? "{}");
      return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  }

  /**
   * A write from a notification went (a quick reply, Reply…, or one of a question's buttons; Fable's 4-K): the user had
   * that notification's news (`key`: it's told, as a tapped answer's question is), and the thread's next reply, or the
   * question it asks next, notifies once whether it's followed or not, with why "You were waiting for it." and the same
   * buttons, for as long as the level watches. `answered`: the question a button answered, which isn't news again while
   * the computer still shows it open. `runAt`: the thread's last run before the write, on the computer's own clock (the
   * reply's reach-out's, else its run as last seen), which a later run's end is compared with, so a computer whose clock
   * is behind the brain's isn't missed, whatever the write was (a reply's quick reply or Reply…, a question's button or
   * typed answer; the skeptic, 4-K's second review).
   */
  wrote(itemId: string, key: string | null, answered?: string) {
    const now = this.clock.now();
    const r = key ? this.d.store.reachOut(key) : null;
    if (r?.state === "untold" && r.news.itemId === itemId) {
      const told: ReachOut = { ...r, state: "told", tapped: true };
      this.d.store.saveReachOut(told);
      this.spent(told);
    }
    const all = this.wroteMap();
    const seen = Date.parse(this.items.get(itemId)?.lastRunAt ?? "") || 0;
    const runAt = r?.news.itemId === itemId && r.news.seen.runAt > 0 ? r.news.seen.runAt : seen > 0 ? seen : undefined;
    all[itemId] = { at: now, until: now + this.limits().watchHours * 3600_000, ...(answered ? { answered } : {}), ...(runAt !== undefined ? { runAt } : {}) };
    this.d.store.set(WROTE, JSON.stringify(all));
  }

  /**
   * Each thread written to from a notification (`wrote`): once a run of it ends after the write (seen running since, or
   * its run's end after it), its reply is a fact, or the question it asks then (never a held command: that's its own),
   * with a pause's duty (`R-wrote:<thread>`, why "You were waiting for it."), told by notification, never a ring; then it
   * goes. Past the level's watch, or the thread gone from a computer that's there, it goes with nothing told.
   */
  private watchWrote(keys: Map<string, string | null>, now: number) {
    const all = this.wroteMap();
    let changed = false;
    for (const [id, w] of Object.entries(all)) {
      const item = this.items.get(id);
      if (now > w.until || (!item && this.reachable(id))) {
        delete all[id];
        changed = true;
        continue;
      }
      if (!item || item.gate) continue;
      const asks = item.pendingQuestion && !!keys.get(id) && (w.answered === undefined || item.questionId !== w.answered);
      if (item.status === "running" && !asks) {
        if (!w.ran) changed = w.ran = true;
        continue;
      }
      const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
      // A run ended after the write: after the thread's last run before it (on the computer's clock) when it's known,
      // else after the write (the brain's).
      if (!asks && !w.ran && !(runAt > (w.runAt !== undefined ? w.runAt + RUN_ENDS_MS : w.at))) continue;
      const handle = this.nameOf(item);
      const kind = asks ? "question" : "reply";
      const news = this.newsOf(item, handle, kind);
      delete all[id];
      changed = true;
      if (kind === "reply" && this.heard(news)) continue;
      const fact = asks ? keys.get(id)! : this.observations.run(id, runAt, now);
      this.addDuty(fact, kind, news, { rule: `${WROTE_RULE}${id}`, via: "callback", pause: true, ring: false, tell: true, urgency: "urgent", from: now }, undefined, now);
      this.d.log(`engine: ${handle} ${asks ? "asks something" : "replied"} after a write from a notification; it's told once`);
    }
    if (changed) this.d.store.set(WROTE, JSON.stringify(all));
  }

  /** A thread's replies not yet told, by key, as the app asks for its list of them: what opening it may tell (`opened`). */
  untoldReplies(itemId: string): string[] {
    return this.d.store.reachOuts().filter((r) => r.state === "untold" && r.kind === "reply" && r.news.itemId === itemId).map((r) => r.key);
  }

  /**
   * The app opened on a thread and showed its replies (`GET /api/replies`), `newest` the latest it showed (null: none):
   * the user saw those, so they're told, and a reply gathering for following's batch leaves it. Only those (§3, Told):
   * of `news`, its untold replies as the list was asked for (`untoldReplies`), each the list shows, its run ended by
   * `newest` (a run ends just after its last message: within the second reads.ts allows), or with no time of its own,
   * by any reply shown. A reply that came while the list was fetched, or that a list older than the engine's look
   * doesn't have, stays news, and its call-back stays ready.
   */
  opened(itemId: string, news: string[], newest: string | null) {
    // Its questions were in front of the user: example 11's escalation is called off for them (stage 3.4).
    const at = this.clock.now();
    for (const r of this.d.store.reachOuts()) if (r.kind === "question" && r.state === "untold" && r.news.itemId === itemId && r.opened === undefined) this.d.store.saveReachOut({ ...r, opened: at });
    const shown = newest === null ? NaN : Date.parse(newest);
    if (Number.isNaN(shown)) return;
    for (const key of news) {
      const r = this.d.store.reachOut(key);
      if (!r || r.state !== "untold" || r.kind !== "reply" || r.news.itemId !== itemId || r.news.seen.runAt > shown + RUN_ENDS_MS) continue;
      this.d.store.saveReachOut({ ...r, state: "told" });
      this.spent(r);
    }
    this.soon();
  }

  /** A wait's facts, for its call-back to own. */
  factsOf(w: Wait): string[] {
    this.fromWaits();
    return this.keysOf(w);
  }

  /** One reach-out, as kept. */
  reachOut(key: string): ReachOut | null {
    return this.d.store.reachOut(key);
  }

  /**
   * The untold news a call-back opens with (`POST /api/session {mode: "callback"}`): `key`'s first, then every other
   * untold reach-out, each question only while it's still asked (an answer at the computer meanwhile drops it, and the
   * call-back opens with nothing stale). Null when `key` isn't untold news any more. Without a key (a ring answered, by
   * its conversation), all of it.
   */
  async callBack(key: string | null): Promise<ReachOut[] | null> {
    const items = await this.d.adapter.list().catch(() => null);
    if (items) this.see(items, this.clock.now());
    this.expire(this.clock.now());
    // A briefing's (stage 3.8) isn't a call's news: its notification is all of it.
    // Nor what became of a send for later (stage 4b): its notification, or its line in a call, is all of it.
    // Nor a command a computer holds (stage 4c), or a question that is one (Away's): its notification, or its own line in
    // a call, is all of it; a call-back it rang for opens with it (`heldIn`), and so does its missed call's Call back.
    // Nor is example 2's (a call has no words for it yet), nor a turn still waiting for its judged check (stage 3.5):
    // told only once it's judged.
    const all = this.d.store.reachOuts().filter((r) => r.state === "untold" && r.kind !== "brief" && r.kind !== "later" && r.kind !== "held" && !this.heldOf(r) && !r.news.idle && !r.duties.every((d) => d.judged === "needs_you" || d.judged === "judge"));
    if (key === null) return all;
    const rang = this.d.store.reachOut(key);
    // A hold a call-back rang for, or a line (`ringHeldLine`), whose ring names it.
    const rung = !!rang && (!!rang.rangFor || this.d.store.deliveries(rang.key).some((d) => d.channel === "ring"));
    const first = all.find((r) => r.key === key) ?? (rang?.kind === "held" && rang.state === "untold" && rung && this.heldOf(rang) ? rang : undefined);
    return first ? [first, ...all.filter((r) => r !== first)] : null;
  }

  /**
   * The untold news a call the voice opens tells first (stage 2b; Fable's 2b topic 3), looked at as it opens: every
   * untold reach-out that has gone somewhere already (a notification, a ring, kept for a call; one still in its grace is
   * told in the call as it comes due), a question only while it's still asked, in order: open questions, the one waiting
   * longest first (an agent is stopped on each); then trouble (a run failed or stopped, a computer gone offline); then the
   * rest, what they asked to hear back about before what they follow, newest first. A briefing's isn't a call's news,
   * nor a held command, nor a question that is one (`callBack`): its own line tells it (stage 4c, `keptLater`).
   */
  async openingNews(): Promise<ReachOut[]> {
    const news = ((await this.callBack(null)) ?? []).filter((r) => this.d.store.deliveries(r.key).length > 0);
    const rank = (r: ReachOut) => (r.kind === "question" ? 0 : r.kind === "offline" || r.news.status ? 1 : r.duties.some((d) => d.via === "callback") ? 2 : 3);
    return news.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.at - b.at : b.at - a.at));
  }

  /** Why the app tells `r`, as its notification says it ("You follow it."): what "why are you telling me that?" gets. */
  whyOf(r: ReachOut): string {
    return whyOf(r.duties).split("\n")[0] ?? "";
  }

  /**
   * "Approve to send" (stage 2b; Fable's 2b topic 7): a send waiting for Face ID, on the phone's lock screen: during a call
   * as soon as it's proposed with the phone locked, and at the call's end for each kept in the car. One for each send,
   * under its own collapse id (`id`: its proposal's or kept reply's), never merged; `active` with no sound, since in a
   * call a sound would talk over the voice, and after a car call the driver was told already. No why: these are the
   * user's own words from a moment ago. Nothing with Notifications off. Whether Apple took it.
   */
  async approve(a: { id: string; start: boolean; name: string | null; message: string; expiresAt: number; conversationId?: string }): Promise<boolean> {
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) return false;
    const result = await this.pushed(this.d.notify(phone, approveNoteOf(a, privacyOf(this.d.store).names)));
    this.d.log(`engine: notification (approve): ${result}`);
    this.track("reach_sent", { channel: "notification", result: result === "unknown" ? "failed" : result, kind: "approve" });
    if (result === "gone") this.d.ringer?.forgetAlert(phone.token);
    return result === "sent";
  }

  /** Untold news kept past its time is dropped; reach-outs dealt with long ago are pruned. */
  private expire(now: number) {
    for (const r of this.d.store.reachOuts()) {
      if (r.state !== "untold" || now <= r.keepUntil) continue;
      this.d.store.saveReachOut({ ...r, state: "dropped" });
      this.d.log(`engine: ${r.news.handle}'s news was kept ${NEWS_MS / 3600_000} h unheard; dropped`);
      this.track("news_dropped", { what: "reach_out" });
    }
    this.d.store.pruneReachOuts(now - KEPT_MS);
    for (const [k, at] of this.deferred) if (at < now - NEWS_MS) this.deferred.delete(k);
  }

  /**
   * §3's recovery: a delivery still `sending` (a crash between its attempt and its result) is `unknown`, never retried.
   * One whose push this brain is still waiting on (Apple slow to answer) isn't a crash's, and is left to its answer.
   */
  private recover() {
    for (const d of this.d.store.deliveries()) {
      if (d.state !== "sending" || this.flying.has(`${d.channel}\n${d.key}`)) continue;
      // An unknown ring counts as rung and unanswered: its deadline from the attempt.
      this.d.store.updateDelivery({ ...d, state: "unknown", ...(d.channel === "ring" ? { missedAt: d.at + MISSED_MS } : {}) });
      this.d.log(`engine: ${d.key}'s ${d.channel} may or may not have gone; it's never tried again`);
    }
  }

  /**
   * Untold news the heard tables say the user had (a call, a call-back or a reading marked it: `heard`, `stars.seen_*`),
   * told, never told again. A roll-forward's check (§11, Rollback): stage 1, rolled back to, tells a call-back's news
   * without knowing of reach-outs. A reply is heard by its run, a question by its id; one with neither can't be told apart.
   */
  private heardBefore() {
    const stars = this.d.store.starsSeen();
    for (const r of this.d.store.reachOuts()) {
      if (r.state !== "untold") continue;
      const seen = [...this.d.store.heardAll(r.news.itemId), ...(stars.has(r.news.itemId) ? [stars.get(r.news.itemId)!] : [])];
      const id = r.news.seen.question;
      const heard = r.kind === "question" ? id !== null && seen.some((s) => s.question === id) : r.news.seen.runAt > 0 && seen.some((s) => s.runAt >= r.news.seen.runAt);
      if (!heard) continue;
      this.d.store.saveReachOut({ ...r, state: "told" });
      this.d.log(`engine: ${r.news.handle}'s news was heard meanwhile; it isn't told again`);
      this.spent(r);
    }
  }

  /** Ends a rule: its row goes, and what it queued and hasn't sent goes with it (its duty, and news only it had). */
  private end(ruleId: string) {
    this.d.store.db.transaction(() => {
      this.d.store.deleteRule(ruleId);
      this.dropQueued(ruleId);
    });
  }

  /**
   * What rule `ruleId` queued and hasn't sent, for `itemId` only if given (and of `kind`, or the one fact `key`, if
   * given): its duty goes, and news only it had. News only kept for a call (`kept`) wasn't sent: it goes too.
   */
  private dropQueued(ruleId: string, itemId?: string, kind?: ReachOut["kind"], key?: string) {
    for (const r of this.d.store.reachOuts()) {
      if (r.state !== "untold" || !r.duties.some((d) => d.rule === ruleId) || (itemId !== undefined && r.news.itemId !== itemId)) continue;
      if ((kind !== undefined && r.kind !== kind) || (key !== undefined && r.key !== key)) continue;
      const duties = r.duties.filter((d) => d.rule !== ruleId);
      const sent = this.d.store.deliveries(r.key).some((d) => d.channel !== "kept" && QUIET.has(d.channel));
      this.d.store.saveReachOut(duties.length || sent ? { ...r, duties: duties.length ? duties : r.duties } : { ...r, state: "dropped" });
    }
  }

  // --- Watching (stage 2a item 9) ---

  /**
   * Each call-back still watching, as one sentence built in code, with its time left. Following isn't a row. As it is
   * now (Fable, 3.3): "Calling you when API replies" while it would ring; "Telling you when API replies" when it would
   * be a notification instead (Call me back off, or the level); else "Watching API for your next call". On Commute, the
   * row the level changes says how, before the time left; at midnight on the phone's clock a row still watching goes
   * back to calling, with no line. Away first, then sends and starts for later (later.ts), then the call-backs.
   */
  watching(now = this.clock.now()): Watching[] {
    return this.rows(now).map((r) => r.row);
  }

  /**
   * Watching's rows (`watching`), each with how the voice says it (stage 2b; Fable's 2b topic 1: the app's sentence, its
   * times on the spoken clock, `sayRow`) and the threads it's about (`itemIds`, and their names as said, `handles`; none
   * for Away). A send, start or chain set up for later (stage 4b, 4-J) has no spoken row here (`spoken` null): "what are
   * you watching" says each in its own sentence (Fable's 4-D, later.ts `said`), and Stop by voice is the `later` tool's
   * (4-E).
   */
  private rows(now: number): { row: Watching; spoken: SpokenRow | null; itemIds: string[]; handles: string[] }[] {
    // A wait over before its not-before still has its call to come (stage 3.6): it's still a row, and can be stopped.
    const open = this.d.waits.all().filter((w) => !w.ready || this.d.waits.early(w, now));
    const limit = this.limits().ring;
    const canRing = !!this.d.ringer?.canRing();
    const used = limit === true ? 0 : this.ringsToday(now);
    const zone = this.zone();
    // Call-backs asked for in words, none fired: more of them than rings left, and whichever is first rings.
    const asked = open.filter((w) => headOf(w).ring && headOf(w).made.via !== "pause").length;
    const hold = this.holdNow(now);
    // Away, first, while it's on (stage 3.9; Fable, 3.9-G): "Away until Monday 08:00", what it tells, the time left, Stop.
    const away = this.away();
    const awayRow = away && now < away.lifetime.at
      ? [{
          row: { id: away.id, said: `Away until ${shownClock(away.lifetime.at, zone, now)}`, note: AWAY_SAID, leftMs: away.lifetime.at - now, until: away.lifetime.at, ring: false, wouldRing: false },
          // Said as Away's own line says it (away.ts `awaySaid`; its note isn't said).
          spoken: { away: awayOn(spokenDay(away.lifetime.at, zone, now)) },
          itemIds: [],
          handles: [],
        }]
      : [];
    // A chain's tail as it would reach them now (4-J): a call while Call me back rings, else a notification, else kept.
    const tailDoing = (tail: "call" | "notify" | "kept") => (tail === "call" && canRing ? "calling" : tail !== "kept" && this.notifies() ? "telling" : "kept");
    const laterRows = (this.d.later?.rows(now, tailDoing) ?? []).map((row) => ({ row, spoken: null, itemIds: [], handles: [] }));
    return [...awayRow, ...laterRows, ...open.map((w) => {
      const head = headOf(w);
      const until = Math.max(...w.items.map((i) => (i.startedAt ?? w.startedAt) + head.lifetime.watchMs));
      const verb = w.items.length > 1 ? "reply" : "replies";
      // Agreed to as a notification (a not-before its watch couldn't reach) is "Telling you…" for its whole life.
      const wouldRing = head.ring && this.allows(w, now) && !w.mode?.notify;
      const ring = wouldRing && canRing;
      // In the car inside the night line's hours, the car line keeps what the night holds (nothing to read: the third
      // reviews of 3.4), so it's for your next call.
      const tells = head.ring && !ring && this.notifies() && !(hold.by === "car" && hold.night);
      // A not-before still ahead (Fable, topic 8): ", from 19:00" as shown, ", from 7 in the evening" as said.
      const nb = notBeforeAt(w, zone);
      const ahead = nb !== null && nb > now ? nb : null;
      const m = w.mode;
      const doing = ring ? "calling" : tells ? "telling" : "kept";
      // A time (stage 3.8; Fable, topic 16): a deadline's or a check-in's sentence, the time on the phone's clock now
      // (none with no zone), counting down to it.
      const time = m?.deadline ?? m?.checkIn;
      const phoneZone = this.phoneZone();
      const handles = w.items.map((i) => i.handle);
      // The sentence with its times as `clock` says them: shown ("19:00") for the app, spoken ("7 in the evening") for the voice.
      const sentence = (clock: (at: number, zone: string, now: number) => string) => {
        const from = ahead !== null ? clock(ahead, zone, now) : null;
        return time !== undefined
          ? timeWatchingOf(handles, m?.deadline !== undefined ? "deadline" : "check", phoneZone ? clock(time, phoneZone, now) : null, doing, from)
          : m && (m.only || m.tests || (m.until === "all" && w.items.length > 1))
          ? watchingOf(handles, { all: m.until === "all", only: m.only ?? null, tests: !!m.tests }, doing, from)
          : ring || tells ? `${ring ? "Calling" : "Telling"} you when ${w.handle} ${verb}${from ? `, from ${from}` : ""}` : `Watching ${w.handle} for your next call`;
      };
      const said = sentence(shownClock);
      // Agreed to as a notification: today's call-back used says so while it is (with a mode, it stays a notification
      // after midnight, with no line).
      const level = limit === true || !canRing ? undefined
        : ring ? (asked > limit.perDay - used ? WATCHING_NOTE.either : undefined)
        : !tells ? undefined
        : m?.notify ? (used >= limit.perDay ? WATCHING_NOTE.used : undefined)
        : head.made.via === "pause" ? WATCHING_NOTE.notify
        : used >= limit.perDay ? WATCHING_NOTE.used : undefined;
      // Waiting for all: how many are done, once one is (Fable, topic 8), before the level's note.
      const done = m?.until === "all" && w.items.length > 1 ? w.items.filter((i) => {
        const o = settle(i, this.items.get(i.itemId), w.startedAt, now, head.lifetime);
        return this.items.has(i.itemId) && (o === "finished" || o === "failed");
      }).length : 0;
      // Its threads' computer offline, until it's back (stage 3.7; Fable, topics 8 and 11): "Quartz is offline".
      const offline = [...new Set(w.items.flatMap((i) => {
        const link = this.link(i.itemId);
        return link && offlineSince(link, now) !== null ? [link.machine] : [];
      }))];
      // Your night line or Quiet for a while holding its call now (stage 3.4; Fable, topic 10): "Your rules hold calls
      // until 07:00", "Quiet until 15:30"; asked for with "call me anyway", "Even at night".
      const held = this.heldNote(w, now, hold);
      // A deadline's row starts its second line with "Sooner if it fails or asks" (Fable, topic 16), kept or not.
      const note = [m?.deadline !== undefined ? SOONER : "", done ? `${done} of ${w.items.length} done` : "", ...offline.map(offlineNote), level ?? "", held].filter(Boolean).join(" · ");
      const end = time ?? until;
      // Stage 5 (Fable's topics 1, 3 and 5): a watch the user asked for has Change, its card and its sheet.
      const change = changeable(w) ? this.changeOf(w, this.rowHow(w, now), now) : {};
      const row: Watching = { id: head.id, said, ...(note ? { note } : {}), leftMs: Math.max(0, end - now), until: end, ring, wouldRing, conversationId: w.conversationId, ...change };
      // Its sentence has a time of its own when it shows a deadline's or a check-in's clock, or a not-before (never kept).
      const timed = (time !== undefined && !!phoneZone && doing !== "kept") || (ahead !== null && doing !== "kept");
      const spoken: SpokenRow = { said: sentence(spokenClock), threads: handles, timed, leftMs: row.leftMs, ...(done ? { done: { n: done, total: w.items.length } } : {}), offline };
      return { row, spoken, itemIds: w.items.map((i) => i.itemId), handles };
    })];
  }

  /**
   * "What are you watching for me?" (stage 2b; Fable's 2b topic 1; Fable's 4-D for sends and starts), said word for word,
   * one sentence each, as one answer (`watchingAnswer`): Away; each command held for the user on their phone (4-H3's
   * line), said whole since Watching has no row for it here; each send, start or chain still to go (later.ts `said`); each
   * call-back as `sayRow` says it, with its time left. Never the rules (Fable's 2b topic 1, upheld on the review of 4-E:
   * asked about outright, they're spike/engine-rules'), nor followed threads. With nothing, whether the threads they
   * follow still notify them: following's rule on, Notifications on, and a followed thread not set to Nothing.
   */
  watchingSaid(now = this.clock.now()): string {
    const { away, held, later, backs } = this.watchingParts(now);
    const rows = [...away, ...held, ...later, ...backs];
    const followed = !rows.length && !!this.following() && this.notifies()
      && [...this.d.store.stars()].some((id) => notifyOf(this.d.store.threadNotify(id), true) !== "nothing");
    return watchingAnswer(rows, followed);
  }

  /**
   * Whether `watchingSaid` names sends and starts for later and nothing else (Fable's ruling on the second review of
   * 4-E): only then is "stop that" straight after it about one of them. With a call-back, Away or a held command in it,
   * "stop that" only cuts the voice off (2b's `stop_watching` stops a call-back by its thread, never "stop that").
   */
  watchingOnlyLater(now = this.clock.now()): boolean {
    const { away, held, backs } = this.watchingParts(now);
    // One still waiting among them: a send past its window that hasn't gone isn't (Fable's nit on the third review).
    return !!this.d.later?.anyWaiting(now) && !away.length && !held.length && !backs.length;
  }

  /** "What are you watching for me?"'s sentences, by kind, in `watchingSaid`'s order. */
  private watchingParts(now: number): { away: string[]; held: { whole: string }[]; later: string[]; backs: string[] } {
    const all = this.rows(now);
    // Away's row, or the call-backs', as `sayRow` says them (a send or start for later has none: `said` says it).
    const spoken = (away: boolean) => all.flatMap((r) => (r.spoken && ("away" in r.spoken) === away ? [sayRow(r.spoken)] : []));
    const computers = this.computers();
    const held = [...this.items.values()].filter((i) => i.gate && i.questionId && i.parentId === null)
      .map((i) => ({ whole: heldSaid(this.nameOf(i), i.gate!.matched, i.machine ?? "your computer", computers) }));
    return { away: spoken(true), held, later: this.d.later?.said(now) ?? [], backs: spoken(false) };
  }

  /**
   * "Stop watching API" and "Stop watching everything" (stage 2b; Fable's 2b topic 2): done at once, with no readback and
   * no yes, as the app's Stop is one tap. `threads`: the threads named (their ids and names as said); every call-back
   * about only those threads stops. One about threads they didn't name too stops whole, so nothing stops until they agree
   * (`agreed`: their yes to `stopWholeQuestion` about the first such row, which the tool checks they heard), and the
   * question is asked first. Each such row is asked about in turn: a yes stops the row it named (and any about only
   * threads they've agreed to), never another they haven't heard of, which its line then asks about. `everything`: every
   * call-back, never Away. The line to say, word for word; `question`, the question it ends with, when it asks one;
   * `stopped` when a call-back was stopped (the claim check's record: never for nothing stopped, nor a failure). A send,
   * start or chain for later is never stopped here, and where it says nothing or every call-back stopped, what's still
   * waiting is said last (later.ts `stillSaid`; Fable's ruling on pass B1's review), so it never denies one the list just
   * said; `later`, what that sentence is about, for "stop that" after it.
   */
  stopWatching(ask: { threads: { itemId: string; handle: string }[] } | { everything: true }, agreed = false, now = this.clock.now()): { line: string; question?: string; stopped?: true; later?: { only: string[] | null } } {
    const rows = this.rows(now);
    const backs = rows.filter((r) => r.itemIds.length > 0);
    const awayOnNow = rows.some((r) => !!r.spoken && "away" in r.spoken);
    const waiting = (line: string): { line: string; later?: { only: string[] | null } } => {
      const still = this.d.later?.stillSaid(now) ?? null;
      return still ? { line: `${line} ${still.line}`, later: { only: still.only } } : { line };
    };
    try {
      if ("everything" in ask) {
        if (!backs.length) return waiting(awayOnNow ? `${NOTHING_TO_STOP} ${AWAY_STILL_ON}` : NOTHING_TO_STOP);
        if (!backs.every((r) => this.stop(r.row.id))) return { line: STOP_FAILED };
        return { ...waiting(awayOnNow ? `${STOPPED_ALL} ${AWAY_STILL_ON}` : STOPPED_ALL), stopped: true };
      }
      if (!backs.length) return waiting(NOTHING_TO_STOP);
      const named = new Set(ask.threads.map((t) => t.itemId));
      const touching = backs.filter((r) => r.itemIds.some((id) => named.has(id)));
      const within = (ids: Set<string>) => (r: (typeof rows)[number]) => r.itemIds.every((id) => ids.has(id));
      const wider = touching.find((r) => !within(named)(r));
      // A row stops whole: one about a thread they didn't name waits for their yes, and nothing stops before it.
      if (wider && !agreed) {
        const question = stopWholeQuestion(wider.handles);
        return { line: question, question };
      }
      // Their yes was to the row it asked about: that one stops, and any other only about threads they've agreed to.
      const allowed = new Set([...named, ...(agreed && wider ? wider.itemIds : [])]);
      const stopping = touching.filter(within(allowed));
      if (!stopping.every((r) => this.stop(r.row.id))) return { line: STOP_FAILED };
      // What stopped, named as said: the threads named it covered, and with a yes to a wider one, every thread it had.
      const stopped = [...new Map(stopping.flatMap((r) => r.itemIds.map((id, i) => [id, r.handles[i]] as const))).entries()];
      // Another row about a thread they didn't name: asked about next, nothing of it stopped.
      const next = touching.find((r) => !stopping.includes(r));
      if (next) {
        const question = stopWholeQuestion(next.handles);
        return { line: [...(stopped.length ? [stoppedWatching(stopped.map(([, h]) => h))] : []), question].join(" "), question, ...(stopped.length ? { stopped: true as const } : {}) };
      }
      const missing = ask.threads.filter((t) => !touching.some((r) => r.itemIds.includes(t.itemId)));
      if (!stopped.length) return { line: notWatching(missing.map((t) => t.handle)) };
      const said = [stoppedWatching(stopped.map(([, h]) => h))];
      // One thread stopped that they follow, which notifies them still (its setting not Nothing, Notifications on).
      if (stopped.length === 1 && this.d.store.stars().has(stopped[0][0]) && this.notifies() && !!this.following()
        && notifyOf(this.d.store.threadNotify(stopped[0][0]), true) !== "nothing") said.push(STILL_FOLLOWED);
      if (missing.length) said.push(notWatching(missing.map((t) => t.handle)));
      return { line: said.join(" "), stopped: true };
    } catch (e) {
      this.d.log(`engine: couldn't stop watching (${describe(e)})`);
      return { line: STOP_FAILED };
    }
  }

  /**
   * The readback of a call-back asked for in words (`wait_for` hanging up), when the level's limit bites (Fable, 3.3):
   * on Commute with Call me back on, today's ring used, or another call-back asked for that hasn't fired yet holding it.
   * Null when nothing bites, so today's words stand with nothing about the level. `threads`: the threads asked about.
   * `agreed`: what's said once the user agrees to it.
   */
  callBackReadback(conversationId: string, threads: string[], now = this.clock.now()): { readback: string; agreed: string } | null {
    const bite = this.ringBite(conversationId, now);
    const readback = commuteReadback(bite, this.notifies(), threads, this.limits().named);
    return bite && readback ? { readback, agreed: commuteAgreed(bite, this.notifies(), threads) } : null;
  }

  /** Commute's day biting a call-back asked for now (3.3): today's ring used, or another asked for holding it; else null. */
  private ringBite(conversationId: string, now: number): "used" | "second" | null {
    const limit = this.limits().ring;
    if (limit === true || !this.d.ringer?.canRing()) return null;
    const left = limit.perDay - this.ringsToday(now);
    const others = this.d.waits.all().filter((w) => w.conversationId !== conversationId && headOf(w).ring && headOf(w).made.via !== "pause" && (!w.ready || (rings(w) && !this.dealt(w)))).length;
    return left <= 0 ? "used" : others >= left ? "second" : null;
  }

  /**
   * What `wait_for` says and sets up for a call-back asked for in words (stage 3.6; Fable's topics 2 to 4), from what was
   * asked: the threads as named, waiting for all of them, only for trouble or a failure, a length (`hours`), a time it
   * mustn't reach them before (`notBefore`, as said: "seven"; read on the phone's clock, the next time it comes round,
   * Fable's topic 1), and whether the call stays on. It watches as long as the level allows, or the shorter length asked
   * for (`watchMs`); `notBefore` is the local date and time to keep, unless it was dropped.
   * - `plain`: nothing asked beyond the first reply and nothing biting: the model's own short sentence, as today.
   * - `statement`: a mode, nothing less than asked: its fixed line, said word for word, then the hang-up.
   * - `readback`: less than asked (the level's length, a not-before its watch ends before, Commute's day's call-back
   *   used): a question that waits for the user's yes (3.3's machinery); `agreed` is said after it. `about`: what
   *   bites, Commute's day used ("ring") or held by another call-back ("second"), the length, or a time.
   * - `notify`, on either: what was said promises no call, so the wait never calls in its whole life (the fourth
   *   review of 3.6 to 3.8: Call me back turned on later, or midnight on Commute, never makes it a call): a statement
   *   or readback saying "I'll send a notification", a not-before its watch can't reach (no `notBefore`: it would
   *   otherwise call at the time they asked not to; `modal`, so its running out is still news), Commute's day's
   *   call-back used, a plain ask too (its not-before kept), and the kept statement's "tell you in your next call" (a
   *   promise of no call too, as Commute's "waiting in your next call" is).
   * - `refused`: said word for word; nothing is set up, nothing hangs up (no zone from the phone for a time of day).
   * - `unreadable`: the time said isn't one (`what`: which); the model asks again.
   *
   * Stage 3.8 (Fable's topics 13 and 14): `at`, a time named for a deadline (`atKind` "deadline": "call me if it isn't
   * done by 6") or a check-in ("call me at 3 about API"), a length from now or a time of day on the phone's clock. Its
   * fixed statement says when, and the time is the watch's end (`time`, the instant to keep). Past what the level
   * watches, the offer is the furthest time it can keep, which waits for a yes; that time, as read back, is the one the
   * yes agrees to (`timesAsked`), and one passed by then sets nothing up. A repeating time isn't set up by voice.
   */
  callBackPlan(
    conversationId: string,
    ask: { threads: string[]; all: boolean; only: "failed" | "trouble" | null; hours: number | null; notBefore: string | null; stayOn: boolean; at?: string | null; atKind?: "deadline" | "check_in" | null; tests?: boolean; anyway?: boolean },
    now = this.clock.now(),
  ):
    | { say: "plain"; watchMs: number }
    | { say: "statement"; line: string; watchMs: number; notify?: true; anyway?: true; notBefore?: { date: string; time: string }; time?: { kind: "deadline" | "check"; at: number } }
    | { say: "readback"; readback: string; agreed: string; watchMs: number; about: "ring" | "second" | "length" | "time"; notify?: true; modal?: true; notBefore?: { date: string; time: string }; time?: { kind: "deadline" | "check"; at: number } }
    | { say: "refused"; line: string }
    | { say: "unreadable"; what: "not_before" | "at" } {
    // Times read back and never answered go once they no longer count (the code review's finding: bounded by use).
    for (const [id, t] of this.timesAsked) if (now - t.made >= ASKED_MS) this.timesAsked.delete(id);
    let nb: { date: string; time: string; at: number; guessed: boolean } | null = null;
    if (ask.notBefore !== null) {
      // A time of day is read on the phone's clock; with no zone from the phone, none is guessed (Fable, topic 1).
      const zone = this.phoneZone();
      if (!zone) return { say: "refused", line: NO_ZONE };
      const heard = parseClock(ask.notBefore);
      if (!heard) return { say: "unreadable", what: "not_before" };
      nb = { ...nextClock(heard, zone, now), guessed: heard.half === null };
    }
    const limits = this.limits();
    const levelMs = limits.watchHours * 3600_000;
    let time: TimeAsked | null = null;
    if (ask.at) {
      const kind = ask.atKind === "deadline" ? "deadline" : "check";
      const had = this.timesAsked.get(conversationId);
      if (had && had.said === ask.at && had.kind === kind && now - had.made < ASKED_MS) time = had;
      else {
        const w = parseWhen(ask.at, this.phoneZone(), now);
        if (w === "repeats") return { say: "refused", line: NO_REPEATS };
        if (w === "zone") return { say: "refused", line: NO_ZONE };
        if (w === "passed") return { say: "refused", line: TIME_PASSED };
        if (w === null) return { say: "unreadable", what: "at" };
        // Past what the level watches: the furthest it can keep, to the minute it's said as.
        const capped = w.at - now > levelMs ? (w.clock ? Math.floor((now + levelMs) / 60_000) * 60_000 : now + levelMs) : w.at;
        time = { said: ask.at, kind, made: now, at: w.at, clock: w.clock, ms: w.ms, capped, ...(w.guessed ? { guessed: true as const } : {}) };
      }
      if (time.capped <= now) {
        this.timesAsked.delete(conversationId);
        return { say: "refused", line: TIME_PASSED };
      }
    }
    const kept = { ...(nb ? { notBefore: { date: nb.date, time: nb.time } } : {}), ...(time ? { time: { kind: time.kind, at: time.capped } } : {}) };
    const askedMs = time ? null : ask.hours !== null && ask.hours > 0 ? Math.round(ask.hours * 3600_000) : null;
    const longer = time ? time.capped < time.at : askedMs !== null && askedMs > levelMs;
    const watchMs = time ? time.capped - now : askedMs !== null ? Math.min(askedMs, levelMs) : levelMs;
    const all = ask.all && ask.threads.length > 1;
    // A thread's tests (stage 3.10): a mode, said in every statement and readback; a time asked for wins over it.
    const tests = !!ask.tests && !time;
    const modal = all || !!ask.only || nb !== null || askedMs !== null || time !== null || tests;
    const bite = ask.stayOn ? null : this.ringBite(conversationId, now);
    const notifies = this.notifies();
    // A readback that waits for a yes keeps the time it says (`timesAsked`); anything else lets it go.
    const asking = <T extends { say: string }>(r: T): T => {
      if (time && r.say === "readback") this.timesAsked.set(conversationId, time);
      else this.timesAsked.delete(conversationId);
      return r;
    };
    // Your night line or Quiet for a while holding its call (stage 3.4; Fable, topic 10): said as a statement's last
    // sentence, with "Say call me anyway to be called.", or with "call me anyway" what it rings through.
    const tail = !ask.stayOn && !bite && this.d.ringer?.canRing() && !(time?.guessed || nb?.guessed) ? this.holdTail(now, watchMs, !!ask.anyway) : null;
    const anyway = ask.anyway ? { anyway: true as const } : {};
    // A plain ask keeps 3.3's words when Commute's day bites; one with a mode says its mode, length and time in the
    // readback, whichever bite (Fable's finding on 3.6 to 3.8: never cut down without being said).
    if (!modal) {
      if (tail) {
        const plain: Ask = { threads: ask.threads, all: false, only: null, notBefore: null, watchMs };
        return asking({ say: "statement", line: `${statementOf(plain, tail.verb)}${tail.text}`, watchMs, ...anyway });
      }
      const commute = bite ? this.callBackReadback(conversationId, ask.threads, now) : null;
      // Today's used promises a notification ("I'll send a notification when API replies.") or the next call ("The reply
      // from API will be waiting in your next call."): kept for the wait's whole life, so midnight on the phone's clock
      // never makes it a call (the Skeptic, on 3.3 and on the fourth review of 3.6 to 3.8).
      const promised = bite === "used" ? { notify: true as const } : {};
      return commute ? asking({ say: "readback", ...commute, watchMs, about: bite === "second" ? "second" : "ring", ...kept, ...promised }) : asking({ say: "plain", watchMs });
    }
    const zone = this.zone();
    // A time's lengths are said as asked, or as the level's when it's past it (never a minute short as the readback is
    // read again: `watchMs` counts down to a time kept).
    const a: Ask = {
      threads: ask.threads, all, only: ask.only, notBefore: nb ? spokenClock(nb.at, zone, now) : null, watchMs: time && longer ? levelMs : watchMs, ...(tests ? { tests: true } : {}),
      ...(time ? { time: { kind: time.kind, clock: time.clock ? spokenClock(time.capped, zone, now) : null, length: spokenLength(longer ? levelMs : (time.ms ?? watchMs)) } } : {}),
    };
    // The time asked for, named in a readback that offers an earlier one, when it was said as a time of day.
    const asked = time?.clock && longer ? spokenClock(time.at, zone, now) : null;
    const verb: Verb = ask.stayOn ? "tell" : this.d.ringer?.canRing() ? "call" : notifies ? "notify" : "kept";
    if (nb && nb.at > now + watchMs) {
      // With today's call-back used, 4B's line after Commute's opening (the level named once, Fable's finding).
      const used = bite === "used" ? `You've had today's call-back${limits.named ? " on Commute" : ""}. ` : "";
      const r = notBeforeReadback(a, notifies, limits.level, limits.named && !used);
      // Asked with a mode (`modal`) though none of it is kept: its running out is news (Fable, topic 7).
      return asking("refused" in r ? { say: "refused", line: `${used}${r.refused}` } : { say: "readback", readback: `${used}${r.readback}`, agreed: r.agreed, watchMs, about: "time", notify: true, modal: true, ...(time ? { time: kept.time } : {}) });
    }
    // Its notification, or with Notifications off its next call, is agreed to for the wait's whole life (`notify`), as
    // 4B's is: a watch that crosses midnight on the phone's clock never calls instead (the Skeptic's findings on the
    // second and fourth reviews of 3.6 to 3.8). Its not-before stays.
    if (bite === "used") return asking({ say: "readback", ...commuteModeReadback(a, longer, limits.named, asked, notifies), watchMs, about: "ring", ...kept, notify: true });
    if (bite === "second") return asking({ say: "readback", ...secondReadback(a, longer, levelMs, asked, notifies, limits.named), watchMs, about: "second", ...kept });
    // What it says from here promises no call when its verb is a notification or kept ("…and tell you in your next
    // call."): kept with the wait (`notify`), so Call me back turned on later never calls (the Skeptic's finding on the
    // fourth review of 3.6 to 3.8).
    const promised = verb === "notify" || verb === "kept" ? { notify: true as const } : {};
    // Kept (nothing will reach them) says the length it keeps, and promises nothing to say yes to.
    if (longer && verb !== "kept") {
      const r = a.time ? timeReadback({ ...a, time: a.time }, verb, levelMs, asked, limits.level, limits.named) : lengthReadback(a, verb, limits.level, limits.named);
      return asking({ say: "readback", ...r, watchMs, about: "length", ...kept, ...promised });
    }
    const line = verb === "call" && tail ? `${statementOf(a, tail.verb)}${tail.text}` : statementOf(a, verb);
    // A bare hour guessed into the small hours (Fable's finding on 3.6 to 3.8): the statement waits for a yes. Kept says
    // no not-before, so only its time counts there.
    const night = (at: number) => clockOf(at, zone).hour < 6;
    if ((time?.guessed && night(time.capped)) || (nb?.guessed && verb !== "kept" && night(nb.at))) {
      return asking({ say: "readback", ...smallHoursReadback(a, verb, line), watchMs, about: "time", ...kept, ...promised });
    }
    return asking({ say: "statement", line, watchMs, ...kept, ...promised, ...(verb === "call" ? anyway : {}) });
  }

  /**
   * What a call-back's statement adds when your night line or Quiet for a while will hold its call over the watch (Fable,
   * topic 10), from now to `now + watchMs`: Quiet for a while on, ending inside it ("You're quiet until 3 in the
   * afternoon, so until then it's a silent notification.") or past it (the notification's form, then "You're quiet until
   * 3 in the afternoon. Say call me anyway to be called."); the night line on now (the notification's form when the
   * watch lies wholly inside it; "Your rules hold calls until 7 in the morning. Say call me anyway to be called."), or
   * coming ("After 11 in the evening, your rules make that a silent notification. Say call me anyway to be called.");
   * with "call me anyway", what it rings through (" Even at night.", " Even while you're quiet.", both). Null when
   * nothing holds it. `verb`: the statement's form, a notification's, or with Notifications off the next call's, whose
   * held call waits for it ("…so until then it will wait for your next call.": the final reviews of 3.4, no promise of a
   * notification that can't come); a watch past the night's end says what a reply before it is, as Quiet's does ("…so
   * until then it's a silent notification."). In the car inside the night's hours, with the car line, what the night
   * holds waits for your next call while you're driving and is the night's silent notification once you've stopped
   * (`deliverOne`, Watching: the fourth reviews of 3.4); with Notifications off, it waits either way. The weekend line
   * never shows (it doesn't touch Watching); a Focus, or the car later, can't be foreseen.
   */
  private holdTail(now: number, watchMs: number, anyway: boolean): { text: string; verb: "call" | "notify" | "kept" } | null {
    const end = now + watchMs;
    const zone = this.phoneZone();
    const q = this.quiet(now);
    // Every night line (the reviews of 3.4: a file may have two): the night they hold now, else the next to begin.
    const cur = zone ? this.nightNow(zone, now) : null;
    const starts = zone && !cur ? this.nightLines().flatMap((l) => nightNext(l.params, zone, now) ?? []) : [];
    const next = starts.length ? Math.min(...starts) : null;
    const night = cur ? (cur.end >= end ? "inside" : "until") : next !== null && next < end ? "into" : null;
    const said = (at: number) => spokenClock(at, zone ?? "UTC", now);
    if (anyway) {
      const through = [night ? "at night" : "", q ? "while you're quiet" : ""].filter(Boolean);
      return through.length ? { text: ` Even ${through.join(" and ")}.`, verb: "call" } : null;
    }
    const ANYWAY = "Say call me anyway to be called.";
    const notifies = this.notifies();
    const held = notifies ? "notify" : "kept";
    if (q) return q.until >= end ? { text: ` You're quiet until ${said(q.until)}. ${ANYWAY}`, verb: held } : { text: ` You're quiet until ${said(q.until)}, so until then ${notifies ? "it's a silent notification" : "it will wait for your next call"}.`, verb: "call" };
    // Driving now, inside the night's hours: the car line keeps what the night holds while you're driving.
    const car = notifies && !!cur && this.holdNow(now).by === "car";
    // A watch that runs past the night's end calls after it; before it, a reply is the night's silent notification, or
    // with Notifications off waits for your next call (the third reviews of 3.4: it promised a call at once and gave none).
    const before = car ? "it will wait for your next call while you're driving, and be a silent notification once you've stopped" : notifies ? "it's a silent notification" : "it will wait for your next call";
    if (night === "until") return { text: ` Your rules hold calls until ${said(cur!.end)}, so until then ${before}. ${ANYWAY}`, verb: "call" };
    if (car) return { text: ` Your rules hold calls until ${said(cur!.end)}. Once you've stopped driving, it's a silent notification. ${ANYWAY}`, verb: "kept" };
    if (night === "inside") return { text: ` Your rules hold calls until ${said(cur!.end)}. ${ANYWAY}`, verb: held };
    if (night === "into") return { text: ` After ${said(next!)}, your rules make that ${notifies ? "a silent notification" : "wait for your next call"}. ${ANYWAY}`, verb: "call" };
    return null;
  }

  /**
   * How call-back `w`'s news reaches the user once a holding phone is let go (a watch longer than an hour that held an
   * hour, or one over before its not-before; stage 3.6, Fable's topic 7: only a phone that can be called is let go): a
   * call while it rings and the level lets it now, else a notification (agreed to as one, Commute's day used: the code
   * review's finding on 3.6 to 3.8), else null: nothing but the hold would reach them before their next call, so it isn't
   * let go.
   */
  letGo(w: Wait, now = this.clock.now()): "call" | "notify" | null {
    if (!this.d.ringer?.canRing()) return null;
    if (headOf(w).ring && !w.mode?.notify && this.allows(w, now)) return "call";
    return this.notifies() ? "notify" : null;
  }

  /**
   * How a chain's tail ("and call me when that's done", 4-J) would reach them, as its readback says it (watch-lines'
   * verbs, as `callBackPlan`'s): a call while Call me back rings, else a notification, else kept for the next call.
   */
  tailVerb(): "call" | "notify" | "kept" {
    return this.d.ringer?.canRing() ? "call" : this.notifies() ? "notify" : "kept";
  }

  /** `GET /api/account`'s Call me back (stage 3.3): whether this brain rings a phone at all, and Commute's day. */
  callMeBack(now = this.clock.now()): CallMeBack {
    const limits = this.limits();
    const limit = limits.ring;
    return {
      push: !!this.d.ringer?.canPush(), perDay: limit === true ? null : limit.perDay, usedToday: limit !== true && this.ringsToday(now) >= limit.perDay,
      level: limit !== true && limits.named ? limits.level : null,
    };
  }

  // --- stage 5: a watch's card and sheet, and one set or changed by hand (§11 stage 5; Fable's topics 1 to 7) ---

  /**
   * What can reach the phone for a watch set now (Fable, topic 3): a call, while a phone can be rung and the level lets
   * it; else a notification in its place (Call me back off, or today's call-back used on Commute); else neither.
   */
  reach(now = this.clock.now()): Reach {
    const limit = this.limits().ring;
    const canRing = !!this.d.ringer?.canRing();
    if (canRing && (limit === true || this.ringsToday(now) < limit.perDay)) return "call";
    if (!this.notifies()) return "kept";
    return canRing ? "used" : "off";
  }

  /** Why `w`'s call is held back now (night rule or Quiet for a while), as Watching and the card show it. */
  private heldNote(w: Wait, now: number, hold = this.holdNow(now)): string {
    const head = headOf(w);
    const m = w.mode;
    const canRing = !!this.d.ringer?.canRing();
    const by = head.ring && !m?.notify && canRing && this.levelAllows(w, now) ? hold.by : null;
    const zone = this.zone();
    const phoneZone = this.phoneZone();
    const night = (by === "night" || by === "focus" || by === "car") && hold.night ? hold.night : null;
    const nightEnd = night && phoneZone ? this.nightNow(phoneZone, now)?.end : undefined;
    return night ? (m?.anyway ? "Even at night" : nightEnd ? `Your rules hold calls until ${shownClock(nightEnd, zone, now)}` : "")
      : by === "quiet" && hold.quiet ? (m?.anyway ? "Even while you're quiet" : `Quiet until ${shownClock(hold.quiet.until, zone, now)}`) : "";
  }

  /** How `w` would reach the phone now, as its Watching row says it (`watching`, which works it out the same way). */
  private rowHow(w: Wait, now: number): How {
    const head = headOf(w);
    const canRing = !!this.d.ringer?.canRing();
    const ring = head.ring && this.allows(w, now) && !w.mode?.notify && canRing;
    if (ring) {
      const limit = this.limits().ring;
      if (limit === true) return "call";
      const asked = this.d.waits.all().filter((x) => (!x.ready || this.d.waits.early(x, now)) && headOf(x).ring && headOf(x).made.via !== "pause").length;
      return asked > limit.perDay - this.ringsToday(now) ? "either" : "call";
    }
    if (head.ring && this.notifies()) {
      if (w.mode?.notify) return "notify";
      if (!canRing) return "off";
      return this.levelAllows(w, now) ? "held" : "used";
    }
    return "kept";
  }

  /** A time as the card shows it: on the phone's clock, or with no zone from the phone, a length from now. */
  private shown(at: number, now: number): Shown {
    const zone = this.phoneZone();
    return zone ? { clock: shownClock(at, zone, now) } : { length: spokenLength(Math.max(60_000, at - now)) };
  }

  /** What every sheet shares: now, the phone's clock, and the level. */
  private frame(now: number) {
    const limits = this.limits();
    const zone = this.phoneZone();
    return { now, clock: (at: number) => (zone ? shownClock(at, zone, now) : null), level: limits.level, levelHours: limits.watchHours, named: limits.named, notifies: this.notifies(), rings: !!this.d.ringer?.canRing() };
  }

  /**
   * Why nothing can be set while nothing can reach the phone (`reach()` "kept"), naming only a switch that's off (the third
   * review of stage 5): with Call me back on, today's call-back is used, so Notifications. `siri`: as Siri says it.
   */
  keptLine(siri = false): string {
    return keptLine(!!this.d.ringer?.canRing(), siri, this.limits().named);
  }

  /** When `w` stops watching: its time, else its last thread's own end. */
  private endOfWait(w: Wait, watchMs = headOf(w).lifetime.watchMs): number {
    return w.mode?.deadline ?? w.mode?.checkIn ?? Math.max(...w.items.map((i) => (i.startedAt ?? w.startedAt) + watchMs));
  }

  /** `w` as its card reads it (Fable, topic 2). */
  private specOf(w: Wait, how: How, now: number): Spec {
    const m = w.mode ?? {};
    const time = m.deadline ?? m.checkIn;
    const zone = this.phoneZone();
    const nb = notBeforeAt(w, zone);
    const head = headOf(w);
    const limits = this.limits();
    const held = how === "held" ? this.heldNote(w, now) : "";
    return {
      threads: w.items.map((i) => i.handle), all: m.until === "all" && w.items.length > 1, when: whenOfMode(m),
      ...(time !== undefined ? { at: this.shown(time, now) } : {}),
      notBefore: nb !== null && nb > now && zone ? shownClock(nb, zone, now) : null,
      then: m.notify ? "notify" : "call", how, ...(held ? { held: held.startsWith("Your ") ? `your ${held.slice(5)}` : held } : {}), until: this.shown(this.endOfWait(w), now),
      // The level cut the length asked for (stage 3.6's `hours`).
      ...(m.hours !== undefined && m.hours * 3600_000 > head.lifetime.watchMs + 60_000 ? { cut: { level: limits.level, named: limits.named } } : {}),
    };
  }

  /** A Watching row's Change (Fable, topics 1, 3 and 5): its threads, its card on the hold, and its sheet. */
  private changeOf(w: Wait, how: How, now: number): Pick<Watching, "canChange" | "threadIds" | "card" | "form"> {
    const spec = this.specOf(w, how, now);
    const time = w.mode?.deadline ?? w.mode?.checkIn;
    const nb = notBeforeAt(w, this.phoneZone());
    const form = formOf({ title: sheetTitle(spec.threads), spec, can: this.reach(now), notBeforeAt: nb !== null && nb > now ? nb : null, until: this.endOfWait(w), fixed: time !== undefined, over: !!w.ready, ...this.frame(now) });
    return { canChange: true, threadIds: w.items.map((i) => i.itemId), card: cardOf(spec), form };
  }

  /**
   * The sheet for a new watch on one thread (a thread's page, Fable's topic 6), filled in: It replies or asks, any time,
   * Call me (or the fixed Send a notification and why), until the level's longest. The phone puts the thread's name on it.
   */
  newForm(now = this.clock.now()): Form {
    const can = this.reach(now);
    const until = now + this.limits().watchHours * 3600_000;
    const then: Then = can === "used" || can === "off" ? "notify" : "call";
    const spec: Spec = { threads: [""], all: false, when: "replies", notBefore: null, then, how: can === "call" ? "call" : can, until: this.shown(until, now) };
    return formOf({ title: "", spec, can, notBeforeAt: null, until, ...this.frame(now) });
  }

  /**
   * The card for `wait_for`'s readback while it waits for a yes (Fable, topics 1, 2 and 4), with its sheet: what was
   * asked as its title, and what will really happen over its whole watch (`plan`, the readback's own plan).
   */
  draftOf(ask: { threads: string[]; all: boolean; only: "failed" | "trouble" | null; tests: boolean }, plan: Readback, now = this.clock.now()): DraftCard {
    const zone = this.phoneZone();
    const limits = this.limits();
    const time = plan.time;
    const when: Spec["when"] = time ? (time.kind === "deadline" ? "deadline" : "check") : ask.tests ? "tests" : ask.only === "failed" ? "fails" : ask.only ? "trouble" : "replies";
    // Asked as a call, unless what's read back offers a notification in its place (4B's not-before): Commute's day used
    // is a call asked for, its How saying what will happen.
    const then: Then = plan.notify && plan.about !== "ring" ? "notify" : "call";
    const reach = this.reach(now);
    const how: How = plan.about === "ring" ? (this.notifies() ? "used" : "kept") : plan.about === "second" ? "either" : then === "notify" ? (this.notifies() ? "notify" : "kept") : reach;
    const until = time?.at ?? now + plan.watchMs;
    const nb = plan.notBefore && zone ? instantOf(plan.notBefore.date, plan.notBefore.time, zone) : null;
    const spec: Spec = {
      threads: ask.threads, all: ask.all && ask.threads.length > 1, when, ...(time ? { at: this.shown(time.at, now) } : {}),
      notBefore: nb !== null && zone ? shownClock(nb, zone, now) : null, then, how, until: this.shown(until, now),
      ...(plan.about === "length" ? { cut: { level: limits.level, named: limits.named } } : {}),
    };
    return { ...cardOf(spec), form: formOf({ title: sheetTitle(spec.threads), spec, can: reach, notBeforeAt: nb, until, fixed: !!time, ...this.frame(now) }) };
  }

  /** The open watch the user asked for that covers thread `itemId`, if any: one per thread (Fable, topic 6). */
  watchOn(itemId: string, now = this.clock.now()): Wait | null {
    return this.d.waits.all().find((w) => changeable(w) && (!w.ready || this.d.waits.early(w, now)) && w.items.some((i) => i.itemId === itemId)) ?? null;
  }

  /** Why a tests watch can't be set on `item` (Fable, 3.10-B's lines), or null. */
  private testsRefused(item: WorkItem | undefined, handle: string): string | null {
    if (!item || item.testRuns === false) return cantSeeTests(handle);
    if (item.testRuns !== true) return tooOldForTests(this.d.adapter.link?.(item.id)?.machine ?? item.machine ?? "your computer", handle);
    return null;
  }

  /** A not-before picked on the sheet (an instant), as a wait keeps it, before `end`; or why not. */
  private notBeforeOf(at: number, end: number, now: number): NonNullable<Mode["notBefore"]> | { line: string } {
    const zone = this.phoneZone();
    if (!zone) return { line: SHEET.noZone };
    if (at <= now) return { line: SHEET.past };
    if (at >= end) return { line: SHEET.late };
    const c = clockOf(at, zone);
    return { date: c.date, time: `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}` };
  }

  /**
   * Why the sheet's choices `c` can't be applied to a watch on `t.items`, waiting for `t.when`, asked as a notification
   * (`notify`) and ending at `end`, or null: a When that's fixed (several threads, a time made by voice), tests that can't
   * be seen, a call that can't be made, a not-before that can't be kept. `live`: the threads as the computers say now,
   * for a tests watch's check (else as last seen). `change` refuses with these; so does the call's card's OK, before it
   * sets anything (`cardRefusal`).
   */
  refusal(t: { items: readonly { itemId: string; handle: string }[]; when: Spec["when"]; notify: boolean; end: number }, c: Choices, live?: WorkItem[], now = this.clock.now()): string | null {
    if (c.when !== undefined && c.when !== t.when) {
      if (t.items.length > 1 || t.when === "deadline" || t.when === "check") return SHEET.fixed;
      if (c.when === "tests") {
        const { itemId, handle } = t.items[0];
        const refused = this.testsRefused(live?.find((i) => i.id === itemId) ?? this.items.get(itemId), handle);
        if (refused) return refused;
      }
    }
    if (c.then === "call" && t.notify) {
      const reach = this.reach(now);
      if (reach !== "call") return reach === "used" ? SHEET.used : reach === "off" ? SHEET.off : this.keptLine();
    }
    // A notification with Notifications off would reach nothing (the second review of stage 5).
    if (c.then === "notify" && !t.notify && !this.notifies()) return SHEET.notesOff;
    if (c.notBefore != null) {
      const nb = this.notBeforeOf(c.notBefore, t.end, now);
      if ("line" in nb) return nb.line;
    }
    return null;
  }

  /**
   * Why the call's card's OK can't apply the sheet's choices `c` to what `wait_for`'s readback (`plan`) would set on
   * `items` (the review of stage 5: a change the brain refuses must leave nothing set, the card still waiting), or null.
   * `asked`: what was asked, as `draftOf` takes it.
   */
  cardRefusal(items: readonly { itemId: string; handle: string }[], asked: { only: "failed" | "trouble" | null; tests: boolean }, plan: Readback, c: Choices, live?: WorkItem[], now = this.clock.now()): string | null {
    const time = plan.time;
    const when: Spec["when"] = time ? (time.kind === "deadline" ? "deadline" : "check") : asked.tests ? "tests" : asked.only === "failed" ? "fails" : asked.only ? "trouble" : "replies";
    const end = c.forMs !== undefined && !time ? now + Math.min(c.forMs, this.limits().watchHours * 3600_000) : (time?.at ?? now + plan.watchMs);
    return this.refusal({ items, when, notify: !!plan.notify, end }, c, live, now);
  }

  /**
   * How `w` reaches the phone now, as its Watching row says it: "kept" when nothing can (Call me back and Notifications
   * off, or a notification asked for with Notifications off), so nothing about it may promise one.
   */
  reachOf(w: Wait, now = this.clock.now()): How {
    return this.rowHow(w, now);
  }

  /**
   * A watch made by hand on one thread (`POST /api/rules`: a thread's page or Siri; Fable, topics 6 and 7), the kind a
   * call's "call me when API replies" makes: it rings as Call me back does, and on Commute follows the day's one. The
   * server has found the thread and when to watch it from; `conversationId` is new, the call-back it opens.
   */
  watchOne(conversationId: string, t: { item: WorkItem; handle: string; since: number; patient: boolean }, c: Choices, via: "app" | "siri", now = this.clock.now()): Wait | { line: string } {
    const levelMs = this.limits().watchHours * 3600_000;
    const watchMs = Math.max(60_000, Math.min(c.forMs ?? levelMs, levelMs));
    const mode: Mode = {};
    if (c.when === "tests") {
      const refused = this.testsRefused(t.item, t.handle);
      if (refused) return { line: refused };
      mode.tests = true;
    } else if (c.when === "fails" || c.when === "trouble") mode.only = c.when === "fails" ? "failed" : "trouble";
    // A notification asked for with Notifications off would reach nothing, though a call could (the second review of
    // stage 5): nothing is made, and the line names the switch that's off. It's the one way a new watch can't reach the
    // phone when `reach` says something can.
    if (c.then === "notify" && !this.notifies()) return { line: via === "siri" ? SIRI_NOTES_OFF : SHEET.notesOff };
    if (c.then === "notify") mode.notify = true;
    if (c.notBefore != null) {
      const nb = this.notBeforeOf(c.notBefore, now + watchMs, now);
      if ("line" in nb) return nb;
      mode.notBefore = nb;
    }
    return this.d.waits.start(conversationId, [t], { via, watchMs, mode }, now);
  }

  /**
   * The sheet's OK on a watch that's set (`PUT /api/rules/:id`, and the call's card after its yes; Fable, topics 3 and
   * 5): each part given replaces what it has, in place, and the watch goes on; its Watching row is the answer. Only one
   * the user asked for that's still watching; else 404, and a refusal is 409, each with its line. `live`: the threads as
   * the computers say now, for a tests watch's check (else as last seen).
   */
  change(id: string, c: Choices, live?: WorkItem[], now = this.clock.now()): { row: Watching } | { status: 404 | 409; line: string } {
    const w = this.d.waits.all().find((x) => headOf(x).id === id && changeable(x) && (!x.ready || this.d.waits.early(x, now)));
    if (!w) return { status: 404, line: SHEET.gone };
    const m: Mode = { ...(w.mode ?? {}) };
    const head = headOf(w);
    const time = m.deadline ?? m.checkIn;
    const when = whenOfMode(m);
    // Over already, held for its not-before (its thread replied before that time): its news is decided, so what it waits
    // for and how long can't change under it (the Skeptic's finding on stage 5: changed to "It fails", it still rang
    // "API replied" for a clean finish). Not before and Then still can.
    if (w.ready && ((c.when !== undefined && c.when !== when) || (c.forMs !== undefined && time === undefined))) return { status: 409, line: SHEET.over };
    let watchMs = head.lifetime.watchMs;
    if (c.forMs !== undefined && time === undefined) {
      const end = now + Math.min(c.forMs, this.limits().watchHours * 3600_000);
      watchMs = Math.max(60_000, end - Math.max(...w.items.map((i) => i.startedAt ?? w.startedAt)));
    }
    const refused = this.refusal({ items: w.items, when, notify: !!m.notify, end: this.endOfWait(w, watchMs) }, c, live, now);
    if (refused) return { status: 409, line: refused };
    if (c.when !== undefined && c.when !== when) {
      delete m.only;
      delete m.tests;
      if (c.when === "tests") m.tests = true;
      else if (c.when !== "replies") m.only = c.when === "fails" ? "failed" : "trouble";
    }
    if (c.then === "notify") m.notify = true;
    else if (c.then === "call") delete m.notify;
    if (c.forMs !== undefined && time === undefined) delete m.hours;
    if (c.notBefore === null) delete m.notBefore;
    else if (c.notBefore !== undefined) {
      const nb = this.notBeforeOf(c.notBefore, this.endOfWait(w, watchMs), now);
      if ("line" in nb) return { status: 409, line: nb.line };
      m.notBefore = nb;
    }
    if (Object.keys(m).length) w.mode = m;
    else delete w.mode;
    w.rule = { ...head, lifetime: { ...head.lifetime, watchMs } };
    this.d.waits.extended(w);
    this.d.log(`engine: ${head.id} changed on the phone (${JSON.stringify(c)})`);
    const row = this.watching(now).find((r) => r.id === head.id);
    return row ? { row } : { status: 404, line: SHEET.gone };
  }

  /**
   * What's said or shown once a watch is set by hand (Fable, topics 6 and 7), about thread `handle`: the toast on its page
   * ("I'll call when API replies."), or Siri's line, which says when it's quieter than asked. A watch on several threads
   * or with a time, already there, says its Watching sentence.
   */
  setLineOf(w: Wait, handle: string, siri: boolean, now = this.clock.now()): string {
    const how = this.rowHow(w, now);
    const when = whenOfMode(w.mode ?? {});
    if (w.items.length > 1 || when === "deadline" || when === "check") return `${this.watching(now).find((r) => r.id === headOf(w).id)?.said ?? `Watching ${handle}`}.`;
    const nb = notBeforeAt(w, this.phoneZone());
    const zone = this.phoneZone();
    if (siri && when === "replies" && !w.mode?.notify && !w.mode?.notBefore) {
      const held = how === "held" ? this.heldNote(w, now) : "";
      return siriLine(handle, how, this.limits().named, this.notifies(), held || undefined);
    }
    return setLine(handle, when, how, nb !== null && nb > now && zone ? shownClock(nb, zone, now) : null, this.notifies());
  }

  /**
   * What the voice says once the call's card was set with a change made on screen (Fable, topic 3): `mainOf`'s sentence
   * for the watch as set ("I'll call you when API's tests pass, but not before 7 in the evening."), or kept's statement.
   */
  saidOf(w: Wait, now = this.clock.now()): string {
    const zone = this.zone();
    const m = w.mode ?? {};
    const time = m.deadline ?? m.checkIn;
    const nb = notBeforeAt(w, this.phoneZone());
    const a: Ask = {
      threads: w.items.map((i) => i.handle), all: m.until === "all", only: m.only ?? null, notBefore: nb !== null && nb > now ? spokenClock(nb, zone, now) : null,
      watchMs: headOf(w).lifetime.watchMs, ...(m.tests ? { tests: true } : {}),
      ...(time !== undefined ? { time: { kind: m.deadline !== undefined ? "deadline" as const : "check" as const, clock: this.phoneZone() ? spokenClock(time, zone, now) : null, length: spokenLength(Math.max(60_000, time - now)) } } : {}),
    };
    const how = this.rowHow(w, now);
    return how === "kept" ? statementOf(a, "kept") : mainOf(a, how === "call" || how === "either" ? "call" : "notify");
  }

  /**
   * Stop in Watching (`DELETE /api/rules/:id`): the call-back is called off, and what it queued and hasn't sent goes
   * with it. False for a rule that isn't one of Watching's (following's included: it's each thread's own setting).
   */
  stop(id: string): boolean {
    // A send or a start for later (stage 4b): stopped, and its computers told (later.ts).
    if (id.startsWith(LATER_PREFIX)) return this.d.later?.stop(id) ?? false;
    // Away (stage 3.9): ended at once, silently: you did it in the app.
    const away = this.away();
    if (away && away.id === id) {
      this.endAway(away, { at: this.clock.now(), why: "stop" }, this.clock.now());
      return true;
    }
    const w = this.d.waits.all().find((x) => headOf(x).id === id);
    if (!w) return false;
    this.d.waits.stop(w.conversationId); // `calledOff` drops what it queued
    return true;
  }

  // --- a repeating time (stage 3.8; §3 `every`, Fable's topic 16) ---

  /** The repeating times' rules this version reads (not following's; anything it can't read is left as it is). */
  private everyRules(): EveryRule[] {
    return this.d.store.ruleRows().flatMap((row) => {
      if (row.id === FOLLOWING) return [];
      try {
        const r = JSON.parse(row.rule);
        return validEvery(r) ? [r] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * When `rule` next fires, on the phone's clock now: once per local date, wherever the phone has flown (zone.ts
   * `nextEvery`). None with no zone from the phone: no time of day is guessed.
   */
  private everyNext(rule: EveryRule, now: number): { date: string; at: number } | null {
    const zone = this.phoneZone();
    return zone ? nextEvery(rule.when[0], zone, { at: rule.state.lastAt, date: rule.state.lastDate }, now) : null;
  }

  /**
   * Each repeating time come round, §3's fire in one transaction: the rule moves to this occurrence (its date never
   * fired for again, and the next look-back starting here), and if anything happened since its last, its briefing's
   * reach-out is written (`${rule}:on:${local date}`). Nothing happened, nothing is sent.
   */
  private fireEvery(now: number) {
    for (const rule of this.everyRules()) {
      const next = this.everyNext(rule, now);
      if (!next || next.at > now) continue;
      const happened = happenedOf(this.items.values(), rule.state.lastAt, next.at);
      const counts = countsOf(happened);
      const any = anything(counts);
      this.d.store.db.transaction(() => {
        this.d.store.saveRule(rule.id, { ...rule, state: { ...rule.state, n: rule.state.n + 1, lastAt: next.at, lastDate: next.date } });
        if (any) {
          const brief = { since: rule.state.lastAt, ...counts, line: rule.made.said, until: next.at, as: rule.then[0].as, ids: toldOrder(happened).map((i) => i.id) };
          const news: News = { itemId: rule.id, handle: "your briefing", seen: { runAt: 0, question: null }, brief };
          // `tell` false: older code keeps it for a call rather than word it as a thread's reply (§11, 3.8's rollback).
          this.addDuty(`${rule.id}:on:${next.date}`, "brief", news, { rule: rule.id, via: "rule", ring: false, tell: false, urgency: "normal", from: now }, undefined, now);
        }
      });
      this.d.log(`engine: ${rule.id} came round for ${next.date}; ${any ? "its briefing is ready" : "nothing happened since its last, so nothing is sent"}`);
    }
  }

  /**
   * What happened between `since` and `until`, from the threads as they are now (their facts, no model call): each
   * top-level thread counted once, asking (a question open, from after `since`), else whether its last run ended in
   * that time, failed (or stopped) or replied. A run counted here is before the next look-back starts, so one failure is
   * in one briefing only.
   */
  private happened(since: number, until: number): { asks: number; failed: number; replied: number } {
    return countsOf(happenedOf(this.items.values(), since, until));
  }

  /**
   * A briefing's notification (example 6's words, reach.ts `briefNoteOf`): never a call, and never kept for one (Hear
   * my briefing is there whenever asked). With no phone taking notifications it's dropped; once Apple has it, it's told.
   */
  private async deliverBrief(r: ReachOut, now: number) {
    const phone = this.alertPhone();
    // The weekend line sends no briefing, as with Notifications off (stage 3.4; Fable, topic 8); nor does driving.
    const hold = this.holdNow(now);
    if (!phone || !this.d.notify || hold.weekend || hold.by === "car") {
      this.d.store.saveReachOut({ ...r, state: "dropped" });
      this.d.log(`engine: ${r.news.itemId}'s briefing: no phone takes notifications now, so nothing is sent`);
      return;
    }
    // Stage 4 (Fable's 4-I): the briefing is made before it's said to be ready, so Hear it plays it at once. It's made
    // beside the engine's turns, not in one, so nothing else waits for it; the notification goes once it's made (with
    // its id), once it couldn't be (without), or after `MAKE_MS` without, whichever is first.
    // When it started making is kept on the reach-out (`making`), so a brain evicted while it was made starts it again
    // without restarting the 2 minutes (the skeptic's finding on 4-I's second review).
    if (r.briefing === undefined && this.d.brief && r.news.brief?.ids) {
      const started = r.making ?? this.making.get(r.key)?.at;
      if (started === undefined || (!this.making.has(r.key) && now < started + MAKE_MS)) return this.makeAhead(r, now);
      if (now < started + MAKE_MS) return;
      this.d.log(`engine: ${r.news.itemId}'s briefing is taking a while to make; its notification goes without it`);
    }
    const note = briefNoteOf(r, shownSince(r.news.brief!.since, this.zone(), r.at), privacyOf(this.d.store));
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now })) return;
    this.flying.add(`notification\n${r.key}`);
    await this.sent([r.key], phone, note, now);
    const fresh = this.d.store.reachOut(r.key);
    const went = this.d.store.deliveries(r.key).some((d) => d.channel === "notification" && d.state === "accepted");
    if (fresh?.state === "untold") this.d.store.saveReachOut({ ...fresh, state: went ? "told" : "dropped" });
  }

  /**
   * A repeating time's briefing made ahead (Fable's 4-I): its threads as they are now, in the order its facts were
   * counted, opened with what it says first when played ("Good morning. Since 8 yesterday morning, 6 threads replied,
   * and 2 are waiting on you."), on the phone's clock at its time; a summary or each reply in full, as its line says.
   * Null when it couldn't be made: the notification goes without, and Hear it plays the briefing as it is then.
   */
  private async madeAhead(r: ReachOut): Promise<string | null> {
    const b = r.news.brief!;
    const zone = this.zone();
    const opening: Opening = { said: "played", since: b.since, asks: b.asks, failed: b.failed, replied: b.replied };
    const threads = (b.ids ?? []).flatMap((id) => (this.items.get(id) ? [this.items.get(id)!] : []));
    return this.d.brief!({ threads, opening, zone, as: b.as ?? "summary", at: b.until ?? r.at }).catch((e) => {
      this.d.log(`engine: ${r.news.itemId}'s briefing couldn't be made ahead (${describe(e)}); its notification goes without it`);
      return null;
    });
  }

  /**
   * Starts making `r`'s briefing ahead (`madeAhead`), once: made, its id goes on the reach-out (`""`: it couldn't be),
   * so the next look sends the notification with it; made after the notification went without, it's still linked, so
   * Hear my briefing finds it. Then the engine takes a turn, which sends it.
   */
  private makeAhead(r: ReachOut, now: number) {
    const at = r.making ?? now;
    if (r.making === undefined) this.d.store.saveReachOut({ ...r, making: at });
    const done = this.madeAhead(r).then((id) => {
      const fresh = this.d.store.reachOut(r.key);
      if (fresh && !fresh.briefing) this.d.store.saveReachOut({ ...fresh, briefing: id ?? "" });
    }).catch((e) => this.d.log(`engine: ${r.news.itemId}'s briefing: couldn't keep it (${describe(e)})`)).finally(() => {
      this.making.delete(r.key);
      // After the turn under way, if any (`tick()` would join it): it may have looked before this was kept.
      void (this.ticking ?? Promise.resolve()).then(() => this.tick());
    });
    this.making.set(r.key, { at, done });
  }

  // --- sends and starts for later (stage 4b; Fable's 4-F, 4-G) ---

  /**
   * What became of sends and starts set up for later, due now: in a call, each told there word for word; else a
   * notification each (several sent at one look are one, "3 messages sent"), never a ring; with no phone taking
   * notifications, kept for the next call. Told once Apple has it.
   */
  private async deliverLater(rs: ReachOut[], now: number) {
    if (this.d.call?.()) {
      for (const r of rs) this.toCall(r, now);
      return;
    }
    // The car line keeps them all for your next call, the weekend line those that went as asked (stage 3.4; the
    // combinations review of pass B2): neither is a failure or a question.
    const h = this.holdNow(now);
    const keeps = (r: ReachOut) => h.by === "car" || (!!h.weekend && r.news.later?.outcome === "sent");
    for (const r of rs.filter(keeps)) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
    rs = rs.filter((r) => !keeps(r));
    if (!rs.length) return;
    const phone = this.alertPhone();
    if (!phone || !this.d.notify || !this.notifies()) {
      for (const r of rs) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      this.d.log(`engine: ${rs.length} outcome${rs.length === 1 ? "" : "s"} of sends for later kept for the next call`);
      return;
    }
    const o = { names: privacyOf(this.d.store).names, zone: this.zone(), now };
    const sent = rs.filter((r) => r.news.later?.outcome === "sent" && !r.news.later.start);
    const batch = sent.length > 1 ? [sent] : [];
    const each = rs.filter((r) => !batch.length || !sent.includes(r)).map((r) => [r]);
    for (const group of [...batch, ...each]) {
      const note = group.length > 1 ? sentBatchNoteOf(group, o, ruleCollapse(group.map((r) => r.key).join("\n"))) : laterNoteOf(group[0], o);
      const keys = group.map((r) => r.key).filter((key) => this.d.store.attemptDelivery({ key, channel: "notification", state: "sending", at: now }));
      if (!keys.length) continue;
      for (const key of keys) this.flying.add(`notification\n${key}`);
      await this.sent(keys, phone, note, now);
      for (const key of keys) {
        const fresh = this.d.store.reachOut(key);
        const went = this.d.store.deliveries(key).some((d) => d.channel === "notification" && d.state === "accepted");
        if (fresh?.state !== "untold") continue;
        // Not taken by Apple: kept for the next call instead, never lost.
        if (went) this.d.store.saveReachOut({ ...fresh, state: "told" });
        else this.d.store.attemptDelivery({ key, channel: "kept", state: "accepted", at: now });
      }
    }
  }

  /**
   * Outcomes of sends for later, and commands still held (Commands that wait), kept for the next call (or a hold rung for
   * and not answered, `ringHeld`), while a call is on: told first thing in it.
   */
  private keptLater(now: number): ReachOut[] {
    if (!this.d.call?.()) return [];
    return this.d.store.reachOuts().filter((r) => (r.kind === "later" || (r.kind === "held" && !!this.heldOf(r))) && r.state === "untold" && (this.deferred.get(r.key) ?? 0) <= now &&
      this.d.store.deliveries(r.key).some((d) => d.channel === "kept" || (r.kind === "held" && d.channel === "ring")) && !this.d.store.deliveries(r.key).some((d) => d.channel === "call"));
  }

  // --- Away (stage 3.9; §2 Presets; Fable's decisions 3.9-D to 3.9-G) ---

  /** Away's rule while it's on (the latest, should there be two), if this version reads it. */
  away(): AwayRule | null {
    let found: AwayRule | null = null;
    for (const row of this.d.store.ruleRows()) {
      if (!row.id.startsWith(AWAY_PREFIX)) continue;
      try {
        const r = JSON.parse(row.rule);
        if (validAway(r) && (!found || r.made.at > found.made.at)) found = r;
      } catch {
        // Left as it is.
      }
    }
    return found;
  }

  /**
   * Away turned on until `until` (stage 5's preset is what calls this; the tests do now): only on a level with it
   * (`awayHours`), with this phone's Notifications on (nothing else would tell it: Fable, 3.9-D), and no further than the
   * level's hours. Turned on again while it's on, its end moves. Its threads join now, or at the brain's first look, each
   * taking what it has then as told: a question already open as you leave isn't news.
   */
  startAway(until: number, now = this.clock.now()): { ok: true; id: string } | { ok: false; line: string } {
    const limits = this.limits();
    if (!limits.awayHours) return { ok: false, line: AWAY_LONG_HAUL };
    if (!this.notifies()) return { ok: false, line: AWAY_NOTIFICATIONS };
    if (until <= now) return { ok: false, line: TIME_PASSED };
    if (until - now > limits.awayHours * 3600_000) return { ok: false, line: awayFooter(limits.awayHours) };
    const had = this.away();
    const rule: AwayRule = had ? { ...had, lifetime: { ...had.lifetime, at: until } } : awayRule(now, until, OFFLINE_MS);
    if (!had) {
      if (this.viewed) this.joinAway(rule, new Map([...this.items.values()].map((i) => [i.id, this.observations.question(i, now)])), now, true);
      else rule.state.joining = true;
    }
    this.d.store.db.transaction(() => {
      this.d.store.saveRule(rule.id, rule);
      logAway(this.d.store, { id: rule.id, on: rule.made.at, until }, now);
    });
    this.d.log(`engine: Away is on until ${new Date(until).toISOString()}`);
    this.soon();
    return { ok: true, id: rule.id };
  }

  /**
   * What's said when Away is asked for by voice until `asked` (Fable, 3.9-E; stage 5's tool says it, word for word): on a
   * level without it, "Away comes with Long Haul."; past the level's hours, a readback offering the furthest it can keep
   * (to the minute), which waits for a yes (`agreed` is said then, and `until` set); within them, "Away is on until …",
   * naming no level. Times as said on the phone's clock (`spokenDay`).
   */
  awayPlan(asked: number, now = this.clock.now()): { say: "refused"; line: string } | { say: "statement"; line: string; until: number } | { say: "readback"; readback: string; agreed: string; until: number } {
    const limits = this.limits();
    if (!limits.awayHours) return { say: "refused", line: AWAY_LONG_HAUL };
    if (asked <= now) return { say: "refused", line: TIME_PASSED };
    const zone = this.zone();
    const max = now + limits.awayHours * 3600_000;
    if (asked <= max) return { say: "statement", line: awayOn(spokenDay(asked, zone, now)), until: asked };
    const furthest = Math.floor(max / 60_000) * 60_000;
    return { say: "readback", readback: awayReadback(limits.awayHours, spokenDay(asked, zone, now), spokenDay(furthest, zone, now), limits.named), agreed: awayOn(spokenDay(furthest, zone, now)), until: furthest };
  }

  /**
   * What the voice says if asked what's being watched or whether Away is on (Fable, 3.9-G), word for word, never said
   * unasked: while it's on, until when; for a day after it ended, when and how. Thread names as a call says them.
   */
  awaySaid(now = this.clock.now()): string | null {
    return awaySaid(awayLog(this.d.store).at(-1), !!this.away(), { names: true, computers: this.computers(), zone: this.zone() }, now);
  }

  /** How many computers the account has: its links (the cloud) or machines (Lattice), else those its threads are on. */
  private computers(): number {
    const listed = this.d.adapter.connectionStatus?.();
    if (listed?.length) return listed.length;
    return new Set([...this.items.values()].map((i) => i.machine ?? "")).size;
  }

  /**
   * Away's look (Fable, 3.9-D): over first; else each thread joins as first seen and its facts fire. Any thread on any
   * computer, threads started later too; a thread set to Nothing leaves it, as it leaves every wide scope.
   */
  private watchAway(keys: Map<string, string | null>, now: number) {
    let rule = this.away();
    if (!rule) return;
    const end = this.awayEnded(rule, now);
    if (end) return this.endAway(rule, end, now);
    const before = JSON.stringify(rule.state);
    const fire = this.joinAway(rule, keys, now, !!rule.state.joining);
    let changed = JSON.stringify(rule.state) !== before;
    for (const f of fire) {
      try {
        this.fireAway(rule, f.item, f.key, f.kind, now);
        changed = false;
      } catch (e) {
        // Neither the firing nor its reach-out was written: the next look sees it again and fires then.
        this.d.log(`engine: couldn't keep ${f.item.id}'s ${f.kind} for Away (${describe(e)}); it's looked at again`);
        const fresh = this.away();
        if (!fresh) return;
        rule = fresh;
      }
    }
    if (changed) this.d.store.saveRule(rule.id, rule);
  }

  /**
   * Each thread of Away's as first seen (what it had from before Away was turned on, or with `told`, everything it has
   * now, isn't news), and the facts to fire: each question it asks after (input or approval), and each run after that
   * failed or was stopped (its status, never its words). A clean reply is following's to tell, not Away's; a turn ending
   * on a question its work system holds open is that question.
   */
  private joinAway(rule: AwayRule, keys: Map<string, string | null>, now: number, told: boolean): { item: WorkItem; key: string; kind: "question" | "reply" }[] {
    const stars = this.d.store.stars();
    const set = this.d.store.threadNotifies();
    const fire: { item: WorkItem; key: string; kind: "question" | "reply" }[] = [];
    for (const item of this.items.values()) {
      if (item.parentId !== null || item.settled) continue;
      const id = item.id;
      if (notifyOf(set.get(id)?.notify, stars.has(id)) === "nothing") {
        delete rule.state.items[id];
        continue;
      }
      const key = keys.get(id) ?? null;
      const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
      let joined = rule.state.items[id];
      if (!joined) {
        const q = this.observations.get(id).question;
        joined = rule.state.items[id] = {
          at: now, heard: key && (told || (q?.key === key && q.seenAt <= rule.made.at)) ? key : null,
          ran: told || (runAt > 0 && runAt <= rule.made.at) ? this.ranNow(item, now) : null, running: item.status === "running",
        };
      }
      if (key && key !== joined.heard) fire.push({ item, key, kind: "question" });
      if (item.status === "running") {
        joined.running = true;
        continue;
      }
      const ran = item.pendingQuestion ? (this.ranNow(item, now) ?? joined.ran ?? null) : runAt ? this.observations.run(id, runAt, now) : joined.running ? this.observations.run(id, 0, now) : null;
      if (ran && ran !== joined.ran) {
        if (!item.pendingQuestion && (item.status === "failed" || item.status === "cancelled")) fire.push({ item, key: ran, kind: "reply" });
        else joined.ran = ran;
      }
      joined.running = false;
    }
    delete rule.state.joining;
    return fire;
  }

  /** §3's fire for Away, one transaction: its baseline moves past the fact, its count goes up, its duty is written. */
  private fireAway(rule: AwayRule, item: WorkItem, key: string, kind: "question" | "reply", now: number) {
    const handle = this.nameOf(item);
    this.d.store.db.transaction(() => {
      if (kind === "question") rule.state.items[item.id].heard = key;
      else rule.state.items[item.id].ran = key;
      rule.state.n++;
      this.d.store.saveRule(rule.id, rule);
      this.addDuty(key, kind, this.newsOf(item, handle, kind), { rule: rule.id, via: "away", ring: false, tell: true, urgency: "urgent", from: now }, undefined, now);
    });
    this.d.log(`engine: ${handle} ${kind === "question" ? "asks something" : item.status === "cancelled" ? "was stopped" : "failed"}; Away is on`);
  }

  /**
   * Whether Away is over (Fable, 3.9-D), and how, at the first of: your first message typed at a computer more than 10
   * minutes after it was turned on (earlier is you leaving), in any thread on any computer, before its time; and its set
   * time. Read from the threads as they are (`typed.desk`), so a restart between changes nothing. Not T3 Code's phone app,
   * a tap or a typed answer from a notification, a call, a send the computer ran, anything nobody typed, a computer going
   * offline or back, or a change of level.
   */
  private awayEnded(rule: AwayRule, now: number): AwayEnd | null {
    const until = rule.lifetime.at;
    let first: { at: number; item: WorkItem } | null = null;
    for (const item of this.items.values()) {
      const desk = typedOf(item).desk;
      if (desk !== null && desk > rule.made.at + LEAVING_MS && desk < until && desk <= now && (!first || desk < first.at)) first = { at: desk, item };
    }
    if (first) return { at: first.at, why: "wrote", thread: this.nameOf(first.item), ...(first.item.machine ? { machine: first.item.machine } : {}) };
    return now >= until ? { at: until, why: "time" } : null;
  }

  /**
   * Away ends (Fable, 3.9-D and 3.9-F), in one transaction: its rule goes, what it queued and hasn't sent goes with it, its
   * end is kept for the Timeline, and, unless it was stopped, its one "Away ended" notification is claimed (`${id}:ended`,
   * one attempt ever); then sent. Its counts are what happened since it was turned on, on every computer.
   */
  private endAway(rule: AwayRule, end: AwayEnd, now: number) {
    const key = `${rule.id}:ended`;
    const phone = end.why === "stop" ? null : this.alertPhone();
    const wrote = end.why === "wrote" ? { where: wroteIn({ thread: end.thread ?? "", machine: end.machine }, privacyOf(this.d.store).names, this.computers()), hourLeft: rule.lifetime.at - end.at >= HOUR_LEFT_MS } : undefined;
    const note = phone && this.d.notify
      ? awayNoteOf({ rule: rule.id, key, at: now, counts: this.happened(rule.made.at, end.at), since: shownSince(rule.made.at, this.zone(), now), ...(wrote ? { wrote } : {}) })
      : null;
    let claimed = false;
    this.d.store.db.transaction(() => {
      this.d.store.deleteRule(rule.id);
      this.dropQueued(rule.id);
      logAway(this.d.store, { id: rule.id, on: rule.made.at, until: rule.lifetime.at, ended: end }, now);
      claimed = !!note && this.d.store.attemptDelivery({ key, channel: "notification", state: "sending", at: now });
    });
    this.d.log(`engine: Away ended (${end.why === "wrote" ? "you wrote in a thread at a computer" : end.why === "stop" ? "stopped" : "its time"})`);
    if (!claimed) return;
    this.flying.add(`notification\n${key}`);
    const p: Promise<void> = this.sent([key], phone!, note!, now).finally(() => {
      if (this.ending === p) this.ending = null;
    });
    this.ending = p;
  }

  // --- a computer offline and back (stage 3.7; §11 item 7, Fable's topics 9 to 12) ---

  /** The computer holding `itemId`, as the adapter knows it; null where it can't tell (Lattice's own threads, a demo). */
  private link(itemId: string): Link | null {
    try {
      return this.d.adapter.link?.(itemId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Each computer holding a running thread something already tells you about (Fable, topic 9), top-level only, by its
   * name: (a) a call-back asked for in words that's still watching it (a pause's or a goodbye's never promised a call, so
   * isn't); (b) a thread you follow, or set by hand to tell you (one set to Nothing counts only under a). Each with when it
   * joined, so a thread watched only since its computer went quiet isn't news of it. A thread under several (two
   * call-backs, or one and following) is there once for each, so each keeps its own duty (the fourth review of 3.6 to
   * 3.8); only the names shown are one per thread (`fireOffline`).
   */
  private watchedRunning(): Map<string, { link: Link; threads: { item: WorkItem; why: "callback" | "follow" | "set" | "away" | "rule"; since: number; wait?: Wait }[] }> {
    // Following's rule holds only the threads whose own setting tells you something (`scoped`, `watchFollowed`): one set
    // to Nothing has left it.
    const out = new Map<string, { link: Link; threads: { item: WorkItem; why: "callback" | "follow" | "set" | "away" | "rule"; since: number; wait?: Wait }[] }>();
    if (!this.d.adapter.link) return out;
    const add = (item: WorkItem | undefined, why: "callback" | "follow" | "set" | "away" | "rule", since: number, wait?: Wait) => {
      if (!item || item.status !== "running" || item.parentId !== null) return;
      const link = this.link(item.id);
      if (!link) return;
      const m = out.get(link.machine) ?? { link, threads: [] };
      out.set(link.machine, m);
      if (!m.threads.some((t) => t.item.id === item.id && t.why === why && t.wait === wait)) m.threads.push({ item, why, since, ...(wait ? { wait } : {}) });
    };
    for (const w of this.d.waits.all()) {
      const head = headOf(w);
      if (w.ready || w.auto || !head.ring || head.made.via === "pause") continue;
      for (const i of w.items) if (i.asked !== false) add(this.items.get(i.itemId), "callback", i.startedAt ?? w.startedAt, w);
    }
    const rule = this.following();
    if (rule) {
      const stars = this.d.store.stars();
      for (const [id, joined] of Object.entries(rule.state.items)) if (id !== ROLLBACK_MARK) add(this.items.get(id), stars.has(id) ? "follow" : "set", joined.at);
    }
    // Away's threads (stage 3.9): every one it has joined, each from when it first saw it.
    const away = this.away();
    if (away) for (const [id, joined] of Object.entries(away.state.items)) add(this.items.get(id), "away", joined.at);
    // Example 4 (stage 3.4): any thread running on any computer, from when the line was added; not one set to Nothing.
    const line = this.lineOf(4);
    if (line) {
      const stars = this.d.store.stars();
      const set = this.d.store.threadNotifies();
      for (const item of this.items.values()) if (notifyOf(set.get(item.id)?.notify, stars.has(item.id)) !== "nothing") add(item, "rule", line.made.at);
    }
    return out;
  }

  /** Offline news whose computer hasn't been seen back yet, by computer: its down time isn't over, so it isn't told again. */
  private downs(): Map<string, ReachOut> {
    const out = new Map<string, ReachOut>();
    for (const r of this.d.store.reachOuts()) if (r.kind === "offline" && r.news.offline && r.back === undefined) out.set(r.news.handle, r);
    return out;
  }

  /**
   * When each watched computer's offline check is due (§7). One whose news may call (a call-back asked for in words that
   * the level and the phone let ring): its last word plus the link's staleness and the grace, so while it's up each check
   * finds a newer ping and sets the next (about one wake per 4 minutes). One whose news can only be a notification
   * (following, or a call-back that can't call now): every 15 minutes while it's up, and the grace's end once it's
   * silent (Fable's "after about 5-18 minutes"). A computer holding no watched running thread is never checked, nor one
   * already down (its return is a report). None before the engine's first look (an object just woken doesn't know yet
   * what's running where): the alarm set before it slept is the check, and its tick looks first (`deliver`), so waking
   * costs no alarm of its own.
   */
  private offlineTimes(now: number): number[] {
    if (!this.d.adapter.link || !this.viewed) return [];
    const downs = this.downs();
    const canRing = !!this.d.ringer?.canRing();
    const holding = this.d.ringer?.holdingFor(now) ?? [];
    const times: number[] = [];
    for (const [machine, { link, threads }] of this.watchedRunning()) {
      const told = threads.filter((t) => t.since <= link.heardAt + STALE_MS);
      if (downs.has(machine) || !told.length || this.longDown(link, now)) continue;
      // Only a call-back whose offline news may call now (its mode, its not-before, its check-in: `offlineCalls`), or
      // that a holding phone would take.
      const calls = canRing && told.some((t) => t.wait && this.offlineCalls(t.wait, now, holding.includes(t.wait.conversationId)));
      times.push(calls || !link.linked ? offlineAt(link.heardAt) : link.heardAt + NOTIFY_CHECK_MS);
    }
    for (const { from } of this.laterCalls(now)) if (from > now) times.push(from);
    return times;
  }

  /**
   * A computer silent for longer than news is kept (24 h): its going down is no longer news, whether or not it was told,
   * so it's never told again once its reach-out is pruned (the Skeptic's long-off finding on 3.7), nor checked.
   */
  private longDown(link: Link, now: number): boolean {
    return !link.linked && now - link.heardAt > NEWS_MS;
  }

  /**
   * Whether offline news (or a held command, stage 4c) may call for call-back `w` now (Fable's decision on 3.7's findings:
   * offline news belongs to its call-back and follows its limits). Still watching, not agreed to with no call (`notify`) unless `held` with
   * Notifications off, not only for a failure (going offline isn't one: a notification, the builder's reading), nothing
   * held back still ahead (its not-before, its check-in's time: `heldUntil`); and a call-back that rings and the level
   * lets ring now, unless `held`: a phone holding for it, which takes it as it takes a reply, with no ring. One agreed to
   * with no call (Commute's "…waiting in your next call.") is still held for its replies, so with nothing else to reach
   * them, its holding phone takes this too (the Skeptic's finding on 1847d5c56e7a); with Notifications on, it's a
   * notification.
   */
  private offlineCalls(w: Wait, now: number, held = false): boolean {
    const m = w.mode;
    return !w.ready && (!m?.notify || (held && !this.notifies())) && m?.only !== "failed" && this.heldUntil(w) <= now && (held || (headOf(w).ring && this.allows(w, now)));
  }

  /** When a call-back may first reach the user: its not-before on the phone's clock (`notBeforeZone`), its check-in's time; else 0. */
  private heldUntil(w: Wait): number {
    return Math.max(notBeforeAt(w, this.notBeforeZone(w)) ?? 0, w.mode?.checkIn ?? 0);
  }

  /**
   * Computers as they are now (a look): one down past the grace with watched threads running there is news, once per time
   * it goes down; one down that reports again is back (`cameBack`).
   */
  private watchOffline(now: number) {
    if (!this.d.adapter.link) return;
    const downs = this.downs();
    for (const r of downs.values()) if (this.computerOf(r)?.linked) this.cameBack(r, now);
    for (const [machine, { link, threads }] of this.watchedRunning()) {
      if (downs.has(machine) || this.longDown(link, now)) continue;
      const since = offlineSince(link, now);
      if (since === null) continue;
      const told = threads.filter((t) => t.since <= since + STALE_MS);
      if (told.length) this.fireOffline(machine, since, told, now);
    }
  }

  /**
   * §3's fire for a computer gone offline (Fable, topic 9): one reach-out per time it goes down, `${machine}:down:${since}`,
   * the watched threads running there newest first, each named once (a thread both asked about and followed, the
   * call-back's: one why), each call-back watching one a duty that may call (`calls`), due from its not-before or its
   * check-in's time when one is still ahead (nothing reaches them before it), and following's one that notifies, for
   * every thread it tells you about, one a call-back watches too (the fourth review of 3.6 to 3.8: following notifies
   * now, a call-back held for later still calls then). The watches go on: none ends. A phone holding for a call-back
   * takes it at once.
   */
  private fireOffline(machine: string, since: number, told: { item: WorkItem; why: "callback" | "follow" | "set" | "away" | "rule"; wait?: Wait }[], now: number) {
    const key = `${machine}:down:${since}`;
    if (this.d.store.reachOut(key)) return;
    const line = told.some((t) => t.why === "rule") ? this.lineOf(4) : null;
    // Each thread once, by the first reason in this order (the call-back's, following's, set by hand, Away's).
    const rank = { callback: 0, follow: 1, set: 2, away: 3, rule: 4 } as const;
    const once = new Map<string, (typeof told)[number]>();
    for (const t of told) if (!once.has(t.item.id) || rank[t.why] < rank[once.get(t.item.id)!.why]) once.set(t.item.id, t);
    const threads = [...once.values()].sort((a, b) => (Date.parse(b.item.updatedAt) || 0) - (Date.parse(a.item.updatedAt) || 0));
    // Its `itemId` is the computer's, no thread's: nothing that reads a thread's news (older code too) takes it for one.
    const news: News = {
      itemId: `computer:${machine}`, handle: machine, machine, seen: { runAt: 0, question: null },
      offline: { since, threads: threads.map((t) => ({ itemId: t.item.id, handle: this.nameOf(t.item), why: t.why })), ...(line ? { line: line.made.said } : {}) },
    };
    const waits = [...new Set(told.flatMap((t) => (t.wait ? [t.wait] : [])))];
    const via = told.some((t) => t.why === "follow") ? "follow" : told.some((t) => t.why === "set") ? "set" : null;
    this.d.store.db.transaction(() => {
      for (const w of waits) this.addDuty(key, "offline", news, { rule: headOf(w).id, via: "callback", ring: false, calls: true, tell: false, urgency: "urgent", from: Math.max(now, this.heldUntil(w)) }, w.conversationId, now);
      if (via) this.addDuty(key, "offline", news, { rule: FOLLOWING, via, ring: false, tell: false, urgency: "normal", from: now }, undefined, now);
      // Away's (stage 3.9): a notification, never a call, with its why.
      const away = told.some((t) => t.why === "away") ? this.away() : null;
      if (away) this.addDuty(key, "offline", news, { rule: away.id, via: "away", ring: false, tell: false, urgency: "normal", from: now }, undefined, now);
      // Example 4's (stage 3.4): a notification, never a call, with its line as why.
      if (line) this.addDuty(key, "offline", news, { rule: line.id, via: "rule", ring: false, tell: false, urgency: "normal", from: now, said: line.made.said }, undefined, now);
    });
    this.d.log(`engine: ${machine} went offline (last heard ${Math.round((now - since) / 1000)} s ago) while ${threads.map((t) => this.nameOf(t.item)).join(", ")} ${threads.length === 1 ? "was" : "were"} running`);
    this.d.waits.wake();
  }

  /** Whether offline news went out (a notification, a call, told in a call or a call-back), so its "back" is news too. */
  private offlineWent(r: ReachOut): boolean {
    return r.state === "told" || this.d.store.deliveries(r.key).some((d) => (d.channel === "notification" || d.channel === "ring" || d.channel === "call") && d.state !== "refused" && d.state !== "gone");
  }

  /**
   * A computer down is reporting again (Fable, topics 9 and 10): its down time is over. Back before its news went out,
   * nothing at all, either way: the news is dropped. Otherwise "back" goes in its place (`deliverBack`); the news stays
   * untold until a call tells it ("…and it's back").
   */
  private cameBack(r: ReachOut, now: number) {
    const went = this.offlineWent(r);
    this.d.store.saveReachOut({ ...r, back: now, ...(!went && r.state === "untold" ? { state: "dropped" as const } : {}) });
    this.d.log(`engine: ${r.news.handle} is back${went ? "" : " before its news went out; nothing is told"}`);
    if (!went && r.state === "untold") this.track("news_dropped", { what: "back" });
  }

  /** Computers back whose offline news went out, back within a day of going down, and not yet told it's back. */
  private backsDue(now: number): ReachOut[] {
    return this.d.store.reachOuts().filter((r) => r.kind === "offline" && r.back !== undefined && r.news.offline && now - r.back <= NEWS_MS
      && r.back - r.news.offline.since <= NEWS_MS && this.offlineWent(r) && !this.d.store.deliveries(r.key).some((d) => d.channel === "back"));
  }

  /**
   * Offline news, its grace over (Fable, topics 10 and 11): in a call, told there; a phone holding for its call-back takes
   * it (the hold answers it, `offlineFor`); a call-back asked for in words still watching, its level letting it ring now,
   * calls (several computers for one call-back, one call: "2 computers went offline"); else a notification, else kept for
   * the next call. Never a call for anything else.
   */
  private async deliverOffline(rs: ReachOut[], now: number, later: ReachOut[] = []) {
    const louder = new Set(later.map((r) => r.key));
    rs = [...rs, ...later].flatMap((r) => {
      const fresh = this.d.store.reachOut(r.key);
      const sent = this.d.store.deliveries(r.key).some((d) => (louder.has(r.key) ? d.channel === "ring" || d.channel === "call" : QUIET.has(d.channel)));
      return fresh?.state === "untold" && fresh.back === undefined && !sent ? [fresh] : [];
    });
    if (!rs.length) return;
    if (this.d.call?.()) {
      for (const r of rs) this.toCall(r, now);
      return;
    }
    const holding = this.d.ringer?.holdingFor(now) ?? [];
    const rings = new Map<string, { w: Wait; rs: ReachOut[] }>();
    for (const r of rs) {
      // A phone holding for a call-back of it takes it, when it may (`offlineFor`); a call-back about to call for its
      // own news tells it in its call (`callingFor`).
      if (holding.some((c) => this.callsFor(dueNow(r, now), now, true, c)) || this.callingFor(r, now)) {
        this.deferred.set(r.key, now + GRACE_MS);
        continue;
      }
      this.deferred.delete(r.key);
      const w = this.callsFor(dueNow(r, now), now);
      // Louder, later: news a notification told before its call-back's not-before only rings, once it may.
      if (louder.has(r.key) && !(w && this.d.ringer?.canRing())) continue;
      if (w && this.d.ringer?.canRing()) {
        const g = rings.get(w.conversationId) ?? { w, rs: [] };
        g.rs.push(r);
        rings.set(w.conversationId, g);
      } else if (this.notifies() && this.holdNow(now).by !== "car") await this.notifyOffline(r, now);
      else {
        this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
        this.d.log(`engine: ${r.news.handle} went offline; kept for the next call`);
      }
    }
    for (const { w, rs: group } of rings.values()) await this.ringOffline(w, group, now);
  }

  /**
   * The call-back offline news may call for now (`offlineCalls`; `held`, a phone holding for it), in `conversationId`
   * if given: one asked for in words, still watching, its limits allowing; and not one that already called, or was
   * told, about this computer going down before (a computer that keeps going down rings once per call-back, then
   * notifies: the Skeptic's flapping finding).
   */
  private callsFor(r: ReachOut, now: number, held = false, conversationId?: string): Wait | null {
    for (const d of r.duties) {
      const w = d.calls ? this.waitOf(d.rule) : undefined;
      if (w && (conversationId === undefined || w.conversationId === conversationId) && this.offlineCalls(w, now, held) && !this.toldOffline(r, d.rule)) return w;
    }
    return null;
  }

  /**
   * Whether offline news `r` is conversation `conversationId`'s (the fourth review of 3.6 to 3.8): one down time is one
   * reach-out shared by every call-back watching a thread there, so it's the conversation its call rang (`rangFor`), or
   * one of its call-backs' (a duty's wait there), not only the first call-back's (`conversationId`). A ring answered, a
   * call-back connecting and a holding phone find it by this.
   */
  offlineIn(r: ReachOut, conversationId: string): boolean {
    return r.kind === "offline" && (r.conversationId === conversationId || r.rangFor === conversationId || r.duties.some((d) => d.calls && this.waitOf(d.rule)?.conversationId === conversationId));
  }

  /** Whether call-back `rule` already rang, or told, that `r`'s computer went offline, for an earlier time it went down. */
  private toldOffline(r: ReachOut, rule: string): boolean {
    return this.d.store.reachOuts().some((x) => x.kind === "offline" && x.key !== r.key && x.news.handle === r.news.handle && x.duties.some((d) => d.rule === rule)
      && (x.state === "told" || this.d.store.deliveries(x.key).some((d) => d.channel === "ring" && d.state !== "refused" && d.state !== "gone")));
  }

  /**
   * A call-back over and about to call, or calling, for its own news (a check-in at its time, a wait over before its
   * not-before), its call-back telling every untold fact: offline news waits for it, until its call is missed or the
   * wait is gone (taken by its call-back, which owns this too).
   */
  private callingFor(r: ReachOut, now: number): boolean {
    return !!this.d.ringer?.canRing() && r.duties.some((d) => {
      const w = d.calls ? this.waitOf(d.rule) : undefined;
      return !!w?.ready && (rings(w) ? this.allows(w, now) : w.rungAt !== undefined && !this.keysOf(w).some((k) => this.missedDealt(k)));
    });
  }

  /**
   * Offline news a notification (following's) or the next call (kept) had before its call-back's not-before or check-in,
   * whose call-back may call once that's come (Fable: louder, later, as a reply's is): untold, its computer still down,
   * nothing rung or told in a call for it. `from`: when its call-back's duty is due.
   */
  private laterCalls(now: number): { r: ReachOut; from: number }[] {
    return this.d.store.reachOuts().flatMap((r) => {
      if (r.kind !== "offline" || r.state !== "untold" || r.back !== undefined) return [];
      const ds = this.d.store.deliveries(r.key);
      const before = ds.filter((d) => d.channel === "notification" || d.channel === "kept");
      if (!before.length || ds.some((d) => d.channel === "ring" || d.channel === "call")) return [];
      const d = r.duties.find((x) => x.calls && x.from > Math.max(...before.map((b) => b.at)));
      const w = d ? this.waitOf(d.rule) : undefined;
      return d && w && !w.ready ? [{ r, from: d.from }] : [];
    });
  }

  /**
   * One call for a call-back's computers gone offline: its attempt rows, the push, Apple's answer (§3's attempt). Whether
   * it may still call is read again in the attempt's transaction (the code review's blocker on 3.6 to 3.8): which
   * call-backs may ring was decided before the awaits of the ones before it, so on Commute a second call-back's call
   * would take a day's ring already used. One that may no longer call is a notification, else kept for the next call.
   */
  private async ringOffline(w: Wait, rs: ReachOut[], now: number) {
    const at = this.clock.now();
    const keys = this.d.store.db.transaction(() => {
      if (this.d.waits.get(w.conversationId) !== w || !this.offlineCalls(w, at)) return null;
      const claimed = rs.map((r) => r.key).filter((key) => this.d.store.attemptDelivery({ key, channel: "ring", state: "sending", at }));
      // Which conversation it rang, with the attempt (the fourth review of 3.6 to 3.8): one down time's news is shared,
      // and the call answered there owns it, its missed call's Call back opens there.
      for (const key of claimed) {
        const r = this.d.store.reachOut(key);
        if (r) this.d.store.saveReachOut({ ...r, rangFor: w.conversationId });
      }
      return claimed;
    });
    if (keys === null) {
      for (const r of rs) {
        if (this.notifies()) await this.notifyOffline(r, at);
        else this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at });
      }
      this.d.log(`engine: ${w.conversationId} may no longer call for ${rs.map((r) => r.news.handle).join(", ")} going offline; ${this.notifies() ? "a notification" : "kept for the next call"} instead`);
      return;
    }
    if (!keys.length) return;
    for (const key of keys) this.flying.add(`ring\n${key}`);
    const caller = offlineCaller(rs.filter((r) => keys.includes(r.key)).map((r) => r.news.handle));
    const result = await this.d.ringer!.call(w.conversationId, caller);
    this.d.log(`engine: rang "${caller}" for ${w.conversationId}: ${result}`);
    this.rang(keys, result, this.clock.now());
  }

  private async notifyOffline(r: ReachOut, now: number) {
    const phone = this.alertPhone();
    if (!phone || !this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now })) return;
    this.flying.add(`notification\n${r.key}`);
    await this.sent([r.key], phone, offlineNoteOf(r, privacyOf(this.d.store)), now);
  }

  /** A missed call about computers gone offline: "You missed a call", "Quartz went offline: API was running.", Call back. */
  private async missedOffline(rs: ReachOut[], now: number) {
    rs = rs.filter((r) => this.d.store.reachOut(r.key)?.state === "untold" && !this.missedDealt(r.key));
    if (!rs.length) return;
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) {
      for (const r of rs) this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      return;
    }
    for (const r of rs) {
      this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now });
      this.flying.add(`notification\n${r.key}`);
    }
    await this.sent(rs.map((r) => r.key), phone, offlineMissedOf(rs, privacyOf(this.d.store)), now);
  }

  /**
   * A computer is back (Fable, topics 10 and 11): told in the call its going offline was told in, else a quiet
   * notification in the offline one's place, how long it was away and how its threads stand now (one that replied or asks
   * meanwhile counts as not running: its own news says that). Never a call. Once.
   */
  private async deliverBack(r: ReachOut, now: number) {
    const off = r.news.offline!;
    const running: string[] = [];
    const not: string[] = [];
    for (const t of off.threads) (this.items.get(t.itemId)?.status === "running" ? running : not).push(t.handle);
    const call = this.d.call?.();
    if (call && this.d.store.deliveries(r.key).some((d) => d.channel === "call")) {
      if (!this.d.store.attemptDelivery({ key: r.key, channel: "back", state: "sending", at: now })) return;
      const back = { length: offlineFor(r.back! - off.since), standing: standingNow(running, not, true) };
      const ok = call.tell({ key: `${r.key}:back`, itemId: r.news.itemId, handle: r.news.handle, group: "", at: new Date(r.back!).toISOString(), ask: null, seen: r.news.seen, kind: "back", offline: { machine: r.news.handle, ago: "", names: off.threads.map((t) => t.handle), back } }, () => {});
      this.d.store.updateDelivery({ key: r.key, channel: "back", state: ok ? "accepted" : "refused", at: now });
      return;
    }
    const phone = this.alertPhone();
    if (!phone || !this.d.notify) {
      this.d.store.attemptDelivery({ key: r.key, channel: "back", state: "refused", at: now });
      return;
    }
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "back", state: "sending", at: now })) return;
    this.flying.add(`back\n${r.key}`);
    await this.sent([r.key], phone, backNoteOf(r, r.back!, { running, not }, privacyOf(this.d.store)), now, "back");
  }

  /**
   * Offline news a phone holding for this call-back takes, as it takes a reply (Fable, topic 11): untold, for a call-back
   * asked for in words, its computer still offline. The hold answers it, and the phone calls back with its opening.
   */
  offlineFor(conversationId: string): ReachOut | null {
    const now = this.clock.now();
    return this.d.store.reachOuts().find((r) => r.kind === "offline" && r.state === "untold" && r.back === undefined
      && !!this.callsFor(dueNow(r, now), now, true, conversationId) && !this.computerOf(r)?.linked) ?? null;
  }

  /**
   * How a call-back tells a computer gone offline, word for word (Fable, topic 11), as things stand when it's answered
   * in `conversationId`: that conversation's call-back's threads (the fourth review of 3.6 to 3.8: a down time shared
   * by two call-backs), else every call-back's, else every one that was running; how a later reply reaches them (a call
   * while it still watches and may call, a notification, or nothing said); or, back already, how long it was away.
   * `names`: the threads it names, for the facts the voice is given with it.
   */
  offlineSaid(r: ReachOut, conversationId?: string, now = this.clock.now()): { line: string; ago: string; names: string[] } {
    const off = r.news.offline!;
    const waits = r.duties.flatMap((d) => (d.calls ? [this.waitOf(d.rule)] : [])).filter((x): x is Wait => !!x);
    const mine = conversationId ? waits.find((x) => x.conversationId === conversationId) : undefined;
    const asked = off.threads.filter((t) => t.why === "callback");
    const its = mine ? asked.filter((t) => mine.items.some((i) => i.itemId === t.itemId)) : [];
    const names = (its.length ? its : asked.length ? asked : off.threads).map((t) => t.handle);
    // How long ago, on the phone's clock past a day ("since Tuesday"), for the facts the voice is given with it.
    const ago = offlineAgo(off.since, now, this.phoneZone());
    const link = this.computerOf(r);
    if (r.back !== undefined || link?.linked) return { line: offlineOpening(r.news.handle, names, null, (r.back ?? link?.heardAt ?? now) - off.since), ago, names };
    const w = mine && !mine.ready ? mine : waits.find((x) => !x.ready);
    // What a clean reply does now (Fable's finding on 3.7): a plain call-back's calls, or is a notification (agreed to as
    // one, or the level or Call me back); with a mode it may not reach them at all (only, all, a deadline, a check-in), so
    // the last sentence is left out ("neither").
    const m = w?.mode;
    const plain = !!w && !m?.only && !(m?.until === "all" && w.items.length > 1) && m?.deadline === undefined && m?.checkIn === undefined;
    const then = !plain ? null : !m?.notify && headOf(w!).ring && this.d.ringer?.canRing() && this.allows(w!, now) ? "call" : this.notifies() ? "notify" : null;
    return { line: offlineOpening(r.news.handle, names, then), ago, names };
  }

  /** The computer offline news is about, as it is now: by one of its threads (its own `itemId` is no thread's). */
  private computerOf(r: ReachOut): Link | null {
    const id = r.news.offline?.threads[0]?.itemId;
    return id ? this.link(id) : null;
  }

  // --- your rules (stage 3.4; §2, Your rules; Fable's decisions for 3.4) ---

  /** The rules your lines made (table `rules`, `made.via: "file"`), this version reads; each by its line's key. */
  lineRules(): LineRule[] {
    return this.d.store.ruleRows().flatMap((row) => {
      if (!row.id.startsWith(LINE_PREFIX)) return [];
      try {
        const r = JSON.parse(row.rule);
        return validLine(r) ? [r] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * What `GET /api/account` says of your rules (stage 3.4): Quiet for a while's end while it's on, and how many rules are
   * in use (Watching's "Always: your 4 rules"), so Home and Watching need no other read; `needsOK`, how many of them are
   * calls in your own words waiting for your OK (stage 3.5: Watching's "1 needs your OK to call").
   */
  accountRules(now = this.clock.now()): { quiet: { until: number } | null; rules: number; needsOK: number } {
    const q = this.quiet(now);
    return { quiet: q ? { until: q.until } : null, rules: this.lineRules().length + this.everyRules().filter((r) => r.made.key).length, needsOK: this.needsOK() };
  }

  /** A line's rule of example `n`, the first in the file's order (each example makes one rule). */
  private lineOf(n: ExampleN): LineRule | null {
    return this.lineRules().find((r) => r.example === n) ?? null;
  }

  /**
   * The car line that calls a question now (example 9's; a read car line may keep questions too, and one in your own
   * words calls only once you've allowed it, and by day only on a spoken yes: until then, and outside 07:00 to 23:00,
   * it keeps questions too), first in the file.
   */
  private carLine(now: number): LineRule | null {
    return this.lineRules().find((r) => r.example === 9 && r.params.calls !== false && this.consentOf(r).call && !this.dayHeldFor(r, now)) ?? null;
  }

  /** Every night line (example 7): a file may have two, with different hours (the reviews of 3.4). */
  private nightLines(): LineRule[] {
    return this.lineRules().filter((r) => r.example === 7);
  }

  /** The night every night line holds `now` in, on the phone's clock (`nightOf`), or null. */
  private nightNow(zone: string, now: number): { from: number; end: number } | null {
    return nightOf(this.nightLines().map((l) => l.params), zone, now);
  }

  /** What changes a line's reading now (my-rules.ts `Context`). */
  private rulesContext(): Context {
    const limits = this.limits();
    return {
      canRing: !!this.d.ringer?.canRing(), perDay: limits.ring === true ? null : limits.ring.perDay, named: limits.named, zone: this.phoneZone(), focusEver: this.focus().ever,
      judged: this.d.needsYou || this.d.judge ? limits.judgedLines : null,
    };
  }

  // --- reading your own words (stage 3.5; reader.ts; Fable's topics 11 and 12) ---

  /** The account as the reader sees it: its projects, computers and recent threads' titles (the ones you follow first). */
  private account(): Account {
    const stars = this.d.store.stars();
    const top = [...this.items.values()].filter((i) => i.parentId === null).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const threads = [...top.filter((i) => stars.has(i.id)), ...top.filter((i) => !stars.has(i.id))].map((i) => ({ title: this.nameOf(i), project: i.project ?? i.group }));
    let computers: string[] = [];
    try {
      computers = this.d.adapter.connectionStatus?.().map((c) => c.name) ?? [];
    } catch {
      // A host that can't say: none.
    }
    return accountOf(this.d.adapter.places?.() ?? [], computers, threads);
  }

  private projects(): Project[] {
    return projectsOf(this.account());
  }

  /** Example 2's project (Fable, topic 4): the one with the most threads in the last 7 days, by its spoken name. */
  private busiest(now: number): string | null {
    const counts = new Map<string, number>();
    for (const i of this.items.values()) {
      if (i.parentId !== null || !(Date.parse(i.updatedAt) > now - 7 * 86_400_000)) continue;
      const name = i.project ?? i.group;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return best && exampleOf(exampleText(2, best[0]), this.projects()) ? best[0] : null;
  }

  /** Each line's reading as kept (kv `rules_read`, by its normalised text), and the answers to their questions. */
  private readsKept(): Record<string, Read> {
    try {
      const r = JSON.parse(this.d.store.get(READ_KEY) ?? "{}");
      return r && typeof r === "object" ? r : {};
    } catch {
      return {};
    }
  }

  private answersKept(): Record<string, number> {
    try {
      const r = JSON.parse(this.d.store.get(ANSWERS_KEY) ?? "{}");
      return r && typeof r === "object" ? r : {};
    } catch {
      return {};
    }
  }

  /**
   * A line in your own words as read: its reading kept, and the rule it runs (the reading's, or the choice you took for
   * its question), null for none (not read, can't, a question not answered).
   */
  private readOf(text: string): { read: Read | null; rule: Checked | null; chose?: number } {
    const k = normal(text);
    const read = this.readsKept()[k] ?? null;
    if (!read || read.v !== 1) return { read: null, rule: null };
    if (read.result === "ok" || read.result === "judged") return { read, rule: read.rule };
    if (read.result === "ask") {
      const chose = this.answersKept()[k];
      return Number.isInteger(chose) && read.options[chose] ? { read, rule: read.options[chose], chose } : { read, rule: null };
    }
    return { read, rule: null };
  }

  /** Whether this brain reads lines in your own words (stage 3.5): it has a reader. */
  readsOwnWords(): boolean {
    return !!this.d.reader;
  }

  // --- a call in your own words waits for your OK (engine.md §11, 3.5, "Allowing a call"; Fable's decision B) ---

  private allowedKept(): Record<string, Allowed> {
    try {
      const r = JSON.parse(this.d.store.get(ALLOWED_KEY) ?? "{}");
      return r && typeof r === "object" && !Array.isArray(r) ? r : {};
    } catch {
      return {};
    }
  }

  /**
   * A line's call as you'd allow it now: its reading kept, checked once more by today's `validDraft` against today's
   * account (a project renamed or gone, a guard that no longer reads it so, refuse it), and its digest. Null for a line
   * that isn't a call in your own words, or whose reading no longer holds.
   */
  private allowNow(said: string): { rule: Checked; reading: string } | null {
    const { read, rule } = this.readOf(said);
    if (!read || !rule || rule.does !== "call") return null;
    const again = validDraft(draftOf(rule), said, this.account(), read.result === "ask");
    if (!("ok" in again) || again.refused || again.ok.does !== "call") return null;
    const reading = allowDigest(rule);
    return allowDigest(again.ok) === reading ? { rule, reading } : null;
  }

  /**
   * Whether a line's rule may call now, and through the night (the gate, at ring time): an example as ever; a call in
   * your own words only with an entry for its line whose reading is the reading now, through the night only if that
   * entry says so. Anything else, missing, unreadable or changed, fails closed.
   */
  private consentOf(rule: Pick<LineRule, "read" | "ring" | "made">): { call: boolean; night: boolean; since: number; voice?: true } {
    // An example's call only while its line is still one (the seventh reviews: example 11 took any words after its
    // minutes, so a rule made from such a line before rings no more).
    if (!rule.read) return { call: rule.ring && !!exampleOf(rule.made.said), night: true, since: 0 };
    if (!rule.ring) return { call: false, night: true, since: 0 };
    const entry = this.allowedKept()[rule.made.key];
    if (!entry || typeof entry.reading !== "string") return { call: false, night: false, since: 0 };
    const now = this.allowNow(rule.made.said);
    if (!now || now.reading !== entry.reading) return { call: false, night: false, since: 0 };
    // A spoken yes (`voice`) is by day only, whatever the line says (the tenth reviews): anything but a tap is.
    const voice = entry.by !== "app";
    return { call: true, night: !voice && entry.night === true && !!now.rule.night, since: Number(entry.at) || 0, ...(voice ? { voice: true as const } : {}) };
  }

  /**
   * Whether a call you allowed is by day only, so held from 23:00 to 07:00 too (`dayHeld`): allowed by voice, whatever
   * its line says (the tenth reviews: a spoken yes rang at 02:00 with no night rule), or by day only on a line that says
   * the night.
   */
  private byDay(rule: Pick<LineRule, "read">, consent: { call: boolean; night: boolean; voice?: true }, night: boolean): boolean {
    return !!rule.read && consent.call && (!!consent.voice || (night && !consent.night));
  }

  /**
   * Whether a line's rule waits for your OK to call, with something to allow: a call in your own words not allowed, its
   * reading still holding. One whose reading no longer holds can't call until it's reworded (`CANT_CALL`).
   */
  private asksOK(rule: Pick<LineRule, "read" | "ring" | "made">): boolean {
    if (!rule.read || !rule.ring || this.consentOf(rule).call) return false;
    const cur = this.allowNow(rule.made.said);
    return !!cur && !this.sameNamed(cur.rule);
  }

  /** The consent of the line rule `id`; none for a rule that's no line's. `day`: by day only (`byDay`). */
  private consentFor(id: string): { call: boolean; night: boolean; day: boolean } {
    const rule = this.lineRules().find((r) => r.id === id);
    if (!rule) return { call: false, night: false, day: false };
    const c = this.consentOf(rule);
    return { call: c.call, night: c.night, day: this.byDay(rule, c, rule.params.night === true) };
  }

  /** Whether a call allowed by day only is held now (`dayHeld`): the car line's and an unanswered question's too. */
  private dayHeldFor(rule: LineRule, now: number): boolean {
    return this.byDay(rule, this.consentOf(rule), rule.params.night === true) && this.dayHeld(now);
  }

  /**
   * Allow a call in your own words (`POST /api/rules/allow`, or the voice's readback once its yes is confirmed): the line
   * `line` as written, in use, a call, its reading now `reading`. `night` asks for the night too, and only a tap gives it
   * (`by: "app"`): a spoken yes allows by day only. `conflict`: the file moved on from `v`, or the reading isn't the one
   * shown; `none`: nothing on that line to allow. `said`, the question as it was shown or said; else built here.
   */
  allowRule(line: string, reading: string, night: boolean, by: "app" | "voice", o: { v?: number; said?: string } = {}, now = this.clock.now()): "ok" | "conflict" | "none" {
    const f = fileOf(this.d.store);
    if (o.v !== undefined && o.v !== f.v) return "conflict";
    const key = keyOf(line);
    if (!rulesOf(f.text).some((l) => keyOf(l.text) === key)) return "none";
    const rule = this.lineRules().find((r) => r.made.key === key);
    if (!rule?.read || !rule.ring) return "none";
    const cur = this.allowNow(rule.made.said);
    if (!cur || this.sameNamed(cur.rule)) return "none";
    if (cur.reading !== reading) return "conflict";
    if (night && !cur.rule.night) return "none";
    const through = by === "app" && night;
    // Which button, for the record (the seventh reviews): the question shown is the night's on Only by day too.
    const tapped = by === "app" ? { tapped: cur.rule.night && !night ? ("Only by day" as const) : ("Allow" as const) } : {};
    const entry: Allowed = { reading, night: through, at: now, by, said: o.said ?? allowAsk(cur.rule), ...tapped };
    this.d.store.set(ALLOWED_KEY, JSON.stringify({ ...this.allowedKept(), [key]: entry }));
    this.d.log(`engine: a rule's call allowed (${by}${through ? ", through the night" : cur.rule.night ? ", by day only" : ""})`);
    this.soon();
    return "ok";
  }

  /** Stop calls (`POST /api/rules/disallow`): the line's call goes back to waiting for your OK. `conflict`: `v` moved on. */
  disallowRule(line: string, v?: number): "ok" | "conflict" {
    if (v !== undefined && v !== fileOf(this.d.store).v) return "conflict";
    const key = keyOf(line);
    const kept = this.allowedKept();
    if (kept[key]) {
      delete kept[key];
      this.d.store.set(ALLOWED_KEY, JSON.stringify(kept));
      this.d.log("engine: a rule's calls stopped; it waits for your OK again");
    }
    return "ok";
  }

  /** How many lines in use wait for your OK to call (Settings' Review, Watching's detail). */
  private needsOK(): number {
    return this.lineRules().filter((r) => !r.state.earlier && this.asksOK(r)).length;
  }

  /**
   * A rule's reading now (a line's earlier wording: an example's fixed one, or its reading as read; a call in your own
   * words as it runs, quietly until you allowed it, or by day only).
   */
  private readingFor(rule: LineRule | EveryRule, c: Context): { reading: string; section: Section } | null {
    const said = rule.made.said;
    const ex = exampleOf(said, this.projects());
    if (ex) {
      const sec = EXAMPLE_SECTION[ex.n];
      return { reading: readingNow(ex, c).reading, section: sec === "tell" ? "tells" : sec === "hold" ? "holds" : "calls" };
    }
    const { rule: read } = this.readOf(said);
    if (!read) return null;
    if (read.does === "call" && rule.id.startsWith(LINE_PREFIX)) {
      const consent = this.consentOf(rule as LineRule);
      if (this.sameNamed(read)) return { reading: this.sameNamedOf(read), section: quietSection(read) };
      if (!consent.call) return this.allowNow(said) ? { reading: `${notYetOf(read)}${this.sameNameTail(read)}`, section: "allow" } : { reading: cantCallOf(read), section: quietSection(read) };
      const r = readNow(read, c);
      return { reading: `${this.allowedReading(read, consent, r.reading, c)}${this.sameNameTail(read)}`, section: this.byDay(rule as LineRule, consent, !!read.night) && !c.zone ? quietSection(read) : r.section };
    }
    const r = readNow(read, c);
    return { reading: `${r.reading}${this.sameNameTail(read)}`, section: r.section };
  }

  /**
   * A call in your own words you allowed, its reading (today's, `reading`): by day only (Only by day on a line that says
   * the night, or any spoken yes: the tenth reviews), the day call's, said so and how, with its hours unless your night
   * rule holds all of 23:00 to 07:00, or with no zone that it never calls (Fable's words, the ninth reviews); without the
   * night and no night rule in use, that it calls at any hour.
   */
  private allowedReading(r: Checked, consent: { night: boolean; voice?: true }, reading: string, c: Context): string {
    if (consent.voice || (r.night && !consent.night)) {
      const day: Checked = { ...r, night: undefined };
      const how = consent.voice ? BY_VOICE : BY_DAY;
      const hours = !c.zone ? noZoneDay(r) : this.nightCovered() ? null : byDayHours(r, this.nightInUse());
      return readNow(day, c).reading.replace(sentenceOf(day), [sentenceOf(day), how, hours].filter(Boolean).join(" "));
    }
    // After the sentence's own "Not while a hold-back rule …" (a choice of project said in it too); the car line's has none.
    return consent.night || this.nightInUse() || !reading.includes(HELD_BACK) ? reading : reading.replace(HELD_BACK, `${HELD_BACK} ${ANY_HOUR}`);
  }

  /**
   * "Two projects are named nix, …" after a call's reading on a project whose name another has too; else nothing. With
   * another rule that can call for those threads, it's this rule that only notifies (the tenth reviews).
   */
  private sameNameTail(r: Checked): string {
    const name = r.does === "call" && "project" in r.scope ? this.sharedName(r.scope.project) : null;
    return name ? ` ${sameNameOf(name, this.projects().filter((q) => q.names.includes(name)).length, this.callsAnyThread())}` : "";
  }

  /**
   * Whether a line can call for a thread whatever its project: an example's call (11's for a question left unanswered,
   * 12's, the car's), or one in your own words you allowed, on any thread or the threads you follow.
   */
  private callsAnyThread(): boolean {
    return this.lineRules().some((r) => r.ring && this.consentOf(r).call && !(r.read && "project" in (this.readOf(r.made.said).rule?.scope ?? {})));
  }

  /**
   * A call on a project every name of which another project has too ("nix", mono-nix's only name, is nix-config's): no
   * thread can be told its own, so it can't call, and there's nothing to allow (Fable, the ninth reviews: its row said
   * "Needs your OK to call", then "Can call you", and never rang).
   */
  private sameNamed(r: Checked): boolean {
    if (r.does !== "call" || !("project" in r.scope)) return false;
    const p = r.scope.project;
    const all = this.projects();
    const names = all.find((q) => q.said === p.said)?.names ?? p.names;
    return names.length > 0 && names.every((n) => all.some((q) => q.said !== p.said && q.names.includes(n)));
  }

  /** Its row's reading: the notification it sends instead, and why (Fable's words, the ninth reviews). */
  private sameNamedOf(r: Checked): string {
    return `${sentenceOf({ does: "tell", on: r.on, scope: r.scope })}${this.sameNameTail(r)}`;
  }

  /** Whether a night rule holds now and then: a night line with its hours (example 7, or one read), and a zone to read it in. */
  private nightInUse(): boolean {
    return !!this.phoneZone() && this.nightLines().some((l) => !!l.params.from && !!l.params.to);
  }

  /** Whether your night rules hold all of 23:00 to 07:00, so by day only needs no hours said. */
  private nightCovered(): boolean {
    return this.nightInUse() && nightCovers(this.nightLines().map((l) => l.params));
  }

  /**
   * Whether a call you allowed by day only is held now: from 23:00 to 07:00 on the phone's clock, example 7's hours, and
   * with no zone always (the eighth reviews: with no night line it rang at 02:00; the ninth: with one that doesn't hold
   * those hours too). Inside a night line it's held as any day call (`lineMayRing`).
   */
  private dayHeld(now: number): boolean {
    const zone = this.phoneZone();
    return !zone || nightAt({ from: "23:00", to: "07:00" }, zone, now) !== null;
  }

  /**
   * Your rules as Settings → Notifications and How I read show them (`GET /api/rules/file`): the file, each line with
   * its row (status, detail), its reading built in code and its count for the last day, and the examples offered with
   * their readings now. Stage 3.5: a line in your own words as read (in use, not in use yet, needing an answer with its
   * question and choices, can't be done yet with why, paused), a reworded line's earlier wording still in use, a judged
   * line's checks; `reads`, whether this brain reads your own words; `judges`, whether it judges any rule by AI;
   * `pending`, how many lines aren't in use yet.
   */
  rulesFile(now = this.clock.now()) {
    const f = fileOf(this.d.store);
    const c = this.rulesContext();
    const projects = this.projects();
    const reads = this.readsOwnWords();
    const rows = new Map<string, { id: string; at: number; rule?: LineRule }>();
    const earlier = new Map<string, LineRule | EveryRule>();
    for (const r of this.lineRules()) {
      rows.set(r.made.key, { id: r.id, at: r.made.at, rule: r });
      if (r.state.earlier) earlier.set(r.state.earlier, r);
    }
    for (const r of this.everyRules()) if (r.made.key) rows.set(r.made.key, { id: r.id, at: r.made.at });
    const seen = new Map<string, number>();
    let n = 0;
    let pending = 0;
    const lines: LineView[] = [];
    for (const l of linesOf(f.text)) {
      if (l.kind === "blank") continue;
      if (l.kind === "heading") {
        lines.push({ at: l.at, kind: "heading", text: l.text });
        continue;
      }
      n++;
      const norm = normal(l.text);
      const first = seen.get(norm);
      if (first !== undefined) {
        lines.push({ at: l.at, kind: "rule", text: l.text, n, status: `Same as line ${first}`, reading: sameAs(first), section: "same" });
        continue;
      }
      seen.set(norm, n);
      const key = keyOf(l.text);
      const row = rows.get(key);
      const ex = exampleOf(l.text, projects);
      if (!ex) {
        if (!reads) {
          lines.push({ at: l.at, kind: "rule", text: l.text, n, status: "Not read yet", reading: NOT_READ, section: "unread" });
          continue;
        }
        const was = earlier.get(key);
        const old = was ? this.readingFor(was, c) : null;
        const prior = was && old ? { earlier: { text: was.made.said, ...old } } : {};
        const { read, rule, chose } = this.readOf(l.text);
        const view: LineView = { at: l.at, kind: "rule", text: l.text, n, read: true };
        if (!read) Object.assign(view, { status: "Not read yet", reading: NOT_READ_YET, section: "unread" });
        else if (read.result === "cant") Object.assign(view, { status: "Can't do yet", reading: read.why, section: "cant" });
        else if (!rule && read.result === "ask") Object.assign(view, { status: "Needs an answer", reading: read.question, section: "ask", question: read.question, choices: read.choices });
        else if (rule) {
          const now_ = readNow(rule, c);
          // The choice you took, said (Fable, topic 11): "…in driver (you chose it over driver-site)".
          const others = read.result === "ask" && chose !== undefined && "project" in rule.scope ? read.choices.filter((_, i) => i !== chose) : [];
          const reading = others.length && "project" in rule.scope ? now_.reading.replace(`in ${rule.scope.project.said}`, `in ${rule.scope.project.said} (you chose it over ${others.join(" and ")})`) : now_.reading;
          const same = rule.does === "call" && this.sameNamed(rule);
          if (!row) {
            pending++;
            Object.assign(view, { status: "Not in use yet", reading: same ? this.sameNamedOf(rule) : `${reading}${this.sameNameTail(rule)}`, section: "pending" });
          } else if (same && row.rule) {
            // A project every name of which another has: no thread can be told its own, so it can't call, and there's
            // nothing to allow; what you allowed is kept, with Stop calls (Fable, the ninth reviews).
            const consent = this.consentOf(row.rule);
            Object.assign(view, { status: CANT_CALL, reading: this.sameNamedOf(rule), section: quietSection(rule), ...(consent.call ? { allowed: { night: consent.night } } : {}) });
          } else if (rule.does === "call" && row.rule && !this.consentOf(row.rule).call) {
            // In use quietly until you allow its call (stage 3.5, "Allowing a call"): Allow, and Only by day for the night.
            // A reading that no longer holds has nothing to allow: it says so, and what to do (the seventh reviews).
            const cur = this.allowNow(l.text);
            if (cur) Object.assign(view, { status: NEEDS_OK, reading: `${notYetOf(rule)}${this.sameNameTail(rule)}`, section: "allow", allow: { ask: allowAsk(cur.rule), reading: cur.reading, night: !!cur.rule.night } });
            else Object.assign(view, { status: CANT_CALL, reading: cantCallOf(rule), section: quietSection(rule) });
          } else {
            const judged = judgedOf(rule) !== null;
            const lastDay = now - row.at >= 86_400_000 && now_.section !== "holds" ? this.lastDay(row.id, now) : null;
            // A call you allowed: Stop calls; by day only (Only by day on a line that says the night, or a spoken yes), its
            // day reading and "By day".
            const consent = rule.does === "call" && row.rule ? this.consentOf(row.rule) : null;
            const day = !!consent && this.byDay(row.rule!, consent, !!rule.night);
            // A spoken yes on a line that says the night: the night still waits for a tap, offered here (the tenth reviews),
            // said last, directly above its question (Fable's words, the eleventh reviews).
            const cur = consent?.voice && rule.night ? this.allowNow(l.text) : null;
            // By day only with no zone: it can't tell day from night, so it never calls (Fable, the ninth reviews).
            const never = day && !c.zone;
            const counted = now_.status === "Tells you" || now_.status === "Can call you" ? countDetail(lastDay) : now_.status === "Holds back" && rule.on === "night" ? `${rule.from} to ${rule.to}` : now_.status === "Holds back" && rule.on === "weekend" ? "Saturday and Sunday" : null;
            const detail = day ? ["By day", counted].filter(Boolean).join(" · ") : counted;
            Object.assign(view, {
              status: never ? CANT_CALL : now_.status, reading: `${consent ? this.allowedReading(rule, consent, reading, c) : reading}${this.sameNameTail(rule)}${cur ? ` ${VOICE_NIGHT}` : ""}`, section: never ? quietSection(rule) : now_.section, ...(detail ? { detail } : {}), ...(now_.section !== "holds" ? { lastDay } : {}),
              ...(judged ? { checks: this.checksOf(row.id, now) } : {}), ...(consent ? { allowed: { night: consent.night } } : {}),
              ...(cur ? { allow: { ask: allowAsk(cur.rule), reading: cur.reading, night: true } } : {}),
            });
          }
        }
        lines.push({ ...view, ...prior });
        continue;
      }
      const { reading, status } = readingNow(ex, c);
      const section: Section = EXAMPLE_SECTION[ex.n] === "tell" ? "tells" : EXAMPLE_SECTION[ex.n] === "hold" ? "holds" : "calls";
      const counts = section !== "holds" || ex.n === 9;
      const lastDay = counts && row && now - row.at >= 86_400_000 ? this.lastDay(row.id, now) : null;
      const detail = status === "Tells you" || status === "Can call you" ? countDetail(lastDay) : status === "Holds back" ? holdDetail(ex) : null;
      const checks = ex.n === 1 && row && c.judged ? { checks: this.checksOf(row.id, now) } : {};
      lines.push({ at: l.at, kind: "rule", text: l.text, n, example: ex.n, status, ...(detail ? { detail } : {}), reading, section, ...(ex.n === 9 ? { also: "calls" as const } : {}), ...(counts ? { lastDay } : {}), ...checks });
    }
    // Example 2 second, with the busiest project's name, when the account has one (Fable, topic 4).
    const busy = this.busiest(now);
    const offered: ExampleN[] = busy ? [1, 2, ...OFFERED.slice(1)] : OFFERED;
    const examples = offered.map((x) => {
      const text = exampleText(x, busy ?? undefined);
      return { n: x, text, section: EXAMPLE_SECTION[x], reading: readingNow(exampleOf(text, projects) ?? { n: x, params: {} }, c).reading };
    });
    // Whether any rule can be judged by AI here (a host wires it only while its switch is on: reader.ts `rulesAI`), so
    // What 10 & 2 reads says what a judged rule sends only then (the third reviews of 3.5).
    const judges = !!(this.d.needsYou || this.d.judge);
    return { v: f.v, rv: this.readsV(f.text), text: f.text, savedAt: f.savedAt, lines, examples, max: { rules: RULES_MAX, chars: LINE_MAX }, reads, judges, pending };
  }

  /**
   * What the file's lines in your own words read as now, and the answers to their questions, digested (`rv`): Use
   * these rules puts in use only what the phone showed, since a read or an answer elsewhere doesn't move the file's
   * version (the reviews of 3.5).
   */
  private readsV(text: string): string {
    const kept = this.readsKept();
    const answers = this.answersKept();
    const lines = [...new Set(rulesOf(text).map((l) => normal(l.text)))].sort();
    return createHash("sha256").update(JSON.stringify(lines.map((k) => [k, kept[k] ?? null, answers[k] ?? null]))).digest("hex").slice(0, 16);
  }

  /** How many times a line's rule told you something in the last day (Fable, topic 1: its own real count). */
  private lastDay(rule: string, now: number): number {
    return this.d.store.reachOuts().filter((r) => r.at > now - 86_400_000 && r.duties.some((d) => d.rule === rule && !d.red && d.judged !== "needs_you" && d.judged !== "judge")).length;
  }

  /**
   * Your rules saved (`PUT /api/rules/file`, Fable's topic 3), one transaction: refused when the file changed since
   * `ifV` (another phone, another save: `conflict` with the file as it is now), or past its limits. Each line that's an
   * example keeps its rule and state if it was there (by its normalised text), else is a new rule from now with no
   * catch-up; one a save just took away comes back with its state if this save follows it (Undo). A line in your own
   * words runs once it's in use (stage 3.5): read, and put in use by Use these rules (`use`, its keys) or by voice after
   * its readback; until then it makes no rule, and with a reader, a line reworded into it keeps its earlier wording
   * running (§2, When a line takes effect). A line gone stops at once with what it hadn't sent; without a reader (3.4),
   * so does one reworded.
   */
  saveRules(text: string, ifV: number, by: "app" | "voice", now = this.clock.now(), use: string[] = []): { ok: true } | { conflict: true } | { error: string } {
    const f = fileOf(this.d.store);
    if (ifV !== f.v) return { conflict: true };
    const problem = fileProblem(text);
    if (problem) return { error: problem };
    const v = f.v + 1;
    const projects = this.projects();
    const reads = this.readsOwnWords();
    type Want = { said: string; ex?: Example; read?: Checked };
    const wanted = new Map<string, Want>();
    const own = new Set<string>();
    for (const l of rulesOf(text)) {
      const key = keyOf(l.text);
      if (wanted.has(key) || own.has(key)) continue;
      const ex = exampleOf(l.text, projects);
      if (ex) wanted.set(key, { said: l.text, ex });
      else {
        own.add(key);
        const { rule } = reads ? this.readOf(l.text) : { rule: null };
        if (rule) wanted.set(key, { said: l.text, read: rule });
      }
    }
    const rows = this.d.store.ruleRows();
    const mine = (row: { id: string; rule: string }): { key: string; earlier?: string } | null => {
      if (!row.id.startsWith(LINE_PREFIX) && !row.id.startsWith(EVERY_PREFIX)) return null;
      try {
        const r = JSON.parse(row.rule);
        return r?.made?.via === "file" && typeof r.made.key === "string" ? { key: r.made.key, ...(typeof r.state?.earlier === "string" ? { earlier: r.state.earlier } : {}) } : null;
      } catch {
        return null;
      }
    };
    const had = new Map(rows.flatMap((row) => {
      const m = mine(row);
      return m ? [[m.key, { ...row, ...m }] as const] : [];
    }));
    const removed = removedOf(this.d.store);
    // Undo: the save just before this one, moments ago (a rule back hours later would catch up on what it missed).
    const back = removed?.v === f.v && removed.at !== undefined && now - removed.at <= UNDO_MS ? new Map(removed.rows.flatMap((row) => {
      const m = mine(row);
      return m ? [[m.key, row] as const] : [];
    })) : new Map<string, { id: string; rule: string }>();
    // A line in your own words is in use once it's had its rule (read when it was put in use), or it's put in use now, or
    // Undo puts it back as it was (stage 3.5's own words too, since "Allowing a call": with what you allowed).
    const inUse = (key: string) => !!wanted.get(key)?.ex || (own.has(key) && had.has(key)) || (!!wanted.get(key)?.read && (use.includes(key) || back.has(key)));
    // Reworded into your own words not in use yet: the earlier wording keeps running (3.5, with a reader), by the new
    // line's key. Each line taken out is paired, in order, with a line put in where it was (`reworded`).
    const keep = new Map<string, string>();
    if (reads) {
      const after = new Set(rulesOf(text).map((l) => keyOf(l.text)));
      const textOf = new Map(rulesOf(text).map((l) => [keyOf(l.text), l.text]));
      const pairs = reworded(rulesOf(f.text).map((l) => keyOf(l.text)), rulesOf(text).map((l) => keyOf(l.text)));
      // Never behind a line read as can't: your new words no longer say what the earlier did (the reviews of 3.5).
      const waits = (to: string | undefined): to is string => !!to && own.has(to) && !inUse(to) && this.readOf(textOf.get(to) ?? "").read?.result !== "cant";
      for (const [from, to] of pairs) if (had.has(from) && waits(to)) keep.set(from, to);
      // An earlier wording kept already: while its line still waits, or follows it reworded again; else it stops.
      for (const [key, row] of had) {
        if (keep.has(key) || !row.earlier || wanted.has(key)) continue;
        const to = after.has(row.earlier) ? row.earlier : pairs.find(([from]) => from === row.earlier)?.[1];
        if (waits(to)) keep.set(key, to);
      }
    }
    const gone: { id: string; rule: string }[] = [];
    let i = 0;
    this.d.store.db.transaction(() => {
      for (const [key, row] of had) {
        if (inUse(key)) {
          // Back in use as itself: no longer anyone's earlier wording.
          if (row.earlier) this.unmarkEarlier(row.id);
          continue;
        }
        const to = keep.get(key);
        if (to) {
          if (row.earlier !== to) this.markEarlier(row.id, to);
          continue;
        }
        gone.push({ id: row.id, rule: row.rule });
        this.d.store.deleteRule(row.id);
        this.dropQueued(row.id);
      }
      for (const [key, w] of wanted) {
        if (had.has(key) || !inUse(key)) continue;
        const old = back.get(key);
        if (old) {
          this.d.store.saveRule(old.id, JSON.parse(old.rule));
          continue;
        }
        // Its version too: two saves in one millisecond make two rules.
        const n = w.ex?.n ?? null;
        const briefing = n === 6 || w.read?.on === "briefing";
        const id = `${briefing ? EVERY_PREFIX : LINE_PREFIX}${now}-${v}-${i++}`;
        if (briefing) {
          const every = w.ex ? { days: [1, 2, 3, 4, 5], time: w.ex.params.time ?? "08:00" } : everyOf(w.read!);
          const rule = everyRule(id, w.said, every, now);
          this.d.store.saveRule(id, { ...rule, made: { ...rule.made, key, ...(w.read ? { read: true as const } : {}) } });
        } else {
          const rule = w.ex ? lineRule(id, w.said, w.ex, now) : readRule(id, w.said, w.read!, now)!;
          // Its threads join now, each taking what it has as told, or at the brain's first look.
          if (this.viewed) {
            this.joinNow(rule, now);
            delete rule.state.joining;
          }
          this.d.store.saveRule(id, rule);
        }
      }
      saveRemoved(this.d.store, { v, at: now, rows: gone });
      saveFile(this.d.store, { v, text, savedAt: now, by });
      // A question's answer: kept for a line still there or put back by Undo, and for one just removed until the next
      // save, so Undo brings it back in use (the eighth reviews: it came back needing an answer, doing nothing).
      const saidOf = (row: { rule: string }) => {
        try {
          return [normal(JSON.parse(row.rule).made.said)];
        } catch {
          return [];
        }
      };
      const was = new Set([...rulesOf(f.text).map((l) => normal(l.text)), ...[...back.values()].flatMap(saidOf)]);
      const removing = new Set(gone.flatMap(saidOf));
      const lines = new Set(rulesOf(text).map((l) => normal(l.text)));
      this.pruneReads(text, now, (k) => (lines.has(k) && was.has(k)) || removing.has(k));
      // What you allowed (stage 3.5, "Allowing a call"): kept for a line still there, one Undo puts back in time, one
      // whose rule never stopped (an earlier wording back as itself: the seventh reviews), one just removed (for Undo)
      // and an earlier wording still running; else dropped, so a line put back later, or any edit to its words, asks
      // again. Nothing in a save ever allows.
      const before = new Set(rulesOf(f.text).map((l) => keyOf(l.text)));
      const after = new Set(rulesOf(text).map((l) => keyOf(l.text)));
      const held = new Set([...gone.flatMap((row) => mine(row)?.key ?? []), ...keep.keys()]);
      const allowed = this.allowedKept();
      const still = Object.entries(allowed).filter(([k]) => (after.has(k) && (before.has(k) || back.has(k) || had.has(k))) || held.has(k));
      if (still.length !== Object.keys(allowed).length) this.d.store.set(ALLOWED_KEY, JSON.stringify(Object.fromEntries(still)));
    });
    this.d.log(`engine: your rules saved (v${v}, ${[...wanted.keys()].filter(inUse).length} in use${gone.length ? `, ${gone.length} stopped` : ""}${keep.size ? `, ${keep.size} earlier wording${keep.size === 1 ? "" : "s"} kept` : ""})`);
    this.soon();
    return { ok: true };
  }

  /** A line's rule joins the threads as they are now: what each has then isn't news (no catch-up). */
  private joinNow(rule: LineRule, now: number) {
    if (rule.example === 2) this.watchIdle(rule, now);
    else this.joinLine(rule, new Map([...this.items.values()].map((it) => [it.id, this.observations.question(it, now)])), now);
  }

  private markEarlier(id: string, to: string) {
    const r = this.lineRules().find((x) => x.id === id);
    if (r) this.d.store.saveRule(id, { ...r, state: { ...r.state, earlier: to } });
    else {
      const e = this.everyRules().find((x) => x.id === id);
      if (e) this.d.store.saveRule(id, { ...e, state: { ...e.state, earlier: to } });
    }
  }

  private unmarkEarlier(id: string) {
    const r = this.lineRules().find((x) => x.id === id);
    if (r) {
      const { earlier: _, ...state } = r.state;
      this.d.store.saveRule(id, { ...r, state });
    }
  }

  /**
   * Readings kept only for the file's lines, and a week for any other (Undo, a line put back), at most 100; answers only
   * where `answered` says (Fable, topic 11: removing or rewording a line forgets its answer, once Undo can't bring it back).
   */
  private pruneReads(text: string, now: number, answered: (k: string) => boolean) {
    const lines = new Set(rulesOf(text).map((l) => normal(l.text)));
    // And an earlier wording's, while it runs: its reading is what it was allowed on (the seventh reviews).
    const running = new Set([...this.lineRules(), ...this.everyRules()].filter((r) => "earlier" in r.state && r.state.earlier).map((r) => normal(r.made.said)));
    const kept = Object.entries(this.readsKept()).filter(([k, r]) => lines.has(k) || running.has(k) || now - (r?.at ?? 0) < 7 * 86_400_000).sort((a, b) => Number(lines.has(b[0])) - Number(lines.has(a[0])) || (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, 100);
    this.d.store.set(READ_KEY, JSON.stringify(Object.fromEntries(kept)));
    // And an earlier wording's answer while it runs, as its reading (the eighth reviews: it ran on with neither row nor call).
    this.d.store.set(ANSWERS_KEY, JSON.stringify(Object.fromEntries(Object.entries(this.answersKept()).filter(([k]) => answered(k) || running.has(k)))));
  }

  /**
   * Use these rules (`POST /api/rules/use {v}`, Fable's topic 11): every line read but not in use yet (ok, judged, or
   * a question answered) goes into use now, each a new rule from this moment with no catch-up, and the earlier wording
   * of each stops. Lines that need an answer or can't be done are left as they are. `conflict`: the file changed since,
   * or (`ifRead`, the `rv` shown) a line was read or answered since, which the phone hasn't shown.
   */
  useRules(ifV: number, now = this.clock.now(), ifRead?: string): { ok: true; used: number } | { conflict: true } {
    const f = fileOf(this.d.store);
    if (ifV !== f.v || (ifRead !== undefined && ifRead !== this.readsV(f.text))) return { conflict: true };
    const have = new Set([...this.lineRules().map((r) => r.made.key), ...this.everyRules().flatMap((r) => (r.made.key ? [r.made.key] : []))]);
    const projects = this.projects();
    const keys = rulesOf(f.text).filter((l) => !exampleOf(l.text, projects) && this.readOf(l.text).rule && !have.has(keyOf(l.text))).map((l) => keyOf(l.text));
    if (!keys.length) return { ok: true, used: 0 };
    // As a save of the same text, with these put in use: the file's version moves on, as after any change.
    const r = this.saveRules(f.text, f.v, f.by, now, keys);
    return "ok" in r ? { ok: true, used: keys.length } : { conflict: true };
  }

  /**
   * The answer to a line's question (`POST /api/rules/answer {line, choice}`, Fable's topic 11): kept with its reading by
   * the line's text, never written into your sentence. The line then waits for Use these rules. Never for a line in use:
   * its row would read as the new choice while the old one runs (the reviews of 3.5).
   */
  answerRule(line: string, choice: number): boolean {
    const { read } = this.readOf(line);
    if (!read || read.result !== "ask" || !Number.isInteger(choice) || choice < 0 || choice >= read.options.length) return false;
    const key = keyOf(line);
    if (this.lineRules().some((r) => r.made.key === key) || this.everyRules().some((r) => r.made.key === key)) return false;
    this.d.store.set(ANSWERS_KEY, JSON.stringify({ ...this.answersKept(), [normal(line)]: choice }));
    this.d.log("engine: a rule's question answered");
    return true;
  }

  private readingNowP: Promise<"read" | "failed" | "limit" | "none"> | null = null;

  /**
   * The reader over the file's lines in your own words not read yet (`POST /api/rules/read`, after a save, and Try
   * again): one call, at most 15 s, within today's reads and the account's background budget; each answer checked in
   * code and kept by the line's text. `none`: nothing to read; `failed`: it couldn't, the lines stay "Not read yet";
   * `limit`: today's reads are used.
   */
  readRules(now = this.clock.now()): Promise<"read" | "failed" | "limit" | "none"> {
    return (this.readingNowP ??= this.readNew(now).finally(() => (this.readingNowP = null)));
  }

  /** The threads looked at once, if nothing has yet (a brain just woken): your rules' projects and example 2 need them. */
  async viewedOnce() {
    if (this.viewed) return;
    const items = await this.d.adapter.list().catch(() => null);
    if (items && !this.viewed) {
      this.see(items, this.clock.now());
      this.soon();
    }
  }

  private async readNew(now: number): Promise<"read" | "failed" | "limit" | "none"> {
    if (!this.d.reader) return "none";
    await this.viewedOnce();
    const projects = this.projects();
    const kept = this.readsKept();
    const lines = [...new Map(rulesOf(fileOf(this.d.store).text).filter((l) => !exampleOf(l.text, projects) && !kept[normal(l.text)]).map((l) => [normal(l.text), l.text])).values()].slice(0, RULES_MAX);
    if (!lines.length) return "none";
    const day = localDay(now, this.phoneZone() ?? "UTC");
    let used: { day: string; n: number } = { day, n: 0 };
    try {
      const u = JSON.parse(this.d.store.get(READS_KEY) ?? "null");
      if (u?.day === day && Number.isInteger(u.n)) used = u;
    } catch {
      // Unreadable: counted from none.
    }
    if (used.n >= READS_PER_DAY) return "limit";
    this.d.store.set(READS_KEY, JSON.stringify({ day, n: used.n + 1 }));
    const account = this.account();
    let timer: Timer | null = null;
    const late = new Promise<"late">((resolve) => (timer = this.clock.setTimeout(() => resolve("late"), READ_MS)));
    const got = await Promise.race([this.d.reader(lines.map((text, i) => ({ n: i + 1, text })), account).catch((e) => (this.d.log(`engine: couldn't read your rules (${describe(e)})`), null)), late]).finally(() => timer && this.clock.clear(timer));
    if (got === "late" || got === null) {
      this.d.log("engine: your rules weren't read in time; they stay not read yet");
      return "failed";
    }
    if (got === "limit") return "limit";
    const at = this.clock.now();
    const next = { ...this.readsKept() };
    lines.forEach((text, i) => {
      const read = checkRaw(got.find((r) => r?.n === i + 1), text, account, at);
      next[normal(text)] = read;
      if (read.refused?.length) this.d.log(`engine: a rule's reading was refused in part (${read.refused.join("; ")})`);
    });
    this.d.store.set(READ_KEY, JSON.stringify(next));
    this.d.log(`engine: ${lines.length} rule${lines.length === 1 ? "" : "s"} read`);
    this.stopBehindCant();
    return "read";
  }

  /**
   * A reworded line read as can't: its earlier wording stops now, with what it hadn't sent (the reviews of 3.5: "Don't
   * ring me…" read as can't kept the old line ringing, and Use these rules has nothing to put in use for it).
   */
  private stopBehindCant() {
    const textOf = new Map(rulesOf(fileOf(this.d.store).text).map((l) => [keyOf(l.text), l.text]));
    this.d.store.db.transaction(() => {
      for (const r of [...this.lineRules(), ...this.everyRules()]) {
        const to = (r.state as { earlier?: string }).earlier;
        if (!to || this.readOf(textOf.get(to) ?? "").read?.result !== "cant") continue;
        this.d.store.deleteRule(r.id);
        this.dropQueued(r.id);
        this.d.log("engine: a reworded rule's earlier wording stopped: its new words can't be done yet");
      }
    });
  }

  /**
   * Examples 1, 3 and 12 (Fable, topic 5), at each look: each thread joins as first seen (from before the rule was
   * added, or with `joining` everything it has then, isn't news), then a question (1: an agent asks or waits for your
   * OK, any thread), a failed run (3: any thread; 12: a thread you follow; never one you stopped), or for a work system
   * that reads test runs, a run's end, told only if its last test run or build failed (read once at its end, `red`). A
   * thread set to Nothing leaves them, as it leaves every wide scope. Stage 3.5: a line's scope (any thread, the ones you
   * follow, a project), a line's replies (13, batched), example 1's judged half (a turn that ends with no question,
   * checked a minute on), a clause of your own on a reply, and example 2 (`watchIdle`).
   */
  private watchLines(keys: Map<string, string | null>, now: number) {
    for (let rule of this.lineRules()) {
      if (![1, 2, 3, 12, 13].includes(rule.example)) continue;
      const before = JSON.stringify(rule.state);
      const fire = rule.example === 2 ? this.watchIdle(rule, now) : this.joinLine(rule, keys, now);
      let changed = JSON.stringify(rule.state) !== before || !!rule.state.joining;
      delete rule.state.joining;
      for (const f of fire) {
        try {
          this.fireLine(rule, f.item, f.key, f.kind, f, now);
          changed = false;
        } catch (e) {
          this.d.log(`engine: couldn't keep ${f.item?.id ?? rule.id}'s ${f.kind} for your rule (${describe(e)}); it's looked at again`);
          const fresh = this.lineRules().find((r) => r.id === rule.id);
          if (!fresh) break;
          rule = fresh;
        }
      }
      if (changed) this.d.store.saveRule(rule.id, rule);
    }
  }

  /** A line's scope (stage 3.5): every thread, the ones you follow (example 12's), or a project's, read again each look. */
  private inScope(rule: LineRule, item: WorkItem, stars: Set<string>): boolean {
    const scope = rule.params.scope ?? (rule.example === 12 ? { followed: true as const } : { any: true as const });
    if ("followed" in scope) return stars.has(item.id);
    if ("project" in scope) return this.inProject(scope.project, item);
    return true;
  }

  /**
   * Whether a line's call may call for `item`: a project's only for a thread it can tell is that project's (the seventh
   * reviews: two repositories' threads both named "nix" rang for mono-nix's call). Any other in its scope is told, as a
   * notification (the eighth reviews: the strict match dropped the fact, so it sent nothing at all).
   */
  private lineCallsFor(rule: LineRule, item: WorkItem): boolean {
    const scope = rule.params.scope;
    return !scope || !("project" in scope) || this.inProject(scope.project, item, true);
  }

  /** A project's name another of the account's projects has too ("nix" for mono-nix and nix-config), or null. */
  private sharedName(p: Project): string | null {
    const all = this.projects();
    const names = all.find((q) => q.said === p.said)?.names ?? p.names;
    return names.find((n) => all.some((q) => q.said !== p.said && q.names.includes(n))) ?? null;
  }

  /**
   * A thread is in a project by its name there; with a repository, any of its workspaces, made later too (§3, Scope).
   * `only`: never by a name another of the account's projects has too, since then it can't be told whose it is.
   */
  private inProject(p: Project, item: WorkItem, only = false): boolean {
    const name = (item.project ?? item.group).toLowerCase();
    const places = this.d.adapter.places?.() ?? [];
    const by = (q: Project) => q.names.includes(name) || (!!q.repo && places.some((pl) => pl.repo === q.repo && pl.name.replace(/, on [\w-]+$/, "").replace(/ \([^)]*\)$/, "").toLowerCase() === name));
    if (!by(p)) return false;
    return !only || !this.projects().some((q) => q.said !== p.said && by(q));
  }

  /** Whether a line's judged half runs now: the level has judged lines, and this brain can check them. */
  private judging(rule: LineRule): boolean {
    if (!this.limits().judgedLines) return false;
    return rule.example === 13 ? !!this.d.judge : !!this.d.needsYou;
  }

  private joinLine(rule: LineRule, keys: Map<string, string | null>, now: number): Fire[] {
    const stars = this.d.store.stars();
    const set = this.d.store.threadNotifies();
    const told = !!rule.state.joining;
    // Example 1's: the question as a fact, and its judged half (an example 1 row is both; a line read in your words, as read).
    const needs = rule.example === 1 ? (rule.params.needs ?? (rule.read ? "none" : "also")) : null;
    const judgedHalf = needs === "also" || needs === "only" || (rule.example === 13 && !!rule.params.judge);
    const judging = judgedHalf && this.judging(rule);
    // A rule that starts reading runs only now (3.5's example 1, made in 3.4): what each thread has finished isn't news.
    const runsFrom = rule.state.runsFrom ?? (rule.example === 1 && judgedHalf ? now : undefined);
    const fresh = rule.example === 1 && judgedHalf && rule.state.runsFrom === undefined;
    if (runsFrom !== undefined) rule.state.runsFrom = runsFrom;
    const fire: Fire[] = [];
    for (const item of this.items.values()) {
      if (item.parentId !== null || item.settled) continue;
      const id = item.id;
      const notify = notifyOf(set.get(id)?.notify, stars.has(id));
      if (notify === "nothing" || !this.inScope(rule, item, stars)) {
        delete rule.state.items[id];
        continue;
      }
      const key = keys.get(id) ?? null;
      const runAt = item.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
      let joined = rule.state.items[id];
      if (!joined) {
        const q = this.observations.get(id).question;
        // A thread you follow joins a followed scope when you follow it: its run then isn't news.
        const followed = !!rule.params.scope && "followed" in rule.params.scope;
        const old = told || (rule.example === 12 && !rule.read) || followed || (runAt > 0 && runAt <= rule.made.at);
        joined = rule.state.items[id] = {
          at: now, heard: key && (told || (q?.key === key && q.seenAt <= rule.made.at)) ? key : null, ran: old ? this.ranNow(item, now) : null, running: item.status === "running",
        };
      } else if (fresh) joined.ran = this.ranNow(item, now);
      if (rule.example === 1) {
        if (key && key !== joined.heard) {
          if (needs !== "only") fire.push({ item, key, kind: "question" });
          else joined.heard = key;
        }
        if (!judgedHalf) continue;
      }
      if (item.status === "running") {
        joined.running = true;
        continue;
      }
      const ran = item.pendingQuestion ? (this.ranNow(item, now) ?? joined.ran ?? null) : runAt ? this.observations.run(id, runAt, now) : joined.running ? this.observations.run(id, 0, now) : null;
      if (ran && ran !== joined.ran) {
        // A turn's end judged (example 1's half; a clause of your own): never a thread you follow or set by hand, never
        // one with a question held open (that's the question), never a stale one; paused on a level without them.
        const ends = runAt || now;
        const judgeable = judging && notify === "rules" && !item.pendingQuestion && ends > now - JUDGE_STALE_MS && ends >= (rule.state.runsFrom ?? 0);
        if (rule.example === 1) {
          if (judgeable && item.status !== "failed" && item.status !== "cancelled") fire.push({ item, key: ran, kind: "reply", judged: "needs_you" });
          else joined.ran = ran;
        } else if (rule.example === 13) {
          if (item.pendingQuestion) joined.ran = ran;
          else if (rule.params.judge) {
            if (judgeable) fire.push({ item, key: ran, kind: "reply", judged: "judge" });
            else joined.ran = ran;
          } else fire.push({ item, key: ran, kind: "reply", batched: true });
        } else if (!item.pendingQuestion && item.status === "failed") fire.push({ item, key: ran, kind: "reply" });
        else if (!item.pendingQuestion && item.status !== "cancelled" && item.testRuns === true) fire.push({ item, key: ran, kind: "reply", red: true });
        else joined.ran = ran;
      }
      joined.running = false;
    }
    return fire;
  }

  /**
   * Example 2 (§3, `none_running`; Fable, topic 5): the project's top-level threads go from at least one running or
   * waiting for you to none, and stay so for 90 s; then one fact, `${rule}:idle:${the latest run's end in it}`. It fires
   * again only after one has run since. A thread set to Nothing still counts: it's a fact about the project.
   */
  private watchIdle(rule: LineRule, now: number): Fire[] {
    const scope = rule.params.scope;
    if (!scope || !("project" in scope)) return [];
    const threads = [...this.items.values()].filter((i) => i.parentId === null && this.inProject(scope.project, i));
    const busy = threads.some((i) => i.status === "running" || i.status === "waiting" || i.pendingQuestion);
    const was = rule.state.idle;
    if (busy || rule.state.joining || !was) {
      rule.state.idle = { busy };
      return [];
    }
    if (!was.busy) return [];
    const since = was.since ?? now;
    if (now - since < IDLE_MS) {
      rule.state.idle = { busy: true, since };
      return [];
    }
    rule.state.idle = { busy: false };
    const latest = Math.max(0, ...threads.map((i) => (i.lastRunAt ? Date.parse(i.lastRunAt) || 0 : 0)));
    return [{ key: `${rule.id}:idle:${latest || since}`, kind: "idle" }];
  }

  /** When example 2's lines next look: 90 s after their project's last thread stopped. */
  private idleTimes(): number[] {
    return this.lineRules().flatMap((r) => (r.example === 2 && r.state.idle?.busy && r.state.idle.since !== undefined ? [r.state.idle.since + IDLE_MS + 1] : []));
  }

  /** §3's fire for a line, one transaction: its baseline moves past the fact, its count goes up, its duty is written. */
  private fireLine(rule: LineRule, item: WorkItem | undefined, key: string, kind: Fire["kind"], f: Pick<Fire, "red" | "judged" | "batched">, now: number) {
    if (kind === "idle") {
      const scope = rule.params.scope;
      const project = scope && "project" in scope ? scope.project.said : "";
      this.d.store.db.transaction(() => {
        rule.state.n++;
        this.d.store.saveRule(rule.id, rule);
        this.addDuty(key, "reply", { itemId: rule.id, handle: project, seen: { runAt: 0, question: null }, idle: { project, ...(rule.params.say ? { say: rule.params.say } : {}) } }, {
          rule: rule.id, via: "rule", ring: false, tell: true, urgency: "urgent", from: now, said: rule.made.said,
        }, undefined, now);
      });
      this.d.log(`engine: nothing is running in ${project}; your rule`);
      return;
    }
    const handle = this.nameOf(item!);
    // A line's call (example 12's failure, a question a line says to call for): through the night line only if it says so.
    // One in your own words only once you've allowed it (by day, or through the night): until then its notification
    // says so (`allow`, read again as it's sent: `allowing`), and the gate at ring time looks again (`lineCalls`).
    const calling = rule.ring && (rule.example === 12 || (rule.example === 1 && kind === "question")) && this.lineCallsFor(rule, item!);
    const consent = calling ? this.consentOf(rule) : { call: false, night: false, since: 0 };
    const calls = calling && consent.call;
    const night = rule.example === 12 && (!rule.read || (!!rule.params.night && consent.night));
    // A question that is a command the thread holds: the line calls for the hold, as the hold (Fable's ruling on pass B2's
    // review: `ringHeldLine`), so the hold's reach-out has the duty too.
    const hold = calls && kind === "question" && item!.gate && item!.questionId ? this.d.store.reachOut(`held:${item!.id}:${item!.questionId}`) : null;
    this.d.store.db.transaction(() => {
      if (kind === "question") rule.state.items[item!.id].heard = key;
      else rule.state.items[item!.id].ran = key;
      rule.state.n++;
      this.d.store.saveRule(rule.id, rule);
      const duty: Duty = {
        rule: rule.id, via: "rule", ring: false, tell: !f.batched, urgency: f.batched ? "batched" : "urgent", from: f.judged ? now + JUDGE_AFTER_MS : now, said: rule.made.said,
        ...(calls ? { calls: true as const, night } : {}), ...(calling && !calls ? { allow: true as const } : {}), ...(f.red ? { red: true as const } : {}), ...(f.judged ? { judged: f.judged } : {}),
      };
      this.addDuty(key, kind, this.newsOf(item!, handle, kind), duty, undefined, now);
      if (hold) this.addDuty(hold.key, "held", hold.news, duty, undefined, now);
    });
    this.d.log(`engine: ${handle} ${kind === "question" ? "asks something" : f.judged ? "ended a turn; it's checked in a minute" : f.batched ? "replied" : f.red ? "replied; its tests are read" : "failed"}; your rule`);
  }

  // --- judged lines (stage 3.5; Fable, topic 12) ---

  /**
   * The checks made (and replies told unchecked) in the last two days, kv `rules_checks`: one entry per line's duty, its
   * result ("dropped": thrown away, a save changed its line meanwhile), and `calls`, how many checks it made (one card's
   * check serves every needs-my-input line, so it's counted on the first; older entries count one unless unchecked).
   */
  private checksKept(): Check[] {
    try {
      const r = JSON.parse(this.d.store.get(CHECKS_KEY) ?? "[]");
      return Array.isArray(r) ? r.filter((x) => x && Number.isFinite(x.at) && typeof x.rule === "string") : [];
    } catch {
      return [];
    }
  }

  /** Checks made today, the phone's local day (Commute's ring's day): at most `JUDGED_PER_DAY`, across every line. */
  private checksToday(now: number): number {
    const zone = this.phoneZone() ?? "UTC";
    const day = localDay(now, zone);
    return this.checksKept().filter((c) => localDay(c.at, zone) === day).reduce((n, c) => n + (c.calls ?? (c.r !== "unchecked" ? 1 : 0)), 0);
  }

  /** Checks under way and not yet logged, counted toward today's as they start (several go at once). */
  private checking = 0;

  /** A judged line's last day (Fable, topic 12): checked, told, told unchecked. */
  private checksOf(rule: string, now: number): { checked: number; told: number; unchecked: number } {
    const day = this.checksKept().filter((c) => c.rule === rule && c.at > now - 86_400_000 && c.r !== "dropped");
    return { checked: day.filter((c) => c.r !== "unchecked").length, told: day.filter((c) => c.r === "yes").length, unchecked: day.filter((c) => c.r === "unchecked").length };
  }

  private logCheck(entries: Omit<Check, "at">[], now: number) {
    if (!entries.length) return;
    const kept = [...this.checksKept().filter((c) => c.at > now - 2 * 86_400_000), ...entries.map((e) => ({ at: now, ...e }))];
    this.d.store.set(CHECKS_KEY, JSON.stringify(kept));
    const today = this.checksToday(now);
    const unchecked = kept.filter((c) => c.r === "unchecked" && c.at > now - 86_400_000).length;
    // For Beta to move the cap (Fable, topic 12): checked today, and told unchecked in the last day.
    this.d.log(`engine: judged checks: ${today} today of ${JUDGED_PER_DAY}, ${unchecked} told unchecked in the last day`);
  }

  /**
   * A judged duty's check, a minute after its turn ended (Fable, topic 12): only while the thread is still stopped on
   * that turn, unheard, not opened, with no call on its own conversation, the level still having judged lines. One
   * card per run serves every "needs my input" line; each clause of your own is its own check. Within 50 a day and
   * 20 s, else unchecked: told in following's batch, "Not checked.". A yes is told at once with its reason; a no takes
   * the duty away. A check whose rule a save changed meanwhile is thrown away. Returns the reach-out to go on with.
   */
  private async checkJudged(r: ReachOut, now: number): Promise<ReachOut | null> {
    const pending = (x: ReachOut) => x.duties.filter((d) => d.judged === "needs_you" || d.judged === "judge");
    const item = this.items.get(r.news.itemId);
    const runAt = item?.lastRunAt ? Date.parse(item.lastRunAt) || 0 : 0;
    const moved = !item || item.status === "running" || item.pendingQuestion || (r.news.seen.runAt > 0 && runAt !== r.news.seen.runAt);
    // A call on: checked as ever, and told in the call, unless the call is this news's own conversation (Fable, topic
    // 12; the reviews of 3.5: any call used to drop it).
    const call = this.d.call?.();
    const own = !!call && !!r.conversationId && r.conversationId === call.conversationId;
    const skip = moved || this.heard(r.news) || r.opened !== undefined || own || !this.limits().judgedLines;
    const results = new Map<string, "yes" | "no" | "unchecked">();
    let reason: string | null = null;
    const log: Omit<Check, "at">[] = [];
    let made = 0;
    try {
      if (!skip) {
        const within = <T>(p: Promise<T>): Promise<T | null> => {
          let timer: Timer | null = null;
          const late = new Promise<null>((resolve) => (timer = this.clock.setTimeout(() => resolve(null), JUDGE_MS)));
          return Promise.race([p.catch((e) => (this.d.log(`engine: a judged check failed (${describe(e)})`), null)), late]).finally(() => timer && this.clock.clear(timer));
        };
        // Within the day's checks, counting those under way (several go at once): each counted as it starts.
        const start = () => {
          if (this.checksToday(this.clock.now()) + this.checking >= JUDGED_PER_DAY) return false;
          this.checking++;
          made++;
          return true;
        };
        const needs = pending(r).filter((d) => d.judged === "needs_you");
        if (needs.length) {
          const asked = !!this.d.needsYou && start();
          const got = asked ? await within(this.d.needsYou!(r.news.itemId)) : null;
          needs.forEach((d, i) => {
            const res = got ? (got.yes ? "yes" : "no") : "unchecked";
            results.set(d.rule, res);
            // One card's check for every needs-my-input line: counted once.
            log.push({ rule: d.rule, r: res, calls: asked && i === 0 ? 1 : 0 });
          });
          if (got?.yes) reason = got.reason;
        }
        const clauses = pending(r).filter((d) => d.judged === "judge");
        if (clauses.length) {
          const rep = this.d.adapter.report ? await this.d.adapter.report(r.news.itemId).catch(() => null) : null;
          for (const d of clauses) {
            const clause = this.lineRules().find((x) => x.id === d.rule)?.params.judge;
            const asked = !!clause && !!rep && !!this.d.judge && start();
            const got = asked ? await within(this.d.judge!(clause!, { title: r.news.handle, text: rep!.text })) : null;
            const res = got ? (got.yes ? "yes" : "no") : "unchecked";
            results.set(d.rule, res);
            log.push({ rule: d.rule, r: res, calls: asked ? 1 : 0 });
            if (got?.yes && !reason) reason = got.reason;
          }
        }
      }
      const at = this.clock.now();
      return this.d.store.db.transaction(() => {
        // A check whose rule a save changed or removed meanwhile is thrown away: that save dropped what the rule had
        // queued (`dropQueued`), its duty with it, so the reply isn't told by that line. It was made all the same, so
        // it's counted (the reviews of 3.5).
        const fresh = this.d.store.reachOut(r.key);
        const live = (rule: string) => !!fresh && fresh.state === "untold" && fresh.duties.some((d) => d.rule === rule);
        this.logCheck(log.map((l) => (live(l.rule) ? l : { ...l, r: "dropped" as const })), at);
        this.checking -= made;
        made = 0;
        if (!fresh || fresh.state !== "untold") return null;
        const duties = fresh.duties.flatMap((d): Duty[] => {
          if (d.judged !== "needs_you" && d.judged !== "judge") return [d];
          const res = results.get(d.rule);
          if (skip || !res || res === "no") return [];
          // Unchecked: in following's batch from its turn's end, so the first after a quiet spell goes now.
          return res === "yes" ? [{ ...d, judged: "yes" }] : [{ ...d, judged: "unchecked", urgency: "batched", tell: false, from: fresh.at }];
        });
        if (!duties.length) {
          this.d.store.saveReachOut({ ...fresh, state: "dropped" });
          return null;
        }
        const next: ReachOut = { ...fresh, duties, ...(reason ? { reason } : {}) };
        this.d.store.saveReachOut(next);
        return next;
      });
    } finally {
      // Not logged (the store failed): no longer under way.
      this.checking -= made;
    }
  }

  /**
   * Example 2's news (stage 3.5; Fable, topic 5): one notification, "Nothing is running in driver", at once after its
   * 90 s, as Quiet and the night line let it (silent then); the weekend and the car keep it for your next call, as a
   * reply, and without a phone that takes notifications it's kept. Never a call: a call has no words for it yet.
   */
  private async deliverIdle(r: ReachOut, now: number) {
    const h = this.holdNow(now);
    const phone = this.alertPhone();
    if (h.weekend || h.by === "car" || !phone || !this.d.notify) {
      this.d.store.attemptDelivery({ key: r.key, channel: "kept", state: "accepted", at: now });
      return;
    }
    if (!this.d.store.attemptDelivery({ key: r.key, channel: "notification", state: "sending", at: now })) return;
    this.flying.add(`notification\n${r.key}`);
    await this.sent([r.key], phone, idleNoteOf(r, privacyOf(this.d.store)), now);
  }

  /**
   * A run's end that a line tells only if its last test run or build failed (`red`): read once (the reply's report,
   * `words`), then the line's duty stays (red, so it says so) or goes; with no duty left its news goes, and with only
   * following's batched one left, it waits for the batch. Returns the reach-out to deliver now, if any.
   */
  private async checkRed(r: ReachOut, now: number): Promise<ReachOut | null> {
    await this.words([r]);
    const fresh = this.d.store.reachOut(r.key);
    if (!fresh || fresh.state !== "untold") return null;
    const isRed = fresh.tests?.state === "failed" || fresh.tests?.state === "build";
    const duties = isRed ? fresh.duties.map(({ red: _, ...d }) => d) : fresh.duties.filter((d) => !d.red);
    if (!duties.length) {
      this.d.store.saveReachOut({ ...fresh, state: "dropped" });
      return null;
    }
    const next = { ...fresh, duties };
    this.d.store.saveReachOut(next);
    return batched(next, now) ? null : next;
  }

  // --- holding back (stage 3.4: reach step 4; Fable, topic 8) ---

  /** Quiet for a while (kv `quiet`): its start, its end, and who set it; ended early, its end is when it ended. */
  quietOf(): { at: number; until: number; by: string } | null {
    try {
      const q = JSON.parse(this.d.store.get(QUIET_KEY) ?? "null");
      return q && Number.isFinite(q.at) && Number.isFinite(q.until) ? { at: q.at, until: q.until, by: String(q.by ?? "app") } : null;
    } catch {
      return null;
    }
  }

  /** Quiet for a while while it's on, else null. */
  quiet(now = this.clock.now()): { at: number; until: number } | null {
    const q = this.quietOf();
    return q && now < q.until ? q : null;
  }

  /**
   * Quiet for a while until `until` (Home, Siri, the voice: Fable, topic 10), at most 12 hours from now. On already, its
   * end moves and its start stays (one stretch, one end-of-hold notification).
   */
  setQuiet(until: number, by: string, now = this.clock.now()): { until: number } | null {
    if (!(until > now)) return null;
    const end = Math.min(until, now + QUIET_MAX_MS);
    const on = this.quiet(now);
    this.d.store.set(QUIET_KEY, JSON.stringify({ at: on?.at ?? now, until: end, by }));
    this.d.log(`engine: quiet until ${new Date(end).toISOString()}`);
    this.soon();
    return { until: end };
  }

  /**
   * Quiet for a while asked for by voice (Fable, topic 10): until a time of day said on the phone's clock, or for a
   * length; at most 12 hours. Set now, and the line said word for word, with the call-backs it will hold.
   */
  quietPlan(said: string | null, hours: number | null, now = this.clock.now()): { line: string; until: number } | { refused: string } | { unreadable: true } {
    const zone = this.phoneZone();
    let until: number;
    if (said?.trim()) {
      const w = parseWhen(/\b(?:till|until|to|by|at|for|in)\b/.test(said) ? said : `until ${said}`, zone, now);
      if (w === "zone") return { refused: NO_ZONE };
      // A time said for today that has passed (stage 4's parseWhen): nothing's set up, as for a call-back's.
      if (w === "passed") return { refused: TIME_PASSED };
      if (w === null || w === "repeats") return { unreadable: true };
      until = w.at;
    } else if (hours !== null && Number.isFinite(hours) && hours > 0) until = now + Math.round(hours * 3600_000);
    else return { unreadable: true };
    const held = this.d.waits.all().filter((w) => !w.ready && headOf(w).ring && !w.mode?.notify && !w.mode?.anyway).length;
    const set = this.setQuiet(until, "voice", now)!;
    const time = spokenClock(set.until, zone ?? "UTC", now);
    const line = until - now > QUIET_MAX_MS ? quietCapped(time) : quietUntil(time);
    return { line: `${line}${this.d.ringer?.canRing() ? quietCalls(held, this.notifies()) : ""}`, until: set.until };
  }

  /** End now: false if it wasn't quiet. Its end-of-hold notification goes at once, if anything is unheard. */
  endQuiet(now = this.clock.now()): boolean {
    const on = this.quiet(now);
    if (!on) return false;
    this.d.store.set(QUIET_KEY, JSON.stringify({ ...this.quietOf(), until: now }));
    this.d.log("engine: quiet ended");
    this.soon();
    return true;
  }

  /**
   * The Focus filter's report (kv `focus`): on until its safety end, and whether it ever said on. iOS runs the filter
   * with its defaults ("Tell my rules" off) as any Focus ends, so an "off" proves nothing was set up (the reviews of 3.4).
   */
  focus(): { on: boolean; until: number; ever: boolean } {
    try {
      const f = JSON.parse(this.d.store.get(FOCUS_KEY) ?? "null");
      return f && typeof f.on === "boolean" ? { on: f.on, until: Number(f.until) || 0, ever: f.on || f.ever === true } : { on: false, until: 0, ever: false };
    } catch {
      return { on: false, until: 0, ever: false };
    }
  }

  /** The Focus filter told the brain (Fable, topic 15): kept apart from Quiet for a while, so neither ends the other. */
  setFocus(on: boolean, now = this.clock.now()) {
    this.d.store.set(FOCUS_KEY, JSON.stringify({ on, until: on ? now + FOCUS_MAX_MS : 0, ever: on || this.focus().ever }));
    this.d.log(`engine: a Focus with 10 & 2's filter is ${on ? "on" : "off"}`);
    this.soon();
  }

  /**
   * What holds back now (Fable, topic 8), first that applies: Quiet for a while, the Focus line while a Focus is on, the
   * car line within 30 minutes of a call through CarPlay, the night line inside its hours on the phone's clock. The
   * weekend line is apart: a filter on what, not how.
   */
  private holdNow(now: number): Hold {
    const quiet = this.quiet(now);
    const lines = this.lineRules();
    const zone = this.phoneZone();
    const f = this.focus();
    const focus = lines.some((l) => l.example === 8) && f.on && now < f.until;
    const carAt = this.d.ringer?.carAt() ?? null;
    const car = lines.some((l) => l.example === 9) && carAt !== null && now - carAt < CAR_MS;
    const night = zone ? lines.find((l) => l.example === 7 && nightAt(l.params, zone, now) !== null) ?? null : null;
    const weekend = zone ? lines.find((l) => l.example === 10 && weekendAt(zone, now)) ?? null : null;
    return { by: quiet ? "quiet" : focus ? "focus" : car ? "car" : night ? "night" : null, quiet, night, weekend };
  }

  /**
   * Whether a ring may ring now under your hold-back lines and Quiet for a while (Fable, topic 8): `night`, a line that
   * says "even at night" (example 12), rings through the night line and the weekend's; `anyway`, "call me anyway",
   * through everything. The car line holds no call, but inside the night line's hours the night holds it all the same
   * (the final reviews of 3.4: the car came first and rang at night, which example 7 and the readback say it doesn't).
   */
  private ringsThrough(now: number, through: { night?: boolean; anyway?: boolean }): boolean {
    const h = this.holdNow(now);
    if (through.anyway) return true;
    if (h.by === "quiet" || h.by === "focus") return false;
    return !h.night || !!through.night;
  }

  /**
   * A notification as it goes now: inside Quiet for a while or the night line, silent with the screen dark, whatever
   * else holds (a Focus or the car decide how a call is held, never the sound: the reviews of 3.4).
   */
  private quietened(note: Note, now: number): Note {
    const h = this.holdNow(now);
    if ((!h.quiet && !h.night) || note.interruption === "passive") return note;
    const { sound: _, ...rest } = note;
    return { ...rest, interruption: "passive" };
  }

  /** The weekend line's filter (Fable, topic 8): a plain reply no call-back asked for waits for your next call. */
  private weekendKeeps(r: ReachOut, now: number): boolean {
    if (!this.holdNow(now).weekend || r.kind !== "reply" || r.duties.some((d) => d.via === "callback")) return false;
    return !r.news.status && !r.news.still && !r.news.check && r.tests?.state !== "failed" && r.tests?.state !== "build";
  }

  // --- a line's call (examples 11 and 12; Fable, topic 16) ---

  /** Whether a line's call may ring now: Call me back, the level's call-backs today, and your hold-back lines. */
  private lineMayRing(night: boolean, now: number): boolean {
    const limit = this.limits().ring;
    return !!this.d.ringer?.canRing() && (limit === true || this.ringsToday(now) < limit.perDay) && this.ringsThrough(now, { night });
  }

  /**
   * A reach-out a line calls for now (example 12's failure: a due duty that calls), if it may ring. The gate is here, at
   * ring time: a call in your own words rings only while you allow its reading now, through the night only if you
   * allowed that too (engine.md §11, 3.5, "Allowing a call").
   */
  private lineCalls(r: ReachOut, now: number): boolean {
    const calls = r.duties.filter((d) => d.calls && d.via === "rule" && d.from <= now && !d.red).map((d) => ({ d, ok: this.consentFor(d.rule) })).filter((c) => c.ok.call);
    // Each line's call on its own (Fable, the ninth reviews: one that may not ring silenced another that may): through
    // the night line only for a line that says so (example 12's "even at night"; stage 3.5's `night`), and one allowed by
    // day only never from 23:00 to 07:00 (the eighth reviews), nor one allowed by voice (the tenth).
    return calls.some((c) => !(c.ok.day && this.dayHeld(now)) && this.lineMayRing(c.d.night !== false && c.ok.night, now));
  }

  /**
   * One call for a line's news (several in one grace, one call: "2 threads want you"), into no conversation: its push
   * names the first reach-out, which its call-back opens with (§3, Where a ring opens). `duty`, escalation's, is added in
   * the attempt's transaction. Missed, "You missed a call" (`missedRings`).
   */
  private async ringLine(rs: ReachOut[], now: number, duty?: Duty) {
    const at = this.clock.now();
    // A line's call whose consent went meanwhile (Stop calls during the turn's awaits: the seventh reviews) is told instead.
    const told: ReachOut[] = [];
    const keys = this.d.store.db.transaction(() => {
      if (!this.lineMayRing(!duty, at)) return null;
      return rs.filter((r) => {
        const fresh = this.d.store.reachOut(r.key);
        if (fresh?.state !== "untold") return false;
        if (!duty && !this.lineCalls(fresh, at)) {
          told.push(fresh);
          return false;
        }
        if (!this.d.store.attemptDelivery({ key: r.key, channel: "ring", state: "sending", at })) return false;
        if (duty) this.d.store.saveReachOut({ ...fresh, duties: [...fresh.duties, duty] });
        return true;
      }).map((r) => r.key);
    });
    if (keys === null) {
      // It may no longer ring (the day's call-back used meanwhile, a hold-back begun): a line's failure is a notification.
      if (!duty) for (const r of rs) await this.notifyOf(r, now);
      return;
    }
    for (const r of told) await this.notifyOf(r, now);
    if (!keys.length) return;
    for (const key of keys) this.flying.add(`ring\n${key}`);
    const names = privacyOf(this.d.store).names;
    const ringing = rs.filter((r) => keys.includes(r.key));
    const one = ringing.length === 1 ? ringing[0] : null;
    const who = one && names ? one.news.handle : "A thread";
    const caller = !one ? `${ringing.length} threads want you` : one.kind === "held" ? waitingCaller(one.news.handle, names) : one.kind === "question" ? `${who} asks something` : one.tests && (one.tests.state === "failed" || one.tests.state === "build") ? testsTitle(names ? one.news.handle : null, one.tests) : `${who} failed`;
    const result = await this.d.ringer!.call({ reachOut: keys[0] }, caller);
    this.d.log(`engine: rang "${caller}" for your rule: ${result}`);
    this.rang(keys, result, this.clock.now());
  }

  /**
   * Example 11's escalation (Fable, topic 16): one per question, due its minutes after Apple accepted its notification,
   * while it's still asked and wasn't opened in the app. Each a question's key and when.
   */
  private escalations(): { r: ReachOut; at: number; rule: LineRule }[] {
    // Each of your escalation lines (a file may have two, with different minutes: the reviews of 3.4). One in your own
    // words only once you've allowed it, from then (no catch-up): until then it does nothing (engine.md §11, 3.5,
    // "Allowing a call").
    const lines = this.lineRules().filter((r) => r.example === 11).flatMap((rule) => {
      const c = this.consentOf(rule);
      return c.call ? [{ rule, from: Math.max(rule.made.at, c.since), ms: (rule.params.minutes ?? 15) * 60_000, day: this.byDay(rule, c, rule.params.night === true) }] : [];
    });
    if (!lines.length) return [];
    return this.d.store.reachOuts().flatMap((r) => {
      if (r.kind !== "question" || r.state !== "untold" || r.opened) return [];
      const ds = this.d.store.deliveries(r.key);
      if (ds.some((d) => d.channel === "ring" || d.channel === "escalated")) return [];
      // Each line's own call (Fable, the eleventh reviews: a voice line's 10 minutes, held at 02:00, silenced example
      // 11's 15): the soonest that may ring when it's due; if none may, the soonest, which does nothing more then.
      // Held when due by anything `escalate` refuses for: by day only, a hold-back line, Quiet, a Focus, the car, or
      // ringing not allowed then (the skeptic's should on the eleventh reviews: a sooner one the night line held
      // silenced example 11's).
      const each = lines.flatMap(({ rule, from, ms, day }) => {
        const note = ds.find((d) => d.channel === "notification" && d.state === "accepted" && d.acceptedAt !== undefined && d.acceptedAt >= from);
        if (!note) return [];
        const due = note.acceptedAt! + ms;
        const h = this.holdNow(due);
        return [{ at: due, rule, held: (day && this.dayHeld(due)) || h.by !== null || h.weekend || !this.lineMayRing(false, due) }];
      });
      const first = each.sort((a, b) => Number(a.held) - Number(b.held) || a.at - b.at)[0];
      return first ? [{ r, at: first.at, rule: first.rule }] : [];
    });
  }

  /**
   * Escalations due, the threads looked at first: each still asked rings (several due together, one call), unless a
   * hold-back line or Quiet for a while is on, Call me back is off or the level's call-back is used, when it does
   * nothing more, never caught up after (its notification is there; the end-of-hold one covers it).
   */
  private async escalate(now: number) {
    const due = this.escalations().filter((e) => e.at <= now);
    if (!due.length) return;
    const h = this.holdNow(now);
    const ring: ReachOut[] = [];
    let rule: LineRule | null = null;
    for (const e of due) {
      const fresh = this.d.store.reachOut(e.r.key);
      if (fresh?.state !== "untold") continue;
      // One you allowed by voice is by day only: from 23:00 to 07:00 it does nothing more (the tenth reviews).
      if (!this.dayHeldFor(e.rule, now) && h.by === null && !h.weekend && this.notifyFor(e.r.news.itemId) !== "nothing" && this.lineMayRing(false, now)) {
        ring.push(fresh);
        rule ??= e.rule;
      } else this.d.store.attemptDelivery({ key: e.r.key, channel: "escalated", state: "refused", at: now });
    }
    if (ring.length && rule) await this.ringLine(ring, now, { rule: rule.id, via: "rule", ring: false, calls: true, tell: false, urgency: "urgent", from: now, said: rule.made.said });
    for (const r of ring) if (!this.d.store.deliveries(r.key).some((d) => d.channel === "ring")) this.d.store.attemptDelivery({ key: r.key, channel: "escalated", state: "refused", at: now });
  }

  // --- the end of a hold-back (Fable, topic 9) ---

  /**
   * Hold-back stretches ended in the last 12 hours (the night lines', Quiet for a while's) and the next to end: each
   * with its once-only key, its start and end, its title and why. Every night line's stretches (a file may have two:
   * the reviews of 3.4), those that overlap or meet as one night, ending with the last of them, its line the why; keyed
   * by its end's instant, so a night in another zone after flying west is its own.
   */
  private holdEnds(now: number): { past: HeldStretch[]; next: number[] } {
    const past: HeldStretch[] = [];
    const next: number[] = [];
    const zone = this.phoneZone();
    const nights = zone ? this.nightLines() : [];
    if (nights.length && zone) {
      const today = clockOf(now, zone).date;
      const stretches = nights.flatMap((night) => [prevDate(today), today, nextDate(today)].map((date) => {
        const startDate = night.params.from! < night.params.to! ? date : prevDate(date);
        return { night, from: instantOf(startDate, night.params.from!, zone), end: instantOf(date, night.params.to!, zone) };
      })).sort((a, b) => a.from - b.from);
      const merged: typeof stretches = [];
      for (const s of stretches) {
        const last = merged.at(-1);
        if (last && s.from <= last.end) merged[merged.length - 1] = { night: s.end > last.end ? s.night : last.night, from: last.from, end: Math.max(last.end, s.end) };
        else merged.push(s);
      }
      for (const { night, from, end } of merged) {
        if (end > now) next.push(end);
        else if (now - end < HOLD_END_MS && end > night.made.at) past.push({ key: `${night.id}:end:${end}`, from, end, title: "Overnight", why: ruleWhy(night.made.said, privacyOf(this.d.store).names) });
      }
    }
    const q = this.quietOf();
    if (q) {
      if (q.until > now) next.push(q.until);
      else if (now - q.until < HOLD_END_MS) past.push({ key: `quiet-${q.at}:end:${q.until}`, from: q.at, end: q.until, title: "While you were quiet", why: `You were quiet until ${zone ? shownClock(q.until, zone, now) : new Date(q.until).toISOString().slice(11, 16)}.` });
    }
    return { past: past.filter((p) => !this.d.store.deliveries(p.key).length), next };
  }

  /**
   * Each stretch just ended, once (Fable, topic 9): one notification with a sound if anything delivered silently or
   * held in it is still unheard (untold; a question still asked, a computer still offline); else nothing, and it's
   * marked so a restart never sends one. It marks nothing told.
   */
  private async endHolds(now: number) {
    for (const s of this.holdEnds(now).past) {
      // A command still held is told by its own line, never as the question a line made of it (the reviews of pass B2);
      // a send for later's outcome has none here (its notification, or the next call).
      const rs = this.d.store.reachOuts().filter((r) => r.state === "untold" && r.kind !== "brief" && r.kind !== "later" && (r.kind !== "offline" || r.back === undefined)
        && (r.kind === "held" ? !!this.heldOf(r) : !(r.kind === "question" && this.heldOf(r)))
        && this.d.store.deliveries(r.key).some((d) => (d.channel === "notification" || d.channel === "kept" || d.channel === "escalated") && d.at >= s.from && d.at < s.end));
      const phone = this.alertPhone();
      if (!rs.length || !phone || !this.d.notify) {
        this.d.store.attemptDelivery({ key: s.key, channel: "notification", state: "refused", at: now });
        continue;
      }
      if (!this.d.store.attemptDelivery({ key: s.key, channel: "notification", state: "sending", at: now })) continue;
      this.flying.add(`notification\n${s.key}`);
      this.d.log(`engine: ${s.title}: ${rs.length} still unheard`);
      await this.sent([s.key], phone, holdEndNoteOf(rs, { key: s.key, title: s.title, why: s.why, ...privacyOf(this.d.store) }), now);
    }
  }

  // --- time ---

  /**
   * When the engine next has something to do, exactly (§7, "Due means true": the first millisecond it changes something),
   * for the cloud's alarm and the engine's own timer; null for nothing. A reach-out's grace, a permission wait's minute, a
   * batch's close, a missed ring's deadline, news to drop; and the call-back waits' (a thread's start grace, its time
   * running out, a wait's news kept), which its tick looks at. After a tick that threw, no sooner than its backoff (§7,
   * "No hot loops"), so neither the timer nor the alarm runs it again at once; and a time a tick left due, no sooner than
   * its own backoff (`Stuck`), whatever left it. A ring's grace is the Ringer's own.
   */
  due(now = this.clock.now()): number | null {
    const times = this.stuck.hold(this.times(now));
    return times.length ? Math.max(now, this.retryAt, Math.min(...times)) : null;
  }

  /** Every due time as things are now, those already past included, before any backoff. */
  private times(now: number): number[] {
    const times: number[] = [];
    for (const r of this.d.store.reachOuts()) if (r.state === "untold") times.push(r.keepUntil + 1);
    const canRing = !!this.d.ringer?.canRing();
    const inCall = !!this.d.call?.();
    for (const r of this.pending()) {
      // A briefing being made isn't due again until it's made (`makeAhead` looks then) or it's taken too long; one this
      // brain started before it was evicted is due at its grace, as before, to start again.
      const m = this.making.get(r.key);
      if (m) times.push(m.at + MAKE_MS);
      else if (!(canRing && this.ringsFor(r, now))) times.push(this.readyAt(r, inCall, now));
    }
    for (const { d } of this.missedDue()) times.push(d.missedAt!);
    // A watched computer's offline check, and a computer back to tell (stage 3.7).
    times.push(...this.offlineTimes(now));
    // A repeating time's next occurrence (stage 3.8).
    for (const rule of this.everyRules()) {
      const next = this.everyNext(rule, now);
      if (next) times.push(next.at);
    }
    if (this.backsDue(now).length) times.push(now);
    // Away's set time (stage 3.9): it ends then, at the latest.
    const away = this.away();
    if (away) times.push(away.lifetime.at);
    // Your rules (stage 3.4): each question's escalation, and each hold-back's end (one just past, now).
    for (const e of this.escalations()) times.push(e.at);
    // Example 2's 90 s (stage 3.5).
    times.push(...this.idleTimes());
    const ends = this.holdEnds(now);
    times.push(...ends.next);
    if (ends.past.length) times.push(now);
    const waits = this.d.waits.due();
    if (waits !== null) times.push(waits);
    // A handover's window ending (stage 4b), and what became of a send kept for the next call, with a call on now.
    if (this.d.later) times.push(...this.d.later.due());
    if (this.keptLater(now).length) times.push(now);
    // A held command's call-back's not-before (`heldLater`).
    for (const { from } of this.heldLater(now)) if (from > now) times.push(from);
    return times;
  }

  private readonly dueListeners = new Set<() => void>();

  /** Calls `l` whenever what's due may have changed (the cloud sets its alarm from `due`). */
  onDue(l: () => void): () => void {
    this.dueListeners.add(l);
    return () => this.dueListeners.delete(l);
  }

  /**
   * The one timer (§7): looks again when something falls due, while the brain is awake; the cloud's alarm covers a brain
   * that sleeps. With what's due unreadable (the store failing), it tries again after the backoff, which a tick that
   * can't read it either starts or doubles (`turn`).
   */
  private soon() {
    if (this.closed) return;
    for (const l of [...this.dueListeners]) l();
    let at: number | null;
    try {
      at = this.due();
    } catch (e) {
      this.d.log(`engine: couldn't tell what's due (${describe(e)})`);
      at = Math.max(this.clock.now(), this.retryAt);
    }
    if (at === null || at >= this.timerAt) return;
    if (this.timer) this.clock.clear(this.timer);
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.tick();
    }, Math.max(0, at - this.clock.now()) + 50);
    this.timer.unref();
  }

  /**
   * Stops its timer and looks no more: a demo world being thrown away (demo/world.ts), whose store the next demo's
   * takes over in the cloud.
   */
  close() {
    this.closed = true;
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
  }

  /** Deliveries, for tests and History. */
  deliveries(key?: string): Delivery[] {
    return this.d.store.deliveries(key);
  }
}

/**
 * A call-back's news that isn't a reply, as a live call is told it (`StatusFact`), or undefined for a reply or a question:
 * a check-in's standing, the threads still working when a watch or a deadline ran out (with how many were done, from
 * one), a failed or stopped run. A thread that held a command for the user then is told by its hold's line as it is now
 * (`heldLine`, Engine's; Fable's ruling on pass B1's review), and as still working once it holds none.
 */
function statusOf(n: News, heldLine: (itemId: string) => string | null): StatusFact | undefined {
  const count = (done: number, total: number) => (total > 1 && done > 0 ? { done: { done, total } } : {});
  const held = (itemId: string) => {
    const said = heldLine(itemId);
    return said ? { state: "held" as const, said } : null;
  };
  if (n.check) {
    const waited = n.check.waitedMs ? spokenLength(n.check.waitedMs) : undefined;
    const lines = n.check.standing.map((t) => {
      const h = t.state === "held" && !t.offline ? held(t.itemId) : null;
      const state = t.state === "held" ? "working" : t.state;
      return h ? { handle: t.handle, ...h } : { handle: t.handle, state, ...(t.offline ? { offline: t.offline } : state === "working" && waited ? { waited } : {}) };
    });
    return { lines, ...count(n.check.standing.filter((t) => t.state === "replied" || t.state === "failed" || t.state === "stopped").length, n.check.total) };
  }
  if (n.still) {
    const off = new Map(n.still.offline?.map((x) => [x.handle, x.machine]));
    // Done since a deadline it missed, looked at late: told as done (the fourth review of 3.6 to 3.8).
    const late = new Set(n.still.late);
    const holding = new Map(n.still.held?.map((x) => [x.handle, x.itemId]));
    return {
      lines: n.still.working.map((handle) => {
        const h = holding.has(handle) && !late.has(handle) && !off.has(handle) ? held(holding.get(handle)!) : null;
        return late.has(handle) ? { handle, state: "replied" as const } : h ? { handle, ...h } : { handle, state: "working" as const, ...(off.has(handle) ? { offline: off.get(handle)! } : { waited: spokenLength(n.still!.waitedMs) }) };
      }),
      ...count(n.still.done, n.still.total),
    };
  }
  return n.status ? { lines: [{ handle: n.handle, state: n.status }] } : undefined;
}

/** How a thread stood at its check-in, as its news keeps it (stage 3.8), from its outcome then (waits.ts `standing`). */
function standingOf(r: Wait["replies"][number]): Standing {
  if (r.outcome === "timed out") return r.held ? "held" : "working";
  if (r.outcome === "failed") return r.stopped ? "stopped" : "failed";
  if (r.outcome === "question") return "asks";
  return r.outcome === "never started" ? "idle" : "replied";
}

/**
 * A question's words for its notification (docs/launch/engine.md §11, stage 2), and its own options as its work system
 * lists them (`Report.choices`). One the work system holds with options is in the agent's own words, the question its
 * buttons answer (reach.ts `heldAsk`), whatever its card says. Only without those is it its card's ask, from the thread
 * read now (its card made if it's behind: one classifier call, background spend inside the account's limit). Either is
 * shown only masked and naming no provider (reach.ts `askShown`).
 */
export function questionReader(briefing: { refresh(ids?: string[], summarize?: boolean): Promise<void> }, adapter: Pick<Adapter, "report">, store: Pick<Store, "cards">) {
  return async (itemId: string): Promise<{ ask: string | null; choices: string[] | null }> => {
    const rep = await adapter.report(itemId).catch(() => null);
    const own = heldAsk(rep?.question, rep?.choices);
    if (own) return { ask: own, choices: rep!.choices! };
    await briefing.refresh([itemId], true).catch(() => {});
    const card = store.cards().find((c) => c.itemId === itemId);
    return { ask: card?.ask ?? null, choices: rep?.choices ?? null };
  };
}
