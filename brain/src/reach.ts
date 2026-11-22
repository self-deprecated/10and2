// The reach policy (docs/launch/engine.md §3; stage 2a item 4): how 10 & 2 reaches you with the news of one fact, the
// same for every rule. Pure: what a reach-out is, which channel it goes on now, and what its notification says. The
// engine (engine.ts) keeps reach-outs and deliveries in the store and runs this; the phone's channels are senders it's
// given (the Ringer's VoIP push, and `NoteSend` for notifications, which the cloud plugs APNs into).
//
// Stage 2 builds §3's steps 1, 2, 5 and 6: in a call, told in the call; a phone holding for it takes it; a ring rule
// with a phone and Call me back on rings; anything else that tells is a notification, `active` with the default sound at
// any hour. Nothing is held back at night (no quiet hours are built in: §12, 8), and only a ring rule rings (§9). Stage
// 3.1 adds step 3 (a thread set to Nothing tells nothing but a call-back you asked for: following leaves it, engine.ts)
// and following's replies, batched (§3, Batching): the first after a quiet spell goes at its grace and opens a window,
// those in it go together as it closes, and each notification says every reply still unheard. Stage 3.3 adds the level
// (levels.ts): a call-back the level won't ring for (Commute's day used, or the call-back a hang-up set up by itself
// there), or with Call me back off, is a notification instead, and a question's
// notification has the agent's options as buttons only on Road Trip and up. Stage 3.6 adds a failed or stopped run
// ("API failed", from its status alone), a watch that ran out with a thread still working ("API is still working"),
// waiting for all of several threads ("All 3 threads are done"), and a duty due later than its fact (a call-back's
// "not before seven": its `from`), which reaches the user only from then. Stage 3.7 adds a computer gone offline with
// watched threads running (kind `offline`, offline.ts): a notification, or a call for a call-back asked for in words
// (`Duty.calls`), and its "back" in that notification's place. Stage 3.8 adds time: a check-in ("API is still working",
// "As of 15:00."), a deadline ("Not done by 18:00."), and a repeating time's briefing (kind `brief`, "Your briefing is
// ready", a line of counts and the rule it's from: a notification only, never a call, and nothing for a later call).
// Stage 3.9 adds Away (rules.ts `AwayRule`): its questions, failures and computers offline are notifications, never a
// call, with why "Away is on." (`Duty.via` "away"), and its end is one "Away ended" notification (`awayNoteOf`).
// Stage 3.10 adds tests passed or failed (receipts.ts, from the computer): a tests watch's title is what its tests did
// ("API's tests pass", "API replied, no test run seen"), a mid-run pass's body "It's still working.", and any reply a
// call-back or following tells whose last test run or build failed is "API replied, but its tests failed".
// Stage 3.4 adds your rules (my-rules.ts): a line's duty says why with the line ("Your rule: Let me know when…"), its
// questions and failures go at once (never in following's batch), and Privacy's "What agents ask and say" off leaves the
// agent's words out of every notification (`asks`). The end of a hold-back (the night line's, Quiet for a while's) is one
// notification of what's still unheard (`holdEndNoteOf`, kind `holdEnd`: `held` is a held command's).
// Stage 3.5 adds lines in your own words and judged ones (Fable's topics 12 and 16): a judged line's yes goes at once,
// "API is waiting on you" with the check's reason (`judgedNoteOf`), its why "Your rule: … Judged by AI."; one that
// couldn't be checked goes in following's batch, "Your rule: … Not checked."; example 2's "Nothing is running in
// driver" (`idleNoteOf`).
import { createHash } from "node:crypto";
import { ruleWhy } from "./my-rules.ts";
import { NOT_A_CALL_YET } from "./reader.ts";
import { offlineFor, offlineLine, offlineWhy, type Offline } from "./offline.ts";
import type { Security } from "./privacy.ts";
import { masked, speakable } from "./reading.ts";
import { noPassAfter, STILL_WORKING, testsTitle, type TestsFact } from "./receipts.ts";
import type { Seen } from "./store.ts";
import type { Fact } from "./later.ts";
import type { HeldCommand } from "./held-lines.ts";
import { FORBIDDEN } from "./user-text.ts";
import { spokenLength } from "./zone.ts";

/** How long every reach-out waits before it goes: a holding phone's long poll, or an answer at the keyboard, takes it. */
export const GRACE_MS = 6_000;
/**
 * A permission wait has no button (10 & 2 never grants one), so it waits a minute: one answered at the keyboard
 * meanwhile never reaches the phone. A ring keeps its 6 s.
 */
export const APPROVAL_MS = 60_000;
/** Untold news is kept this long; a question only while it's still open (`NEWS_MS`, §3 Deliveries). */
export const NEWS_MS = 24 * 3600_000;
/** A ring Apple accepted is missed unless its call-back is established within this (iOS rings 45 s, then connecting). */
export const MISSED_MS = 75_000;
/** A call-back that's connecting has this long to be established before its ring counts as missed. */
export const CONNECTING_MS = 30_000;
/** Dealt-with reach-outs (told or dropped) are kept this long past their news, then pruned. */
export const KEPT_MS = 7 * 86_400_000;
/**
 * Following's replies are batched (§3, Batching; `spike/question-sweep`'s numbers): the first after a quiet spell goes at
 * its grace, as a question does, and opens this window; when it closes, one notification goes for every reply gathered.
 */
export const BATCH_WINDOW_MS = 3 * 60_000;
/** After the window, the next reply notification goes no sooner than this after the last; any later, at its grace. */
export const BATCH_GAP_MS = 30 * 60_000;

/** Where the news of one fact goes. `kept`: for the next call (and the Timeline); nothing is sent. */
export type Channel = "call" | "ring" | "notification" | "kept";
/**
 * A delivery's channel: the reach policy's, or the quiet "Already answered." that takes an answered question's place.
 * `removal`: the background push an earlier build of this stage sent instead, to take it away; read as `answered`, so
 * a question it was sent for is never replaced as well. `back` (stage 3.7): a computer gone offline is back, told in the
 * offline notification's place or in the call it was told in, once.
 */
export type DeliveryChannel = Channel | "answered" | "removal" | "back" | "escalated";
export type Urgency = "urgent" | "normal" | "batched";

/**
 * One rule's part in a reach-out: the place that caused it (`via`: a thread you follow, one you set by hand to notify
 * you without following it, or a call-back), whether it may ring (a call-back the user asked for, about a thread they
 * asked about), whether it tells by notification (following's questions), its urgency, and from when. A batched duty
 * (following's replies) tells by its batch's notification, with `tell` false: a brain rolled back to stage 2a, which
 * would word a reply as a question ("API asks something"), keeps it for the next call instead. `pause` (stage 3.3): a
 * call-back a hang-up set up by itself (a pause, `made.via: "pause"`), not one asked for in words: it never takes
 * Commute's ring, and its why is that you were waiting for it. Older code ignores it. `calls` (stage 3.7): offline news a
 * call-back asked for in words may call for (the engine rings it itself, engine.ts `deliverOffline`); offline news's
 * duties keep `ring` and `tell` false, so older code keeps it for a call rather than ringing or wording it as a reply.
 */
export type Duty = {
  rule: string; via: "follow" | "set" | "callback" | "rule" | "away" | "list"; ring: boolean; tell: boolean; urgency: Urgency; from: number; pause?: true; calls?: true; said?: string; red?: true;
  /**
   * Stage 3.5, a judged line's duty: waiting for its check (`needs_you`, the thread's card; `judge`, a clause of your
   * own), then `yes` (told at once, "Judged by AI.") or `unchecked` (in following's batch, "Not checked."); a no takes
   * the duty away. Older code tells it as a line's reply. `night`: a line's call rings through the night line (example
   * 12, "even at night"); false for one that doesn't. `allow`: a call in your own words you haven't allowed yet (stage
   * 3.5, "Allowing a call"), told as its notification, whose why says so and whose tap opens How I read with Allow.
   */
  judged?: "needs_you" | "judge" | "yes" | "unchecked";
  night?: boolean;
  allow?: true;
};

/**
 * Why, as a notification says it on its last line (§2: every reach-out says why), by the place that caused it. The
 * title has just named the thread, so none names it again, and each reads the same with names hidden.
 */
const WHY: Record<Duty["via"], string> = { follow: "You follow it.", set: "You set it to notify you.", callback: "You asked to hear back.", rule: "Your rule.", away: "Away is on.", list: "It's on your list." };
/** A pause's call-back: "You asked to hear back." wouldn't be true (Fable, 3.3). */
const WHY_WAITING = "You were waiting for it.";
/** A pause's, for a notification about several threads ("…for them."). */
const WHY_WAITING_THEM = "You were waiting for them.";
/** Why, for a notification about several threads that are all followed. */
const WHY_FOLLOW_THEM = "You follow them.";

/**
 * A line in your rules (stage 3.4; Fable, topic 16): "Your rule: <the line, clipped at a word to 60>", or with thread
 * names hidden "Your rule." (`names`: a line may name a project). `said` is the line; `red` (example 3's and 12's): told
 * only if the run's last test run or build failed, read once at its end. Older code reads such a duty as "Your rule." and
 * tells it.
 */
