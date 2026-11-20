import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import { PiAdapter, sessionFolder } from "../../../src/pi/adapter.ts";
import type { Options } from "../../../src/pi/adapter.ts";
import { MARKER } from "../../../src/pi/extension.ts";
import type { Policy } from "../../../src/policy.ts";
import { nodeCommand, removeDir, SLOW, WINDOWS } from "../platform.ts";

export const fakePi = resolve(import.meta.dirname, "pi.mjs");
export const runner = resolve(import.meta.dirname, "turn.ts");
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(test: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) { if (await test()) return; await pause(15); }
  throw new Error("Expected condition did not arrive");
}

type Opts = { policy?: Partial<Policy>; acceptanceTimeoutMs?: number; extension?: boolean; days?: number };

/** A private Pi agent folder with sessions, a registry, a fake `pi`, and an adapter over them. */
export function harness(t: TestContext, opts: Opts = {}) {
  // Real paths, as parsePolicy makes a policy's folders and visible() compares them: macOS's $TMPDIR is under /var, a
  // link to /private/var, so a policy written with it saw nothing there.
  // And on macOS under /tmp: its $TMPDIR leaves no room for an open Pi's socket (<agent>/10and2/<id>.sock) within a Unix
  // socket's 104 bytes; a user's, under ~/.pi, fits.
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-test-"))), agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(join(agent, "sessions"), { recursive: true }); mkdirSync(join(agent, "10and2"), { recursive: true });
  // The extension is there unless a test says otherwise: without it Driver won't continue a closed session.
  if (opts.extension !== false) { mkdirSync(join(agent, "extensions")); writeFileSync(join(agent, "extensions", "10and2.ts"), `${MARKER}\n`); }
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  const logs: string[] = [], clock = { now: Date.now() };
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: false, t3: false, codex: false, opencode: false, pi: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...opts.policy };
  // A headless turn starts two Nodes (the runner, then the fake Pi), several times slower on Windows.
  const options = { agentDir: agent, policy, db: join(root, "pi.db"), stateDir: join(root, "state"), piCommand: nodeCommand(fakePi), entryScript: runner, readCacheMs: 0,
    now: () => clock.now, log: (s: string) => logs.push(s), acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? 3000 * SLOW, days: opts.days };
  const adapter = new PiAdapter(options);
  const all = [adapter];
  const servers: { close(): void }[] = [];

  /** A session file, at `sessions/--<cwd>--/` (or directly in `sessions/` when `flat`), with its header. */
  function session(id: string = randomUUID(), at = cwd, flat = false) {
    const dir = flat ? join(agent, "sessions") : join(agent, "sessions", sessionFolder(at));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${new Date(clock.now - 60_000).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
    let last: string | null = null, n = 0;
    const raw = (e: any) => appendFileSync(path, JSON.stringify(e) + "\n");
    raw({ type: "session", version: 3, id, timestamp: new Date(clock.now - 60_000).toISOString(), cwd: at });
    /** Appends an entry under `parent` (default: the last one) and returns its id. */
    const add = (e: any, parent: string | null = last) => {
      const eid = (++n).toString(16).padStart(8, "0");
      raw({ ...e, id: eid, parentId: parent, timestamp: new Date(clock.now - 30_000 + n * 10).toISOString() }); last = eid; return eid;
    };
    const user = (text: string, parent?: string | null) => add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: clock.now } }, parent);
    const assistant = (text: string, stopReason = "stop", extra: any = {}) => add({ type: "message", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, ...extra } });
    return { id, path, add, user, assistant };
  }
  /** A finished session: one prompt, one reply. */
  function completed(id?: string, at = cwd) {
    const s = session(id, at);
    s.user("Synthetic request."); s.assistant("Synthetic answer.");
    return s;
  }
  /** Where the extension would listen for session `id`: the socket file beside its entry, or on Windows a fresh pipe. */
  const socketFor = (id: string) => WINDOWS ? `\\\\.\\pipe\\10and2-pi-${randomUUID()}` : join(agent, "10and2", `${id}.sock`);
  /**
   * An open Pi (as 10 & 2's extension shows one): its registry entry, and a socket that records each line and, unless
   * `silent`, acks it. `onUser` sees each `user` request.
   */
  async function live(id: string, status: string, extra: any = {}, behaviour: { silent?: boolean; refuse?: boolean; onUser?: (m: any) => void } = {}) {
    const socket = socketFor(id), lines: any[] = [];
    const server = createServer((conn) => {
      let text = "";
      conn.on("data", (b) => {
        text += b.toString();
        for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n")) {
          const m = JSON.parse(text.slice(0, i)); text = text.slice(i + 1);
          lines.push(m);
          if (m.type === "user") behaviour.onUser?.(m);
          if (behaviour.silent) continue;
          conn.write(JSON.stringify(behaviour.refuse ? { id: m.id, type: "error", error: "no" } : { id: m.id, type: "ack", delivered: m.type === "answer" ? "answer" : status === "busy" ? "steer" : "prompt" }) + "\n");
        }
      });
    });
    await new Promise<void>((r, j) => { server.once("error", j); server.listen(socket, r); });
    servers.push(server);
    writeFileSync(join(agent, "10and2", `${id}.json`), JSON.stringify({ sessionId: id, sessionFile: null, cwd, name: null, pid: process.pid, mode: "tui", status,
      prompt: null, questions: [], socket, piVersion: "1.5.1", updatedAt: new Date(clock.now).toISOString(), ...extra }));
    return lines;
  }
  const calls = (): any[] => { try { return readFileSync(join(agent, "calls.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)); } catch { return []; } };
  t.after(async () => {
    for (const a of all) await a.close();
    for (const s of servers) s.close();
    for (const c of calls()) { try { process.kill(c.pid, "SIGTERM"); } catch { /* gone */ } }
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await pause(40); removeDir(root);
  });
  return { root, agent, cwd, adapter, policy, options, clock, logs, session, completed, live, socketFor, calls,
    reopen: (more: Partial<Options> = {}) => { const a = new PiAdapter({ ...options, ...more }); all.push(a); return a; } };
}
