// Everything that must outlive a voice session lives here: conversation transcripts, proposals,
// the operation ledger, drive memory, classification cache and session billing.
// `node:sqlite` is only opened for a path (Lattice); in Workers it is an inert stub, and the brain's Durable Object passes
// its own SQLite instead.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nodeSql, type SqlDb } from "./sql.ts";
import type { LaunchProfile, ReplyRef } from "./adapter.ts";
import type { Segment } from "./reading.ts";
import type { Wait } from "./waits.ts";
import { reasonText, type EndReason } from "./voice/endReason.ts";
import type { CostRow } from "./spend.ts";

export type Card = {
  itemId: string;
  contentKey: string;
  state: CardState;
  summary: string;
  ask: string | null;
  suggested: "none" | "follow_up" | "settle" | "snooze" | "archive";
  classifiedAt: string;
  /** The reply the card was read from, if the system says which. */
  reply?: CardReply | null;
};
/** A reply, and the item's `updatedAt` when it was read: what marking it read in the system sends (`markRead`). */
export type CardReply = ReplyRef & { watermark: string };
export type CardState = "needs_decision" | "ready_to_apply" | "blocked" | "running" | "done_unreviewed" | "stale";

/**
 * The conversation every change made by a tap on the phone is kept under (`Proposals.tap`): never a real one (those ids
 * are at least 8 characters), so taps stay out of every conversation's changes, and the timeline finds them all here.
 */
export const TAP = "tap";

export type ProposalState = "proposed" | "executing" | "executed" | "partial" | "failed" | "unknown" | "cancelled" | "expired";
/** `group`: the project the readback said it was in (proposals since targets kept it). */
export type ProposalTarget = { itemId: string; handle: string; group?: string; parentId?: string };
export type Proposal = {
  id: string;
  conversationId: string;
  action: string;
  targets: ProposalTarget[];
  /**
   * `draftId`: a reply the user dictated on the phone (drafts.ts), sent as `message`. A `start_work` has no targets: it
   * starts `title` in place `placeId` (said `place`) with `profile`, and once started, `itemId` is its new thread.
   * `keptId`: a reply kept for later, sent by this. `confirm`: how the user must agree to it (proposals.ts `Level`);
   * none (a proposal made before levels): the readback heard, then a yes.
   */
  fields: { message?: string; until?: string; draftId?: string; placeId?: string; place?: string; title?: string; profile?: LaunchProfile; itemId?: string; target?: string; keptId?: string; confirm?: "none" | "yes" | "readback" | "tap"; /** Carried out by the brain on the user's spoken yes (`VoiceSession.yesHeard`). */ heardYes?: boolean };
  readback: string;
  /**
   * What the user must have heard: for each group, at least `need` of its words, spoken after `from`; or, with `head`,
   * the readback's action and names word for word, then perhaps `where` (the project), followed by `next` (or a clause
   * break when null). See `saysHead`.
   */
  mustHear: { words: string[]; need: number; from: number; head?: string[]; where?: string[]; next?: string | string[] | null; message?: string; sequence?: string[] }[];
  /** Offset into the conversation's assistant transcript when this proposal was made. */
  createdFrom: number;
  expiresAt: number;
  state: ProposalState;
  createdAt: number;
  result: string | null;
};

/**
 * Which of a thread's summaries the user has heard: its reply that finished at `replyAt` (ms; 0 for none), or for a
 * thread with no reply yet, the card read from `contentKey`. A later reply makes it news again.
 */
export type Briefed = { replyAt: number; contentKey: string | null };

/** What the user has heard from a thread: the reply from the run that finished at `runAt`, and question `question`. */
export type Seen = { runAt: number; question: string | null };

export type ConversationSummary = { id: string; startedAt: number; lastActive: number; title: string; turns: number; changes: number };

export type OperationState = "running" | "done" | "failed" | "unknown";

/**
 * What a conversation hung up to hand the phone (`/api/wait`): a thread's name, and which reply to read out
 * (`read_aloud`) or which thread to dictate a reply to (`dictate`).
 */
export type Handoff =
  | { handle: string; reply: { itemId: string; messageId: string } }
  | { handle: string; dictate: { itemId: string } }
  /** The session reached its cap: the phone carries the call on in a new one, at once. */
  | { handle: string; rollover: true }
  /** Hold: the phone listens for the wake word to come back, calling back if a wait started after it is ready. */
  | { handle: string; hold: true };

/**
 * A reply kept for later in a call (`keep`), unsent: what the phone's Not sent lists, until it's sent or discarded.
 * `threadName` and `project` as they were when it was kept. `note`: a dictated reply's first line, saying it was
 * dictated, which goes before `text` when it's sent. `draftId`: the phone's draft it was, if it was dictated.
 */
