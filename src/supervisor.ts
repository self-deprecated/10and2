// Starting at login on Windows (docs/launch/windows.md, "Starting at login"). Windows' startup entry runs `10and2
// login-service connector` (or `brain`), which starts itself again without a window and becomes the supervisor: it runs
// the connector (or the brain) as its child, as systemd's unit does elsewhere. The child's output goes to a log file, a
// crash is restarted but an exit of 0 or 78 isn't, and a private pipe takes `status`, `restart` and `stop`.
import type { ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { envVar, spawnCommand } from "./command.ts";
import { stateDirectory } from "./paths.ts";
import type { Job } from "./service.ts";
import { proof, proves, randomHex, replaceFile } from "./util.ts";

/** Set for the supervisor itself: the copy that's already hidden supervises instead of starting itself again. */
export const HIDDEN = "TENANDTWO_LOGIN_SERVICE";

/**
 * The restart policy's times, in ms: the first wait, the longest, how long a run counts as settled, and the stop's grace;
 * and how long to wait between tries for its control pipe's name.
 */
export type Timing = { first: number; most: number; settled: number; grace: number; retry: number };
const TIMING: Timing = { first: 5_000, most: 300_000, settled: 600_000, grace: 5_000, retry: 500 };

/** How long to wait before starting it again: 5 s, doubling to 5 minutes, and 5 s again after it had run 10 minutes. */
export function backoff(previous: number | null, ranFor: number, t: Timing = TIMING): number {
  return previous === null || ranFor >= t.settled ? t.first : Math.min(previous * 2, t.most);
}

/**
 * Whether an exit is a crash to start it again after: anything but 0 and 78 (revoked, replaced by another copy, or a
 * brain this version can't talk to), as systemd's Restart=on-failure with RestartPreventExitStatus=78. Windows ends a
 * killed process with 1, so that counts as a crash.
 */
export const restartsAfter = (code: number | null) => code !== 0 && code !== 78;

/** The PATH setup saw, then the login's own, each folder once: `t3` and `claude` are found as they were at setup. */
export function mergePath(saved: string, current: string, platform: NodeJS.Platform = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  return [...saved.split(sep), ...current.split(sep)].filter((dir) => {
    // Windows' folder names ignore case.
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (!dir || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(sep);
}

/** `env` with its PATH replaced under the name it already has (Windows' is `Path`), so the child doesn't get two. */
export function withPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: path };
}

/** Starts a fresh log once it's over `max` bytes, keeping the one before beside it (`<log>.1`). */
export function rotate(log: string, max = 5 * 1024 * 1024) {
  try { if (statSync(log).size <= max) return; } catch { return; }
  try { renameSync(log, `${log}.1`); } catch { /* another program has the old one open: next start */ }
}

/**
 * What `autostart on` keeps for the supervisor: the token its control pipe is named from, the secret it proves itself
 * with on that pipe (a name proves nothing: other accounts can list pipes' names and take one that's free), and the
 * PATH setup saw.
 */
type Saved = { token: string; secret: string; path: string };
export const loginFile = (job: Job, env: NodeJS.ProcessEnv = process.env) => join(stateDirectory(env), `login-${job.name}.json`);
export const logFile = (job: Job, env: NodeJS.ProcessEnv = process.env) => join(stateDirectory(env), job.logName);

export function readLogin(file: string): Partial<Saved> {
  const hex = (s: unknown) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s) ? s : undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { token: hex(raw?.token), secret: hex(raw?.secret), path: typeof raw?.path === "string" ? raw.path : undefined };
  } catch { return {}; }
}

/** Keeps `path` when given (else the saved one), the token and the secret, each made the first time; `fresh` makes a new token. */
export function saveLogin(file: string, path?: string, fresh = false): Saved {
  const old = readLogin(file);
  const saved = { token: fresh ? randomHex() : old.token ?? randomHex(), secret: old.secret ?? randomHex(), path: path ?? old.path ?? "" };
  if (saved.token !== old.token || saved.secret !== old.secret || saved.path !== old.path) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved) + "\n", { mode: 0o600 });
    replaceFile(tmp, file);
  }
  return saved;
}

/**
 * Where a job's supervisor listens. On Windows a pipe named from the private token: anyone could create a pipe with a
 * name they can guess before the supervisor does, and be asked in its place (and since other accounts can list pipes'
 * names, the supervisor also proves itself: ask). Elsewhere, where only the tests run a supervisor, a socket file in
 * the private state folder.
 */
