// Pi (the `pi` coding agent, measured on 1.5.1): its sessions, read from their files; what an open Pi is doing, from
// 10 & 2's Pi extension (extensions/pi/10and2.ts, `10and2 pi install`); follow-ups through that extension's socket to a
// session that's open, and headless turns (`10and2 pi-turn`) for one nothing has open and for new work.
import { watch, existsSync, readdirSync, readFileSync, statSync, mkdirSync, openSync, closeSync, readSync, unlinkSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Action, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, answers, steers, visible, withinCeiling } from "../policy.ts";
import type { Policy } from "../policy.ts";
import { addWorktree, folderOf, gitRoot, group } from "../work.ts";
import { Store } from "../claude/store.ts";
import { pidState, procStart } from "../claude/registry.ts";
import { answersFor } from "../claude/adapter.ts";
import { PiSession, textOf } from "./session.ts";
import { piSessionId, readRegistry, talk } from "./bridge.ts";
import type { Live } from "./bridge.ts";
import { MARKER, installedPath, piAgentDir } from "./extension.ts";
import { NOT_STARTED } from "./turn.ts";
import type { Turn } from "./turn.ts";

export type Options = {
  policy: Policy; db: string; stateDir: string; log: (m: string) => void; now?: () => number;
  /** Pi's agent folder ($PI_CODING_AGENT_DIR, else ~/.pi/agent). */
  agentDir?: string;
  /** Where Pi keeps sessions ($PI_CODING_AGENT_SESSION_DIR, the `sessionDir` setting, else <agentDir>/sessions). */
  sessionsDir?: string;
  /** How long inactive sessions remain in the briefing. Open ones are always included. */
  days?: number;
  /** Tests and slow machines can adjust the bounded acceptance wait; never causes a resend. */
  acceptanceTimeoutMs?: number;
  /** How old a scan reads may reuse (1 s); file events and the periodic rescan keep it current. Tests use 0. */
  readCacheMs?: number;
  /** The `pi` command (on PATH by default). */
  piBin?: string;
  /** The headless runner: `<nodeBin> <entryScript> pi-turn` (this Node and the connector's own command by default). */
  nodeBin?: string;
  entryScript?: string;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** New work's session id, from its operation key: the same key always names the same session. */
export function sessionForKey(key: string): string {
  const bytes = createHash("sha256").update("driver:pi:start_work:v1\0" + key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Pi's session folder for a working folder: `--<path without its leading separator, / \ : as ->--`. */
export const sessionFolder = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
/** A title from the first words, when the session has no name: its first line, cut at a word to about 60 characters. */
export function shortTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30))}…`;
}

/** How much of a new session file is read before deciding whether it's one Driver lists (its header says where it ran). */
const HEAD_BYTES = 64 * 1024;
const UNKNOWN: Receipt = { ok: false, unknown: true, error: "I can't tell whether Pi received that. Driver won't send it again." };
const NO_STEERING = "It's open in Pi, and this computer doesn't let Driver send to open sessions.";
const NO_ANSWERING = "It's waiting for an answer in Pi, and this computer doesn't let Driver answer.";
const OTHER_DIALOG = "It's waiting for an answer in Pi that Driver can't give. Answer it in Pi.";
const NO_FULL_ACCESS_START = "Pi runs its tools without asking, so this computer's settings don't allow starting it.";
const NO_FULL_ACCESS_CONTINUE = "Pi runs its tools without asking, so this computer's settings don't allow continuing it while it's closed.";
const NO_EXTENSION = "Driver can't tell whether that session is open in Pi. Running 10and2 pi install on this computer fixes that.";
const UNREACHABLE = "Driver couldn't reach that session. Is it still open?";

type Row = { session: PiSession | null; cwd: string; live: Live | null; item: WorkItem };

export class PiAdapter implements Adapter {
  readonly name = "pi";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  readonly agentDir: string;
  readonly sessionsDir: string;
  private readonly opts: Options;
  private readonly store: Store;
  private readonly now: () => number;
  private loaded = false;
  private closed = false;
  private closing = false;
  private shutdown: Promise<void> | null = null;
  private readers = new Map<string, PiSession>();
  /** Files left out on their header (another folder, not a session), with the inode they had. */
  private skipped = new Map<string, number | bigint>();
  private rows = new Map<string, Row>();
  private roots = new Map<string, string>();
  private keys = new Map<string, string>();
  private questions = new Map<string, string | null>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private rescan: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private writes = new Set<Promise<Receipt>>();
  private extension = false;
  private scannedAt = 0;

  constructor(opts: Options) {
    this.opts = opts; this.now = opts.now ?? Date.now;
    this.agentDir = resolve(opts.agentDir ?? piAgentDir());
    this.sessionsDir = resolve(opts.sessionsDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? this.settingsSessionDir() ?? join(this.agentDir, "sessions"));
    this.store = new Store(opts.db);
  }
  /** The `sessionDir` setting in Pi's settings.json, when it names one. */
  private settingsSessionDir(): string | null {
    try {
      const dir = JSON.parse(readFileSync(join(this.agentDir, "settings.json"), "utf8"))?.sessionDir;
      if (typeof dir !== "string" || !dir.trim()) return null;
      const home = homedir();
      const expanded = dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
      // Pi reads a relative one from wherever it starts; there's no one folder to read then.
      return isAbsolute(expanded) ? expanded : null;
    } catch { return null; }
  }

  /** The runner's (and so Pi's) environment: its own, naming the folders Driver reads when they aren't Pi's defaults. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.agentDir !== resolve(piAgentDir(process.env))) env.PI_CODING_AGENT_DIR = this.agentDir;
    if (this.opts.sessionsDir) env.PI_CODING_AGENT_SESSION_DIR = this.sessionsDir;
    return env;
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) throw new Error("Pi adapter is closed");
    if (this.loaded) return;
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    // A crash between reservation and spawn leaves no runner to wait for; its operation stays unknown, never resent.
    for (const run of this.store.runs()) if (run.pid === null) this.store.ended(run.sessionId);
    for (const name of readdirSync(this.opts.stateDir)) {
      if (!/^[a-f0-9]{24}\.stderr\.log$/.test(name)) continue;
      const path = join(this.opts.stateDir, name);
      try { if (statSync(path).mtimeMs < this.now() - 7 * 86_400_000) unlinkSync(path); }
      catch { /* An old log that can't be removed mustn't stop startup. */ }
    }
    this.scan(); this.loaded = true;
    this.rescan = setInterval(() => this.safeScan(), 30_000); this.rescan.unref();
  }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean {
    return this.loaded && !this.closed && !this.closing && this.opts.policy.pi && (existsSync(this.sessionsDir) || existsSync(join(this.agentDir, "10and2")));
  }
  private schedule = () => {
    if (this.closed || this.closing || this.debounce) return;
    // A running Pi appends to its session as each message ends; one scan covers a burst.
    this.debounce = setTimeout(() => { this.debounce = null; this.safeScan(); }, 250); this.debounce.unref();
  };
  /** Reads use the last scan when it's under a second old; file events and the periodic rescan keep it current. */
  private fresh() { if (Date.now() - this.scannedAt >= (this.opts.readCacheMs ?? 1000)) this.scan(); }
  private safeScan() { if (!this.closed) { try { this.scan(); } catch { this.opts.log("pi: local scan failed; will retry"); } } }

  /** Session files at both levels: `sessions/--<cwd>--/*.jsonl`, and older ones directly in `sessions/`. */
  private sessionFiles(wanted: Set<string>): string[] {
    const files: string[] = [];
    try {
      for (const d of readdirSync(this.sessionsDir, { withFileTypes: true })) {
        const p = join(this.sessionsDir, d.name);
        if (d.isFile() && d.name.endsWith(".jsonl")) files.push(p);
        else if (d.isDirectory()) {
          wanted.add(p);
          try { for (const f of readdirSync(p, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(p, f.name)); }
          catch { /* gone meanwhile */ }
        }
      }
    } catch { /* No sessions yet: the periodic scan finds them. */ }
    return files;
  }

  private scan(): void {
    if (this.closed) return;
    this.scannedAt = Date.now();
    const policy = this.opts.policy;
    const live = readRegistry(this.agentDir);
    for (const run of this.store.runs()) if (run.pid && pidState(run.pid, run.procStart) === "dead") this.store.ended(run.sessionId, run.pid);
    this.extension = (() => { try { return readFileSync(installedPath(this.agentDir), "utf8").startsWith(MARKER); } catch { return false; } })();
    const wanted = new Set<string>([this.agentDir, this.sessionsDir, join(this.agentDir, "10and2")]);
    const cutoff = this.now() - (this.opts.days ?? 14) * 86_400_000;
    const paths = new Set<string>();
    for (const path of this.sessionFiles(wanted)) {
      // `<timestamp>_<id>.jsonl`: the timestamp has no underscore.
      const name = basename(path, ".jsonl"), id = name.slice(name.indexOf("_") + 1);
      try {
        const st = statSync(path);
        if (st.mtimeMs < cutoff && !live.has(id) && !this.store.run(id)) continue;
        if (this.skipped.get(path) === st.ino) continue;
      } catch { continue; }
      paths.add(path);
    }
    // An open session's file can be somewhere else (`--session-dir`); it's read wherever it is.
    for (const l of live.values()) if (l.sessionFile && existsSync(l.sessionFile)) paths.add(l.sessionFile);
    for (const path of this.readers.keys()) if (!paths.has(path)) this.readers.delete(path);
    for (const path of this.skipped.keys()) if (!existsSync(path)) this.skipped.delete(path);
    const candidates = new Map<string, PiSession>();
    for (const path of paths) {
      let reader = this.readers.get(path);
      if (!reader) {
        // Sessions can be hundreds of MB. The header says where it ran, so one Driver may not see is read no further.
        reader = new PiSession(path);
        reader.read(HEAD_BYTES);
        if (reader.offset > 0 && (reader.invalid || (reader.cwd !== null && !visible(policy, reader.cwd)))) {
          try { this.skipped.set(path, statSync(path).ino); } catch { /* gone: the next scan drops it */ }
          continue;
        }
      }
      this.readers.set(path, reader); reader.read();
      if (!reader.id || !piSessionId(reader.id)) continue;
      const prior = candidates.get(reader.id);
      if (!prior || reader.mtime > prior.mtime) candidates.set(reader.id, reader);
    }
    const ids = new Set<string>([...candidates.keys(), ...live.keys()]);
    const next = new Map<string, Row>();
    for (const id of ids) {
      const session = candidates.get(id) ?? null, l = live.get(id) ?? null;
      const cwd = session?.cwd ?? l?.cwd;
      if (!policy.pi || !cwd || !visible(policy, cwd) || (l && !visible(policy, l.cwd))) continue;
      const overlay = this.store.overlay(id);
      if (overlay.archived) continue;
      const p = session?.projection ?? null;
      const run = this.store.run(id);
      const pending = !!l && (l.status === "waiting" || l.questions.length > 0);
      const busy = l?.status === "busy" || (!l && !!run?.pid);
      const updatedAt = [p?.updatedAt, l?.updatedAt].filter((x): x is string => !!x).sort().at(-1) ?? session?.mtime ?? new Date(this.now()).toISOString();
      if (!l && !run && Date.parse(updatedAt) < cutoff) continue;
      const questionId = !pending ? null : l!.questions[0]?.questionId ?? hash(id + (l!.prompt?.since ?? l!.updatedAt ?? "waiting")).slice(0, 16);
      const lastRunAt = p?.lastRunAt ?? null;
      const newer = (at: string | null) => !!at && !!lastRunAt && lastRunAt > at;
      const title = session?.name ?? l?.name ?? (session?.firstPrompt ? shortTitle(session.firstPrompt) : null) ?? `a Pi session in ${group(cwd)}`;
      const item: WorkItem = {
        id, title: title || `a Pi session in ${group(cwd)}`, group: group(cwd),
        status: pending ? "waiting" : busy ? "running" : p?.status ?? "idle",
        updatedAt, settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !pending && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: pending, questionId, lastRunAt, wroteAt: p?.wroteAt ?? null,
      };
      next.set(id, { session, cwd, live: l, item });
    }
    this.rows = next;
    this.roots.clear();
    for (const row of next.values()) {
      const root = gitRoot(row.cwd);
      // A visible subfolder must not grant a launch into its hidden repository parent.
      if (root && visible(policy, root)) this.roots.set(hash(root).slice(0, 12), root);
    }
    const changed: string[] = []; let urgent = false;
    for (const [id, row] of next) {
      const w = row.item, reply = row.session?.projection.replies[0];
      const key = JSON.stringify([w.status, w.title, w.settled, w.snoozedUntil, w.questionId, w.lastRunAt, reply?.messageId, reply?.text]);
      if (this.keys.get(id) !== key) {
        changed.push(id);
        urgent ||= w.pendingQuestion && this.questions.get(id) !== w.questionId;
      }
      this.keys.set(id, key); this.questions.set(id, w.questionId ?? null);
    }
    for (const id of this.keys.keys()) if (!next.has(id)) { changed.push(id); this.keys.delete(id); this.questions.delete(id); }
    if (!this.closing) this.watchPaths(wanted);
    if (changed.length) for (const listener of this.listeners) listener(changed, urgent);
  }
  /** Folders only: a folder's watch reports its files being written as well as created. */
  private watchPaths(wanted: Set<string>) {
    for (const [path, watcher] of this.watchers) if (!wanted.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, this.schedule);
        watcher.on("error", () => { watcher.close(); this.watchers.delete(path); this.schedule(); });
        this.watchers.set(path, watcher);
      } catch { /* Missing paths and exhausted watch limits are covered by the periodic scan. */ }
    }
  }

  places(): Place[] {
    if (!this.loaded || this.closed || !this.opts.policy.pi || !allows(this.opts.policy, "start_work", "pi")) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => gitRoot(r.cwd) === root).map((r) => r.item.updatedAt).sort().at(-1) ?? null }));
  }
  async list(): Promise<WorkItem[]> { this.fresh(); return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.cwd)) throw new Error("That session isn't visible to Driver.");
    return row;
  }
  async report(id: string): Promise<Report> {
    this.fresh();
    const r = this.row(id), p = r.session?.projection, last = p?.replies[0] ?? null, q = r.live?.questions[0];
    const question = !r.item.pendingQuestion ? null
      : q ? `${q.title}${q.options.length ? ` Options: ${q.options.join(" / ")}.` : ""}`
      : r.live?.prompt?.title ?? "Pi needs your input in its terminal.";
    return { text: last?.text ?? "", progress: r.item.status === "running" ? p?.progress ?? null : null, question,
      reply: last ? { runId: last.runId, messageId: last.messageId, at: last.at } : null };
  }
  async replies(id: string): Promise<PastReply[]> { this.fresh(); return (this.row(id).session?.projection.replies ?? []).map((r) => ({ ...r })); }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  async check(action: Action): Promise<string | null> { return this.preflight(action); }
  private preflight(action: Action): string | null {
    if (this.closed || this.closing || !this.loaded) return "Pi sessions aren't loaded right now.";
    this.scan();
    const policy = this.opts.policy;
    if (!policy.pi) return "Pi sessions are disabled on this machine.";
    if (!allows(policy, action.kind, "pi")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      if (action.title?.trimStart().startsWith("-")) return "A session title must not start with a dash.";
      if (!this.roots.has(action.placeId)) return "That project isn't visible to Driver.";
      const worktrees = join(this.roots.get(action.placeId)!, ".pi", "worktrees");
      if (action.profile.workspace === "worktree" && existsSync(worktrees) && !visible(this.opts.policy, worktrees)) return "That project's worktree folder is outside Driver's visible folders.";
      if (action.profile.interactionMode === "plan") return "Pi has no plan mode, so Driver can't start it with a plan first. Choose a profile without one.";
      if (!withinCeiling(policy, { runtimeMode: "full-access" }, "pi")) return NO_FULL_ACCESS_START;
      if (action.profile.runtimeMode !== "full-access") return "Pi runs its tools without asking, so it only starts with a full-access profile.";
      return null;
    }
    const row = this.rows.get(action.itemId);
    if (!row) return "That session isn't visible to Driver.";
    if (action.kind === "snooze" && !Number.isFinite(Date.parse(action.until))) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.followUpRefusal(action.itemId, row);
    return null;
  }
  private followUpRefusal(id: string, row: Row): string | null {
    const policy = this.opts.policy;
    // An open session: the extension's question takes the answer; otherwise its socket takes the words.
    if (row.live) {
      if (row.live.questions.length) return answers(policy, "pi") ? null : NO_ANSWERING;
      if (row.live.status === "waiting") return OTHER_DIALOG;
      return steers(policy, "pi") ? null : NO_STEERING;
    }
    if (this.store.run(id)) return "Driver is already running that session, or can't yet tell that its last run ended.";
    if (!withinCeiling(policy, { runtimeMode: "full-access" }, "pi")) return NO_FULL_ACCESS_CONTINUE;
    // Without the extension an open Pi is invisible, and a second Pi on the session would split it into branches.
    if (!this.extension) return NO_EXTENSION;
    if (!row.session) return "That session has nothing in it yet.";
    if ((row.session.version ?? 0) > 3) return "This session uses a Pi session format Driver doesn't understand yet.";
    if (!existsSync(row.cwd)) return "That session's folder isn't on this computer anymore.";
    return null;
  }
  /** Follow-ups this machine would refuse right now, per session, from the last scan; checked again on execute. */
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", "pi")) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) {
      const why = this.followUpRefusal(id, row);
      if (why) out[id] = { follow_up: why };
    }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed || this.closing) return { ok: false, error: "Pi adapter is closed." };
    const digest = hash(JSON.stringify(action));
    const prior = this.repeat(key, digest);
    if (prior) return prior;
    const why = await this.check(action);
    if (why) return { ok: false, error: why };
    // Another call may have reserved this key while preflight yielded. Its outcome is never a second dispatch.
    const reserved = this.repeat(key, digest);
    if (reserved) return reserved;
    // Checked again, with what's on disk now: the session may have been opened or closed while that yielded. What
    // follows uses this same scan.
    const changed = this.preflight(action);
    if (changed) return { ok: false, error: changed };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind,
        new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.execute(action, key);
      this.scan(); return receipt;
    }
    if (action.kind === "follow_up") {
      const live = this.rows.get(action.itemId)?.live;
      if (live) {
        const q = live.questions[0];
        if (q) return answers(this.opts.policy, "pi") ? this.tracked(this.answer(action, key, digest, live, q)) : { ok: false, error: NO_ANSWERING };
        if (live.status === "waiting") return { ok: false, error: OTHER_DIALOG };
        if (!steers(this.opts.policy, "pi")) return { ok: false, error: NO_STEERING };
        return this.tracked(this.steer(action, key, digest, live));
      }
    }
    const id = action.kind === "start_work" ? sessionForKey(key) : action.itemId;
    if (this.store.run(id)) return { ok: false, error: "Driver is already running that session." };
    if (!this.store.begin(key, digest, id)) return this.repeat(key, digest) ?? { ok: false, error: "Driver is already running that session." };
    return this.tracked(this.launch(action, key, id));
  }
  /** The outcome of an operation key used before, or null for a new one. */
  private repeat(key: string, digest: string): Receipt | null {
    const prior = this.store.operation(key);
    if (!prior) return null;
    return prior.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : prior.receipt ? JSON.parse(prior.receipt) : UNKNOWN;
  }
  private async tracked(pending: Promise<Receipt>): Promise<Receipt> {
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }

  /** Words to a session open in Pi, as if typed there: a new turn when it's idle, a steer between its steps when busy. */
  private async steer(action: Extract<Action, { kind: "follow_up" }>, key: string, digest: string, live: Live): Promise<Receipt> {
    if (!this.store.begin(key, digest)) return this.repeat(key, digest) ?? UNKNOWN;
    const r = await talk(live.socket, { id: randomUUID(), type: "user", text: action.message, deliverAs: "steer" }, this.opts.acceptanceTimeoutMs ?? 5000);
    this.schedule();
    // The extension's ack is Pi itself saying it took the words.
    if (r === "unreachable") return this.store.finish(key, { ok: false, error: UNREACHABLE });
    if (r === "silent") return this.store.finish(key, { ok: false, unknown: true, error: "That session didn't confirm the message. Driver won't send it again." });
    if (r.type === "ack") return this.store.finish(key, { ok: true });
    return this.store.finish(key, { ok: false, error: "That session didn't take the message." });
  }

  /** The answer to a question the extension asked: the option the user named, else their own words. */
  private async answer(action: Extract<Action, { kind: "follow_up" }>, key: string, digest: string, live: Live, q: Live["questions"][number]): Promise<Receipt> {
    if (!this.store.begin(key, digest)) return this.repeat(key, digest) ?? UNKNOWN;
    const value = answersFor([{ question: q.title, options: q.options, multiSelect: false }], action.message)[q.title]!;
    const r = await talk(live.socket, { id: randomUUID(), type: "answer", questionId: q.questionId, value }, this.opts.acceptanceTimeoutMs ?? 5000);
    this.schedule();
    if (r === "unreachable") return this.store.finish(key, { ok: false, error: UNREACHABLE });
    if (r === "silent") return this.store.finish(key, { ok: false, unknown: true, error: "Pi may have had its answer already. Driver won't send it again." });
    if (r.type === "ack") return this.store.finish(key, { ok: true });
    return this.store.finish(key, { ok: false, error: "That question was already answered in Pi." });
  }

  /**
   * A turn of a session nothing has open, or new work, in a detached `10and2 pi-turn` (turn.ts), which carries on if the
   * connector stops. It counts as sent once the session's file records the user's words after where it ended before.
   */
  private async launch(action: Extract<Action, { kind: "start_work" | "follow_up" }>, key: string, id: string): Promise<Receipt> {
    const starting = action.kind === "start_work";
    const row = starting ? null : this.rows.get(id);
    let cwd = starting ? this.roots.get(action.placeId) : row?.cwd;
    // A worktree profile's new work runs in a fresh worktree inside the project, from the policy's `worktreeBase`.
    if (starting && cwd && action.profile.workspace === "worktree") {
      try { cwd = await addWorktree(cwd, join(".pi", "worktrees"), hash(key).slice(0, 12), this.opts.policy.worktreeBase ?? "HEAD"); }
      catch (e) { this.store.ended(id); return this.store.finish(key, { ok: false, error: (e as Error).message }); }
    }
    const sessionPath = row?.session?.path ?? null;
    let baseline = 0;
    if (sessionPath) { try { baseline = statSync(sessionPath).size; } catch { /* gone: everything in it is new */ } }
    if (!cwd || (!starting && !sessionPath)) { this.store.ended(id); return this.store.finish(key, { ok: false, error: "That session isn't visible to Driver." }); }
    const turn: Turn = { pi: this.opts.piBin ?? "pi", cwd, message: action.message,
      ...(starting ? { sessionId: id, ...(action.title ? { name: action.title } : {}) } : { session: sessionPath! }) };
    const token = hash(key).slice(0, 24), stderrPath = join(this.opts.stateDir, `${token}.stderr.log`);
    const finish = (receipt: Receipt): Receipt => {
      const saved = this.store.finish(key, receipt);
      if (receipt.ok || !receipt.unknown) { try { unlinkSync(stderrPath); } catch { /* A later startup prunes it. */ } }
      this.scan();
      return saved;
    };
    let err: number;
    try { err = openSync(stderrPath, "wx", 0o600); }
    catch { this.store.ended(id); return finish({ ok: false, error: "Driver couldn't create a private run log." }); }
    let child: ChildProcess;
    try {
      child = spawn(this.opts.nodeBin ?? process.execPath, [this.opts.entryScript ?? process.argv[1]!, "pi-turn"], { cwd, detached: true, env: this.childEnv(), stdio: ["pipe", "ignore", err] });
    } catch {
      closeSync(err); this.store.ended(id);
      return finish({ ok: false, error: "Driver couldn't start Pi on this machine." });
    }
    closeSync(err);
    const pid = child.pid;
    if (pid) this.store.started(id, pid, procStart(pid)); else this.store.ended(id);
    let failed = false, code: number | null | undefined;
    child.on("error", () => { failed = true; if (!this.closed) this.store.ended(id); });
    child.on("exit", (c) => { code = c; if (!this.closed && pid) { this.store.ended(id, pid); this.schedule(); } });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify(turn) + "\n");
    child.unref();
    const deadline = Date.now() + (this.opts.acceptanceTimeoutMs ?? 15_000);
    let lines: Lines | null = sessionPath ? new Lines(sessionPath, baseline) : null;
    while (Date.now() < deadline) {
      if (!lines) { const path = this.findSession(id, cwd); if (path) lines = new Lines(path); }
      for (const r of lines?.read() ?? []) {
        if (r?.type === "message" && r.message?.role === "user" && textOf(r.message.content).trim() === action.message.trim()) {
          return finish(starting ? { ok: true, itemId: id } : { ok: true });
        }
      }
      if (failed || code === NOT_STARTED) return finish({ ok: false, error: "Pi couldn't be started. Check that it's installed on this machine." });
      // Even after the runner exits, keep reading until the deadline: the file is the only evidence.
      await new Promise((r) => setTimeout(r, code === undefined ? 25 : 40));
    }
    return finish(UNKNOWN);
  }
  /** New work's session file: under its folder's session folder, or anywhere in the sessions folder. */
  private findSession(id: string, cwd: string): string | null {
    const suffix = `_${id}.jsonl`;
    for (const dir of [join(this.sessionsDir, sessionFolder(cwd)), this.sessionsDir]) {
      try { const f = readdirSync(dir).find((n) => n.endsWith(suffix)); if (f) return join(dir, f); } catch { /* not there */ }
    }
    try {
      for (const d of readdirSync(this.sessionsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = readdirSync(join(this.sessionsDir, d.name)).find((n) => n.endsWith(suffix));
        if (f) return join(this.sessionsDir, d.name, f);
      }
    } catch { /* not yet */ }
    return null;
  }

  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      if (this.rescan) clearInterval(this.rescan);
      if (this.debounce) clearTimeout(this.debounce);
      for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
      // Finish acceptance bookkeeping; a headless turn itself stays detached and carries on.
      await Promise.allSettled([...this.writes]);
      this.closed = true; this.loaded = false; this.listeners.clear();
      this.store.close();
    })();
    return this.shutdown;
  }
}

/** A bounded incremental line reader used only during acceptance; it keeps no records. */
class Lines {
  private readonly path: string;
  private offset: number;
  private tail = Buffer.alloc(0);
  constructor(path: string, offset = 0) { this.path = path; this.offset = offset; }
  read(): any[] {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return []; }
    try {
      const buffer = Buffer.alloc(64 * 1024), out: any[] = [];
      let n: number;
      while ((n = readSync(fd, buffer, 0, buffer.length, this.offset)) > 0) {
        this.offset += n; const bytes = Buffer.concat([this.tail, buffer.subarray(0, n)]);
        let pos = 0, end: number;
        while ((end = bytes.indexOf(10, pos)) !== -1) {
          try { out.push(JSON.parse(bytes.subarray(pos, end).toString("utf8"))); } catch { /* partial or irrelevant */ }
          pos = end + 1;
        }
        this.tail = Buffer.from(bytes.subarray(pos));
        if (this.tail.length > 16 * 1024 * 1024) this.tail = Buffer.alloc(0);
      }
      return out;
    } finally { closeSync(fd); }
  }
}
