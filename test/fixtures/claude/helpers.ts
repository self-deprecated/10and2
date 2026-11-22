import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { ClaudeAdapter, type Options } from "../../../src/claude/adapter.ts";
import { procStart } from "../../../src/claude/registry.ts";
import { projectFolder } from "../../../src/claude/transcript.ts";
import type { Policy } from "../../../src/policy.ts";
import { ipcPath, nodeCommand, removeDir, SLOW, WINDOWS } from "../platform.ts";

export const fake = resolve(import.meta.dirname, "claude.mjs");
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The token every fixture session's key file holds. */
export const PEER_TOKEN = "peer-token-123";
/** The key file Claude Code writes for a session's inbox, named from the inbox as it names it (worked out here, not by the connector). */
export function keyFile(pid: number, socket: string) {
  const pipe = /^\\\\[.?]\\pipe\\(.+)$/i.exec(socket)?.[1];
  return `${pid}.${createHash("sha256").update(pipe !== undefined ? `\\\\.\\pipe\\${pipe.toLowerCase()}` : resolve(socket)).digest("hex")}.key`;
}
/** A start for a registry entry, as Claude Code on Windows writes it (a FILETIME). */
export const filetime = (ms = Date.now()) => String(BigInt(Math.round(ms)) * 10_000n + 116_444_736_000_000_000n);
export async function until(test: () => boolean | Promise<boolean>, ms = 2000 * SLOW) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await pause(15); }
  throw new Error("Expected condition did not arrive");
}
export function harness(t: TestContext, opts: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number; adapter?: Partial<Options> } = {}) {
  // Real paths, as parsePolicy makes a policy's folders and visible() compares them: macOS's $TMPDIR is under /var, a
  // link to /private/var, so a policy written with it saw nothing there.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "driver-claude-test-"))), config = join(root, "config"), cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(join(config, "sessions"), { recursive: true }); mkdirSync(join(config, "projects"), { recursive: true });
  const logs: string[] = [], clock = { now: Date.now() };
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "auto", claude: true, t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...opts.policy };
  const options = { configDir: config, policy, db: join(root, "db.sqlite"), stateDir: join(root, "state"), hookSocketPath: ipcPath(join(root, "state"), "hooks.sock"), claudeCommand: nodeCommand(fake), readCacheMs: 0, now: () => clock.now, log: (s: string) => logs.push(s), acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? 1000 * SLOW, ...opts.adapter };
  const adapter = new ClaudeAdapter(options);
  const all = [adapter];
  function transcript(id = randomUUID(), atCwd = cwd) {
    const dir = join(config, "projects", projectFolder(atCwd)!); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const append = (record: any) => appendFileSync(path, JSON.stringify({ version: "2.1.310", sessionId: id, cwd: atCwd, timestamp: new Date(clock.now - 1000).toISOString(), ...record }) + "\n");
    return { id, path, append };
  }
  /** A finished session; it last ran in `mode` (null: its records don't say). */
  function completed(id = randomUUID(), atCwd = cwd, mode: string | null = "bypassPermissions") {
    const f = transcript(id, atCwd);
    f.append({ type: "user", uuid: "prompt-1", promptId: "turn-1", message: { content: "Synthetic request." }, ...(mode === null ? {} : { permissionMode: mode }) });
    f.append({ type: "assistant", uuid: "reply-1", message: { content: [{ type: "text", text: "Synthetic answer." }], stop_reason: "end_turn" } });
    return f;
  }
  /**
   * This test process as a live Claude Code session, as Claude Code records one: its start as `procStartFt` on Windows,
   * and, for one with an inbox, the key file beside it.
   */
  function registry(id: string, status: string, extra: any = {}) {
    const path = join(config, "sessions", `${process.pid}.json`);
    const start = WINDOWS ? { procStartFt: filetime(Date.now() - process.uptime() * 1000) } : { procStart: procStart(process.pid) };
    const entry = { pid: process.pid, sessionId: id, cwd, ...start, version: "2.1.310", kind: "interactive", entrypoint: "cli", status, statusUpdatedAt: clock.now, ...extra };
    writeFileSync(path, JSON.stringify(entry));
    if (typeof entry.messagingSocketPath === "string") {
      writeFileSync(join(config, "sessions", keyFile(process.pid, entry.messagingSocketPath)), JSON.stringify({ peerToken: PEER_TOKEN, ...start, pidDomain: "test" }));
    }
    return path;
  }
  t.after(async () => {
    for (const a of all) await a.close();
    // Only fake children whose pids we recorded may be stopped; registry fixtures include this test process.
    let calls: any[] = [];
    try { calls = readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
    for (const c of calls) { try { process.kill(c.pid, "SIGTERM"); } catch {} }
    await pause(40); removeDir(root);
  });
  return { root, config, cwd, adapter, policy, options, clock, logs, transcript, completed, registry,
    reopen: () => { const a = new ClaudeAdapter(options); all.push(a); return a; } };
}
