// Cursor's CLI agent (`cursor-agent`, measured on 2026.11.19) as a work system. Its chats are read from their own files
// (chat.ts): `meta.json` for where and when, the transcript for what was said. A chat a Cursor process has open (its
// `store.db` held by `cursor-agent`, open.ts) can't be reached from outside, so it's listed but not sent to. A chat
// nothing has open is continued, and new work started, by a detached `cursor-agent -p --resume <id>` of 10 & 2's own,
// within this computer's ceiling. Settle, snooze and archive are kept here (cursor.db), as Cursor has none.
import { watch, existsSync, readdirSync, statSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Action, Adapter, CodingModel, FirstAsk, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, ceilingFor, visible, withinCeiling } from "../policy.ts";
import type { Policy, RuntimeMode } from "../policy.ts";
import { Store } from "../claude/store.ts";
import { pidState, procStart, sessionId } from "../claude/registry.ts";
import { spawnCommand } from "../command.ts";
import { addWorktree, firstAsk, folderOf, gitRoot, group } from "../work.ts";
import { CursorChat } from "./chat.ts";
import { bucketOf, cursorConfigDir, cursorDataDir } from "./paths.ts";
import { openChats } from "./open.ts";
import { chatSettings, createChat, listModels, runArgs } from "./cli.ts";

