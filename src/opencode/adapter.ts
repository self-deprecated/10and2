// OpenCode (sst/opencode, measured on 1.19.5) as a work system: its sessions are read from its own database; what
// only a running process knows (busy, a question, a permission request) is asked of the processes Driver can reach
// (live.ts); a follow-up goes to the process that has the session open, or to Driver's own `opencode serve` (serve.ts)
// when nothing has. Same rules as the Claude Code adapter: a write counts as sent only on evidence that OpenCode took
// it, an operation key is used at most once, and anything refused is said in words.
import { watch, existsSync, mkdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Action, Adapter, PastReply, Place, Receipt, Report, WorkItem } from "../contract.ts";
import { allows, answers, ceilingFor, steers, visible, withinCeiling } from "../policy.ts";
import type { Policy, RuntimeMode } from "../policy.ts";
import { Store } from "../claude/store.ts";
import { t3Cwd } from "../claude/transcript.ts";
import { addWorktree, folderOf, gitRoot, group } from "../work.ts";
import { dbPathFor, isRunSession, messages, newUserMessages, projectRoots, questionsOf, sessions, userMessageIds, view, withDb } from "./db.ts";
import type { Asked, SessionRow, View } from "./db.ts";
import { alive, call, CallError, defaultLiveDir, endpointKey, events, healthy, pluginEndpoints, processes } from "./live.ts";
import type { Endpoint, Proc } from "./live.ts";
import { atMost, isRules, reach, serveCeiling, sessionRules } from "./rules.ts";
import type { Rule } from "./rules.ts";
import { Serve } from "./serve.ts";
import { defaultConfigDir, openCodePluginStatus } from "./plugin.ts";

export type Options = {
  policy: Policy; db: string; stateDir: string; log: (m: string) => void;
  /** OpenCode's data folder (holding opencode.db); its default is $XDG_DATA_HOME/opencode, or $OPENCODE_DB's file. */
  dataDir?: string;
  /** OpenCode's config folder, where its plugins are (only to say when 10 & 2's isn't installed). */
  configDir?: string;
  opencodeBin?: string;
  now?: () => number;
  /** How long inactive sessions remain in the briefing. Ones a process is running are always included. */
  days?: number;
  /** The bounded wait for evidence a message arrived; never causes a resend. */
  acceptanceTimeoutMs?: number;
  /** Where the plugin announces processes (its own default). */
  liveDir?: string;
  /** How old a read may be reused (1 s). Tests use 0. */
  readCacheMs?: number;
  /** How long Driver's own server may sit idle before it's stopped (10 minutes). */
  idleMs?: number;
  /** Whether `ps` is asked for OpenCode processes the plugin doesn't announce (TUIs started with --port, or before it was installed). */
  scanProcesses?: boolean;
};

type Pending =
  | { kind: "question"; id: string; sessionId: string; ep: Endpoint; directory: string | null; questions: Asked[] }
  | { kind: "permission"; id: string; sessionId: string; ep: Endpoint; directory: string | null; permission: string; patterns: string[]; command: string | null };
