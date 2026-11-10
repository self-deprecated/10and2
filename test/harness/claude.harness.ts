// Claude Code, for real, against the fake model: a session open in its terminal UI is listed, read, followed up when
// idle, steered mid-turn, has its question answered through the hook; a closed one is continued; new work starts.
// Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ClaudeAdapter } from "../../src/claude/adapter.ts";
import { installHooks } from "../../src/claude/hooks.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, home, inContainer, mockModel, project, Terminal, until } from "./lib.ts";

const skip = !inContainer || !has("claude") ? "runs in the harness container (test/harness/run.sh)" : false;
const KEY = "sk-ant-mock-00000000000000000000000000";

test("Claude Code: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 300_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), config = join(home("claude"), ".claude"), state = join(config, "..", "connector");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  // Claude Code on the fake model with a throwaway key: onboarding, the key and the folder already answered.
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: join(state, "hooks.sock") });
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark",
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`);
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: join(state, "hooks.sock") };

  const adapter = new ClaudeAdapter({ configDir: config, db: join(state, "claude.db"), stateDir: state, hookSocketPath: join(state, "hooks.sock"), log: (m) => t.diagnostic(m),
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: true, t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("claude");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); try { execFileSync("claude", ["daemon", "stop", "--any"], { stdio: "ignore", timeout: 15_000 }); } catch { /* none */ } });

  // Each feature is its own subtest, so an older Claude Code can pass some and fail others (src/versions.ts).
  let id = "";
  const sessions = () => readdirSync(join(config, "sessions")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(config, "sessions", f), "utf8")));
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);

  await t.test("read: a session open in its terminal is listed and read", async () => {
    tui.start("claude", cwd, env);
    await until("the terminal to be ready", () => tui.screen().includes("❯"));
    await tui.type("First words TUIONE");
    await until("its first reply", () => tui.screen().includes("ACK First words TUIONE"));
    await adapter.start();
    await until("its registry entry", () => sessions().length > 0);
    id = sessions()[0].sessionId;
    await until("it to be listed", async () => (await adapter.list()).some((i) => i.id === id));
    assert.equal((await adapter.report(id)).text, "ACK First words TUIONE");
  });

  await t.test("follow up: an idle open session gets a new turn in its terminal", async () => {
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await until("the terminal to show the message", () => tui.screen().includes("Message from @10-2: Idle words IDLEONE"));
    await until("the model to get it", () => mock.saw("Idle words IDLEONE"));
  });

  await t.test("steer: a busy open session is steered mid-turn", async () => {
    await tui.type("Slow work SLOW6 BUSYONE");
    await until("the slow turn to start", () => mock.saw("SLOW6 BUSYONE"));
    assert.deepEqual(await follow("busy", "Steer words STEERONE"), { ok: true });
    await until("the model to get the steer", () => mock.saw("Steer words STEERONE"), 60_000);
  });

  await t.test("answer: Claude's question is held by the hook and answered", async () => {
    await tui.type("Please ASKQ now");
    await until("the question to be held", async () => /Which one\? Options: Alpha \/ Beta/.test((await adapter.report(id)).question ?? ""));
    assert.deepEqual(await follow("answer", "Beta, please"), { ok: true });
    await until("the answer to come back from the model", () => tui.screen().includes("ACK RESULT"), 60_000);
    assert.match(tui.screen(), /Allowed by PermissionRequest hook/);
  });

  await t.test("continue: a closed session is continued under its own id", async () => {
    tui.stop();
    await until("the terminal's registry entry to go", () => !sessions().some((s) => s.sessionId === id && s.kind === "interactive"));
    assert.deepEqual(await follow("closed", "Closed words CLOSEDONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words CLOSEDONE"), 60_000);
  });

  await t.test("start: new work in the checkout", async () => {
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the new work", () => mock.saw("Start words STARTONE"), 60_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree", async () => {
    const profile: LaunchProfile = { name: "Build", runtimeMode: "auto", workspace: "worktree", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile }, "start-wt");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 60_000);
  });
});
