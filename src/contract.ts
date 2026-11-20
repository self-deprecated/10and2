// The types the connector shares with the 10 & 2 service (exported from its brain/src/adapter.ts).
// The generic contract between the brain and a work system (T3 Code is the first).
// Nothing above this file knows about threads, projects or T3's wire format.

export type ItemStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle";

export type WorkItem = {
  id: string;
  title: string;
  /** What the item belongs to, spoken as-is ("nix", "screen-gate"). */
  group: string;
  /**
   * On a computer that isn't the brain's own, `group` says which ("expo, on Quartz"): the project alone ("expo") and
   * the computer as it's said ("Quartz"). Unset otherwise: the group is the project.
   */
  project?: string;
  machine?: string;
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
  /** When the item was started, if the system says (connectors 0.10.0 on). */
  createdAt?: string | null;
};

/**
 * The first thing the user asked an item, and when (the message's own time). `complete`: the system read the item from
 * its start, so this is truly the first; false when only a recent window was read (a long T3 thread), so this is the
 * oldest ask that window holds.
 */
export type FirstAsk = { text: string; at: string; complete: boolean };

/**
 * Which reply a report's text is: the run it ended, the message, and when that run finished. A later run that ends
 * without a reply (a failure, a cancel) moves `lastRunAt` but not this, so it never makes an old reply look new.
 * `byAgent`: the agent started that run itself, as T3 does when a background task it left running finishes, so the reply
 * goes on from the one before it rather than answering the user.
 */
export type ReplyRef = { runId: string | null; messageId: string; at: string; byAgent?: true };

/**
 * One of an item's replies, from any finished run: its text, and the user's message that started that run (none for a
 * run the agent started itself).
 */
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
  /**
   * When the replies before it finished, newest first (a few), when the system says: what counts how many the user
   * hasn't heard without fetching them (`replies`).
   */
  earlier?: string[];
};

/**
 * A model a new thread's coding agent can start on, as its coding app offers it in one place: never the model 10 & 2
 * itself runs on (brain/src/models.ts). `id`: the connector's own, sent back as start_work's `model` and never said;
 * `name`: what the user says and hears ("Claude Opus 5.5"); `provider`: what serves it, as the coding app names it,
 * where it has more than one (T3 Code's provider instances: "Claude", "Claude Proxy", "Codex"), from connectors after
 * 0.10.0. One per name and provider in a place, the one a start with none would use first.
 */
export type CodingModel = { id: string; name: string; provider?: string };

/**
 * Where new work can start. `folder`: the end of its checkout's path ("mono/nix"), and `repo`: its repository's name
 * ("mono-nix"), from connectors 0.7.0 on: other names the user may say for it, and how two places with one name are told
 * apart (places.ts). `models`: what a new thread there can be started on (docs/launch/thread-model.md), from connectors
 * after 0.10.0 on; empty where its coding app offers no choice through 10 & 2, absent from an older connector.
 */
export type Place = { id: string; name: string; /** When an item there was last active, if any. */ activeAt: string | null; folder?: string; repo?: string; models?: CodingModel[] };

/**
 * A place as `tenandtwo://work` carries it: its `models` named by `catalog`, a key into the view's `catalogs`, since
 * most places share one list. A connector packs them; the brain's RemoteAdapter unpacks them into `Place.models`.
 */
export type WirePlace = Omit<Place, "models"> & { catalog?: string };

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
  /**
   * `title`: the brain's, made from the prompt (titles.ts). None: the work system names the thread (T3 Code's
   * `generateTitle`; Claude Code by itself). `model`: one of the place's `models` by its `id`, only to a connector whose
   * start_work schema lists it; none: the coding app's own default, as before.
   */
  | { kind: "start_work"; placeId: string; title?: string; message: string; profile: LaunchProfile; model?: string };

export type ActionKind = Action["kind"];

/**
 * A short name for a new thread from its first prompt, for whatever needs one when the brain has made no title (a
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
  /** The user's first message to the item (not a note the agent wrote itself), or null when it has none yet. */
  firstAsk?(id: string): Promise<FirstAsk | null>;
  /**
   * The time zone (IANA, "Europe/Copenhagen") of the computer holding `itemId`, as it reports it (connectors 0.10.0 on),
   * or null when unknown: what "yesterday at 8 AM" is said in.
   */
  timeZone?(itemId: string): string | null;
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
