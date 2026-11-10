// The Codex CLI, for real, against the fake model, on its shared app-server daemon: a session open in its terminal UI
// is listed, read, followed up when idle, steered mid-turn, has its question answered; once nothing has it open it's
// continued; new work starts. Runs in the harness container only (run.sh), which has no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAdapter } from "../../src/codex/adapter.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, inContainer, mockModel, project, sleep, Terminal, until } from "./lib.ts";

const skip = !inContainer || !has("codex") ? "runs in the harness container (test/harness/run.sh)" : false;

test("Codex: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 420_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), codexHome = join(mkdtempSync(join(homedir(), "harness-codex-")), ".codex"), state = join(codexHome, "..", "connector");
  mkdirSync(codexHome, { recursive: true }); mkdirSync(state, { recursive: true });
  // Codex's home is outside /tmp: under it, Codex warns that it won't make its helper binaries there and its terminal
  // UI stalls. Codex on the fake model (a provider of its own needs no login), the project trusted, and nothing that goes online
  // at start: no update check, plugins, analytics or tips. (Its announcement fetch still fails quietly, offline.)
  writeFileSync(join(codexHome, "config.toml"), [
    `model = "mock-model"`, `model_provider = "mock"`, `check_for_update_on_startup = false`, ``,
    `[model_providers.mock]`, `name = "Mock"`, `base_url = "${mock.url}/v1"`, `wire_api = "responses"`, ``,
    `[projects."${cwd}"]`, `trust_level = "trusted"`, ``,
    `[features]`, `plugins = false`, `plugin_discovery_prefetch = false`, `remote_plugin = false`, ``,
    `[analytics]`, `enabled = false`, ``,
    `[tui]`, `screen_reader_detection_done = true`, `show_tooltips = false`, ``].join("\n"));
  const env = { CODEX_HOME: codexHome };
  process.env.CODEX_HOME = codexHome;

  const adapter = new CodexAdapter({ codexHome, db: join(state, "codex.db"), stateDir: state, log: (m) => t.diagnostic(m), acceptanceTimeoutMs: 30_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("codex");
  // A wait that, when it times out, leaves the terminal's screen in the test's output.
  const wait = async (what: string, test: () => boolean | Promise<boolean>, ms?: number) => {
    try { await until(what, test, ms); } catch (e) { t.diagnostic(`screen:\n${tui.screen()}`); throw e; }
  };
  // Typing as a person would; Codex's paste detection sometimes takes the Enter as part of the text, so it's pressed
  // again until the model has the words (an Enter on an empty prompt does nothing).
  const submit = async (words: string) => {
    await tui.type(words);
    await wait(`Codex to send "${words}"`, async () => {
      for (let i = 0; i < 10; i++) { if (mock.saw(words)) return true; await sleep(100); }
      tui.key("Enter");
      return false;
    });
  };
  t.after(async () => {
    tui.stop(); Terminal.stopAll(); await adapter.close();
    try { execFileSync("codex", ["app-server", "daemon", "stop"], { env: { ...process.env, ...env }, stdio: "ignore", timeout: 90_000 }); } catch { /* none */ }
  });

  // Each feature is its own subtest, so an older Codex can pass some and fail others (src/versions.ts).
  let id = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);
  const status = async () => (await adapter.list()).find((i) => i.id === id)?.status;

  await t.test("read: a session open in its terminal is listed and read", async () => {
    // The terminal starts Codex's daemon.
    tui.start("codex", cwd, env);
    await wait("the terminal to be ready", () => tui.screen().includes("Ask Codex to do anything"));
    await submit("First words TUIONE");
    await wait("its first reply", () => tui.screen().includes("ACK First words TUIONE"));
    await adapter.start();
    await wait("it to be listed", async () => (await adapter.list()).some((i) => i.title === "First words TUIONE"));
    id = (await adapter.list()).find((i) => i.title === "First words TUIONE")!.id;
    assert.equal((await adapter.report(id)).text, "ACK First words TUIONE");
  });

  await t.test("follow up: an idle open session gets a new turn its terminal shows", async () => {
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await wait("the terminal to show the message and its reply", () => tui.screen().includes("› Idle words IDLEONE") && tui.screen().includes("ACK Idle words IDLEONE"));
    assert.ok(mock.saw("Idle words IDLEONE"));
  });

  await t.test("steer: a busy open session is steered mid-turn", async () => {
    await submit("Slow work SLOW6 BUSYONE");
    await wait("the slow turn to start", () => mock.saw("SLOW6 BUSYONE"));
    await wait("it to show as running", async () => await status() === "running");
    assert.deepEqual(await follow("busy", "Steer words STEERONE"), { ok: true });
    await wait("the model to get the steer", () => mock.saw("Steer words STEERONE"), 60_000);
    await wait("the terminal to show the steer's reply", () => tui.screen().includes("ACK Steer words STEERONE"), 60_000);
    await wait("the turn to end", async () => await status() === "completed", 60_000);
  });

  await t.test("answer: Codex's question (plan mode's request_user_input) is answered", async () => {
    tui.key("BTab");
    await wait("plan mode", () => tui.screen().includes("Plan mode"));
    await submit("Please ASKQ now");
    await wait("the question to be read", async () => /Which one\? Options: Alpha \/ Beta\./.test((await adapter.report(id)).question ?? ""), 60_000);
    assert.equal(await status(), "waiting");
    assert.deepEqual(await follow("answer", "Beta, please"), { ok: true });
    await wait("the answer to reach the model", () => tui.screen().includes(`ACK RESULT {"answers":{"pick":{"answers":["Beta"]}}}`), 60_000);
    await wait("the question to be gone", async () => (await adapter.report(id)).question === null);
  });

  await t.test("continue: a session nothing has open is continued in the daemon", async () => {
    // Nothing has it open once the terminal is gone and Codex unloads it (about a minute later).
    tui.stop();
    await wait("Codex to unload it", () => (adapter as any).threads.get(id)?.status?.type === "notLoaded", 150_000);
    assert.deepEqual(await follow("closed", "Closed words CLOSEDONE"), { ok: true });
    await wait("the model to get it", () => mock.saw("Closed words CLOSEDONE"), 60_000);
    await wait("its reply to be read", async () => (await adapter.report(id)).text === "ACK Closed words CLOSEDONE", 60_000);
  });

  await t.test("start: new work in the checkout, named", async () => {
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    await wait("the model to get the new work", () => mock.saw("Start words STARTONE"), 60_000);
    const newId = (started as { itemId: string }).itemId;
    await wait("it to be listed by its name", async () => (await adapter.list()).some((i) => i.id === newId && i.title === "Harness start"), 60_000);
    await wait("its reply to be read", async () => (await adapter.report(newId)).text === "ACK Start words STARTONE", 60_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree inside the project", async () => {
    const build: LaunchProfile = { name: "Build", runtimeMode: "auto", workspace: "worktree", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const inWorktree = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile: build }, "start-wt");
    assert.equal(inWorktree.ok, true, JSON.stringify(inWorktree));
    await wait("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 60_000);
    const wtId = (inWorktree as { itemId: string }).itemId;
    await wait("its reply to be read", async () => (await adapter.report(wtId)).text === "ACK Worktree words WTONE", 60_000);
    assert.deepEqual(adapter.places().map((p) => p.id), [place], "the worktree isn't a project of its own");
  });
});
