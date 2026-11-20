// Reaching a running OpenCode: the processes 10 & 2's plugin announces (a unix socket each, or on Windows 127.0.0.1
// with a token), terminal UIs started with --port, and Driver's own `opencode serve`. Busy state, questions and
// permission requests live only in the memory of the process running a session, so they're asked of it over its HTTP
// API (the v1 routes; never /api/*, a separate runtime that doesn't share their history).
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { execFileCommand } from "../command.ts";

export const defaultLiveDir = (env: NodeJS.ProcessEnv = process.env) => env.TENANDTWO_OPENCODE_DIR
  || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "10and2", "opencode", "live");

export type Kind = "tui" | "serve" | "run" | "other";
export type Endpoint = {
  /** plugin: announced by 10 & 2's plugin; port: a TUI started with --port; serve: Driver's own. */
  via: "plugin" | "port" | "serve";
  kind: Kind; pid: number; socket?: string; url?: string; auth?: string;
  /** The folder this process serves (the plugin's instance, a TUI's working folder), or null for Driver's serve. */
  directory: string | null;
  /** Sessions this process ran lately, by when (the plugin keeps these). */
  sessions: Record<string, number>;
  startedAt: number;
  /** For a process the plugin announced inside one of Driver's own servers: that server's mark (serve.ts). */
  driverServe?: string;
};
export const endpointKey = (e: Endpoint) => `${e.via}:${e.pid}:${e.socket ?? e.url}:${e.directory ?? ""}`;

/**
 * Whether a process is running. A pid that refuses the check (EPERM) is another account's, or one run as administrator.
 * Elsewhere that's still running; on Windows it counts as gone. Windows hands pids out again quickly, and an announce an
 * OpenCode left behind, whose pid another account's process now has, would otherwise send the token and the user's
 * words to whatever that account listens with on its port. An OpenCode run as administrator is left out with it.
 */
export const alive = (pid: unknown, platform: NodeJS.Platform = process.platform): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return platform !== "win32" && (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** A call that failed: `sent` false means it never reached the process, so nothing can have happened. */
export class CallError extends Error {
  readonly sent: boolean;
  constructor(message: string, sent: boolean) { super(message); this.sent = sent; }
}
export type Reply = { status: number; body: any };

export function call(ep: Endpoint, method: string, path: string, opts: { body?: unknown; directory?: string | null; timeoutMs?: number } = {}): Promise<Reply> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.directory) headers["x-opencode-directory"] = encodeURIComponent(opts.directory);
  if (ep.auth) headers.authorization = ep.auth;
  let data: Buffer | undefined;
  if (opts.body !== undefined) { data = Buffer.from(JSON.stringify(opts.body)); headers["content-type"] = "application/json"; headers["content-length"] = String(data.length); }
  const target = ep.socket ? { socketPath: ep.socket } : { host: new URL(ep.url!).hostname, port: Number(new URL(ep.url!).port) };
  return new Promise((resolvePromise, reject) => {
    let connected = false;
    const req = httpRequest({ ...target, method, path, headers }, (res) => {
      let out = ""; res.setEncoding("utf8");
      res.on("data", (c) => { if (out.length < 8 * 1024 * 1024) out += c; });
      res.on("end", () => { let body: any = out; try { body = out ? JSON.parse(out) : null; } catch { /* text */ } resolvePromise({ status: res.statusCode ?? 0, body }); });
      res.on("error", () => reject(new CallError("connection lost", true)));
    });
    req.on("socket", (s) => { if (!s.connecting) connected = true; else s.once("connect", () => { connected = true; }); });
    req.on("error", (e) => reject(new CallError(e.message, connected)));
    req.setTimeout(opts.timeoutMs ?? 10_000, () => req.destroy(new Error("timed out")));
    req.end(data);
  });
}

// Where the plugin serves on Windows: this computer only, with the token it made.
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]+$/;

/**
 * The processes 10 & 2's plugin announced that are still running and can still be reached: by their socket, or on
 * Windows (where Bun's socket is a kind Node can't open) at 127.0.0.1 with their token.
 */
export function pluginEndpoints(dir: string, platform: NodeJS.Platform = process.platform): Endpoint[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^\d+-\d+\.json$/.test(f)); } catch { return []; }
  const out: Endpoint[] = [];
  for (const f of files) {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!alive(a.pid, platform) || typeof a.directory !== "string") continue;
      const where = platform !== "win32" && typeof a.socket === "string" && existsSync(a.socket) ? { socket: a.socket as string }
        : typeof a.url === "string" && LOOPBACK.test(a.url) && typeof a.auth === "string" && BEARER.test(a.auth) ? { url: a.url as string, auth: a.auth as string } : null;
      if (!where) continue;
      out.push({ via: "plugin", kind: ["tui", "serve", "run"].includes(a.kind) ? a.kind : "other", pid: a.pid, ...where, directory: a.directory,
        sessions: a.sessions && typeof a.sessions === "object" ? a.sessions : {}, startedAt: typeof a.startedAt === "number" ? a.startedAt : 0,
        ...typeof a.driverServe === "string" ? { driverServe: a.driverServe as string } : {} });
    } catch { /* being written, or not ours: the next read */ }
  }
  return out;
}

