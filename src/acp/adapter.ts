// One adapter for the coding agents 10 & 2 reaches through their ACP mode (the Agent Client Protocol): Gemini CLI and
// GitHub Copilot CLI. What differs between them is a `Source` (gemini/source.ts, copilot/source.ts): where their
// sessions are and how to read them, which are open in a terminal or an editor, and which of their modes a launch
// profile is. The rest is here: the list and reports, settle/snooze/archive (kept by the connector, as neither has its
// own), and turns, a follow-up to a session nothing has open or new work, run by a detached `10and2 acp-turn`
// (turn.ts) so a turn carries on if the connector stops. A session open elsewhere is never sent to: neither CLI takes
// words from outside while it's open, and a second agent on one session would split it.
import { watch, existsSync, mkdirSync, openSync, closeSync, statSync, readdirSync, unlinkSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Action, Adapter, CodingModel, FirstAsk, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, answers, ceilingFor, steers, visible, withinCeiling, RUNTIME_MODES, type Policy, type RuntimeMode } from "../policy.ts";
import { talk, type Question } from "../pi/bridge.ts";
import { answersFor } from "../claude/adapter.ts";
import { addWorktree, firstAsk, folderOf, gitRoot, group } from "../work.ts";
import { Store } from "../claude/store.ts";
import { pidState, procStart } from "../claude/registry.ts";
import { describe } from "../util.ts";
import type { Projection } from "./session.ts";
import { AcpClient } from "./rpc.ts";
import type { Settings, Turn } from "./turn.ts";
import { NOT_STARTED } from "./turn.ts";

/** One session as a source read it. */
export type Found = {
  id: string; cwd: string; title: string | null; createdAt: string | null; mtimeMs: number;
  projection: Projection;
  /** The user has said something in it (agents leave files for sessions never started). */
  started: boolean;
  /** The question it's waiting on the user for, in the agent itself. */
  question: string | null;
  userCount: number;
  says(words: string, after: number): boolean;
};

export interface Source {
  readonly agent: "gemini" | "copilot";
  /** As the user says it: "Gemini CLI". */
  readonly name: string;
  /** The agent's ACP mode, as its program and arguments. */
  readonly command: string[];
  /** Where a worktree profile's new work goes, inside the project: `.gemini/worktrees`. */
  readonly worktrees: string;
  /** Folders whose changes mean the sessions should be read again. */
  dirs(): string[];
  /** Sessions changed since `sinceMs`, and those in `also` whenever they changed. */
  sessions(sinceMs: number, also: Set<string>): Found[];
  /** One session, wherever it is (new work's, once the agent has named it). */
  find(id: string): Found | null;
  /** Which of these are open in the agent itself now (a terminal, an editor), apart from Driver's own runs (`own` pids). */
  open(found: Found[], own: Set<number>): Set<string>;
  /** What a launch with this mode sets: the agent's mode and options (approvals). Plan: its plan mode. */
  launch(runtime: RuntimeMode, plan: boolean): Settings;
  /** What a loaded session may keep at this ceiling; anything else is lowered to `launch(ceiling, false)`. */
  allowed(ceiling: RuntimeMode): { modes: string[]; options: Record<string, string[]> };
  /** The agent's environment for Driver's runs. */
  env(): NodeJS.ProcessEnv;
  /**
   * Sessions open in an agent that runs 10 & 2's extension (Copilot's), by id: what it's doing, the questions it can
   * take an answer to, and where it listens. Open sessions without it can't be reached.
   */
  live?(): Map<string, Reach>;
  /** What to say about an open session the agent's extension isn't reaching, when there's something to do about it. */
  reachHint?(): string | null;
}

/** An open session 10 & 2's extension reaches. */
export type Reach = { status: "idle" | "busy" | "waiting"; questions: Question[]; socket: string };

