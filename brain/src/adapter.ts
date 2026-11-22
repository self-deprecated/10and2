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
  /**
   * What it's waiting on, when the work system says: a question the user answers ("input"), or a permission or
   * approval ("approval"), which 10 & 2 never gives, so it's answered at the computer. Unset when it can't tell, or
   * from a connector before it said (docs/launch/engine.md, stage 2).
   */
  questionKind?: "input" | "approval";
  /** When the user last opened it in the system itself: a watermark of its `updatedAt`, if the system tracks visits. */
  visitedAt?: string | null;
  /** When the user last wrote in it, if the system says. */
  wroteAt?: string | null;
  /**
   * When you last wrote in it yourself, as its work system records it (docs/launch/engine.md §11 stage 3.9; connectors
   * from this change on): `at`, the last message you typed in the agent's own app on a computer or in T3 Code's phone
   * app; `desk`, the last known to be typed on a computer (not OpenCode's or Pi's, whose plugins and extensions write the
   * user's message too, nor a Claude Code turn relayed from Slack or an email). Never one of 10 & 2's own sends, nor
   * anything an agent, a script, a schedule or the work system wrote as yours (a usage limit's resume, a notice, a
   * relayed answer, a headless run's prompt): what it can't say a person typed isn't counted. Null for none it has read. Absent from an older connector:
   * nothing its messages say is taken as you writing.
   */
  typed?: { at: string | null; desk: string | null };
  /** When the item was started, if the system says (connectors 0.10.0 on). */
  createdAt?: string | null;
  /**
   * Whether the connector reads this thread's test runs (`Report.checks`, docs/launch/engine.md §11 stage 3.10): true
   * where it does, false where its work system isn't covered (Pi). Absent from an older connector, which doesn't say:
   * never read as "no test ran" or as a pass.
   */
  testRuns?: boolean;
  /**
   * It holds a command on its computer's list until the user lets it run from the phone, or it's stopped (Commands that
   * wait, docs/launch/engine.md §11 stage 4; Fable's 4-H2): `pendingQuestion` is true and `questionId` is the hold's own
   * (`g-…`, new each hold). Never answered by a follow-up: only `answerHold` lets it run. Absent from an older connector.
   */
  gate?: Gate;
};

/**
 * A command a computer holds (Commands that wait; connector/src/gate.ts): the whole Bash call as the phone shows it
 * (credentials masked, spaces collapsed, at most 120 characters), the command on the list it ran (`matched`, "terraform
 * apply -auto-approve", which names it), and since when (ISO).
 */
export type Gate = { command: string; matched: string; since: string };

/**
 * One kind of check a run ran on the computer (its tests, a build or a lint), from the commands' exit codes or their
 * runner's own summary read there, never the agent's words (docs/launch/engine.md §11 stage 3.10; spike/run-receipts).
 * `ok`: its last run of that kind passed; `runs` and `failed`: how many of that kind it ran and how many failed;
 * `label`: which runner, in at most two words from a fixed table or the machine's own policy ("pnpm test"), never the
 * command or its output; `stale`: it changed files after that last run; `edited`: it changed files before it, in the
 * same run.
 */
export type CheckRun = { ok: boolean; runs: number; failed: number; label: string; stale?: true; edited?: true };
/** A run's checks, by kind: absent when it ran none the connector recognised. */
export type Checks = { tests?: CheckRun; build?: CheckRun; lint?: CheckRun };

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

/**
 * Metadata for a prose document linked by a thread's reply (connectors after 0.12.0, opt-in): never carries a file
 * path. `id` is opaque and bound to its thread on the connector; `contentHash` changes whenever the file's text does.
 */
export type DocSummary = {
  id: string;
  name: string;
  chars: number;
  words: number;
  minutes: number;
  headings: string[];
  contentHash: string;
  reason: "review_wait" | "primary_link" | "session_plan" | "secondary_link";
  offer: "primary" | "secondary";
};

/** The redacted text of a linked document fetched through `read_document`. */
export type DocumentText = { id: string; name: string; text: string; contentHash: string };