/** An `opencode` process of this user's, as `ps` shows it. */
export type Proc = { pid: number; kind: Kind; port: number | null; host: string; directory: string | null };
const COMMANDS = new Set(["acp", "mcp", "attach", "run", "debug", "auth", "agent", "upgrade", "uninstall", "serve", "web", "models", "stats", "export", "import", "github", "pr", "session", "db", "plugin", "completion", "generate"]);
const VALUED = new Set(["--port", "--hostname", "-m", "--model", "--agent", "-s", "--session", "--prompt", "--log-level", "--mdns-domain", "--cors"]);

/**
 * An `opencode` process from its command line, as `ps` gives it: POSIX paths, so they're resolved as such whatever
 * this system is; a Windows path (`C:\...\opencode.exe ..\other`) is resolved as Windows does.
 */
export function parseProc(pid: number, args: string, cwd: string | null): Proc | null {
  const words = args.trim().split(/\s+/);
  let i = 0;
  if (/(^|[\\/])(node|bun)(\.exe)?$/i.test(words[0] ?? "")) i = 1;
  if (!/(^|[\\/])opencode(\.exe)?$/i.test(words[i] ?? "")) return null;
  const rest = words.slice(i + 1);
  let positional: string | null = null;
  for (let j = 0; j < rest.length; j++) {
    if (VALUED.has(rest[j]!)) { j++; continue; }
    if (!rest[j]!.startsWith("-")) { positional = rest[j]!; break; }
  }
  const command = positional && COMMANDS.has(positional) ? positional : null;
  const kind: Kind = command === null ? "tui" : command === "serve" || command === "web" ? "serve" : command === "run" ? "run" : "other";
  const flag = (name: string) => { const k = rest.findIndex((w) => w === name || w.startsWith(name + "=")); return k < 0 ? null : rest[k]!.includes("=") ? rest[k]!.split("=")[1]! : rest[k + 1] ?? null; };
  const port = Number(flag("--port") ?? 0) || null;
  const h = flag("--hostname") ?? "127.0.0.1";
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd ?? positional ?? "") ? win32 : posix;
  const project = kind === "tui" && positional ? (paths.isAbsolute(positional) ? positional : cwd ? paths.resolve(cwd, positional) : null) : null;
  return { pid, kind, port, host: h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h, directory: project ?? cwd };
}

/**
 * This user's `opencode` processes. Their working folder is read on Linux only (elsewhere it's unknown, null). None on
 * Windows, which has no `ps`: there only the plugin's processes are reached (as on a Mac, a terminal UI without it is
 * one 10 & 2 can't tell is open).
 */
export function processes(): Promise<Proc[]> {
  const uid = process.getuid?.();
  if (process.platform === "win32" || uid === undefined) return Promise.resolve([]);
  return new Promise((resolvePromise) => {
    execFileCommand("ps", ["-U", String(uid), "-o", "pid=,args="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolvePromise([]);
      const out: Proc[] = [];
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m || !/opencode/.test(m[2]!) || Number(m[1]) === process.pid) continue;
        let cwd: string | null = null;
        if (process.platform === "linux") { try { cwd = readlinkSync(`/proc/${m[1]}/cwd`); } catch { /* gone or not ours */ } }
        const p = parseProc(Number(m[1]), m[2]!, cwd);
        if (p) out.push(p);
      }
      resolvePromise(out);
    });
  });
}

/** Follows a process's event stream; calls `onEvent` with each event's type and properties, `onClose` once it ends. */
export function events(ep: Endpoint, path: string, onEvent: (type: string, props: any) => void, onClose: () => void): () => void {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (ep.auth) headers.authorization = ep.auth;
  if (ep.directory && ep.via !== "serve") headers["x-opencode-directory"] = encodeURIComponent(ep.directory);
  const target = ep.socket ? { socketPath: ep.socket } : { host: new URL(ep.url!).hostname, port: Number(new URL(ep.url!).port) };
  let closed = false;
  const done = () => { if (!closed) { closed = true; onClose(); } };
  const req = httpRequest({ ...target, method: "GET", path, headers }, (res: IncomingMessage) => {
    if (res.statusCode !== 200) { res.resume(); done(); return; }
    let buf = ""; res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) buf = "";
      for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { const e = JSON.parse(line.slice(5).trim()); const p = e?.payload ?? e; if (typeof p?.type === "string") onEvent(p.type, p.properties ?? {}); } catch { /* not an event */ }
      }
    });
    res.on("end", done); res.on("error", done);
  });
  req.on("error", done);
  req.end();
  return () => { closed = true; req.destroy(); };
}

/** Whether a process at this address answers as OpenCode. */
export async function healthy(ep: Endpoint, timeoutMs = 1500): Promise<boolean> {
  try { const r = await call(ep, "GET", "/global/health", { timeoutMs }); return r.status === 200 && r.body?.healthy === true; } catch { return false; }
}