const whyLine = (d: Duty, several: boolean, names: boolean) => (d.via === "callback" && d.pause ? (several ? WHY_WAITING_THEM : WHY_WAITING) : d.via === "rule" && d.said ? allowWhy(judgedWhy(ruleWhy(d.said, names), d.judged), d.allow) : WHY[d.via]);
/** A call in your own words not allowed yet (stage 3.5): "Your rule: <line, clipped as ever>. Not a call until you allow it." */
function allowWhy(why: string, allow: Duty["allow"]): string {
  return allow ? `${/[.!?]$/.test(why) ? why : `${why}.`} ${NOT_A_CALL_YET}` : why;
}
/** A judged line's why (Fable, topics 12 and 16): "Your rule: <line, clipped to 60>. Judged by AI." or "… Not checked." */
function judgedWhy(why: string, judged: Duty["judged"]): string {
  if (judged !== "yes" && judged !== "unchecked") return why;
  return `${/[.!?]$/.test(why) ? why : `${why}.`} ${judged === "yes" ? "Judged by AI." : "Not checked."}`;
}
/**
 * A notification's why lines: one for each place, in the order its duties were made (`several`: about several threads;
 * `names` false, thread names hidden: a line's is "Your rule.").
 */
export const whyOf = (duties: Duty[], several = false, names = true) => [...new Set(duties.map((d) => whyLine(d, several, names)))].join("\n");

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numberWord = (n: number) => NUMBER_WORDS[n - 1] ?? String(n);

/**
 * A call's opening news past its first three, counted, said exactly (the engine's stage 2b; Fable's 2b topic 3): "And
 * one more thread has news.", "And two more threads have news."
 */
export const moreNews = (n: number) => (n === 1 ? "And one more thread has news." : `And ${numberWord(n)} more threads have news.`);

/**
 * The quiet opening's one line when there's untold news (the phone's greeting "hello"; Fable's 2b topic 3), said exactly:
 * "Hi, I'm here. API has a question for you." / "Hi, I'm here. API has news." / "Hi, I'm here. Three threads have news."
 * Names alone, as the fixed lines say them.
 */
export function helloNews(items: { handle: string; question: boolean }[]): string {
  if (items.length === 1) return `Hi, I'm here. ${items[0].handle} ${items[0].question ? "has a question for you" : "has news"}.`;
  const n = numberWord(items.length);
  return `Hi, I'm here. ${n[0].toUpperCase()}${n.slice(1)} threads have news.`;
}

/**
 * How a thread stood at a check-in (stage 3.8). `held`: holding a command for the user (Commands that wait, stage 4c),
 * waiting for them, never working (Fable's ruling on pass B1's review).
 */
export type Standing = "working" | "held" | "replied" | "failed" | "stopped" | "asks" | "idle";

/** What a reach-out is about: one thread, and (for a question) which question and what kind. */
export type News = {
  itemId: string;
  handle: string;
  /** The computer it's on, as said ("Quartz"), when the brain has more than its own. */
  machine?: string;
  question?: { id: string | null; kind: "input" | "approval" | null };
  /** What hearing it marks (`Store.markSeen`): the run and question it was. */
  seen: Seen;
  /** A reply whose run failed, or was stopped (cancelled): its status, never its words (stage 3.6). */
  status?: "failed" | "stopped";
  /**
   * A call-back that ran out with threads still working (stage 3.6, Fable's topic 7): their names, how many of its
   * threads were done (`done` of `total`, for one waiting for all) and how long it watched. Older code reads it as a reply.
   * `offline`: those of them on a computer offline then, last (the Skeptic's finding on 3.6 to 3.8), not known to be.
   * `late`: those of them a deadline's look came after (a late wake, a restart) whose run ended after it (the fourth
   * review of 3.6 to 3.8): not done by then, done now ("API finished late"), counted in `done`. Older code reads them
   * as still working. `held`: those of them holding a command for the user then (Commands that wait, stage 4c): waiting
   * for them, never counted as still working (Fable's ruling on pass B1's review).
   */
  still?: { working: string[]; done: number; total: number; waitedMs: number; by?: number; offline?: { handle: string; machine: string }[]; late?: string[]; held?: { itemId: string; handle: string }[]; tests?: true };
  /**
   * Stage 3.10: what a call-back's reply's tests did, from the computer, decided as its wait was over (receipts.ts
   * `testsOf`): its title and caller line, and what its call-back says first. Older code ignores it. `still.tests`: a
   * tests watch that ran out ("No passing test run after 4 hours.").
   */
  tests?: TestsFact;
  /**
   * A check-in's news (stage 3.8; Fable, topic 14): when it fell (`at`) and how each of its threads stood then, of
   * `total`, how long after it was asked (`waitedMs`); `handle` and `itemId` are its first thread's. Older code reads it
   * as that thread's reply. A thread working as last seen on a computer offline then has its computer (`offline`).
   */
  check?: { at: number; standing: { itemId: string; handle: string; state: Standing; offline?: string }[]; total: number; waitedMs?: number };
  /**
   * A repeating time's briefing (stage 3.8, kind `brief`; example 6's words, Fable's topic 16): since when it counts,
   * how many threads ask, failed and replied since, and the rule's line, its why. `itemId` is the rule's.
   */
  brief?: {
    since: number; asks: number; failed: number; replied: number; line: string;
    /**
     * Stage 4 (Fable's 4-I): its time (the look-back's end), a summary or each reply in full, and the threads it tells in
     * the order it tells them, from the same facts as its counts: what the briefing made ahead says. Older code ignores them.
     */
    until?: number; as?: "summary" | "full"; ids?: string[];
  };
  /** A computer gone offline (stage 3.7, kind `offline`): `handle` and `machine` are its name, `itemId` its newest thread's. */
  offline?: Offline;
  /**
   * What became of a send or a start set up for later (stage 4b, kind `later`): sent, missed past its window, not sent
   * by the computer's checks, or not known; `itemId` and `handle` are its thread's (a start's: its rule's, and its project).
   */
  later?: Fact;
  /**
   * A command the thread holds until the user lets it run from the phone (Commands that wait, kind `held`): what it
   * would run and since when (`held-lines.ts`). Its question is the hold's own id.
   */
  held?: HeldCommand;
  /**
   * Example 2 (stage 3.5): nothing in a project is running or waiting for you any more. `handle` is the project's name,
   * `itemId` the line's rule; `say`, the reminder your line asked for ("push to Prod"). Older code reads it as a reply.
   */
  idle?: { project: string; say?: string };
};

/**
 * The news of one fact, kept until it's heard or expires (§3). Written with the firing; its news never changes after;
 * rules seeing it later add a duty. `ask` and `choices`: the question's words (the agent's own for one its work system
 * holds with options, else its card's ask) and its own options, read once during the grace (`asked` says it was);
 * `conversationId`: the call-back's conversation, for a ring rule's; `tapped`: a tap on one of its notification's
 * buttons reached the brain, whatever became of it, so the line after the tap took the notification's place (nothing to
 * replace); `grouped`: its notification was one about several threads (a missed call-back's), under the call-back's
 * collapse id, not its own, so no notification of its own is there to replace. `words`: a reply's opening words, on one
 * line (`openingOf`), read once (`asked` says it was), for its notification. `back` (stage 3.7, kind `offline`): when its
 * computer was seen reporting again, so its down time is over and the next is a new fact. `rangFor` (kind `offline`):
 * the conversation its call rang, written with the attempt, since one down time is shared by every call-back watching
 * there (the fourth review of 3.6 to 3.8): the call answered there, and its missed call's Call back, are that
 * conversation's.
 */
export type ReachOut = {
  v: 1;
  key: string;
  at: number;
  kind: "reply" | "question" | "offline" | "brief" | "later" | "held";
  conversationId?: string;
  news: News;
  duties: Duty[];
  asked?: boolean;
  ask?: string | null;
  choices?: string[];
  words?: string | null;
  state: "untold" | "told" | "dropped";
  keepUntil: number;
  tapped?: boolean;
  grouped?: boolean;
  back?: number;
  rangFor?: string;
  /**
   * Stage 3.10: a followed reply's run's last test run or build failed, read with its words (`words`): its title says so.
   * Null when that report was read and said nothing of it.
   */
  tests?: TestsFact | null;
  /**
   * A held command answered from this phone (kind `held`; `POST /api/held`): let run or stopped, and how it was let run
   * (Face ID, or unlocked), so the line in its notification's place and the Timeline say so. Older code ignores it.
   */
  answer?: { run: boolean; how?: "faceid" | "unlocked"; at: number };
  /** When a held command's hold ended (kind `held`), and how, as the brain saw it: what the Timeline and its line say. */
  ended?: { at: number; end: "run" | "stop" | "timeout" | "elsewhere" };
  /**
   * A reply's own, read with its words (kind `reply`; Fable's 4-K): which message it is (`messageId`, when its work
   * system says), so a write from its notification goes only while it's still the thread's latest, and whether it ends
   * with a question (`asks`: its last non-empty line ends with "?"), so a quick reply never answers one. Null when its
   * report couldn't be read or was an older reply's. Older code ignores it.
   */
  reply?: { messageId: string | null; asks: boolean } | null;
  /**
   * A briefing's (kind `brief`, stage 4; Fable's 4-I): the briefing made ahead for it, kept as a reading
   * (briefing-reading.ts `prepareSince`), which its notification's Hear it plays. Older code ignores it.
   */
  briefing?: string;
  /**
   * When its briefing started being made ahead (kind `brief`), kept so a brain evicted while it was made counts the 2
   * minutes its notification waits for it from the first try (engine.ts `MAKE_MS`). Older code ignores it.
   */
  making?: number;
  /** Stage 3.4: when the app opened on its thread (a question's escalation, example 11, is called off by it). */
  opened?: number;
  /** Stage 3.5: a judged line's yes, its check's reason (the card's ask, or the clause's why), for its notification. */
  reason?: string | null;
};

