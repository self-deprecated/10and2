// Levels as limits (docs/launch/engine.md §8; §11, stage 3.3): the same engine on every level, and one `Limits` from
// the account's plan and labels, computed in the cloud (cloud/src/plan.ts `limitsOf`) and given to the brain as its
// settings are; Lattice's are Long Haul's. A level sets how long a rule may watch and how wide, and which ways it
// reaches you: Commute rings once a day (§12, 9: "One per day. Then the rest above that unlimited."), and answering an
// agent from a notification is Road Trip and up (§12, 5: "Road Trip and up").
//
// What Commute's limit says, and where, is Fable's (§11, 3.3): only when it bites, in the readback of the ask, word for
// word from here (never the model's own); on the affected Watching row; on Settings → Calls → Call me back; and in a
// call only when asked. Never in a notification or any push, and never a level's name in one. A level is named only to
// an account on that level's plan (`named`); anyone else on its limits gets the same lines with the name left out.

export type LevelName = "Commute" | "Road Trip" | "Long Haul";

export type Limits = {
  level: LevelName;
  /**
   * Whether the level's name may be said or shown to the account (Fable, 18 November): only when its active plan is
   * that level, or staff are trying it from Ops. Anyone else on its limits (no plan: a trial, pay as you go, their own
   * key; the old monthly and yearly plans; testers) gets the same lines with the level's name left out, and nothing in
   * its place: never "trial", "free", "your plan" or "this level".
   */
  named: boolean;
  /** How long a rule watches (3.6 reads it: a call-back watches an hour on every level until then). */
  watchHours: number;
  /**
   * Watching's width: the threads you name; and the threads you follow; and every thread, started later too. Nothing
   * asks for wider than the threads you name until 3.6's scopes, which read it.
   */
  width: "threads" | "starred" | "everything";
  /** Call me back: rings with no limit, or so many a day, the day starting at midnight on the phone's clock. */
  ring: true | { perDay: number };
  /** The agent's own options as buttons on a question's notification. Without them it has Call back only. */
  answerFromNotification: boolean;
  /**
   * The longest Away may be set for, in hours (stage 3.9; §8: "up to 72 h" on Long Haul, none below it). Read only as
   * Away is turned on: a downgrade never cuts one already set short.
   */
  awayHours: number;
  /**
   * How many sends and starts set up for later may wait at once (stage 4b; Fable's 4-0 (7)): none on Commute, one on Road
   * Trip, 20 on Long Haul. Each thread a send goes to counts as one. Read when one is set up: a downgrade never stops one
   * already agreed to.
   */
  laterSends: number;
  /**
   * Whether a command held on a computer's list sends a notification (Commands that wait; Fable's 4-0 (7) and 4-H2): Road
   * Trip and Long Haul. The hold is the computer's, which doesn't know the level, and the app shows it on every level.
   */
  heldNotes: boolean;
  /**
   * How a briefing made ahead is put together (Fable's 4-0 (7) and 4-I): Commute's from the threads' cards, with no
   * writer call (§8: a writer call a day is past Commute's margin); Road Trip's and Long Haul's written. It sounds the same
   * either way, and the level is never said.
   */
  briefing: "cards" | "written";
  /**
   * How many steps a chain may have ("when Schema's done, tell API to rebase"; Fable's 4-0 (7) and 4-J): none on Commute,
   * one on Road Trip, three on Long Haul. Each step also counts against `laterSends` while it waits; "and call me when
   * that's done" isn't a step.
   */
  chain: number;
  /**
   * Lines in your rules judged by AI (stage 3.5; §8: Road Trip and up): "needs my input"'s judged half, and a line with a
   * clause of your own the facts can't decide. At most 50 checks a day per account on either (`JUDGED_PER_DAY`). Without
   * them a wholly judged line is paused, and example 1 keeps its fact half.
   */
  judgedLines: boolean;
};

/** Each level's limits, as an account on that level's plan has them (named). */
export const LIMITS: Record<LevelName, Limits> = {
  Commute: { level: "Commute", named: true, watchHours: 1, width: "threads", ring: { perDay: 1 }, answerFromNotification: false, awayHours: 0, laterSends: 0, heldNotes: false, briefing: "cards", chain: 0, judgedLines: false },
  "Road Trip": { level: "Road Trip", named: true, watchHours: 4, width: "starred", ring: true, answerFromNotification: true, awayHours: 0, laterSends: 1, heldNotes: true, briefing: "written", chain: 1, judgedLines: true },
  "Long Haul": { level: "Long Haul", named: true, watchHours: 12, width: "everything", ring: true, answerFromNotification: true, awayHours: 72, laterSends: 20, heldNotes: true, briefing: "written", chain: 3, judgedLines: true },
};

/** The same limits for an account not on the level's plan: its name is never said or shown to it. */
export const UNNAMED: Record<LevelName, Limits> = {
  Commute: { ...LIMITS.Commute, named: false },
  "Road Trip": { ...LIMITS["Road Trip"], named: false },
  "Long Haul": { ...LIMITS["Long Haul"], named: false },
};

const days = new Map<string, Intl.DateTimeFormat>();

