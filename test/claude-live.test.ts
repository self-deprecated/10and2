import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeAdapter, sessionForKey } from "../src/claude/adapter.ts";
import { readRegistry } from "../src/claude/registry.ts";
import { until, pause } from "./fixtures/claude/helpers.ts";

test("live Claude: cold follow-up and deterministic new work have positive acceptance evidence", { skip: process.env.DRIVER_LIVE_CLAUDE !== "1", timeout: 90_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "driver-claude-live-"));
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const project = join(configDir, "projects", cwd.replace(/[/.]/g, "-"));
  const binary = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const wrapper = join(cwd, "haiku-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${binary.replace(/'/g, "'\\''")}' --model haiku "$@"\n`, { mode: 0o700 });
  let adapter: ClaudeAdapter | undefined;
  t.after(async () => {
    if (adapter) await adapter.close();
    const scratch = (path: string) => path === cwd || path.startsWith(cwd + "/");
    for (const run of readRegistry(configDir).filter((r) => scratch(r.cwd))) { try { process.kill(run.pid, "SIGINT"); } catch {} }
    await until(() => !readRegistry(configDir).some((r) => scratch(r.cwd)), 5000);
    await pause(100);
    // The encoded directory belongs only to the unique scratch project, never to a user's project.
    assert.ok(cwd.startsWith(join(tmpdir(), "driver-claude-live-")));
    const encoded = cwd.replace(/[/.]/g, "-");
    for (const dir of readdirSync(join(configDir, "projects"))) if (dir === encoded || dir.startsWith(encoded + "-")) rmSync(join(configDir, "projects", dir), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  execFileSync("jj", ["git", "init", cwd], { stdio: "pipe" });
  writeFileSync(join(cwd, "seed.txt"), "Disposable worktree base.\n");
  execFileSync("jj", ["commit", "-m", "scratch worktree base"], { cwd, stdio: "pipe" });
  const initialId = randomUUID();
  try {
    execFileSync(binary, ["-p", "--model", "haiku", "--session-id", initialId, "--permission-mode", "default", "--output-format", "stream-json", "--verbose", "reply with the word A"], { cwd, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // Quota errors are turn outcomes, not failures to accept the initial prompt. Require its persisted record.
    if (!readFileSync(join(project, `${initialId}.jsonl`), "utf8").includes('"type":"user"')) throw e;
  }
  adapter = new ClaudeAdapter({ configDir, db: join(cwd, "overlay.sqlite"), stateDir: join(cwd, "runs"), hookSocketPath: join(cwd, "runs", "hooks.sock"), claudeBin: wrapper,
    log: (message) => t.diagnostic(message), policy: { brain: "wss://unused.invalid/connector", projects: [cwd], claude: true,
      actions: ["follow_up", "start_work"], maxRuntimeMode: "approval-required", t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  await adapter.start();
  assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: initialId, message: "reply with the word B" }, "live-follow"), { ok: true });
  await until(() => !readRegistry(configDir).some((r) => r.sessionId === initialId), 15_000);
  const place = adapter.places()[0]; assert.ok(place);
  const receipt = await adapter.execute({ kind: "start_work", placeId: place.id, title: "Scratch A", message: "reply with the word A",
    profile: { name: "Manual", workspace: "root", runtimeMode: "approval-required", interactionMode: "default" } }, "live-start");
  assert.deepEqual(receipt, { ok: true, itemId: sessionForKey("live-start") });
  await until(() => !readRegistry(configDir).some((r) => r.sessionId === sessionForKey("live-start")), 15_000);
  const worktree = await adapter.execute({ kind: "start_work", placeId: place.id, title: "Scratch worktree", message: "reply with the word A",
    profile: { name: "Manual worktree", workspace: "worktree", runtimeMode: "approval-required", interactionMode: "default" } }, "live-worktree");
  assert.deepEqual(worktree, { ok: true, itemId: sessionForKey("live-worktree") });
  await until(() => !readRegistry(configDir).some((r) => r.sessionId === sessionForKey("live-worktree")), 15_000);
  const items = await adapter.list(); assert.ok(items.some((i) => i.id === sessionForKey("live-start")));
  assert.ok(items.some((i) => i.id === sessionForKey("live-worktree")));
  t.diagnostic(`Observed follow-up, root and worktree start_work acceptance; turn states: ${items.map((i) => i.status).join(", ")}.`);
});