/**
 * Whether a reply ends with a question, by code alone (relay's check, never a model's): its last non-empty line, trimmed,
 * ends with "?" (or the full-width "？"), perhaps then "!" ("?!"). Read past what follows a question in the way agents
 * write (Fable, 4-K's review and second review; the skeptic's): last lines that are only a code fence or a horizontal
 * rule, then at its end emphasis marks, quotes, emoji and spaces, a smiley (":)"), a parenthesis, square or angle
 * brackets right after the question ("(y/n)", "[y/N]", "<y/n>") and closing brackets, so "**Should I proceed?**", "Do
 * you want X? (y/n)", "Proceed? [y/N]" and "Ship it? 🚀" ask. A question followed by a list of options doesn't (no
 * classifier in stage 4): erring that way keeps "Carry on" off only a reply that asks (Fable's 4-K).
 */
export function endsAsking(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  while (lines.length > 1 && (FENCE.test(lines.at(-1)!) || RULE.test(lines.at(-1)!))) lines.pop();
  // Its end only: the regexes below take time that grows with the square of a long run of spaces (the skeptic, 4-K's
  // third review), and a question's ending, a long parenthesis after it included, fits well within this.
  let last = (lines.at(-1) ?? "").slice(-ASKING_TAIL);
  for (let was = ""; was !== last; ) {
    was = last;
    last = last.replace(MARKS, "").replace(SMILEY, "").replace(AFTER_ASKING, "");
    // A closing bracket alone, once nothing else is left to take: "(Should I deploy?)".
    if (last === was) last = last.replace(CLOSER, "");
  }
  return /[?？][!！]*$/.test(last);
}
/** How much of the last line's end `endsAsking` reads. */
const ASKING_TAIL = 500;
/** A line that is only a code fence (its info string, if any): one closing a block after the question. */
const FENCE = /^(`{3,}|~{3,})[\w+-]*$/;
/** A line that is only a horizontal rule: "---", "***", "___", "* * *". */
const RULE = /^([-*_])(\s*\1){2,}$/;
/** Emphasis marks, quotes, emoji (with their joiners and modifiers) and spaces at a line's end. */
const MARKS = /[\s*_~`"'“”‘’«»\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]+$/u;
/** A smiley at a line's end: ":)", ":-)", ";)", ":D", ":P". */
const SMILEY = /\s*[:;]-?[)DPp]$/u;
/** A parenthesis, square or angle brackets right after the question at a line's end, "Deploy it? (y/n)", "Proceed? [y/N]". */
const AFTER_ASKING = /(?<=[?？][!！]*)\s*(\([^()]+\)|\[[^[\]]+\]|<[^<>]+>)$/u;
/** A closing bracket at a line's end. */
const CLOSER = /[)\]}]$/;

/**
 * The buttons a notification about one thread's reply offers for writing back (Fable's 4-K), on limits that answer from
 * a notification (`answers`), to a phone that registers the write categories (`writes`: a build that says so when it
 * registers; an older one has only `REPLY`, so it keeps its Call back), the thread as it stands now (`busy`: running
 * again, asking, or gone): a reply that asks nothing, with the thread stopped and not asking, the user's quick replies,
 * Reply… and Call back (`REPLY_QUICK`); one ending with a question, a failed or stopped run, one whose tests or build
 * failed, or a reply whose words weren't read, Reply… and Call back (`REPLY_TEXT`, never a "Carry on" that answers
 * nothing); a tests pass while it still works, a thread busy now, Commute's limits or an older phone, Call back alone
 * (`REPLY`).
 */
export function writesOf(r: ReachOut, o: { answers?: boolean; writes?: boolean; busy?: boolean }): (typeof CATEGORY)["reply" | "replyText" | "replyQuick"] {
  if (!o.answers || !o.writes || o.busy || r.kind !== "reply" || r.news.still || r.news.check) return CATEGORY.reply;
  const tests = r.news.status ? null : (r.news.tests ?? r.tests ?? null);
  if (tests?.running) return CATEGORY.reply;
  if (r.news.status || tests?.state === "failed" || tests?.state === "build" || !r.reply || r.reply.asks) return CATEGORY.replyText;
  return CATEGORY.replyQuick;
}

/**
 * One attempt on one channel: the primary key (key, channel) allows one ever. `sending` until the push's answer is
 * written; one still `sending` at a restart is `unknown`, and never tried again. A ring: `missedAt` is when, unanswered,
 * its notification goes; `callback`, the call-back it led to.
 */
export type Delivery = {
  key: string;
  channel: DeliveryChannel;
  state: "sending" | "accepted" | "refused" | "gone" | "unknown";
  at: number;
  acceptedAt?: number;
  missedAt?: number;
  callback?: "connecting" | "established";
};

/** What the policy needs to know of now (§3, `Situation`, stage 2's part). */
export type Situation = {
  /** The live call's conversation, if a call is on. */
  inCall: string | null;
  /** Conversations a phone is holding for (`/api/wait`). */
  holding: readonly string[];
  /** A ring can go: this brain can push, a phone registered for rings (Call me back on), and the level rings for it. */
  ring: boolean;
  /** A notification can go: the engine is on for the account (its gate), and a phone with Notifications on. */
  notify: boolean;
};

/**
 * Whether a reach-out waits for following's batch (§3, Batching): a reply following told, which no call-back the user
 * asked for shares (one asked for goes at once, at the louder channel, with both whys, and isn't in the batch as well).
 */
export function batched(r: ReachOut, now = Infinity): boolean {
  // Away's failure (stage 3.9) goes at once, not in following's batch; so does the reply after a write from a
  // notification (Fable's 4-K: "You were waiting for it.", its duty `R-wrote:`), followed or not, and a line's failure
  // (stage 3.4).
  return r.kind === "reply" && r.duties.some((d) => d.urgency === "batched") && !r.duties.some((d) => (d.ring && d.from <= now) || d.via === "away" || d.rule.startsWith(WROTE_RULE) || (d.via === "rule" && d.urgency === "urgent"));
}

/**
 * A write from a notification's rule (Fable's 4-K), one per thread (`R-wrote:<thread>`, engine.ts `wrote`): that thread's
 * next reply notifies once, with no row of its own.
 */
export const WROTE_RULE = "R-wrote:";

/**
 * When a reach-out may go: its grace, or a permission wait's minute when nothing in it rings, from its fact or, when
 * every duty on it is due later (a call-back's not-before, stage 3.6), from the first of them.
 */
export function dueOf(r: ReachOut): number {
  const approval = r.news.question?.kind === "approval" && !r.duties.some((d) => d.ring);
  return Math.max(r.at, Math.min(...r.duties.map((d) => d.from))) + (approval ? APPROVAL_MS : GRACE_MS);
}

/** `r` with only the duties due by `now` (stage 3.6): a call-back's not yet due, before its not-before, has no say. */
export function dueNow(r: ReachOut, now: number): ReachOut {
  const due = r.duties.filter((d) => d.from <= now);
  return due.length === r.duties.length ? r : { ...r, duties: due };
}

/**
 * The channel a reach-out goes on now, loudest first, from every duty in it (duties that came in one grace merge into
 * one delivery at the loudest channel any of them allows). Nothing is held back by itself, and `ring` only for a duty
 * that may ring. A call-back that can't ring now (Call me back off, or the level: §11, 3.3) is a notification instead.
 */
export function reach(r: ReachOut, s: Situation): Channel[] {
  if (s.inCall) return ["call"];
  if (r.conversationId && s.holding.includes(r.conversationId)) return [];
  if (s.ring && r.duties.some((d) => d.ring)) return ["ring"];
  if (s.notify && r.duties.some((d) => d.tell || d.ring || d.urgency === "batched")) return ["notification"];
  return ["kept"];
}

/** The most buttons a question's notification offers for its answers (with Call back, iOS's most of four). */
export const ANSWERS_MAX = 3;
/** The longest answer a button shows whole; a question with a longer option gets no buttons. */
export const ANSWER_CHARS = 40;

/**
 * The buttons a question's notification offers: every one of its own options as its work system lists them
 * (`Report.choices`), so a tap selects that option, or none at all. None for more than three (a button for some would
 * hide the rest), one longer than a button shows, empty, two alike, masked as a credential, or naming the AI provider.
 */
export function tapChoices(choices: string[] | null | undefined): string[] {
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > ANSWERS_MAX) return [];
  const ok = choices.every((c) => typeof c === "string" && c.trim() === c && c.length > 0 && c.length <= ANSWER_CHARS && !/[\r\n]/.test(c) && masked(c) === c && !FORBIDDEN.test(c));
  return ok && new Set(choices.map((c) => c.toLowerCase().replace(/\s+/g, " "))).size === choices.length ? [...choices] : [];
}

/** A question's words as a notification may show them: masked, and never naming the AI provider; null otherwise. */
export function askShown(ask: string | null | undefined): string | null {
  const said = ask ? masked(ask).trim() : "";
  return said && !FORBIDDEN.test(said) ? said : null;
}

