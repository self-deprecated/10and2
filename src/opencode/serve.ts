// Driver's own `opencode serve`, for sessions nothing has open: started when first needed, on 127.0.0.1 at a free port
// with a random password (HTTP Basic, user "opencode"), reused for every call and stopped once it has had nothing to do
// for a while. One server serves any folder (each call names it). Its record (pid, port, password, the folders it was
// given) is kept in a private file, so a connector that restarts picks up a server still finishing a turn instead of
// starting a second one; the password never leaves that file and the process's environment.
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileCommand, spawnCommand, which } from "../command.ts";
import { describe, replaceFile } from "../util.ts";
import { alive, healthy } from "./live.ts";
import type { Endpoint } from "./live.ts";

/** `mark`: put in the server's environment, which 10 & 2's plugin inside it announces, so it isn't taken for a user's own. */
type Record_ = { pid: number; port: number; password: string; mark?: string; ceiling: string | null; startedAt: number; dirs: string[] };

export type ServeOptions = {
  /** How OpenCode is run: `opencode` on PATH, or a program and its first arguments (tests). */
  command: string[]; stateDir: string; log: (m: string) => void;
  /** OPENCODE_PERMISSION for it (rules.ts serveCeiling), or null. */
  permission: string | null;
  startTimeoutMs?: number;
  /** The system it's on (tests try Windows' way on Linux). */
  platform?: NodeJS.Platform;
  /** Runs a program to its end, saying whether it succeeded (tests watch what's run). */
  run?: (command: string, args: string[]) => Promise<boolean>;
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (command: string, args: string[]) => new Promise<boolean>((done) => { execFileCommand(command, args, { timeout: 10_000 }, (err) => done(!err)); });
const endpointOf = (r: Record_): Endpoint => ({ via: "serve", kind: "serve", pid: r.pid, url: `http://127.0.0.1:${r.port}`,
  auth: "Basic " + Buffer.from(`opencode:${r.password}`).toString("base64"), directory: null, sessions: {}, startedAt: r.startedAt });

export class Serve {
  private readonly opts: ServeOptions;
  private readonly file: string;
  private readonly logFile: string;
  private readonly windows: boolean;
  private rec: Record_ | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<Endpoint> | null = null;
  /** When it was last given work or seen busy. */
  lastActive = 0;

  constructor(opts: ServeOptions) {
    this.opts = opts;
    this.windows = (opts.platform ?? process.platform) === "win32";
    this.file = join(opts.stateDir, "serve.json");
    this.logFile = join(opts.stateDir, "serve.log");
    try {
      const r = JSON.parse(readFileSync(this.file, "utf8"));
      // Only a process that is still that server is picked up: after a reboot its pid may be anyone's. Windows has no
      // command line to read cheaply, so there a live pid is taken for now, and it must answer with the password before
      // it's used (ensure) or stopped (stop).
      const valid = typeof r.password === "string" && Number.isInteger(r.port) && Number.isInteger(r.pid);
      if (valid && (this.windows ? alive(r.pid) : isServe(r.pid, r.port))) { this.rec = { ...r, dirs: Array.isArray(r.dirs) ? r.dirs : [] }; this.lastActive = Date.now(); }
      else unlinkSync(this.file);
    } catch { /* none kept */ }
  }

  get pid(): number | null { return this.rec?.pid ?? null; }
  /** What the plugin inside it announces it as. */
  get mark(): string | null { return this.rec?.mark ?? null; }
  get dirs(): string[] { return this.rec?.dirs ?? []; }
  /** The server, when one is running (it may not have answered yet). */
  endpoint(): Endpoint | null {
    if (!this.rec) return null;
    if (!alive(this.rec.pid)) { this.forget(); return null; }
    return endpointOf(this.rec);
  }
  /** Remembers a folder it was given, so its sessions there are asked about. */
  use(dir: string) {
    this.lastActive = Date.now();
    if (this.rec && !this.rec.dirs.includes(dir)) { this.rec.dirs.push(dir); this.save(); }
  }

  /** The running server, starting one if there's none (or the one recorded doesn't answer with its password). */
  async ensure(): Promise<Endpoint> {
    const have = this.endpoint();
    if (have && await healthy(have)) {
      // One started under another ceiling is replaced, once it's idle (the caller checks); until then it's still checked per session.
      return have;
    }
    if (have) await this.stop();
    this.starting ??= this.spawn().finally(() => { this.starting = null; });
    return this.starting;
  }
  /** Whether it was started with this ceiling. */
  matches(permission: string | null): boolean { return !this.rec || this.rec.ceiling === permission; }

  private async spawn(): Promise<Endpoint> {
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const port = await freePort(), password = randomBytes(24).toString("hex"), mark = randomBytes(8).toString("hex");
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode", TENANDTWO_OPENCODE_SERVE: mark };
    if (this.opts.permission) env.OPENCODE_PERMISSION = this.opts.permission;
    const [bin, ...first] = this.opts.command;
    // Windows looks for a bare name in the current folder before PATH; one that isn't on PATH isn't run from there.
    if (process.platform === "win32" && !which(bin!, env)) throw new Error(`OpenCode couldn't start (${bin} isn't on PATH)`);
    const log = openSync(this.logFile, "w", 0o600);
    let child: ChildProcess;
    try {
      // Detached, so it finishes a turn after the connector stops; with no window of its own on Windows (spawnCommand).
      child = spawnCommand(bin!, [...first, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: homedir(), detached: true, env, stdio: ["ignore", log, log] });
    } finally { closeSync(log); }
    let failed: string | null = null;
    child.on("error", (e) => { failed = e.message; });
    child.on("exit", (code) => { failed ??= `exited ${code}`; if (this.child === child) this.child = null; if (this.rec?.pid === child.pid) this.forget(); });
    child.unref();
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000);
    while (Date.now() < deadline && !failed) {
      let out = "";
      try { out = readFileSync(this.logFile, "utf8"); } catch { /* not yet */ }
      if (new RegExp(`listening on http://127\\.0\\.0\\.1:${port}\\b`).test(out)) {
        this.child = child;
        this.rec = { pid: child.pid!, port, password, mark, ceiling: this.opts.permission, startedAt: Date.now(), dirs: [] };
        this.save(); this.lastActive = Date.now();
        this.opts.log(`opencode: started a background OpenCode server (pid ${child.pid}, port ${port})`);
        return this.endpoint()!;
      }
      await sleep(100);
    }
    if (child.pid) await this.kill(child.pid);
    throw new Error(failed ? `OpenCode couldn't start (${failed})` : "OpenCode didn't start in time");
  }

  /** Keeps the record. One that can't be written leaves this connector using the server all the same. */
  private save() {
    if (!this.rec) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(this.rec), { mode: 0o600 }); replaceFile(tmp, this.file); }
    catch (e) { this.opts.log(`opencode: couldn't keep the background OpenCode server's record (${describe(e)})`); }
  }
  private forget() {
    this.rec = null;
    try { unlinkSync(this.file); } catch { /* gone */ }
  }
  /**
   * Stops it, with what it started, if that process is still the server. `patient: false` (the connector shutting
   * down) skips the longer second check below: Windows' supervisor ends a connector that hasn't stopped within 5 s.
   */
  async stop(patient = true): Promise<void> {
    const rec = this.rec, child = this.child;
    this.forget(); this.child = null;
    if (!rec) return;
    // On Windows a server this connector didn't start is known only by answering with its password. One slow to answer
    // (hung, or busy) is asked once more and given longer before it's left running and no longer tracked; its pid goes
    // in the log then, so a server left behind can be found.
    const answers = async () => await healthy(endpointOf(rec)) || (patient && await healthy(endpointOf(rec), 5000));
    const mine = child?.pid === rec.pid || (this.windows ? alive(rec.pid) && await answers() : isServe(rec.pid, rec.port));
    if (!mine) {
      if (this.windows && alive(rec.pid)) this.opts.log(`opencode: left process ${rec.pid} running: it didn't answer as the background OpenCode server`);
      return;
    }
    await this.kill(rec.pid);
    this.opts.log(`opencode: stopped the background OpenCode server (pid ${rec.pid})`);
  }
  /**
   * Ends a server and what it started: its process group, or on Windows (no groups there, and a negative pid is
   * refused) its process tree, as OpenCode ends its own children there (`taskkill /T /F`).
   */
  private async kill(pid: number): Promise<void> {
    if (this.windows) {
      if (await (this.opts.run ?? run)("taskkill", ["/pid", String(pid), "/T", "/F"])) return;
      try { process.kill(pid); } catch { /* gone */ }
      return;
    }
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  }
  get running(): boolean { return this.endpoint() !== null; }
}

/** Whether `pid` is an `opencode serve` on this port: its command line says so (Linux, macOS). */
function isServe(pid: unknown, port: number): boolean {
  if (!alive(pid)) return false;
  let args = "";
  try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); }
  catch { try { args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2000 }); } catch { return false; } }
  return /\bserve\b/.test(args) && args.includes(`--port ${port}`);
}