/** The day `at` falls on in `zone` ("2026-11-18"): Commute's ring comes back when it changes, at midnight there. */
export function localDay(at: number, zone: string): string {
  let f = days.get(zone);
  if (!f) days.set(zone, (f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(at);
}

/**
 * The readback of a call-back asked for in words on Commute's limits, when the day's ring bites (Fable, 3.3): today's
 * is used, or another asked for hasn't fired yet and would take it. `threads`: the threads asked about, as said;
 * several are "they". `notifications`: whether this phone takes notifications, so the other one comes as a notification
 * or waits for the next call. `named`: the account is on Commute's plan, so the level is named; else the same sentence
 * without it (Fable, 18 November). Null when nothing bites: today's words stand, with nothing about the level. No
 * "instead" after the thread: the voice dropped or moved it in 4 of 50 readbacks, and it means the same without (Fable, 19
 * November).
 */
export function commuteReadback(bite: "used" | "second" | null, notifications: boolean, threads: string[], named: boolean): string | null {
  if (!bite) return null;
  const one = threads.length === 1 ? threads[0] : null;
  if (bite === "second") {
    return `I'll call for whichever comes first; the other ${notifications ? "will be a notification" : "will wait for your next call"}. ${named ? "Commute has" : "There's"} one call-back a day. OK?`;
  }
  const how = notifications
    ? `I'll send a notification when ${one ?? "they"} ${one ? "replies" : "reply"}.`
    : one ? `The reply from ${one} will be waiting in your next call.` : "Their replies will be waiting in your next call.";
  return `You've had today's call-back${named ? " on Commute" : ""}. ${how} OK?`;
}

/**
 * Said word for word once the user agrees to `commuteReadback` (Fable, 18 November): how it will reach them, as the
 * readback said. With today's call-back used it never says "call back": no call is coming. No "OK." first: the voice
 * says its own ("Okay. OK. I'll send…" in nearly every eval run, Fable, 18 November).
 */
export function commuteAgreed(bite: "used" | "second", notifications: boolean, threads: string[]): string {
  if (bite === "second") return "I'll call for whichever comes first.";
  const one = threads.length === 1;
  if (notifications) return `I'll send a notification when ${one ? `${threads[0]} replies` : "they reply"}.`;
  return one ? "It'll be waiting in your next call." : "Their replies will be waiting in your next call.";
}

/** Said word for word when the user says no to `commuteReadback` (Fable, 18 November: seven runs, seven wordings). */
export const NOTHING_SET_UP = "Nothing's set up.";

/**
 * The line in a notification's place when its button was tapped on a level that doesn't answer from one (Fable, 3.3),
 * naming no level: refused as it's tapped, or just before it's sent if the level changed while it was being prepared.
 */
export const NOT_FROM_NOTE = "Not sent. Open 10 & 2 to answer it.";

/**
 * Said only if the user asks why it didn't call (Fable, 3.3), the level named only to an account on its plan. Unnamed, it
 * says who gets the one call-back, so it answers "why" by itself (Fable, 19 November: "There's…" was rebuilt 4 times in 10).
 */
export const whyNoCall = (named: boolean) => `${named ? "Commute has" : "You get"} one call-back a day, and today's was used. It's back at midnight.`;
/** Said only if they ask what would change it: true, asked, and the levels they could choose, so named to everyone. */
export const NO_LIMIT = "Road Trip and Long Haul have no limit.";

// --- Away (stage 3.9; Fable's decisions 3.9-E), said only when the level bites ---

/**
 * Asked for Away on a level without it (`awayHours` 0), any way: said to everyone, since it names what would change it,
 * as `NO_LIMIT` does. Nothing is set up.
 */
export const AWAY_LONG_HAUL = "Away comes with Long Haul.";

/**
 * Asked by voice for an end past what the level allows (`timeReadback`'s shape): the end asked for and the furthest it can
 * keep, each as said ("Monday at 8 in the morning"), waiting for a yes. `named`: the account is on Long Haul's plan, so
 * the level is named; else the same without it. An end within the level's hours names no level and asks nothing.
 */
export const awayReadback = (hours: number, asked: string, furthest: string, named: boolean) =>
  `Away lasts up to ${hours} hours${named ? " on Long Haul" : ""}, so not until ${asked}. It would end ${furthest} instead. OK?`;

/** Away set up, said word for word: after a yes to `awayReadback` (its end the furthest), and for an end within the level's. */
export const awayOn = (until: string) => `Away is on until ${until}.`;

/** Away turned on with this phone's Notifications off (stage 5's card refuses so): there'd be nothing to tell it by. */
export const AWAY_NOTIFICATIONS = "Turn on Notifications to use Away.";

/** The card's footer (stage 5), and its refusal of an end past the level's: "Up to 72 hours." */
export const awayFooter = (hours: number) => `Up to ${hours} hours.`;

/** Watching's second line on Commute's rows (Fable, 3.3), before the time left. */
export const WATCHING_NOTE = {
  /** A call-back asked for in words, with today's ring used: it notifies. */
  used: "A notification; today's call-back is used",
  /** Two or more asked for, none fired: whichever is first rings. */
  either: "A call for whichever comes first",
  /** The call-back a hang-up set up by itself: it notifies (it never takes the day's ring). */
  notify: "A notification",
} as const;
