// The Codex CLI as a work system, through its shared app-server daemon (measured on codex-cli 0.167.0): threads are
// items, read with `thread/list` and `thread/turns/list`; live state comes from the daemon's global notifications.
// Writes, after the user's spoken yes: a follow-up steers a running turn (`turn/steer`), starts a turn in a thread
// something has open, or loads one nothing has open and starts a turn there (`thread/resume` + `turn/start`); new work
// is `thread/start` + `turn/start`; a question Codex asks (`item/tool/requestUserInput`) is answered. Commands Codex
// wants to run are never approved. Settle, snooze and archive stay on this computer, as for Claude Code.
//
// Codex has no command ids that dedupe, so every write is at most once: the operation store reserves the key first,
// and an outcome Driver can't confirm stays unknown and is never sent again.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Action, Adapter, ItemStatus, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, answers, ceilingFor, RUNTIME_MODES, steers, visible, withinCeiling } from "../policy.ts";
import type { Policy, RuntimeMode } from "../policy.ts";
import { Store } from "../claude/store.ts";
import { t3Cwd } from "../claude/transcript.ts";
import { goAhead } from "../claude/adapter.ts";
import { titleFrom } from "../t3/adapter.ts";
import { addWorktree, folderOf, gitRoot, group } from "../work.ts";
import { VERSION } from "../protocol.ts";
import { CodexRpc, ConnectionError } from "./rpc.ts";
import type { ServerRequest } from "./rpc.ts";

export type Options = {
  policy: Policy;
  /** Codex's home ($CODEX_HOME, else ~/.codex). */
  codexHome?: string;
  codexBin?: string;
  /** Driver's own records for Codex: settle, snooze, archive, and every write's outcome. */
  db: string;
  /** Not used yet: Codex keeps its own state. Accepted so every adapter is set up alike. */
  stateDir?: string;
  log: (m: string) => void;
  now?: () => number;
  /** How long threads nothing has loaded stay in the briefing. Loaded and running ones are always included. */
  days?: number;
  /** How long a write waits for Codex to take it; never causes a resend. */
  acceptanceTimeoutMs?: number;
  /** False: never start Codex's daemon when it isn't running (tests); it's also off when Codex's own config turns it off. */
  autoStart?: boolean;
  /** How often the thread list is read again besides the daemon's notifications (30 s). */
  refreshMs?: number;
};

/** A thread as `thread/list` and `thread/read` give it: only the fields used here. */
type Thread = {
  id: string; name: string | null; preview: string; cwd: string; updatedAt: number; ephemeral?: boolean;
  status: { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: string[] };
  originator?: string | null; source?: unknown; threadSource?: string | null; parentThreadId?: string | null;
};
type Item = { type: string; id: string; text?: string; phase?: string | null; clientId?: string | null; content?: { type: string; text?: string }[]; startedAtMs?: number | null };
type Turn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; items: Item[]; startedAt: number | null; completedAt: number | null };
/** A request Codex sent this connection about a thread: a question or an approval. Its id only means something here. */
type Held = { rpc: CodexRpc; id: number | string; method: string; params: any };
type Row = { thread: Thread; item: WorkItem; turns: Turn[] };

const QUESTION = "item/tool/requestUserInput";
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval"]);

const UNKNOWN: Receipt = { ok: false, unknown: true, error: "I can't tell whether Codex received that. 10 & 2 won't send it again." };
const NO_STEERING = "It's open in Codex, and this computer doesn't let 10 & 2 send to open sessions.";
const NO_ANSWERS = "Codex is asking a question, and this computer doesn't let 10 & 2 answer them. Answer it in Codex.";
const NOT_CONNECTED = "Codex isn't connected right now.";
const REUSED = "That operation key was already used for different words or settings.";
const REFUSED = "Codex didn't take that. Nothing was sent.";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** A UUID made from the operation key, as the message's `clientUserMessageId`: how its turn is found again. */
export function messageIdFor(key: string): string {
  const b = createHash("sha256").update("driver:codex:message:v1\0" + key).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const iso = (unixSeconds: number | null | undefined) => typeof unixSeconds === "number" && unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null;
const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];

/**
 * What each runtime mode runs with in Codex, as T3 Code maps them: approval-required asks before anything not known to be
 * safe and can't write; auto-accept-edits writes in the workspace and asks to go further; auto is the same with Codex's
 * own reviewer answering those asks; full-access never asks and has no sandbox.
 */