/** The most of a question's own words a notification shows: whole in its detail view, well inside APNs's 4 KB. */
export const ASK_CHARS = 500;

/**
 * The question a work system holds open with its own options (`Report.question` with `Report.choices`: the one the
 * buttons answer), in the agent's own words, as a notification shows them: without the options the connector adds in
 * words (the body says them once), as `askShown` allows, on one line, and clipped to `ASK_CHARS`. Null for no held
 * question with options, or nothing of it to show.
 */
export function heldAsk(question: string | null | undefined, choices: string[] | null | undefined): string | null {
  if (!question || !choices?.length) return null;
  const suffix = ` Options: ${choices.join(" / ")}.`;
  const own = askShown((question.endsWith(suffix) ? question.slice(0, -suffix.length) : question).replace(/\s+/g, " "));
  const chars = own ? [...own] : [];
  return chars.length <= ASK_CHARS ? own : `${chars.slice(0, ASK_CHARS - 1).join("").replace(/\s+\S*$/, "")}…`;
}

/** A digest that fits APNs's 64-byte collapse id. */
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/** A question's collapse id: its own (the thread and the question), never the rule's, so two questions are two. */
export const questionCollapse = (itemId: string, question: string) => `q-${digest(`${itemId}\n${question}`)}`;
/** Anything else's: per rule. */
export const ruleCollapse = (rule: string) => `r-${digest(rule)}`;

/**
 * The categories the app registers (docs/launch/engine.md §6): a question with the agent's own options as buttons
 * (the notification service extension builds them, by `auth`), one with none (Call back), a permission wait (no button),
 * a missed call-back (Call back), and a followed thread's reply (Call back, stage 3.1).
 */
export const CATEGORY = {
  question: "QUESTION", open: "QUESTION_OPEN", approval: "APPROVAL", missed: "MISSED_CALL", reply: "REPLY", approve: "APPROVE",
  // Stage 4b (Fable's 4-F, 4-G): a send or start for later that went (no buttons), one missed past its window (Send now
  // or Start now, and Don't), and one not sent or not known to have gone (no buttons; a tap opens it).
  sent: "SENT_LATER", missedSend: "LATER_MISSED", missedStart: "LATER_MISSED_START", notSent: "LATER_NOT_SENT",
  // Commands that wait (Fable's 4-H2): Let it run (it opens the app) and Stop it.
  held: "HELD",
  // Quick replies and Reply… (Fable's 4-K), on a notification about one thread on limits that answer from one: a reply
  // that asks nothing (the user's quick replies, Reply…, Call back), one that asks or failed (Reply…, Call back), and a
  // held question with no options of its own (Reply…, Call back). The app registers them with its own quick replies and
  // Privacy's level; `REPLY` stays Call back only.
  replyQuick: "REPLY_QUICK", replyText: "REPLY_TEXT", questionReply: "QUESTION_REPLY",
  // A briefing ready (Fable's 4-I, 4-L): Hear it, which plays it (it opens the app at every Privacy level: it sends nothing).
  briefing: "BRIEFING",
} as const;

/**
 * An alert push: what a notification says and does. Its payload is the cloud's (cloud/src/apns.ts). A computer gone
 * offline (stage 3.7) has a category only with Call back; its "back" is `passive`, with no sound.
 */
export type Note = {
  type: "alert";
  kind: "question" | "approval" | "missed" | "reply" | "offline" | "back" | "brief" | "away" | "approve" | "later" | "held" | "holdEnd";
  category?: (typeof CATEGORY)[keyof typeof CATEGORY];
  collapseId: string;
  interruption: "active" | "passive";
  sound?: "default";
  /** When Apple may drop it undelivered: when its news would be dropped (ms). */
  expiresAt: number;
  title: string;
  /** What it says, each part on its own line: the question, then its options in words. */
  body: string;
  /** Why it came ("You follow it."): the body's last line, kept on its own too, so the app can leave it out. */
  why: string;
  /** The thread's name, with names shown: the title of the line a tap leaves in its place. */
  thread?: string;
  /** A reply's about one thread: the thread a tap on it opens. About several, none: it opens Home. */
  item?: string;
  /** The agent's own options, as buttons; none for a question without them, a permission wait or a missed call-back. */
  choices: string[];
  /** A question's: Privacy's "Check it's you before sending", which picks its buttons' options (§6). */
  auth?: Security;
  /** The reach-out its Call back opens (`POST /api/session {mode: "callback", reachOut}`). */
  reachOut: string;
  conversationId?: string;
  /**
   * The question it's about, whenever it has an id: what a tap on one of `choices` answers (`POST /api/reply` with
   * `questionId`), and what the app's own look takes it away by once the thread no longer asks it.
   */
  question?: { itemId: string; questionId: string };
  /**
   * "Approve to send" (stage 2b, kind `approve`): the send waiting for Face ID it approves, by its proposal's or kept
   * reply's id (`POST /api/approvals/:id`), and its words as shown (`text`, for the line once it's sent). Its category's
   * Approve opens the app (Face ID), Don't send never asks.
   */
  approve?: { id: string; text: string };
  /** A send or start for later that didn't go (stage 4b): its words kept in Drafts, which Send now and Don't act on. */
  kept?: string;
  /** Its words, clipped (names shown only): what the line after Send now says it sent ("Sent: carry on"). */
  words?: string;
  /** A held command (Commands that wait): what the app's sheet shows, opened from Let it run or a tap on it. */
  held?: { command: string; matched: string };
  /**
   * A question with one or two options of its own (Fable's 4-K): the extension adds Reply… after them, for an answer in
   * the user's own words. Never with three (four buttons are iOS's most), nor on a missed call's.
   */
  typed?: true;
  /** A briefing ready (stage 4): the briefing made ahead, which Hear it, or a tap, plays; fetched ahead by the phone. */
  briefing?: string;
  /** A call in your own words not allowed yet (stage 3.5): a tap opens How I read your rules, with Allow. */
  allow?: true;
};

/**
 * The line that takes an answered question's place (§11, Answered elsewhere): a quiet alert under the question's own
 * collapse id, so Apple swaps it in. "Already answered." is always true: the brain knows the question is no longer
 * open, not where it was answered.
 */
export type Answered = { type: "answered"; collapseId: string; reachOut: string; title: string; body: string; expiresAt: number };

/** A phone's alert token, and which of Apple's push services it's for. */
export type AlertPhone = { token: string; env: "sandbox" | "production" };

/** Sends one alert push; `gone`: Apple says the alert token is no longer the app's, so it's forgotten. */
export type NoteSend = (phone: AlertPhone, push: Note | Answered) => Promise<"sent" | "gone" | "failed">;

/** The options in words, for the body: "Rebase · Merge". */
const inWords = (choices: string[]) => choices.join(" · ");

/**
 * The collapse id of a reach-out's notification: a question's own, else per rule. A reply asked for as well as followed
 * goes alone, under its call-back's, so it doesn't take the place of following's batch.
 */
export function collapseOf(r: ReachOut): string {
  if (r.kind === "question") return questionCollapse(r.news.itemId, r.news.question?.id ?? r.key);
  return ruleCollapse((r.duties.find((d) => d.via === "callback") ?? r.duties[0])?.rule ?? r.key);
}

/**
 * What a question's notification says (§11, stage 2): "API asks", the question (the agent's own words for one its work
 * system holds with options, else as its card asks it), then its options in words, so the choice reads before any
 * press, then why; the buttons are the options, only with a question to read above them. With no words to show (none
 * read, or they name the provider), "API asks something", why, and Call back. A permission wait: "API is waiting for
 * your OK", what it wants, where to answer it, and why, with no button. With names hidden (Privacy), no thread's name.
 * `answers` false (a level without answering from a notification: Commute, §11 3.3): the same, with Call back only, so
 * nothing looks withheld. From stage 4 (Fable's 4-K), where it answers from a notification to a phone that registers the
 * write categories (`writes`): one or two options get Reply… after them (`typed`), and a question it shows with no
 * buttons of its own (none, or options that don't fit on them) gets Reply… and Call back (`QUESTION_REPLY`); a reply's
 * notification gets its write buttons by `writesOf` (`busy`: the thread as it is now).
 */