export function controlPipe(job: Job, token: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\10and2-${job.name}-${token}` : join(stateDirectory(env), `${job.name}.sock`);
}

/**
 * Sends a supervisor one line and resolves with its one-line answer, or null when none answers within `ms`. The line
 * goes with a fresh nonce, and an answer counts only with proof(secret, nonce) before it: anything else on the pipe's
 * name (another account's pipe, once the supervisor has gone) is no supervisor.
 */
export function ask(pipe: string, line: string, secret: string, ms = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let got = "";
    let timer: NodeJS.Timeout | undefined;
    const nonce = randomHex();
    const socket = createConnection(pipe);
    const done = (answer: string | null) => { clearTimeout(timer); socket.destroy(); resolve(answer); };
    const proved = (answer: string) => {
      const space = answer.indexOf(" ");
      return space > 0 && proves(answer.slice(0, space), secret, nonce) ? answer.slice(space + 1) : null;
    };
    timer = setTimeout(() => done(null), ms);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${nonce} ${line}\n`));
    socket.on("data", (d) => { got += d; const end = got.indexOf("\n"); if (end >= 0) done(proved(got.slice(0, end))); else if (got.length > 64 * 1024) done(null); });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

export type Supervision = {
  name: string; pipe: string; secret: string; command: string[]; env: NodeJS.ProcessEnv; log: string; timing?: Partial<Timing>;
  /** A new pipe to listen on, for when something that can't prove it's a supervisor keeps `pipe`'s name. */
  renew: () => string;
  platform?: NodeJS.Platform;
};

/**
 * Runs `command` until it exits 0 or 78, or "stop" arrives on `pipe`, starting it again after a crash; resolves then,
 * or at once when another supervisor has `pipe`. On the pipe, one line in and one out: a nonce and "status" (this pid,
 * the child's or null, and since when it runs), "restart" or "stop", answered with proof(secret, nonce) and the answer
 * ("ok" once a restart or stop is done).
 */
export async function supervise(o: Supervision): Promise<void> {
  const t = { ...TIMING, ...o.timing };
  const note = (s: string) => { try { appendFileSync(o.log, `${new Date().toISOString()} login-service: ${s}\n`); } catch { /* no log */ } };
  try { mkdirSync(dirname(o.log), { recursive: true, mode: 0o700 }); } catch { /* it runs without a log */ }

  let child: ChildProcess | null = null;
  let since: string | null = null;
  let exited = Promise.resolve();
  let delay: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  // A stop or restart is ending the child, so its exit isn't a crash.
  let busy = false;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let finish = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const handle = (line: string): Promise<string> => {
    if (line === "status") return Promise.resolve(JSON.stringify({ pid: process.pid, child: child?.pid ?? null, since }));
    if (line !== "restart" && line !== "stop") return Promise.resolve("unknown");
    // One at a time: a second restart waits for the first.
    const answer = queue.then(async () => {
      if (closed) return "stopped";
      note(`${line === "stop" ? "stopping" : "restarting"} the ${o.name}`);
      busy = true;
      await stopChild();
      busy = false;
      if (line === "stop") { close(); return "ok"; }
      delay = null;
      start();
      return "ok";
    });
    queue = answer.catch(() => {});
    return answer;
  };
  const server: Server = createServer((socket) => {
    let got = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (d) => {
      if (got.includes("\n")) return;
      got += d;
      const end = got.indexOf("\n");
      if (end < 0) { if (got.length > 64) socket.destroy(); return; }
      const asked = /^([0-9a-f]{32}) (\S+)$/.exec(got.slice(0, end).trim());
      if (!asked) { socket.destroy(); return; }
      void handle(asked[2]!).then((answer) => socket.end(`${proof(o.secret, asked[1]!)} ${answer}\n`));
    });
  });

  let pipe = o.pipe;
  for (let tries = 0; ; tries++) {
    // One supervisor per job: a second (another `autostart on`, the same account signed in twice) leaves it to the first.
    if (await ask(pipe, "status", o.secret) !== null) return;
    // A socket file outlives its process (only off Windows); a pipe goes with it.
    if ((o.platform ?? process.platform) !== "win32") rmSync(pipe, { force: true });
    // Each try's listeners go with it, so many tries don't pile them up.
    const failed = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const listening = () => { server.off("error", refused); resolve(null); };
      const refused = (e: NodeJS.ErrnoException) => { server.off("listening", listening); resolve(e); };
      server.once("error", refused).once("listening", listening);
      server.listen(pipe);
    });
    if (!failed) break;
    // A pipe's name stays taken for a moment after its supervisor stopped, until its last connection closes. Taken
    // for longer by something that doesn't prove it's this job's supervisor (another account's pipe, which can't be
    // removed), it listens on a new name.
    if (failed.code !== "EADDRINUSE" || tries >= 20) { note(`couldn't listen for its controls (${failed.message})`); return; }
    if (tries === 10) { pipe = o.renew(); note("something else has its control pipe's name; listening on a new one"); }
    await sleep(t.retry);
  }
  server.on("error", () => {});

  function start() {
    timer = undefined;
    rotate(o.log);
    const began = Date.now();
    let out: number | "ignore" = "ignore";
    try { out = openSync(o.log, "a", 0o600); } catch { /* it runs without a log */ }
    let c: ChildProcess;
    try {
      // Not detached: it ends with the supervisor (on Windows, in the supervisor's job). What it starts detached, such
      // as Claude Code runs, carries on through a restart.
      c = spawnCommand(o.command[0]!, o.command.slice(1), { env: o.env, stdio: ["ignore", out, out, "ipc"] });
    } catch (e) {
      ended(null, `couldn't start (${(e as Error).message})`, 0);
      return;
    } finally {
      if (out !== "ignore") closeSync(out);
    }
    child = c;
    since = new Date(began).toISOString();
    exited = new Promise((resolve) => {
      let over = false;
      const end = (code: number | null, why: string) => {
        if (over) return;
        over = true;
        child = null;
        since = null;
        resolve();
        ended(code, why, Date.now() - began);
      };
      c.on("exit", (code, signal) => end(code, signal ? `ended by ${signal}` : `exited ${code}`));
      // Only a child that never started has no pid; other errors (a failed kill) leave it running.
      c.on("error", (e) => { if (c.pid === undefined) end(null, `couldn't start (${e.message})`); });
    });
  }
  function ended(code: number | null, why: string, ranFor: number) {
    if (busy || closed) return;
    if (!restartsAfter(code)) { note(`the ${o.name} ${why}; not starting it again`); close(); return; }
    delay = backoff(delay, ranFor, t);
    note(`the ${o.name} ${why}; starting it again in ${delay / 1000} s`);
    timer = setTimeout(start, delay);
  }
  /**
   * Asks the child to shut down, which it does as on SIGTERM (T3's session revoked, the ledger closed: Windows never
   * delivers SIGTERM), and ends it if it hasn't after the grace period.
   */
  async function stopChild() {
    clearTimeout(timer);
    timer = undefined;
    const c = child;
    if (!c) return;
    const kill = setTimeout(() => { note(`the ${o.name} didn't stop within ${t.grace / 1000} s; ending it`); c.kill("SIGKILL"); }, t.grace);
    c.send("stop", (e) => { if (e) c.kill("SIGKILL"); });
    await exited;
    clearTimeout(kill);
  }
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    finish();
  }

  start();
  await finished;
}