export type Report = {
  /** The agent's last reply from a finished run, untrimmed. */
  text: string;
  /** While a run is going: the latest note from that run, which is progress, not a result. */
  progress?: string | null;
  /** The open question, when the system tracks one explicitly. */
  question: string | null;
  /**
   * The open question's own options, exactly as the work system lists them, when it asks one question with two or more
   * and holds it open for 10 & 2 to answer: a follow-up that is one of them, word for word, selects it. Null otherwise
   * (several questions at once, one with no options, a permission or a plan to approve, a question only the terminal
   * can answer); absent from a connector before it said (docs/launch/engine.md, stage 2).
   */
  choices?: string[] | null;
  /** Which reply `text` is, when the system says. */
  reply?: ReplyRef | null;
  /**
   * When the replies before it finished, newest first (a few), when the system says: what counts how many the user
   * hasn't heard without fetching them (`replies`).
   */
  earlier?: string[];
  /**
   * What the run `reply` ends ran of its checks (stage 3.10), when the connector reads test runs for this thread
   * (`WorkItem.testRuns`) and it ran any it recognised.
   */
  checks?: Checks;
  /**
   * The run `reply` ends had its checks, but they couldn't be read this time (its work system's record locked or
   * refused): `checks` absent then isn't "no check ran" (the review's finding on 3.10). Absent from older connectors.
   */
  checksUnread?: true;
  /** While a run is going: what it has run of its checks so far, as far as its newest work shows. */
  running?: Checks;
  /**
   * When the run still going took the user's latest words (its start, or a message steered into it): a run a follow-up
   * is queued behind isn't taken for the follow-up's.
   */
  runningSince?: string;
  /**
   * The run still going's id, as its reply will carry it (`ReplyRef.runId`), when the connector says (the review of
   * 45ec9eccdf6f, F6): a mid-run pass told later is told by that run's own end, never another run's.
   */
  runningId?: string;
  /** A held command (Commands that wait; `WorkItem.gate`): `question` is "wants to run <command>", with no `choices`. */
  gate?: Gate;
  /** Prose documents linked by the reply (when the machine's connector opted into document reading). */
  docs?: DocSummary[];
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
  /**
   * `questionId`: an answer to that question only (a tap on one of its `choices`). The computer sends it only while the
   * thread asks that question by the work system's latest view, so an answer to one question never answers the next.
   */
  | { kind: "follow_up"; itemId: string; message: string; questionId?: string }
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

/**
 * The computer holding a thread, as a host that spans computers that can drop knows it (the cloud's links): its name as
 * it's said ("Quartz"), when it was last heard from (a frame, a ping, its link opening or closing), and whether its link
 * is up now (heard from within the link's staleness, 75 s). docs/launch/engine.md §11 item 7.
 */
export type Link = { machine: string; heardAt: number; linked: boolean };

/** `unknown`: the request may have been applied (a dropped connection); retry with the same key. `itemId`: the item it made. */
export type Receipt = { ok: true; itemId?: string } | { ok: false; error: string; unknown?: boolean };

/**
 * A send or a start set up for later, as the brain hands it to the computer it targets (docs/launch/contracts.md §2,
 * "Sends and starts for later"; the connector's `connector/src/schedules.ts`): its ids are that computer's own.
 */
export type Schedule = {
  v: 1;
  /** "R-<rule>-<n>:<itemId>" or "R-<rule>-<n>:start": also the computer's Ledger key when it fires. */
  id: string;
  action: Action;
  when: { at: string } | { after: { itemId: string; lastRunAt: string | null }; notBefore?: string };
  until: string;
  guard: { agreedAt: string; running: boolean; lastRunAt: string | null; questionId: string | null };
  said: string;
  zone: string;
};

/**
 * What a computer holds for later, as its view and `set_schedules` report it. `code`: the short reason the brain picks
 * its line by (Fable's 4-G: `asleep`, `unreached`, `busy`, `app`, `wrote`, `ran`, `asking`, `gone`, `settled`, `policy`,
 * `ceiling`, `place`, `refused`, and a set's `time`, `full`, `invalid`, `conflict`, `version`), beside its words in `why`.
 */
export type Held = {
  id: string;
  state: "waiting" | "firing" | "sent" | "not_sent" | "missed" | "cancelled" | "unknown" | "refused";
  code?: string; why?: string; app?: string;
  at?: string; firedAt?: string; receipt?: Receipt;
  after?: { lastRunAt: string | null; questionId: string | null };
};

/**
 * What handing a computer its set came to: what it holds, a refusal of the whole set (a `seq` it has seen, its clock off
 * by `minutes`), or `lost`: the set timed out or failed on the wire, which closed it, so the reconnect's first set decides.
 */
export type SetAnswer = { held: Held[] } | { refused: "stale" | "clock"; error: string; minutes?: number } | { lost: true };

/** What a computer lets sends and starts set up for later do there (its policy's `rules`, `10and2 agents`). */
export type LaterRules = "off" | "send" | "start";

/**
 * A computer that can be handed sends and starts for later (stage 4b), as the adapter spanning it knows it: its name as
 * it's said ("Quartz"), what its ids carry before their own ("Quartz|", none for the brain's own machine on Lattice),
 * whether its 10and2 lists `set_schedules` (`tool`: false for one too old), what its policy lets them do (`rules`: null
 * from a connector without them), the most a launch may run with there, what it holds as last seen, and whether its
 * link is up with its handshake done. `allows`: the computer's own saved word on an action (its tool list, its ceiling,
 * its refusals), with no round trip and whether or not it's connected; null when it would take it.
 */
export type LaterLink = {
  machine: string;
  prefix: string;
  tool: boolean;
  rules: LaterRules | null;
  ceiling: LaunchProfile["runtimeMode"];
  held: Held[];
  linked(): boolean;
  allows(action: Action): string | null;
  set(seq: number, schedules: Schedule[], now: number): Promise<SetAnswer>;
};

export interface Adapter {
  readonly name: string;
  readonly actions: readonly ActionKind[];
  /** What the machine holding `itemId` can do, when this adapter spans machines that may differ (an older connector). */
  actionsFor?(itemId: string): readonly ActionKind[];
  /** Whether the current connection has loaded live data, for one item or the local adapter. */
  connected(itemId?: string): boolean;
  /** The work system holding `itemId` by its own name ("T3 Code"), as its machine last said, or null when it hasn't. */
  appOf?(itemId: string): string | null;
  /** Composite adapters identify local items for local health checks. Single adapters are local. */
  isLocal?(itemId: string): boolean;
  connectionStatus?(): { name: string; connected: boolean }[];
  /**
   * The computer holding `itemId` and whether it's reporting (`Link`), or null when this adapter can't tell (Lattice's
   * own threads): `list()` keeps a silent computer's last view, so its threads read as they were then.
   */
  link?(itemId: string): Link | null;
  /** Every live (not archived or deleted) item. */
  list(): Promise<WorkItem[]>;
  /** Where `start_work` can start something, as far as the system has said; none while it's unreachable. */
  places?(): Place[];
  report(id: string): Promise<Report>;
  /** Every finished run's reply, newest first, when the system keeps them. */
  replies?(id: string): Promise<PastReply[]>;
  /** The user's first message to the item (not a note the agent wrote itself), or null when it has none yet. */
  firstAsk?(id: string): Promise<FirstAsk | null>;
  /** A linked document's redacted text, by thread and opaque doc id, or null when unsupported or unavailable. */
  readDocument?(itemId: string, docId: string): Promise<DocumentText | null>;
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
  /**
   * Answers a held command (Commands that wait; Fable's 4-H2): `run` lets it run (back to the agent's own permission
   * mode), else it's stopped. Only for the hold `questionId` while it's held; the same answer again gets its first
   * receipt. Absent, or `"unsupported"`: the computer's 10and2 holds no commands.
   */
  answerHold?(itemId: string, questionId: string, run: boolean): Promise<Receipt | "unsupported">;
  /** The computers that can be handed sends and starts for later (stage 4b); none from an adapter without them. */
  laterLinks?(): LaterLink[];
  /**
   * Calls back when one of them links (its handshake done: its first set is due now, even an empty one) and whenever it
   * reports (a refusal is sent again then, and what it holds is read).
   */
  watchLater?(l: (link: LaterLink, why: "linked" | "report") => void): () => void;
  close(): Promise<void>;
}