export function noteOf(r: ReachOut, o: { names: boolean; security: Security; machine?: string; answers?: boolean; writes?: boolean; busy?: boolean; asks?: boolean }): Note {
  if (r.kind === "reply") return replyNoteOf([r], o, collapseOf(r), whyOf(r.duties, false, o.names));
  const name = o.names ? r.news.handle : null;
  const base = {
    type: "alert" as const, collapseId: collapseOf(r), interruption: "active" as const, sound: "default" as const, expiresAt: r.keepUntil,
    why: whyOf(r.duties, false, o.names) || WHY.follow, reachOut: r.key, ...(name ? { thread: name } : {}), ...(r.conversationId ? { conversationId: r.conversationId } : {}),
  };
  // What agents ask and say off (Privacy, stage 3.4; Fable, topic 13): none of the agent's words, and no answers.
  const ask = o.asks === false ? null : askShown(r.ask);
  const asks = r.news.question?.id ? { question: { itemId: r.news.itemId, questionId: r.news.question.id } } : {};
  if (r.news.question?.kind === "approval") {
    const where = o.machine ?? r.news.machine;
    return {
      ...base, ...asks, kind: "approval", category: CATEGORY.approval, choices: [],
      title: name ? `${name} is waiting for your OK` : "A thread is waiting for your OK",
      body: [ask, `Answer it on ${where ?? "your computer"}.`].filter(Boolean).join("\n"),
    };
  }
  const choices = ask && r.news.question?.id && o.answers !== false ? tapChoices(r.choices) : [];
  const options = ask && r.choices?.length && r.choices.every((c) => askShown(c) === c) ? inWords(r.choices) : "";
  // Reply… (Fable's 4-K): only where answering from a notification is on (`answers` true: a missing one is an older
  // caller's, which never offered it), and only under a question it shows, so the words answer something read: one
  // whose options don't fit on buttons (four or more, or too long) too, as they're listed in its body (Fable, 4-K's
  // review). Its own category only to a phone that registers it (`writes`): an older one keeps `QUESTION_OPEN`'s Call
  // back; `typed` after options is the extension's, which an older one ignores.
  const typed = o.answers === true && !!ask && !!r.news.question?.id;
  const category = choices.length ? CATEGORY.question : typed && o.writes === true ? CATEGORY.questionReply : CATEGORY.open;
  return {
    ...base, kind: "question", category, choices, auth: o.security,
    title: ask ? (name ? `${name} asks` : "A thread asks") : name ? `${name} asks something` : "A thread asks something",
    body: ask ? [ask, options].filter(Boolean).join("\n") : "",
    ...asks, ...(typed && choices.length > 0 && choices.length < ANSWERS_MAX ? { typed: true as const } : {}),
  };
}

/**
 * A missed call-back's notification (§3, Missed rings; stage 2a item 8): "You missed a call", what it was about, then
 * why it called, from the news of the ring nobody answered (`rs`, one reach-out per fact it rang for). One whose news
 * is a single open question with the agent's own options carries its buttons as well as Call back, as a question's own
 * notification would, under the question's collapse id (so "Already answered." takes its place); anything else has
 * Call back, collapsed per rule (`rule`, the call-back's). `answers` false (Commute): Call back only. About several
 * threads, what each kind of news is (`severalNews`): a question is never hidden inside "replied".
 */
export function missedNoteOf(rs: ReachOut[], rule: string, o: { names: boolean; security: Security; answers?: boolean; caller?: string; asks?: boolean }): Note {
  const name = (r: ReachOut) => (o.names ? r.news.handle : "A thread");
  // A held command's call was the call-back's (`Engine.ringHeld`), or a line's (your rule's): its why, not the list's.
  const why = whyOf(rs.flatMap((r) => (r.kind === "held" ? r.duties.filter((d) => (r.rangFor ? d.via === "callback" : d.via === "rule" && d.calls)) : r.duties)), rs.length > 1, o.names) || WHY.callback;
  const one = rs.length === 1 ? rs[0] : null;
  const question = one?.kind === "question" ? one : null;
  const ask = question && o.asks !== false ? askShown(question.ask) : null;
  const choices = question && ask && question.news.question?.id && question.news.question.kind !== "approval" && o.answers !== false ? tapChoices(question.choices) : [];
  const options = ask && question?.choices?.length && question.choices.every((c) => askShown(c) === c) ? inWords(question.choices) : "";
  // The call's own caller line, as a sentence (stage 3.6: "All 3 threads are done.", "API failed."), for news with no
  // question in it; a question is never hidden inside it.
  const news = o.caller && !rs.some((r) => r.kind === "question") ? `${o.caller}.`
    : !one ? severalNews(rs, o.names, o.asks !== false)
    : !question ? `${name(one)} ${one.kind === "held" || one.news.still?.held?.some((h) => h.handle === one.news.handle) ? `is ${WAITING_FOR_YOU}` : one.news.still ? "is still working" : one.news.status === "failed" ? "failed" : one.news.status === "stopped" ? "was stopped" : "replied"}.`
    : question.news.question?.kind === "approval" ? `${name(one)} is waiting for your OK.`
    : ask ? [`${name(one)} asks: ${ask}`, options].filter(Boolean).join("\n") : `${name(one)} asks something.`;
  return {
    type: "alert", kind: "missed", category: choices.length ? CATEGORY.question : CATEGORY.missed,
    collapseId: question ? collapseOf(question) : ruleCollapse(rule), interruption: "active", sound: "default",
    expiresAt: Math.max(...rs.map((r) => r.keepUntil)), title: "You missed a call", body: news, why, choices,
    ...(choices.length ? { auth: o.security } : {}), ...(one && o.names ? { thread: one.news.handle } : {}),
    ...(question?.news.question?.id ? { question: { itemId: question.news.itemId, questionId: question.news.question.id } } : {}),
    reachOut: rs[0].key, ...(rs[0].conversationId ? { conversationId: rs[0].conversationId } : {}),
  };
}

/** The most of the one asking thread's question a missed call about several threads shows. */
export const MISSED_ASK_CHARS = 80;

/**
 * What a missed call about several threads says (Fable, 18 November): one line per kind of news, in this order, a kind
 * with no threads left out: who asks ("API asks: <its question on one line, clipped at a word>", or "API asks
 * something.", with no options; "API and Docs ask."), who is waiting for an OK ("Deploy is waiting for your OK."), who
 * replied ("Schema replied."; "Docs and Schema replied."), each group's names newest first (`namesLine`). Names hidden,
 * the same lines with counts: "A thread asks: …", "2 threads ask.", "A thread replied.". Every one a reply stays
 * "<N> threads replied.".
 */
function severalNews(rs: ReachOut[], names: boolean, asked = true): string {
  const newest = [...rs].sort((a, b) => b.at - a.at);
  const asks = newest.filter((r) => r.kind === "question" && r.news.question?.kind !== "approval");
  const waits = newest.filter((r) => r.kind === "question" && r.news.question?.kind === "approval");
  const replies = newest.filter((r) => r.kind === "reply");
  if (!asks.length && !waits.length) return `${rs.length} threads replied.`;
  const one = (r: ReachOut) => (names ? r.news.handle : "A thread");
  const who = (g: ReachOut[]) => (names ? namesLine(g.map((r) => r.news.handle)) : `${g.length} threads`);
  const ask = asks.length === 1 && asked ? askShown(asks[0].ask)?.replace(/\s+/g, " ") : null;
  return [
    asks.length === 1 ? (ask ? `${one(asks[0])} asks: ${clip(ask, MISSED_ASK_CHARS)}` : `${one(asks[0])} asks something.`) : asks.length ? `${who(asks)} ask.` : "",
    waits.length === 1 ? `${one(waits[0])} is waiting for your OK.` : waits.length ? `${who(waits)} are waiting for your OK.` : "",
    replies.length === 1 ? `${one(replies[0])} replied.` : replies.length ? `${who(replies)} replied.` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The line that takes an answered question's place: titled with the thread alone (no "asks"), as the line after a tap
 * is, and "Already answered."; with names hidden, "A thread". It lapses with the question's news.
 */
export function answeredOf(r: ReachOut, o: { names: boolean }): Answered {
  return { type: "answered", collapseId: collapseOf(r), reachOut: r.key, title: o.names ? r.news.handle : "A thread", body: "Already answered.", expiresAt: r.keepUntil };
}

/**
 * What a write from a notification's quick reply or Reply… that didn't go says in its place (Fable's 4-K), shown only
 * (the phone shows it under the thread's name): the thread moved on since that reply (it replied again, runs, asks
 * something, or you wrote in it), "Not sent: API has moved on. Open 10 & 2 to reply." for a quick reply, "… Your reply
 * is in Drafts." for typed words, which are kept there; names hidden, "a thread has moved on". Its computer offline,
 * "Not sent: Quartz is offline. Your reply is in Drafts." (one computer: "your computer"), a quick reply's kept too.
 */
export function notWrittenLine(o: { why: "moved_on" | "offline"; thread: string; names: boolean; machine: string | null; computers: number; typed: boolean }): string {
  if (o.why === "offline") return `Not sent: ${o.computers > 1 && o.machine ? o.machine : "your computer"} is offline. Your reply is in Drafts.`;
  return `Not sent: ${o.names ? o.thread : "a thread"} has moved on. ${o.typed ? "Your reply is in Drafts." : "Open 10 & 2 to reply."}`;
}

/** The most of a reply's opening words a notification about one thread shows (§11, 3.1), cut at a word with no "…". */
export const OPENING_CHARS = 140;
/** Each thread's line in a notification about two. */
export const OPENING_LINE_CHARS = 80;
/** The most of them kept on the reach-out: enough for either. */
const WORDS_KEPT = 500;

/** `text` cut at a word to `max` characters, with "…" when it's cut (`mark` false: without it). */
export function clip(text: string, max: number, mark = true): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, mark ? max - 1 : max).join("");
  const word = head.replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "");
  return mark ? `${word || head}…` : word || head;
}

/**
 * A reply's opening words, as a notification shows them (§11, stage 3.1): its prose with markdown's formatting gone and
 * its code blocks left out, on one line, through the same filter as a question's words (`askShown`: masked, and none
 * naming the AI provider); null when nothing is left. No model call. Kept to `WORDS_KEPT`; clipped where it's shown.
 */
