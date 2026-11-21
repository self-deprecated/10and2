import { watch, existsSync, readdirSync, readFileSync, statSync, mkdirSync, openSync, closeSync, readSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import type { Action, ActionKind, Adapter, FirstAsk, CodingModel, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, answers, ceilingFor, steers, visible, withinCeiling } from "../policy.ts";
import type { Policy, RuntimeMode } from "../policy.ts";
import { iso, pidState, procStart, readRegistry, registrySnapshot, sessionId, versionAtLeast } from "./registry.ts";
import { modelKey } from "../util.ts";
import type { Live } from "./registry.ts";
import { Transcript, projectFolder, t3Cwd, typedUser } from "./transcript.ts";
import { Store } from "./store.ts";
import { firstAsk, folderOf, gitRoot, group } from "../work.ts";
import { attestedMode, envelope, heldFor, peerToken, post } from "./inbox.ts";
import { execFileCommand, spawnCommand, which } from "../command.ts";
import { proof, randomHex, replaceFile } from "../util.ts";
import { asked } from "./transcript.ts";
import type { Asked } from "./transcript.ts";
import type { Socket } from "node:net";

export type Options = {
  configDir?: string; policy: Policy; db: string; stateDir: string; log: (m: string) => void; now?: () => number;
  /** How to run Claude Code: `claude` on PATH, or a program and its first arguments (`[node, fake.mjs]` in tests). */
  claudeCommand?: string[];
  /** How long inactive sessions remain in the briefing. Live holders are always included. */
  days?: number;
  /** Tests and slow machines can adjust the bounded acceptance wait; never causes a resend. */
  acceptanceTimeoutMs?: number;
  /** How old a scan reads may reuse (1 s); file events and the periodic rescan keep it current. Tests use 0. */
  readCacheMs?: number;
  /**
   * Local override for isolated installations/tests; defaults to the standard runtime socket, or on Windows a pipe with a
   * new random name at each start. On Windows the adapter writes the pipe's name to hooks.pipe in `stateDir`.
   */
  hookSocketPath?: string;
  /** False keeps starts and follow-ups headless (`claude -p`) even where background sessions are available. */
  background?: boolean;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function sessionForKey(key: string): string {
  const bytes = createHash("sha256").update("driver:claude:start_work:v1\0" + key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/**
 * A project's place id, from its checkout's folder. Windows folders ignore case, and a session started from another
 * shell can record `c:\` for `C:\`, so there it's the same place whatever the case.
 */
export const placeId = (root: string, platform: NodeJS.Platform = process.platform) => hash(platform === "win32" ? root.toLowerCase() : root).slice(0, 12);
export const permissionMode = (mode: RuntimeMode): string => ({ "approval-required": "default", "auto-accept-edits": "acceptEdits", auto: "auto", "full-access": "bypassPermissions" })[mode];
/** How much each Claude Code permission mode lets a run do unasked. `plan` changes nothing; `dontAsk` refuses what isn't pre-approved. */
const REACH: Record<string, number> = { plan: 0, default: 1, dontAsk: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
/**
 * What a follow-up resumes a session with: the mode it last ran with, never more than this machine's ceiling. Null when
 * the session doesn't say (or says something unknown), so Driver never guesses a mode for someone else's session.
 */
export function resumeMode(session: string | null, ceiling: RuntimeMode): string | null {
  if (session === null || !(session in REACH)) return null;
  const cap = permissionMode(ceiling);
  return REACH[session]! <= REACH[cap]! ? session : cap;
}

/** How much of a new transcript is read before deciding whether it's one Driver lists at all. */
const HEAD_BYTES = 512 * 1024;
const UNKNOWN: Receipt = { ok: false, unknown: true, error: "I can't tell whether Claude received that. 10 & 2 won't send it again." };
/** A live session without an inbox: Claude Code before 2.1.224, or one started bare. */
const HELD = "It's open in a terminal in an older Claude Code, so 10 & 2 can't send to it. Updating Claude Code fixes that.";
/** A live session 10 & 2 can't reach (Windows: run as administrator, or another account's): never resumed beside it. */
const FOREIGN = "It's open where 10 & 2 can't reach it, such as an administrator terminal. Answer it there.";
/** Why a session that's open, but with no inbox 10 & 2 can use, takes no follow-up. */
const unreachable = (live: Live[]) => live.some((l) => l.foreign) ? FOREIGN : HELD;
/** A live session, on a machine whose policy doesn't let Driver steer open sessions. */
const NO_STEERING = "It's open in a terminal, and this computer doesn't let 10 & 2 send to open sessions.";
const NOT_DELIVERED = "That session didn't take the message. 10 & 2 won't send it again.";
/** A session on Windows whose inbox key 10 & 2 can't find: its inbox would drop the message unread. */
const NO_KEY = "That session wouldn't take a message from 10 & 2, so nothing was sent. Try reopening it in Claude Code.";
const NOT_INSTALLED = "Claude couldn't be started. Check that it's installed on this machine.";
const AWAITING_OK = "It's waiting for your OK in that session's terminal. 10 & 2 won't send it again.";
/**
 * An open AskUserQuestion that 10 & 2's PermissionRequest hook is holding for Driver (hooks.ts): the terminal shows the
 * question meanwhile, and whichever answers first wins. The hook gets the answers as one JSON line, then exits.
 */
type Ask = { socket: Socket; heldAt: string } & ({ questions: Asked[]; plan?: undefined } | { plan: string; questions?: undefined });
/** Words that let a plan go ahead as it is: a short yes, with nothing asking for a change. */
export const goAhead = (words: string) => words.trim().length <= 60
  && /^(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|approve|approved|proceed|sounds good|looks good|ship it|that works|go for it|let's go|start)\b/i.test(words.trim())
  && !/\b(but|except|change|instead|first|wait|don't|not)\b/i.test(words);
/**
 * The answer to each question from the user's words: an option whose label they said (every one, for a multi-select),
 * or else their words themselves, which Claude Code takes as a typed-in answer.
 */
export function answersFor(questions: Asked[], words: string): Record<string, string> {
  // Words only, so "Milliseconds, please." names "Milliseconds" and "Tabs" isn't found in "establish".
  const plain = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const said = plain(words);
  const out: Record<string, string> = {};
  for (const q of questions) {
    const named = q.options.filter((o) => plain(o).trim() !== "" && said.includes(plain(o)));
    const exact = q.options.find((o) => plain(o) === said);
    out[q.question] = exact ?? (q.multiSelect && named.length ? named.join(", ") : named.length === 1 ? named[0]! : words);
  }
  return out;
}
type Row = { transcript: Transcript; cwd: string; live: Live[]; item: WorkItem };

/** How often Claude Code's models are read again besides at start: they change with its releases. */
const MODELS_MS = 6 * 3600_000;
/** How soon after a read that failed, doubling while they fail, to `MODELS_MS`: until one works, none to choose. */
const MODELS_RETRY_MS = 5 * 60_000;
const NO_SUCH_MODEL = "Claude Code doesn't offer that model now.";

/**
 * The models a new session can start on, from Claude Code's `/model` list (`initialize`'s `models`): not "default"
 * (its own, which a start with no model gets), each named as it's said ("Claude Opus 5.5", from the model it resolves
 * to, a date never read as a version), else as Claude Code shows it; once per name, the plain value before one with a
 * suffix ("[1m]"). The id is what `--model` takes.
 */
export function claudeModels(list: unknown): CodingModel[] {
  const out: CodingModel[] = [];
  const suffixed = (id: string) => /\[[^\]]*\]$/.test(id);
  for (const m of Array.isArray(list) ? list : []) {
    const value = m?.value;
    if (typeof value !== "string" || !value || value === "default" || value.length > 200 || value.trim() !== value) continue;
    const v = typeof m.resolvedModel === "string" ? /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(m.resolvedModel) : null;
    const name = v ? `Claude ${v[1]![0]!.toUpperCase()}${v[1]!.slice(1)} ${v[2]}${v[3] ? `.${v[3]}` : ""}` : typeof m.displayName === "string" ? m.displayName.trim() : "";
    if (!name) continue;
    const same = out.findIndex((o) => modelKey(o.name) === modelKey(name));
    if (same === -1) out.push({ id: value, name });
    else if (suffixed(out[same]!.id) && !suffixed(value)) out[same] = { id: value, name };
  }
  return out;
}

/**
 * Asks a `claude -p` only to initialize, which lists its models without calling one (about 0.3 s), and stops it as soon
 * as it answers, or after `timeoutMs`. Its answer also carries the user's account: only `models` is read, and nothing of
 * it is logged. Null when it doesn't answer. Without the user's hooks and MCP servers: a session they never started
 * mustn't run their SessionStart and SessionEnd hooks, nor wait on them (initialize does), nor start their servers.
 */
export function listClaudeModels(command: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, timeoutMs = 10_000): Promise<CodingModel[] | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const id = randomUUID();
    let done = false, buffer = "";
    let child: ChildProcess | undefined;
    // The adapter's signal lives as long as it does: its listener goes with each read (spawn's own would stay on it
    // for a `claude` that isn't there, which never exits).
    const stop = () => finish(null);
    const finish = (models: CodingModel[] | null) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener("abort", stop); child?.kill(); resolve(models);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [bin = "claude", ...first] = command;
      child = spawnCommand(bin, [...first, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
        "--settings", JSON.stringify({ disableAllHooks: true })], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    } catch { finish(null); return; }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (b: Buffer) => {
      buffer += b.toString();
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let r: any;
        try { r = JSON.parse(line); } catch { continue; }
        if (r?.type === "control_response" && r.response?.request_id === id) return finish(r.response.subtype === "success" ? claudeModels(r.response.response?.models) : null);
      }
      if (buffer.length > 4 << 20) finish(null);
    });
    child.stdin!.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "initialize" } }) + "\n");
  });
}