/**
 * `10and2 login-service connector|brain`, which Windows' startup entry runs at each login. Its console window stays
 * until it exits, so it starts itself again without one and exits (a window shows for about a second). That copy
 * supervises the job, with the PATH setup saw ahead of the login's own.
 */
export async function loginService(job: Job, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const self = [process.execPath, ...process.execArgv, process.argv[1]!];
  if (env[HIDDEN] !== "1") {
    spawnCommand(self[0]!, [...self.slice(1), "login-service", job.name], { detached: true, stdio: "ignore", cwd: homedir(), env: { ...env, [HIDDEN]: "1" } })
      .on("error", () => {}).unref();
    return;
  }
  const { [HIDDEN]: _, ...rest } = env;
  const file = loginFile(job, env), saved = saveLogin(file);
  await supervise({
    name: job.name, pipe: controlPipe(job, saved.token, env), secret: saved.secret, command: [...self, ...job.args], log: logFile(job, env),
    env: withPath(rest, mergePath(saved.path, envVar(env, "PATH") ?? "")),
    // A new token, saved where `autostart` and `status` read it.
    renew: () => controlPipe(job, saveLogin(file, undefined, true).token, env),
  });
}

/**
 * Takes a request to stop that isn't SIGTERM as SIGTERM, so its handlers run (T3's session revoked, the ledger closed,
 * the brain's calls hung up): the supervisor's "stop" over IPC, since Windows never delivers SIGTERM, and on Windows
 * Ctrl-Break (SIGBREAK) and closing the console (SIGHUP). Before any SIGTERM handler is there, it exits, as SIGTERM
 * would. The IPC channel doesn't keep it running once its work is done.
 */
export function stopLikeSigterm(platform: NodeJS.Platform = process.platform) {
  const term = () => { if (!process.emit("SIGTERM")) process.exit(0); };
  if (process.channel) {
    process.on("message", (m) => { if (m === "stop") term(); });
    process.channel.unref();
  }
  if (platform === "win32") for (const signal of ["SIGHUP", "SIGBREAK"] as const) process.on(signal, term);
}