export function openingOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const prose: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(```|~~~)/.exec(lines[i]);
    if (!fence) {
      prose.push(lines[i]);
      continue;
    }
    for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++);
  }
  const said = askShown(speakable(prose.join("\n"), { skipCode: true }).replace(/\s+/g, " ").trim());
  return said ? clip(said, WORDS_KEPT) : null;
}

/** Names in a line, newest first: "API", "API and Docs", "API, Docs and Schema", "API, Docs and 3 more". */
export function namesLine(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * Following's reply notification (§11, stage 3.1), about `rs`: one reach-out per thread, newest first. One thread:
 * "API replied", its opening words, then why; a tap opens that thread. Two: "2 threads replied", each thread's line
 * ("API: <its opening words>", or just its name), then why. Three or more: "<N> threads replied", their names in a line,
 * then why. Why, for several: "You follow them." when every one is followed, else each why once. Names hidden: "A thread
 * replied" over the same body for one, and the why alone for several (previews with no names read as noise). Call back
 * only (`REPLY`), no answer buttons; `active` with the default sound, kept as long as its news. `why`: one reply's own
 * whys, every duty's (a reply asked for as well as followed goes alone, with both). From stage 4 (Fable's 4-K), one
 * about a single thread, where the level answers from a notification (`answers`), has its write buttons (`writesOf`);
 * about several, Call back only.
 */
export function replyNoteOf(rs: ReachOut[], o: { names: boolean; answers?: boolean; writes?: boolean; busy?: boolean; asks?: boolean }, collapseId: string, why?: string): Note {
  const one = rs.length === 1 ? rs[0] : null;
  const following = (r: ReachOut) => r.duties.filter((d) => d.via !== "callback");
  const whys = why ?? (rs.length > 1 && rs.every((r) => following(r).some((d) => d.via === "follow")) ? WHY_FOLLOW_THEM : whyOf(rs.flatMap(following), false, o.names));
  // A failed or stopped run says so, from its status, and shows none of its words (stage 3.6).
  const failed = (r: ReachOut) => (r.news.status === "stopped" ? "was stopped" : r.news.status === "failed" ? "failed" : null);
  // Cut at a word with no "…" of its own: more lines follow (the why, another thread's), so a banner that cuts there adds
  // iOS's own, and with both it read "all 42 tests……" (the stage 3 staging run).
  // What agents ask and say off (stage 3.4): no opening words, and two threads by name only.
  const words = (r: ReachOut, max: number) => (r.words && !failed(r) && o.asks !== false ? clip(r.words, max, false) : null);
  // What its tests did (stage 3.10), from the computer: a call-back's as its wait decided, else a followed reply's own.
  const fact = (r: ReachOut) => (failed(r) ? null : (r.news.tests ?? r.tests ?? null));
  const title = one ? (failed(one) || !fact(one) ? `${o.names ? one.news.handle : "A thread"} ${failed(one) ?? "replied"}` : testsTitle(o.names ? one.news.handle : null, fact(one)!))
    : `${rs.length} threads ${rs.every(failed) ? "failed" : "replied"}`;
  // A pass mid-run has no reply yet (Fable, 3.10-C): "It's still working.", none of the agent's words.
  const body = one ? (fact(one)?.running ? STILL_WORKING : (words(one, OPENING_CHARS) ?? ""))
    : !o.names ? ""
    : rs.length === 2 && o.asks !== false ? rs.map((r) => (failed(r) ? `${r.news.handle} ${failed(r)}` : fact(r) ? testsTitle(r.news.handle, fact(r)!) : words(r, OPENING_LINE_CHARS) ? `${r.news.handle}: ${words(r, OPENING_LINE_CHARS)}` : r.news.handle)).join("\n")
    : namesLine(rs.map((r) => r.news.handle));
  return {
    type: "alert", kind: "reply", category: one ? writesOf(one, o) : CATEGORY.reply, collapseId, interruption: "active", sound: "default",
    expiresAt: Math.max(...rs.map((r) => r.keepUntil)), title, body, why: whys || WHY.follow, choices: [], reachOut: rs[0].key,
    ...(one && o.names ? { thread: one.news.handle } : {}), ...(one ? { item: one.news.itemId } : {}),
    ...(one?.conversationId ? { conversationId: one.conversationId } : {}),
  };
}

/**
 * A call-back's notification when its news isn't plain replies (stage 3.6; Fable's topics 6 and 7), as its call would
 * have said it: a watch that ran out with threads still working ("API is still working" or "2 of 3 threads are done",
 * then who is still working and "No reply after 4 hours."); waiting for all, done ("All 3 threads are done", their
 * names) or ended early by a failure ("Docs failed", "1 of 3 threads are done."); several failed ("2 threads failed",
 * their names); a failure among other news ("2 threads want you", a line for each kind). Null for plain replies, whose
 * shapes are 3.1's (`replyNoteOf`). `all`: the call-back waits for all of its `total` threads. Names hidden: counts.
 */
export function callBackWords(rs: ReachOut[], o: { names: boolean; shown?: (at: number) => string | null }, wait: { all: boolean; total: number }): { title: string; body: string } | null {
  const are = (names: string[]) => (names.length === 1 ? "is" : "are");
  const who = (names: string[]) => (o.names ? namesLine(names) : names.length === 1 ? "A thread" : `${names.length} threads`);
  // A check-in (stage 3.8; Fable, topic 14): how it stands, then when that was ("As of 15:00.", on the phone's clock).
  const check = rs.find((r) => r.news.check)?.news.check;
  if (check) {
    const asOf = o.shown?.(check.at);
    return { title: checkTitle(check, o.names), body: asOf ? `As of ${asOf}.` : "" };
  }
  const still = rs.find((r) => r.news.still)?.news.still;
  if (still) {
    // On a computer offline as it ran out, not known to be still working (the Skeptic's finding on 3.6 to 3.8): its
    // computer is said instead, "Quartz is offline", "API was running." (computer names are shown with thread names
    // hidden), and nothing is said of a deadline it can't tell.
    const off = still.offline ?? [];
    const unknown = offLines(off, o.names);
    // Done since a deadline it missed, looked at late (the fourth review of 3.6 to 3.8): never "still working".
    const late = still.late ?? [];
    // Holding a command for the user (Commands that wait; Fable's ruling on pass B1's review): waiting for them, never
    // "still working", nor counted among those still working: "API is waiting for you".
    const held = (still.held ?? []).map((h) => h.handle).filter((h) => !off.some((x) => x.handle === h) && !late.includes(h));
    const known = still.working.filter((h) => !off.some((x) => x.handle === h) && !late.includes(h) && !held.includes(h));
    if (!known.length && !late.length && !held.length) return { title: unknown.title, body: unknown.lines.join("\n") };
    const working = `${who(known)} ${are(known)} still working.`;
    const waiting = held.length ? [`${who(held)} ${are(held)} ${WAITING_FOR_YOU}.`] : [];
    // A deadline's (stage 3.8): "Not done by 18:00." on the phone's clock; with no zone, how long it watched.
    const by = still.by !== undefined ? o.shown?.(still.by) : null;
    // A tests watch's (stage 3.10): "No passing test run after 4 hours.".
    const after = by ? `Not done by ${by}.` : still.tests ? noPassAfter(spokenLength(still.waitedMs)) : `No reply after ${spokenLength(still.waitedMs)}.`;
    const offBody = off.length ? unknown.lines.map((l, i) => `${unknown.machines[i]} is offline: ${l}`) : [];
    // Some done of several, the rest waiting for you: how many are done, as with any still working (the combinations
    // review of pass B1).
    const counted = still.total > 1 && still.done > 0;
    if (!known.length) return { title: late.length ? lateTitle(late, o.names) : counted ? `${still.done} of ${still.total} threads are done` : `${who(held)} ${are(held)} ${WAITING_FOR_YOU}`, body: [...(late.length || counted ? waiting : []), ...offBody, after].join("\n") };
    if (still.total > 1 && still.done > 0) return { title: `${still.done} of ${still.total} threads are done`, body: [working, ...waiting, ...offBody, after].join("\n") };
    const title = known.length === 1 ? `${o.names ? known[0] : "A thread"} is still working` : `${known.length} threads are still working`;
    return { title, body: [...(off.length || held.length ? [working, ...waiting, ...offBody] : []), after].join("\n") };
  }
  const replies = rs.filter((r) => r.kind === "reply");
  if (replies.length !== rs.length) return null;
  const fails = replies.filter((r) => r.news.status);
  const fine = replies.filter((r) => !r.news.status);
  const failedOf = (r: ReachOut) => (r.news.status === "stopped" ? "was stopped" : "failed");
  if (wait.all && wait.total > 1) {
    if (!fails.length) return replies.length > 1 ? { title: replies.length === 2 ? "Both threads are done" : `All ${replies.length} threads are done`, body: o.names ? namesLine(replies.map((r) => r.news.handle)) : "" } : null;
    const title = fails.length === 1 ? `${o.names ? fails[0].news.handle : "A thread"} ${failedOf(fails[0])}` : `${fails.length} threads failed`;
    // None done yet: no count line (Fable's finding: "0 of 3 threads are done." says nothing).
    return { title, body: fine.length ? `${fine.length} of ${wait.total} threads are done.` : "" };
  }
  if (!fails.length || replies.length === 1) return null;
  if (!fine.length) return { title: `${fails.length} threads failed`, body: o.names ? namesLine(fails.map((r) => r.news.handle)) : "" };
  const lines = [
    fails.length === 1 ? `${who([fails[0].news.handle])} ${failedOf(fails[0])}.` : `${who(fails.map((r) => r.news.handle))} failed.`,
    `${who(fine.map((r) => r.news.handle))} replied.`,
  ];
  return { title: `${replies.length} threads want you`, body: lines.join("\n") };
}

/** A thread holding a command for the user when a watch ran out or a check-in came (Fable's ruling on pass B1's review). */
export const WAITING_FOR_YOU = "waiting for you";

/** The ring Call me back makes for a held command (Fable's ruling on pass B1's review): "API is waiting for you". */
export const waitingCaller = (handle: string, names: boolean) => `${names ? handle : "A thread"} is ${WAITING_FOR_YOU}`;

/**
 * A deadline missed by threads done since, told late (the fourth review of 3.6 to 3.8; a fixed line, unmeasured): "API
 * finished late", "2 threads finished late"; names hidden, "A thread finished late". As the call's caller line says it.
 */
export function lateTitle(late: string[], names: boolean): string {
  return late.length === 1 ? `${names ? late[0] : "A thread"} finished late` : `${late.length} threads finished late`;
}

/**
 * Threads still working as last seen on computers offline now, by computer (the Skeptic's finding on 3.6 to 3.8): the
 * title ("Quartz is offline", "2 computers are offline") and, per computer, who was running there ("API was running.").
 */
function offLines(off: { handle: string; machine: string }[], names: boolean): { title: string; machines: string[]; lines: string[] } {
  const machines = [...new Set(off.map((x) => x.machine))];
  const title = machines.length === 1 ? `${machines[0]} is offline` : `${machines.length} computers are offline`;
  return { title, machines, lines: machines.map((m) => wereRunning(off.filter((x) => x.machine === m).map((x) => x.handle), names)) };
}

/**
 * A check-in's title, as its call's caller line says it (Fable, topic 14): one thread, how it stands ("API is still
 * working", "API replied", "API failed", "API was stopped", "API asks something", "API isn't running"; holding a command
 * for the user, "API is waiting for you": Fable's ruling on pass B1's review); several, how many are done ("2 of 3
 * threads are done"). Names hidden: "A thread". One working as last seen on a computer offline then, that computer
 * ("Quartz is offline"), never "still working".
 */
export function checkTitle(check: NonNullable<News["check"]>, names: boolean): string {
  if (check.total > 1) return `${check.standing.filter((t) => t.state === "replied" || t.state === "failed" || t.state === "stopped").length} of ${check.total} threads are done`;
  const t = check.standing[0];
  if (t?.offline) return `${t.offline} is offline`;
  const who = names && t ? t.handle : "A thread";
  const what: Record<Standing, string> = { working: "is still working", held: `is ${WAITING_FOR_YOU}`, replied: "replied", failed: "failed", stopped: "was stopped", asks: "asks something", idle: "isn't running" };
  return `${who} ${what[t?.state ?? "idle"]}`;
}

/**
 * A briefing's notification (stage 3.8; example 6's words, Fable's topic 16): "Your briefing is ready"; one line of
 * counts since the last one, zero groups left out ("Since Friday 08:00: 2 threads ask, 1 failed, 5 replied."; "1 thread
 * asks", "1 replied"), `since` as shown ("yesterday 08:00", "Friday 08:00"); then the rule it's from, its why. No thread
 * names; with thread names hidden, its why is "Your rule." (a line may name a project); collapsed per rule, so
 * yesterday's is replaced. Stage 4 (Fable's 4-I, 4-L): one button, Hear it, and a tap does the same: the phone plays the
 * briefing made ahead (`briefing`, when one was made), with no call.
 */
export function briefNoteOf(r: ReachOut, since: string, o: { names: boolean } = { names: true }): Note {
  const b = r.news.brief!;
  return {
    type: "alert", kind: "brief", category: CATEGORY.briefing, collapseId: ruleCollapse(r.duties[0]?.rule ?? r.key), interruption: "active", sound: "default", expiresAt: r.keepUntil,
    title: "Your briefing is ready", body: countsLine(b, since), why: o.names ? `Your rule: ${b.line}` : "Your rule.", choices: [], reachOut: r.key, ...(r.briefing ? { briefing: r.briefing } : {}),
  };
}

/**
 * What happened since a time, in one line (a briefing's, and Away's end, Fable's 3.9-F): "Since Friday 18:00: 2 threads
 * ask, 1 failed, 14 replied.", zero groups left out ("1 thread asks", "1 replied"); all three zero, "Nothing happened
 * since Friday 18:00.".
 */
export function countsLine(c: { asks: number; failed: number; replied: number }, since: string): string {
  const counts = [
    c.asks ? `${c.asks} ${c.asks === 1 ? "thread asks" : "threads ask"}` : "",
    c.failed ? `${c.failed} failed` : "",
    c.replied ? `${c.replied} replied` : "",
  ].filter(Boolean).join(", ");
  return counts ? `Since ${since}: ${counts}.` : `Nothing happened since ${since}.`;
}

/**
 * Where you wrote, as Away's end says it (Fable, 3.9-F and 3.9-G): the thread, and its computer only when the account
 * has more than one ("Migration on Lattice", "Migration"); thread names hidden, "a thread" (computer names stay shown).
 */
export function wroteIn(o: { thread: string; machine?: string }, names: boolean, computers: number): string {
  return `${names ? o.thread : "a thread"}${computers > 1 && o.machine ? ` on ${o.machine}` : ""}`;
}

/**
 * The one "Away ended" notification (Fable, 3.9-F), never a second, with no button (a tap opens Home), collapsed under
 * Away's rule and kept a day like other news, naming no level. Ended at its set time: passive, no sound, the counts line
 * alone. Ended by your message typed at a computer: "You wrote in Migration on Lattice." first (the why), then the counts
 * line; with an hour or more left it has the default sound and asks to turn Away on again ("If you're still away, turn
 * Away on again."), so an end you didn't mean is noticed; with less, passive and without it. Stop sends nothing.
 */
export function awayNoteOf(o: { rule: string; key: string; at: number; counts: { asks: number; failed: number; replied: number }; since: string; wrote?: { where: string; hourLeft: boolean } }): Note {
  const counts = countsLine(o.counts, o.since);
  const loud = !!o.wrote?.hourLeft;
  const body = o.wrote ? [`You wrote in ${o.wrote.where}.${loud ? " If you're still away, turn Away on again." : ""}`, counts].join("\n") : counts;
  return {
    type: "alert", kind: "away", collapseId: ruleCollapse(o.rule), interruption: loud ? "active" : "passive", ...(loud ? { sound: "default" as const } : {}),
    expiresAt: o.at + NEWS_MS, title: "Away ended", body, why: "", choices: [], reachOut: o.key,
  };
}

// --- a computer offline and back (stage 3.7; Fable, topics 10 and 11; its words are offline.ts's) ---

/**
 * Who was running, for a notification's body (Fable, topic 10): "API was running.", "API and Docs were running.", "API,
 * Docs and 3 more were running."; thread names hidden, "A thread was running.", "2 threads were running."
 */
export function wereRunning(names: string[], shown: boolean): string {
  const who = shown ? namesLine(names) : names.length === 1 ? "A thread" : `${names.length} threads`;
  return `${who} ${names.length === 1 ? "was" : "were"} running.`;
}

/**
 * How the threads stand once their computer is back (Fable, topic 10), statuses only, running first: "API is still
 * running.", "API and Docs are still running."; "API isn't running now.", "API and Docs aren't running now."; hidden, "A
 * thread is still running.", "2 threads aren't running now.".
 */
export function standingNow(running: string[], not: string[], shown: boolean): string[] {
  const who = (names: string[]) => (shown ? namesLine(names) : names.length === 1 ? "A thread" : `${names.length} threads`);
  return [
    running.length ? `${who(running)} ${running.length === 1 ? "is" : "are"} still running.` : "",
    not.length ? `${who(not)} ${not.length === 1 ? "isn't" : "aren't"} running now.` : "",
  ].filter(Boolean);
}

/** The collapse id offline news and its "back" share: the down time's key's, as any other fact's (one per computer). */
export const offlineCollapse = (r: ReachOut) => ruleCollapse(r.key);

/**
 * The notification that a computer went offline (Fable, topic 10): one per computer, `active` with the default sound,
 * kept as its news is (24 h). Title "Quartz went offline"; then who was running, newest first; then why. Call back
 * (`REPLY`, opening that conversation) only when a call-back you asked for is among its reasons, otherwise no button, and
 * a tap opens Home. Under its down time's collapse id, so "back" takes its place.
 */
export function offlineNoteOf(r: ReachOut, o: { names: boolean }): Note {
  const off = r.news.offline!;
  const asked = off.threads.some((t) => t.why === "callback") && !!r.conversationId;
  return {
    type: "alert", kind: "offline", ...(asked ? { category: CATEGORY.reply } : {}), collapseId: offlineCollapse(r), interruption: "active", sound: "default",
    expiresAt: r.keepUntil, title: `${r.news.handle} went offline`, body: wereRunning(off.threads.map((t) => t.handle), o.names), why: offlineWhy(off, o.names), choices: [],
    reachOut: r.key, ...(asked ? { conversationId: r.conversationId } : {}),
  };
}

/**
 * A missed call about a computer gone offline (Fable, topic 11): "You missed a call", "Quartz went offline: API was
 * running.", why, and Call back, under the down time's collapse id (so "back" takes its place). Several computers in the
 * one call: a line each.
 */
export function offlineMissedOf(rs: ReachOut[], o: { names: boolean }): Note {
  const r = rs[0];
  return {
    type: "alert", kind: "missed", category: CATEGORY.missed, collapseId: offlineCollapse(r), interruption: "active", sound: "default",
    expiresAt: Math.max(...rs.map((x) => x.keepUntil)), title: "You missed a call",
    body: rs.map((x) => `${offlineLine(x.news.handle, x.news.offline!.threads.map((t) => t.handle), o.names)}.`).join("\n"),
    why: [...new Set(rs.map((x) => offlineWhy(x.news.offline!, o.names)).join("\n").split("\n"))].join("\n"), choices: [], reachOut: r.key,
    // The conversation its call rang (`rangFor`), its Call back opening there.
    ...((r.rangFor ?? r.conversationId) ? { conversationId: r.rangFor ?? r.conversationId } : {}),
  };
}

/**
 * The notification that the computer is back (Fable, topic 10): `passive` (no sound, no banner wake), in the offline
 * one's place under its collapse id; "Quartz is back", how long it was offline, how the threads stand now, why. No
 * buttons; a tap opens Home. Sent only when the offline news was sent or told, and it's back within a day.
 */
export function backNoteOf(r: ReachOut, now: number, standing: { running: string[]; not: string[] }, o: { names: boolean }): Note {
  const off = r.news.offline!;
  return {
    type: "alert", kind: "back", collapseId: offlineCollapse(r), interruption: "passive", expiresAt: off.since + NEWS_MS,
    title: `${r.news.handle} is back`, body: [`Offline for ${offlineFor(now - off.since)}.`, ...standingNow(standing.running, standing.not, o.names)].join("\n"),
    why: offlineWhy(off, o.names), choices: [], reachOut: r.key,
  };
}

// --- the end of a hold-back (stage 3.4; Fable, topic 9) ---

/**
 * What a held stretch left unheard, one line per kind, names newest first (Fable, topic 9): who asks ("API asks: <its
 * question on one line, clipped at a word to 80>"; "API and Docs ask."), who waits for an OK, who waits for you (a
 * command it holds, stage 4c: "API is waiting for you."), who failed, which computer went offline (computers are named
 * with thread names hidden), who is still working (a watch that ran out), who replied ("API, Docs and 3 more
 * replied."). Thread names hidden, counts ("A thread asks: …", "2 threads ask.", "3 threads replied."); What agents ask
 * and say off, "API asks something." in place of the question.
 */
export function heldNews(rs: ReachOut[], o: { names: boolean; asks?: boolean }): string {
  const newest = [...rs].sort((a, b) => b.at - a.at);
  const one = (r: ReachOut) => (o.names ? r.news.handle : "A thread");
  const who = (g: ReachOut[]) => (o.names ? namesLine(g.map((r) => r.news.handle)) : `${g.length} threads`);
  // A run you stopped is no failure (the reviews of 3.4): "API was stopped.", as its own notification says.
  const failed = (r: ReachOut) => r.kind === "reply" && (r.news.status === "failed" || r.tests?.state === "failed" || r.tests?.state === "build");
  const stopped = (r: ReachOut) => r.kind === "reply" && r.news.status === "stopped" && !failed(r);
  const asks = newest.filter((r) => r.kind === "question" && r.news.question?.kind !== "approval");
  const waits = newest.filter((r) => r.kind === "question" && r.news.question?.kind === "approval");
  const fails = newest.filter(failed);
  const stops = newest.filter(stopped);
  const offline = newest.filter((r) => r.kind === "offline");
  // A command a thread still holds (stage 4c), or a watch that ran out on one: waiting for you, once a thread; a watch
  // that ran out on a thread still working says so, never "replied" (Fable's rulings on pass B2's review).
  const still = (r: ReachOut) => r.kind === "reply" && !!r.news.still && !failed(r);
  const holding = (r: ReachOut) => r.kind === "held" || (still(r) && !!r.news.still!.held?.some((h) => h.handle === r.news.handle));
  const held = newest.filter((r, i, all) => holding(r) && all.findIndex((x) => holding(x) && x.news.itemId === r.news.itemId) === i);
  const working = newest.filter((r) => still(r) && !holding(r));
  const idle = newest.filter((r) => r.news.idle);
  const replies = newest.filter((r) => r.kind === "reply" && !failed(r) && !stopped(r) && !still(r) && !r.news.idle);
  const ask = asks.length === 1 && o.asks !== false ? askShown(asks[0].ask)?.replace(/\s+/g, " ") : null;
  const verb = (g: ReachOut[], single: string, plural: string) => (g.length === 1 ? `${one(g[0])} ${single}.` : `${who(g)} ${plural}.`);
  return [
    asks.length === 1 ? (ask ? `${one(asks[0])} asks: ${clip(ask, MISSED_ASK_CHARS)}` : `${one(asks[0])} asks something.`) : asks.length ? `${who(asks)} ask.` : "",
    waits.length ? verb(waits, "is waiting for your OK", "are waiting for your OK") : "",
    held.length ? verb(held, `is ${WAITING_FOR_YOU}`, `are ${WAITING_FOR_YOU}`) : "",
    fails.length ? verb(fails, "failed", "failed") : "",
    stops.length ? verb(stops, "was stopped", "were stopped") : "",
    offline.length ? `${namesLine(offline.map((r) => r.news.handle))} went offline.` : "",
    working.length ? verb(working, "is still working", "are still working") : "",
    ...idle.map((r) => `${idleIn(r, o.names)}.`),
    replies.length ? verb(replies, "replied", "replied") : "",
  ].filter(Boolean).join("\n");
}

/**
 * The one notification at the end of a hold-back (Fable, topic 9): the night line's at its end ("Overnight", why "Your
 * rule: …"), Quiet for a while's when it ends ("While you were quiet", "You were quiet until 15:30."). An ordinary
 * notification with the default sound, no category and no buttons (each held question's own notification is still there
 * with its buttons); about one thread a tap opens it, about several, Home. Collapsed per stretch, kept as its news is.
 * Kind `holdEnd`, as `held` is a held command's (stage 4).
 */
export function holdEndNoteOf(rs: ReachOut[], o: { key: string; title: string; why: string; names: boolean; asks?: boolean }): Note {
  const threads = new Set(rs.filter((r) => r.kind !== "offline").map((r) => r.news.itemId));
  const only = threads.size === 1 && rs.every((r) => r.kind !== "offline" && !r.news.idle) ? rs[0].news.itemId : null;
  return {
    type: "alert", kind: "holdEnd", collapseId: ruleCollapse(o.key), interruption: "active", sound: "default", expiresAt: Math.max(...rs.map((r) => r.keepUntil)),
    title: o.title, body: heldNews(rs, o), why: o.why, choices: [], reachOut: rs[0].key, ...(only ? { item: only } : {}),
  };
}

// --- stage 3.5: a judged line's yes, and example 2 (Fable, topics 5, 12 and 16) ---

/** The most of a judged check's reason a notification shows (Fable, topic 12). */
export const REASON_CHARS = 140;

/**
 * A judged line's yes (Fable, topic 12), at once: "API is waiting on you" (names hidden, "A thread is waiting on you"),
 * the check's reason on one line clipped at a word to 140 (left out with What agents ask and say off), then why ("Your
 * rule: … Judged by AI."). A clause of your own on a reply (`judge`) has the reply's own title ("API replied"). Call back
 * (`REPLY`); a tap opens the thread. Collapsed per fact.
 */
export function judgedNoteOf(r: ReachOut, o: { names: boolean; asks?: boolean }, needsYou: boolean): Note {
  const name = o.names ? r.news.handle : null;
  const reason = o.asks === false ? null : askShown(r.reason ?? "")?.replace(/\s+/g, " ") ?? null;
  const base = replyNoteOf([r], o, ruleCollapse(r.key), whyOf(r.duties, false, o.names));
  return {
    ...base, title: needsYou ? (name ? `${name} is waiting on you` : "A thread is waiting on you") : base.title,
    body: reason ? clip(reason, REASON_CHARS, false) : "",
  };
}

/** Example 2's words for its project: its name, or with thread names hidden, none (the reviews of 3.5). */
const idleIn = (r: ReachOut, names: boolean) => `Nothing is running in ${names ? r.news.handle : "a project"}`;

/**
 * Example 2's notification (Fable, topic 5): "Nothing is running in driver" ("…in a project" with thread names hidden),
 * the reminder your line asked for ("Push to Prod."), then why. No button; a tap opens Home. Collapsed per rule, kept a
 * day.
 */
export function idleNoteOf(r: ReachOut, o: { names: boolean }): Note {
  const say = r.news.idle?.say;
  return {
    type: "alert", kind: "reply", collapseId: ruleCollapse(r.duties[0]?.rule ?? r.key), interruption: "active", sound: "default", expiresAt: r.keepUntil,
    title: idleIn(r, o.names), body: say ? `${say.charAt(0).toUpperCase()}${say.slice(1)}.` : "", why: whyOf(r.duties, false, o.names), choices: [], reachOut: r.key,
  };
}
