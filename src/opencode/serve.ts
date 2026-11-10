// Driver's own `opencode serve`, for sessions nothing has open: started when first needed, on 127.0.0.1 at a free port
// with a random password (HTTP Basic, user "opencode"), reused for every call and stopped once it has had nothing to do
// for a while. One server serves any folder (each call names it). Its record (pid, port, password, the folders it was
// given) is kept in a private file, so a connector that restarts picks up a server still finishing a turn instead of
// starting a second one; the password never leaves that file and the process's environment.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { alive, healthy } from "./live.ts";
import type { Endpoint } from "./live.ts";

type Record_ = { pid: number; port: number; password: string; ceiling: string | null; startedAt: number; dirs: string[] };

export type ServeOptions = {
  bin: string; stateDir: string; log: (m: string) => void;
  /** OPENCODE_PERMISSION for it (rules.ts serveCeiling), or null. */
  permission: string | null;
  startTimeoutMs?: number;
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Serve {
  private readonly opts: ServeOptions;
  private readonly file: string;
  private readonly logFile: string;
  private rec: Record_ | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<Endpoint> | null = null;
  /** When it was last given work or seen busy. */
  lastActive = 0;

  constructor(opts: ServeOptions) {
    this.opts = opts;
    this.file = join(opts.stateDir, "serve.json");
    this.logFile = join(opts.stateDir, "serve.log");
    try {
      const r = JSON.parse(readFileSync(this.file, "utf8"));
      // Only a process that is still that server is picked up: after a reboot its pid may be anyone's.
      if (typeof r.password === "string" && Number.isInteger(r.port) && isServe(r.pid, r.port)) { this.rec = { ...r, dirs: Array.isArray(r.dirs) ? r.dirs : [] }; this.lastActive = Date.now(); }
      else unlinkSync(this.file);
    } catch { /* none kept */ }
  }

  get pid(): number | null { return this.rec?.pid ?? null; }
  get dirs(): string[] { return this.rec?.dirs ?? []; }
  /** The server, when one is running (it may not have answered yet). */
  endpoint(): Endpoint | null {
    if (!this.rec) return null;
    if (!alive(this.rec.pid)) { this.forget(); return null; }
    return { via: "serve", kind: "serve", pid: this.rec.pid, url: `http://127.0.0.1:${this.rec.port}`,
      auth: "Basic " + Buffer.from(`opencode:${this.rec.password}`).toString("base64"), directory: null, sessions: {}, startedAt: this.rec.startedAt };
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
    if (have) this.stop();
    this.starting ??= this.spawn().finally(() => { this.starting = null; });
    return this.starting;
  }
  /** Whether it was started with this ceiling. */
  matches(permission: string | null): boolean { return !this.rec || this.rec.ceiling === permission; }

  private async spawn(): Promise<Endpoint> {
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    const port = await freePort(), password = randomBytes(24).toString("hex");
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" };
    if (this.opts.permission) env.OPENCODE_PERMISSION = this.opts.permission;
    const log = openSync(this.logFile, "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(this.opts.bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: homedir(), detached: true, env, stdio: ["ignore", log, log] });
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
        this.rec = { pid: child.pid!, port, password, ceiling: this.opts.permission, startedAt: Date.now(), dirs: [] };
        this.save(); this.lastActive = Date.now();
        this.opts.log(`opencode: started a background OpenCode server (pid ${child.pid}, port ${port})`);
        return this.endpoint()!;
      }
      await sleep(100);
    }
    try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill(); } catch { /* gone */ } }
    throw new Error(failed ? `OpenCode couldn't start (${failed})` : "OpenCode didn't start in time");
  }

  private save() {
    if (!this.rec) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rec), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private forget() {
    this.rec = null;
    try { unlinkSync(this.file); } catch { /* gone */ }
  }
  /** Stops it, with what it started (its process group), if that process is still the server. */
  stop() {
    const pid = this.rec?.pid, port = this.rec?.port;
    const mine = !!pid && (this.child?.pid === pid || isServe(pid, port!));
    this.forget(); this.child = null;
    if (!pid || !mine) return;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    this.opts.log(`opencode: stopped the background OpenCode server (pid ${pid})`);
  }
  get running(): boolean { return this.endpoint() !== null; }
}

/** Whether `pid` is an `opencode serve` on this port: its command line says so. */
function isServe(pid: unknown, port: number): boolean {
  if (!alive(pid)) return false;
  let args = "";
  try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); }
  catch { try { args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2000 }); } catch { return false; } }
  return /\bserve\b/.test(args) && args.includes(`--port ${port}`);
}
