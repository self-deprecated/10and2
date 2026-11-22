// Sends and starts set up for later (docs/launch/engine.md §5, "Sends and starts for later: held and run by the computer";
// §11 stage 4b; Jordan's answer 4): the yes is given now, in a call or with a tap, and the brain hands the send or start to
// the computer it targets in the same step. That computer's connector keeps it, runs it at its time under its own policy
// and checks, and says what happened in its view; the brain tells you. The cloud never fires one.
//
// A rule of its own in table `rules` (`R-later-<proposal>`), one schedule per thread (or one for a start), each a
// target with its computer and what the brain last knew of it. Each computer's set is worked out from the store each time
// it goes, with the account's next `seq` (it only goes up, across restarts and restores: at least the clock's ms), one at
// a time per wire: at every link (its handshake ends with it, sent even when it's empty), after a yes or a Stop, and at a
// report while it's refused or behind. A set lost on the wire closed it (connector-client.ts), so the reconnect's first
// set decides: Stop always wins, since a computer fires nothing until a set on its link was applied.
//
// What it holds comes back in each set's answer and each report of its view; an outcome (sent, missed, not sent, not
// known) is read once into a reach-out (`<schedule>:done`, kind `later`) the engine tells, the words go to Drafts when
// it didn't go, and a start's new thread is followed, titled and named as one started in a call is (`afterStart`). A
// handover still waiting for its computer at the end of its window is the brain's one due time: missed, and told.
//
// Chains (4-J; Fable's decisions binding for words): "when Schema's done, tell API to rebase, and call me when that's
// done" is a rule of its own, one target per step, each with the thread it waits for. A step whose thread is on the
// computer it goes to is handed over at once as `after` (spike/relay's clean finish, judged there); one whose thread is on
// another computer is judged here, at each report and at its own looks, and handed over as due now once it finished.
// Each step after the first is armed when the one before went, with that computer's `Held.after` as its baseline; the
// tail ("call me when that's done") is a call-back started then, on the last step's thread, ringing only as Call me back
// allows. A step not sent drops the rest, and the tail with it.
import { createHash, randomUUID } from "node:crypto";
import type { Action, Adapter, Held, LaterLink, LaunchProfile, Report, Schedule, SetAnswer, WorkItem } from "./adapter.ts";
import { newThreadTarget } from "./drafts.ts";
import { followNewOf } from "./follow.ts";
import { keyWords, nameKey } from "./handles.ts";
import { LIMITS, type Limits } from "./levels.ts";
import {
  clockOff, computerOf, forRest, hasIt, LATER_MOST, LATER_NONE, laterFull, notBack, offlineGoes, offlineNotSent, rulesOff, scheduledLine, sendSentence, startSentence, startsOff,
  notStarted, notSetUpWaiting, offlineNotStarted, stoppedOfflineStart, stoppedWontStart, wentOffline,
  LATER_NO_COMPUTER, notFound, STOPPING, stoppedMaybeSent, stoppedOffline, TOO_LATE, tooLateSentence, tooMuchAccess, tooOld, updateToSend, VIA_SAID, waitingApp, waitingFree, waitingOn, waitingOnline,
  bareHour, laterSentence, manyFor, manyWaiting, NOTHING_WAITING, nothingSentTo, notTaken, reasonSaid, roomLeft, spokenPast, STOPPED_START, moreWaiting, stoppedMaybeSaid, stoppedOneOf, stoppedRestMaybe,
  stoppedRestWont, stoppedSend, stoppedWont, stoppingRest, STOPPING_NOW, notWaiting, stillWaiting, stillWaitingCount, stoppedMaybeTo, stoppedWontTo, stoppingTo, threadsNamed, tooLateFor, tooLateMaybe, tooLateSaid, tooLateStopped, tooLateStopping, tooLateWaiting, tooLateWont, whichOne,
  whichThread, whichTimes, type Handed, type LaterSaid,
  CHAIN_LONGER, CHAIN_MOST, CHAIN_WHYS, chainDid, chainRoom, chainScheduledLine, chainSentence, chainStartSentence, chainsOne, justFinished, moreSteps, thenLine, type ChainWhy, type Tail,
} from "./later-lines.ts";
import { NEWS_MS, type Duty, type ReachOut } from "./reach.ts";
import { trackChange } from "./proposals.ts";
import type { Track } from "./analytics.ts";
import { possessive } from "./receipts.ts";
import { phoneZoneIn } from "./ring.ts";
import type { Proposal, Store } from "./store.ts";
import { keptName } from "./thread-models.ts";
import { describe, realClock, type Clock, type Timer } from "./util.ts";
import type { Waits } from "./waits.ts";
import { clockOf, nextDate, parseClock, shownClock, spokenClock, type Heard } from "./zone.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The rules' ids. */
export const LATER_PREFIX = "R-later-";
/** A computer asleep or busy at the time sends it late up to this long after (spike/timed-send's window). */
export const WINDOW_MS = 2 * HOUR;
/** The furthest ahead one may be set up: 3 days. */
export const AHEAD_MS = 72 * HOUR;
/** How long the yes waits for the computer's answer before it's said: "Scheduled." alone when it didn't come. */
export const ANSWER_MS = 3000;
/** A Stop that came too late stays in Watching this long, saying so. */
export const TOO_LATE_SHOWN_MS = 10 * MIN;
/** A rule whose every schedule is over is kept this long for the Timeline. */
export const KEPT_MS = 7 * 24 * HOUR;
/**
 * A thread judged here whose reply couldn't be read is looked at again after this, doubling each time up to `LOOK_MAX_MS`
 * (the reviews of 4-J: nothing else may come to judge it again), and every one is looked at once more this long before its
 * watch ends, so "still working" is never said of a finish no report brought.
 */
const LOOK_MS = MIN;
const LOOK_MAX_MS = 15 * MIN;
const LAST_LOOK_MS = MIN;
/** For this long after this brain sent a thread a follow-up, a view that doesn't show that run yet may only lag (`viewLags`). */
export const SENT_MS = 30_000;
/** How long a stop by voice waits for its computers' answer before "Stopping it now." (Fable's 4-E). */
export const STOP_SAID_MS = 5000;
/** A send that went this recently, asked to stop by voice, is "Too late: it went…" rather than nothing waiting. */
export const TOO_LATE_SAID_MS = HOUR;
const SYNC_KEY = "later_sync";
const SEQ_KEY = "later_seq";

/**
 * What became of one schedule, as a reach-out tells it (kind `later`; later-lines.ts): sent, missed past its window
 * (`code` "never": its computer never took it), not sent by its computer's checks, or not known; with its words, a
 * start's title and project, its computer, how many the account has, when it was due and when it went, why (`code`,
 * the work system's name in `app`), the end of its window, the words kept in Drafts (`kept`), a start's new thread.
 */
export type Fact = {
  outcome: "sent" | "missed" | "not_sent" | "unknown";
  start: boolean;
  words: string;
  title?: string | null;
  project?: string;
  machine: string;
  computers: number;
  at: number;
  firedAt?: number;
  code?: string;
  app?: string;
  until: number;
  kept?: string;
  newItem?: string;
  rule: string;
  /** A chain's step (4-J): the thread it waited for, as named, and how long it watched in all (its "still working" line). */
  after?: string;
  watchMs?: number;
  /**
   * The computer of the thread it waited for, its view not loaded at the watch's end (`code` "unseen"): offline, "Prism was
   * offline, so I couldn't tell when Build finished"; linked with its work app (`app`) not connected, "T3 Code wasn't
   * running on Prism, so …".
   */
  afterOn?: string;
};

/**
 * One schedule of a rule: its id (the computer's Ledger key), its computer as said and the prefix its ids carry there,
 * the thread it's for (a send's, as the brain names it; none for a start), what the thread was like at the yes, and what
 * the brain last knew of it: not yet held by its computer (`pending`), held, refused there (its row in `held`), or over
 * (`done`: what became of it, and when the brain knew).
 */
export type LaterTarget = {
  id: string;
  machine: string;
  prefix: string;
  itemId: string | null;
  handle: string;
  group?: string;
  guard: Schedule["guard"];
  state: "pending" | "held" | "refused" | "done";
  held?: Held;
  /**
   * A chain's step (4-J): the thread it waits for (its id, its name, and the run it was on: a later run's clean finish is
   * the trigger), its own words, the time it mustn't go before (the first step's), whether it's armed (the first, or the
   * step before it went), whether the brain judges its trigger (`cross`: that thread is on another computer than this
   * step goes to) and when it saw it finish (`met`), from when it's handed over as due now; one judged here, when the brain
   * looks at it again without waiting for a report (`look`: its reply couldn't be read, a follow-up just sent, or its watch
   * about to end), how many looks in a row couldn't read its reply (`looks`), the follow-up this brain sent that thread
   * just before the yes (`sent`), and from its last look on, when it was judged and whether its computer's view was
   * loaded then (`judged`, `seen`: what its end is told from).
   */
  step?: {
    after: { itemId: string; handle: string; lastRunAt: string | null }; message: string; notBefore?: number; armed: boolean; cross?: boolean; met?: number;
    look?: number; looks?: number; sent?: JustSent; judged?: number; seen?: boolean;
  };
  done?: {
    state: "sent" | "not_sent" | "missed" | "unknown" | "cancelled"; at: number; code?: string; app?: string; firedAt?: number; newItem?: string;
    /** A chain's step: the target as it was when it went (`Held.after`, the next step's baseline), and when its trigger was met (`Held.at`). */
    after?: Held["after"]; met?: number;
    /**
     * A chain's step judged here, not sent because the view of the computer of the thread it waited for wasn't loaded
     * (`code` "unseen"): that computer, none when no link names it; its work app's name when it was linked (`app`).
     */
    on?: string;
    /**
     * Cancelled by the brain alone (`finish`): stopped, and its window over before its computer said what became of it.
     * Its computer may have sent it first (it was offline since), so what it says when it's back is still read (`read`).
     */
    assumed?: true;
  };
};

/**
 * A send or a start set up for later: who agreed and how (`via`: a spoken yes, a tap, a tap with Face ID), in which
 * conversation and from which proposal; the words, or the start's place, title and the profile agreed (whole: never a
 * name looked up when it fires); when it's due, the end of its window, the phone's zone at the yes; its schedules; and
 * when Stop was asked.
 */
export type LaterRule = {
  /** 1 for a send or a start at a time (stage 4b); 2 for a chain (4-J), which a brain from before chains leaves as it is. */
  v: 1 | 2;
  kind: "later";
  id: string;
  made: { at: number; via: "voice" | "tap" | "faceid"; conversationId: string; proposalId: string; said: string };
  send?: { message: string };
  /**
   * `model`: the one chosen for it (thread-model.md), sent by id; in Drafts if it didn't start, as an untapped start is
   * kept: by its name when the user said it (`keptName`), else as Settings' default, its name and provider.
   */
  start?: { placeId: string; place: string; project: string; title: string | null; message: string; profile: LaunchProfile; model?: NonNullable<Proposal["fields"]["model"]> };
  at: number;
  until: number;
  zone: string;
  targets: LaterTarget[];
  stopped?: number;
  /**
   * A chain (4-J): its targets are its steps, in order, each with `step`. How long it watches in all (the level's, said in
   * its readback: every step's end is `at` plus it), and its tail ("and call me when that's done") as it was agreed to.
   */
  chain?: { watchMs: number; tail: Tail | null; tailed?: number };
};

const STATES = ["pending", "held", "refused", "done"];
/**
 * A rule this version reads. A chain is `v: 2` (the review of 4-J): a brain from before chains reads only `v: 1` and
 * would hand every step over at the yes's time with the first step's words, so it leaves a chain as it is instead.
 */
export function validLater(x: unknown): x is LaterRule {
  const r = x as LaterRule;
  return !!r && typeof r === "object" && (r.chain === undefined ? r.v === 1 : r.v === 2) && r.kind === "later" && typeof r.id === "string" && r.id.startsWith(LATER_PREFIX) &&
    !!r.made && typeof r.made.at === "number" && typeof r.made.conversationId === "string" && Number.isFinite(r.at) && Number.isFinite(r.until) &&
    typeof r.zone === "string" && (!!r.send !== !!r.start) && Array.isArray(r.targets) && r.targets.length > 0 &&
    r.targets.every((t) => t && typeof t.id === "string" && typeof t.machine === "string" && typeof t.prefix === "string" && STATES.includes(t.state) && !!t.guard
      && (t.step === undefined || (!!t.step.after && typeof t.step.after.itemId === "string" && typeof t.step.message === "string" && typeof t.step.armed === "boolean"))) &&
    (r.chain === undefined || (Number.isFinite(r.chain.watchMs) && r.targets.every((t) => !!t.step)));
}

/**
 * A reply whose last paragraph asks something ("Should I drop the old column?"): not a clean finish (spike/relay; the
 * connector's `endsAsking`, the same words).
 */
export function endsAsking(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).at(-1) ?? "";
  return /\?[\s"'”’)*_`]*(?:\s|$)/.test(last);
}

/**
 * A follow-up this brain sent a thread, and the thread as its view showed it then (the reviews of 4-J): when, whether it
 * was asking and which question (the one the send answered), and its status.
 */
export type JustSent = { at: number; asking: boolean; questionId: string | null; status: WorkItem["status"] };

/**
 * Whether thread `a`'s view may only not show yet the run follow-up `s` started, so it's at work: within `SENT_MS` of it,
 * no run finished since, asking nothing or only the question it answered, and not failed or stopped since (the reviews of
 * 4-J: a new question, or a Stop, after the send keeps its verdict).
 */
export function viewLags(a: WorkItem, s: JustSent | null | undefined, now: number): boolean {
  if (!s || now - s.at > SENT_MS) return false;
  if (a.lastRunAt && Date.parse(a.lastRunAt) >= s.at) return false;
  if (a.pendingQuestion && !(s.asking && (a.questionId ?? null) === s.questionId)) return false;
  return !((a.status === "failed" || a.status === "cancelled") && a.status !== s.status);
}