export class ClaudeAdapter implements Adapter {
  readonly name = "claude";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  readonly configDir: string;
  readonly socketPath: string;
  /**
   * What the hook socket proves itself with, to a hook that sends a nonce first (hooks.ts reach): new at each start, and
   * written beside the pipe's name in hooks.pipe on Windows, where a pipe's name alone proves nothing.
   */
  readonly hookSecret = randomHex();
  private readonly opts: Options;
  private readonly store: Store;
  private readonly now: () => number;
  private loaded = false;
  private closed = false;
  private closing = false;
  private shutdown: Promise<void> | null = null;
  private readers = new Map<string, Transcript>();
  private rows = new Map<string, Row>();
  private roots = new Map<string, string>();
  private keys = new Map<string, string>();
  private questions = new Map<string, string | null>();
  private watchers = new Map<string, FSWatcher>();
  private listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private rescan: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private socket: Server | null = null;
  private ownsSocket = false;
  private writes = new Set<Promise<Receipt>>();
  private collisions = new Set<string>();
  private worktrees = false;
  /** This Claude Code starts background sessions (`claude --bg`), which Driver uses to start and continue work. */
  private background = false;
  /** Open AskUserQuestions held by the hook, by session. */
  private asks = new Map<string, Ask>();
  /** Transcripts left out on their first records, by path, with the inode they had (a new file is read again). */
  private skipped = new Map<string, number | bigint>();
  /** What a new session can start on (`claudeModels`), as Claude Code last said. */
  private models: CodingModel[] = [];
  private modelsTimer: NodeJS.Timeout | null = null;
  /** How long until the next read after one that failed (`MODELS_RETRY_MS`, doubling); the log says so the first time. */
  private modelsRetry = 0;
  /** Stops a models read under way when the adapter closes. */
  private readonly stopping = new AbortController();

