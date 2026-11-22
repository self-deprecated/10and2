// A computer offline and back (docs/launch/engine.md §11, stage 3.7; Fable's decisions for items 6 to 8, topics 9 to
// 12, binding for words): when it counts as offline, and every line that says so, built here and said or shown word for
// word, as watch-lines.ts's are. Ported from spike/stall-alarm's mechanism, its "stopped reporting" made "offline", the
// word the app and the notification use (so its measured 20 of 20 doesn't carry over: unmeasured, §11 3.7's notes).
//
// Offline is no ping for the link's staleness (75 s), then a 3-minute grace: a blip shorter than that is never mentioned.
// It can't be told from sleep, a closed lid, a reboot or lost Wi-Fi, so the word is always "offline", and since the
// agents may well still be working, nothing here ever says they stopped. The notifications that say it are reach.ts's.
import type { Link } from "./adapter.ts";
import { STALE_MS } from "./connector-client.ts";
import { ruleWhy } from "./my-rules.ts";
import { clockOf } from "./zone.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** After the link's staleness, how long a silent computer is given before it's offline (a Wi-Fi handover, a reconnect). */
export const OFFLINE_GRACE_MS = 3 * MIN;
/** A computer not heard from in longer than this is offline. */
export const OFFLINE_MS = STALE_MS + OFFLINE_GRACE_MS;

/** When a computer last heard from at `heardAt` is first offline: the first millisecond past it (§7, due means true). */
export const offlineAt = (heardAt: number) => heardAt + OFFLINE_MS + 1;

/** Since when the computer is offline (when it was last heard from), or null while it reports or is within the grace. */
export function offlineSince(link: Link | null | undefined, now: number): number | null {
  return link && !link.linked && now >= offlineAt(link.heardAt) ? link.heardAt : null;
}

/** What one computer gone offline is news of (`News.offline`): since when, and the watched threads running there. */
export type Offline = {
  since: number;
  /**
   * Newest first. `why`: what tells the user about it (a call-back asked for in words, following, set by hand, or Away,
   * stage 3.9). Older code reads an Away thread's as none of its own: its why line is left out there.
   */
  threads: { itemId: string; handle: string; why: "callback" | "follow" | "set" | "away" | "rule" }[];
  /** Example 4's line (stage 3.4), its why ("Your rule: …") for threads only it tells. Older code leaves it out. */
  line?: string;
};

const was = (n: number) => (n === 1 ? "was" : "were");

/**
 * The one line the Timeline and a missed call surface (Fable, topic 10, Jordan's sentence): "Quartz went offline: API was
 * running" for one thread with names shown, "…: 2 threads were running" for several, "…: a thread was running" hidden.
 */
export function offlineLine(machine: string, names: string[], shown: boolean): string {
  const who = names.length > 1 ? `${names.length} threads` : shown ? names[0] : "a thread";
  return `${machine} went offline: ${who} ${was(names.length)} running`;
}

/** The incoming call's caller line (Fable, topic 11): "Quartz went offline"; two at once, "2 computers went offline". */
export const offlineCaller = (machines: string[]) => (machines.length === 1 ? `${machines[0]} went offline` : `${machines.length} computers went offline`);

/** How long a computer was offline, said: under 90 minutes in minutes ("6 minutes", "75 minutes"); then "about 2 hours". */
export function offlineFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 90) return m === 1 ? "a minute" : `${m} minutes`;
  return `about ${Math.round(m / 60)} hours`;
}

/**
 * How long ago a computer went offline, for the facts the voice is given (Fable, topic 12): "4 minutes ago", "about 9
 * hours ago", past a day "since Tuesday" (its weekday on the phone's clock, else UTC's).
 */
export function offlineAgo(since: number, now: number, zone?: string | null): string {
  const m = Math.max(1, Math.round((now - since) / MIN));
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (now - since < 24 * HOUR) return h === 1 ? "about an hour ago" : `about ${h} hours ago`;
  return `since ${clockOf(since, zone ?? "UTC").weekday}`;
}

/** Threads as a fixed spoken line names them: "API", "API and Docs", "API, Docs and Schema"; four or more by count. */
export function spokenNames(names: string[]): string {
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return names.length === 1 ? names[0] : `${names.length} threads`;
}

/**
 * How a call-back about a computer gone offline opens, word for word from code, the computer first (Fable, topic 11):
 * "Quartz went offline while API was running. I can't tell if it's still working. I'll call you if it replies."; for
 * several, "…while API and Docs were running. I can't tell if they're still working. I'll call you if one replies."
 * (four or more, "while 4 threads were running"). `then`: how a later reply reaches them, the call-back still watching (a
 * call, a notification), or nothing (the last sentence left out). `backAfterMs`: the computer is back already, "Quartz
 * went offline for 6 minutes while API was running, and it's back."
 */
export function offlineOpening(machine: string, names: string[], then: "call" | "notify" | null, backAfterMs?: number): string {
  const one = names.length === 1;
  if (backAfterMs !== undefined) return `${machine} went offline for ${offlineFor(backAfterMs)} while ${spokenNames(names)} ${was(names.length)} running, and it's back.`;
  const replies = one ? "if it replies" : "if one replies";
  const last = then === "call" ? ` I'll call you ${replies}.` : then === "notify" ? ` I'll send a notification ${replies}.` : "";
  return `${machine} went offline while ${spokenNames(names)} ${was(names.length)} running. I can't tell if ${one ? "it's" : "they're"} still working.${last}`;
}

/**
 * `wait_for` about a thread whose computer is offline (Fable, topic 12): no wait is made, and this is said word for word.
 * "Quartz is offline, so I can't watch API right now."
 */
export const offlineRefusal = (machine: string, names: string[]) => `${machine} is offline, so I can't watch ${spokenNames(names)} right now.`;

/** Watching's note on a call-back whose threads' computer is offline (Fable, topics 8 and 11): "Quartz is offline". */
export const offlineNote = (machine: string) => `${machine} is offline`;

/** A notification's why lines for offline news, each once, in the order made (Fable, topic 10); `names` as `ruleWhy`'s. */
export function offlineWhy(o: Offline, names = true): string {
  const lines: string[] = [];
  const n = (why: Offline["threads"][number]["why"]) => o.threads.filter((t) => t.why === why).length;
  if (n("callback")) lines.push("You asked to hear back.");
  if (n("follow")) lines.push(n("follow") > 1 ? "You follow them." : "You follow it.");
  if (n("set")) lines.push(n("set") > 1 ? "You set them to notify you." : "You set it to notify you.");
  if (n("away")) lines.push("Away is on.");
  if (n("rule") && o.line) lines.push(ruleWhy(o.line, names));
  return lines.join("\n");
}

