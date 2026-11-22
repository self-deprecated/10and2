// The engine's rules (docs/launch/engine.md): when something happens, do something. Stage 1 (§10) builds only a rule's
// head, kept inside each wait's own row (`Wait.rule`), so a rollback loses nothing and a roll-forward finds it. It holds
// lengths of time, never an end time: each is read against the clock today's code reads it against (a thread's own
// start, else the wait's; when the wait was over, for keeping its news).
import type { Wait } from "./waits.ts";

/** A run the user just asked for (a follow-up) may take a moment to show as running. */
export const START_GRACE_MS = 3 * 60_000;
export const MAX_WAIT_MS = 60 * 60_000;
/**
 * How long a wait that's over keeps its call-back. A holding phone calls back within seconds; this is for one that
 * lost track of its hold (a crash), whose next Start still gets the news. After that the news is stale and dropped.
 */
export const READY_MS = 60 * 60_000;

/** How long a call-back watches each thread from its own start, gives a follow-up to start, and keeps its news. */
export type Watch = { kind: "watch"; watchMs: number; graceMs: number; keepNewsMs: number };

/** Who made a rule, and how: starred threads at a goodbye are the system's (today's `auto`). */
export type Made = { by: "user" | "preset" | "system"; via: "voice" | "tap" | "siri" | "app" | "pause" | "goodbye" };

export type RuleHead = {
  v: 1;
  /** `R-w-<conversationId>-<startedAt>`: a replaced wait is a new rule. */
  id: string;
  made: Made;
  /** A "call me" rule: the only kind that rings the phone. */
  ring: boolean;
  lifetime: Watch;
};

const BY: readonly string[] = ["user", "preset", "system"] satisfies Made["by"][];
const VIA: readonly string[] = ["voice", "tap", "siri", "app", "pause", "goodbye"] satisfies Made["via"][];

/** Today's lifetime: each thread watched an hour, 3 minutes to start, a call-back's news kept an hour. */
export function todaysWatch(): Watch {
  return { kind: "watch", watchMs: MAX_WAIT_MS, graceMs: START_GRACE_MS, keepNewsMs: READY_MS };
}

/**
 * The head of a wait started now (`Waits.start`), or the one a row with none implies (`via` unsaid). `watchMs`: how long
 * it watches each thread, for a call-back asked for in words the level's length or a shorter one asked for (stage 3.6:
 * `wait_for` gives it); else an hour, as today.
 */
export function headFor(conversationId: string, startedAt: number, auto: boolean, via?: Made["via"], watchMs?: number): RuleHead {
  const lifetime = todaysWatch();
  if (watchMs !== undefined && duration(watchMs)) lifetime.watchMs = watchMs;
  return { v: 1, id: `R-w-${conversationId}-${startedAt}`, made: { by: auto ? "system" : "user", via: via ?? (auto ? "goodbye" : "voice") }, ring: !auto, lifetime };
}

const duration = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;

/** A head this version reads: anything else (a later version's, a broken one) is never trusted. */
export function validHead(h: unknown): h is RuleHead {
  if (!h || typeof h !== "object") return false;
  const { v, id, made, ring, lifetime } = h as Record<string, any>;
  return v === 1 && typeof id === "string" && !!made && typeof made === "object" && BY.includes(made.by) && VIA.includes(made.via) && typeof ring === "boolean"
    && !!lifetime && typeof lifetime === "object" && lifetime.kind === "watch" && duration(lifetime.watchMs) && duration(lifetime.graceMs) && duration(lifetime.keepNewsMs);
}

/** A wait's head: the one it holds if it's valid, else the one its row implies, which is today's behaviour. */
export function headOf(w: Wait): RuleHead {
  return validHead(w.rule) ? w.rule : headFor(w.conversationId, w.startedAt, !!w.auto);
}

/** Following's rule: one per account, while the phone has Notifications on (stage 2a item 3). */
export const FOLLOWING = "R-following";

/**
 * A thread in a standing rule's scope, from when it joined: for following, its star (or when it was set by hand to
 * notify you). `heard`: the question it had then, or the last one the rule told, by its fact's key (observations.ts), so
 * neither is news again. `ran` (stage 3.1): likewise its finished run, the reply it had then or the last one told; unset
 * on a thread that joined before replies were told, which takes the run it has as told. `running`: seen running since,
 * so a run that ends with no time of its own is still a reply.
 */
export type Joined = { at: number; heard: string | null; ran?: string | null; running?: boolean };

