import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { ClaudeAdapter } from "../../../src/claude/adapter.ts";
import { procStart } from "../../../src/claude/registry.ts";
import type { Policy } from "../../../src/policy.ts";

export const fake = resolve(import.meta.dirname, "claude.mjs");
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(test: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await pause(15); }
  throw new Error("Expected condition did not arrive");
}
export function harness(t: TestContext, opts: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "driver-claude-test-")), config = join(root, "config"), cwd = join(root, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(join(config, "sessions"), { recursive: true }); mkdirSync(join(config, "projects"), { recursive: true });
  const logs: string[] = [], clock = { now: Date.now() };
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "auto", claude: true, t3: false, worktreeBase: "HEAD", ...opts.policy };
  const options = { configDir: config, policy, db: join(root, "db.sqlite"), stateDir: join(root, "state"), hookSocketPath: join(root, "state", "hooks.sock"), claudeBin: fake, readCacheMs: 0, now: () => clock.now, log: (s: string) => logs.push(s), acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? 1000 };
  const adapter = new ClaudeAdapter(options);
  const all = [adapter];
  function transcript(id = randomUUID(), atCwd = cwd) {
    const dir = join(config, "projects", atCwd.replace(/[/.]/g, "-")); mkdirSync(dir, { recursive: true });
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
  function registry(id: string, status: string, extra: any = {}) {
    const path = join(config, "sessions", `${process.pid}.json`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, sessionId: id, cwd, procStart: procStart(process.pid), version: "2.1.310", kind: "interactive", entrypoint: "cli", status, statusUpdatedAt: clock.now, ...extra }));
    return path;
  }
  t.after(async () => {
    for (const a of all) await a.close();
    // Only fake children whose pids we recorded may be stopped; registry fixtures include this test process.
    let calls: any[] = [];
    try { calls = readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch {}
    for (const c of calls) { try { process.kill(c.pid, "SIGTERM"); } catch {} }
    await pause(40); rmSync(root, { recursive: true, force: true });
  });
  return { root, config, cwd, adapter, policy, options, clock, logs, transcript, completed, registry,
    reopen: () => { const a = new ClaudeAdapter(options); all.push(a); return a; } };
}