export type KeptReply = {
  id: string; threadId: string; threadName: string; project: string; text: string; note: string | null; draftId: string | null; conversationId: string; keptAt: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  item_id TEXT PRIMARY KEY, content_key TEXT NOT NULL, state TEXT NOT NULL,
  summary TEXT NOT NULL, ask TEXT, suggested TEXT NOT NULL, classified_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turns_by_conversation ON turns (conversation_id, id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, action TEXT NOT NULL, targets TEXT NOT NULL, fields TEXT NOT NULL,
  readback TEXT NOT NULL, must_hear TEXT NOT NULL, created_from INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL, item_id TEXT NOT NULL, action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, error TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, note TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stars (item_id TEXT PRIMARY KEY, at INTEGER NOT NULL, seen_run_at INTEGER NOT NULL, seen_question TEXT);
CREATE TABLE IF NOT EXISTS heard (
  conversation_id TEXT NOT NULL, item_id TEXT NOT NULL, run_at INTEGER NOT NULL, question TEXT, at INTEGER NOT NULL, PRIMARY KEY (conversation_id, item_id));
CREATE TABLE IF NOT EXISTS briefed (item_id TEXT PRIMARY KEY, reply_at INTEGER NOT NULL, content_key TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aliases (conversation_id TEXT NOT NULL, name TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (conversation_id, name));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  billed_seconds REAL, end_reason TEXT, closed_at INTEGER, hangup_failed_at INTEGER,
  fast INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0, resume TEXT);
CREATE TABLE IF NOT EXISTS waits (conversation_id TEXT PRIMARY KEY, wait TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS untold (conversation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, replies TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reads (
  item_id TEXT PRIMARY KEY, run_id TEXT, message_id TEXT NOT NULL, reply_at TEXT NOT NULL, watermark TEXT NOT NULL,
  read_at INTEGER NOT NULL, visit_pending INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS handoffs (conversation_id TEXT PRIMARY KEY, handoff TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, message_id TEXT NOT NULL, style TEXT NOT NULL, segments TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kept (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, thread_name TEXT NOT NULL, project TEXT NOT NULL, text TEXT NOT NULL, note TEXT,
  draft_id TEXT UNIQUE, conversation_id TEXT NOT NULL, kept_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS costs (
  ref TEXT PRIMARY KEY, day TEXT NOT NULL, op TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL, own INTEGER NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL, seconds REAL NOT NULL, chars INTEGER NOT NULL, retries INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS costs_by_day ON costs (day);
`;

/** One day's spend on one operation, on Driver's key or the account's own (`own`). */
export type CostDay = { day: string; op: string; own: boolean; usd: number; requests: number; seconds: number };

export class Store {
  readonly db: SqlDb;

  /** A file (or `:memory:`) opened with `node:sqlite`, or a database already open (a Durable Object's). */
  constructor(path: string | SqlDb) {
    if (typeof path === "string") {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = nodeSql(new DatabaseSync(path));
      this.db.exec("PRAGMA journal_mode = WAL;");
    } else this.db = path;
    // Before the first release the proposals table changed shape; proposals are short-lived, so drop it.
    const cols = (this.db.prepare("PRAGMA table_info(proposals)").all() as any[]).map((c) => c.name);
    if (cols.length && !cols.includes("created_from")) this.db.exec("DROP TABLE proposals");
    // Cards used to carry a model-invented name; threads are now named by their titles. Cards are a cache: drop them.
    const cardCols = (this.db.prepare("PRAGMA table_info(cards)").all() as any[]).map((c) => c.name);
    if (cardCols.includes("handle")) {
      // The opener was written from those cards and names threads the new briefing may leave out.
      this.db.exec("DROP TABLE cards");
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'kv'").get()) this.db.exec("DELETE FROM kv WHERE key = 'opener'");
    }
    // Hand-offs used to hold the prepared readings; now they say which reply, and the phone asks for its reading. They
    // last an hour at most: drop the old ones.
    if ((this.db.prepare("PRAGMA table_info(handoffs)").all() as any[]).some((c) => c.name === "readings")) this.db.exec("DROP TABLE handoffs");
    this.db.exec(SCHEMA);
    if (!(this.db.prepare("PRAGMA table_info(cards)").all() as any[]).some((c) => c.name === "reply")) this.db.exec("ALTER TABLE cards ADD COLUMN reply TEXT");
    // Sessions used to count as over once the brain stopped using them. Now one is over only when OpenAI says so
    // (`closed_at`); a session that reported its billed seconds got OpenAI's session.closed, so that counts.
    const sessionCols = (this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
    if (!sessionCols.includes("closed_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN closed_at INTEGER; ALTER TABLE sessions ADD COLUMN hangup_failed_at INTEGER;");
      this.db.exec("UPDATE sessions SET closed_at = ended_at WHERE ended_at IS NOT NULL AND billed_seconds IS NOT NULL");
    }
    // How many answers each session's backend gave, and whether in Fast mode: the phone's usage line.
    if (!sessionCols.includes("answers")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN fast INTEGER NOT NULL DEFAULT 0; ALTER TABLE sessions ADD COLUMN answers INTEGER NOT NULL DEFAULT 0;");
    }
    // What a brain restarted mid-call needs to take the session back (`liveSessions`).
    if (!(this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).some((c) => c.name === "resume")) this.db.exec("ALTER TABLE sessions ADD COLUMN resume TEXT");
    // What the phone showed of each call as it ended (callview.ts `final`): the call's record in History.
    if (!(this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).some((c) => c.name === "view")) this.db.exec("ALTER TABLE sessions ADD COLUMN view TEXT");
    // What Driver said that didn't happen, with its correction (`correctLastTurn`).
    if (!(this.db.prepare("PRAGMA table_info(turns)").all() as any[]).some((c) => c.name === "corrected")) this.db.exec("ALTER TABLE turns ADD COLUMN corrected TEXT");
  }

  // --- cards and briefing ---
  cards(): Card[] {
    return this.db.prepare("SELECT * FROM cards").all().map((r: any) => ({
      itemId: r.item_id, contentKey: r.content_key, state: r.state,
      summary: r.summary, ask: r.ask, suggested: r.suggested, classifiedAt: r.classified_at,
      reply: r.reply ? JSON.parse(r.reply) : null,
    }));
  }
  putCard(c: Card) {
    this.db.prepare(
      `INSERT INTO cards (item_id, content_key, state, summary, ask, suggested, classified_at, reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
       content_key=excluded.content_key, state=excluded.state, summary=excluded.summary,
       ask=excluded.ask, suggested=excluded.suggested, classified_at=excluded.classified_at, reply=excluded.reply`,
    ).run(c.itemId, c.contentKey, c.state, c.summary, c.ask, c.suggested, c.classifiedAt, c.reply ? JSON.stringify(c.reply) : null);
  }
  /** The same report from a later read: only which reply it is, and the watermark, move on. */
  setCardReply(itemId: string, reply: CardReply | null) {
    this.db.prepare("UPDATE cards SET reply = ? WHERE item_id = ?").run(reply ? JSON.stringify(reply) : null, itemId);
  }
  deleteCard(itemId: string) {
    this.db.prepare("DELETE FROM cards WHERE item_id = ?").run(itemId);
  }
  get(key: string): string | null {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any)?.value ?? null;
  }
  set(key: string, value: string) {
    this.db.prepare("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- what model calls cost (spend.ts) ---
  /**
   * Adds a call's usage to row `ref`. `raise`: the row holds a cumulative count (a voice session's billed seconds), so
   * it's raised to the new one when that's higher instead. The row keeps the day and key it was first written with.
   */
  addCost(ref: string, r: CostRow, raise: boolean, now = Date.now()) {
    const vals = [r.input, r.cached, r.cacheWrite, r.output, r.reasoning, r.seconds, r.chars, r.retries, r.usd];
    this.db.prepare(
      `INSERT INTO costs (ref, day, op, model, tier, own, requests, input, cached, cache_write, output, reasoning, seconds, chars, retries, usd, at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET ${raise
         ? "seconds = MAX(seconds, excluded.seconds), usd = MAX(usd, excluded.usd), at = excluded.at"
         : `requests = requests + 1, input = input + excluded.input, cached = cached + excluded.cached, cache_write = cache_write + excluded.cache_write,
            output = output + excluded.output, reasoning = reasoning + excluded.reasoning, seconds = seconds + excluded.seconds,
            chars = chars + excluded.chars, retries = retries + excluded.retries, usd = usd + excluded.usd, at = excluded.at`}`,
    ).run(ref, r.day, r.op, r.model, r.tier, r.own ? 1 : 0, ...vals, now);
  }
  /** Dollars spent on Driver's key on `day` on any of `ops`. */
  costOn(day: string, ops: readonly string[]): number {
    if (!ops.length) return 0;
    return Number((this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM costs WHERE day = ? AND own = 0 AND op IN (${ops.map(() => "?").join(", ")})`).get(day, ...ops) as any).usd);
  }
  /** Spend per day, operation and key since `from` (a UTC day). */
  costDays(from: string): CostDay[] {
    return (this.db.prepare("SELECT day, op, own, SUM(usd) AS usd, SUM(requests) AS requests, SUM(seconds) AS seconds FROM costs WHERE day >= ? GROUP BY day, op, own ORDER BY day").all(from) as any[])
      .map((r) => ({ day: String(r.day), op: String(r.op), own: Number(r.own) === 1, usd: Number(r.usd), requests: Number(r.requests), seconds: Number(r.seconds) }));
  }
  /** Rows older than `before` (a UTC day) go. */
  pruneCosts(before: string) {
    this.db.prepare("DELETE FROM costs WHERE day < ?").run(before);
  }

  // --- conversations ---
  touchConversation(id: string, now = Date.now()) {
    this.db.prepare(
      "INSERT INTO conversations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_active = excluded.last_active",
    ).run(id, now, now);
  }
  /** `corrected`: what in it Driver said that didn't happen, and the correction it made (session.ts `Conversations.correct`). */
  addTurn(conversationId: string, role: "user" | "assistant", text: string, now = Date.now(), corrected?: { said: string; note: string }[]) {
    if (!text.trim()) return;
    this.db.prepare("INSERT INTO turns (conversation_id, role, text, at, corrected) VALUES (?, ?, ?, ?, ?)")
      .run(conversationId, role, text.trim(), now, corrected?.length ? JSON.stringify(corrected) : null);
  }
  /** Driver's latest turn said `said`, which didn't happen: kept with its correction, as `addTurn`'s `corrected`. */
  correctLastTurn(conversationId: string, said: string, note: string) {
    const r = this.db.prepare("SELECT id, corrected FROM turns WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(conversationId) as any;
    if (!r) return;
    const corrected = [...(r.corrected ? JSON.parse(r.corrected) : []), { said, note }];
    this.db.prepare("UPDATE turns SET corrected = ? WHERE id = ?").run(JSON.stringify(corrected), r.id);
  }
  /**
   * The conversation's latest turns, oldest first, as history for a new session: what Driver said that didn't happen
   * is given as its correction ("[That was wrong: nothing was sent.]"), so it's never carried on as fact.
   */
  recentTurns(conversationId: string, limit: number): { role: "user" | "assistant"; text: string }[] {
    return (this.db.prepare("SELECT role, text, corrected FROM turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, limit) as any[])
      .reverse()
      .map((r) => ({ role: r.role, text: r.corrected ? withCorrections(r.text, JSON.parse(r.corrected)) : r.text }));
  }

  /** Every turn of a conversation with when it was said, oldest first (a flag's file). */
  turnsOf(conversationId: string): { role: "user" | "assistant"; text: string; at: number }[] {
    return (this.db.prepare("SELECT role, text, at FROM turns WHERE conversation_id = ? ORDER BY id").all(conversationId) as any[])
      .map((r) => ({ role: r.role, text: r.text, at: r.at }));
  }

  /** A conversation's sessions, oldest first, with how each ended. */
  sessionsOf(conversationId: string): { id: string; startedAt: number; endedAt: number | null; endReason: string | null }[] {
    return (this.db.prepare("SELECT id, started_at, ended_at, end_reason FROM sessions WHERE conversation_id = ? ORDER BY started_at").all(conversationId) as any[])
      .map((r) => ({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at ?? null, endReason: r.end_reason ?? null }));
  }

  /** Newest first, with a title from the user's first words and how many changes went through. */
  conversations(limit: number): ConversationSummary[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.created_at, c.last_active,
             (SELECT text FROM turns WHERE conversation_id = c.id AND role = 'user' ORDER BY id LIMIT 1) AS first_words,
             (SELECT COUNT(*) FROM turns WHERE conversation_id = c.id) AS turns,
             (SELECT COUNT(*) FROM proposals WHERE conversation_id = c.id AND state IN ('executed', 'partial')) AS changes
           FROM conversations c WHERE EXISTS (SELECT 1 FROM turns WHERE conversation_id = c.id)
           ORDER BY c.last_active DESC LIMIT ?`,
        )
        .all(limit) as any[]
    ).map((r) => ({ id: r.id, startedAt: r.created_at, lastActive: r.last_active, title: r.first_words ?? "", turns: r.turns, changes: r.changes }));
  }
  /**
   * The conversation last in use since `since`: its latest session started or ended then (a reading or dictation in
   * between has no session, so a session's end counts). Null if there's none.
   */
  lastConversation(since: number): string | null {
    const r = this.db.prepare(
      `SELECT c.id, MAX(c.last_active, COALESCE((SELECT MAX(ended_at) FROM sessions WHERE conversation_id = c.id), 0)) AS t
         FROM conversations c ORDER BY t DESC LIMIT 1`,
    ).get() as any;
    return r && r.t >= since ? r.id : null;
  }
  /**
   * When each conversation was last in use: its last session's end (or start, while one is live) or its last turn,
   * whichever is later. `last_active` alone moves only when a session starts.
   */
  lastActivity(): Map<string, number> {
    return new Map((this.db.prepare(
      `SELECT c.id, MAX(c.last_active,
         COALESCE((SELECT MAX(COALESCE(ended_at, started_at)) FROM sessions WHERE conversation_id = c.id), 0),
         COALESCE((SELECT MAX(at) FROM turns WHERE conversation_id = c.id), 0)) AS t
       FROM conversations c`,
    ).all() as any[]).map((r) => [r.id, Number(r.t)]));
  }
  conversation(id: string): { startedAt: number; lastActive: number } | null {
    const r = this.db.prepare("SELECT created_at, last_active FROM conversations WHERE id = ?").get(id) as any;
    return r ? { startedAt: r.created_at, lastActive: r.last_active } : null;
  }
  /** When a proposal was carried out (its first operation), or null if it never ran. */
  carriedOutAt(proposalId: string): number | null {
    return (this.db.prepare("SELECT MIN(at) AS at FROM operations WHERE proposal_id = ?").get(proposalId) as any)?.at ?? null;
  }
  turns(conversationId: string): { role: "user" | "assistant"; text: string; at: number }[] {
    return this.db.prepare("SELECT role, text, at FROM turns WHERE conversation_id = ? ORDER BY id").all(conversationId) as any[];
  }

  // --- proposals ---
  putProposal(p: Proposal) {
    this.db.prepare(
      `INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
       state=excluded.state, result=excluded.result, expires_at=excluded.expires_at, fields=excluded.fields`,
    ).run(p.id, p.conversationId, p.action, JSON.stringify(p.targets), JSON.stringify(p.fields), p.readback,
      JSON.stringify(p.mustHear), p.createdFrom, p.expiresAt, p.state, p.createdAt, p.result);
  }
  proposal(id: string): Proposal | null {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as any;
    return r ? rowToProposal(r) : null;
  }
  openProposals(conversationId: string): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE conversation_id = ? AND state = 'proposed' ORDER BY created_at").all(conversationId) as any[]).map(rowToProposal);
  }
  allOpenProposals(): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE state = 'proposed'").all() as any[]).map(rowToProposal);
  }
  proposalsFor(conversationId: string): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE conversation_id = ? ORDER BY created_at").all(conversationId) as any[]).map(rowToProposal);
  }
  /** Every proposal to send a dictated reply, oldest first. */
  draftProposals(draftId: string): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE json_extract(fields, '$.draftId') = ? ORDER BY created_at").all(draftId) as any[]).map(rowToProposal);
  }
  recentProposals(limit: number): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(rowToProposal);
  }

  /** A crash leaves in-flight outcomes uncertain; retry with the original operation keys. */
  recoverExecutingProposals() {
    const result = "Driver restarted while carrying this out; it's unknown whether it went through";
    this.db.transaction(() => {
      this.db.prepare("UPDATE operations SET state = 'unknown' WHERE state != 'done' AND proposal_id IN (SELECT id FROM proposals WHERE state = 'executing')").run();
      this.db.prepare("UPDATE proposals SET state = 'unknown', result = ? WHERE state = 'executing'").run(result);
    });
  }

  // --- operations ---
  /** Records an operation before it runs; returns false if this key already exists. */
  beginOperation(proposalId: string, itemId: string, action: string, key: string, now = Date.now()): boolean {
    const r = this.db.prepare(
      "INSERT OR IGNORE INTO operations (proposal_id, item_id, action, idempotency_key, state, at) VALUES (?, ?, ?, ?, 'running', ?)",
    ).run(proposalId, itemId, action, key, now);
    return Number(r.changes) === 1;
  }
  operation(key: string): { state: OperationState; error: string | null } | null {
    return (this.db.prepare("SELECT state, error FROM operations WHERE idempotency_key = ?").get(key) as any) ?? null;
  }
  finishOperation(key: string, state: OperationState, error: string | null) {
    this.db.prepare("UPDATE operations SET state = ?, error = ? WHERE idempotency_key = ?").run(state, error, key);
  }
  // --- memory: what the user has been working on lately, never the state of anything ---
  /** Saves a note; one already saved word for word is only dated anew, so asking "is that noted?" never doubles it. False then. */
  remember(conversationId: string | null, note: string, now = Date.now()): boolean {
    const again = this.db.prepare("UPDATE memory SET at = ?, conversation_id = ? WHERE lower(note) = lower(?)").run(now, conversationId, note);
    if (Number(again.changes) > 0) return false;
    this.db.prepare("INSERT INTO memory (conversation_id, note, at) VALUES (?, ?, ?)").run(conversationId, note, now);
    return true;
  }
  /** The newest notes saved at or after `since`, oldest first. */
  memories(limit: number, since = 0): { note: string; at: number }[] {
    return (this.db.prepare("SELECT note, at FROM memory WHERE at >= ? ORDER BY id DESC LIMIT ?").all(since, limit) as any[]).reverse().map((r) => ({ note: r.note, at: r.at }));
  }
  /** Where memory starts: `days` back, but never before the user last wiped it. */
  memoryStart(days: number, now = Date.now()): number {
    return Math.max(now - days * 86_400_000, Number(this.get("memoryClearedAt") ?? 0));
  }
  /** The notes saved between `from` and `to`, oldest first. */
  notesBetween(from: number, to: number): string[] {
    return (this.db.prepare("SELECT note FROM memory WHERE at >= ? AND at <= ? ORDER BY id").all(from, to) as any[]).map((r) => r.note);
  }
  /** Deletes notes older than `before`. */
  forgetBefore(before: number) {
    this.db.prepare("DELETE FROM memory WHERE at < ?").run(before);
  }
  /** Deletes every note, and keeps earlier changes out of memory too (they stay in History). */
  forgetAll(now = Date.now()) {
    this.db.exec("DELETE FROM memory");
    this.set("memoryClearedAt", String(now));
  }
  /** Changes Driver carried out since `since`, in any conversation (not the user's taps), newest last. */
  changesSince(since: number, limit: number): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE created_at >= ? AND state IN ('executed', 'partial') AND conversation_id != ? ORDER BY created_at DESC LIMIT ?").all(since, TAP, limit) as any[]).reverse().map(rowToProposal);
  }

  /** Every proposal and tap in one of `states`, oldest first: the timeline's calls and taps. */
  proposalsIn(states: readonly string[]): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`).all(...states) as any[]).map(rowToProposal);
  }

  // --- aliases: every name Driver gave a thread in a conversation keeps meaning that thread there ---
  /** `name` is normalized by the caller (handles.ts `nameKey`). A name keeps its first meaning: it's never re-pointed. */
  alias(conversationId: string, name: string, itemId: string) {
    this.db.prepare("INSERT OR IGNORE INTO aliases VALUES (?, ?, ?)").run(conversationId, name, itemId);
  }
  aliasFor(conversationId: string, name: string): string | null {
    return (this.db.prepare("SELECT item_id FROM aliases WHERE conversation_id = ? AND name = ?").get(conversationId, name) as any)?.item_id ?? null;
  }

  // --- stars: the threads the user picked to follow in the car ---
  /** `seen`: the latest finished run and open question the user already knows about, so only later ones are news. */
  star(itemId: string, on: boolean, seen: Seen = { runAt: 0, question: null }, now = Date.now()) {
    if (on) this.db.prepare("INSERT OR IGNORE INTO stars VALUES (?, ?, ?, ?)").run(itemId, now, seen.runAt, seen.question);
    else this.db.prepare("DELETE FROM stars WHERE item_id = ?").run(itemId);
  }
  stars(): Set<string> {
    return new Set(this.starsSeen().keys());
  }
  /** Each starred thread, with the last reply and question the user heard. */
  starsSeen(): Map<string, Seen> {
    return new Map((this.db.prepare("SELECT item_id, seen_run_at, seen_question FROM stars").all() as any[]).map((r) => [r.item_id, { runAt: r.seen_run_at, question: r.seen_question }]));
  }
  /**
   * The user has now heard this reply (the run that finished at `runAt`) and, if there was one, this question: in this
   * conversation for any thread (so asking to hear back again waits for the next one), and for good if it's starred.
   * Without a conversation (a reply read out on its own), only the star's.
   */
  markSeen(itemId: string, seen: Seen, conversationId: string | null, now = Date.now()) {
    this.db.prepare("UPDATE stars SET seen_run_at = MAX(seen_run_at, ?), seen_question = COALESCE(?, seen_question) WHERE item_id = ?").run(seen.runAt, seen.question, itemId);
    if (conversationId === null) return;
    this.db
      .prepare(
        "INSERT INTO heard VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET run_at = MAX(run_at, excluded.run_at), question = COALESCE(excluded.question, question), at = excluded.at",
      )
      .run(conversationId, itemId, seen.runAt, seen.question, now);
  }
  /** The latest reply (and question) from `itemId` this conversation has told, or null. */
  heard(conversationId: string, itemId: string): Seen | null {
    const r = this.db.prepare("SELECT run_at, question FROM heard WHERE conversation_id = ? AND item_id = ?").get(conversationId, itemId) as any;
    return r ? { runAt: r.run_at, question: r.question } : null;
  }
  /** The threads whose news these conversations last told between `from` and `to`. */
  heardBetween(conversationIds: string[], from: number, to: number): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT item_id FROM heard WHERE at >= ? AND at <= ? AND conversation_id IN (${conversationIds.map(() => "?").join(", ") || "NULL"})`).all(from, to, ...conversationIds) as any[];
    return rows.map((r) => r.item_id);
  }
  /** The thread whose news this conversation told last, and when. */
  lastHeard(conversationId: string): { itemId: string; at: number } | null {
    const r = this.db.prepare("SELECT item_id, at FROM heard WHERE conversation_id = ? ORDER BY at DESC LIMIT 1").get(conversationId) as any;
    return r ? { itemId: r.item_id, at: r.at } : null;
  }

  // --- briefed: which summary of each thread the user has heard, in any call or the phone's briefing ---
  /**
   * The user heard a summary of `itemId` as of `b`. Only moves forward: an older reply's summary heard after a newer
   * one's (a list fetched before the newer reply came) changes nothing.
   */
  markBriefed(itemId: string, b: Briefed, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO briefed VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET
         reply_at = MAX(reply_at, excluded.reply_at), content_key = excluded.content_key, at = excluded.at
         WHERE excluded.reply_at >= briefed.reply_at`,
      )
      .run(itemId, b.replyAt, b.contentKey, now);
  }
  /**
   * The latest summary of each thread the user has heard: as marked here, or as any conversation told the thread's news
   * (`heard`, by when the run it told finished), whichever is later.
   */
  briefedAll(): Map<string, Briefed> {
    const out = new Map<string, Briefed>();
    for (const r of this.db.prepare("SELECT item_id, reply_at, content_key FROM briefed").all() as any[]) out.set(r.item_id, { replyAt: r.reply_at, contentKey: r.content_key });
    for (const r of this.db.prepare("SELECT item_id, MAX(run_at) AS run_at FROM heard GROUP BY item_id").all() as any[]) {
      const b = out.get(r.item_id);
      if (!b) out.set(r.item_id, { replyAt: r.run_at, contentKey: null });
      else if (r.run_at > b.replyAt) b.replyAt = r.run_at;
    }
    return out;
  }

  // --- reads: the latest reply of each item the user has heard read out in full ---
  /**
   * The user heard `reply` in full. Only ever moves forward: an older reply heard again changes nothing. A newer one,
   * or the same one with a later watermark (the thread's state when it was heard), is to be marked read in the system
   * too (`pendingVisits`).
   */
  markRead(itemId: string, reply: CardReply, now = Date.now()): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO reads VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(item_id) DO UPDATE SET
         run_id = excluded.run_id, message_id = excluded.message_id, reply_at = excluded.reply_at, watermark = excluded.watermark,
         read_at = excluded.read_at, visit_pending = 1
         WHERE julianday(excluded.reply_at) > julianday(reads.reply_at)
            OR (excluded.message_id = reads.message_id AND julianday(excluded.watermark) > julianday(reads.watermark))`,
      )
      .run(itemId, reply.runId, reply.messageId, reply.at, reply.watermark, now);
    if (Number(r.changes) === 1) return true;
    // Heard again: nothing to tell the system, but the user was in the thread just now (`readAt`).
    this.db.prepare("UPDATE reads SET read_at = MAX(read_at, ?) WHERE item_id = ?").run(now, itemId);
    return false;
  }
  /** When the user last heard one of the item's replies in full here. */
  readAt(itemId: string): number | null {
    return (this.db.prepare("SELECT read_at FROM reads WHERE item_id = ?").get(itemId) as any)?.read_at ?? null;
  }
  /** The items whose latest reply the user last heard in full between `from` and `to`. */
  readsBetween(from: number, to: number): string[] {
    return (this.db.prepare("SELECT item_id FROM reads WHERE read_at >= ? AND read_at <= ?").all(from, to) as any[]).map((r) => r.item_id);
  }
  /** When the latest reply each item's user heard in full finished. */
  reads(): Map<string, string> {
    return new Map((this.db.prepare("SELECT item_id, reply_at FROM reads").all() as any[]).map((r) => [r.item_id, r.reply_at]));
  }
  /** Replies heard in full that the system hasn't been told about yet. */
  pendingVisits(): { itemId: string; runId: string | null; messageId: string; watermark: string }[] {
    return (this.db.prepare("SELECT item_id, run_id, message_id, watermark FROM reads WHERE visit_pending = 1").all() as any[])
      .map((r) => ({ itemId: r.item_id, runId: r.run_id, messageId: r.message_id, watermark: r.watermark }));
  }
  /** The system has this visit (or can't take one); a newer read since then stays pending. */
  visitDone(itemId: string, messageId: string, watermark: string) {
    this.db.prepare("UPDATE reads SET visit_pending = 0 WHERE item_id = ? AND message_id = ? AND watermark = ?").run(itemId, messageId, watermark);
  }

  // --- readings: replies prepared for reading aloud, by thread, reply and style ---
  putReading(id: string, itemId: string, messageId: string, style: string, segments: Segment[], now = Date.now()) {
    this.db.prepare("INSERT OR IGNORE INTO readings VALUES (?, ?, ?, ?, ?, ?)").run(id, itemId, messageId, style, JSON.stringify(segments), now);
  }
  /** What a reading was made with (`style`, as `putReading` was given it), or null for none kept. */
  readingStyle(id: string): string | null {
    return (this.db.prepare("SELECT style FROM readings WHERE id = ?").get(id) as any)?.style ?? null;
  }
  readingSegments(id: string): Segment[] | null {
    const r = this.db.prepare("SELECT segments FROM readings WHERE id = ?").get(id) as any;
    // Readings kept before segments had paragraphs were plain strings: each one its own paragraph.
    return r ? (JSON.parse(r.segments) as (Segment | string)[]).map((s, i) => (typeof s === "string" ? { text: s, paragraph: i } : s)) : null;
  }
  /** Which thread and reply a reading is of, and how many segments it has. */
  reading(id: string): { itemId: string; messageId: string; segments: number } | null {
    const r = this.db.prepare("SELECT item_id, message_id, segments FROM readings WHERE id = ?").get(id) as any;
    return r ? { itemId: r.item_id, messageId: r.message_id, segments: JSON.parse(r.segments).length } : null;
  }
  /**
   * A conversation hung up for the phone to read a reply out (`read_aloud`); the phone's poll picks it up. An hour at
   * most: a phone that never asked has moved on.
   */
  saveHandoff(conversationId: string, handoff: Handoff, now = Date.now()) {
    this.db.prepare("INSERT INTO handoffs VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET handoff = excluded.handoff, at = excluded.at").run(conversationId, JSON.stringify(handoff), now);
    for (const listener of [...this.handoffListeners]) listener(conversationId);
  }
  private handoffListeners = new Set<(conversationId: string) => void>();
  /** Called with the conversation each time one hands off, so a phone in the call hears at once; returns the unsubscribe. */
  onHandoff(listener: (conversationId: string) => void): () => void {
    this.handoffListeners.add(listener);
    return () => this.handoffListeners.delete(listener);
  }
  handoff(conversationId: string, now = Date.now()): Handoff | null {
    return this.handoffAt(conversationId, now)?.handoff ?? null;
  }
  /** The hand-off with when it was made. */
  handoffAt(conversationId: string, now = Date.now()): { handoff: Handoff; at: number } | null {
    const r = this.db.prepare("SELECT handoff, at FROM handoffs WHERE conversation_id = ?").get(conversationId) as any;
    return r && now - r.at <= 3600_000 ? { handoff: JSON.parse(r.handoff), at: r.at } : null;
  }
  /**
   * A phone on hold asked again (`onhold=1`): the conversation's hand-off becomes a hold as of now, so a reading or
   * dictation it was put on hold from isn't handed over again, and the hold lasts while the phone asks rather than the
   * hour a hand-off keeps, whatever its age (an hour out of signal, a reading paused for longer). Only a hand-off still
   * there: without one, the brain has let go. No call is told: there's none while on hold.
   */
  keepHold(conversationId: string, now = Date.now()) {
    const r = this.db.prepare("SELECT handoff FROM handoffs WHERE conversation_id = ?").get(conversationId) as any;
    if (!r || "rollover" in JSON.parse(r.handoff)) return;
    this.db.prepare("UPDATE handoffs SET handoff = ?, at = ? WHERE conversation_id = ?").run(JSON.stringify({ handle: "", hold: true }), now, conversationId);
  }
  /** One conversation's hand-off, or (without one) every conversation's. */
  dropHandoff(conversationId?: string) {
    if (conversationId) this.db.prepare("DELETE FROM handoffs WHERE conversation_id = ?").run(conversationId);
    else this.db.exec("DELETE FROM handoffs");
  }
  /** Readings older than `before` go; they're made again from the reply if it's asked for. */
  forgetReadings(before: number) {
    this.db.prepare("DELETE FROM readings WHERE created_at < ?").run(before);
  }

  // --- kept replies: replies kept for later in a call, unsent ---
  /** Keeps `k`; the same dictated draft kept again replaces the one kept before, under its id. Returns what's kept. */
  keepReply(k: KeptReply): KeptReply {
    const old = k.draftId ? this.keptByDraft(k.draftId) : null;
    const row = old ? { ...k, id: old.id } : k;
    this.db.prepare(
      `INSERT INTO kept VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id, thread_name = excluded.thread_name, project = excluded.project, text = excluded.text,
       note = excluded.note, conversation_id = excluded.conversation_id, kept_at = excluded.kept_at`,
    ).run(row.id, row.threadId, row.threadName, row.project, row.text, row.note, row.draftId, row.conversationId, row.keptAt);
    return row;
  }
  keptReply(id: string): KeptReply | null {
    const r = this.db.prepare("SELECT * FROM kept WHERE id = ?").get(id);
    return r ? rowToKept(r) : null;
  }
  keptByDraft(draftId: string): KeptReply | null {
    const r = this.db.prepare("SELECT * FROM kept WHERE draft_id = ?").get(draftId);
    return r ? rowToKept(r) : null;
  }
  /** Every kept reply, newest first. */
  keptReplies(): KeptReply[] {
    return (this.db.prepare("SELECT * FROM kept ORDER BY kept_at DESC, rowid DESC").all() as any[]).map(rowToKept);
  }
  /** False when there's no such kept reply. */
  editKept(id: string, text: string): boolean {
    return Number(this.db.prepare("UPDATE kept SET text = ? WHERE id = ?").run(text, id).changes) === 1;
  }
  dropKept(id: string) {
    this.db.prepare("DELETE FROM kept WHERE id = ?").run(id);
  }

  // --- sessions: every GPT-Live session the brain created, and whether OpenAI has confirmed it's over ---
  startSession(id: string, conversationId: string, now = Date.now(), fast = false) {
    this.db.prepare("INSERT OR IGNORE INTO sessions (id, conversation_id, started_at, fast) VALUES (?, ?, ?, ?)").run(id, conversationId, now, fast ? 1 : 0);
  }
  /** The session's backend answered the user once more. */
  answered(id: string) {
    this.db.prepare("UPDATE sessions SET answers = answers + 1 WHERE id = ?").run(id);
  }
  /** How many answers sessions started since `since` gave, and how many of them in Fast mode. */
  answersSince(since: number): { answers: number; fast: number } {
    const r = this.db.prepare("SELECT COALESCE(SUM(answers), 0) AS answers, COALESCE(SUM(CASE WHEN fast = 1 THEN answers END), 0) AS fast FROM sessions WHERE started_at >= ?").get(since) as any;
    return { answers: Number(r.answers), fast: Number(r.fast) };
  }
  /** Every session started since `since`, oldest first: when it started and ended, and its conversation (drives.ts). */
  sessionsSince(since: number): { conversationId: string; startedAt: number; endedAt: number | null }[] {
    return (this.db.prepare("SELECT conversation_id, started_at, ended_at FROM sessions WHERE started_at >= ? ORDER BY started_at").all(since) as any[])
      .map((r) => ({ conversationId: r.conversation_id, startedAt: r.started_at, endedAt: r.ended_at }));
  }
  /** The brain is done with the session (`closed_at` is OpenAI's side of it). Keeps the first reason. */
  endSession(id: string, billedSeconds: number | null, reason: EndReason, now = Date.now()) {
    this.db.prepare("UPDATE sessions SET ended_at = ?, billed_seconds = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(now, billedSeconds, reasonText(reason), id);
  }
  /** OpenAI confirmed the session is over: it accepted the hang-up, said it had already ended, or sent session.closed. */
  sessionClosed(id: string, now = Date.now()) {
    this.db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(now, id);
  }
  /** Notes a failed hang-up; the first failure is when the session started to look as if it might still bill. */
  hangupFailed(id: string, now = Date.now()) {
    this.db.prepare("UPDATE sessions SET hangup_failed_at = COALESCE(hangup_failed_at, ?) WHERE id = ?").run(now, id);
  }
  /** Sessions OpenAI hasn't confirmed over: open ones, and ones whose hang-up hasn't gone through yet. */
  /** How to take session `id` back if the brain restarts while it's live: its settings, as the server made it. */
  saveResume(id: string, resume: unknown) {
    this.db.prepare("UPDATE sessions SET resume = ? WHERE id = ?").run(JSON.stringify(resume), id);
  }
  /** What conversation `conversationId`'s latest session was made with (`saveResume`), or null. */
  lastResume(conversationId: string): any {
    const r = this.db.prepare("SELECT resume FROM sessions WHERE conversation_id = ? AND resume IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(conversationId) as any;
    return r ? JSON.parse(r.resume) : null;
  }
  /** What the phone showed of session `id`'s call as it ended (its agenda and receipts). */
  saveCallView(id: string, view: unknown) {
    this.db.prepare("UPDATE sessions SET view = ? WHERE id = ?").run(JSON.stringify(view), id);
  }
  /**
   * A conversation's latest call record (callview.ts `CallRecord`), or null: a call carried on in a new session (a
   * rollover, a reconnect) keeps one record, kept again as each of its sessions ends.
   */
  callView<T>(conversationId: string): T | null {
    const r = this.db.prepare("SELECT view FROM sessions WHERE conversation_id = ? AND view IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(conversationId) as any;
    return r ? JSON.parse(r.view) : null;
  }
  /** Sessions the brain never ended, started since `since`, that it can take back: each with its settings. */
  liveSessions(since: number): { id: string; conversationId: string; startedAt: number; resume: any }[] {
    return (this.db.prepare("SELECT id, conversation_id, started_at, resume FROM sessions WHERE closed_at IS NULL AND ended_at IS NULL AND resume IS NOT NULL AND started_at >= ? ORDER BY started_at").all(since) as any[])
      .map((r) => ({ id: r.id, conversationId: r.conversation_id, startedAt: r.started_at, resume: JSON.parse(r.resume) }));
  }
  unclosedSessions(): string[] {
    return (this.db.prepare("SELECT id FROM sessions WHERE closed_at IS NULL ORDER BY started_at").all() as any[]).map((r) => r.id);
  }
  isClosed(id: string): boolean {
    return (this.db.prepare("SELECT closed_at FROM sessions WHERE id = ?").get(id) as any)?.closed_at != null;
  }
  /** Sessions whose hang-up has failed and that OpenAI still hasn't confirmed over, with when it first failed. */
  failedHangups(): { id: string; since: number }[] {
    return (this.db.prepare("SELECT id, hangup_failed_at FROM sessions WHERE closed_at IS NULL AND hangup_failed_at IS NOT NULL").all() as any[]).map((r) => ({ id: r.id, since: r.hangup_failed_at }));
  }

  // --- waits and call-back news, so a restart loses neither ---
  saveWait(w: Wait) {
    this.db.prepare("INSERT INTO waits VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET wait = excluded.wait").run(w.conversationId, JSON.stringify(w));
  }
  deleteWait(conversationId: string) {
    this.db.prepare("DELETE FROM waits WHERE conversation_id = ?").run(conversationId);
  }
  waits(): Wait[] {
    return (this.db.prepare("SELECT wait FROM waits").all() as any[]).map((r) => JSON.parse(r.wait));
  }
  /** Call-back news not yet heard, per conversation (server.ts `untold`); null deletes it. */
  saveUntold<T>(conversationId: string, news: { at: number; replies: T[] } | null) {
    if (!news) this.db.prepare("DELETE FROM untold WHERE conversation_id = ?").run(conversationId);
    else this.db.prepare("INSERT INTO untold VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET at = excluded.at, replies = excluded.replies").run(conversationId, news.at, JSON.stringify(news.replies));
  }
  /**
   * A call-back's session exists: its news is saved as untold and (with `dropWait`) its wait deleted, in one
   * transaction, so a crash in between can't lose the wait without its news being kept.
   */
  callBackStarted<T>(conversationId: string, news: { at: number; replies: T[] }, dropWait: boolean) {
    this.db.transaction(() => {
      if (dropWait) this.deleteWait(conversationId);
      this.saveUntold(conversationId, news);
    });
  }
  untold<T>(): Map<string, { at: number; replies: T[] }> {
    return new Map((this.db.prepare("SELECT * FROM untold").all() as any[]).map((r) => [r.conversation_id, { at: r.at, replies: JSON.parse(r.replies) }]));
  }
}

/** A turn with each claim that didn't happen replaced by its correction (appended when the words can't be found). */
function withCorrections(text: string, corrected: { said: string; note: string }[]): string {
  let out = text;
  for (const c of corrected) out = c.said && out.includes(c.said) ? out.replace(c.said, `[${c.note}]`) : `${out} [${c.note}]`;
  return out;
}

const rowToKept = (r: any): KeptReply => ({
  id: r.id, threadId: r.thread_id, threadName: r.thread_name, project: r.project, text: r.text, note: r.note ?? null, draftId: r.draft_id ?? null,
  conversationId: r.conversation_id, keptAt: r.kept_at,
});

function rowToProposal(r: any): Proposal {
  return {
    id: r.id, conversationId: r.conversation_id, action: r.action, targets: JSON.parse(r.targets), fields: JSON.parse(r.fields),
    readback: r.readback, mustHear: JSON.parse(r.must_hear), createdFrom: r.created_from, expiresAt: r.expires_at,
    state: r.state, createdAt: r.created_at, result: r.result,
  };
}