export type Options = {
  policy: Policy; source: Source; db: string; stateDir: string; log: (m: string) => void; now?: () => number;
  /** How long inactive sessions remain in the briefing. Open ones are always included. */
  days?: number;
  acceptanceTimeoutMs?: number;
  readCacheMs?: number;
  /** The detached runner: `<nodeBin> <entryScript> acp-turn` (this Node and the connector's own command by default). */
  nodeBin?: string;
  entryScript?: string;
  /** How often the models are read again (6 hours), and after a read that failed (5 minutes). */
  modelsEveryMs?: number;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** A title from the first words, when the agent gives none: its first line, cut at a word to about 60 characters. */
export function shortTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30))}…`;
}
/** The words as the agent's prompt gets them: one starting with "/" would be taken as a command, so a space keeps it words. */
export const promptText = (message: string) => message.startsWith("/") ? ` ${message}` : message;

/** A question as Driver reads it out: "Which one? Options: Alpha / Beta." */
const questionText = (q: Question) => `${q.title}${q.options.length ? ` Options: ${q.options.join(" / ")}.` : ""}`;

/** The narrower of two runtime modes. */
const lower = (a: RuntimeMode, b: RuntimeMode): RuntimeMode => RUNTIME_MODES.indexOf(a) <= RUNTIME_MODES.indexOf(b) ? a : b;

type Row = { found: Found; open: boolean; live: Reach | null; item: WorkItem };

export class AcpAdapter implements Adapter {
  readonly name: string;
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  private readonly opts: Options;
  private readonly source: Source;
  private readonly store: Store;
  private readonly now: () => number;
  private loaded = false;
  private closed = false;
  private closing = false;
  private shutdown: Promise<void> | null = null;
  private rows = new Map<string, Row>();
  private roots = new Map<string, string>();
  private keys = new Map<string, string>();
  private questions = new Map<string, string | null>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private rescan: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private modelsTimer: NodeJS.Timeout | null = null;
  private writes = new Set<Promise<Receipt>>();
  private scannedAt = 0;
  private models: CodingModel[] = [];

  constructor(opts: Options) {
    this.opts = opts; this.source = opts.source; this.name = opts.source.agent; this.now = opts.now ?? Date.now;
    this.store = new Store(opts.db);
    // What Driver started a session with (its runtime mode, so a follow-up runs the same way) and the title it gave it.
    // When Driver's last run of it ended, so what it wrote then isn't taken for a terminal's.
    this.store.db.exec("CREATE TABLE IF NOT EXISTS acp_sessions (sessionId TEXT PRIMARY KEY, runtime TEXT, title TEXT, ranAt INTEGER)");
  }
  private remembered(id: string): { runtime: RuntimeMode | null; title: string | null; ranAt: number | null } {
    const r = this.store.db.prepare("SELECT runtime, title, ranAt FROM acp_sessions WHERE sessionId=?").get(id) as { runtime: string | null; title: string | null; ranAt: number | null } | undefined;
    return { runtime: RUNTIME_MODES.includes(r?.runtime as RuntimeMode) ? r!.runtime as RuntimeMode : null, title: r?.title ?? null, ranAt: r?.ranAt ?? null };
  }
  private remember(id: string, runtime: RuntimeMode, title: string | null) {
    this.store.db.prepare("INSERT INTO acp_sessions(sessionId, runtime, title) VALUES(?,?,?) ON CONFLICT(sessionId) DO UPDATE SET runtime=excluded.runtime, title=excluded.title").run(id, runtime, title);
  }
  private ran(id: string, at: number) {
    this.store.db.prepare("INSERT INTO acp_sessions(sessionId, ranAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET ranAt=excluded.ranAt").run(id, at);
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) throw new Error(`${this.source.name} adapter is closed`);
    if (this.loaded) return;
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    // A crash between reservation and spawn leaves no runner to wait for; its operation stays unknown, never resent.
    for (const run of this.store.runs()) if (run.pid === null) this.store.ended(run.sessionId);
    for (const name of readdirSync(this.opts.stateDir)) {
      if (!/^[a-f0-9]{24}\.stderr\.log$/.test(name)) continue;
      const path = join(this.opts.stateDir, name);
      try { if (statSync(path).mtimeMs < this.now() - 7 * 86_400_000) unlinkSync(path); } catch { /* pruned next time */ }
    }
    this.scan(); this.loaded = true;
    this.rescan = setInterval(() => this.safeScan(), 30_000); this.rescan.unref();
    void this.readModels();
  }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean { return this.loaded && !this.closed && !this.closing && this.opts.policy[this.source.agent] === true; }
  private schedule = () => {
    if (this.closed || this.closing || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.safeScan(); }, 250); this.debounce.unref();
  };
  private fresh() { if (Date.now() - this.scannedAt >= (this.opts.readCacheMs ?? 1000)) this.scan(); }
  private safeScan() { if (!this.closed) { try { this.scan(); } catch (e) { this.opts.log(`${this.name}: local scan failed (${describe(e)}); will retry`); } } }

  /**
   * What a new session can start on, as the agent's ACP mode lists it for a new session, asked in a private folder of
   * the connector's (the agent keeps an unused session there, never one of the user's projects). The one it would use
   * by itself first.
   */
  private async readModels(): Promise<void> {
    if (this.closed || this.closing) return;
    const dir = join(this.opts.stateDir, "models");
    let failed = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const client = new AcpClient(this.source.command, dir, this.source.env());
      const timer = setTimeout(() => client.child.kill(), 60_000);
      try {
        await client.initialize();
        const s = await client.session(dir);
        const list = s.models.length ? s.models : (s.configOptions.find((o) => o?.id === "model")?.options ?? []).map((o: any) => ({ modelId: String(o.value), name: String(o.name ?? o.value) }));
        const current = s.currentModelId ?? s.configOptions.find((o) => o?.id === "model")?.currentValue ?? null;
        const seen = new Set<string>();
        this.models = [...list].sort((a, b) => Number(b.modelId === current) - Number(a.modelId === current))
          .filter((m) => !seen.has(m.modelId) && seen.add(m.modelId)).map((m) => ({ id: m.modelId, name: m.name }));
        if (client.agentCapabilities?.sessionCapabilities?.close) await client.request("session/close", { sessionId: s.sessionId }).catch(() => {});
      } finally { clearTimeout(timer); client.stop(); }
    } catch (e) {
      failed = true;
      this.opts.log(`${this.name}: couldn't read ${this.source.name}'s models (${describe(e)}); new work starts on its own`);
    }
    if (this.closed || this.closing) return;
    this.modelsTimer = setTimeout(() => void this.readModels(), failed ? 5 * 60_000 : this.opts.modelsEveryMs ?? 6 * 3_600_000);
    this.modelsTimer.unref();
    this.schedule();
  }

  private scan(): void {
    if (this.closed) return;
    this.scannedAt = Date.now();
    const policy = this.opts.policy, agent = this.source.agent;
    const runs = this.store.runs();
    // A run that ended while the connector wasn't watching (it restarted meanwhile) ended by now, near enough.
    for (const run of runs) if (run.pid && pidState(run.pid, run.procStart) === "dead") { this.ran(run.sessionId, this.now()); this.store.ended(run.sessionId, run.pid); }
    const running = new Map(this.store.runs().filter((r) => r.pid).map((r) => [r.sessionId, r.pid!]));
    const cutoff = this.now() - (this.opts.days ?? 14) * 86_400_000;
    const found = this.source.sessions(cutoff, new Set(running.keys())).filter((f) => f.started && visible(policy, f.cwd));
    const open = this.source.open(found, new Set(running.values()));
    const lives = this.source.live?.() ?? new Map<string, Reach>();
    const next = new Map<string, Row>();
    for (const f of found) {
      if (!policy[agent]) continue;
      const overlay = this.store.overlay(f.id);
      if (overlay.archived) continue;
      // Open where the agent says so, but not for what Driver's own last run wrote (a source that can only guess from
      // when a session was written would take that for a terminal's).
      const ranAt = this.remembered(f.id).ranAt;
      const live = running.has(f.id) ? null : lives.get(f.id) ?? null;
      const p = f.projection, isOpen = !!live || (open.has(f.id) && !running.has(f.id) && !(ranAt !== null && f.mtimeMs <= ranAt + 3000));
      const question = live?.questions[0] ? questionText(live.questions[0]) : f.question;
      const pending = isOpen && !!question;
      const busy = running.has(f.id) || (live ? live.status === "busy" : isOpen && p.unanswered);
      const updatedAt = [p.updatedAt, new Date(f.mtimeMs).toISOString()].filter((x): x is string => !!x).sort().at(-1)!;
      if (!isOpen && !running.has(f.id) && Date.parse(updatedAt) < cutoff) continue;
      const lastRunAt = p.lastRunAt;
      const newer = (at: string | null) => !!at && !!lastRunAt && lastRunAt > at;
      const title = f.title ?? this.remembered(f.id).title ?? (p.first ? shortTitle(p.first.text) : null) ?? `a ${this.source.name} session in ${group(f.cwd)}`;
      const item: WorkItem = {
        id: f.id, title, group: group(f.cwd),
        status: pending ? "waiting" : busy ? "running" : p.status,
        updatedAt, settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !pending && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: pending, questionId: pending ? hash(f.id + question).slice(0, 16) : null,
        lastRunAt, wroteAt: p.wroteAt, createdAt: f.createdAt,
      };
      next.set(f.id, { found: f, open: isOpen, live, item });
    }
    this.rows = next;
    this.roots.clear();
    for (const row of next.values()) {
      const root = gitRoot(row.found.cwd);
      // A visible subfolder must not grant a launch into its hidden repository parent.
      if (root && visible(policy, root)) this.roots.set(hash(root).slice(0, 12), root);
    }
    const changed: string[] = []; let urgent = false;
    for (const [id, row] of next) {
      const w = row.item, reply = row.found.projection.replies[0];
      const key = JSON.stringify([w.status, w.title, w.settled, w.snoozedUntil, w.questionId, w.lastRunAt, row.open, reply?.messageId, reply?.text]);
      if (this.keys.get(id) !== key) { changed.push(id); urgent ||= w.pendingQuestion && this.questions.get(id) !== w.questionId; }
      this.keys.set(id, key); this.questions.set(id, w.questionId ?? null);
    }
    for (const id of this.keys.keys()) if (!next.has(id)) { changed.push(id); this.keys.delete(id); this.questions.delete(id); }
    if (!this.closing) this.watchPaths(new Set(this.source.dirs()));
    if (changed.length) for (const listener of this.listeners) listener(changed, urgent);
  }
  private watchPaths(wanted: Set<string>) {
    for (const [path, watcher] of this.watchers) if (!wanted.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, this.schedule);
        watcher.on("error", () => { watcher.close(); this.watchers.delete(path); this.schedule(); });
        this.watchers.set(path, watcher);
      } catch { /* missing folders and exhausted watch limits: the periodic scan covers them */ }
    }
  }

  places(): Place[] {
    const agent = this.source.agent;
    if (!this.loaded || this.closed || !this.opts.policy[agent] || !allows(this.opts.policy, "start_work", agent)) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => gitRoot(r.found.cwd) === root).map((r) => r.item.updatedAt).sort().at(-1) ?? null,
      models: this.models.map((m) => ({ ...m })) }));
  }
  async list(): Promise<WorkItem[]> { this.fresh(); return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.found.cwd)) throw new Error("That session isn't visible to 10 & 2.");
    return row;
  }
  async report(id: string): Promise<Report> {
    this.fresh();
    const r = this.row(id), p = r.found.projection, last = p.replies[0] ?? null;
    return { text: last?.text ?? "", progress: r.item.status === "running" ? p.progress : null, question: r.item.pendingQuestion ? (r.live?.questions[0] ? questionText(r.live.questions[0]) : r.found.question) : null,
      reply: last ? { runId: last.runId, messageId: last.messageId, at: last.at } : null };
  }
  async replies(id: string): Promise<PastReply[]> { this.fresh(); return this.row(id).found.projection.replies.map((r) => ({ ...r })); }
  async firstAsk(id: string): Promise<FirstAsk | null> { this.fresh(); const f = this.row(id).found.projection.first; return f ? firstAsk(f.text, f.at, true) : null; }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  async check(action: Action): Promise<string | null> { return this.preflight(action); }
  private preflight(action: Action): string | null {
    const name = this.source.name, agent = this.source.agent;
    if (this.closed || this.closing || !this.loaded) return `${name} sessions aren't loaded right now.`;
    this.scan();
    const policy = this.opts.policy;
    if (!policy[agent]) return `${name} sessions are disabled on this machine.`;
    if (!allows(policy, action.kind, agent)) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      if (!this.roots.has(action.placeId)) return "That project isn't visible to 10 & 2.";
      if (!withinCeiling(policy, action.profile, agent)) return `The ${action.profile.name} profile asks for more access than this machine allows for ${name}.`;
      const worktrees = join(this.roots.get(action.placeId)!, this.source.worktrees);
      if (action.profile.workspace === "worktree" && existsSync(worktrees) && !visible(policy, worktrees)) return "That project's worktree folder is outside 10 & 2's visible folders.";
      return null;
    }
    const row = this.rows.get(action.itemId);
    if (!row) return "That session isn't visible to 10 & 2.";
    if (action.kind === "snooze" && !Number.isFinite(Date.parse(action.until))) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.followUpRefusal(action.itemId, row);
    return null;
  }
  private followUpRefusal(id: string, row: Row): string | null {
    const name = this.source.name, policy = this.opts.policy, agent = this.source.agent;
    // Open where 10 & 2's extension reaches it: its question takes the answer; otherwise the words go in as typed.
    if (row.live) {
      if (row.live.questions.length) return answers(policy, agent) ? null : `It's waiting for an answer in ${name}, and this computer doesn't let 10 & 2 answer.`;
      return steers(policy, agent) ? null : `It's open in ${name}, and this computer doesn't let 10 & 2 send to open sessions.`;
    }
    const hint = this.source.reachHint?.();
    if (row.open) return row.found.question
      ? `It's waiting for your answer in ${name}. Answer it there${hint ? `. ${hint}` : ": 10 & 2 can't reach it."}`
      : `It's open in ${name}, where 10 & 2 can't reach it. Say it there, or close it${hint ? `. ${hint}` : "."}`;
    if (this.store.run(id)) return "10 & 2 is already running that session, or can't yet tell that its last run ended.";
    if (!existsSync(row.found.cwd)) return "That session's folder isn't on this computer anymore.";
    return null;
  }
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", this.source.agent)) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) { const why = this.followUpRefusal(id, row); if (why) out[id] = { follow_up: why }; }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed || this.closing) return { ok: false, error: `${this.source.name} adapter is closed.` };
    const digest = hash(JSON.stringify(action));
    const prior = this.repeat(key, digest);
    if (prior) return prior;
    const why = await this.check(action);
    if (why) return { ok: false, error: why };
    const reserved = this.repeat(key, digest);
    if (reserved) return reserved;
    const changed = this.preflight(action);
    if (changed) return { ok: false, error: changed };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind, new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.execute(action, key);
      this.scan(); return receipt;
    }
    if (action.kind === "follow_up") {
      const live = this.rows.get(action.itemId)?.live;
      if (live) return this.tracked(this.reach(action, key, digest, live));
    }
    // New work's session has no id until the agent makes one: its run is kept under one made from the key meanwhile.
    const id = action.kind === "start_work" ? `new-${hash(key).slice(0, 24)}` : action.itemId;
    if (this.store.run(id)) return { ok: false, error: "10 & 2 is already running that session." };
    if (!this.store.begin(key, digest, id)) return this.repeat(key, digest) ?? { ok: false, error: "10 & 2 is already running that session." };
    return this.tracked(this.launch(action, key, id));
  }
  private unknown(): Receipt { return { ok: false, unknown: true, error: `I can't tell whether ${this.source.name} received that. 10 & 2 won't send it again.` }; }
  private repeat(key: string, digest: string): Receipt | null {
    const prior = this.store.operation(key);
    if (!prior) return null;
    return prior.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : prior.receipt ? JSON.parse(prior.receipt) : this.unknown();
  }
  private async tracked(pending: Promise<Receipt>): Promise<Receipt> {
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }

  /**
   * Words to a session open where 10 & 2's extension reaches it: the answer to its question (the option the user named,
   * else their words), or the words as if typed there (a busy one takes them into the turn running now). It counts as
   * sent when the extension says the agent took them.
   */
  private async reach(action: Extract<Action, { kind: "follow_up" }>, key: string, digest: string, live: Reach): Promise<Receipt> {
    if (!this.store.begin(key, digest)) return this.repeat(key, digest) ?? this.unknown();
    const name = this.source.name, q = live.questions[0];
    const request = q
      ? { id: randomUUID(), type: "answer", questionId: q.questionId, value: answersFor([{ question: q.title, options: q.options, multiSelect: false }], action.message)[q.title]! }
      : { id: randomUUID(), type: "user", text: action.message };
    const r = await talk(live.socket, request, this.opts.acceptanceTimeoutMs ? Math.min(this.opts.acceptanceTimeoutMs, 10_000) : 10_000);
    this.schedule();
    if (r === "unreachable") return this.store.finish(key, { ok: false, error: `10 & 2 couldn't reach that session in ${name}. Is it still open?` });
    if (r === "silent") return this.store.finish(key, { ok: false, unknown: true, error: `${name} didn't confirm that. 10 & 2 won't send it again.` });
    if (r?.type === "ack") return this.store.finish(key, { ok: true });
    return this.store.finish(key, { ok: false, error: q && r?.error === "answered" ? `That question was already answered in ${name}.` : `${name} didn't take that.` });
  }

  /** What a turn runs with: a new session's profile; a follow-up, what Driver started it with, else what it has, lowered to the ceiling. */
  private settingsFor(action: Extract<Action, { kind: "start_work" | "follow_up" }>): Pick<Turn, "settings" | "exact" | "allowed"> {
    const ceiling = ceilingFor(this.opts.policy, this.source.agent);
    if (action.kind === "start_work") return { settings: this.source.launch(action.profile.runtimeMode, action.profile.interactionMode === "plan"), exact: true };
    const runtime = this.remembered(action.itemId).runtime;
    // A session Driver started runs as it was started (out of plan mode: a follow-up to a plan is the go-ahead or a change).
    if (runtime) return { settings: this.source.launch(lower(runtime, ceiling), false), exact: true };
    return { settings: this.source.launch(ceiling, false), exact: false, allowed: this.source.allowed(ceiling) };
  }

  /**
   * A turn in a detached `10and2 acp-turn` (turn.ts), which carries on if the connector stops. It counts as sent once
   * the session's own file records the user's words after those it held before.
   */
  private async launch(action: Extract<Action, { kind: "start_work" | "follow_up" }>, key: string, runId: string): Promise<Receipt> {
    const starting = action.kind === "start_work", name = this.source.name;
    const row = starting ? null : this.rows.get(runId);
    let cwd = starting ? this.roots.get(action.placeId) : row?.found.cwd;
    if (starting && cwd && action.profile.workspace === "worktree") {
      try { cwd = await addWorktree(cwd, this.source.worktrees, hash(key).slice(0, 12), this.opts.policy.worktreeBase ?? "HEAD"); }
      catch (e) { this.store.ended(runId); return this.store.finish(key, { ok: false, error: (e as Error).message }); }
    }
    if (!cwd || (!starting && !row)) { this.store.ended(runId); return this.store.finish(key, { ok: false, error: "That session isn't visible to 10 & 2." }); }
    const model = starting ? (action as Extract<Action, { kind: "start_work" }>).model : undefined;
    const turn: Turn = { command: this.source.command, cwd, message: promptText(action.message), ...(starting ? {} : { load: runId }),
      ...this.settingsFor(action), ...(model ? { model } : {}) };
    const before = row?.found.userCount ?? 0;
    const token = hash(key).slice(0, 24), stderrPath = join(this.opts.stateDir, `${token}.stderr.log`);
    let sessionId: string | null = starting ? null : runId;
    const finish = (receipt: Receipt): Receipt => {
      const saved = this.store.finish(key, receipt);
      if (receipt.ok || !receipt.unknown) { try { unlinkSync(stderrPath); } catch { /* pruned at a later start */ } }
      this.scan();
      return saved;
    };
    let err: number;
    try { err = openSync(stderrPath, "wx", 0o600); }
    catch { this.store.ended(runId); return finish({ ok: false, error: "10 & 2 couldn't create a private run log." }); }
    let child: ChildProcess;
    try {
      child = spawn(this.opts.nodeBin ?? process.execPath, [this.opts.entryScript ?? process.argv[1]!, "acp-turn"],
        { cwd, detached: true, windowsHide: true, env: this.source.env(), stdio: ["pipe", "pipe", err] });
    } catch {
      closeSync(err); this.store.ended(runId);
      return finish({ ok: false, error: `10 & 2 couldn't start ${name} on this machine.` });
    }
    closeSync(err);
    const pid = child.pid;
    if (pid) this.store.started(runId, pid, procStart(pid)); else this.store.ended(runId);
    let failed = false, code: number | null | undefined, sending = false, said: string | null = null;
    child.on("error", () => { failed = true; if (!this.closed) this.store.ended(runId); });
    child.on("exit", (c) => { code = c; if (!this.closed && pid) { if (sessionId) this.ran(sessionId, this.now()); this.store.ended(sessionId ?? runId, pid); this.schedule(); } });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(turn) + "\n");
    // The runner's lines: the session's id as soon as it has one, then that the words are going.
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (typeof m?.sessionId === "string" && starting && !sessionId) {
          sessionId = m.sessionId;
          // The run is the session's now, so it's listed as running and nothing else is sent to it meanwhile.
          this.store.db.prepare("UPDATE claude_runs SET sessionId=? WHERE sessionId=?").run(sessionId, runId);
          const start = action as Extract<Action, { kind: "start_work" }>;
          this.remember(sessionId!, start.profile.runtimeMode, start.title ?? null);
        }
        if (m?.sending) sending = true;
        if (typeof m?.error === "string") said = m.error;
      }
    });
    child.stdout!.on("error", () => {});
    child.unref(); (child.stdout as any)?.unref?.();
    const deadline = Date.now() + (this.opts.acceptanceTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const f = sessionId ? this.source.find(sessionId) : null;
      if (f?.says(promptText(action.message), starting ? 0 : before)) return finish(starting ? { ok: true, itemId: sessionId! } : { ok: true });
      if (failed || code === NOT_STARTED) return finish({ ok: false, error: `${name} couldn't be started. Check that it's installed on this machine.` });
      // It stopped before the words went (a session it couldn't load, a mode it refused): nothing was sent.
      if (code !== undefined && !sending) return finish({ ok: false, error: said ? `${name} said: ${said}` : `${name} didn't take that.` });
      await new Promise((r) => setTimeout(r, code === undefined ? 50 : 100));
    }
    return finish(this.unknown());
  }

  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      if (this.rescan) clearInterval(this.rescan);
      if (this.debounce) clearTimeout(this.debounce);
      if (this.modelsTimer) clearTimeout(this.modelsTimer);
      for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
      await Promise.allSettled([...this.writes]);
      this.closed = true; this.loaded = false; this.listeners.clear();
      this.store.close();
    })();
    return this.shutdown;
  }
}