/**
 * A mark among following's threads, never a thread's id, that stage 2a takes away (docs/launch/engine.md §11, 3.1's
 * rollback): 2a reads it as a thread no longer followed and drops it at its first look, keeping the rest of the row as it
 * was, each thread's `ran` and `running` too, though it never moves them. So a rule without it has been run by older code
 * since (or made by it), and the replies that code saw meanwhile aren't news: each thread takes the reply it has then as
 * told (`ran` unset, as for a rule from before replies were told), and the mark goes back. A restart keeps it, so a reply
 * that came while this code was down is still news.
 */
export const ROLLBACK_MARK = "(stage 3.1)";

/** What following's rule says it does: not a row in Watching, but the sentence any reading of it uses (§11, 3.1). */
export const FOLLOWING_SAID = "Threads you follow tell you when they reply or ask";

/**
 * The first rule that isn't a call-back (docs/launch/engine.md §3, §11 item 3): a standing rule over the threads you
 * follow, `made.via: "follow"`, that tells you when one asks something, and from stage 3.1 when one replies, batched;
 * with them, threads you don't follow that you set by hand to tell you. Kept in table `rules`; each thread joins at its
 * star, or when it was set. `sentAt`: when its last reply notification went, which the next batch waits 30 minutes from.
 * `openedAt`: when the reply that last went at its grace came, opening the 3-minute window the next ones gather in (the
 * stage 3 staging run); older code ignores it, and a rule without it has no window open.
 * `joining`: made, its threads not yet joined (a brain that hasn't looked yet): its first look joins those starred or set
 * before it was made, each taking the reply it has then as told. Older code ignores it. `items` holds `ROLLBACK_MARK`
 * too, which isn't a thread.
 */
export type FollowRule = {
  v: 1;
  id: typeof FOLLOWING;
  made: { by: "user"; via: "follow"; at: number; said: string };
  scope: { starred: true };
  when: ({ on: "asks" } | { on: "replied" })[];
  then: { do: "tell" }[];
  urgency: "urgent";
  ring: false;
  lifetime: { kind: "standing" };
  state: { status: "watching"; items: Record<string, Joined>; n: number; sentAt?: number; openedAt?: number; joining?: true };
};

export function followRule(at: number): FollowRule {
  return {
    v: 1, id: FOLLOWING, made: { by: "user", via: "follow", at, said: FOLLOWING_SAID }, scope: { starred: true },
    when: [{ on: "asks" }, { on: "replied" }], then: [{ do: "tell" }], urgency: "urgent", ring: false, lifetime: { kind: "standing" },
    state: { status: "watching", items: { [ROLLBACK_MARK]: { at, heard: null } }, n: 0 },
  };
}

/** A following rule this version reads: anything else is left as it is and not run. */
export function validFollow(x: unknown): x is FollowRule {
  const r = x as FollowRule | null;
  return !!r && typeof r === "object" && r.v === 1 && r.id === FOLLOWING && r.made?.via === "follow" && !!r.state && typeof r.state === "object"
    && r.state.status === "watching" && !!r.state.items && typeof r.state.items === "object" && Number.isFinite(r.state.n)
    && (r.state.sentAt === undefined || Number.isFinite(r.state.sentAt)) && (r.state.openedAt === undefined || Number.isFinite(r.state.openedAt))
    && (r.state.joining === undefined || r.state.joining === true)
    && Object.values(r.state.items).every((j) => !!j && Number.isFinite(j.at) && (j.heard === null || typeof j.heard === "string")
      && (j.ran === undefined || j.ran === null || typeof j.ran === "string") && (j.running === undefined || typeof j.running === "boolean"));
}

/**
 * A repeating time's rule (docs/launch/engine.md §3, `every`; §11 stage 3.8), standing until removed: on its weekdays,
 * at its time on the phone's clock of the moment, a briefing of what happened since its last occurrence, told only when
 * something did (example 6: "Every weekday at 8, have a briefing ready of what happened overnight."; Fable, topic 16).
 * Nothing makes one by voice; your rules' file does, from stage 3.4. Kept in table `rules`, which older code reads only
 * for following's rule. `lastAt`: its last occurrence, where the next look-back starts (its making, before the first);
 * `lastDate`: the local date it last fired for, which it never fires for again (null before the first). `as` (stage 4,
 * Fable's 4-I): a summary, or with the line's own words for it ("in full", "word for word", "read me the replies") each
 * reply read as it is. Older code never reads `as`: its notification is the same either way.
 */
export type EveryRule = {
  v: 1;
  id: string;
  /** `key`: its line's normalised text, digested (my-rules.ts `keyOf`), so a save keeps it while the line stays. */
  made: { by: "user"; via: "file"; at: number; said: string; key?: string; read?: true };
  scope: { everything: true };
  when: [{ on: "every"; days: number[]; time: string }];
  then: [{ do: "brief"; since: "last_occurrence"; as: "summary" | "full"; deliver: "now" }];
  urgency: "normal";
  ring: false;
  lifetime: { kind: "standing" };
  state: { status: "watching"; n: number; lastAt: number; lastDate: string | null };
};

