// OpenCode, for real, against the fake model: a session open in its terminal UI (reached through 10 & 2's plugin) is
// listed, read, followed up when idle, steered mid-turn, has its question answered; once the terminal is closed it's
// continued in Driver's own `opencode serve`; new work starts. Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeAdapter } from "../../src/opencode/adapter.ts";
import { installOpenCodePlugin } from "../../src/opencode/plugin.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, home, inContainer, mockModel, project, Terminal, until } from "./lib.ts";

const skip = !inContainer || !has("opencode") ? "runs in the harness container (test/harness/run.sh)" : false;

test("OpenCode: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 300_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), root = home("opencode"), state = join(root, "connector");
  const xdg = { XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, ".local", "share"), XDG_STATE_HOME: join(root, ".local", "state"), XDG_CACHE_HOME: join(root, ".cache") };
  const config = join(xdg.XDG_CONFIG_HOME, "opencode");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  // OpenCode installs its plugin package here before loading a plugin; the image has it ready (no network here).
  if (existsSync("/opt/opencode-config")) cpSync("/opt/opencode-config", config, { recursive: true });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", model: "mock/mock-model", small_model: "mock/mock-model", autoupdate: false, share: "disabled",
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `${mock.url}/v1`, apiKey: "dummy" }, models: { "mock-model": { name: "Mock Model", tool_call: true } } } },
  }));
  await installOpenCodePlugin(config);
  // The terminal and Driver's own server (which inherits this process's environment) share this private OpenCode.
  const env = { ...xdg, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  Object.assign(process.env, env);

  const adapter = new OpenCodeAdapter({ dataDir: join(xdg.XDG_DATA_HOME, "opencode"), configDir: config, db: join(state, "opencode.db"), stateDir: state, log: (m) => t.diagnostic(m),
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "auto", claude: false, t3: false, codex: false, opencode: true, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("opencode");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });

  // Each feature is its own subtest, so an older OpenCode can pass some and fail others (src/versions.ts).
  let id = "";
  const live = join(xdg.XDG_STATE_HOME, "10and2", "opencode", "live");
  const entry = () => readdirSync(live).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(live, f), "utf8"))).find((e) => e.kind === "tui");
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);

  await t.test("read: a session open in its terminal is listed and read", async () => {
    tui.start("opencode", cwd, env);
    await until("the terminal to be ready", () => tui.screen().includes("Ask anything"), 60_000);
    await tui.type("First words TUIONE");
    await until("its first reply", () => tui.screen().includes("ACK First words TUIONE"));
    await adapter.start();
    await until("it to be listed", async () => { const items = await adapter.list(); id = items[0]?.id ?? ""; return items.length === 1 && items[0]!.status === "completed"; });
    assert.equal((await adapter.report(id)).text, "ACK First words TUIONE");
  });

  await t.test("follow up: an idle open session gets a new turn in its terminal (the plugin)", async () => {
    await until("the plugin to announce the terminal", () => !!entry());
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Idle words IDLEONE"));
    await until("the terminal to show its reply", () => tui.screen().includes("ACK Idle words IDLEONE"));
  });

  await t.test("steer: a busy open session is queued into, taken once the turn ends", async () => {
    await tui.type("Slow work SLOW6 BUSYONE");
    await until("the slow turn to start", () => mock.saw("SLOW6 BUSYONE"));
    await until("it to be running", async () => (await adapter.list())[0]!.status === "running");
    assert.deepEqual(await follow("busy", "Steer words STEERONE"), { ok: true });
    await until("the model to get the steer", () => mock.saw("Steer words STEERONE"), 60_000);
    await until("the terminal to show it", () => tui.screen().includes("ACK Steer words STEERONE"), 30_000);
  });

  await t.test("answer: OpenCode's question is answered", async () => {
    await tui.type("Please OCASKQ now");
    await until("the question to be asked", async () => /Which one\? Options: Alpha \/ Beta/.test((await adapter.report(id)).question ?? ""));
    assert.equal((await adapter.list())[0]!.status, "waiting");
    assert.deepEqual(await follow("answer", "Beta, please"), { ok: true });
    await until("the answer to come back from the model", () => tui.screen().includes("ACK RESULT"), 60_000);
    assert.match(tui.screen(), /"Which one\?"="Beta"/);
  });

  await t.test("continue: a closed session is continued in 10 & 2's own server", async () => {
    const pid = entry()?.pid;
    tui.stop();
    if (pid) await until("the terminal to exit", () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("closed", "Closed words CLOSEDONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words CLOSEDONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Closed words CLOSEDONE", 30_000);
  });

  await t.test("start: new work in the checkout, edits allowed and commands asked", async () => {
    const profile: LaunchProfile = { name: "Edits", runtimeMode: "auto-accept-edits", workspace: "root", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the new work", () => mock.saw("Start words STARTONE"), 60_000);
    const item = (await adapter.list()).find((i) => i.id === (started as { itemId: string }).itemId);
    assert.equal(item?.title, "Harness start");
  });

  await t.test("start in a worktree: new work in a fresh worktree inside the project", async () => {
    const build: LaunchProfile = { name: "Build", runtimeMode: "auto-accept-edits", workspace: "worktree", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const inWorktree = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile: build }, "start-wt");
    assert.equal(inWorktree.ok, true, JSON.stringify(inWorktree));
    await until("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 60_000);
    const wtId = (inWorktree as { itemId: string }).itemId;
    await until("its reply to be read", async () => (await adapter.report(wtId)).text === "ACK Worktree words WTONE", 60_000);
    assert.deepEqual(adapter.places().map((p) => p.id), [place], "the worktree isn't a project of its own");
  });
});