export const SETTINGS: Record<RuntimeMode, { approvalPolicy: string; sandbox: string; approvalsReviewer: string }> = {
  "approval-required": { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" },
  "auto-accept-edits": { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
};
const SANDBOX_POLICY: Record<string, object> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};
/** The turn overrides that make a thread run as `mode`. */
export const turnSettings = (mode: RuntimeMode) => ({ approvalPolicy: SETTINGS[mode].approvalPolicy, approvalsReviewer: SETTINGS[mode].approvalsReviewer, sandboxPolicy: SANDBOX_POLICY[SETTINGS[mode].sandbox] });
/**
 * Which runtime mode a thread's settings (as `thread/resume` reports them) amount to: what it can do without asking
 * the user. Anything Driver doesn't recognise counts as full access, so it's capped.
 */
export function reachOf(approvalPolicy: unknown, sandbox: any, reviewer: unknown): RuntimeMode {
  const type = sandbox?.type;
  if (type === "readOnly") return reviewer === "user" || approvalPolicy === "never" ? "approval-required" : "auto";
  if (type === "workspaceWrite") return reviewer === "user" || approvalPolicy === "never" ? "auto-accept-edits" : "auto";
  return "full-access";
}
const above = (a: RuntimeMode, b: RuntimeMode) => RUNTIME_MODES.indexOf(a) > RUNTIME_MODES.indexOf(b);

const plain = (s: string) => ` ${s.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
type Question = { id: string; question: string; isOther?: boolean; options?: { label: string }[] | null };
/**
 * The answers to a request_user_input from the user's words: the option they named, or else their words, when the
 * question takes any answer. One that takes only its options and isn't given one is refused, in words.
 */
export function answersFor(questions: Question[], words: string): { answers: Record<string, { answers: string[] }> } | { error: string } {
  if (!questions.length) return { error: "10 & 2 can't see Codex's question, so nothing was sent." };
  const out: Record<string, { answers: string[] }> = {};
  const said = plain(words);
  for (const q of questions) {
    const options = q.options ?? [];
    const exact = options.find((o) => plain(o.label) === said);
    const named = options.filter((o) => plain(o.label).trim() && said.includes(plain(o.label)));
    const pick = exact ?? (named.length === 1 ? named[0] : undefined);
    if (pick) out[q.id] = { answers: [pick.label] };
    else if (q.isOther !== false || !options.length) out[q.id] = { answers: [words] };
    else return { error: `That question takes one of its options: ${options.map((o) => o.label).join(" / ")}. Nothing was sent.` };
  }
  return { answers: out };
}
/** What a held approval asks for, as a clause ("wants to run npm test"). */
function wants(h: Held): string {
  const p = h.params ?? {};
  if (h.method === "item/commandExecution/requestApproval" || h.method === "execCommandApproval") {
    const cmd = typeof p.command === "string" ? p.command : Array.isArray(p.command) ? p.command.join(" ") : null;
    return cmd ? `wants to run ${cmd.replace(/\s+/g, " ").slice(0, 300)}` : "wants to run a command";
  }
  if (h.method === "item/fileChange/requestApproval" || h.method === "applyPatchApproval") return "wants to change files";
  if (h.method === "item/permissions/requestApproval") return "wants more permissions";
  return "needs your input";
}

/** Folders Codex's config.toml marks trusted (`[projects."<path>"]` with `trust_level = "trusted"`), that exist. */
export function trustedProjects(configToml: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of configToml.split("\n")) {
    const table = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/.exec(line);
    if (table) { current = table[1] !== undefined ? table[1].replace(/\\(["\\])/g, "$1") : table[2]!; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (current && /^\s*trust_level\s*=\s*["']trusted["']/.test(line) && isAbsolute(current) && existsSync(current)) out.push(current);
  }
  return out;
}
/** Whether Codex's own config turns off starting its daemon (`daemon_auto_start = false` under [features]). */
export function daemonDisabled(configToml: string): boolean {
  let features = false;
  for (const line of configToml.split("\n")) {
    if (/^\s*\[/.test(line)) { features = /^\s*\[\s*features\s*\]/.test(line); continue; }
    if (features && /^\s*daemon_auto_start\s*=\s*false\b/.test(line)) return true;
    if (!features && /^\s*features\s*\.\s*daemon_auto_start\s*=\s*false\b/.test(line)) return true;
  }
  return false;
}

export class CodexAdapter implements Adapter {
  readonly name = "codex";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  readonly codexHome: string;
  readonly socketPath: string;
  private readonly opts: Options;
  private readonly store: Store;
  private readonly now: () => number;
  private rpc: CodexRpc | null = null;
  private loaded = false;
  private closed = false;
  private retryMs = 1000;
  private retryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private startedDaemonAt = 0;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private readonly threads = new Map<string, Thread>();
  /** The newest turns (up to three, newest first) of each thread, and the `updatedAt` and status they were read at. */
  private readonly turns = new Map<string, { at: number; status: string; turns: Turn[] }>();
  private readonly held = new Map<string, Held>();
  /** Threads this connection subscribed to (`thread/resume`), and why: a question to watch, or a write. */
  private readonly subscribed = new Map<string, Set<string>>();
  private rows = new Map<string, Row>();
  private readonly roots = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly questions = new Map<string, string | null>();
  private readonly listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly stale = new Set<string>();
  private turnsTimer: NodeJS.Timeout | null = null;

  constructor(opts: Options) {
    this.opts = opts; this.now = opts.now ?? Date.now;
    this.codexHome = resolve(opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    this.socketPath = join(this.codexHome, "app-server-control", "app-server-control.sock");
    this.store = new Store(opts.db);
  }

  /** Connects (starting Codex's daemon if it isn't running and that's allowed) and reads the threads once; then keeps both current. */
  async start(): Promise<void> {
    if (this.closed) throw new Error("Codex adapter is closed");
    await this.connect();
    this.refreshTimer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? 30_000); this.refreshTimer.unref();
  }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean { return this.loaded && !this.closed && this.rpc !== null && !this.rpc.closed && this.opts.policy.codex; }

  // --- The connection ---------------------------------------------------------------------------------------------

  private connecting: Promise<void> | null = null;
  /** One attempt at a time: a write waiting to reconcile and the retry timer share it. */
  private connect(): Promise<void> {
    if (this.closed || (this.rpc && !this.rpc.closed)) return Promise.resolve();
    this.connecting ??= this.attempt().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async attempt(): Promise<void> {
    let rpc: CodexRpc;
    try {
      rpc = await this.open();
    } catch (e) {
      const missing = ["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException)?.code ?? "");
      if (missing && await this.startDaemon()) return this.attempt();
      this.opts.log(`codex: can't reach Codex (${missing ? "its daemon isn't running" : (e as Error).message}); retrying in ${this.retryMs / 1000}s`);
      this.retry();
      return;
    }
    if (this.closed) { rpc.close(); return; }
    this.rpc = rpc; this.retryMs = 1000;
    this.held.clear(); this.subscribed.clear();
    this.opts.log(`codex: connected (${(rpc.init.userAgent ?? "unknown version").split(" ")[0]})`);
    rpc.onClose((err) => {
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.held.clear(); this.subscribed.clear();
      if (this.closed) return;
      this.opts.log(`codex: connection lost (${err.message}); reconnecting`);
      this.recompute();
      this.retry();
    });
    await this.refresh();
  }
  private open(): Promise<CodexRpc> {
    return CodexRpc.connect(this.socketPath, {
      clientName: "10and2", clientTitle: "10 & 2", version: VERSION,
      optOut: ["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
        "item/fileChange/outputDelta", "item/plan/delta", "thread/tokenUsage/updated", "account/rateLimits/updated"],
      onNotification: (m, p) => this.onNotification(m, p),
      onRequest: (r) => this.onRequest(r),
    });
  }
  private retry() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
  /**
   * Starts Codex's shared daemon the way Codex itself does (`codex app-server daemon start`, idempotent), at most once a
   * minute, unless that's off here or in Codex's config. True when it says it's running.
   */
  private async startDaemon(): Promise<boolean> {
    if (this.opts.autoStart === false || this.closed || this.now() - this.startedDaemonAt < 60_000) return false;
    let config = "";
    try { config = readFileSync(join(this.codexHome, "config.toml"), "utf8"); } catch { /* none: defaults */ }
    if (daemonDisabled(config)) return false;
    this.startedDaemonAt = this.now();
    const out = await new Promise<string>((done) => {
      execFile(this.opts.codexBin ?? "codex", ["app-server", "daemon", "start"], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, CODEX_HOME: this.codexHome } },
        (err, stdout) => done(err ? "" : stdout));
    });
    const status = out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && typeof o.status === "string")?.status;
    if (status === "started" || status === "alreadyRunning" || status === "running") { this.opts.log(`codex: started Codex's daemon (${status})`); return true; }
    this.opts.log("codex: couldn't start Codex's daemon");
    return false;
  }

  // --- Reading ----------------------------------------------------------------------------------------------------

  /** Reads the thread list again (and the newest turns of whatever changed). One at a time; a call meanwhile runs once more after. */
  private refresh(): Promise<void> {
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      try {
        do { this.again = false; await this.readAll(); } while (this.again && !this.closed);
      } catch (e) {
        if (!(e instanceof ConnectionError)) this.opts.log(`codex: reading threads failed (${(e as Error).message})`);
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }
  private async readAll() {
    const rpc = this.rpc;
    if (!rpc || !this.opts.policy.codex) return;
    const cutoff = (this.now() - (this.opts.days ?? 14) * 86_400_000) / 1000;
    const seen = new Map<string, Thread>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      // Every provider (the default is only the configured one's), interactive sources only (not `codex exec` runs).
      // The first read lets Codex check its index against its session files (slower); later ones read the index only.
      const r: any = await rpc.request("thread/list", { limit: 100, sortKey: "updated_at", sortDirection: "desc", modelProviders: [], archived: false, cursor, useStateDbOnly: this.loaded },
        this.loaded ? 20_000 : 60_000);
      for (const t of (r?.data ?? []) as Thread[]) seen.set(t.id, t);
      cursor = r?.nextCursor ?? null;
      const last = (r?.data ?? []).at(-1) as Thread | undefined;
      if (!cursor || !last || last.updatedAt < cutoff) break;
    }
    // Loaded threads count however old: something has them open.
    const loaded: string[] = ((await rpc.request("thread/loaded/list", {}))?.data ?? []).filter((id: unknown) => typeof id === "string");
    for (const id of loaded) {
      if (seen.has(id)) continue;
      const known = this.threads.get(id);
      if (known && known.ephemeral) continue;
      try { const r: any = await rpc.request("thread/read", { threadId: id }); if (r?.thread) seen.set(id, r.thread); }
      catch (e) { if (e instanceof ConnectionError) throw e; }
    }
    if (this.rpc !== rpc) return;
    for (const [id, t] of seen) this.threads.set(id, t);
    for (const id of [...this.threads.keys()]) if (!seen.has(id)) this.threads.delete(id);
    for (const id of [...this.turns.keys()]) if (!this.threads.has(id)) this.turns.delete(id);
    for (const t of this.threads.values()) {
      const cached = this.turns.get(t.id);
      if (this.listed(t) && (!cached || cached.at !== t.updatedAt || cached.status !== t.status.type)) await this.readTurns(t.id);
    }
    this.loaded = true;
    this.recompute();
    for (const row of this.rows.values()) if (this.waitingFlag(row.thread)) void this.watchQuestion(row.thread.id);
  }
  /** The newest turns of a thread, kept for its status, reply and last run. A thread with no turns yet has none. */
  private async readTurns(id: string) {
    const rpc = this.rpc, t = this.threads.get(id);
    if (!rpc || !t) return;
    let turns: Turn[] = [];
    try {
      const r: any = await rpc.request("thread/turns/list", { threadId: id, limit: 3, sortDirection: "desc", itemsView: "summary" });
      turns = r?.data ?? [];
    } catch (e) {
      if (e instanceof ConnectionError) throw e;
      // "not materialized yet": nothing said in it so far.
    }
    this.turns.set(id, { at: t.updatedAt, status: t.status.type, turns });
  }
  /** Turns read again soon for threads a notification touched; several notifications share one read. */
  private touch(id: string) {
    this.stale.add(id);
    if (this.turnsTimer || this.closed) return;
    this.turnsTimer = setTimeout(async () => {
      this.turnsTimer = null;
      const ids = [...this.stale]; this.stale.clear();
      try { for (const id of ids) if (this.threads.has(id)) await this.readTurns(id); } catch { /* reconnect rereads */ }
      this.recompute();
    }, 150);
    this.turnsTimer.unref();
  }

  /** Whether a thread is the user's own Codex work that Driver lists: not T3 Code's, not an internal one, in a visible folder. */
  private listed(t: Thread): boolean {
    if (!this.opts.policy.codex || t.ephemeral || !t.cwd || typeof t.id !== "string") return false;
    if (t.threadSource === "thread_title" || t.parentThreadId) return false;
    if (typeof t.source === "object" && t.source !== null && ("subAgent" in t.source || "subagent" in t.source)) return false;
    // T3 Code runs its own app-server, so its threads carry its name as originator; its worktrees are under ~/.t3 or
    // a workspace's t3-* folders. T3's adapter lists those.
    if (/^t3\b/i.test(t.originator ?? "") || t3Cwd(t.cwd)) return false;
    return visible(this.opts.policy, t.cwd);
  }
  private waitingFlag(t: Thread): string | null {
    const flags = t.status.type === "active" ? t.status.activeFlags ?? [] : [];
    return flags.includes("waitingOnUserInput") ? "question" : flags.includes("waitingOnApproval") ? "approval" : null;
  }

  private recompute() {
    if (this.closed) return;
    const cutoff = (this.now() - (this.opts.days ?? 14) * 86_400_000) / 1000;
    const next = new Map<string, Row>();
    for (const t of this.threads.values()) {
      if (!this.listed(t)) continue;
      if (t.status.type === "notLoaded" && t.updatedAt < cutoff) continue;
      const overlay = this.store.overlay(t.id);
      if (overlay.archived) continue;
      const turns = this.turns.get(t.id)?.turns ?? [];
      const finished = turns.find((x) => x.status !== "inProgress");
      const lastRunAt = iso(finished?.completedAt ?? null);
      const flag = this.waitingFlag(t), held = this.held.get(t.id);
      const pending = !!flag || !!held;
      const status: ItemStatus = pending ? "waiting" : t.status.type === "active" ? "running" : t.status.type === "systemError" ? "failed"
        : turns[0]?.status === "completed" ? "completed" : turns[0]?.status === "failed" ? "failed" : turns[0]?.status === "interrupted" ? "cancelled" : "idle";
      const questionId = held ? hash(`${held.method}:${held.params?.itemId ?? ""}:${held.params?.approvalId ?? ""}`).slice(0, 24)
        : flag ? hash(`${t.id}:${turns.find((x) => x.status === "inProgress")?.id ?? t.updatedAt}:${flag}`).slice(0, 24) : null;
      const newer = (at: string | null) => !!at && !!lastRunAt && lastRunAt > at;
      const wrote = turns.flatMap((x) => x.items.filter((i) => i.type === "userMessage").map((i) => i.startedAtMs ?? 0)).sort((a, b) => b - a)[0];
      const item: WorkItem = {
        id: t.id, title: t.name?.trim() || (t.preview?.trim() ? titleFrom(t.preview) : `a Codex session in ${group(t.cwd)}`), group: group(t.cwd),
        status, updatedAt: iso(t.updatedAt) ?? new Date(this.now()).toISOString(),
        settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !pending && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: pending, questionId, lastRunAt, wroteAt: wrote ? new Date(wrote).toISOString() : null,
      };
      next.set(t.id, { thread: t, item, turns });
    }
    this.rows = next;
    this.refreshPlaces();
    const changed: string[] = []; let urgent = false;
    for (const [id, row] of next) {
      const w = row.item, reply = this.lastReply(row.turns);
      const key = JSON.stringify([w.status, w.title, w.settled, w.snoozedUntil, w.questionId, w.lastRunAt, reply?.item.id, reply?.item.text]);
      if (this.keys.get(id) !== key) {
        changed.push(id);
        urgent ||= w.pendingQuestion && this.questions.get(id) !== w.questionId;
      }
      this.keys.set(id, key); this.questions.set(id, w.questionId ?? null);
    }
    for (const id of [...this.keys.keys()]) if (!next.has(id)) { changed.push(id); this.keys.delete(id); this.questions.delete(id); }
    if (changed.length) for (const l of this.listeners) l(changed, urgent);
  }
  private lastReply(turns: Turn[]): { turn: Turn; item: Item } | null {
    for (const turn of turns) {
      if (turn.status === "inProgress") continue;
      const said = turn.items.filter((i) => i.type === "agentMessage" && i.text?.trim());
      const item = said.filter((i) => i.phase === "final_answer").at(-1) ?? said.at(-1);
      if (item) return { turn, item };
    }
    return null;
  }

  private trusted: { mtimeMs: number; folders: string[] } | null = null;
  /** The folders Codex's config.toml trusts, read again only when it changes. */
  private trustedFolders(): string[] {
    const path = join(this.codexHome, "config.toml");
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (this.trusted?.mtimeMs !== mtimeMs) this.trusted = { mtimeMs, folders: trustedProjects(readFileSync(path, "utf8")) };
      return this.trusted.folders;
    } catch { return []; }
  }
  private refreshPlaces() {
    this.roots.clear();
    if (!allows(this.opts.policy, "start_work", "codex")) return;
    for (const cwd of [...[...this.rows.values()].map((r) => r.thread.cwd), ...this.trustedFolders()]) {
      const root = gitRoot(cwd);
      if (root && visible(this.opts.policy, root) && !t3Cwd(root)) this.roots.set(hash(root).slice(0, 12), root);
    }
  }
  places(): Place[] {
    if (!this.loaded || this.closed || !this.opts.policy.codex || !allows(this.opts.policy, "start_work", "codex")) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => gitRoot(r.thread.cwd) === root).map((r) => r.item.updatedAt).sort().at(-1) ?? null }));
  }

  async list(): Promise<WorkItem[]> { return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.thread.cwd)) throw new Error("That session isn't visible to 10 & 2.");
    return row;
  }
  async report(id: string): Promise<Report> {
    this.row(id);
    try { await this.readTurns(id); this.recompute(); } catch { /* the last read stands */ }
    const row = this.row(id), last = this.lastReply(row.turns), held = this.held.get(id);
    const running = row.turns[0]?.status === "inProgress" ? row.turns[0] : null;
    const progress = row.item.status === "running" || row.item.status === "waiting"
      ? running?.items.filter((i) => i.type === "agentMessage" && i.text?.trim()).at(-1)?.text ?? null : null;
    let question: string | null = null;
    if (held?.method === QUESTION) {
      question = ((held.params?.questions ?? []) as any[]).map((q) => `${q.question}${q.options?.length ? ` Options: ${q.options.map((o: any) => o.label).join(" / ")}.` : ""}`).join(" ");
    } else if (held) question = `Codex ${wants(held)}.${held.params?.reason ? ` ${String(held.params.reason).slice(0, 300)}` : ""}`;
    else if (row.item.pendingQuestion) question = "Codex needs your input in its terminal.";
    return { text: last?.item.text ?? "", progress, question,
      reply: last ? { runId: last.turn.id, messageId: last.item.id, at: iso(last.turn.completedAt ?? last.turn.startedAt) ?? row.item.updatedAt } : null };
  }
  async replies(id: string): Promise<PastReply[]> {
    this.row(id);
    const rpc = this.rpc;
    if (!rpc) throw new Error(NOT_CONNECTED);
    const r: any = await rpc.request("thread/turns/list", { threadId: id, limit: 20, sortDirection: "desc", itemsView: "summary" }).catch((e) => {
      if (e instanceof ConnectionError) throw new Error(NOT_CONNECTED);
      return { data: [] };
    });
    const out: PastReply[] = [];
    for (const turn of (r?.data ?? []) as Turn[]) {
      const one = this.lastReply([turn]);
      if (!one) continue;
      const prompt = turn.items.find((i) => i.type === "userMessage")?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim() || null;
      out.push({ runId: turn.id, messageId: one.item.id, at: iso(turn.completedAt ?? turn.startedAt) ?? "", text: one.item.text ?? "", prompt });
    }
    return out;
  }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  // --- Live state -------------------------------------------------------------------------------------------------

  private onNotification(method: string, p: any) {
    const id: string | undefined = p?.threadId ?? p?.thread?.id;
    switch (method) {
      case "thread/started":
        if (p?.thread?.id) { this.threads.set(p.thread.id, p.thread); if (!p.thread.ephemeral) this.touch(p.thread.id); }
        return;
      case "thread/status/changed": {
        const t = id ? this.threads.get(id) : undefined;
        if (!t || !p.status) { if (id && p.status?.type !== "notLoaded") void this.refresh(); return; }
        if (t.ephemeral) { this.threads.set(id!, { ...t, status: p.status }); return; }
        const was = this.waitingFlag(t);
        this.threads.set(id!, { ...t, status: p.status, updatedAt: p.status.type === "active" ? Math.max(t.updatedAt, Math.floor(this.now() / 1000)) : t.updatedAt });
        const now = this.waitingFlag(this.threads.get(id!)!);
        if (now !== was) this.unreadable.delete(id!);
        if (now && !was) void this.watchQuestion(id!);
        if (!now) {
          // Answered: by Driver (whose answer is then what cleared it) or in Codex.
          const h = this.held.get(id!);
          if (h) { this.held.delete(id!); this.resolved.get(h)?.(); }
          if (was) void this.release(id!, "question");
        }
        this.touch(id!);
        this.recompute();
        return;
      }
      case "thread/name/updated":
        if (id && this.threads.has(id)) { this.threads.set(id, { ...this.threads.get(id)!, name: p.threadName ?? null }); this.recompute(); }
        return;
      case "thread/archived":
        if (id) { this.threads.delete(id); this.held.delete(id); this.recompute(); }
        return;
      case "thread/unarchived":
        void this.refresh();
        return;
      case "serverRequest/resolved": {
        const h = id ? this.held.get(id) : undefined;
        if (h && h.id === p.requestId && h.rpc === this.rpc) { this.held.delete(id!); this.resolved.get(h)?.(); this.recompute(); }
        return;
      }
      case "turn/completed": case "turn/started":
        if (id) this.touch(id);
        return;
    }
  }
  private readonly resolved = new Map<Held, () => void>();
  private onRequest(r: ServerRequest) {
    const rpc = this.rpc;
    if (!rpc) return;
    // Codex asks every client what time it is; the answer is harmless and always right.
    if (r.method === "currentTime/read") { rpc.respond(r.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
    // Questions and approvals are kept for reading out (and questions for answering). Approvals are never answered,
    // and nothing else is either: whoever started the thread (its terminal) answers those.
    const threadId = r.params?.threadId ?? r.params?.conversationId;
    if ((r.method === QUESTION || APPROVALS.has(r.method)) && typeof threadId === "string") {
      this.held.set(threadId, { rpc, id: r.id, method: r.method, params: r.params });
      this.recompute();
    }
  }
  /** Subscribes to a thread that's waiting on the user, so Codex replays the question (or approval) it's waiting on. */
  private async watchQuestion(id: string) {
    const row = this.rows.get(id);
    if (!row || this.held.has(id) || this.subscribed.has(id) || this.unreadable.has(id)) return;
    await this.subscribe(id, "question").catch((e) => {
      // Said once per question: the item still shows as waiting, with Codex's terminal to answer it in.
      this.unreadable.add(id);
      this.opts.log(`codex: couldn't read the question in ${id} (${(e as Error).message})`);
    });
  }
  /** Threads whose question couldn't be read (another provider, say), until their status changes. */
  private readonly unreadable = new Set<string>();
  /**
   * `thread/resume`: subscribes this connection to a thread (loading it into the daemon if nothing has), and says what
   * it runs with. On a thread already subscribed it only rejoins.
   */
  private async subscribe(id: string, why: string): Promise<any> {
    const rpc = this.rpc;
    if (!rpc) throw new ConnectionError(NOT_CONNECTED);
    const reasons = this.subscribed.get(id) ?? new Set<string>();
    reasons.add(why); this.subscribed.set(id, reasons);
    try {
      return await rpc.request("thread/resume", { threadId: id, excludeTurns: true }, this.opts.acceptanceTimeoutMs ?? 20_000);
    } catch (e) {
      reasons.delete(why);
      if (!reasons.size && this.subscribed.get(id) === reasons) this.subscribed.delete(id);
      throw e;
    }
  }
  /** Lets go of a thread once nothing here needs it, so Codex can unload it when nothing else has it open. */
  private async release(id: string, why: string) {
    const reasons = this.subscribed.get(id);
    if (!reasons) return;
    reasons.delete(why);
    if (reasons.size) return;
    this.subscribed.delete(id);
    await this.rpc?.request("thread/unsubscribe", { threadId: id }).catch(() => {});
  }

  // --- Acting -----------------------------------------------------------------------------------------------------

  async check(action: Action): Promise<string | null> { return this.preflight(action); }
  private preflight(action: Action): string | null {
    if (this.closed) return "Codex isn't available right now.";
    if (!this.opts.policy.codex) return "Codex sessions are disabled on this machine.";
    if (!allows(this.opts.policy, action.kind, "codex")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      if (!this.loaded) return NOT_CONNECTED;
      if (!this.roots.has(action.placeId)) return "That project isn't visible to 10 & 2.";
      if (!withinCeiling(this.opts.policy, action.profile, "codex")) return "That launch profile exceeds this machine's permission ceiling.";
      const worktrees = join(this.roots.get(action.placeId)!, ".codex", "worktrees");
      if (action.profile.workspace === "worktree" && existsSync(worktrees) && !visible(this.opts.policy, worktrees)) return "That project's worktree folder is outside 10 & 2's visible folders.";
      return this.connected() ? null : NOT_CONNECTED;
    }
    const row = this.rows.get(action.itemId);
    if (!row || !visible(this.opts.policy, row.thread.cwd)) return "That session isn't visible to 10 & 2.";
    if (action.kind === "snooze" && Number.isNaN(Date.parse(action.until))) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.connected() ? this.followUpRefusal(row) : NOT_CONNECTED;
    return null;
  }
  private followUpRefusal(row: Row): string | null {
    const t = row.thread, held = this.held.get(t.id), flag = this.waitingFlag(t);
    if (held && held.method !== QUESTION) return `Codex is waiting for your OK: it ${wants(held)}. 10 & 2 can't approve that, so answer it in Codex.`;
    if (flag === "approval") return "Codex is waiting for your OK in its terminal. 10 & 2 can't approve that, so answer it there.";
    if (held || flag === "question") return answers(this.opts.policy, "codex") ? null : NO_ANSWERS;
    if (t.status.type === "systemError") return "That session hit an error in Codex. Open it in Codex to carry on.";
    if (t.status.type !== "notLoaded") return steers(this.opts.policy, "codex") ? null : NO_STEERING;
    return null;
  }
  /** Follow-ups this machine would refuse right now, per session; checked again on execute. */
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", "codex")) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) {
      const why = this.connected() ? this.followUpRefusal(row) : NOT_CONNECTED;
      if (why) out[id] = { follow_up: why };
    }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed) return { ok: false, error: "Codex isn't available right now." };
    const digest = hash(JSON.stringify(action));
    const earlier = this.earlier(key, digest);
    if (earlier) return earlier;
    const why = this.preflight(action);
    if (why) return { ok: false, error: why };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind, new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.earlier(key, digest) ?? UNKNOWN;
      this.recompute();
      return receipt;
    }
    // Refusals that need no reservation come first: nothing is sent for them.
    if (action.kind === "follow_up") {
      const held = this.held.get(action.itemId);
      if (held?.method === QUESTION) {
        const a = answersFor(held.params?.questions ?? [], action.message);
        if ("error" in a) return { ok: false, error: a.error };
      }
    }
    if (!this.store.begin(key, digest)) return this.earlier(key, digest) ?? UNKNOWN;
    const run = (async (): Promise<Receipt> => {
      try {
        return this.store.finish(key, action.kind === "start_work" ? await this.startWork(action, key) : await this.followUp(action, key));
      } catch (e) {
        this.opts.log(`codex: ${action.kind} failed (${(e as Error).message})`);
        return this.store.finish(key, e instanceof ConnectionError ? UNKNOWN : { ok: false, error: REFUSED });
      }
    })();
    this.writes.add(run);
    try { return await run; } finally { this.writes.delete(run); this.recompute(); }
  }
  /** The outcome already recorded for this key, if any: the same receipt again, never a second send. */
  private earlier(key: string, digest: string): Receipt | null {
    const prior = this.store.operation(key);
    if (!prior) return null;
    return prior.hash !== digest ? { ok: false, error: REUSED } : prior.receipt ? JSON.parse(prior.receipt) : UNKNOWN;
  }

  private async followUp(action: Extract<Action, { kind: "follow_up" }>, key: string): Promise<Receipt> {
    const id = action.itemId, rpc = this.rpc!;
    const t = this.rows.get(id)!.thread;
    if (this.held.get(id)?.method === QUESTION || this.waitingFlag(t) === "question") return this.answer(id, action.message);
    const timeout = this.opts.acceptanceTimeoutMs ?? 20_000;
    const clientUserMessageId = messageIdFor(key);
    if (t.status.type === "active") {
      // Running: the message joins the turn that's going, between its steps.
      const r: any = await rpc.request("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, timeout);
      const turn = (r?.data ?? [])[0] as Turn | undefined;
      if (turn?.status === "inProgress") {
        try {
          await rpc.request("turn/steer", { threadId: id, input: text(action.message), expectedTurnId: turn.id, clientUserMessageId }, timeout);
          this.touch(id);
          return { ok: true };
        } catch (e) {
          if (e instanceof ConnectionError) return this.reconcile(id, clientUserMessageId);
          // The turn ended just now (Codex said so, and took nothing): it's an open, idle thread now.
          if (!/active turn|expected/i.test((e as Error).message)) throw e;
        }
      }
    }
    return this.turn(id, action.message, clientUserMessageId, t.status.type !== "notLoaded");
  }
  /**
   * A new turn in a thread: loaded first (`thread/resume`, which also says what it runs with), so a thread nothing has
   * open is taken into Codex's daemon, where `codex resume` and `codex agents` show it. It never runs with more than
   * this machine's ceiling allows. Sent once Codex accepts the turn.
   */
  private async turn(id: string, message: string, clientUserMessageId: string, open: boolean): Promise<Receipt> {
    const rpc = this.rpc!, timeout = this.opts.acceptanceTimeoutMs ?? 20_000;
    let resumed: any;
    try {
      resumed = await this.subscribe(id, "write");
    } catch (e) {
      if (e instanceof ConnectionError) return UNKNOWN; // a resume sends nothing, but whether it loaded is unknown
      const m = (e as Error).message;
      this.opts.log(`codex: couldn't load ${id} (${m})`);
      if (/active writer/i.test(m)) return { ok: false, error: "That session is open in a Codex window 10 & 2 can't reach. Send it from there." };
      if (/provider/i.test(m)) return { ok: false, error: "That session uses a different AI provider than Codex does now, so 10 & 2 can't continue it." };
      if (/not found|no rollout|materialized/i.test(m)) return { ok: false, error: "Codex can't find that session any more." };
      return { ok: false, error: REFUSED };
    }
    try {
      const status = resumed?.thread?.status?.type;
      if ((open || status === "active") && !steers(this.opts.policy, "codex")) return { ok: false, error: NO_STEERING };
      const ceiling = ceilingFor(this.opts.policy, "codex");
      const capped = above(reachOf(resumed?.approvalPolicy, resumed?.sandbox, resumed?.approvalsReviewer), ceiling) ? turnSettings(ceiling) : {};
      // A thread in plan mode stays in it, unless the words just say to go ahead with the plan.
      const plan = resumed?.collaborationMode?.mode === "plan" && goAhead(message) && typeof resumed?.model === "string"
        ? { collaborationMode: { mode: "default", settings: { model: resumed.model, reasoning_effort: null, developer_instructions: null } } } : {};
      try {
        await rpc.request("turn/start", { threadId: id, input: text(message), clientUserMessageId, ...capped, ...plan }, timeout);
      } catch (e) {
        if (e instanceof ConnectionError) return this.reconcile(id, clientUserMessageId);
        throw e;
      }
      this.touch(id);
      return { ok: true };
    } finally { void this.release(id, "write"); }
  }
  /**
   * After a write whose answer was lost: sent if the thread has a message with this message's id, else unknown (never
   * "not sent": Codex may still take it).
   */
  private async reconcile(id: string, clientUserMessageId: string): Promise<Receipt> {
    const deadline = Date.now() + Math.min(this.opts.acceptanceTimeoutMs ?? 20_000, 5000);
    while (Date.now() < deadline && !this.closed) {
      if (!this.rpc) await this.connect().catch(() => {});
      const rpc = this.rpc;
      if (rpc) {
        try {
          const r: any = await rpc.request("thread/turns/list", { threadId: id, limit: 3, sortDirection: "desc", itemsView: "full" }, 5000);
          const found = ((r?.data ?? []) as Turn[]).some((turn) => turn.items.some((i) => i.type === "userMessage" && i.clientId === clientUserMessageId));
          return found ? { ok: true } : UNKNOWN;
        } catch { /* try again until the deadline */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return UNKNOWN;
  }
  /**
   * The answer to the question a thread is waiting on, through this connection (Codex replays it to whoever
   * subscribes). Sent once Codex says the question is resolved after this answer.
   */
  private async answer(id: string, words: string): Promise<Receipt> {
    const timeout = this.opts.acceptanceTimeoutMs ?? 20_000;
    if (!this.held.has(id)) {
      await this.subscribe(id, "question");
      const end = Date.now() + Math.min(timeout, 3000);
      while (!this.held.has(id) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    }
    const held = this.held.get(id);
    if (!held || held.method !== QUESTION) return { ok: false, error: held ? `Codex is waiting for your OK: it ${wants(held)}. 10 & 2 can't approve that, so answer it in Codex.` : "Codex's question was already answered. Nothing was sent." };
    if (held.rpc !== this.rpc) return { ok: false, error: "Codex's question was already answered. Nothing was sent." };
    const a = answersFor(held.params?.questions ?? [], words);
    if ("error" in a) return { ok: false, error: a.error };
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.resolved.delete(held); resolve(false); }, timeout);
      this.resolved.set(held, () => { clearTimeout(timer); this.resolved.delete(held); resolve(true); });
      held.rpc.onClose(() => { clearTimeout(timer); this.resolved.delete(held); resolve(false); });
    });
    if (!held.rpc.respond(held.id, { answers: a.answers })) return { ok: false, error: NOT_CONNECTED };
    if (!await done) return { ok: false, unknown: true, error: "Codex may have had its answer already. 10 & 2 won't send it again." };
    this.touch(id);
    return { ok: true };
  }

  /**
   * New work: `thread/start` with the profile's settings, in the project's checkout or a fresh worktree inside it
   * (`.codex/worktrees/10and2-<id>`, as Claude Code keeps its own, starting where the policy's `worktreeBase` says), then
   * its first turn on the same connection (a thread with no turn is dropped when its client leaves). Plan profiles start
   * in Codex's plan mode.
   */
  private async startWork(action: Extract<Action, { kind: "start_work" }>, key: string): Promise<Receipt> {
    const timeout = this.opts.acceptanceTimeoutMs ?? 20_000;
    const s = SETTINGS[action.profile.runtimeMode];
    const root = this.roots.get(action.placeId)!;
    let cwd = root;
    if (action.profile.workspace === "worktree") {
      try { cwd = await addWorktree(root, join(".codex", "worktrees"), createHash("sha256").update(key).digest("hex").slice(0, 12), this.opts.policy.worktreeBase ?? "HEAD"); }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    }
    const rpc = this.rpc;
    if (!rpc) return { ok: false, error: NOT_CONNECTED };
    let started: any;
    try {
      started = await rpc.request("thread/start", { cwd, approvalPolicy: s.approvalPolicy, sandbox: s.sandbox, approvalsReviewer: s.approvalsReviewer, threadSource: "10and2" }, timeout);
    } catch (e) {
      if (e instanceof ConnectionError) return UNKNOWN;
      this.opts.log(`codex: thread/start refused (${(e as Error).message})`);
      return { ok: false, error: REFUSED };
    }
    const threadId: string = started?.thread?.id;
    if (typeof threadId !== "string") return UNKNOWN;
    const reasons = this.subscribed.get(threadId) ?? new Set<string>(); reasons.add("write"); this.subscribed.set(threadId, reasons);
    if (started.thread) this.threads.set(threadId, started.thread);
    const clientUserMessageId = messageIdFor(key);
    const plan = action.profile.interactionMode === "plan" && typeof started.model === "string"
      ? { collaborationMode: { mode: "plan", settings: { model: started.model, reasoning_effort: null, developer_instructions: null } } } : {};
    try {
      await rpc.request("turn/start", { threadId, input: text(action.message), clientUserMessageId, ...plan }, timeout);
    } catch (e) {
      void this.release(threadId, "write");
      if (e instanceof ConnectionError) { const r = await this.reconcile(threadId, clientUserMessageId); return r.ok ? { ok: true, itemId: threadId } : r; }
      this.opts.log(`codex: turn/start refused (${(e as Error).message})`);
      return { ok: false, error: REFUSED };
    }
    // Named once Codex has written the thread down (it can't name an empty one); a name that doesn't take is no failure.
    const naming = (async () => {
      if (action.title) {
        for (let i = 0; i < 20 && this.rpc === rpc; i++) {
          await new Promise((r) => setTimeout(r, 150));
          try { await rpc.request("thread/name/set", { threadId, name: action.title }, 5000); break; } catch { /* not written yet */ }
        }
      }
      await this.release(threadId, "write");
    })();
    this.writes.add(naming);
    void naming.finally(() => this.writes.delete(naming));
    this.touch(threadId);
    return { ok: true, itemId: threadId };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled([...this.writes]);
    this.closed = true; this.loaded = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.turnsTimer) clearTimeout(this.turnsTimer);
    this.listeners.clear();
    const rpc = this.rpc; this.rpc = null;
    rpc?.close();
    this.store.close();
  }
}

/** Codex's home: $CODEX_HOME, else ~/.codex. */
export const defaultCodexHome = (env: NodeJS.ProcessEnv = process.env): string => resolve(env.CODEX_HOME || join(homedir(), ".codex"));
/**
 * For setup: how many Codex sessions of the user's own the last `days` days have, from the rollout files alone (no
 * daemon needed). T3 Code's and `codex exec` runs aren't counted. Null when there's no Codex home here.
 */
export function countSessions(home = defaultCodexHome(), days = 14, now = Date.now()): number | null {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  let n = 0;
  for (let d = 0; d <= days; d++) {
    const day = new Date(now - d * 86_400_000);
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      let meta: any = null;
      try {
        const fd = openSync(join(dir, f), "r");
        try { const b = Buffer.alloc(64 * 1024); const len = readSync(fd, b, 0, b.length, 0); meta = JSON.parse(b.subarray(0, len).toString("utf8").split("\n")[0]!)?.payload; }
        finally { closeSync(fd); }
      } catch { /* unreadable or a long first line: counted */ }
      if (/^t3\b/i.test(meta?.originator ?? "") || meta?.source === "exec" || (typeof meta?.cwd === "string" && t3Cwd(meta.cwd))) continue;
      n++;
    }
  }
  return n;
}