export type Options = {
  policy: Policy; db: string; stateDir: string; log: (m: string) => void; now?: () => number;
  /** Cursor's config folder (chats) and data folder (transcripts); both ~/.cursor unless moved. */
  configDir?: string;
  dataDir?: string;
  /** How Cursor's CLI is run: `cursor-agent` on PATH, or a program and its first arguments (tests). */
  cursorCommand?: string[];
  /** How long inactive chats remain in the briefing. Open ones are always included. */
  days?: number;
  /** The bounded wait for evidence a message arrived; never causes a resend. */
  acceptanceTimeoutMs?: number;
  /** How old a scan reads may reuse (1 s). Tests use 0. */
  readCacheMs?: number;
  /** Which chats a process has open (tests replace it). */
  openChats?: (chatsDir: string) => Set<string>;
  /** Whether the models are read (`cursor-agent models` asks Cursor's servers). On by default. */
  readModels?: boolean;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const UNKNOWN: Receipt = { ok: false, unknown: true, error: "I can't tell whether Cursor received that. 10 & 2 won't send it again." };
const OPEN = "It's open in Cursor, which 10 & 2 can't send to yet. Say it there, or close it there and ask again.";
const NO_ASK = "Cursor runs edits without asking when 10 & 2 runs it, so this computer's settings don't allow it.";
const MODELS_MS = 6 * 3600_000;

type Row = { chat: CursorChat; cwd: string; open: boolean; item: WorkItem };

/** Cursor's own permission settings for a run, from the most a run may have here: `--force` runs every command, `--auto-review` lets Cursor's classifier run safe ones, and its default runs edits in the folder and allowlisted commands. */
export function modeFlags(mode: RuntimeMode): string[] | null {
  if (mode === "full-access") return ["--force"];
  if (mode === "auto") return ["--auto-review"];
  if (mode === "auto-accept-edits") return [];
  return null;
}

export class CursorAdapter implements Adapter {
  readonly name = "cursor";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  readonly configDir: string;
  readonly dataDir: string;
  private readonly opts: Options;
  private readonly store: Store;
  private readonly now: () => number;
  private loaded = false;
  private closed = false;
  private closing = false;
  private shutdown: Promise<void> | null = null;
  private chats = new Map<string, CursorChat>();
  private rows = new Map<string, Row>();
  private roots = new Map<string, string>();
  private keys = new Map<string, string>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private rescan: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private modelsTimer: NodeJS.Timeout | null = null;
  private writes = new Set<Promise<Receipt>>();
  private models: CodingModel[] = [];
  private scannedAt = 0;

  constructor(opts: Options) {
    this.opts = opts; this.now = opts.now ?? Date.now;
    this.configDir = resolve(opts.configDir ?? cursorConfigDir());
    this.dataDir = resolve(opts.dataDir ?? cursorDataDir());
    this.store = new Store(opts.db);
  }
  private get chatsDir() { return join(this.configDir, "chats"); }
  private get command() { return this.opts.cursorCommand ?? ["cursor-agent"]; }
  /** Cursor's environment, naming its folders when they aren't its defaults. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.configDir !== resolve(cursorConfigDir(process.env))) env.CURSOR_CONFIG_DIR = this.configDir;
    if (this.dataDir !== resolve(cursorDataDir(process.env))) env.CURSOR_DATA_DIR = this.dataDir;
    return env;
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) throw new Error("Cursor adapter is closed");
    if (this.loaded) return;
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    for (const run of this.store.runs()) if (run.pid === null) this.store.ended(run.sessionId);
    for (const name of readdirSync(this.opts.stateDir)) {
      if (!/^[a-f0-9]{24}\.(?:out|err)\.log$/.test(name)) continue;
      const path = join(this.opts.stateDir, name);
      try { if (statSync(path).mtimeMs < this.now() - 7 * 86_400_000) unlinkSync(path); } catch { /* pruned next time */ }
    }
    this.scan(); this.loaded = true;
    this.rescan = setInterval(() => this.safeScan(), 30_000); this.rescan.unref();
    if (this.opts.readModels !== false) {
      void this.readModels();
      this.modelsTimer = setInterval(() => void this.readModels(), MODELS_MS); this.modelsTimer.unref();
    }
  }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean { return this.loaded && !this.closed && !this.closing && !!this.opts.policy.cursor && existsSync(this.chatsDir); }

  /** What `cursor-agent models` offers: Cursor's servers say, for the signed-in account. */
  private async readModels(): Promise<void> {
    try {
      const models = await listModels(this.command, this.childEnv());
      if (!this.closed && JSON.stringify(models) !== JSON.stringify(this.models)) { this.models = models; this.notifyAll(); }
    } catch (e) { this.opts.log(`cursor: couldn't read Cursor's models (${(e as Error).message}); new work starts on its own`); }
  }
  private notifyAll() { const ids = [...this.rows.keys()]; for (const l of this.listeners) l(ids, false); }

  private schedule = () => {
    if (this.closed || this.closing || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.safeScan(); }, 250); this.debounce.unref();
  };
  private fresh() { if (Date.now() - this.scannedAt >= (this.opts.readCacheMs ?? 1000)) this.scan(); }
  private safeScan() { if (!this.closed) { try { this.scan(); } catch { this.opts.log("cursor: local scan failed; will retry"); } } }

  private scan(): void {
    if (this.closed) return;
    this.scannedAt = Date.now();
    const policy = this.opts.policy;
    for (const run of this.store.runs()) if (run.pid && pidState(run.pid, run.procStart) === "dead") this.store.ended(run.sessionId, run.pid);
    const open = (this.opts.openChats ?? openChats)(this.chatsDir);
    const cutoff = this.now() - (this.opts.days ?? 14) * 86_400_000;
    const wanted = new Set<string>([this.configDir, this.chatsDir]);
    const seen = new Set<string>();
    let buckets: string[] = [];
    try { buckets = readdirSync(this.chatsDir); } catch { /* no chats yet */ }
    for (const b of buckets) {
      const bucket = join(this.chatsDir, b);
      let ids: string[];
      try { ids = readdirSync(bucket); } catch { continue; }
      wanted.add(bucket);
      for (const id of ids) {
        if (!sessionId(id)) continue;
        const dir = join(bucket, id);
        const ours = !!this.store.run(id);
        try { if (statSync(join(dir, "meta.json")).mtimeMs < cutoff && !open.has(id) && !ours) continue; } catch { if (!ours) continue; }
        let chat = this.chats.get(id);
        if (!chat || chat.dir !== dir) { chat = new CursorChat(id, dir); this.chats.set(id, chat); }
        chat.read(this.dataDir);
        seen.add(id);
      }
    }
    for (const id of this.chats.keys()) if (!seen.has(id)) this.chats.delete(id);
    const next = new Map<string, Row>();
    for (const [id, chat] of this.chats) {
      const m = chat.meta, cwd = m?.cwd;
      // A subagent's chat belongs to its parent's turn; one with nothing said yet isn't work.
      if (!policy.cursor || !m || m.isSubagent || !cwd || !visible(policy, cwd)) continue;
      // The chat is filed under its folder's hash: one filed elsewhere isn't where its meta says.
      if (basename(join(chat.dir, "..")) !== bucketOf(cwd)) continue;
      const overlay = this.store.overlay(id);
      if (overlay.archived) continue;
      const run = this.store.run(id), held = open.has(id), p = chat.projection;
      if (!m.hasConversation && !run && !held) continue;
      const updatedAt = new Date(m.updatedAtMs ?? m.createdAtMs).toISOString();
      if (!held && !run && Date.parse(updatedAt) < cutoff) continue;
      const lastRunAt = p.status === "completed" || p.status === "failed" || p.status === "cancelled" ? p.replies[0]?.at ?? updatedAt : null;
      const newer = (at: string | null) => !!at && !!lastRunAt && lastRunAt > at;
      const running = (held || !!run?.pid) && p.open;
      const title = m.title ?? (chat.first ? shortTitle(chat.first) : null) ?? `a Cursor chat in ${group(cwd)}`;
      const item: WorkItem = {
        id, title, group: group(cwd), status: running ? "running" : p.open ? "idle" : p.status,
        updatedAt, settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: false, questionId: null, lastRunAt, wroteAt: p.prompt ? updatedAt : null, createdAt: new Date(m.createdAtMs).toISOString(),
      };
      next.set(id, { chat, cwd, open: held && !run, item });
      // Its folder: Cursor rewrites meta.json there as the chat changes, and its WAL comes and goes as it's opened.
      wanted.add(chat.dir);
    }
    this.rows = next;
    this.roots.clear();
    for (const row of next.values()) {
      const root = gitRoot(row.cwd);
      if (root && visible(policy, root)) this.roots.set(hash(root).slice(0, 12), root);
    }
    const changed: string[] = [];
    for (const [id, row] of next) {
      const w = row.item, reply = row.chat.projection.replies[0];
      const key = JSON.stringify([w.status, w.title, w.settled, w.snoozedUntil, w.lastRunAt, row.open, reply?.messageId]);
      if (this.keys.get(id) !== key) changed.push(id);
      this.keys.set(id, key);
    }
    for (const id of this.keys.keys()) if (!next.has(id)) { changed.push(id); this.keys.delete(id); }
    if (!this.closing) this.watchPaths(wanted);
    if (changed.length) for (const listener of this.listeners) listener(changed, false);
  }
  private watchPaths(wanted: Set<string>) {
    for (const [path, watcher] of this.watchers) if (!wanted.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (event) => {
          // A folder that's gone is let go, and watched again by a scan once it's back. On Windows its watcher would
          // report it gone without end, a busy loop that keeps the process up (measured on Windows 10, Node 26).
          if (event === "rename" && !existsSync(path)) { watcher.close(); this.watchers.delete(path); }
          this.schedule();
        });
        watcher.on("error", () => { watcher.close(); this.watchers.delete(path); this.schedule(); });
        this.watchers.set(path, watcher);
      } catch { /* the periodic scan covers it */ }
    }
  }

  places(): Place[] {
    if (!this.loaded || this.closed || !this.opts.policy.cursor || !allows(this.opts.policy, "start_work", "cursor")) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => gitRoot(r.cwd) === root).map((r) => r.item.updatedAt).sort().at(-1) ?? null, models: this.models }));
  }
  async list(): Promise<WorkItem[]> { this.fresh(); return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.cwd)) throw new Error("That chat isn't visible to 10 & 2.");
    return row;
  }
  async report(id: string): Promise<Report> {
    this.fresh();
    const r = this.row(id), p = r.chat.projection, last = p.replies[0] ?? null;
    return { text: last?.text ?? "", progress: r.item.status === "running" ? p.progress : null, question: null,
      reply: last ? { runId: last.runId, messageId: last.messageId, at: last.at } : null };
  }
  async replies(id: string): Promise<PastReply[]> { this.fresh(); return this.row(id).chat.projection.replies.map((r) => ({ ...r })); }
  async firstAsk(id: string): Promise<FirstAsk | null> {
    this.fresh();
    const r = this.row(id);
    return r.chat.first ? firstAsk(r.chat.first, new Date(r.chat.meta!.createdAtMs).toISOString(), true) : null;
  }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  async check(action: Action): Promise<string | null> { return this.preflight(action); }
  private preflight(action: Action): string | null {
    if (this.closed || this.closing || !this.loaded) return "Cursor chats aren't loaded right now.";
    this.scan();
    const policy = this.opts.policy;
    if (!policy.cursor) return "Cursor chats are disabled on this machine.";
    if (!allows(policy, action.kind, "cursor")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      const root = this.roots.get(action.placeId);
      if (!root) return "That project isn't visible to 10 & 2.";
      if (action.model !== undefined && !this.models.some((m) => m.id === action.model)) return "Cursor doesn't offer that model now.";
      if (action.profile.workspace === "worktree" && existsSync(join(root, ".cursor", "worktrees")) && !visible(policy, join(root, ".cursor", "worktrees"))) return "That project's worktree folder is outside 10 & 2's visible folders.";
      if (!withinCeiling(policy, action.profile, "cursor")) return "That profile asks for more than this computer allows.";
      if (!modeFlags(action.profile.runtimeMode)) return NO_ASK;
      return null;
    }
    const row = this.rows.get(action.itemId);
    if (!row) return "That chat isn't visible to 10 & 2.";
    if (action.kind === "snooze" && !Number.isFinite(Date.parse(action.until))) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.followUpRefusal(action.itemId, row);
    return null;
  }
  private followUpRefusal(id: string, row: Row): string | null {
    if (this.store.run(id)) return "10 & 2 is already running that chat, or can't yet tell that its last run ended.";
    if (row.open) return OPEN;
    if (!modeFlags(ceilingFor(this.opts.policy, "cursor"))) return NO_ASK;
    if (!existsSync(row.cwd)) return "That chat's folder isn't on this computer anymore.";
    return null;
  }
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", "cursor")) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) { const why = this.followUpRefusal(id, row); if (why) out[id] = { follow_up: why }; }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed || this.closing) return { ok: false, error: "Cursor adapter is closed." };
    const digest = hash(JSON.stringify(action));
    const prior = this.repeat(key, digest);
    if (prior) return prior;
    const why = this.preflight(action);
    if (why) return { ok: false, error: why };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind, new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.repeat(key, digest) ?? { ok: false, error: "That operation key was already used." };
      this.scan(); return receipt;
    }
    if (action.kind === "follow_up") {
      if (!this.store.begin(key, digest, action.itemId)) return this.repeat(key, digest) ?? { ok: false, error: "10 & 2 is already running that chat." };
      return this.tracked(this.launch(action, key, action.itemId, this.rows.get(action.itemId)!.cwd));
    }
    return this.tracked(this.startWork(action, key, digest));
  }
  private repeat(key: string, digest: string): Receipt | null {
    const prior = this.store.operation(key);
    if (!prior) return null;
    return prior.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : prior.receipt ? JSON.parse(prior.receipt) : UNKNOWN;
  }
  private async tracked(pending: Promise<Receipt>): Promise<Receipt> {
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }

  /** New work: a chat made first (`cursor-agent create-chat`, no model call), so its id is known before anything runs. */
  private async startWork(action: Extract<Action, { kind: "start_work" }>, key: string, digest: string): Promise<Receipt> {
    if (!this.store.begin(key, digest)) return this.repeat(key, digest) ?? UNKNOWN;
    let cwd = this.roots.get(action.placeId)!;
    if (action.profile.workspace === "worktree") {
      try { cwd = await addWorktree(cwd, join(".cursor", "worktrees"), hash(key).slice(0, 12), this.opts.policy.worktreeBase ?? "HEAD"); }
      catch (e) { return this.store.finish(key, { ok: false, error: (e as Error).message }); }
    }
    let id: string;
    try { id = await createChat(this.command, cwd, this.childEnv()); }
    catch { return this.store.finish(key, { ok: false, error: "Cursor couldn't be started. Check that it's installed and signed in on this machine." }); }
    this.store.db.prepare("INSERT OR IGNORE INTO claude_runs(sessionId) VALUES(?)").run(id);
    return this.launch(action, key, id, cwd);
  }

  /**
   * A turn of a chat nothing has open, or of new work: a detached `cursor-agent -p --resume <id>` that carries on if the
   * connector stops. It counts as sent once the chat's transcript records the words as a new user message.
   */
  private async launch(action: Extract<Action, { kind: "start_work" | "follow_up" }>, key: string, id: string, cwd: string): Promise<Receipt> {
    const starting = action.kind === "start_work";
    const ceiling = ceilingFor(this.opts.policy, "cursor");
    // A follow-up runs as the chat last ran, never above the ceiling; new work as its profile asks.
    const mode: RuntimeMode = starting ? action.profile.runtimeMode : lower(chatSettings(join(this.chatsDir, bucketOf(cwd), id)).runtimeMode ?? ceiling, ceiling);
    const flags = modeFlags(mode) ?? [];
    const before = this.chats.get(id)?.projection.asks ?? 0;
    const args = runArgs({ id, flags, plan: starting && action.profile.interactionMode === "plan", model: starting ? action.model : undefined });
    const token = hash(key).slice(0, 24), out = join(this.opts.stateDir, `${token}.out.log`), err = join(this.opts.stateDir, `${token}.err.log`);
    const finish = (receipt: Receipt): Receipt => {
      const saved = this.store.finish(key, receipt);
      if (receipt.ok || !receipt.unknown) { for (const f of [out, err]) { try { unlinkSync(f); } catch { /* pruned at startup */ } } }
      this.scan();
      return saved;
    };
    let outFd: number, errFd: number;
    try { outFd = openSync(out, "wx", 0o600); errFd = openSync(err, "wx", 0o600); }
    catch { this.store.ended(id); return finish({ ok: false, error: "10 & 2 couldn't create a private run log." }); }
    const [command, ...prefix] = this.command as [string, ...string[]];
    let child: ChildProcess;
    try {
      child = spawnCommand(command, [...prefix, ...args], { cwd, detached: true, env: this.childEnv(), stdio: ["pipe", outFd, errFd] });
    } catch {
      closeSync(outFd); closeSync(errFd); this.store.ended(id);
      return finish({ ok: false, error: "10 & 2 couldn't start Cursor on this machine." });
    }
    closeSync(outFd); closeSync(errFd);
    const pid = child.pid;
    if (pid) this.store.started(id, pid, procStart(pid)); else this.store.ended(id);
    let failed = false, code: number | null | undefined;
    child.on("error", () => { failed = true; if (!this.closed) this.store.ended(id); });
    child.on("exit", (c) => { code = c; if (!this.closed && pid) { this.store.ended(id, pid); this.schedule(); } });
    // The words go on stdin, so they never show in a process list.
    child.stdin!.on("error", () => {});
    child.stdin!.end(action.message);
    child.unref();
    const deadline = Date.now() + (this.opts.acceptanceTimeoutMs ?? 30_000);
    const words = action.message.trim();
    while (Date.now() < deadline) {
      let chat = this.chats.get(id);
      if (!chat) { const dir = join(this.chatsDir, bucketOf(cwd), id); chat = new CursorChat(id, dir); this.chats.set(id, chat); }
      chat.read(this.dataDir);
      if (chat.asksSince(before).includes(words)) return finish(starting ? { ok: true, itemId: id } : { ok: true });
      if (failed) return finish({ ok: false, error: "Cursor couldn't be started. Check that it's installed on this machine." });
      if (code !== undefined && code !== 0) return finish({ ok: false, error: "Cursor stopped before taking that. Check that it's signed in on this machine." });
      await new Promise((r) => setTimeout(r, code === undefined ? 100 : 200));
    }
    return finish(UNKNOWN);
  }

  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      if (this.rescan) clearInterval(this.rescan);
      if (this.debounce) clearTimeout(this.debounce);
      if (this.modelsTimer) clearInterval(this.modelsTimer);
      for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
      await Promise.allSettled([...this.writes]);
      this.closed = true; this.loaded = false; this.listeners.clear();
      this.store.close();
    })();
    return this.shutdown;
  }
}

const ORDER: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const lower = (a: RuntimeMode, b: RuntimeMode): RuntimeMode => (ORDER.indexOf(a) < ORDER.indexOf(b) ? a : b);

/** A title from the first words, when the chat has none: its first line, cut at a word to about 60 characters. */
export function shortTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30))}…`;
}