type Live = {
  endpoints: Endpoint[];
  /** sessionId → the process running it. */
  busy: Map<string, Endpoint>;
  pending: Pending[];
  /** OpenCode terminal UIs Driver can't reach (no plugin, no --port), by folder. */
  unreachable: Proc[];
};
type Row = { s: SessionRow; v: View; item: WorkItem; holder: Endpoint | null; runner: Endpoint | null; pending: Pending | null; unreachable: boolean };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const UNKNOWN: Receipt = { ok: false, unknown: true, error: "I can't tell whether OpenCode received that. 10 & 2 won't send it again." };
const NO_STEERING = "It's open in OpenCode, and this computer doesn't let 10 & 2 send to open sessions.";
const UNREACHABLE = "It's open in an OpenCode that 10 & 2 can't reach. Installing 10 & 2's OpenCode plugin and restarting OpenCode fixes that.";
const CAPPED = "That session may do more than this computer lets 10 & 2 run, so 10 & 2 won't send to it.";
const NOT_REACHED = "10 & 2 couldn't reach OpenCode. Is it still open?";
const KEY_REUSED = "That operation key was already used for different words or settings.";
/** A question OpenCode is asking, said as it's asked. */
const ask = (qs: Asked[]) => qs.map((q) => `${q.question}${q.options.length ? ` Options: ${q.options.join(" / ")}.` : ""}`).join(" ");
function wants(p: Extract<Pending, { kind: "permission" }>): string {
  if (p.permission === "bash") return `run ${p.command ?? p.patterns.join(" && ")}`;
  if (p.permission === "edit") return `edit ${p.patterns.join(", ")}`;
  if (p.permission === "external_directory") return `use files outside the project${p.patterns[0] ? ` (${p.patterns[0]})` : ""}`;
  if (p.permission === "webfetch") return `fetch ${p.patterns.join(", ")}`;
  return `use ${p.permission}${p.patterns.length && p.patterns[0] !== "*" ? ` (${p.patterns.join(", ")})` : ""}`;
}
/** The answer to each question from the user's words: an option they named (each, when several may be chosen), else their words. */
export function answersFor(questions: Asked[], words: string): string[][] {
  const plain = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const said = plain(words);
  return questions.map((q) => {
    const exact = q.options.find((o) => plain(o) === said);
    if (exact) return [exact];
    const named = q.options.filter((o) => plain(o).trim() !== "" && said.includes(plain(o)));
    return q.multiple && named.length ? named : named.length === 1 ? [named[0]!] : [words];
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const untitled = (t: string) => !t.trim() || /^New session - \d{4}-\d\d-\d\dT/.test(t);

export class OpenCodeAdapter implements Adapter {
  readonly name = "opencode";
  readonly actions = ["follow_up", "settle", "snooze", "archive", "start_work", "unsnooze", "unsettle"] as const;
  readonly dbPath: string;
  readonly liveDir: string;
  private readonly opts: Options;
  private readonly store: Store;
  private readonly serve: Serve;
  private readonly now: () => number;
  private loaded = false;
  private closed = false;
  private closing = false;
  private shutdown: Promise<void> | null = null;
  private rows = new Map<string, Row>();
  private live: Live = { endpoints: [], busy: new Map(), pending: [], unreachable: [] };
  private roots = new Map<string, string>();
  private keys = new Map<string, string>();
  private questions = new Map<string, string | null>();
  private cache = new Map<string, { signature: string; v: View }>();
  private projectDirs: string[] = [];
  private listeners = new Set<(ids: string[], urgent: boolean) => void>();
  private watchers = new Map<string, FSWatcher>();
  private streams = new Map<string, { stop: () => void; endpoint: Endpoint }>();
  private streamTried = new Map<string, number>();
  private healthyPorts = new Map<number, { ok: boolean; at: number }>();
  private rescan: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private again = false;
  private forceLive = false;
  private liveAt = 0;
  private scannedAt = 0;
  private writes = new Set<Promise<Receipt>>();

  constructor(opts: Options) {
    this.opts = opts; this.now = opts.now ?? Date.now;
    this.dbPath = dbPathFor(opts.dataDir);
    this.liveDir = opts.liveDir ?? defaultLiveDir();
    this.store = new Store(opts.db);
    this.serve = new Serve({ bin: opts.opencodeBin ?? "opencode", stateDir: opts.stateDir, log: opts.log, permission: serveCeiling(ceilingFor(opts.policy, "opencode")) });
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) throw new Error("OpenCode adapter is closed");
    if (this.loaded) return;
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const plugin = await openCodePluginStatus(this.opts.configDir ?? defaultConfigDir()).catch(() => null);
    if (plugin && !plugin.installed) this.opts.log("opencode: 10and2's plugin isn't installed, so sessions open in OpenCode can't be reached (10and2 opencode install)");
    await this.scan(true);
    if (this.closed || this.closing) throw new Error("OpenCode adapter is closed");
    this.loaded = true;
    this.rescan = setInterval(() => { void this.safeScan().then(() => this.idleCheck()); }, 30_000); this.rescan.unref();
  }
  get isLoaded(): boolean { return this.loaded; }
  connected(): boolean { return this.loaded && !this.closed && !this.closing && this.opts.policy.opencode && existsSync(this.dbPath); }

  private schedule = () => {
    if (this.closed || this.closing || this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; void this.safeScan(); }, 250); this.debounce.unref();
  };
  private async fresh() { if (Date.now() - this.scannedAt >= (this.opts.readCacheMs ?? 1000)) await this.scan(); }
  private async safeScan() { if (!this.closed) { try { await this.scan(); } catch { this.opts.log("opencode: local scan failed; will retry"); } } }
  /**
   * One scan at a time; a scan asked for meanwhile runs once more after it. The processes are asked again at most once
   * a second (a streaming reply writes the database many times a second), or always when `live` (before acting).
   */
  private scan(live = false): Promise<void> {
    this.forceLive ||= live;
    if (this.scanning) { this.again = true; return this.scanning; }
    this.scanning = (async () => {
      try {
        do {
          this.again = false;
          const probeNow = this.forceLive || Date.now() - this.liveAt >= (this.opts.readCacheMs ?? 1000);
          this.forceLive = false;
          await this.scanOnce(probeNow);
        } while (this.again && !this.closed);
      } finally { this.scanning = null; }
    })();
    return this.scanning;
  }

  /** What the reachable processes are doing right now. */
  private async probe(): Promise<Live> {
    const ours = this.serve.pid;
    const plugin = pluginEndpoints(this.liveDir).filter((e) => e.pid !== ours);
    const procs = this.opts.scanProcesses === false ? [] : await processes();
    const endpoints: Endpoint[] = [...plugin];
    const unreachable: Proc[] = [];
    for (const p of procs) {
      if (p.pid === ours || p.kind !== "tui" || plugin.some((e) => e.pid === p.pid)) continue;
      if (p.port) {
        const ep: Endpoint = { via: "port", kind: "tui", pid: p.pid, url: `http://${p.host.includes(":") ? `[${p.host}]` : p.host}:${p.port}`, directory: p.directory, sessions: {}, startedAt: 0 };
        // Asked once it answers; one that didn't (yet: it may be starting) is asked again now and then.
        let known = this.healthyPorts.get(p.pid);
        if (!known || (!known.ok && Date.now() - known.at > 15_000)) { known = { ok: await healthy(ep), at: Date.now() }; this.healthyPorts.set(p.pid, known); }
        if (known.ok) { endpoints.push(ep); continue; }
      }
      unreachable.push(p);
    }
    for (const pid of this.healthyPorts.keys()) if (!procs.some((p) => p.pid === pid)) this.healthyPorts.delete(pid);
    const serve = this.serve.endpoint();
    if (serve) endpoints.push(serve);
    const busy = new Map<string, Endpoint>(), pending: Pending[] = [], answering: Endpoint[] = [];
    await Promise.all(endpoints.map(async (ep) => {
      const dirs = ep.via === "serve" ? this.serve.dirs : [ep.directory];
      let reached = false;
      for (const dir of dirs) {
        const get = (path: string) => call(ep, "GET", path, { directory: dir, timeoutMs: 1500 }).then((r) => r.status === 200 ? r.body : null, () => null);
        const [status, questions, permissions] = await Promise.all([get("/session/status"), get("/question"), get("/permission")]);
        if (status === null) continue;
        reached = true;
        for (const [id, s] of Object.entries(status ?? {})) if ((s as any)?.type === "busy" || (s as any)?.type === "retry") busy.set(id, ep);
        for (const q of Array.isArray(questions) ? questions : []) {
          if (typeof q?.id === "string" && typeof q.sessionID === "string") pending.push({ kind: "question", id: q.id, sessionId: q.sessionID, ep, directory: dir, questions: questionsOf(q) });
        }
        for (const p of Array.isArray(permissions) ? permissions : []) {
          if (typeof p?.id === "string" && typeof p.sessionID === "string") {
            pending.push({ kind: "permission", id: p.id, sessionId: p.sessionID, ep, directory: dir, permission: String(p.permission ?? "a tool"),
              patterns: Array.isArray(p.patterns) ? p.patterns.map(String) : [], command: typeof p.metadata?.command === "string" ? p.metadata.command : null });
          }
        }
      }
      // A socket nobody answers on is a crashed process's (or a reused pid's): left out, like a dead one.
      if (reached || ep.via === "serve") answering.push(ep);
    }));
    if ([...busy.values()].some((e) => e.via === "serve") || pending.some((p) => p.ep.via === "serve")) this.serve.lastActive = Date.now();
    return { endpoints: answering, busy, pending, unreachable };
  }

  private async scanOnce(ask: boolean): Promise<void> {
    if (this.closed) return;
    const live = ask ? await this.probe() : this.live;
    if (ask) this.liveAt = Date.now();
    if (this.closed) return;
    const cutoff = this.now() - (this.opts.days ?? 14) * 86_400_000;
    let rows: SessionRow[];
    const views = new Map<string, View>();
    try {
      rows = withDb(this.dbPath, (db) => {
        const found = sessions(db, cutoff, [...live.busy.keys(), ...live.pending.map((p) => p.sessionId)]);
        for (const s of found) {
          const cached = this.cache.get(s.id);
          if (cached?.signature === s.signature) { views.set(s.id, cached.v); continue; }
          const { messages: msgs, parts } = messages(db, s.id);
          const v = view(msgs, parts, s.agent);
          this.cache.set(s.id, { signature: s.signature, v }); views.set(s.id, v);
        }
        this.projectDirs = projectRoots(db);
        return found;
      });
    } catch (e) {
      // Locked past the busy timeout, or not there yet: keep what was read last; the next event or rescan retries.
      if (existsSync(this.dbPath)) this.opts.log(`opencode: couldn't read OpenCode's database (${(e as Error).message}); will retry`);
      else this.rows = new Map();
      this.live = live; this.scannedAt = Date.now(); this.watchPaths(); this.follow(live);
      return;
    }
    this.scannedAt = Date.now();
    this.live = live;
    const next = new Map<string, Row>();
    const linux = process.platform === "linux" && this.opts.scanProcesses !== false;
    for (const s of rows) {
      if (!this.opts.policy.opencode || !visible(this.opts.policy, s.directory) || t3Cwd(s.directory)) continue;
      // `opencode run` is a script's run, not the user's own session, unless Driver made it.
      if (isRunSession(s) && !this.store.startedByDriver(s.id)) continue;
      const overlay = this.store.overlay(s.id);
      if (overlay.archived) continue;
      const v = views.get(s.id)!;
      const pending = live.pending.find((p) => p.sessionId === s.id) ?? null;
      const busyIn = live.busy.get(s.id) ?? null;
      const runner = busyIn?.kind === "run" ? busyIn : null;
      // The process that has it: one running it, else a terminal UI in its folder (one that ran it lately first).
      const tuis = live.endpoints.filter((e) => e.kind === "tui" && (e.directory === s.directory || e.sessions[s.id]))
        .sort((a, b) => (b.sessions[s.id] ?? 0) - (a.sessions[s.id] ?? 0) || b.startedAt - a.startedAt);
      const holder = busyIn && !runner ? busyIn : pending?.ep ?? tuis[0] ?? null;
      const unreachable = !holder && !runner && live.unreachable.some((p) => p.directory === s.directory);
      // Unfinished in the database with nothing reachable running it: running in an OpenCode Driver can't reach, or its
      // process died mid-turn (the database then says so forever). Where folders can't be told, a recent write decides.
      const elsewhere = v.outcome === "incomplete" && !busyIn && (unreachable || (!linux && this.now() - s.updatedAt < 10 * 60_000));
      const waiting = !!pending || (elsewhere && !!v.asking);
      const status: WorkItem["status"] = waiting ? "waiting" : busyIn || elsewhere ? "running" : v.outcome === "incomplete" ? "idle" : v.outcome;
      const updatedAt = new Date(s.updatedAt).toISOString();
      const newer = (at: string | null) => !!at && !!v.lastRunAt && v.lastRunAt > at;
      const item: WorkItem = {
        id: s.id, title: untitled(s.title) ? `an OpenCode session in ${group(s.directory)}` : s.title, group: group(s.directory), status, updatedAt,
        settled: !!overlay.settledAt && !newer(overlay.settledAt),
        snoozedUntil: overlay.snoozedUntil && Date.parse(overlay.snoozedUntil) > this.now() && !waiting && !newer(overlay.snoozedAt) ? overlay.snoozedUntil : null,
        parentId: null, pendingQuestion: waiting, questionId: pending?.id ?? (waiting ? v.asking?.partId ?? null : null), lastRunAt: v.lastRunAt, wroteAt: v.wroteAt,
      };
      next.set(s.id, { s, v, item, holder, runner, pending, unreachable });
    }
    for (const id of this.cache.keys()) if (!rows.some((s) => s.id === id)) this.cache.delete(id);
    this.rows = next; this.refreshPlaces();
    const changed: string[] = []; let urgent = false;
    for (const [id, row] of next) {
      const w = row.item;
      const key = JSON.stringify([w.status, w.title, w.settled, w.snoozedUntil, w.questionId, w.lastRunAt, row.v.reply?.messageId, row.v.reply?.text, !!row.holder, row.unreachable]);
      if (this.keys.get(id) !== key) { changed.push(id); urgent ||= w.pendingQuestion && this.questions.get(id) !== w.questionId; }
      this.keys.set(id, key); this.questions.set(id, w.questionId ?? null);
    }
    for (const id of this.keys.keys()) if (!next.has(id)) { changed.push(id); this.keys.delete(id); this.questions.delete(id); }
    this.watchPaths(); this.follow(live);
    if (changed.length) for (const listener of this.listeners) listener(changed, urgent);
  }

  /** OpenCode's database folder (the database and its write-ahead log) and the plugin's folder, watched for any change. */
  private watchPaths() {
    if (this.closing || this.closed) return;
    const wanted = new Map<string, (name: string | null) => boolean>([
      [dirname(this.dbPath), (name) => !name || name.startsWith(basename(this.dbPath))],
      [this.liveDir, (name) => !name || name.endsWith(".json")],
    ]);
    for (const [path, w] of this.watchers) if (!wanted.has(path)) { w.close(); this.watchers.delete(path); }
    for (const [path, relevant] of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const w = watch(path, { persistent: false }, (_event, name) => { if (relevant(name ? String(name) : null)) this.schedule(); });
        w.on("error", () => { w.close(); this.watchers.delete(path); this.schedule(); });
        this.watchers.set(path, w);
      } catch { /* Not there yet: the periodic rescan finds it. */ }
    }
  }
  /** Each reachable process's event stream: a change there (busy, idle, a question) rescans at once. */
  private follow(live: Live) {
    if (this.closing || this.closed) return;
    const wanted = new Map(live.endpoints.map((e) => [endpointKey(e), e]));
    for (const [key, s] of this.streams) if (!wanted.has(key)) { s.stop(); this.streams.delete(key); }
    for (const [key, ep] of wanted) {
      if (this.streams.has(key) || Date.now() - (this.streamTried.get(key) ?? 0) < 5000) continue;
      this.streamTried.set(key, Date.now());
      const stop = events(ep, ep.via === "serve" ? "/global/event" : "/event", (type) => {
        if (/^(session\.(status|idle|error|created|updated|deleted)|message\.updated|permission\.|question\.)/.test(type)) this.schedule();
      }, () => { if (this.streams.get(key)?.stop === stop) this.streams.delete(key); });
      this.streams.set(key, { stop, endpoint: ep });
    }
    for (const key of this.streamTried.keys()) if (!wanted.has(key)) this.streamTried.delete(key);
  }

  private refreshPlaces() {
    this.roots.clear();
    for (const dir of [...[...this.rows.values()].map((r) => r.s.directory), ...this.projectDirs]) {
      if (t3Cwd(dir) || !existsSync(dir)) continue;
      const root = gitRoot(dir);
      if (root && visible(this.opts.policy, root) && !t3Cwd(root)) this.roots.set(hash(root).slice(0, 12), root);
    }
  }
  places(): Place[] {
    if (!this.loaded || this.closed || !this.opts.policy.opencode || !allows(this.opts.policy, "start_work", "opencode")) return [];
    const roots = [...this.roots].filter(([, root]) => visible(this.opts.policy, root));
    const counts = new Map<string, number>();
    for (const [, root] of roots) counts.set(basename(root), (counts.get(basename(root)) ?? 0) + 1);
    return roots.map(([id, root]) => ({ id, name: basename(root) + ((counts.get(basename(root)) ?? 0) > 1 ? ` (${id})` : ""), folder: folderOf(root),
      activeAt: [...this.rows.values()].filter((r) => gitRoot(r.s.directory) === root).map((r) => r.item.updatedAt).sort().at(-1) ?? null }));
  }

  async list(): Promise<WorkItem[]> { await this.fresh(); return [...this.rows.values()].map((r) => ({ ...r.item })); }
  private row(id: string): Row {
    const row = this.rows.get(id);
    if (!row || !visible(this.opts.policy, row.s.directory)) throw new Error("That session isn't visible to 10 & 2.");
    return row;
  }
  async report(id: string): Promise<Report> {
    await this.fresh();
    const r = this.row(id), p = r.pending;
    const question = p?.kind === "question" ? ask(p.questions) : p?.kind === "permission" ? `OpenCode wants to ${wants(p)}.`
      : r.item.pendingQuestion && r.v.asking ? ask(r.v.asking.questions) : null;
    return { text: r.v.reply?.text ?? "", progress: r.item.status === "running" ? r.v.progress : null, question,
      reply: r.v.reply ? { runId: r.v.reply.runId, messageId: r.v.reply.messageId, at: r.v.reply.at } : null };
  }
  async replies(id: string): Promise<PastReply[]> { await this.fresh(); return this.row(id).v.replies.map((r) => ({ ...r })); }
  async markRead(): Promise<"unsupported"> { return "unsupported"; }
  watch(onChange: (ids: string[], urgent: boolean) => void): () => void { this.listeners.add(onChange); return () => { this.listeners.delete(onChange); }; }

  async check(action: Action): Promise<string | null> {
    if (this.closed || this.closing || !this.loaded) return "OpenCode sessions aren't loaded right now.";
    await this.scan(true);
    return this.preflight(action);
  }
  /** Checks against the last scan. */
  private preflight(action: Action): string | null {
    if (this.closed || this.closing || !this.loaded) return "OpenCode sessions aren't loaded right now.";
    if (!this.opts.policy.opencode) return "OpenCode sessions are disabled on this machine.";
    if (!allows(this.opts.policy, action.kind, "opencode")) return "This machine's local policy doesn't allow that action.";
    if (action.kind === "start_work") {
      if (!this.roots.has(action.placeId)) return "That project isn't visible to 10 & 2.";
      if (!withinCeiling(this.opts.policy, action.profile, "opencode")) return "That launch profile exceeds this machine's permission ceiling.";
      // OpenCode's own worktrees are experimental in 1.19.5 (and outside its session API), so Driver makes a plain one.
      const worktrees = join(this.roots.get(action.placeId)!, ".opencode", "worktrees");
      if (action.profile.workspace === "worktree" && existsSync(worktrees) && !visible(this.opts.policy, worktrees)) return "That project's worktree folder is outside 10 & 2's visible folders.";
      return null;
    }
    const row = this.rows.get(action.itemId);
    if (!row) return "That session isn't visible to 10 & 2.";
    if (action.kind === "snooze" && !Number.isFinite(Date.parse(action.until))) return "That snooze time isn't valid.";
    if (action.kind === "follow_up") return this.followUpRefusal(row);
    return null;
  }
  private followUpRefusal(row: Row): string | null {
    const p = row.pending;
    // Driver never gives a tool permission: that's for the user, in OpenCode.
    if (p?.kind === "permission") return `It's waiting for your OK in OpenCode to ${wants(p)}. 10 & 2 doesn't give that; answer it in OpenCode.`;
    if (p?.kind === "question") return answers(this.opts.policy, "opencode") ? null : "It's asking you a question in OpenCode, and this computer doesn't let 10 & 2 answer questions.";
    if (row.runner) return "It's running in a one-off OpenCode run right now. Try again once that's done.";
    if (row.holder) return steers(this.opts.policy, "opencode") ? null : NO_STEERING;
    if (row.unreachable) return UNREACHABLE;
    if (row.item.pendingQuestion) return "It's asking you something in an OpenCode that 10 & 2 can't reach. Answer it there.";
    // Continued in Driver's own server, which runs under this machine's ceiling: a session whose own rules allow more is refused.
    if (!atMost(reach([{ permission: "*", pattern: "*", action: "allow" }, ...askAll(ceilingFor(this.opts.policy, "opencode")), ...(row.s.permission ?? [])]), ceilingFor(this.opts.policy, "opencode"))) return CAPPED;
    return null;
  }
  /** Follow-ups this machine would refuse right now, per session, from the last scan; checked again on execute. */
  refusals(): Record<string, { follow_up?: string }> {
    if (!this.loaded || this.closed || !allows(this.opts.policy, "follow_up", "opencode")) return {};
    const out: Record<string, { follow_up?: string }> = {};
    for (const [id, row] of this.rows) { const why = this.followUpRefusal(row); if (why) out[id] = { follow_up: why }; }
    return out;
  }

  async execute(action: Action, key: string): Promise<Receipt> {
    if (this.closed || this.closing) return { ok: false, error: "OpenCode adapter is closed." };
    const digest = hash(JSON.stringify(action));
    const prior = this.repeat(key, digest);
    if (prior) return prior;
    const why = await this.check(action);
    if (why) return { ok: false, error: why };
    if (action.kind !== "follow_up" && action.kind !== "start_work") {
      const receipt = this.store.completeOverlay(key, digest, action.itemId, action.kind, new Date(this.now()).toISOString(), action.kind === "snooze" ? action.until : undefined);
      if (!receipt) return this.repeat(key, digest) ?? UNKNOWN;
      void this.safeScan(); return receipt;
    }
    // Reserved before anything is sent: whatever happens next, this key never sends again.
    if (!this.store.begin(key, digest)) return this.repeat(key, digest) ?? UNKNOWN;
    if (action.kind === "start_work") return this.tracked(this.startWork(action, key));
    const row = this.rows.get(action.itemId)!;
    if (row.pending?.kind === "question") return this.tracked(this.answer(action, key, row.pending));
    if (row.holder) return this.tracked(this.message(action, key, row, row.holder));
    return this.tracked(this.continueInServe(action, key, row));
  }
  /** An earlier outcome for this key: its receipt, unknown while it's unfinished, or a refusal for different words. */
  private repeat(key: string, digest: string): Receipt | null {
    const op = this.store.operation(key);
    if (!op) return null;
    return op.hash !== digest ? { ok: false, error: KEY_REUSED } : op.receipt ? JSON.parse(op.receipt) : UNKNOWN;
  }
  private async tracked(pending: Promise<Receipt>): Promise<Receipt> {
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }
  private finish(key: string, receipt: Receipt): Receipt { const r = this.store.finish(key, receipt); void this.safeScan(); return r; }
  /** A call's failure as a receipt: one that never reached OpenCode changed nothing; one lost on the way may have. */
  private failed(key: string, e: unknown, unreached = NOT_REACHED): Receipt {
    return this.finish(key, e instanceof CallError && !e.sent ? { ok: false, error: unreached } : UNKNOWN);
  }

  /**
   * The words as a new user message in the session (`prompt_async`): a busy session queues them, and takes them at its
   * next step or turn. They count as sent once OpenCode records a user message with exactly these words that wasn't
   * there before.
   */
  private async message(action: Extract<Action, { kind: "follow_up" }>, key: string, row: Row, ep: Endpoint): Promise<Receipt> {
    const id = row.s.id, dir = row.s.directory;
    let known: Set<string>;
    try { known = withDb(this.dbPath, (db) => userMessageIds(db, id)); } catch { return this.finish(key, { ok: false, error: "10 & 2 couldn't read OpenCode's sessions just now. Nothing was sent." }); }
    let r;
    try { r = await call(ep, "POST", `/session/${encodeURIComponent(id)}/prompt_async`, { directory: dir, body: { parts: [{ type: "text", text: action.message }] } }); }
    catch (e) { return this.failed(key, e); }
    if (r.status >= 400 && r.status < 500) return this.finish(key, { ok: false, error: "OpenCode didn't take the message. 10 & 2 won't send it again." });
    if (r.status >= 300) return this.finish(key, UNKNOWN);
    if (ep.via === "serve") this.serve.use(dir);
    return this.finish(key, await this.arrived(ep, id, dir, action.message, known) ? { ok: true } : UNKNOWN);
  }
  private async arrived(ep: Endpoint, id: string, dir: string, words: string, known: Set<string>): Promise<boolean> {
    const deadline = Date.now() + (this.opts.acceptanceTimeoutMs ?? 15_000);
    let asked = 0;
    while (Date.now() < deadline && !this.closed) {
      try { if (withDb(this.dbPath, (db) => newUserMessages(db, id, known)).some((m) => m.text === words)) return true; } catch { /* locked: next time */ }
      // The process's own view too, once a second, should the database be slow to show it.
      if (Date.now() - asked > 1000) {
        asked = Date.now();
        try {
          const r = await call(ep, "GET", `/session/${encodeURIComponent(id)}/message`, { directory: dir, timeoutMs: 3000 });
          if (Array.isArray(r.body) && r.body.some((m: any) => m?.info?.role === "user" && !known.has(m.info.id)
            && (m.parts ?? []).filter((p: any) => p?.type === "text" && !p.synthetic).map((p: any) => p.text).join("\n") === words)) return true;
        } catch { /* the database may still show it */ }
      }
      await sleep(100);
    }
    return false;
  }

  /** The answer to OpenCode's question, to the process asking it; whichever answers first (there, or here) wins. */
  private async answer(action: Extract<Action, { kind: "follow_up" }>, key: string, p: Extract<Pending, { kind: "question" }>): Promise<Receipt> {
    let r;
    try { r = await call(p.ep, "POST", `/question/${encodeURIComponent(p.id)}/reply`, { directory: p.directory, body: { answers: answersFor(p.questions, action.message) } }); }
    catch (e) { return this.failed(key, e); }
    if (r.status === 200 && r.body === true) return this.finish(key, { ok: true });
    if (r.status >= 400 && r.status < 500) return this.finish(key, { ok: false, error: "That question was already answered in OpenCode. 10 & 2 didn't send your answer." });
    return this.finish(key, { ok: false, unknown: true, error: "OpenCode may have had its answer already. 10 & 2 won't send it again." });
  }

  /** The rules an agent runs with in this process, or null when it can't be told. */
  private async agentRules(ep: Endpoint, dir: string, agent: string): Promise<Rule[] | null> {
    try {
      const r = await call(ep, "GET", "/agent", { directory: dir, timeoutMs: 5000 });
      const found = Array.isArray(r.body) ? r.body.find((a: any) => a?.name === agent) : null;
      return found && isRules(found.permission) ? found.permission : null;
    } catch { return null; }
  }
  private async serveEndpoint(): Promise<Endpoint> {
    // One started under another ceiling (an earlier policy) is replaced while it has nothing running.
    const permission = serveCeiling(ceilingFor(this.opts.policy, "opencode"));
    if (!this.serve.matches(permission) && ![...this.live.busy.values(), ...this.live.pending.map((p) => p.ep)].some((e) => e.via === "serve")) this.serve.stop();
    return this.serve.ensure();
  }

  /**
   * A session nothing has open, continued in Driver's own server, which runs every agent under this machine's ceiling.
   * The session's agent and its own rules there are checked against the ceiling first; one that may do more is refused.
   */
  private async continueInServe(action: Extract<Action, { kind: "follow_up" }>, key: string, row: Row): Promise<Receipt> {
    let ep: Endpoint;
    try { ep = await this.serveEndpoint(); }
    catch (e) { this.opts.log(`opencode: ${(e as Error).message}`); return this.finish(key, { ok: false, error: "10 & 2 couldn't start OpenCode on this computer." }); }
    this.serve.use(row.s.directory);
    const agent = row.v.agent ?? row.s.agent ?? "build";
    const rules = await this.agentRules(ep, row.s.directory, agent);
    if (!rules) return this.finish(key, { ok: false, error: "10 & 2 can't tell what that session may do, so it won't send to it." });
    if (!atMost(reach([...rules, ...(row.s.permission ?? [])]), ceilingFor(this.opts.policy, "opencode"))) return this.finish(key, { ok: false, error: CAPPED });
    return this.message(action, key, row, ep);
  }

  /**
   * New work: a session made in the project's folder, or a fresh worktree inside it (`.opencode/worktrees/10and2-<id>`,
   * from the policy's `worktreeBase`), with the profile's agent (`plan` for a plan) and rules for its
   * runtime mode, then the words as its first message. Made in an OpenCode terminal open in that folder, if there is
   * one (it shows in its session list there), else in Driver's own server.
   */
  private async startWork(action: Extract<Action, { kind: "start_work" }>, key: string): Promise<Receipt> {
    let root = this.roots.get(action.placeId)!;
    if (action.profile.workspace === "worktree") {
      try { root = await addWorktree(root, join(".opencode", "worktrees"), createHash("sha256").update(key).digest("hex").slice(0, 12), this.opts.policy.worktreeBase ?? "HEAD"); }
      catch (e) { return this.finish(key, { ok: false, error: (e as Error).message }); }
    }
    const tui = this.live.endpoints.filter((e) => e.kind === "tui" && e.directory === root).sort((a, b) => b.startedAt - a.startedAt)[0];
    let ep: Endpoint;
    try { ep = tui ?? await this.serveEndpoint(); }
    catch (e) { this.opts.log(`opencode: ${(e as Error).message}`); return this.finish(key, { ok: false, error: "10 & 2 couldn't start OpenCode on this computer." }); }
    if (ep.via === "serve") this.serve.use(root);
    const plan = action.profile.interactionMode === "plan", agent = plan ? "plan" : "build";
    const agentRules = await this.agentRules(ep, root, agent);
    if (!agentRules) return this.finish(key, { ok: false, error: plan ? "OpenCode here has no plan agent, so 10 & 2 can't start a plan." : "10 & 2 can't tell what OpenCode here would allow, so it won't start work." });
    const rules = sessionRules(action.profile.runtimeMode, agentRules, plan);
    if (!atMost(reach([...agentRules, ...rules]), action.profile.runtimeMode)) return this.finish(key, { ok: false, error: "OpenCode's settings here allow more than that profile, so 10 & 2 won't start it." });
    let made;
    try { made = await call(ep, "POST", "/session", { directory: root, body: { ...(action.title ? { title: action.title } : {}), agent, ...(rules.length ? { permission: rules } : {}) } }); }
    catch (e) { return this.failed(key, e); }
    const id = made.body?.id;
    if (made.status >= 400 && made.status < 500) return this.finish(key, { ok: false, error: "OpenCode didn't start that session. Nothing was sent." });
    if (made.status !== 200 || typeof id !== "string" || !id.startsWith("ses")) return this.finish(key, UNKNOWN);
    this.store.markStarted(id);
    let r;
    try { r = await call(ep, "POST", `/session/${encodeURIComponent(id)}/prompt_async`, { directory: root, body: { agent, parts: [{ type: "text", text: action.message }] } }); }
    catch (e) {
      if (e instanceof CallError && !e.sent) void call(ep, "DELETE", `/session/${encodeURIComponent(id)}`, { directory: root }).catch(() => {});
      return this.failed(key, e);
    }
    if (r.status >= 400 && r.status < 500) {
      void call(ep, "DELETE", `/session/${encodeURIComponent(id)}`, { directory: root }).catch(() => {});
      return this.finish(key, { ok: false, error: "OpenCode didn't take the message. 10 & 2 won't send it again." });
    }
    if (r.status >= 300) return this.finish(key, UNKNOWN);
    return this.finish(key, await this.arrived(ep, id, root, action.message, new Set()) ? { ok: true, itemId: id } : UNKNOWN);
  }

  /** Stops Driver's own server once it has run nothing, and been asked nothing, for a while. */
  private idleCheck() {
    if (!this.serve.running || this.writes.size) return;
    if ([...this.live.busy.values()].some((e) => e.via === "serve") || this.live.pending.some((p) => p.ep.via === "serve")) return;
    if (Date.now() - this.serve.lastActive >= (this.opts.idleMs ?? 10 * 60_000)) this.serve.stop();
  }

  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = this.stop();
    return this.shutdown;
  }
  private async stop(): Promise<void> {
    if (this.rescan) clearInterval(this.rescan);
    if (this.debounce) clearTimeout(this.debounce);
    for (const w of this.watchers.values()) w.close(); this.watchers.clear();
    for (const s of this.streams.values()) s.stop(); this.streams.clear();
    await Promise.allSettled([...this.writes]);
    await this.scanning?.catch(() => {});
    // Driver's own server stops with the connector unless it's still running a turn or waiting on the user: then it's
    // left to finish, and the next connector picks it up (its record is kept) and stops it once it's idle.
    if (this.serve.running) {
      const live = await this.probe().catch(() => null);
      const working = !live || [...live.busy.values()].some((e) => e.via === "serve") || live.pending.some((p) => p.ep.via === "serve");
      if (!working) this.serve.stop();
      else this.opts.log("opencode: leaving the background OpenCode server to finish its turn");
    }
    this.closed = true; this.loaded = false; this.listeners.clear();
    this.store.close();
  }
}

/** Every permission a mode leaves to the user, as rules: what Driver's own server adds to each agent's. */
function askAll(ceiling: RuntimeMode): Rule[] {
  const env = serveCeiling(ceiling);
  return env ? Object.keys(JSON.parse(env)).map((permission): Rule => ({ permission, pattern: "*", action: "ask" })) : [];
}

/**
 * For setup: OpenCode's top-level sessions from the last two weeks, and how many OpenCode terminals Driver can reach
 * now (through the plugin). Read cheaply, starting nothing.
 */
export function openCodeCounts(dataDir?: string, liveDir = defaultLiveDir()): { sessions: number; open: number } {
  let count = 0;
  try {
    count = withDb(dbPathFor(dataDir), (db) => (db.prepare("SELECT count(*) AS n FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND time_updated >= ?").get(Date.now() - 14 * 86_400_000) as { n: number }).n);
  } catch { /* none yet */ }
  const open = new Set(pluginEndpoints(liveDir).filter((e) => e.kind === "tui" && alive(e.pid)).map((e) => e.pid)).size;
  return { sessions: count, open };
}