/** Subagents at work, or one that finished after its parent's last run, which it's about to answer (spike/relay). */
const SUBAGENT_MS = 3 * 60_000;
function subagentsBusy(item: WorkItem, items: WorkItem[], now: number): boolean {
  const last = item.lastRunAt ? Date.parse(item.lastRunAt) : 0;
  return items.some((c) => {
    if (c.parentId !== item.id || c.settled) return false;
    const done = c.lastRunAt ? Date.parse(c.lastRunAt) : 0;
    return c.status === "running" || (done > last && now - done < SUBAGENT_MS);
  });
}

/** At work now: running, or its subagents are (a chain on it has a finish to wait for; Fable's review of 4-J). */
export const runningNow = (a: WorkItem, items: WorkItem[], now: number) => a.status === "running" || subagentsBusy(a, items, now);
/** A run of `a` past `baseline` (its run when the chain was asked for; null: any run). */
export const ranSince = (a: WorkItem, baseline: string | null) => !!a.lastRunAt && (baseline === null || Date.parse(a.lastRunAt) > Date.parse(baseline));

/**
 * Whether the computer holding `itemId` has a view loaded with its work system connected, so a thread missing from it is
 * gone; not yet linked since the brain started, or its work app not loaded yet, it's only not known (the review of 4-J).
 */
export function listedOn(adapter: Partial<Pick<Adapter, "connected">>, itemId: string): boolean {
  try {
    return adapter.connected?.(itemId) ?? true;
  } catch {
    return false;
  }
}