/** A repeating time's rule made now, from its line (`said`, its why), its weekdays and time, and summary or full. */
export function everyRule(id: string, said: string, every: { days: number[]; time: string }, at: number, as: "summary" | "full" = "summary"): EveryRule {
  return {
    v: 1, id, made: { by: "user", via: "file", at, said }, scope: { everything: true }, when: [{ on: "every", days: [...every.days], time: every.time }],
    then: [{ do: "brief", since: "last_occurrence", as, deliver: "now" }], urgency: "normal", ring: false, lifetime: { kind: "standing" },
    state: { status: "watching", n: 0, lastAt: at, lastDate: null },
  };
}

/** A repeating time's rule this version reads: anything else is left as it is and not run. */
export function validEvery(x: unknown): x is EveryRule {
  const r = x as EveryRule | null;
  const w = r?.when?.[0];
  return !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && r.id !== FOLLOWING && typeof r.made?.said === "string"
    && Array.isArray(r.when) && r.when.length === 1 && w?.on === "every" && Array.isArray(w.days) && w.days.length > 0 && w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && typeof w.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(w.time) && r.then?.[0]?.do === "brief" && (r.then[0].as === "summary" || r.then[0].as === "full") && r.state?.status === "watching" && Number.isFinite(r.state.n)
    && Number.isFinite(r.state.lastAt) && (r.state.lastDate === null || (typeof r.state.lastDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.state.lastDate)));
}

/**
 * Away (docs/launch/engine.md §2, Presets; §11 stage 3.9; Fable's decisions 3.9-D to 3.9-G): a preset's rule with a set
 * end, over every thread on every computer, threads started later too (a thread set to Nothing leaves it, as it leaves
 * every wide scope). It tells you of a question, a failed or stopped run and a computer offline, by notification only,
 * never a call (§9: a preset never rings), with why "Away is on."; a clean reply is following's to tell, not Away's. It
 * ends at its set time (`lifetime.at`, at most the level's `awayHours` from when it was turned on, never cut short by a
 * downgrade), or at your first message typed at a computer more than 10 minutes after it was turned on, whichever is
 * first, or by Stop. Stage 5's preset is what turns it on. Kept in table `rules`; `items` as following's (`Joined`), each
 * thread from when Away first saw it, so a question already open as you leave isn't news. `joining`: turned on before
 * the brain had looked, its threads join at its first look, each taking what it has then as told.
 */
export type AwayRule = {
  v: 1;
  id: string;
  made: { by: "preset"; via: "app"; preset: "away"; at: number; said: string };
  scope: { everything: true };
  when: [{ on: "asks" }, { on: "failed" }, { on: "offline"; afterMs: number }];
  then: [{ do: "tell" }];
  urgency: "urgent";
  ring: false;
  lifetime: { kind: "until"; at: number; endOn: "person_wrote" };
  state: { status: "watching"; items: Record<string, Joined>; n: number; joining?: true };
};

/** Away's rules' ids: one per time it's turned on. */
export const AWAY_PREFIX = "R-away-";
/** What Away says it does, as Watching's second line says it (Fable, 3.9-G). */
export const AWAY_SAID = "Questions, failures, a computer offline";

/** Away turned on at `at` until `until`. */
export function awayRule(at: number, until: number, offlineMs: number): AwayRule {
  return {
    v: 1, id: `${AWAY_PREFIX}${at}`, made: { by: "preset", via: "app", preset: "away", at, said: AWAY_SAID }, scope: { everything: true },
    when: [{ on: "asks" }, { on: "failed" }, { on: "offline", afterMs: offlineMs }], then: [{ do: "tell" }], urgency: "urgent", ring: false,
    lifetime: { kind: "until", at: until, endOn: "person_wrote" }, state: { status: "watching", items: {}, n: 0 },
  };
}

/** An Away rule this version reads: anything else is left as it is and not run. */
export function validAway(x: unknown): x is AwayRule {
  const r = x as AwayRule | null;
  return !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && r.id.startsWith(AWAY_PREFIX) && r.made?.preset === "away" && Number.isFinite(r.made.at)
    && r.ring === false && r.lifetime?.kind === "until" && Number.isFinite(r.lifetime.at) && r.state?.status === "watching" && Number.isFinite(r.state.n)
    && !!r.state.items && typeof r.state.items === "object" && (r.state.joining === undefined || r.state.joining === true)
    && Object.values(r.state.items).every((j) => !!j && Number.isFinite(j.at) && (j.heard === null || typeof j.heard === "string")
      && (j.ran === undefined || j.ran === null || typeof j.ran === "string") && (j.running === undefined || typeof j.running === "boolean"));
}