  constructor(opts: Options) {
    this.opts = opts; this.now = opts.now ?? Date.now;
    this.configDir = resolve(opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
    this.socketPath = opts.hookSocketPath ?? (process.platform === "win32" ? `\\\\.\\pipe\\10and2-hooks-${randomBytes(16).toString("hex")}`
      : join(process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "10and2") : opts.stateDir, "hooks.sock"));
    this.store = new Store(opts.db);
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) throw new Error("Claude adapter is closed");
    if (this.loaded) return;
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    // A crash between reservation and spawn leaves no pid to track. A child that did start is still
    // protected by its registry holder, and its original operation remains unknown rather than resent.
    for (const run of this.store.runs()) if (run.pid === null) this.store.ended(run.sessionId);
    for (const name of readdirSync(this.opts.stateDir)) {
      if (!/^[a-f0-9]{24}\.(?:stdout\.jsonl|stderr\.log)$/.test(name)) continue;
      const path = join(this.opts.stateDir, name);
      try { if (statSync(path).mtimeMs < this.now() - 7 * 86_400_000) unlinkSync(path); }
      catch { /* A missing or inaccessible old log must not prevent startup. */ }
    }
    // Its models are read beside its version, so the first view has them.
    await Promise.all([this.probeWorktrees(), this.probeModels()]);
    if (this.closed || this.closing) throw new Error("Claude adapter is closed");
    this.scan(); this.loaded = true;
    this.rescan = setInterval(() => this.safeScan(), 30_000); this.rescan.unref();
    await this.listenHooks();
  }
  /**
   * Reads Claude Code's models, keeping the last list when it doesn't answer; the brain is told when they change. Read
   * again in 6 hours, or 5 minutes after a read that failed (a slow start at boot), then 10, 20…, up to 6 hours.
   */
  private async probeModels() {
    if (this.closed || this.closing) return;
    const models = await listClaudeModels(this.opts.claudeCommand ?? ["claude"], this.childEnv(), this.opts.stateDir, this.stopping.signal);
    if (this.closed || this.closing) return;
    if (!models && !this.modelsRetry) this.opts.log("claude: couldn't read Claude Code's models; new work starts on its own");
    this.modelsRetry = models ? 0 : Math.min(this.modelsRetry ? this.modelsRetry * 2 : MODELS_RETRY_MS, MODELS_MS);
    this.modelsTimer = setTimeout(() => void this.probeModels(), this.modelsRetry || MODELS_MS); this.modelsTimer.unref();
    if (!models) return;
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    for (const listener of this.listeners) listener([], false);
  }
  private async probeWorktrees() {
    // Claude Code on Windows is a 370 MB program its antivirus scans as it starts: 3 s wasn't always enough there.
    const timeout = process.platform === "win32" ? 10_000 : 3000;
    const output = (flag: string) => new Promise<string>((resolve) => {
      let command: [string, string[]];
      try { command = this.claude([flag]); } catch { resolve(""); return; }
      execFileCommand(...command, { timeout, maxBuffer: 1024 * 1024, env: this.childEnv() }, (err, stdout) => resolve(err ? "" : stdout));
    });
    const [version, help] = await Promise.all([output("--version"), output("--help")]);
    // Headless worktrees were measured starting at 2.1.310; require the flag as well.
    this.worktrees = versionAtLeast(version.trim().split(/\s+/)[0], "2.1.310") && /--worktree\b/.test(help);
    // Background starts were measured on 2.1.321 (docs/launch/release.md); require the flag as well.
    this.background = this.opts.background !== false && versionAtLeast(version.trim().split(/\s+/)[0], "2.1.321") && /--bg\b/.test(help);
  }
  /**
   * The environment of the `claude` Driver runs: its own, with CLAUDE_CONFIG_DIR only for a folder other than the
   * default. Set even to the default, it moves Claude Code's global settings (trusted folders, MCP servers) from
   * ~/.claude.json to ~/.claude/.claude.json, so a run would lose them, and a background start in a trusted folder be
   * refused as untrusted.
   */
  private childEnv(): NodeJS.ProcessEnv {
    if (process.env.CLAUDE_CONFIG_DIR || this.configDir !== resolve(join(homedir(), ".claude"))) return { ...process.env, CLAUDE_CONFIG_DIR: this.configDir };
    return process.env;
  }
  /**
   * The `claude` command with these arguments, found on PATH now. On Windows a bare name is looked for in the child's
   * folder (a project, which could hold a claude.exe of its own) before PATH, so one that isn't on PATH isn't run at all:
   * it throws ENOENT, as starting it would elsewhere.
   */
  private claude(args: string[]): [string, string[]] {
    const [bin = "claude", ...first] = this.opts.claudeCommand ?? ["claude"];
    const found = process.platform === "win32" ? which(bin, this.childEnv()) : bin;
    if (!found) throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT" });
    return [found, [...first, ...args]];
  }
  private spawnClaude(args: string[], options: SpawnOptions): ChildProcess { return spawnCommand(...this.claude(args), options); }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean { return this.loaded && !this.closed && !this.closing && this.opts.policy.claude && existsSync(join(this.configDir, "projects")); }
  private schedule = () => {
    if (this.closed || this.closing || this.debounce) return;
    // A running session appends to its transcript many times a second; one scan covers a burst.
    this.debounce = setTimeout(() => { this.debounce = null; this.safeScan(); }, 250); this.debounce.unref();
  };
  private scannedAt = 0;
  /** Reads use the last scan when it's under a second old; file events and the periodic rescan keep it current. */
  private fresh() { if (Date.now() - this.scannedAt >= (this.opts.readCacheMs ?? 1000)) this.scan(); }
  private safeScan() { if (!this.closed) { try { this.scan(); } catch { this.opts.log("claude: local scan failed; will retry"); } } }

  /** Synchronous projection updates keep filesystem events and concurrent action checks on one consistent snapshot. */
  private scan(): void {
    if (this.closed) return;
    this.scannedAt = Date.now();
    const live = readRegistry(this.configDir, this.opts.log);
    for (const run of this.store.runs()) {
      if (run.pid && pidState(run.pid, run.procStart) === "dead") this.store.ended(run.sessionId, run.pid);
      const holders = live.filter((l) => l.sessionId === run.sessionId && l.pid !== run.pid);
      if (holders.length && !this.collisions.has(run.sessionId)) {
        this.collisions.add(run.sessionId);
        this.opts.log(`claude: session ${run.sessionId} has another live holder; concurrent transcript writes are possible`);
      }
    }
    const wanted = new Set<string>([this.configDir, join(this.configDir, "sessions"), join(this.configDir, "projects")]);
    const paths = new Set<string>();
    const projectDir = join(this.configDir, "projects");
    const cutoff = this.now() - (this.opts.days ?? 14) * 86_400_000;
    try {
      for (const dir of readdirSync(projectDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const folder = join(projectDir, dir.name); wanted.add(folder);
        for (const file of readdirSync(folder, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith(".jsonl") || !sessionId(file.name.slice(0, -6))) continue;
          const path = join(folder, file.name), id = file.name.slice(0, -6);
          try {
            const st = statSync(path);
            if (st.mtimeMs < cutoff && !live.some((l) => l.sessionId === id) && !this.store.run(id)) continue;
            // Left out on its first records (below): never read further, and not watched, while it's the same file.
            if (this.skipped.get(path) === st.ino && !this.store.startedByDriver(id)) continue;
          } catch { continue; }
          paths.add(path); wanted.add(path);
        }
      }
    } catch { /* A first launch may not have created projects yet. The periodic scan discovers it. */ }
    for (const path of this.readers.keys()) if (!paths.has(path)) this.readers.delete(path);
    const candidates = new Map<string, Transcript>();
    for (const path of this.skipped.keys()) if (!existsSync(path)) this.skipped.delete(path);
    for (const path of paths) {
      let reader = this.readers.get(path);
      if (!reader) {
        // Most transcripts are other programs' (T3's, headless runs, SDK apps), and some are hundreds of MB. Their
        // first records say so, so a new one is read that far first, and no further if it's left out.
        reader = new Transcript(path, this.opts.log);
        reader.read(HEAD_BYTES);
        if (this.leftOut(reader, basename(path, ".jsonl"))) {
          try { this.skipped.set(path, statSync(path).ino); } catch { /* gone: the next scan drops it */ }
          paths.delete(path); wanted.delete(path);
          continue;
        }
      }
      this.readers.set(path, reader); reader.read();
      const id = basename(path, ".jsonl"), prior = candidates.get(id);
      if (!prior || reader.mtime > prior.mtime) candidates.set(id, reader);
    }
    for (const holder of live) if (!candidates.has(holder.sessionId)) candidates.set(holder.sessionId, new Transcript(""));
    const next = new Map<string, Row>();
    for (const [id, t] of candidates) {
      const holders = live.filter((l) => l.sessionId === id);
      const cwd = t.cwd ?? holders[0]?.cwd;
      if (!this.opts.policy.claude || !cwd || !visible(this.opts.policy, cwd) || holders.some((l) => !visible(this.opts.policy, l.cwd))) continue;
      if (t.t3 || t.sidechain || t3Cwd(cwd) || holders.some((l) => t3Cwd(l.cwd))) continue;
      // Only the user's own sessions (a terminal, an IDE, the desktop app) and the ones Driver started. Headless `-p`
      // runs and apps on the Agent SDK (T3 among them) are other programs' work: on Lattice they were 96 of 105.
      const entrypoint = t.entrypoint ?? holders.find((l) => l.entrypoint)?.entrypoint ?? null;
      if (entrypoint?.startsWith("sdk-") && !this.store.startedByDriver(id)) continue;
      const overlay = this.store.overlay(id);
      if (overlay.archived) continue;
      const pending = !t.unknown && holders.some((l) => l.status === "waiting");
      const busy = !t.unknown && holders.some((l) => l.status === "busy");
      const liveAt = holders.map((l) => l.statusUpdatedAt).filter((x): x is string => x !== null).sort().at(-1);
      const updatedAt = [t.updatedAt, liveAt].filter((x): x is string => !!x).sort().at(-1) ?? t.mtime;
      if (!holders.length && !this.store.run(id) && Date.parse(updatedAt) < cutoff) continue;
      const questionId = pending ? t.tool?.id ?? hash(id + (liveAt ?? "waiting")) : null;
      const newer = (at: string | null) => !!at && !!t.lastRunAt && t.lastRunAt > at;
      const item: WorkItem = {
        id, title: t.title ?? holders.find((l) => l.name)?.name ?? `a Claude session in ${group(cwd)}`, group: group(cwd),
        status: pending ? "waiting" : busy ? "running" : t.unknown || holders.some((l) => l.status === null) ? "idle" : t.outcome,
        updatedAt, settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !pending && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: pending, questionId, lastRunAt: t.lastRunAt, wroteAt: t.wroteAt, createdAt: t.createdAt,
      };
      next.set(id, { transcript: t, cwd, live: holders, item });
    }
    this.rows = next; this.refreshPlaces(); this.releaseAnswered();
    const changed: string[] = []; let urgent = false;
    for (const [id, row] of next) {
      const w = row.item, reply = row.transcript.reply;
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
  /**
   * Whether a transcript's first records already rule it out, as the listing below would: T3's own, a headless run or
   * an SDK app's that Driver didn't start, or in a folder Driver may not see. Unknown so far means read on.
   */
  private leftOut(t: Transcript, id: string): boolean {
    if (this.store.startedByDriver(id)) return false;
    if (t.t3 || t.entrypoint?.startsWith("sdk-")) return true;
    return t.cwd !== null && (t3Cwd(t.cwd) || !visible(this.opts.policy, t.cwd));
  }
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
  private refreshPlaces() {
    this.roots.clear();
    // Folders with a recent session, and every folder the user has trusted in Claude Code, as T3 Code lists every
    // project: new work can start in a project untouched for weeks.
    for (const cwd of [...[...this.rows.values()].map((r) => r.cwd), ...this.trustedFolders()]) {
      const root = gitRoot(cwd);
      // A visible subfolder must not grant a launch into its hidden repository parent.
      if (root && visible(this.opts.policy, root)) this.roots.set(placeId(root), root);
    }
  }
  private trusted: { mtimeMs: number; folders: string[] } | null = null;
  /**
   * The folders Claude Code's global settings (~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR) record as trusted,
   * that still exist. Read again only when the file changes; anything unreadable is none.
   */
  private trustedFolders(): string[] {
    const path = process.env.CLAUDE_CONFIG_DIR || this.configDir !== resolve(join(homedir(), ".claude")) ? join(this.configDir, ".claude.json") : join(homedir(), ".claude.json");
    try {
      const st = statSync(path);
      if (this.trusted?.mtimeMs === st.mtimeMs) return this.trusted.folders;
      const projects = st.size > 64 * 1024 * 1024 ? {} : JSON.parse(readFileSync(path, "utf8"))?.projects ?? {};
      const folders = Object.entries(projects).filter(([dir, v]: [string, any]) => isAbsolute(dir) && v?.hasTrustDialogAccepted === true && existsSync(dir)).map(([dir]) => dir);
      this.trusted = { mtimeMs: st.mtimeMs, folders };
      return folders;
    } catch { return []; }
  }
  /** Where a process 10 & 2 starts for this would work: new work's project, or a session nothing has open (local.ts). */
  workFolder(kind: ActionKind, id: string): string | null {
    if (kind === "start_work") return this.roots.get(id) ?? null;
    const row = kind === "follow_up" ? this.rows.get(id) : undefined;
    return row && !row.live.length && !this.asks.has(id) ? row.cwd : null;
  }
  places(): Place[] {
    if (!this.loaded || this.closed || !this.opts.policy.claude || !allows(this.opts.policy, "start_work", "claude")) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => { const g = gitRoot(r.cwd); return g !== null && placeId(g) === id; }).map((r) => r.item.updatedAt).sort().at(-1) ?? null, models: this.models }));
  }
  async list(): Promise<WorkItem[]> { this.fresh(); return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.cwd)) throw new Error("That session isn't visible to 10 & 2.");
    return row;
  }
  async report(id: string): Promise<Report> {
    this.fresh(); const r = this.row(id), t = r.transcript, last = t.reply;
    return { text: last?.text ?? "", progress: r.item.status === "running" ? t.progress : null,
      question: this.asks.get(id)?.plan ? `Claude has a plan ready and asks whether to go ahead with it: ${this.asks.get(id)!.plan!.slice(0, 3000)}`
        : r.item.pendingQuestion || this.asks.has(id) ? (this.asks.get(id)?.questions ?? t.asking) ? (this.asks.get(id)?.questions ?? t.asking)!.map((q) => `${q.question}${q.options.length ? ` Options: ${q.options.join(" / ")}.` : ""}`).join(" ")
        : t.tool ? `wants to run ${t.tool.name}` : "Claude needs your input in its terminal." : null,
      reply: last ? { runId: last.runId, messageId: last.messageId, at: last.at } : null };
  }
  async replies(id: string): Promise<PastReply[]> { this.fresh(); return this.row(id).transcript.replies().map((r) => ({ ...r })); }
  /** Read from the transcript's start, so it's complete. */
  async firstAsk(id: string): Promise<FirstAsk | null> { this.fresh(); const f = this.row(id).transcript.first; return f ? firstAsk(f.text, f.at, true) : null; }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  async check(action: Action): Promise<string | null> {
    return this.preflight(action);
  }
  private preflight(action: Action): string | null {
    if (this.closed || this.closing || !this.loaded) return "Claude sessions aren't loaded right now.";
    this.scan();
    if (!this.opts.policy.claude) return "Claude sessions are disabled on this machine.";
    if (!allows(this.opts.policy, action.kind, "claude")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      if (action.title?.trimStart().startsWith("-")) return "A session title must not start with a dash.";
      if (!this.roots.has(action.placeId)) return "That project isn't visible to 10 & 2.";
      if (!withinCeiling(this.opts.policy, action.profile, "claude")) return "That launch profile exceeds this machine's permission ceiling.";
      // Claude Code takes any `--model` and fails only once the session calls it, after it counts as started.
      if (action.model !== undefined && !this.models.some((m) => m.id === action.model)) return NO_SUCH_MODEL;
      if (action.profile.workspace === "worktree" && !this.worktrees) return "10 & 2 hasn't verified headless Claude worktrees with this Claude version. Choose the project checkout profile.";
      if (action.profile.workspace === "worktree") {
        const root = this.roots.get(action.placeId)!;
        if ([join(root, ".claude"), join(root, ".claude", "worktrees")].some((p) => existsSync(p) && !visible(this.opts.policy, p))) return "That project's worktree folder is outside 10 & 2's visible folders.";
      }
      return null;
    }
    const row = this.rows.get(action.itemId);
    if (!row) return "That session isn't visible to 10 & 2.";
    if (action.kind === "snooze" && !iso(action.until)) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.followUpRefusal(action.itemId, row, registrySnapshot(this.configDir, this.opts.log).uncertain);
    return null;
  }
  private followUpRefusal(id: string, row: Row, holdersUncertain: boolean): string | null {
    // A question Claude asked that the hook holds takes the answer; a live session (a terminal, a background session,
    // Driver's own run) takes the message in its inbox, between steps or as its next turn.
    if (this.asks.has(id)) return null;
    if (row.live.length) return !steers(this.opts.policy, "claude") ? NO_STEERING : row.live.some((l) => l.socket) ? null : unreachable(row.live);
    if (this.store.run(id)) return "10 & 2 is already running that session, or can't yet verify that its previous run ended.";
    if (holdersUncertain) return "10 & 2 can't verify whether a terminal holds that session right now.";
    if (row.transcript.unknown) return "This session uses a Claude transcript version 10 & 2 doesn't understand yet.";
    if (resumeMode(row.transcript.permissionMode, ceilingFor(this.opts.policy, "claude")) === null) return "10 & 2 can't tell what permissions that session runs with, so it won't send to it.";
    return null;
  }
  /** Follow-ups this machine would refuse right now, per session, from the last scan; checked again on execute. */
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", "claude")) return {};
    const uncertain = registrySnapshot(this.configDir, this.opts.log).uncertain;
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) {
      const why = this.followUpRefusal(id, row, uncertain);
      if (why) out[id] = { follow_up: why };
    }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed || this.closing) return { ok: false, error: "Claude adapter is closed." };
    const digest = hash(JSON.stringify(action));
    const prior = this.store.operation(key);
    if (prior) return prior.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : prior.receipt ? JSON.parse(prior.receipt) : UNKNOWN;
    const why = await this.check(action);
    if (why) return { ok: false, error: why };
    // Another call may have reserved this key while preflight yielded. Its outcome is never a second dispatch.
    const reserved = this.store.operation(key);
    if (reserved) return reserved.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : reserved.receipt ? JSON.parse(reserved.receipt) : UNKNOWN;
    const changedPolicy = this.preflight(action);
    if (changedPolicy) return { ok: false, error: changedPolicy };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind,
        new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.execute(action, key);
      this.scan(); return receipt;
    }
    const id = action.kind === "start_work" ? sessionForKey(key) : action.itemId;
    // Re-read after the asynchronous preflight. Claude itself does not lock out terminal holders.
    const holders = registrySnapshot(this.configDir, this.opts.log);
    if (action.kind === "follow_up") {
      const ask = this.asks.get(id);
      if (ask) return this.tracked(this.answer(action, key, digest, ask));
      const live = holders.live.filter((l) => l.sessionId === id);
      // The most recently active holder with an inbox: usually the terminal the user has open.
      const target = live.filter((l) => l.socket).sort((a, b) => (b.statusUpdatedAt ?? "").localeCompare(a.statusUpdatedAt ?? ""))[0];
      if (live.length && !steers(this.opts.policy, "claude")) return { ok: false, error: NO_STEERING };
      if (target) return this.tracked(this.message(action, key, digest, target));
      if (live.length) return { ok: false, error: unreachable(live) };
    }
    const held = holders.live.filter((l) => l.sessionId === id);
    if (held.length) return { ok: false, error: unreachable(held) };
    if (action.kind === "follow_up" && holders.uncertain) return { ok: false, error: "10 & 2 can't verify whether a terminal holds that session right now." };
    if (this.store.run(id)) return { ok: false, error: "10 & 2 is already running that session." };
    if (!this.store.begin(key, digest, id)) {
      const existing = this.store.operation(key);
      return existing ? existing.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : existing.receipt ? JSON.parse(existing.receipt) : UNKNOWN : { ok: false, error: "10 & 2 is already running that session." };
    }
    return this.tracked(this.background ? this.launchBackground(action, key, id) : this.launch(action, key, id));
  }

  private async tracked(pending: Promise<Receipt>): Promise<Receipt> {
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }
  /** Reserves an operation key for a write without a run of Driver's own: null, or the earlier outcome to repeat. */
  private reserve(key: string, digest: string): Receipt | null {
    if (this.store.begin(key, digest)) return null;
    const existing = this.store.operation(key);
    return !existing ? UNKNOWN : existing.hash !== digest ? { ok: false, error: "That operation key was already used for different words or settings." } : existing.receipt ? JSON.parse(existing.receipt) : UNKNOWN;
  }

  /**
   * A follow-up to a session something has open (a terminal, a background session, a run of Driver's own): posted to its
   * inbox. It counts as sent once Claude Code queues it (its transcript's `enqueue` with these exact words) or records
   * it as a turn (a user record with this message's id). One it holds for the user's approval says so.
   */
  private async message(action: Extract<Action, { kind: "follow_up" }>, key: string, digest: string, target: Live): Promise<Receipt> {
    const earlier = this.reserve(key, digest);
    if (earlier) return earlier;
    const id = action.itemId, row = this.rows.get(id);
    const sessionMode = row?.transcript.permissionMode ?? null;
    const mode = attestedMode(sessionMode, ceilingFor(this.opts.policy, "claude"));
    const content = envelope(action.message, mode), uuid = randomUUID();
    let path = row?.transcript.path || this.transcriptOf(id, target.cwd);
    let baseline = 0;
    try { if (path) baseline = statSync(path).size; } catch { /* No transcript yet: everything in it is new. */ }
    const token = peerToken(this.configDir, target.pid, target.socket!, target.procStart);
    // Claude Code on Windows reads nothing on its inbox before the token, and would drop the message unread.
    if (!token && process.platform === "win32") return this.store.finish(key, { ok: false, error: NO_KEY });
    if (!(await post(target.socket!, token, id, uuid, content))) {
      return this.store.finish(key, { ok: false, error: "10 & 2 couldn't reach that session. Is it still open?" });
    }
    let lines = path ? new TranscriptLines(path, baseline) : null;
    // One Claude Code will hold for the user's approval needs no long wait (unless its settings accept every message).
    const held = heldFor(sessionMode, mode);
    const deadline = Date.now() + Math.min(this.opts.acceptanceTimeoutMs ?? 15_000, held ? 3000 : Infinity);
    while (Date.now() < deadline) {
      // A transcript that wasn't there before the message is new: all of it counts.
      if (!lines && (path = this.findTranscript(id))) lines = new TranscriptLines(path);
      for (const r of lines?.read() ?? []) {
        const queued = r.type === "queue-operation" && r.operation === "enqueue" && r.content === content;
        if (queued || (r.type === "user" && r.uuid === uuid)) { this.schedule(); return this.store.finish(key, { ok: true }); }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.store.finish(key, { ok: false, unknown: true, error: held ? AWAITING_OK : NOT_DELIVERED });
  }

  /** The answer to a question Claude asked, through the hook holding it; the hook passes it on and exits. */
  private async answer(action: Extract<Action, { kind: "follow_up" }>, key: string, digest: string, ask: Ask): Promise<Receipt> {
    const earlier = this.reserve(key, digest);
    if (earlier) return earlier;
    this.asks.delete(action.itemId);
    // A plan goes ahead on a plain yes; any other words go back to Claude as what to change.
    const reply = ask.plan ? goAhead(action.message) ? { approve: true } : { revise: action.message } : { answers: answersFor(ask.questions!, action.message) };
    const passed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ask.socket.once("close", () => { clearTimeout(timer); resolve(true); });
      ask.socket.once("error", () => { clearTimeout(timer); resolve(false); });
      if (ask.socket.destroyed || !ask.socket.writable) { clearTimeout(timer); resolve(false); return; }
      ask.socket.end(JSON.stringify(reply) + "\n");
    });
    this.schedule();
    return this.store.finish(key, passed ? { ok: true } : { ok: false, unknown: true, error: "Claude may have had its answer already. 10 & 2 won't send it again." });
  }

  /**
   * New work, or a follow-up to a session nothing has open, as a background session (`claude --bg`): it shows in
   * `claude agents`, `claude attach` opens it in a terminal, and while it runs Driver can message it like any live
   * session. Claude Code's supervisor stops it about an hour after it goes idle; the conversation stays. It counts as sent
   * once its transcript records the message as the user's prompt. When `claude --bg` fails before starting anything
   * (an untrusted folder, a bypass mode never accepted, no supervisor), it runs headless instead.
   */
  private async launchBackground(action: Extract<Action, { kind: "start_work" | "follow_up" }>, key: string, id: string): Promise<Receipt> {
    const starting = action.kind === "start_work";
    const cwd = starting ? this.roots.get(action.placeId)! : this.row(id).cwd;
    const mode = starting ? action.profile.interactionMode === "plan" ? "plan" : permissionMode(action.profile.runtimeMode) : resumeMode(this.row(id).transcript.permissionMode, ceilingFor(this.opts.policy, "claude"))!;
    // A name the user gave the session stays; otherwise Claude Code keeps titling it itself.
    const name = starting ? action.title : this.rows.get(id)?.transcript.named ? this.rows.get(id)?.transcript.title ?? undefined : undefined;
    const worktree = starting && action.profile.workspace === "worktree" ? `10and2-${id.slice(0, 13)}` : null;
    // Without a worktree profile it stays where it is: Claude Code would otherwise move a background session into a
    // worktree before its first edit, a user's own session included.
    const args = ["--bg", "--permission-mode", mode, ...(name ? ["--name", name] : []),
      ...(worktree ? ["--worktree", worktree] : ["--settings", JSON.stringify({ worktree: { bgIsolation: "none" } })]),
      ...(starting && action.model ? ["--model", action.model] : []), ...(starting ? [] : ["--resume", id]), "--", action.message];
    this.store.markStarted(id);
    const previous = starting ? undefined : this.rows.get(id)?.transcript;
    const baseline = previous?.offset ?? 0;
    const ran = await new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = "";
      try {
        const child = this.spawnClaude(args, { cwd, detached: true, env: this.childEnv(), stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => resolve({ code: null, out }), 30_000);
        child.stdout!.on("data", (b) => { out += b.toString(); });
        child.stderr!.on("data", (b) => { out += b.toString(); });
        child.on("error", () => { clearTimeout(timer); resolve({ code: -1, out }); });
        child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
      } catch { resolve({ code: -1, out }); }
    });
    const short = /backgrounded · ([0-9a-f]{8})/.exec(ran.out)?.[1];
    const copy = /started a copy (?:of that conversation )?as ([0-9a-f]{8})/.exec(ran.out)?.[1];
    if (!short && ran.code !== null && ran.code !== 0) {
      this.opts.log(`claude: background start refused (${ran.out.trim().split("\n").at(-1)?.slice(0, 200) ?? `exit ${ran.code}`}); running it headless`);
      return this.launch(action, key, id);
    }
    if (!short) { this.store.ended(id); return this.store.finish(key, UNKNOWN); }
    const finish = (receipt: Receipt) => { this.store.ended(id); this.scan(); return this.store.finish(key, receipt); };
    if (copy || (!starting && short !== id.slice(0, 8))) {
      return finish({ ok: false, unknown: true, error: "It was open somewhere else, so Claude started a copy with your message. 10 & 2 won't send it again." });
    }
    // The session's transcript: the one Driver read, or a new one under its working folder (or worktree).
    // The supervisor starts the session's own process before its first record, so this waits twice as long.
    const deadline = Date.now() + 2 * (this.opts.acceptanceTimeoutMs ?? 15_000);
    let lines: TranscriptLines | null = previous?.path ? new TranscriptLines(previous.path, baseline) : null, path = previous?.path ?? null;
    while (Date.now() < deadline) {
      if (!lines) {
        path = this.findTranscript(short);
        if (path) lines = new TranscriptLines(path);
      }
      for (const r of lines?.read() ?? []) {
        if (typedUser(r) === action.message && typeof r.sessionId === "string" && r.sessionId.startsWith(short)) {
          this.store.markStarted(r.sessionId);
          return finish(starting ? { ok: true, itemId: r.sessionId } : { ok: true });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return finish(UNKNOWN);
  }
  /** Where a session's transcript is (or will be): in its folder's, or past Claude Code's name length, wherever it is. */
  private transcriptOf(id: string, cwd: string): string | null {
    const folder = projectFolder(cwd);
    return folder ? join(this.configDir, "projects", folder, `${id}.jsonl`) : this.findTranscript(id);
  }
  /** The transcript of a session whose id starts with `short`, in any project folder. */
  private findTranscript(short: string): string | null {
    const projects = join(this.configDir, "projects");
    try {
      for (const dir of readdirSync(projects)) {
        const file = readdirSync(join(projects, dir)).find((f) => f.startsWith(short) && f.endsWith(".jsonl") && sessionId(f.slice(0, -6)));
        if (file) return join(projects, dir, file);
      }
    } catch { /* Not there yet. */ }
    return null;
  }

  private async launch(action: Extract<Action, { kind: "start_work" | "follow_up" }>, key: string, id: string): Promise<Receipt> {
    const cwd = action.kind === "start_work" ? this.roots.get(action.placeId)! : this.row(id).cwd;
    const mode = action.kind === "start_work" ? action.profile.interactionMode === "plan" ? "plan" : permissionMode(action.profile.runtimeMode) : resumeMode(this.row(id).transcript.permissionMode, ceilingFor(this.opts.policy, "claude"))!;
    const args = ["-p", action.kind === "start_work" ? "--session-id" : "--resume", id, "--permission-mode", mode,
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"];
    // With no title, Claude Code names the session itself.
    if (action.kind === "start_work" && action.title) args.push(`--name=${action.title}`);
    const worktreeName = action.kind === "start_work" && action.profile.workspace === "worktree" ? `10and2-${id.slice(0, 13)}` : null;
    if (worktreeName) args.push("--worktree", worktreeName);
    // A refused background start comes here too, so the model it asked for goes with it.
    if (action.kind === "start_work" && action.model) args.push("--model", action.model);
    // Driver's own headless records follow in this transcript; the session stays listed as Driver's whatever they say.
    this.store.markStarted(id);
    const messageId = randomUUID();
    const token = hash(key).slice(0, 24), stdoutPath = join(this.opts.stateDir, `${token}.stdout.jsonl`), stderrPath = join(this.opts.stateDir, `${token}.stderr.log`);
    const finish = (receipt: Receipt): Receipt => {
      const saved = this.store.finish(key, receipt);
      if (receipt.ok || !receipt.unknown) {
        for (const path of [stdoutPath, stderrPath]) {
          try { unlinkSync(path); } catch { /* A later startup prunes any log we couldn't remove. */ }
        }
      }
      return saved;
    };
    let out: number, err: number;
    try { out = openSync(stdoutPath, "wx", 0o600); try { err = openSync(stderrPath, "wx", 0o600); } catch (e) { closeSync(out); throw e; } }
    catch { this.store.ended(id); return finish({ ok: false, error: "10 & 2 couldn't create a private run log." }); }
    const previous = this.rows.get(id)?.transcript;
    const baseline = previous?.offset ?? 0;
    const runCwd = worktreeName ? join(cwd, ".claude", "worktrees", worktreeName) : cwd;
    let transcriptPath = previous?.path || this.transcriptOf(id, runCwd);
    let child;
    try {
      child = this.spawnClaude(args, { cwd, detached: true, env: this.childEnv(), stdio: ["pipe", out, err] });
    } catch (e) {
      closeSync(out); closeSync(err); this.store.ended(id);
      return finish({ ok: false, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? NOT_INSTALLED : "10 & 2 couldn't start Claude on this machine." });
    }
    closeSync(out); closeSync(err);
    const pid = child.pid;
    if (pid) this.store.started(id, pid, procStart(pid));
    else this.store.ended(id);
    let failed = false, exited = false;
    child.on("error", () => { failed = true; exited = true; if (!this.closed) this.store.ended(id); });
    child.on("exit", () => { exited = true; if (!this.closed && pid) { this.store.ended(id, pid); this.schedule(); } });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ type: "user", uuid: messageId, session_id: id, message: { role: "user", content: action.message } }) + "\n");
    child.unref();
    // Observe files instead of piping output, so detached Claude can continue if the connector exits.
    const output = new TranscriptLines(stdoutPath);
    let transcript = transcriptPath ? new TranscriptLines(transcriptPath, baseline) : null, searched = 0;
    let init = false, replay = false, recorded = false;
    const deadline = Date.now() + (this.opts.acceptanceTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      for (const r of output.read()) {
        if (r.type === "system" && r.subtype === "init" && r.session_id === id) init = true;
        if (r.type === "user" && r.session_id === id && r.uuid === messageId && typedUser(r) === action.message) replay = true;
      }
      // Claude Code names the folder from the cwd as it sees it, which can differ from the one given (a Windows drive's
      // case, a resolved link): until the transcript is where expected, it's looked for by id every half second.
      if ((!transcriptPath || (!previous?.path && !existsSync(transcriptPath))) && Date.now() - searched >= 500) {
        searched = Date.now();
        const found = this.findTranscript(id);
        if (found && found !== transcriptPath) { transcriptPath = found; transcript = new TranscriptLines(found); }
      }
      for (const r of transcript?.read() ?? []) if (r.sessionId === id && r.uuid === messageId && typedUser(r) === action.message) recorded = true;
      if ((init && replay) || recorded) {
        const receipt: Receipt = action.kind === "start_work" ? { ok: true, itemId: id } : { ok: true };
        finish(receipt); this.scan(); return receipt;
      }
      if (failed) return finish({ ok: false, error: NOT_INSTALLED });
      // Even an exited process can have an asynchronous transcript flush in flight. Keep waiting for evidence.
      await new Promise((resolve) => setTimeout(resolve, exited ? 40 : 25));
    }
    return finish(UNKNOWN);
  }

  /** Where `10and2 hook` finds this adapter's pipe on Windows (paths.ts hookSocket). */
  private get pipeFile() { return join(this.opts.stateDir, "hooks.pipe"); }
  private async listenHooks() {
    // On Windows it's a named pipe, not a file: there's no folder to make, nothing a crash leaves to remove, and no mode.
    const pipe = process.platform === "win32";
    if (!pipe) {
      try { mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 }); }
      catch { this.opts.log("claude: hook socket unavailable; using filesystem watches"); return; }
    }
    // Never unlink a socket another connector may own; one nobody answers on was left by a crash and is replaced.
    // Polling remains available if this one cannot bind.
    if (!pipe && existsSync(this.socketPath)) {
      const answered = await new Promise<boolean>((resolve) => {
        const probe = createConnection(this.socketPath);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", () => resolve(false));
      });
      if (answered) { this.opts.log("claude: another connector owns the hook socket; using filesystem watches"); return; }
      try { unlinkSync(this.socketPath); } catch { /* bind below reports it */ }
    }
    const server = createServer((socket) => {
      socket.setTimeout(500, () => socket.destroy()); let text = "", proved = false;
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (text.includes("\n")) return;
        text += chunk.toString();
        if (text.length > 64 * 1024) { socket.destroy(); return; }
        if (!text.includes("\n")) return;
        try {
          const event = JSON.parse(text.slice(0, text.indexOf("\n")));
          // A hook that has the secret (Windows) asks this to prove it first, once, and sends its event after.
          if (!proved && typeof event?.nonce === "string") {
            proved = true; text = "";
            socket.write(proof(this.hookSecret, event.nonce) + "\n"); return;
          }
          if (event.hook_event_name === "PermissionRequest" && sessionId(event.session_id) && this.hold(event.session_id, socket, event)) return;
          // Payloads never set status or supply reply text. Only a fresh filesystem read may do that.
          if (sessionId(event.session_id) && ["SessionStart", "SessionEnd", "Stop", "Notification"].includes(event.hook_event_name)) this.schedule();
        } catch { /* Untrusted or incomplete local notification. */ }
        socket.end();
      });
    });
    this.socket = server;
    await new Promise<void>((resolve) => {
      server.on("error", () => { this.opts.log("claude: hook socket unavailable; using filesystem watches"); resolve(); });
      server.listen(this.socketPath, () => {
        this.ownsSocket = true;
        if (pipe) {
          // Its name, and the secret it proves itself with: hooks.pipe is in the user's own profile, where only they can
          // read it, but other accounts can list pipes' names and take this one once it's gone.
          try {
            const tmp = `${this.pipeFile}.${randomUUID()}`;
            writeFileSync(tmp, `${this.socketPath}\n${this.hookSecret}\n`, { mode: 0o600 }); replaceFile(tmp, this.pipeFile); server.unref();
          } catch { server.close(); this.opts.log("claude: couldn't name the hook pipe; using filesystem watches"); }
          resolve(); return;
        }
        try { chmodSync(this.socketPath, 0o600); server.unref(); }
        catch { server.close(); this.opts.log("claude: couldn't make hook socket private; using filesystem watches"); }
        resolve();
      });
    });
  }
  /**
   * Keeps a PermissionRequest hook's connection while its session waits on an AskUserQuestion Driver may answer. The
   * questions come from the hook, since Claude Code writes the call to its transcript only once it's answered; only
   * their text and option labels are kept. False (the hook exits at once, leaving the question to the terminal) for a
   * session Driver doesn't list, or no questions.
   */
  private hold(id: string, socket: Socket, event: any): boolean {
    this.scan();
    const row = this.rows.get(id), heldAt = new Date(this.now()).toISOString();
    const questions = event.tool === "ExitPlanMode" ? null : asked({ name: "AskUserQuestion", input: { questions: event.questions } });
    const plan = event.tool === "ExitPlanMode" && typeof event.plan === "string" && event.plan.trim() ? event.plan.slice(0, 20_000) : null;
    if (!row || (!questions && !plan) || this.closing || !answers(this.opts.policy, "claude")) return false;
    this.asks.get(id)?.socket.end();
    socket.setTimeout(0);
    const ask: Ask = questions ? { socket, questions, heldAt } : { socket, plan: plan!, heldAt };
    this.asks.set(id, ask);
    socket.once("close", () => { if (this.asks.get(id) === ask) { this.asks.delete(id); this.schedule(); } });
    this.schedule();
    return true;
  }
  /** A question answered in the terminal (or a session that ended) lets its hook go, with no answer. */
  private releaseAnswered() {
    for (const [id, ask] of this.asks) {
      const row = this.rows.get(id), answered = row?.transcript.answeredAt;
      if (!row || !row.live.length || (answered && answered >= ask.heldAt)) { this.asks.delete(id); ask.socket.end(); }
    }
  }
  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = this.stop();
    return this.shutdown;
  }
  private async stop(): Promise<void> {
    if (this.rescan) clearInterval(this.rescan);
    if (this.modelsTimer) clearTimeout(this.modelsTimer);
    this.stopping.abort();
    if (this.debounce) clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
    // Finish acceptance bookkeeping; the child itself stays detached and keeps its log descriptors.
    await Promise.allSettled([...this.writes]);
    this.closed = true; this.loaded = false; this.listeners.clear();
    for (const ask of this.asks.values()) ask.socket.end(); this.asks.clear();
    this.socket?.close();
    if (this.ownsSocket && process.platform === "win32") {
      // The pipe goes with its server; its name goes too, unless a newer connector has written its own.
      try { if (readFileSync(this.pipeFile, "utf8").split(/\r?\n/)[0] === this.socketPath) unlinkSync(this.pipeFile); } catch { /* already gone */ }
    } else if (this.ownsSocket) { try { unlinkSync(this.socketPath); } catch { /* Server may already have removed it. */ } }
    this.store.close();
  }
}

/** A bounded incremental line reader used only during acceptance; it does not retain any transcript records. */
class TranscriptLines {
  private offset: number;
  private tail = Buffer.alloc(0);
  constructor(privatePath: string, offset = 0) { this.path = privatePath; this.offset = offset; }
  private readonly path: string;
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
          try { out.push(JSON.parse(bytes.subarray(pos, end).toString("utf8"))); } catch { /* Partial or irrelevant line. */ }
          pos = end + 1;
        }
        this.tail = Buffer.from(bytes.subarray(pos));
        if (this.tail.length > 1024 * 1024) this.tail = Buffer.alloc(0);
      }
      return out;
    } finally { closeSync(fd); }
  }
}