/** The work system holding `itemId` by its own name ("T3 Code"), as its computer last said, or null. */
function appOn(adapter: Partial<Pick<Adapter, "appOf">>, itemId: string): string | null {
  try {
    return adapter.appOf?.(itemId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether thread `a` finished cleanly since `baseline` (its run then), as the connector judges a chain on its own
 * computer (spike/relay's clean finish): a run past it, not running, no subagent busy, not failed or stopped, no question,
 * and its reply not ending in one. "met", what ends the chain (`ChainWhy`), or "working" for not yet. Judged here, across
 * a link (the reviews of 4-J): missing while its computer's view isn't loaded (`listed` false) isn't gone ("working"), and
 * a reply that can't be read isn't a clean finish ("unread": looked at again in a minute, then less often). Sent a
 * follow-up by this brain while its status was `was`, a failure or a Stop since counts though its view moved no run
 * (Fable's review of 4-J).
 */
export async function finishedSince(a: WorkItem | undefined, baseline: string | null, items: WorkItem[], now: number, report?: (id: string) => Promise<Report | null>, listed = true, was?: WorkItem["status"]): Promise<"met" | "unread" | ChainWhy> {
  if (!a) return listed ? "vanished" : "working";
  if (a.settled) return "vanished";
  if (a.pendingQuestion) return "asked";
  if (a.status === "running") return "working";
  const since = ranSince(a, baseline) || (was !== undefined && a.status !== was);
  if (since && a.status === "failed") return "failed";
  if (since && a.status === "cancelled") return "stopped";
  if (!ranSince(a, baseline)) return "working";
  if (subagentsBusy(a, items, now)) return "working";
  let rep: Report | null = null;
  try {
    rep = (await report?.(a.id)) ?? null;
  } catch {
    return "unread";
  }
  if (rep && (rep.question || endsAsking(typeof rep.text === "string" ? rep.text : ""))) return "asked";
  return "met";
}

/** One sync state per computer, kept so a brain woken from hibernation knows: the last set it applied, and a refusal. */
type Sync = { hash: string | null; refused: { code: "clock" | "stale"; minutes?: number; error: string } | null };

/**
 * A row of Watching for a rule (engine.ts `Watching`): no time left (`timed`), no Stop (`stop` false), greyed (`grey`),
 * stopped and waiting for its computer's answer (`stopping`: the phone reads Watching again until it comes, 4-E).
 */
export type LaterRow = { id: string; said: string; note?: string; leftMs: number; until: number; ring: false; wouldRing: false; timed?: true; stop?: false; grey?: true; stopping?: true };

export type LaterDeps = {
  store: Store;
  adapter: Pick<Adapter, "list"> & Partial<Pick<Adapter, "laterLinks" | "watchLater" | "timeZone" | "connectionStatus" | "report" | "connected" | "appOf">>;
  log: (m: string) => void;
  clock?: Clock;
  limits?: () => Limits;
  /** The call-backs, for a chain's tail ("and call me when that's done"), started once its last step went. */
  waits?: Pick<Waits, "start" | "get">;
  /** A start's new thread, once it's known (the briefing names it): the work system's name for it, or none. */
  started?: (itemId: string, started: { title: string; group: string }) => Promise<string | null | void>;
  /** Analytics: a send or a start its computer made at its time is `reply_sent` with `via: "rule"` (contracts §5). */
  track?: Track;
};

const MODES: LaunchProfile["runtimeMode"][] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | undefined) => (s ? Date.parse(s) : NaN);

/** A schedule's words: a chain's step's own, else its rule's. */
const wordsOf = (rule: LaterRule, t: LaterTarget) => t.step?.message ?? rule.send?.message ?? rule.start!.message;
/** When a chain's step judged here goes: once its thread finished, not before its time. */
const dueOf = (t: LaterTarget) => Math.max(t.step!.met!, t.step!.notBefore ?? 0);
/**
 * The end of a schedule's window: its rule's (a chain's watch), or for a chain's step judged here and met, 2 hours from
 * when it's due, as any schedule due now (§5: a sleeping target gets it when it wakes).
 */
export const endOf = (rule: LaterRule, t: LaterTarget) => (t.step?.cross && t.step.met !== undefined ? dueOf(t) + WINDOW_MS : rule.until);
/** A chain's step no computer holds yet: waiting for the step before it, or judged here and not yet finished. */
const unheld = (t: LaterTarget) => !!t.step && (!t.step.armed || (!!t.step.cross && t.step.met === undefined));
/** A chain's step the brain judges (its thread on another computer), armed, not over and not yet finished. */
const watchedHere = (t: LaterTarget) => t.state !== "done" && !!t.step?.armed && !!t.step.cross && t.step.met === undefined;
/** A chain's step on now: the first not over. */
const current = (rule: LaterRule) => rule.targets.find((t) => t.state !== "done") ?? rule.targets.at(-1)!;
/** The threads a chain's steps wait for, as the brain names them: what a stop by voice may name it by (4-E). */
const afterNames = (rule: LaterRule) => rule.targets.flatMap((t) => (t.step ? [t.step.after.handle] : []));

/**
 * What 10 & 2 does once it has started a thread (moved from `Proposals.start`, shared with a start set up for later): its
 * first message and when it started kept for its purpose, named in the conversation by its title and as "your new thread
 * in <project>" (none for a tap), followed unless Follow new threads is Never, and the briefing told, which gives the work
 * system's name for it once it lists it.
 */
export async function afterStart(
  d: { store: Store; started?: LaterDeps["started"]; log?: (m: string) => void },
  o: { itemId: string; title: string | null; place: string; message: string; conversationId: string | null; at: number },
): Promise<{ follows: boolean; called: string | null }> {
  const follows = followNewOf(d.store).choice !== "never";
  d.store.saveFirstAsk(o.itemId, { text: o.message, at: new Date(o.at).toISOString(), complete: true }, o.at);
  const project = o.place.replace(/, on [\w-]+$/, "");
  const newName = (p: string) => `your new thread in ${p}`;
  const names = [...(o.title ? [o.title] : []), ...[newName(o.place), newName(project)].flatMap((n) => [n, n.replace(/^your /, "")])];
  if (o.conversationId) for (const n of new Set([...names, "new thread", "your new thread"])) d.store.alias(o.conversationId, nameKey(n), o.itemId);
  if (follows) {
    d.store.star(o.itemId, true, undefined, o.at);
    d.store.setThreadNotify(o.itemId, "both", o.at);
  }
  const called = (await d.started?.(o.itemId, { title: o.title ?? "Your new thread", group: o.place }).catch((e) => d.log?.(`couldn't list the new thread ${o.itemId} (${describe(e)})`))) || null;
  if (called && o.conversationId) d.store.alias(o.conversationId, nameKey(called), o.itemId);
  return { follows, called };
}

export class Later {
  private readonly d: LaterDeps;
  private readonly clock: Clock;
  private readonly news = new Set<() => void>();
  /** Each computer's set under way (one at a time per wire), and whether another must follow it. */
  private readonly syncing = new Map<string, { running: Promise<SetAnswer | null>; again: boolean }>();

  constructor(d: LaterDeps) {
    this.d = d;
    this.clock = d.clock ?? realClock;
    d.adapter.watchLater?.((link, why) => void this.heard(link, why).catch((e) => d.log(`later: ${link.machine}: ${describe(e)}`)));
    // A brain started again, or woken from hibernation with its links still up: a set that changed meanwhile goes now.
    queueMicrotask(() => {
      for (const link of this.links()) if (link.linked()) void this.behind(link).catch((e) => d.log(`later: ${link.machine}: ${describe(e)}`));
    });
  }

  /** Calls `l` when an outcome was written for the engine to tell, or what's due changed. */
  onNews(l: () => void): () => void {
    this.news.add(l);
    return () => this.news.delete(l);
  }
  private told() {
    for (const l of [...this.news]) l();
  }

  private now() {
    return this.clock.now();
  }

  private links(): LaterLink[] {
    return this.d.adapter.laterLinks?.() ?? [];
  }

  /** How many computers the account has (a computer is named only when there's more than one). */
  computers(): number {
    return this.d.adapter.connectionStatus?.().length || this.links().length || 1;
  }

  /** The computer holding a thread or a place, by its id: the one whose prefix it carries, else the brain's own. */
  linkOf(id: string): LaterLink | null {
    const links = this.links();
    return links.find((l) => l.prefix && id.startsWith(l.prefix)) ?? links.find((l) => !l.prefix) ?? null;
  }

  /** Every rule this version reads; anything else in the table is left as it is. */
  rules(): LaterRule[] {
    return laterRules(this.d.store);
  }

  /** The Timeline's lines (`laterTimeline`). */
  timeline(): { key: string; at: number; text: string }[] {
    return laterTimeline(this.d.store, this.computers());
  }

  private save(rule: LaterRule) {
    this.d.store.saveRule(rule.id, rule);
  }

  /** Each schedule still waiting (not stopped, not over): what the level counts. */
  waiting(): { rule: LaterRule; target: LaterTarget }[] {
    return this.rules().filter((r) => !r.stopped).flatMap((rule) => rule.targets.filter((t) => t.state !== "done").map((target) => ({ rule, target })));
  }

  private zone(rule?: LaterRule): string {
    return phoneZoneIn(this.d.store) ?? rule?.zone ?? "UTC";
  }

  // --- set up (4-A to 4-C) ---

  /**
   * Why this can't be set up, as a fixed line said instead of the readback (Fable's 4-C), or null: the level (none, its
   * one or 20 already waiting, more threads than it has room for), then each computer (too old, set not to, a start where
   * it only sends, more access than it allows a start later, or its own refusal of the action).
   */
  refusal(o: { actions: Action[]; ids: string[]; steps?: number }): { line: string; asked?: string } | { error: string } | null {
    const limits = this.d.limits?.() ?? LIMITS["Long Haul"];
    const room = limits.laterSends;
    if (room <= 0) return { line: LATER_NONE };
    // A chain (4-J): none on Commute's limits, one step on Road Trip's, three on Long Haul's; each step also waits as a send.
    if (o.steps !== undefined) {
      if (limits.chain <= 0) return { line: LATER_NONE };
      if (o.steps > limits.chain) return limits.chain === 1 ? { line: chainsOne(limits.named), asked: CHAIN_LONGER } : { line: CHAIN_MOST };
    }
    const waiting = this.waiting();
    if (waiting.length >= room) {
      if (room === 1) {
        const w = waiting[0];
        const hour = bareHour(w.rule.at, this.zone(w.rule));
        const words = wordsOf(w.rule, w.target);
        return {
          line: laterFull(limits.named, { words, to: w.rule.start ? `a new thread in ${w.rule.start.project}` : w.target.handle, hour, ...(w.target.step ? { after: w.target.step.after.handle } : {}) }),
          asked: "Long Haul holds 20.",
        };
      }
      return { line: LATER_MOST };
    }
    if (o.ids.length > room - waiting.length) {
      // A chain asks which steps, not which thread (the skeptic's nit).
      if (room > 1 && o.steps !== undefined) return { line: chainRoom(waiting.length, room) };
      return room === 1 ? { line: whichThread(limits.named) } : { line: roomLeft(waiting.length, room) };
    }
    const computers = this.computers();
    for (const [i, id] of o.ids.entries()) {
      const link = this.linkOf(id);
      const action = o.actions[i];
      if (!link) return { line: LATER_NO_COMPUTER };
      if (!link.tool) return { line: tooOld(link.machine, computers) };
      if (link.rules === "off") return { line: rulesOff(link.machine, computers) };
      if (action.kind === "start_work") {
        if (link.rules !== "start") return { line: startsOff(link.machine, computers) };
        if (MODES.indexOf(action.profile.runtimeMode) > MODES.indexOf(link.ceiling)) return { line: tooMuchAccess(link.machine, computers) };
      }
      const local = this.local(action, link);
      const no = link.allows(local);
      if (no) return { error: no };
    }
    return null;
  }

  /** An action with its ids as its computer knows them. */
  private local(action: Action, link: LaterLink): Action {
    const strip = (id: string) => (link.prefix && id.startsWith(link.prefix) ? id.slice(link.prefix.length) : id);
    return action.kind === "start_work" ? { ...action, placeId: strip(action.placeId) } : action.kind === "follow_up" ? { ...action, itemId: strip(action.itemId) } : action;
  }

  /**
   * The yes (4-A): the rule written with each of its schedules waiting for its computer, then handed over at once. Waits
   * up to `ANSWER_MS` for the computers' answers, and gives what's said after the yes, word for word. A send's thread not
   * in the list at the yes (gone, or the list unreadable), a chain's step's too, sets nothing up (`refused`, said word for
   * word): its guard would have nothing to compare with, and a thread that ever ran would read as run again. A chain (4-J,
   * `chain`): the thread its first step waits for (with its run at the readback), the steps after it, the tail and how long
   * it watches; its first step goes to its computer at once, as `after`, unless that thread is on another computer, which
   * the brain watches. `finished`: that thread finished cleanly during the readback, so the step is due now (one judged
   * here is met at once), and what's said is `justFinished` by how its computer took it. `sent`: this brain sent that
   * thread a follow-up just before (a step judged here keeps it, so its view lagging isn't read as a question or a stop).
   */
  async make(o: {
    proposalId: string; conversationId: string; via: LaterRule["made"]["via"]; at: number; zone: string; said: string;
    send?: { message: string; targets: { itemId: string; handle: string; group?: string }[] };
    start?: { placeId: string; place: string; title: string | null; message: string; profile: LaunchProfile; model?: NonNullable<Proposal["fields"]["model"]> };
    chain?: {
      after: { itemId: string; handle: string; lastRunAt: string | null }; notBefore?: number; next: { itemId: string; handle: string; group?: string; message: string }[]; tail: Tail | null; watchMs: number;
      finished?: boolean; sent?: JustSent;
    };
  }, write: (rule: LaterRule) => void): Promise<{ rule: LaterRule; line: string } | { refused: string }> {
    const now = this.now();
    const items = new Map((await this.d.adapter.list().catch(() => [] as WorkItem[])).map((i) => [i.id, i]));
    const missing = [...(o.send?.targets ?? []), ...(o.chain?.next ?? [])].find((t) => !items.has(t.itemId));
    if (missing) return { refused: notFound(missing.handle) };
    const id = `${LATER_PREFIX}${o.proposalId}`;
    // A first step judged here: the follow-up just sent, and its last look a minute before its watch ends, set as it's
    // written, so neither waits on a judge that can list the threads (the skeptic's review of 4-J).
    const judged = (cross: boolean, c: NonNullable<typeof o.chain>) =>
      !cross ? {} : c.finished ? { met: now } : { look: now + c.watchMs - LAST_LOOK_MS, ...(c.sent ? { sent: c.sent } : {}) };
    const guard = (item?: WorkItem): Schedule["guard"] => ({
      agreedAt: iso(now), running: item?.status === "running", lastRunAt: item?.lastRunAt ?? null, questionId: item?.pendingQuestion ? (item.questionId ?? null) : null,
    });
    const targets: LaterTarget[] = [];
    const c = o.chain;
    const sends = [...(o.send?.targets ?? []).map((t) => ({ ...t, message: o.send!.message })), ...(c?.next ?? [])];
    // A chain's threads it waits for, so far: a step to one of them expects its run (it's what the chain is waiting on, or
    // an earlier step's), so the run it does isn't "it ran again after you scheduled this".
    const expected = new Set(c ? [c.after.itemId] : []);
    for (const [i, t] of sends.entries()) {
      const link = this.linkOf(t.itemId);
      const local = link?.prefix && t.itemId.startsWith(link.prefix) ? t.itemId.slice(link.prefix.length) : t.itemId;
      const machine = link?.machine ?? "your computer";
      const g = guard(items.get(t.itemId)!);
      let step: LaterTarget["step"];
      if (c) {
        const after = i === 0 ? c.after : { itemId: sends[i - 1].itemId, handle: sends[i - 1].handle, lastRunAt: null };
        if (expected.has(t.itemId)) g.running = true;
        expected.add(t.itemId);
        const cross = i === 0 && this.linkOf(c.after.itemId)?.machine !== machine;
        step = {
          after, message: t.message, armed: i === 0, ...(i === 0 && c.notBefore !== undefined ? { notBefore: c.notBefore } : {}), ...(i === 0 ? { cross, ...judged(cross, c) } : {}),
        };
      }
      targets.push({
        id: `${id}-${c ? i + 1 : 1}:${local}`, machine, prefix: link?.prefix ?? "", itemId: t.itemId, handle: t.handle, ...(t.group !== undefined ? { group: t.group } : {}), guard: g, state: "pending",
        ...(step ? { step } : {}),
      });
    }
    if (o.start) {
      const link = this.linkOf(o.start.placeId);
      const project = o.start.place.replace(/, on [\w-]+$/, "");
      const machine = link?.machine ?? "your computer";
      const cross = !!c && this.linkOf(c.after.itemId)?.machine !== machine;
      const step = c ? { step: { after: c.after, message: o.start.message, armed: true, ...(c.notBefore !== undefined ? { notBefore: c.notBefore } : {}), cross, ...judged(cross, c) } } : {};
      targets.push({ id: `${id}-1:start`, machine, prefix: link?.prefix ?? "", itemId: null, handle: project, guard: guard(), state: "pending", ...step });
    }
    const rule: LaterRule = {
      v: c ? 2 : 1, kind: "later", id, made: { at: now, via: o.via, conversationId: o.conversationId, proposalId: o.proposalId, said: o.said },
      ...(o.send ? { send: { message: o.send.message } } : {}),
      ...(o.start ? { start: { ...o.start, project: o.start.place.replace(/, on [\w-]+$/, "") } } : {}),
      at: o.at, until: c ? now + c.watchMs : o.at + WINDOW_MS, zone: o.zone, targets,
      ...(c ? { chain: { watchMs: c.watchMs, tail: c.tail } } : {}),
    };
    // The rule and the proposal closing, in one transaction (the caller's `write`): nothing goes to the agent now.
    this.d.store.db.transaction(() => {
      this.save(rule);
      write(rule);
    });
    this.d.log(`later: ${id} set up ${c ? `for when ${c.after.handle} finishes` : `for ${iso(o.at)}`} (${targets.length} ${c ? "step" : "schedule"}${targets.length === 1 ? "" : "s"})`);
    this.told();
    // A chain whose thread is on another computer is watched here (`judge`, at each report and link); nothing is handed
    // over until it has finished (at the yes already: met, and handed over below). Judged once now the rule is saved: a
    // finish reported while the yes was under way (a start's title is a model call) found no rule to judge (the skeptic's
    // review of 4-J).
    if (c && targets.some(watchedHere)) void this.judge().catch((e) => this.d.log(`later: ${id}: ${describe(e)}`));
    // Handed to each computer now; the answer, if it comes within 3 s, says how it went.
    const machines = [...new Set(targets.filter((t) => !unheld(t)).map((t) => t.machine))];
    const handed = await Promise.all(machines.map(async (machine): Promise<Handed> => {
      const link = this.links().find((l) => l.machine === machine);
      if (!link || !link.linked()) return { machine, state: "offline" };
      const answer = await Promise.race([this.sync(link), new Promise<"quiet">((r) => this.clock.setTimeout(() => r("quiet"), ANSWER_MS))]);
      if (answer === "quiet" || answer === null || "lost" in answer) return { machine, state: "quiet" };
      if ("refused" in answer) return answer.refused === "clock" ? { machine, state: "clock", minutes: answer.minutes ?? 0 } : { machine, state: "refused" };
      const mine = answer.held.filter((h) => targets.some((t) => t.id === h.id && t.machine === machine));
      return { machine, state: mine.some((h) => h.state === "refused") ? "refused" : mine.length ? "held" : "quiet" };
    }));
    const computers = this.computers();
    let line = c ? chainScheduledLine(handed, computers, c.after.handle) : scheduledLine(handed, computers);
    if (c?.finished) {
      // "Now" only when it truly goes now (Fable's review of 4-J): its computer online and took it, no time ahead.
      const first = targets[0];
      const nb = c.notBefore !== undefined && c.notBefore > now ? spokenClock(c.notBefore, o.zone, now) : null;
      line = justFinished(c.after.handle, o.start ? null : first.handle, handed.find((h) => h.machine === first.machine) ?? null, computers, nb);
    }
    return { rule: this.rules().find((r) => r.id === id) ?? rule, line };
  }

  // --- handing over ---

  private syncs(): Record<string, Sync> {
    try {
      const v = JSON.parse(this.d.store.get(SYNC_KEY) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  private setSync(machine: string, s: Sync) {
    this.d.store.set(SYNC_KEY, JSON.stringify({ ...this.syncs(), [machine]: s }));
  }

  /** The account's next `seq`: one more than the last, and never below the clock's ms, so it goes up across a restore too. */
  private nextSeq(now: number): number {
    const seq = Math.max(Number(this.d.store.get(SEQ_KEY) ?? 0) + 1, now);
    this.d.store.set(SEQ_KEY, String(seq));
    return seq;
  }

  /** Computer `machine`'s whole set as the store has it now: every schedule there not stopped and not over. */
  private setFor(machine: string, now: number): Schedule[] {
    this.finish(now);
    const out: Schedule[] = [];
    for (const rule of this.rules()) {
      if (rule.stopped) continue;
      for (const t of rule.targets) {
        if (t.machine !== machine || t.state === "done" || unheld(t)) continue;
        out.push(this.scheduleOf(rule, t));
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private scheduleOf(rule: LaterRule, t: LaterTarget): Schedule {
    const strip = (id: string) => (t.prefix && id.startsWith(t.prefix) ? id.slice(t.prefix.length) : id);
    const action: Action = rule.start
      ? { kind: "start_work", placeId: strip(rule.start.placeId), ...(rule.start.title ? { title: rule.start.title } : {}), message: rule.start.message, profile: rule.start.profile, ...(rule.start.model ? { model: rule.start.model.id } : {}) }
      : { kind: "follow_up", itemId: strip(t.itemId!), message: wordsOf(rule, t) };
    // A chain's step (4-J): judged on its own computer as `after` (the thread there, and its run it waits past), or here
    // and handed over as due now once its thread finished.
    const s = t.step;
    const when: Schedule["when"] = !s ? { at: iso(rule.at) }
      : s.cross ? { at: iso(dueOf(t)) }
      : { after: { itemId: strip(s.after.itemId), lastRunAt: s.after.lastRunAt }, ...(s.notBefore !== undefined ? { notBefore: iso(s.notBefore) } : {}) };
    return { v: 1, id: t.id, action, when, until: iso(endOf(rule, t)), guard: t.guard, said: rule.made.said.slice(0, 1000), zone: rule.zone };
  }

  private hashOf(set: Schedule[]): string {
    return createHash("sha256").update(JSON.stringify(set)).digest("hex");
  }

  /** A computer linked (its first set is due now, even an empty one) or reported (what it holds is read). */
  private async heard(link: LaterLink, why: "linked" | "report") {
    // A chain's thread on another computer than its step goes to is judged here, at each report (4-J).
    void this.judge().catch((e) => this.d.log(`later: chains: ${describe(e)}`));
    if (why === "linked") {
      await this.sync(link);
      return;
    }
    this.read(link, link.held, null);
    await this.behind(link);
  }

  /** The set goes again when that computer refused the last one, or the store has changed since it applied one. */
  private async behind(link: LaterLink) {
    if (!link.tool || !link.linked()) return;
    const s = this.syncs()[link.machine];
    const set = this.setFor(link.machine, this.now());
    if (s?.refused || s?.hash !== this.hashOf(set)) await this.sync(link);
  }

  /** Hands `link` its whole set, one set at a time per wire; one asked for meanwhile goes after, built from the store then. */
  sync(link: LaterLink): Promise<SetAnswer | null> {
    const busy = this.syncing.get(link.machine);
    if (busy) {
      busy.again = true;
      return busy.running;
    }
    const st = { running: Promise.resolve<SetAnswer | null>(null), again: false };
    st.running = (async () => {
      let last: SetAnswer | null = null;
      do {
        st.again = false;
        last = await this.syncOnce(link);
      } while (st.again);
      return last;
    })().finally(() => this.syncing.delete(link.machine));
    this.syncing.set(link.machine, st);
    return st.running;
  }

  private async syncOnce(link: LaterLink): Promise<SetAnswer | null> {
    if (!link.tool || !link.linked()) return null;
    const now = this.now();
    const set = this.setFor(link.machine, now);
    const answer = await link.set(this.nextSeq(now), set, now);
    if ("lost" in answer) {
      this.d.log(`later: ${link.machine}: its set was lost on the wire; the reconnect's first set decides`);
      return answer;
    }
    if ("refused" in answer) {
      this.setSync(link.machine, { hash: null, refused: { code: answer.refused, ...(answer.minutes !== undefined ? { minutes: answer.minutes } : {}), error: answer.error } });
      this.d.log(`later: ${link.machine} refused its set (${answer.refused}): ${answer.error}`);
      // Refused for its clock, a stopped one it never took is cancelled now, as one refused for its version is (Fable's
      // ruling on the review of 4-E): this link fires nothing until a set on it is applied, and any set from here on
      // leaves it out. (A stale `seq` says nothing of what it holds, so that waits.)
      if (answer.refused === "clock") this.dropUntaken(link.machine, now);
      this.told();
      return answer;
    }
    this.setSync(link.machine, { hash: this.hashOf(set), refused: null });
    this.read(link, answer.held, new Set(set.map((s) => s.id)));
    return answer;
  }

  /** Each stopped rule's schedule on `machine` its computer never took (still pending), cancelled. */
  private dropUntaken(machine: string, now: number) {
    for (const rule of this.rules()) {
      if (!rule.stopped) continue;
      const untaken = rule.targets.filter((t) => t.machine === machine && t.state === "pending");
      for (const t of untaken) this.over(rule, t, { state: "cancelled", at: now });
      if (untaken.length) this.save(rule);
    }
  }

  /**
   * What `link` holds, read into its rules' schedules: held, refused there, or over. `inSet`: the ids of the set it has
   * just applied, whose answer is the whole of what it holds, so a schedule left out of it (stopped) and not there is
   * cancelled; a report of its view says only what it lists. One the brain cancelled alone (`assumed`) is read again:
   * sent, or not known, after all (it went before the Stop reached it) is told once; anything else stays cancelled.
   */
  private read(link: LaterLink, held: Held[], inSet: Set<string> | null) {
    const byId = new Map(held.map((h) => [h.id, h]));
    const now = this.now();
    let news = false;
    for (const rule of this.rules()) {
      let changed = false;
      for (const t of rule.targets) {
        if (t.machine !== link.machine) continue;
        if (t.state === "done") {
          const h = t.done?.assumed ? byId.get(t.id) : undefined;
          if (!h || h.state === "waiting" || h.state === "firing" || h.state === "refused") continue;
          if (h.state === "sent" || h.state === "unknown") {
            this.over(rule, t, this.doneOf(t, h, now));
            news = true;
          } else t.done = { ...t.done!, assumed: undefined };
          changed = true;
          continue;
        }
        const h = byId.get(t.id);
        if (!h) {
          if (inSet && !inSet.has(t.id) && rule.stopped) {
            this.over(rule, t, { state: "cancelled", at: now });
            changed = true;
          }
          continue;
        }
        if (h.state === "waiting" || h.state === "firing" || h.state === "refused") {
          const state = h.state === "refused" ? "refused" : "held";
          if (t.state !== state || JSON.stringify(t.held) !== JSON.stringify(h)) {
            t.state = state;
            t.held = h;
            changed = true;
          }
          continue;
        }
        // Cancelled there though never stopped here (that computer was disconnected from 10 & 2, by `10and2 revoke` or a
        // refused credential, and linked again): it won't go, so it's told once as not sent, "no longer has it" (`dropped`,
        // Fable's nit on fix4: often before its time), its words in Drafts.
        const dropped = h.state === "cancelled" && !rule.stopped;
        const state = dropped ? "not_sent" : h.state;
        const done = this.doneOf(t, h, now);
        this.over(rule, t, dropped ? { ...done, state: "not_sent", code: "dropped" } : done);
        changed = true;
        news ||= state !== "cancelled";
      }
      if (changed) this.save(rule);
    }
    this.onward();
    if (news) this.told();
  }

  /** What its computer said became of a schedule: when it went, why, a start's new thread; a chain's step's baseline and trigger's time. */
  private doneOf(t: LaterTarget, h: Held, now: number): NonNullable<LaterTarget["done"]> {
    const firedAt = ms(h.firedAt);
    const met = ms(h.at);
    return {
      state: h.state as NonNullable<LaterTarget["done"]>["state"], at: now, ...(h.code ? { code: h.code } : {}), ...(h.app ? { app: h.app } : {}), ...(Number.isFinite(firedAt) ? { firedAt } : {}),
      ...(h.receipt?.ok && h.receipt.itemId ? { newItem: `${t.prefix}${h.receipt.itemId}` } : {}),
      ...(t.step && h.after ? { after: h.after } : {}), ...(t.step && Number.isFinite(met) ? { met } : {}),
    };
  }

  /**
   * A schedule over: what became of it kept on the rule (saved by the caller), and unless it was cancelled, its outcome
   * told once (`<schedule>:done`), its words in Drafts when it didn't go (never when not known: it may have), and a
   * start's new thread followed and named.
   */
  private over(rule: LaterRule, t: LaterTarget, done: NonNullable<LaterTarget["done"]>) {
    t.state = "done";
    t.done = done;
    if (done.state === "cancelled") {
      this.d.log(`later: ${t.id} cancelled`);
      return;
    }
    const key = `${t.id}:done`;
    if (this.d.store.reachOut(key)) return;
    const words = wordsOf(rule, t);
    let kept: string | undefined;
    if (done.state === "missed" || done.state === "not_sent") {
      // Its id from the schedule's, so a look that's run again keeps one, not two (`keepReply` replaces by id).
      kept = `K-L${createHash("sha256").update(t.id).digest("hex").slice(0, 16)}`;
      const s = rule.start;
      this.d.store.keepReply(s
        ? { id: kept, threadId: newThreadTarget({ placeId: s.placeId, profile: s.profile.name, ...(!s.model ? {} : s.model.said ? { model: keptName(s.model) } : { defaultModel: s.model.name, defaultProvider: s.model.provider ?? null }) }), threadName: s.place, project: s.place, text: s.message, note: null, draftId: null, conversationId: rule.made.conversationId, keptAt: done.at }
        : { id: kept, threadId: t.itemId!, threadName: t.handle, project: t.group ?? "", text: words, note: null, draftId: null, conversationId: rule.made.conversationId, keptAt: done.at });
    }
    // A chain's step is due when its thread finished (`met`, its computer's or this brain's), not at a time (4-J).
    const at = t.step ? (done.met ?? (t.step.met !== undefined ? dueOf(t) : undefined) ?? done.firedAt ?? done.at) : rule.at;
    const fact: Fact = {
      outcome: done.state, start: !!rule.start, words, ...(rule.start ? { title: rule.start.title, project: rule.start.project } : {}),
      machine: t.machine, computers: this.computers(), at, ...(done.firedAt !== undefined ? { firedAt: done.firedAt } : {}),
      ...(done.code ? { code: done.code } : {}), ...(done.app ? { app: done.app } : {}), until: endOf(rule, t), ...(kept ? { kept } : {}),
      ...(done.newItem ? { newItem: done.newItem } : {}), rule: rule.id,
      ...(t.step ? { after: t.step.after.handle, watchMs: rule.chain?.watchMs ?? 0, ...(done.on ? { afterOn: done.on } : {}) } : {}),
    };
    const duty: Duty = { rule: rule.id, via: "rule", ring: false, tell: false, urgency: "normal", from: done.at };
    const r: ReachOut = {
      v: 1, key, at: done.at, kind: "later", conversationId: rule.made.conversationId,
      news: { itemId: done.newItem ?? t.itemId ?? rule.id, handle: rule.start ? rule.start.project : t.handle, ...(this.computers() > 1 ? { machine: t.machine } : {}), seen: { runAt: 0, question: null }, later: fact },
      duties: [duty], state: "untold", keepUntil: done.at + NEWS_MS,
    };
    this.d.store.saveReachOut(r);
    this.d.log(`later: ${t.id} ${done.state}${done.code ? ` (${done.code})` : ""}`);
    // Sent by a rule (the Timeline's "what rules and computers did"), once, as its outcome is.
    if (done.state === "sent" && this.d.track) trackChange(this.d.track, { state: "executed", action: rule.start ? "start_work" : "follow_up", fields: {}, targets: [] }, "rule");
    // A start's new thread: followed, titled and named as a start in a call is.
    if (rule.start && done.state === "sent" && done.newItem) {
      void afterStart(this.d, { itemId: done.newItem, title: rule.start.title, place: rule.start.place, message: rule.start.message, conversationId: rule.made.conversationId, at: done.firedAt ?? done.at })
        .catch((e) => this.d.log(`later: ${t.id}: after its start (${describe(e)})`));
    }
  }

  // --- chains (4-J) ---

  /**
   * What comes after a chain's step is over, worked out from the store each time, so it's done once whatever reads it
   * (an answer, a report, the brain's own due time, a Stop): a step that went arms the next, with the target as it was
   * when it went as its baseline (`Held.after`), handed to its computer or watched here; the last one that went starts the
   * tail, once; a step not sent (or stopped, or not known) drops the rest, the tail with it, untold.
   */
  private onward() {
    const now = this.now();
    const machines = new Set<string>();
    let watch = false;
    for (const rule of this.rules()) {
      if (!rule.chain) continue;
      let changed = false;
      let ended = false;
      for (const [i, t] of rule.targets.entries()) {
        if (ended && t.state !== "done") {
          t.state = "done";
          t.done = { state: "cancelled", at: now };
          this.d.log(`later: ${t.id} dropped: the step before it wasn't sent`);
          changed = true;
          continue;
        }
        if (t.state !== "done" && rule.stopped && unheld(t)) {
          // Stopped, and no computer holds it: nothing to tell any.
          t.state = "done";
          t.done = { state: "cancelled", at: rule.stopped };
          changed = true;
          continue;
        }
        if (t.state !== "done" || !t.step) continue;
        if (t.done?.state !== "sent") {
          ended = true;
          continue;
        }
        const next = rule.targets[i + 1];
        if (next?.step && !next.step.armed && next.state !== "done" && !rule.stopped) {
          next.step.armed = true;
          next.step.after.lastRunAt = t.done.after?.lastRunAt ?? null;
          next.step.cross = t.machine !== next.machine;
          this.d.log(`later: ${next.id} armed: ${t.handle} has its message`);
          if (next.step.cross) {
            // Its last look, a minute before its watch ends, whether or not a judge can list the threads now.
            next.step.look = rule.until - LAST_LOOK_MS;
            watch = true;
          } else machines.add(next.machine);
          changed = true;
        }
        if (!next && rule.chain.tail && !rule.chain.tailed && !rule.stopped) {
          // Marked as started only once its call-back is (`tail`), so a restart or a throw before then starts it at the next look.
          void this.tail(rule.id, t.id).catch((e) => this.d.log(`later: ${t.id}: its call-back (${describe(e)})`));
        }
      }
      if (changed) this.save(rule);
    }
    for (const machine of machines) {
      const link = this.links().find((l) => l.machine === machine);
      if (link?.linked()) void this.sync(link).catch((e) => this.d.log(`later: ${machine}: ${describe(e)}`));
    }
    if (watch) void this.judge().catch((e) => this.d.log(`later: chains: ${describe(e)}`));
  }

  /**
   * The tail of a chain whose last step went (4-J: "and call me when that's done"): a call-back on that thread (a start's
   * new one), from when its message went, the question it answered not news; asked for in words, so it rings as Call me
   * back allows then, for the level's length. One agreed to as a notification or for the next call never calls. In the
   * chain's conversation, unless a call-back is open there already, which it would replace: then a conversation of its own.
   * The rule says it started (`tailed`) only once the call-back has (the review of 4-J): read from the store after the
   * list, its only wait, and saved in the same step as the start, so a Stop meanwhile is heard, nothing is saved over, and
   * looks that overlap start it once.
   */
  private async tail(ruleId: string, targetId: string) {
    const items = await this.d.adapter.list().catch(() => [] as WorkItem[]);
    const rule = this.rules().find((r) => r.id === ruleId);
    const t = rule?.targets.find((x) => x.id === targetId);
    if (!rule?.chain || rule.stopped || rule.chain.tailed || t?.done?.state !== "sent") return;
    const waits = this.d.waits;
    const done = t.done;
    const itemId = rule.start ? done.newItem : t.itemId;
    if (!waits || !itemId) {
      rule.chain.tailed = this.now();
      this.save(rule);
      this.d.log(`later: ${rule.id}: no call-back: ${waits ? "its new thread isn't known" : "no call-backs here"}`);
      return;
    }
    // A new thread not listed yet has just started.
    const item = items.find((i) => i.id === itemId) ?? ({ id: itemId, status: "running" } as WorkItem);
    const handle = rule.start ? (rule.start.title ?? `your new thread in ${rule.start.project}`) : t.handle;
    const conversationId = waits.get(rule.made.conversationId) ? randomUUID() : rule.made.conversationId;
    const limits = this.d.limits?.() ?? LIMITS["Long Haul"];
    waits.start(conversationId, [{ item, handle, since: done.firedAt ?? done.at, heardQuestion: done.after?.questionId ?? null, asked: true }], {
      via: "voice", watchMs: limits.watchHours * HOUR, ...(rule.chain.tail === "call" ? {} : { mode: { notify: true } }),
    }, this.now());
    rule.chain.tailed = this.now();
    this.save(rule);
    this.d.log(`later: ${rule.id}: its call-back on ${handle} started (${rule.chain.tail})`);
  }

  /** One judging at a time; one asked for meanwhile runs after it. */
  private judging: Promise<void> | null = null;
  private judgeAgain = false;

  /**
   * A chain's step whose thread is on another computer than the one it goes to, judged here (§5: the brain keeps a
   * trigger on another computer): finished cleanly, it's handed to its computer as due now, 2 hours to go; failed,
   * stopped, asking or gone, it's not sent, and told. At each report and link, once it's armed or set up, and at its looks
   * (`step.look`: its reply unreadable, or its watch about to end).
   */
  judge(): Promise<void> {
    if (this.judging) {
      this.judgeAgain = true;
      return this.judging;
    }
    this.judging = (async () => {
      do {
        this.judgeAgain = false;
        await this.judgeOnce();
      } while (this.judgeAgain);
    })().finally(() => (this.judging = null));
    return this.judging;
  }

  private async judgeOnce() {
    const open = () => this.rules().filter((r) => !r.stopped && r.chain).flatMap((rule) => rule.targets.filter(watchedHere).map((t) => ({ rule, t })));
    if (!open().length) return;
    const items = await this.d.adapter.list().catch(() => null);
    if (!items) return;
    const now = this.now();
    const verdicts = new Map<string, { v: "met" | "unread" | ChainWhy; lag: boolean; seen: boolean }>();
    for (const { rule, t } of open()) {
      const s = t.step!;
      const id = s.after.itemId;
      const a = items.find((i) => i.id === id);
      const seen = listedOn(this.d.adapter, id);
      // Sent a follow-up just before the yes, its view may only not show that run yet (Fable's review of 4-J): at work
      // until `SENT_MS` is over, then judged as ever.
      const lag = !!a && viewLags(a, s.sent, now);
      const v = lag ? "working" : await finishedSince(a, s.after.lastRunAt, items, now, this.d.adapter.report?.bind(this.d.adapter), seen, s.sent?.status);
      // Looked at after its watch's end (`finish` waits for that look): a run that finished after the end was still at work
      // then, so nothing goes after the watch the user agreed to (the skeptic's review of 4-J).
      const after = v === "met" && now > endOf(rule, t) && ms(a?.lastRunAt ?? undefined) > endOf(rule, t);
      verdicts.set(t.id, { v: after ? "working" : v, lag, seen });
    }
    const machines = new Set<string>();
    let news = false;
    let looks = false;
    // Read again after the awaits: one stopped or over meanwhile is left as it is.
    for (const { rule, t } of open()) {
      const j = verdicts.get(t.id);
      if (!j) continue;
      const { v } = j;
      const s = t.step!;
      if (v === "working" || v === "unread") {
        // Looked at again without a report (the reviews of 4-J): a reply that couldn't be read in a minute, then less
        // often; one sent a follow-up just now once that's over; and once more a minute before its watch ends. From that
        // last look on, its end is told from what the latest saw (`judged`, `seen`; `looks` for a reply still unread).
        const tries = v === "unread" ? (s.looks ?? 0) + 1 : 0;
        const last = endOf(rule, t) - LAST_LOOK_MS;
        const final = now >= last;
        const look = final ? undefined : Math.min(v === "unread" ? now + Math.min(LOOK_MS * 2 ** (tries - 1), LOOK_MAX_MS) : j.lag ? s.sent!.at + SENT_MS + 1 : Infinity, last);
        const next = { look, looks: tries || undefined, judged: final ? now : s.judged, seen: final ? j.seen : s.seen };
        if (s.look !== next.look || s.looks !== next.looks || s.judged !== next.judged || s.seen !== next.seen) {
          // Saved as JSON, so a field left undefined is dropped.
          Object.assign(s, next);
          this.save(rule);
          looks = true;
        }
        if (v === "unread") this.d.log(`later: ${t.id}: ${s.after.handle}'s reply couldn't be read${s.look ? `; looked at again at ${iso(s.look)}` : ""}`);
        continue;
      }
      delete s.look;
      delete s.looks;
      if (v === "met") {
        t.step!.met = now;
        machines.add(t.machine);
        this.d.log(`later: ${t.id}: ${t.step!.after.handle} finished; handed over as due now`);
      } else {
        this.over(rule, t, { state: "not_sent", at: now, code: v });
        news = true;
      }
      this.save(rule);
    }
    this.onward();
    for (const machine of machines) {
      const link = this.links().find((l) => l.machine === machine);
      if (link?.linked()) await this.sync(link);
    }
    if (news || machines.size || looks) this.told();
  }

  /**
   * The brain's one due time per schedule (§5): one still not taken by its computer (or refused there) at the end of its
   * window is over, missed (never handed over) or not sent (refused); a stopped one that never heard back, cancelled
   * (nothing fires after it). Rules over a week ago go.
   */
  private finish(now: number): boolean {
    let news = false;
    for (const rule of this.rules()) {
      let changed = false;
      for (const t of rule.targets) {
        // A chain's step waiting for the one before it is over with it (`onward`).
        if (t.state === "done" || (t.step && !t.step.armed) || now <= endOf(rule, t)) continue;
        // Stopped, and never heard back: nothing fires after its window, but it may have gone before (read again then).
        if (rule.stopped) this.over(rule, t, { state: "cancelled", at: now, ...(t.state === "held" ? { assumed: true as const } : {}) });
        // A chain's thread on another computer, watched here, still not finished at the end of its watch (4-J), told from
        // what its last look saw (`endWhy`). One not looked at since a minute before its end (the brain asleep then) is
        // looked at first (`lookAgain`; Fable's review of 4-J), for up to 15 minutes.
        else if (t.step?.cross && t.step.met === undefined) {
          const s = t.step;
          if (s.look !== undefined && (s.judged ?? -Infinity) < endOf(rule, t) - LAST_LOOK_MS && now <= endOf(rule, t) + LOOK_MAX_MS) continue;
          this.over(rule, t, { state: "missed", at: now, ...this.endWhy(rule, t) });
        }
        else if (t.state === "pending") this.over(rule, t, { state: "missed", at: now, code: "never" });
        else if (t.state === "refused") this.over(rule, t, { state: "not_sent", at: now, ...(t.held?.code ? { code: t.held.code } : {}) });
        else continue;
        changed = true;
        news ||= !rule.stopped;
      }
      if (changed) this.save(rule);
      const last = Math.max(...rule.targets.map((t) => t.done?.at ?? Infinity));
      if (Number.isFinite(last) && now - last > KEPT_MS) this.d.store.deleteRule(rule.id);
    }
    this.onward();
    return news;
  }

  /**
   * Why a chain's step judged here wasn't sent at its watch's end (the reviews of 4-J). Its computer's view not loaded at
   * the last look nor now, nobody could tell (`unseen`): offline, "Prism was offline, so I couldn't tell when Build
   * finished"; linked with its work app not connected, "T3 Code wasn't running on Prism, so …". Else its reply unreadable
   * at the latest look, or no look judged it from its last on (the threads couldn't be listed; Fable's review of 4-J), "I
   * couldn't tell if Build finished" (`unread`); or "Build was still working after 12 hours".
   */
  private endWhy(rule: LaterRule, t: LaterTarget): Pick<NonNullable<LaterTarget["done"]>, "code" | "on" | "app"> {
    const s = t.step!;
    const id = s.after.itemId;
    const looked = (s.judged ?? -Infinity) >= endOf(rule, t) - LAST_LOOK_MS;
    if (!(looked && s.seen) && !listedOn(this.d.adapter, id)) {
      const link = this.linkOf(id);
      return { code: "unseen", ...(link ? { on: link.machine } : {}), ...(link?.linked() ? { app: appOn(this.d.adapter, id) ?? "Its app" } : {}) };
    }
    return { code: s.looks || (s.look !== undefined && !looked) ? "unread" : "working" };
  }

  /** The engine's turn: a thread judged here looked at again (`lookAgain`), what's due is over (`finish`); true when something was written to tell. */
  tick(now = this.now()): boolean {
    this.lookAgain(now);
    const news = this.finish(now);
    if (news) this.told();
    return news;
  }

  /**
   * A thread judged here whose look is due (`step.look`: its reply couldn't be read, or its watch is about to end; the
   * reviews of 4-J), judged now without waiting for a report. Its look is put off first, as far as the longest wait, so a
   * judge that never answers doesn't leave it due; the judge then sets the next. Never past the most its end waits for a
   * look (`finish`), so a step no look can judge ends 15 minutes after its watch, not 30 (the skeptic's review of 4-J).
   */
  private lookAgain(now: number) {
    let due = false;
    for (const rule of this.rules()) {
      if (rule.stopped || !rule.chain) continue;
      const looks = rule.targets.filter((t) => watchedHere(t) && t.step!.look !== undefined && t.step!.look <= now);
      for (const t of looks) t.step!.look = Math.min(now + LOOK_MAX_MS, endOf(rule, t) + LOOK_MAX_MS + 1);
      if (looks.length) {
        this.save(rule);
        due = true;
      }
    }
    if (due) void this.judge().catch((e) => this.d.log(`later: chains: ${describe(e)}`));
  }

  /** When something here next falls due: the end of each window with a schedule its computer hasn't taken, and each look at a thread judged here. */
  due(): number[] {
    const out: number[] = [];
    for (const rule of this.rules()) {
      for (const t of rule.targets) {
        // One judged here is due at its look while it has one (its end waits for it: `finish`), else at its end.
        if (!rule.stopped && watchedHere(t) && t.step!.look !== undefined) out.push(t.step!.look);
        else if (t.state !== "done" && !(t.step && !t.step.armed) && (rule.stopped || t.state === "pending" || t.state === "refused")) out.push(endOf(rule, t) + 1);
      }
    }
    return [...new Set(out)];
  }

  // --- Stop (4-E) ---

  /**
   * Stop in Watching: the rule is stopped, and each computer holding one of its schedules is handed its set without it
   * (none asked, no Face ID). Watching says "Stopping…" until the computer answers. False for no such rule.
   */
  stop(id: string): boolean {
    return this.halt(id) !== null;
  }

  /** Stop's work (`stop`): null for no such rule; else its computers' answers, once each has answered (or failed). */
  private halt(id: string): Promise<unknown> | null {
    const rule = this.rules().find((r) => r.id === id);
    if (!rule) return null;
    if (rule.stopped) return Promise.resolve();
    const now = this.now();
    rule.stopped = now;
    // One no computer was handed is cancelled at once only when none can have it: a set may be on its way. A chain's step
    // no computer holds (waiting for the step before, or watched here) is over at once (`onward`): Stop stops the chain.
    this.save(rule);
    this.d.log(`later: ${id} stopped`);
    this.onward();
    const answers: Promise<unknown>[] = [];
    for (const machine of new Set(rule.targets.filter((t) => t.state !== "done").map((t) => t.machine))) {
      const link = this.links().find((l) => l.machine === machine);
      if (link?.linked()) answers.push(this.sync(link).catch((e) => this.d.log(`later: ${machine}: ${describe(e)}`)));
    }
    this.told();
    return Promise.all(answers);
  }

  /**
   * Still to go: not stopped, a schedule not over, and its window not over (a chain's (4-J), its step on now's: 4-J's
   * `endOf`, its watch or two hours from a finish judged here). One past the end of its window never goes now, though
   * its computer, offline, hasn't said so yet: it isn't waiting, so it's never stopped, asked about or counted as waiting
   * by voice (the skeptic's should on the third review of 4-E).
   */
  private stillToGo(rule: LaterRule, now: number): boolean {
    return !rule.stopped && rule.targets.some((t) => t.state !== "done") && now <= endOf(rule, current(rule));
  }

  /**
   * Each rule still to go (`stillToGo`), soonest first (a chain's, by when it was agreed), as the voice names it: its
   * words, the threads it still goes to, its time, a chain's thread it waits for, a computer that doesn't have it yet
   * because it's offline, and, past its time and not gone, what it waits for, as Watching's second line says (Fable's
   * ruling on the review of 4-E): its thread to be free, its computer, or that computer to be back. Never one its
   * computer went offline while sending (`wentOff`): it isn't waiting, so it's never named as waiting, asked about or
   * stopped by voice (the skeptic's should on the sixth review of 4-E).
   */
  private open(now = this.now()): { rule: LaterRule; said: LaterSaid }[] {
    const computers = this.computers();
    const links = new Map(this.links().map((l) => [l.machine, l]));
    const syncs = this.syncs();
    return this.rules().filter((r) => this.stillToGo(r, now) && !this.wentOff(r)).sort((a, b) => a.at - b.at).map((rule) => {
      // A chain's (4-J) by its step on now, once a computer is to hold it: a later step, or one watched here, has none yet.
      const open = rule.chain ? [current(rule)].filter((t) => t.state !== "done" && !unheld(t)) : rule.targets.filter((t) => t.state !== "done");
      const away = open.find((t) => t.state === "pending" && !links.get(t.machine)?.linked());
      // Its computer didn't take it (its clock, or a refusal there): said, as after the yes, never only "I'll send…".
      const clock = open.find((t) => syncs[t.machine]?.refused?.code === "clock");
      const refused = open.find((t) => t.state === "refused");
      const notTook = clock ? notTaken(computerOf(clock.machine, computers), syncs[clock.machine]!.refused!.minutes ?? 0) : refused ? notTaken(computerOf(refused.machine, computers)) : undefined;
      const gone = open.find((t) => !links.get(t.machine)?.linked());
      const late = !rule.chain && !notTook && now >= rule.at
        ? { until: spokenPast(rule.until, this.zone(rule), now), computer: computerOf(open[0].machine, computers), back: gone ? computerOf(gone.machine, computers) : null }
        : undefined;
      return { rule, said: this.saidOf(rule, away ? computerOf(away.machine, computers) : undefined, notTook, late) };
    });
  }

  private saidOf(rule: LaterRule, offline?: string, notTook?: string, late?: LaterSaid["late"]): LaterSaid {
    // A chain by its step on now (4-J): "\"rebase\" to API, when Schema finishes".
    const t = rule.chain ? current(rule) : null;
    return {
      words: t ? wordsOf(rule, t) : (rule.send?.message ?? rule.start!.message), threads: t ? [t.handle] : rule.targets.filter((x) => x.state !== "done").map((x) => x.handle), at: rule.at, zone: this.zone(rule),
      ...(rule.start ? { project: rule.start.project } : {}), ...(t?.step ? { after: t.step.after.handle } : {}), ...(offline ? { offline } : notTook ? { notTaken: notTook } : {}),
      ...(late ? { late } : {}),
      // Its tail with its last step (the readback's "and call you when API replies").
      ...(t && rule.chain?.tail && t === rule.targets.at(-1) ? { tail: rule.chain.tail } : {}),
    };
  }

  /**
   * What's still to go, as the voice says it when asked (Fable's 4-D), one sentence each, soonest first. A send or a
   * start whose window is over and that hasn't gone never goes now (its computer reports it missed when it's back, 4-G),
   * so it's never "I'll send…" (the skeptic's should on the second review of 4-E); with its computer offline, it's said
   * that it hasn't gone or started (`notBack`, `notStarted`: Fable's shoulds on the third and fourth reviews), and
   * otherwise left out. One its computer said was going (`firing`) is never said as not gone: it likely went (the
   * skeptic's should on the fourth review); nor, its computer offline now, as still to go, inside its window or past it
   * (`wentOff`, Fable's words on the fifth review): it isn't waiting, and what became of it is told when that computer
   * is back. A chain's window is its step on now's (`stillToGo`).
   */
  said(now = this.now()): string[] {
    const computers = this.computers();
    const links = new Map(this.links().map((l) => [l.machine, l]));
    const over = this.rules().filter((r) => !r.stopped && !r.chain && now > r.until).flatMap((rule) => {
      const away = rule.targets.filter((t) => t.state !== "done" && t.held?.state !== "firing" && !links.get(t.machine)?.linked());
      if (!away.length) return [];
      const computer = computerOf(away[0].machine, computers);
      return [{ at: rule.at, line: rule.start ? notStarted(computer, rule.start.project) : notBack(computer, rule.send!.message, away.map((t) => t.handle)) }];
    });
    const waiting = this.open(now).map((o) => ({ at: o.rule.at, line: laterSentence(o.said, now) }));
    return [...over, ...waiting].sort((a, b) => a.at - b.at).map((o) => o.line);
  }

  /** Whether anything is still to go (`stillToGo`): what a list must name for "stop that" after it to be about one. */
  anyWaiting(now = this.now()): boolean {
    return this.rules().some((r) => this.stillToGo(r, now) && !this.wentOff(r));
  }

  /**
   * Every schedule of `rule` still to go is one its computer said it was sending (`firing`), and that computer is offline
   * now (Fable's words on the fifth review of 4-E): Watching's `wentOffline`, with no Stop; never said as waiting. One
   * with none still to go went, so it never blocks a stop (Fable's should on the eighth review).
   */
  private wentOff(rule: LaterRule): boolean {
    const links = new Map(this.links().map((l) => [l.machine, l]));
    const open = rule.targets.filter((t) => t.state !== "done");
    return open.length > 0 && open.every((t) => t.held?.state === "firing" && !links.get(t.machine)?.linked());
  }

  /**
   * What's still to go (`open`), said last after a stop of call-backs that leaves it waiting (2b's `stop_watching`;
   * Fable's ruling on pass B1's review): one, `stillWaiting`'s sentence, about it (`only`), so "stop that" after it
   * stops it, as after `notWaiting`; two or more, how many, about any, so "stop that" asks which. Null with none.
   */
  stillSaid(now = this.now()): { line: string; only: string[] | null } | null {
    const open = this.open(now);
    if (!open.length) return null;
    return open.length === 1 ? { line: stillWaiting(open[0].said, now), only: [open[0].rule.id] } : { line: stillWaitingCount(open.length), only: null };
  }

  /**
   * A readback's no that named one in words a stop can't read (Fable's should on the fifth review of 4-E), or that named
   * one that fits nothing waiting, and after a refusal, words a stop can't read (Fable's should on the sixth review):
   * nothing is stopped, and what's still to go (`open`) is said after "Nothing's set up." (`notSetUpWaiting`); `only`,
   * the one it names when it names one, so "cancel that" after it is about that one; `waiting`, it names any.
   */
  notSetUp(now = this.now()): { line: string; only: string[] | null; waiting: boolean } {
    const open = this.open(now);
    return { line: notSetUpWaiting(open.map((o) => o.said), now), only: open.length === 1 ? [open[0].rule.id] : null, waiting: open.length > 0 };
  }

  /**
   * Stop by voice (Fable's 4-E: "stop that", "don't send that to API", "cancel the three o'clock one"), at once, never
   * read back, never a yes. `ask`: the thread named (where it goes, a new thread's project, or the one a chain waits
   * for) and the time said, each null when not said; `at` may be words it can't read as a time ("the other one"), which
   * name nothing it can tell apart. The rule (engine.md, 4-E's notes): it stops one only when what was named singles out
   * exactly one still to go, and nothing else fits it, not the readback open or just said no to, not one its computer
   * went offline while sending (`wentOff`), not a second still to go. Its computers then have 5 s to answer before it's
   * said: "Stopped. Nothing will be sent to API." (a start's, "…Nothing will be started."), "Stopped. Quartz won't send
   * it." (offline), "Stopping it now." (no answer), or "Too late: it went to API at 3 this morning." (it went first, or as
   * the stop reached it). Otherwise:
   * - `readback`, the one open or just said no to: what fits it (its threads, its project, its time), or naming nothing,
   *   is its no, null, and nothing waiting is stopped (Fable's rulings on the third to seventh reviews);
   * - a thread or a time that fits nothing still to go: one that went in the last hour (or offline while sending) and
   *   fits is too late; else null after a refusal (`refused`) or at a readback, their no; else what's waiting, with one
   *   `That one isn't waiting. "zzz" to Docs at 4 is still waiting.` (about it, `only`), two or more which one, none
   *   nothing is waiting (Fable's ruling on the seventh review: never "only one exists" then);
   * - naming nothing it can read, the only one still to go is stopped, its line naming where it goes (4-E's "or only one
   *   exists", kept only here); none still to go: the one that went is too late, else nothing is waiting;
   * - one gone offline while sending that could be meant too (naming nothing, or a thread or a time that fits both: the
   *   skeptic's Q8 on the seventh review): nothing is stopped, and both are said, `Too late: it went to API at 3 this
   *   morning. "zzz" to Docs at 5 is still waiting.` (about the one waiting; Fable's ruling on the eighth review). One
   *   that went, with nothing left to go, never blocks a stop (`wentOff`);
   * - anything else asks which: two or three, which one; more, how many, and which thread's (or time).
   * Two or more that are the same to the user (words, threads, time) are one: the first is stopped, unless one gone
   * offline while sending could be meant too (the skeptic's should on the eighth review). `stopped`: a rule was stopped
   * now. Every rule this version reads is looked at, a chain's (4-J) too.
   *
   * `only`: "stop that" straight after a line about these rules (the session's; Fable's rulings on the second review of
   * 4-E): "Scheduled." names the one just set up, a refusal that set nothing up names none; then only those are looked at,
   * whatever else waits, and with none of them to stop it says nothing is waiting when nothing is, else null (it only cut
   * the voice off).
   */
  async stopSaid(ask: { thread: string | null; at: string | null; only?: string[] | null; readback?: LaterReadback | null; refused?: boolean }): Promise<StopSaid | null> {
    const now = this.now();
    const open = this.open(now);
    // One gone offline while sending counts past its window too, as Watching still shows it (the skeptic's should on the
    // ninth review of 4-E).
    const went = this.rules().filter((r) => !r.stopped && (this.wentOff(r)
      || (r.targets.every((t) => t.state === "done") && r.targets.some((t) => t.done?.state === "sent" && now - (t.done.firedAt ?? t.done.at) < TOO_LATE_SAID_MS))));
    const late = (rule: LaterRule) => ({ line: this.tooLate(rule, now), stopped: false });
    const thread = ask.thread?.trim() ? ask.thread : null;
    const at = ask.at?.trim() ? askedTime(ask.at) : null;
    const named = thread !== null || at !== null;
    if (ask.readback && (!named || fitsReadback(ask.readback, thread, at, this.zone(), now))) return null;
    if (ask.only) {
      const only = ask.only;
      const mine = open.find((o) => only.includes(o.rule.id));
      if (mine) return this.stopOne(mine.rule);
      const gone = went.find((r) => only.includes(r.id));
      if (gone) return late(gone);
      return open.length ? null : { line: NOTHING_WAITING, stopped: false };
    }
    const which = (some: typeof open) => (sameToUser(some.map((o) => o.rule)) ? this.stopOne(some[0].rule)
      : { line: some.length > 3 ? manyLine(some.map((o) => o.rule), thread) : whichOne(some.map((o) => o.said), now), stopped: false });
    // What's waiting, when what was named singles out none: never a stop (Fable's ruling on the seventh review), so two
    // the same to the user are said as one, never stopped; with `off`, one gone offline while sending that could be
    // meant too, both (Fable's ruling on the eighth review).
    const waiting = (some: typeof open, off?: LaterRule) => (ask.readback || ask.refused ? null : some.length > 1 && !sameToUser(some.map((o) => o.rule)) ? which(some)
      : some.length ? { line: off ? tooLateWaiting(this.tooLate(off, now), some[0].said, now) : notWaiting(some[0].said, now), stopped: false, only: [some[0].rule.id] }
      : { line: NOTHING_WAITING, stopped: false });
    const fits = (rule: LaterRule) => fitsAsk(rule, thread, at, this.zone(rule), now);
    const fitting = named ? open.filter((o) => fits(o.rule)) : open;
    const gone = named ? went.filter(fits) : went;
    // One gone offline while sending that could be meant never leaves another the only one (the skeptic's Q8), nor two
    // the same to the user (his should on the eighth review); one that went never does (`wentOff`). "Stop that" straight
    // after a line about any of them (`only` null) is about what it named, which is never that one.
    const off = ask.only === null ? [] : gone.filter((r) => this.wentOff(r));
    if (fitting.length > 1 && !(off.length && sameToUser(fitting.map((o) => o.rule)))) return which(fitting);
    if (fitting.length && !off.length) return this.stopOne(fitting[0].rule, !named);
    if (fitting.length) return waiting(fitting, off[0]);
    if (gone.length === 1) return late(gone[0]);
    return named ? waiting(open) : { line: NOTHING_WAITING, stopped: false };
  }

  /** Its schedules that went (or are going) already. */
  private sentOf(rule: LaterRule): LaterTarget[] {
    return rule.targets.filter((t) => t.done?.state === "sent" || t.held?.state === "firing");
  }

  /** When the first of `sent` went, as said ("3 this morning"). */
  private wentAt(rule: LaterRule, sent: LaterTarget[], now: number): string {
    const fired = Math.min(...sent.map((t) => t.done?.firedAt ?? (t.held?.firedAt ? Date.parse(t.held.firedAt) : NaN)).filter(Number.isFinite), now);
    return spokenPast(fired, this.zone(rule), now);
  }

  /**
   * "Too late: it went to API at 3 this morning.", by when its first schedule went. A chain's steps go one after another:
   * its last that went, at its own time (pass B1's review).
   */
  private tooLate(rule: LaterRule, now: number): string {
    const went = this.sentOf(rule);
    const sent = rule.chain ? went.slice(-1) : went;
    return tooLateSaid(!!rule.start, sent.map((t) => t.handle), this.wentAt(rule, sent, now));
  }

  /**
   * `stopSaid`'s stop: Stop as the tap's, then up to 5 s for its computers' answers, and the line for what it knows then.
   * A send to several threads that went to some first stopped the rest (Fable's ruling on the review of 4-E): both are
   * said, `Too late for API: it went at 3 this morning. Nothing will be sent to Docs.`, and it's a stop. `name`: the stop
   * named nothing (the only one waiting), so a send's line names where it goes (`stoppedLine`).
   */
  private async stopOne(rule: LaterRule, name = false): Promise<StopSaid> {
    const stopping = new Set(rule.targets.filter((t) => t.state !== "done").map((t) => t.id));
    const answered = this.halt(rule.id)!;
    let timer: Timer | null = null;
    await Promise.race([answered, new Promise<void>((r) => { timer = this.clock.setTimeout(r, STOP_SAID_MS); })]);
    if (timer) this.clock.clear(timer);
    const now = this.now();
    const after = this.rules().find((r) => r.id === rule.id) ?? rule;
    // A chain's steps that went before the stop was asked aren't this stop's (pass B1's review): only those still to go
    // then, as Watching's row counts them. A send to several threads that went to some first says both (Fable's ruling).
    const sent = this.sentOf(after).filter((t) => !after.chain || stopping.has(t.id));
    // What this stop stopped: each schedule still to go when it was asked that didn't go first.
    const rest = after.targets.filter((t) => stopping.has(t.id) && !sent.includes(t));
    // It went as the stop reached its computer: nothing was stopped.
    if (sent.length && !rest.length) return { line: tooLateSaid(!!after.start, sent.map((t) => t.handle), this.wentAt(after, sent, now)), stopped: false };
    const line = this.stoppedLine(after, rest, sent.length > 0, now, name);
    return { line: sent.length ? `${tooLateFor(sent.map((t) => t.handle), this.wentAt(after, sent, now))} ${line}` : line, stopped: true };
  }

  /**
   * What a stop of `rest` says, by what its computers answered: "Stopped. Nothing will be sent to API." (after a too-late
   * part, `partly`, "Nothing will be sent to Docs."), "Stopped. Nothing will be started.", "Stopping it now." with no
   * answer, or offline "Stopped. Quartz won't send it." (past its time and held there, "Stopped, but Quartz may have sent
   * it already. You'll hear if it did."); after a too-late part, those name the rest ("Stopping Docs' now.", Fable's nit
   * on the second review of 4-E). Another send still waiting for a thread it went to: which one stopped and how many
   * are left (`stoppedOneOf`, Fable's ruling on that review). `name`: the stop named nothing, so a send's line names
   * where it goes ("Stopped. Quartz won't send it to API.", "Stopping API's now.": the rule on the seventh review).
   */
  private stoppedLine(rule: LaterRule, rest: LaterTarget[], partly: boolean, now: number, name = false): string {
    const links = new Map(this.links().map((l) => [l.machine, l]));
    const open = rest.filter((t) => t.state !== "done");
    const names = rest.map((t) => t.handle);
    const to = name && !rule.start;
    if (!open.length) return rule.start ? STOPPED_START : this.moreFor(rule, rest, partly, now) ?? (partly ? nothingSentTo(names) : stoppedSend(names));
    // Not confirmed yet (no answer, or offline): how many more still wait for those threads, so a twin isn't left
    // unsaid (Fable's ruling on the ninth review of 4-E).
    const others = this.othersFor(rule, rest, now);
    const more = others ? ` ${moreWaiting(others.count, others.threads)}` : "";
    if (open.some((t) => links.get(t.machine)?.linked())) return (partly ? stoppingRest(names) : to ? stoppingTo(names) : STOPPING_NOW) + more;
    // Every one left is on a computer offline: it never sends unsynced, but past its time it may have gone first.
    const computer = computerOf(open[0].machine, this.computers());
    const maybe = open.some((t) => t.state === "held") && rule.stopped! >= rule.at;
    if (partly) return (maybe ? stoppedRestMaybe(names, computer) : stoppedRestWont(names, computer)) + more;
    if (to) return (maybe ? stoppedMaybeTo(computer, names) : stoppedWontTo(computer, names)) + more;
    return (maybe ? stoppedMaybeSaid(computer) : rule.start ? stoppedWontStart(computer) : stoppedWont(computer)) + more;
  }

  /** Others still to go (`stillToGo`) that wait for one of the threads `rest` went to: how many, and which threads. */
  private othersFor(rule: LaterRule, rest: LaterTarget[], now: number): { count: number; threads: string[]; others: LaterRule[] } | null {
    const ids = new Set(rest.map((t) => t.itemId).filter((id) => id !== null));
    // One gone offline while sending isn't waiting, so it's never counted here (`wentOff`).
    const others = this.rules().filter((r) => r.id !== rule.id && this.stillToGo(r, now) && !this.wentOff(r) && r.targets.some((t) => t.state !== "done" && t.itemId !== null && ids.has(t.itemId)));
    if (!others.length) return null;
    const threads = rest.filter((t) => others.some((r) => r.targets.some((o) => o.state !== "done" && o.itemId === t.itemId))).map((t) => t.handle);
    return { count: others.length, threads, others };
  }

  /**
   * A send just stopped for `rest` while others still to go (`stillToGo`) wait for one of those threads (Fable's ruling on
   * the second review of 4-E): `Stopped the one at 4. 3 more are waiting for API.`, its time as `whichTimes` says it
   * beside theirs (a chain's "when Schema finishes"); after a too-late part (`partly`), the rest by name, `Stopped for
   * Docs. One more is waiting for Docs.` (Fable's nit on the third review); null when none does.
   */
  private moreFor(rule: LaterRule, rest: LaterTarget[], partly: boolean, now: number): string | null {
    const found = this.othersFor(rule, rest, now);
    if (!found) return null;
    const { others, threads } = found;
    // A chain's (4-J) by the thread its step stopped now waits for.
    const after = rule.chain ? (rest[0] ?? current(rule)).step?.after.handle : undefined;
    const what = partly ? forRest(rest.map((t) => t.handle))
      : after !== undefined ? `the one when ${after} finishes` : `the one at ${whichTimes([rule.at, ...others.filter((r) => !r.chain).map((r) => r.at)], this.zone(rule), now)[0]}`;
    return stoppedOneOf(what, others.length, threads);
  }

  // --- Watching (4-D) ---

  /** Watching's rows: each rule with a schedule still to go, and a Stop too late for a while, saying so. */
  rows(now = this.now(), doing: (tail: Tail) => "calling" | "telling" | "kept" = (tail) => (tail === "call" ? "calling" : tail === "notify" ? "telling" : "kept")): LaterRow[] {
    const computers = this.computers();
    const syncs = this.syncs();
    const links = new Map(this.links().map((l) => [l.machine, l]));
    const out: LaterRow[] = [];
    for (const rule of this.rules()) {
      if (rule.chain) {
        const row = this.chainRow(rule, now, { computers, syncs, links, doing });
        if (row) out.push(row);
        continue;
      }
      const open = rule.targets.filter((t) => t.state !== "done");
      const sent = rule.targets.filter((t) => t.done?.state === "sent");
      const tooLate = !!rule.stopped && sent.length > 0 && now - rule.stopped < TOO_LATE_SHOWN_MS;
      if (!open.length && !tooLate) continue;
      const zone = this.zone(rule);
      const shown = shownClock(rule.at, zone, now);
      const threads = rule.targets.map((t) => t.handle);
      const words = rule.send?.message ?? rule.start!.message;
      const said = rule.start ? startSentence(rule.start.project, shown) : sendSentence(words, threads, shown);
      const base = { id: rule.id, leftMs: Math.max(0, rule.at - now), until: rule.at, ring: false as const, wouldRing: false as const, timed: true as const };
      const c = (machine: string, start = false) => computerOf(machine, computers, start);
      if (tooLate) {
        const fired = Math.min(...sent.map((t) => t.done?.firedAt ?? rule.at));
        // Sent to some and stopped for the rest (Fable's ruling on the review of 4-E): both, on its second line; the rest
        // as 4-D says a stop until its computer answers (the skeptic's should on the second review): "Stopping…", which
        // the phone reads again, or offline, that it may have gone or won't.
        const handles = (ts: LaterTarget[]) => ts.map((t) => t.handle);
        const stopped = rule.targets.filter((t) => t.state !== "done" || t.done?.state === "cancelled");
        const away = open.find((t) => !links.get(t.machine)?.linked());
        const said = tooLateSentence(words, handles(sent), shownClock(fired, zone, now));
        if (open.length && (!away || open.some((t) => links.get(t.machine)?.linked()))) {
          out.push({ ...base, said, note: tooLateStopping(handles(sent)), stop: false, stopping: true });
        } else if (away) {
          const maybe = open.some((t) => t.state === "held") && rule.stopped! >= rule.at;
          out.push({ ...base, said, note: maybe ? tooLateMaybe(handles(sent), handles(stopped), c(away.machine)) : tooLateWont(handles(sent), handles(stopped), c(away.machine)), stop: false });
        } else out.push({ ...base, said, note: stopped.length ? tooLateStopped(handles(sent), handles(stopped)) : TOO_LATE, stop: false });
        continue;
      }
      if (rule.stopped) {
        const away = open.find((t) => !links.get(t.machine)?.linked());
        // Stopped past its time, held by a computer offline now: it may have sent it before it went (the skeptic's).
        const maybe = away && away.state === "held" && rule.stopped >= rule.at;
        out.push(away ? { ...base, said, note: maybe ? stoppedMaybeSent(c(away.machine)) : rule.start ? stoppedOfflineStart(c(away.machine, true)) : stoppedOffline(c(away.machine, true)), stop: false, grey: true } : { ...base, said, note: STOPPING, stop: false, stopping: true });
        continue;
      }
      const untilShown = shownClock(rule.until, zone, now);
      const notes = open.map((t) => {
        const link = links.get(t.machine);
        const s = syncs[t.machine];
        if (s?.refused?.code === "clock") return clockOff(c(t.machine, true), s.refused.minutes ?? 0);
        if (t.state === "refused") return t.held?.code === "version" ? updateToSend(c(t.machine)) : (t.held?.why ?? `${c(t.machine, true)} didn't take it`).replace(/\.$/, "");
        if (t.state === "pending") return link?.linked() ? null : waitingOnline(c(t.machine));
        // Its computer said it was sending it, then went offline (Fable's words on the fifth review of 4-E).
        if (t.held?.state === "firing" && !link?.linked()) return wentOffline(c(t.machine, true));
        if (now < rule.at) return hasIt(c(t.machine, true), rule.start?.profile.runtimeMode);
        // Its window over and its computer offline, it never goes now (Fable's shoulds on the third and fourth reviews of 4-E).
        if (!link?.linked() && now > rule.until) return rule.start ? offlineNotStarted(c(t.machine, true), untilShown) : offlineNotSent(c(t.machine, true), untilShown);
        if (!link?.linked()) return offlineGoes(c(t.machine, true), untilShown);
        return rule.start ? waitingOn(c(t.machine), untilShown) : waitingFree(t.handle, untilShown);
      });
      const note = notes.find((n) => n !== null) ?? undefined;
      out.push({ ...base, said, ...(note ? { note } : {}), ...(this.wentOff(rule) ? { stop: false } : {}) });
    }
    return out;
  }

  /**
   * A chain's row (4-J): its step on now, "Sending “rebase and run the tests” to API when Schema finishes" (a start,
   * "Starting a thread in driver when Schema finishes"); the second line what follows it ("Then calling you when API
   * replies", as the tail would reach them now; "Then 1 more step") and its state as 4-D's rows say it ("Quartz has it");
   * the time left to its watch's end, and Stop, which stops the whole chain ("Stopping…" until its computer answers,
   * `stopping`, as a send's: 4-E). A step that went after a Stop: too late.
   */
  private chainRow(rule: LaterRule, now: number, o: { computers: number; syncs: Record<string, Sync>; links: Map<string, LaterLink>; doing: (tail: Tail) => "calling" | "telling" | "kept" }): LaterRow | null {
    const open = rule.targets.filter((t) => t.state !== "done");
    const zone = this.zone(rule);
    const c = (machine: string, start = false) => computerOf(machine, o.computers, start);
    const base = { id: rule.id, ring: false as const, wouldRing: false as const };
    const late = rule.stopped ? rule.targets.find((t) => t.done?.state === "sent" && t.done.at >= rule.stopped!) : undefined;
    if (late && now - rule.stopped! < TOO_LATE_SHOWN_MS) {
      return { ...base, leftMs: 0, until: now, said: tooLateSentence(wordsOf(rule, late), [late.handle], shownClock(late.done!.firedAt ?? late.done!.at, zone, now)), note: TOO_LATE, stop: false };
    }
    if (!open.length) return null;
    const t = open[0];
    const end = endOf(rule, t);
    const after = t.step!.after.handle;
    const row = { ...base, said: rule.start ? chainStartSentence(rule.start.project, after) : chainSentence(wordsOf(rule, t), t.handle, after), leftMs: Math.max(0, end - now), until: end };
    const link = o.links.get(t.machine);
    // Its thread finished: on its computer (`Held.at`), or watched here.
    const met = t.step!.cross ? t.step!.met !== undefined : t.held?.at !== undefined;
    if (rule.stopped) {
      const away = !link?.linked();
      return away ? { ...row, note: met && t.state === "held" ? stoppedMaybeSent(c(t.machine)) : stoppedOffline(c(t.machine, true)), stop: false, grey: true } : { ...row, note: STOPPING, stop: false, stopping: true };
    }
    const more = open.length - 1;
    const then = more ? moreSteps(more) : rule.chain!.tail ? thenLine(o.doing(rule.chain!.tail), rule.start ? "the new thread" : t.handle) : null;
    const s = o.syncs[t.machine];
    const untilShown = shownClock(end, zone, now);
    // Its thread on another computer without a loaded view: waiting for it to come online, or linked, for its work app
    // (Fable's reviews of 4-J).
    const state = t.step!.cross && !met ? this.waitingFor(t.step!.after, o.computers)
      : s?.refused?.code === "clock" ? clockOff(c(t.machine, true), s.refused.minutes ?? 0)
      : t.state === "refused" ? (t.held?.code === "version" ? updateToSend(c(t.machine)) : (t.held?.why ?? `${c(t.machine, true)} didn't take it`).replace(/\.$/, ""))
      : t.state === "pending" ? (link?.linked() ? null : waitingOnline(c(t.machine)))
      : !met ? hasIt(c(t.machine, true), rule.start?.profile.runtimeMode)
      : !link?.linked() ? offlineGoes(c(t.machine, true), untilShown)
      : rule.start ? waitingOn(c(t.machine), untilShown) : waitingFree(t.handle, untilShown);
    // "your computer" lower-case after " · ", as the call's receipt has it (Fable's nit on 4-J).
    const note = [then, state].filter(Boolean).join(" · ").replace(/ · Your computer/g, " · your computer");
    return { ...row, ...(note ? { note } : {}) };
  }

  /**
   * Watching's state for a chain's step judged here, by the view of the computer holding the thread it waits for: loaded,
   * none; that computer offline, "Waiting for Prism to come online"; linked with its work app not connected, "Waiting for
   * T3 Code on Prism", or by the thread when its app's name isn't known, "Waiting for Build's app on Prism" (Fable's
   * reviews of 4-J).
   */
  private waitingFor({ itemId, handle }: { itemId: string; handle: string }, computers: number): string | null {
    if (listedOn(this.d.adapter, itemId)) return null;
    const link = this.linkOf(itemId);
    const machine = computerOf(link?.machine ?? "your computer", computers);
    return link?.linked() ? waitingApp(appOn(this.d.adapter, itemId) ?? `${possessive(handle)} app`, machine) : waitingOnline(machine);
  }
}

/** A part of the day, as a stop's question offers it ("the afternoon one"): `spokenClock`'s parts. */
export type DayPart = "morning" | "afternoon" | "evening";
const partOf = (hour: number): DayPart => (hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening");

/**
 * A stop's time as said (4-E): its clock (`Heard`), a part of the day alone, and its day ("today", "tomorrow", a
 * weekday, lower case), each null when not said; null when none is.
 */
export type AskedTime = { clock: Heard | null; part: DayPart | null; day: string | null };

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** Words before "one" that make it an hour ("at one", "quarter past one", "ten to one", "five after one", "half one"). */
const HOUR_AFTER = new Set(["at", "past", "to", "after", "half"]);
/** Words after "one" that make it an hour ("one o'clock", "one pm", "one thirty", "one oh five"). */
const HOUR_BEFORE = /^(?:o'?clock|am|pm|a\.m\.?|p\.m\.?|oh|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)$/;
/** "twenty one past three": "one" as minutes. */
const TENS = new Set(["twenty", "thirty", "forty", "fifty"]);
/** Words that say nothing of when, around a part of the day or a day alone ("the one in the afternoon", "the Saturday one"). */
const FILLER = new Set(["the", "this", "in", "on", "of", "for"]);
/** An hour said in words or digits ("three", "3", "noon"): what "after", "to" or "past" may come before. */
const HOUR_WORD = /^(?:\d{1,2}(?:[:.]\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midday|midnight)$/;
/** Minutes before "past", "to" or "after" ("ten to", "quarter past", "5 after"); "one" only after a ten ("twenty one past"). */
const MINUTE_WORD = /^(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|quarter|half)$/;
/** What may follow "at one" when it's the hour ("the one at one", "at one tomorrow", "at one in the morning"). */
const AFTER_AT_ONE = new Set(["in", "this", "on", "tomorrow", "today", "tonight", "morning", "afternoon", "evening", ...WEEKDAYS]);
/** A length's unit ("in 20 minutes", "2 hours from now", "5 minutes ago", "2 days from now"): never a clock time. */
const LENGTH = /^(?:hours?|hrs?|minutes?|mins?|days?|weeks?)$/;

/**
 * A stop's time as said (4-E): "three o'clock", "the 3 AM one", "the one o'clock one", "half past one", "the one at
 * one", "ten to one"; a part of the day ("the afternoon one", "the one in the afternoon"); a day ("the one tomorrow",
 * "the Saturday one", "3 tomorrow", "this afternoon", and "tonight", today's evening: Fable's nit on the third review).
 * "One" is an hour only in a clock form (the skeptic's blocker and Fable's on the second review of 4-E): after "at"
 * (with nothing after it but a day or a part of one), "half", or minutes and "past", "to" or "after", or before
 * "o'clock", "am"/"pm" or a minute word, and never as the last word, which names the send ("the three o'clock one").
 * Anywhere else it names the send and goes, and what's left must read as a time: "the later one", "the new one", "the
 * API one", "the one I just made", "the first one" are no time at all, so the question comes back. No time either (the
 * skeptic's blocker and nit on the third review, Fable's nit): a length or how long ago ("in 20 minutes", "the one in 2
 * hours", "the one in ten", "5 minutes ago", "2 hours from now"), an hour after "before", "until", or after "after", "to"
 * or "past" with no minutes before it ("the one after two", "the reply to one"), and "them" ("the two of them").
 */
export function askedTime(said: string): AskedTime | null {
  const words = said.toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?]+$/, "").replace(/,/g, " ").replace(/(\p{L})-(\p{L})/gu, "$1 $2").replace(/'s\b/g, "").split(/\s+/).filter(Boolean);
  // A minute word before word `i` ("twenty one", "twenty minutes"): what "past", "to" or "after" an hour needs.
  const minutesAt = (i: number): boolean => {
    const w = words[i] ?? "";
    if (w === "one") return TENS.has(words[i - 1] ?? "");
    if (w === "minute" || w === "minutes") return minutesAt(i - 1);
    return MINUTE_WORD.test(w);
  };
  for (const [i, w] of words.entries()) {
    const next = words[i + 1] ?? "";
    if (w === "them" || w === "before" || w === "until" || w === "till" || (w === "in" && HOUR_WORD.test(next))) return null;
    if (LENGTH.test(w) && !/^(?:past|to|after)$/.test(next)) return null;
    if (/^(?:past|to|after)$/.test(w) && HOUR_WORD.test(next) && !minutesAt(i - 1)) return null;
  }
  let day: string | null = null;
  let tonight = false;
  const kept: string[] = [];
  for (const [i, w] of words.entries()) {
    const d = w === "today" || w === "tonight" || (w === "this" && /^(?:morning|afternoon|evening)$/.test(words[i + 1] ?? "")) ? "today" : w === "tomorrow" ? "tomorrow" : WEEKDAYS.includes(w) ? w : null;
    if (d) {
      if (day && day !== d) return null;
      day = d;
      if (w !== "tonight") continue;
      // Kept for the clock, which reads "1 tonight" as the small hours and "9 tonight" as the evening.
      tonight = true;
    }
    if (w === "one" || w === "ones") {
      const prev = words[i - 1] ?? "";
      const next = words[i + 1] ?? "";
      const atOne = prev !== "at" || next === "" || HOUR_BEFORE.test(next) || AFTER_AT_ONE.has(next);
      const hour = w === "one" && ((HOUR_AFTER.has(prev) && atOne) || (i < words.length - 1 && (HOUR_BEFORE.test(next) || TENS.has(prev))));
      if (!hour) continue;
    }
    kept.push(w);
  }
  const rest = kept.join(" ");
  const clock = rest ? parseClock(rest) : null;
  const left = kept.filter((w) => !FILLER.has(w) && w !== "tonight");
  const part = !clock && left.length === 1 && /^(?:morning|afternoon|evening)$/.test(left[0]) ? (left[0] as DayPart) : !clock && tonight && !left.length ? "evening" : null;
  if (!clock && !part && (left.length || !day)) return null;
  // "1 tonight" is in the small hours, tomorrow's date; "9 tonight", today's.
  if (tonight && clock) day = clock.hour < 6 ? "tomorrow" : "today";
  return { clock, part, day };
}

/**
 * Whether `rule` is the one a stop by voice names (4-E): `thread`, every word said in one of its names (a thread it goes
 * to; a new thread's project, or "the new thread"; a chain's thread it waits for); `at`, its time on the phone's clock,
 * by the hour said (and its half, when said), its part of the day, and its day (today, tomorrow, a weekday: the
 * skeptic's nit on the second review of 4-E), each when said; a chain has none. Each not said fits anything.
 */
export function fitsAsk(rule: LaterRule, thread: string | null, at: AskedTime | null, zone: string, now: number): boolean {
  if (thread !== null && fittingName(rule, thread) === null) return false;
  return at === null || (!rule.chain && fitsWhen(rule.at, at, zone, now));
}

/** Whether a stop's time as said (`askedTime`) fits `when` on the phone's clock: its hour (and half), part of the day and day, each when said. */
function fitsWhen(when: number, at: AskedTime, zone: string, now: number): boolean {
  const c = clockOf(when, zone);
  if (at.day !== null) {
    const today = clockOf(now, zone).date;
    if (at.day === "today" ? c.date !== today : at.day === "tomorrow" ? c.date !== nextDate(today) : c.weekday.toLowerCase() !== at.day) return false;
  }
  if (at.part !== null && partOf(c.hour) !== at.part) return false;
  const h = at.clock;
  return !h || (c.minute === h.minute && (h.half !== null ? c.hour === h.hour : c.hour % 12 === h.hour % 12));
}

/**
 * A readback open or just said no to, as a stop by voice names it (`Later.stopSaid`): the threads it goes to (a start's
 * project, and "the new thread in" it), and its time (none for one that acts now).
 */
export type LaterReadback = { names: string[]; at: number | null };

/** `p`'s names and time, as a stop names it (`LaterReadback`): a start's project as `make` writes the rule's. */
export function readbackOf(p: { targets: { handle: string }[]; fields: { place?: string; at?: number } }): LaterReadback {
  const project = p.fields.place?.replace(/, on [\w-]+$/, "");
  return { names: [...p.targets.map((t) => t.handle), ...(project ? [project, `new thread in ${project}`] : [])], at: p.fields.at ?? null };
}

/**
 * Whether a stop's thread and time fit the readback open or just said no to (Fable's ruling on the seventh review of
 * 4-E): every word of the thread in one of its names, and the time its own, each when said; one that acts now has no time.
 */
export function fitsReadback(rb: LaterReadback, thread: string | null, at: AskedTime | null, zone: string, now: number): boolean {
  if (thread !== null && nameIn(rb.names, thread) === null) return false;
  return at === null || (rb.at !== null && fitsWhen(rb.at, at, zone, now));
}

/** What `stopSaid` says: its line, whether a rule was stopped now, and the one the line is about when it names one waiting. */
export type StopSaid = { line: string; stopped: boolean; only?: string[] };

/**
 * Two or more still to go that are the same to the user (Fable's nit on the second review of 4-E): the same words to the
 * same threads (or a start in the same project) at the same time, or after the same thread. Asking which can't be
 * answered, and either stopped is the same.
 */
function sameToUser(rules: LaterRule[]): boolean {
  const key = (r: LaterRule) => JSON.stringify([
    r.send?.message ?? null, r.start ? [r.start.placeId, r.start.message] : null, r.targets.filter((t) => t.state !== "done").map((t) => [t.itemId, wordsOf(r, t)]).sort(),
    // A chain (4-J) by the thread its step on now waits for, never its time.
    r.chain ? current(r).step!.after.itemId : null, r.chain ? null : r.at,
  ]);
  return rules.length > 1 && rules.every((r) => key(r) === key(rules[0]));
}

/** The name of `rule` that every word of `thread` is in (a thread it goes to, a new thread's project, the thread a chain waits for), or null. */
function fittingName(rule: LaterRule, thread: string): string | null {
  return nameIn([...rule.targets.map((t) => t.handle), ...(rule.start ? [rule.start.project, `new thread in ${rule.start.project}`] : []), ...afterNames(rule)], thread);
}

/** The one of `names` that every word of `thread` is in, or null. */
function nameIn(names: string[], thread: string): string | null {
  const said = keyWords(thread);
  if (!said.length) return null;
  return names.find((n) => { const words = new Set(keyWords(n)); return said.every((w) => words.has(w)); }) ?? null;
}

/**
 * More than three could be meant (4-E): "You have 5 waiting. Which thread's?"; but when they're all for one thread, the
 * one named or the only one each goes to (Fable's ruling on the review of 4-E), naming it again can't tell them apart, so
 * it asks the time: `You have 4 waiting for API. Which time?`. With a chain (never named by a time) or a new thread (for
 * no thread yet) among them, which thread's, as before.
 */
function manyLine(rules: LaterRule[], thread: string | null): string {
  const names = rules.map((r) => {
    if (r.chain || r.start) return null;
    if (thread !== null) return fittingName(r, thread);
    const left = r.targets.filter((t) => t.state !== "done");
    return left.length === 1 ? left[0].handle : null;
  });
  return names[0] !== null && names.every((n) => n === names[0]) ? manyFor(rules.length, names[0]) : manyWaiting(rules.length);
}

/** Every rule in the store this version reads; anything else in the table is left as it is. */
export function laterRules(store: Pick<Store, "ruleRows">): LaterRule[] {
  return store.ruleRows().flatMap((row) => {
    if (!row.id.startsWith(LATER_PREFIX)) return [];
    try {
      const r = JSON.parse(row.rule);
      return validLater(r) ? [r] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The Timeline's lines (Fable's 4-F), names always shown, a computer named with more than one (`computers`): "Scheduled
 * for API, 03:00 tomorrow: carry on (spoken yes)", "Sent to API at 03:00 by Quartz: carry on" (late: " (Quartz was asleep
 * at 03:00)"), "Started in driver at 14:00 by Quartz: Update the dependencies", "Not sent to API at 03:00: Quartz was
 * asleep", "Stopped: carry on, to API at 03:00"; not known, "API may not have your message of 03:00: Quartz stopped while
 * sending it" ("A new thread in driver may not have started at 14:00: Quartz stopped while starting it").
 */
export function laterTimeline(store: Pick<Store, "ruleRows">, computers: number): { key: string; at: number; text: string }[] {
  const out: { key: string; at: number; text: string }[] = [];
  for (const rule of laterRules(store)) {
    if (rule.chain) {
      out.push(...chainTimeline(rule, computers));
      continue;
    }
    const zone = rule.zone;
    const words = rule.send?.message ?? rule.start!.message;
    const to = rule.start ? `a new thread in ${rule.start.project}` : threadsNamed(rule.targets.map((t) => t.handle)) ?? `${rule.targets.length} threads`;
    out.push({ key: `${rule.id}:made`, at: rule.made.at, text: `Scheduled for ${to}, ${shownClock(rule.at, zone, rule.made.at)}: ${words} (${VIA_SAID[rule.made.via]})` });
    if (rule.stopped) out.push({ key: `${rule.id}:stopped`, at: rule.stopped, text: `Stopped: ${words}, to ${to} at ${shownClock(rule.at, zone, rule.stopped)}` });
    for (const t of rule.targets) {
      const done = t.done;
      if (!done || done.state === "cancelled") continue;
      const when = (at: number) => shownClock(at, zone, done.at);
      // Each after a colon or in brackets: one computer is "your computer" (Fable's nit on fix4).
      const c = computerOf(t.machine, computers);
      const lateWhy = done.code === "asleep" ? `${c} was asleep at ${when(rule.at)}` : done.code === "busy" ? `${t.handle} was busy at ${when(rule.at)}`
        : done.code === "app" ? `${done.app ?? "its app"} wasn't running at ${when(rule.at)}` : done.code === "unreached" ? `${c} couldn't be reached at ${when(rule.at)}` : null;
      if (done.state === "sent") {
        const fired = done.firedAt ?? rule.at;
        const late = fired - rule.at > 2 * MIN && lateWhy ? ` (${lateWhy})` : "";
        const by = computers > 1 ? ` by ${t.machine}` : "";
        out.push({ key: `${t.id}:sent`, at: fired, text: rule.start ? `Started in ${rule.start.project} at ${when(fired)}${by}: ${rule.start.title ?? words}${late}` : `Sent to ${t.handle} at ${when(fired)}${by}: ${words}${late}` });
      } else if (done.state === "unknown") {
        // It may have arrived (Fable's 4-G, and the review of stage 4): never "Not sent", which would have it sent again.
        out.push({ key: `${t.id}:unknown`, at: done.at, text: rule.start
          ? `A new thread in ${rule.start.project} may not have started at ${when(rule.at)}: ${c} stopped while starting it`
          : `${t.handle} may not have your message of ${when(rule.at)}: ${c} stopped while sending it` });
      } else {
        const why = lateWhy ?? reasonSaid({ code: done.code, app: done.app, machine: t.machine, computers }, t.handle);
        // Dropped before its time: what won't happen, as a call says it (the skeptic's nit on fix4), never past tense.
        const what = done.code === "dropped" && rule.at > done.at
          ? `Won't ${rule.start ? `start in ${rule.start.project}` : `go to ${t.handle}`}`
          : `Not ${rule.start ? `started in ${rule.start.project}` : `sent to ${t.handle}`}`;
        out.push({ key: `${t.id}:${done.state}`, at: done.at, text: `${what} at ${when(rule.at)}: ${why}` });
      }
    }
  }
  return out;
}

/**
 * A chain's Timeline lines (4-J; 4-F's forms with what it waited for): at the yes, each step, "Scheduled for API, when
 * Schema finishes: rebase and run the tests (spoken yes)"; "Sent to API at 14:12 by Quartz, after Schema finished: rebase
 * and run the tests" ("Started in driver at 14:12 …"); not sent, "Not sent to API: Schema failed" (or the computer's
 * reason); "Stopped: rebase and run the tests, to API when Schema finishes"; not known, as a send's.
 */
function chainTimeline(rule: LaterRule, computers: number): { key: string; at: number; text: string }[] {
  const out: { key: string; at: number; text: string }[] = [];
  const zone = rule.zone;
  const toOf = (t: LaterTarget) => (rule.start ? `a new thread in ${rule.start.project}` : t.handle);
  for (const [i, t] of rule.targets.entries()) {
    const s = t.step!;
    const words = wordsOf(rule, t);
    out.push({ key: i === 0 ? `${rule.id}:made` : `${t.id}:made`, at: rule.made.at, text: `Scheduled for ${toOf(t)}, when ${s.after.handle} finishes: ${words} (${VIA_SAID[rule.made.via]})` });
    const done = t.done;
    if (!done || done.state === "cancelled") continue;
    const when = (at: number) => shownClock(at, zone, done.at);
    // After a colon: one computer is "your computer", as a send's (Fable's nit on fix4).
    const c = computerOf(t.machine, computers);
    const by = computers > 1 ? ` by ${t.machine}` : "";
    if (done.state === "sent") {
      const fired = done.firedAt ?? done.at;
      out.push({ key: `${t.id}:sent`, at: fired, text: rule.start
        ? `Started in ${rule.start.project} at ${when(fired)}${by}, after ${s.after.handle} finished: ${rule.start.title ?? words}`
        : `Sent to ${t.handle} at ${when(fired)}${by}, after ${s.after.handle} finished: ${words}` });
    } else if (done.state === "unknown") {
      const at = done.firedAt ?? done.at;
      out.push({ key: `${t.id}:unknown`, at: done.at, text: rule.start
        ? `A new thread in ${rule.start.project} may not have started at ${when(at)}: ${c} stopped while starting it`
        : `${t.handle} may not have your message of ${when(at)}: ${c} stopped while sending it` });
    } else {
      const why = done.code !== undefined && CHAIN_WHYS.includes(done.code)
        ? chainDid(s.after.handle, done.code as ChainWhy, rule.chain!.watchMs, done.on ? { machine: done.on, computers, ...(done.app ? { app: done.app } : {}) } : undefined)
        : reasonSaid({ code: done.code, app: done.app, machine: t.machine, computers }, t.handle);
      out.push({ key: `${t.id}:${done.state}`, at: done.at, text: `Not ${rule.start ? `started in ${rule.start.project}` : `sent to ${t.handle}`}: ${why}` });
    }
  }
  if (rule.stopped) {
    const t = rule.targets.find((x) => x.done?.state !== "sent") ?? current(rule);
    out.push({ key: `${rule.id}:stopped`, at: rule.stopped, text: `Stopped: ${wordsOf(rule, t)}, to ${toOf(t)} when ${t.step!.after.handle} finishes` });
  }
  return out;
}
