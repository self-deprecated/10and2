// The generic contract between the brain and a work system (T3 Code is the first).
// Nothing above this file knows about threads, projects or T3's wire format.

export type ItemStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle";

export type WorkItem = {
  id: string;
  title: string;
  /** What the item belongs to, spoken as-is ("nix", "screen-gate"). */
  group: string;
  status: ItemStatus;
  updatedAt: string;
  settled: boolean;
  /** Set only while the snooze is in effect. */
  snoozedUntil: string | null;
  /** The item this one was spawned by (a subagent's parent), or null for top-level work. */
  parentId: string | null;
  /** The system itself says it is blocked on the user. */
  pendingQuestion: boolean;
  /** When the item's latest run finished, if the system says. */
  lastRunAt?: string | null;
  /** Which question it's waiting on, when it is, so the same question isn't news twice. */
  questionId?: string | null;
  /** When the user last opened it in the system itself: a watermark of its `updatedAt`, if the system tracks visits. */
  visitedAt?: string | null;
  /** When the user last wrote in it, if the system says. */
  wroteAt?: string | null;
};

/**
 * Which reply a report's text is: the run it ended, the message, and when that run finished. A later run that ends
 * without a reply (a failure, a cancel) moves `lastRunAt` but not this, so it never makes an old reply look new.
 */
export type ReplyRef = { runId: string | null; messageId: string; at: string };

/** One of an item's replies, from any finished run: its text, and the user's message that started that run. */
export type PastReply = ReplyRef & { text: string; prompt: string | null };

export type Report = {
  /** The agent's last reply from a finished run, untrimmed. */
  text: string;
  /** While a run is going: the latest note from that run, which is progress, not a result. */
  progress?: string | null;
  /** The open question, when the system tracks one explicitly. */
  question: string | null;
  /** Which reply `text` is, when the system says. */
  reply?: ReplyRef | null;
};

/** Where new work can start: a project, named as it's said, with where it is ("driver, on Quartz"). */
export type Place = { id: string; name: string; /** When an item there was last active, if any. */ activeAt: string | null };

/**
 * What new work runs with. Voice only ever names a profile; this is the most it can ask for. `workspace`: a fresh
 * worktree (starting where that machine's connector settings say), or the project's own checkout.
 */
export type LaunchProfile = {
  name: string;
  workspace: "worktree" | "root";
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  interactionMode: "default" | "plan";
};

export type Action =
  | { kind: "follow_up"; itemId: string; message: string }
  | { kind: "settle"; itemId: string }
  | { kind: "snooze"; itemId: string; until: string }
  /** Undoing a snooze or a settle: only from a tap on the phone, never by voice. */
  | { kind: "unsnooze"; itemId: string }
  | { kind: "unsettle"; itemId: string }
  | { kind: "archive"; itemId: string }
  /** No `title`: the work system names the thread from its prompt (T3 Code's `generateTitle`; Claude Code by itself). */
  | { kind: "start_work"; placeId: string; title?: string; message: string; profile: LaunchProfile };

export type ActionKind = Action["kind"];

/**
 * A short name for a new thread from its first prompt, for whatever needs one before the work system has named it (a
 * connector before 0.6.0, demo mode): its first line of the user's own words (not the line saying it was dictated, nor a
 * quoted one), cut at a word to about 50 characters. connector/src/t3/adapter.ts has the same, for T3's seed title.
 */
export function titleFrom(message: string): string {
  const line = message.split("\n").map((l) => l.trim()).find((l) => l && !/^\(.*\)$/.test(l) && !l.startsWith(">")) ?? "";
  const words = line.replace(/\s+/g, " ");
  if (words.length <= 50) return words.replace(/[\s.,;:]+$/, "") || "New thread";
  const cut = words.slice(0, 50);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 25)).replace(/[\s.,;:]+$/, "")}…`;
}

/** What an action is about: the item it changes, or the place new work starts in. */
export const targetOf = (a: Action) => (a.kind === "start_work" ? a.placeId : a.itemId);

/** `unknown`: the request may have been applied (a dropped connection); retry with the same key. `itemId`: the item it made. */
export type Receipt = { ok: true; itemId?: string } | { ok: false; error: string; unknown?: boolean };

export interface Adapter {
  readonly name: string;
  readonly actions: readonly ActionKind[];
  /** What the machine holding `itemId` can do, when this adapter spans machines that may differ (an older connector). */
  actionsFor?(itemId: string): readonly ActionKind[];
  /** Whether the current connection has loaded live data, for one item or the local adapter. */
  connected(itemId?: string): boolean;
  /** Composite adapters identify local items for local health checks. Single adapters are local. */
  isLocal?(itemId: string): boolean;
  connectionStatus?(): { name: string; connected: boolean }[];
  /** Every live (not archived or deleted) item. */
  list(): Promise<WorkItem[]>;
  /** Where `start_work` can start something, as far as the system has said; none while it's unreachable. */
  places?(): Place[];
  report(id: string): Promise<Report>;
  /** Every finished run's reply, newest first, when the system keeps them. */
  replies?(id: string): Promise<PastReply[]>;
  /**
   * Performs one action. The same key must never perform it twice, so a retry after a dropped
   * connection is safe.
   */
  /** Why this action cannot be done right now, in words for the voice model, or null. */
  check?(action: Action): Promise<string | null>;
  execute(action: Action, idempotencyKey: string): Promise<Receipt>;
  /**
   * Tells the system the user has seen the item as it was at `watermark` (its `updatedAt` when the reply was read), so
   * it shows as read there too. Changes nothing in the item, and the system can mark it unread again. The same key never
   * counts twice. "unsupported": the system (or this machine's version of it) doesn't track visits.
   */
  markRead?(itemId: string, watermark: string, idempotencyKey: string): Promise<Receipt | "unsupported">;
  /** Calls back with the ids that changed in a way that matters; urgent when a question appeared. */
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void;
  close(): Promise<void>;
}
