// Each thread's own notifications, and Follow new threads (docs/launch/engine.md §2, Following; §11, stage 3.1). A
// thread tells you what its setting says: As my rules say (`rules`: a thread you don't follow, by default), Replies and
// questions (`both`: one you follow, by default), Questions only, or Nothing. Following sets Replies and questions
// whatever it was; unfollowing sets As my rules say, unless it was Nothing, which stays. The setting never changes the
// star: Questions only on a thread you don't follow notifies without following it. Kept per thread in table
// `thread_notify`, written whenever the star or the setting changes, so a thread with a row has been followed, unfollowed
// or set by hand. Follow new threads is the account's (kv `follow_new`): Never, The ones I start with 10 & 2 (the
// default, and what the brain always did), or Every new thread, which follows each top-level thread started after it was
// chosen (engine.ts `followNew`).
import type { Store } from "./store.ts";

export type ThreadNotify = "rules" | "both" | "questions" | "nothing";
const NOTIFIES: readonly string[] = ["rules", "both", "questions", "nothing"] satisfies ThreadNotify[];

export const isNotify = (x: unknown): x is ThreadNotify => typeof x === "string" && NOTIFIES.includes(x);

/** A thread's setting: the one it was given, else its default (Replies and questions followed, As my rules say not). */
export function notifyOf(set: ThreadNotify | null | undefined, starred: boolean): ThreadNotify {
  return set ?? (starred ? "both" : "rules");
}

/** What following (`on`) or unfollowing leaves: Replies and questions; As my rules say, unless it was Nothing. */
export function notifyAfterStar(on: boolean, was: ThreadNotify): ThreadNotify {
  return on ? "both" : was === "nothing" ? "nothing" : "rules";
}

/** Whether a thread set so tells you when an agent there asks something. Until your rules (3.4), As my rules say doesn't. */
export const tellsQuestions = (n: ThreadNotify) => n === "both" || n === "questions";
/** Whether a thread set so tells you when it replies. */
export const tellsReplies = (n: ThreadNotify) => n === "both";

export type FollowNew = "never" | "started" | "every";
const CHOICES: readonly string[] = ["never", "started", "every"] satisfies FollowNew[];
/** `at`: when Every new thread was chosen; a thread started after it is followed. */
export type FollowNewSetting = { choice: FollowNew; at?: number };

const KEY = "follow_new";
export const FOLLOW_NEW_DEFAULT: FollowNewSetting = { choice: "started" };

/** The account's Follow new threads: what it chose, else The ones I start with 10 & 2. */
export function followNewOf(store: Pick<Store, "get">): FollowNewSetting {
  try {
    const f = JSON.parse(store.get(KEY) ?? "null");
    if (!f || !CHOICES.includes(f.choice)) return FOLLOW_NEW_DEFAULT;
    return f.choice === "every" && Number.isFinite(f.at) ? { choice: "every", at: f.at } : { choice: f.choice === "every" ? "started" : f.choice };
  } catch {
    return FOLLOW_NEW_DEFAULT;
  }
}

/**
 * Sets Follow new threads. Every new thread chosen again keeps when it was first chosen, so the same request twice
 * changes nothing; chosen anew, only threads started from now on are followed. Changing it never unfollows anything.
 */
export function setFollowNew(store: Pick<Store, "get" | "set">, choice: FollowNew, now: number): FollowNewSetting {
  const was = followNewOf(store);
  const f: FollowNewSetting = choice === "every" ? { choice, at: was.choice === "every" ? was.at! : now } : { choice };
  store.set(KEY, JSON.stringify(f));
  return f;
}

/** `PUT /api/account/follow-new`'s body: `{ choice }`, one of the three; undefined for anything else. */
export function followNewFrom(body: unknown): FollowNew | undefined {
  const c = (body as { choice?: unknown } | null)?.choice;
  return typeof c === "string" && CHOICES.includes(c) ? (c as FollowNew) : undefined;
}
