// 10and2 OpenCode plugin (installed by `10and2 opencode install`)
//
// Lets 10 & 2's connector reach the OpenCode running on this computer: a terminal UI has no server anyone else can
// reach, so this puts the server OpenCode runs inside each process (TUI, `serve`, `run`) on a private unix socket and
// announces it in a JSON file beside it, in ~/.local/state/10and2/opencode/live/ (or $XDG_STATE_HOME/10and2/...):
//   <pid>-<n>.sock   the process's own OpenCode API, for this directory (mode 0600: only this user)
//   <pid>-<n>.json   {v, pid, kind, socket, directory, worktree, projectID, startedAt, sessions: {id: last activity ms}}
// On Windows Bun's unix socket is one Node can't open, so there the API is on 127.0.0.1 at a free port, answering only
// requests with a random token, and the JSON has {url, auth} instead of socket: it's private as the user's profile is.
// One announcement per process and directory. Exit hooks don't run in the TUI's worker, so each start removes the
// files of processes that are gone, and the connector checks the pid too. It never changes what OpenCode does;
// anything that fails here leaves OpenCode as it was. Tested with OpenCode 1.19.5. Remove with `10and2 opencode uninstall`.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.TENANDTWO_OPENCODE_DIR
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "10and2", "opencode", "live");
const WINDOWS = process.platform === "win32";
let seq = 0;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const sweep = () => {
  try {
    for (const f of fs.readdirSync(DIR)) {
      const pid = Number(f.split("-")[0]);
      if (pid && pid !== process.pid && !alive(pid)) fs.rmSync(path.join(DIR, f), { force: true });
    }
  } catch { /* nothing to sweep */ }
};
const argv = process.argv.slice(1).join(" ");
const kind = /tui[\\/]worker/.test(argv) ? "tui" : /\b(serve|web)\b/.test(argv) ? "serve" : /\brun\b/.test(argv) ? "run" : "other";

export const TenAndTwo = async ({ client, directory, worktree, project }) => {
  try {
    // The SDK client OpenCode hands plugins calls its own server in-process; its fetch is the way in.
    const cfg = client?._client?.getConfig?.();
    if (typeof cfg?.fetch !== "function" || typeof Bun === "undefined") return {};
    const base = String(cfg.baseUrl || "http://opencode.internal").replace(/\/$/, "");
    const id = `${process.pid}-${seq++}`;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    sweep();
    const socket = WINDOWS ? null : path.join(DIR, `${id}.sock`);
    const announce = path.join(DIR, `${id}.json`);
    const token = WINDOWS ? `Bearer ${crypto.randomBytes(32).toString("hex")}` : null;
    if (socket) {
      if (Buffer.byteLength(socket) > 100) return {}; // longer than a unix socket path may be
      try { fs.unlinkSync(socket); } catch { /* none */ }
    }
    const allowed = (given) => {
      if (!token) return true;
      const a = Buffer.from(given ?? ""), b = Buffer.from(token);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    // Calls are made only when the connector asks, never during start-up (that deadlocks `opencode run`).
    const server = Bun.serve({
      ...(socket ? { unix: socket } : { hostname: "127.0.0.1", port: 0 }),
      idleTimeout: 0, // event streams stay open
      async fetch(req) {
        if (!allowed(req.headers.get("authorization"))) return new Response(null, { status: 401 });
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        if (token) headers.delete("authorization"); // the token is for this door only, not OpenCode's own password
        if (!headers.has("x-opencode-directory")) headers.set("x-opencode-directory", encodeURIComponent(directory));
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
        return cfg.fetch(new Request(base + url.pathname + url.search, { method: req.method, headers, body }));
      },
    });
    if (socket) fs.chmodSync(socket, 0o600);
    const where = socket ? { socket } : { url: `http://127.0.0.1:${server.port}`, auth: token };
    // Driver's own `opencode serve` is marked, so the connector doesn't take it for one of the user's.
    const mark = process.env.TENANDTWO_OPENCODE_SERVE ? { driverServe: process.env.TENANDTWO_OPENCODE_SERVE } : {};
    const state = { v: 1, pid: process.pid, kind, ...where, ...mark, directory, worktree, projectID: project?.id ?? null, startedAt: Date.now(), sessions: {} };
    let timer = null, tries = 0;
    const write = () => {
      timer = null;
      const tmp = `${announce}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, announce);
        tries = 0;
      } catch {
        // On Windows the rename fails while another program (the connector reading it, antivirus) has the file open.
        if (++tries <= 5) timer = setTimeout(write, 100 * tries);
        else { tries = 0; try { fs.unlinkSync(tmp); } catch { /* none */ } }
      }
    };
    write();
    process.on("exit", () => { for (const f of [socket, announce]) if (f) try { fs.unlinkSync(f); } catch { /* gone */ } });
    return {
      // Which sessions this process ran lately, so the connector picks the right process when several share a folder.
      event: async ({ event }) => {
        const sid = event?.properties?.sessionID ?? event?.properties?.info?.sessionID;
        if (!sid || !/^(session\.status|session\.idle|message\.updated|permission\.asked|question\.asked)$/.test(event.type)) return;
        state.sessions[sid] = Date.now();
        timer ??= setTimeout(write, 500);
      },
    };
  } catch {
    return {};
  }
};
