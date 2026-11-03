// The types the connector shares with the 10 & 2 service (exported from its brain/src/adapter.ts).
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
 * worktree of the project's current commit, or the project's own checkout.
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
  | { kind: "archive"; itemId: string }
  | { kind: "start_work"; placeId: string; title: string; message: string; profile: LaunchProfile };

export type ActionKind = Action["kind"];

/** What an action is about: the item it changes, or the place new work starts in. */
export const targetOf = (a: Action) => (a.kind === "start_work" ? a.placeId : a.itemId);

/** `unknown`: the request may have been applied (a dropped connection); retry with the same key. `itemId`: the item it made. */
export type Receipt = { ok: true; itemId?: string } | { ok: false; error: string; unknown?: boolean };

export interface Adapter {
  readonly name: string;
  readonly actions: readonly ActionKind[];
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
