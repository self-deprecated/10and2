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
import { ANSWERED } from "../../src/util.ts";
import { checksByStart, has, inContainer, local, mockModel, project, scheduled, sleep, Terminal, typedOf, until } from "./lib.ts";

const skip = !inContainer || !has("codex") ? "runs in the harness container (test/harness/run.sh)" : false;

test("Codex: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 420_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), codexHome = join(mkdtempSync(join(homedir(), "harness-codex-")), ".codex"), state = join(codexHome, "..", "connector");
  mkdirSync(codexHome, { recursive: true }); mkdirSync(state, { recursive: true });
  // Codex's home is outside /tmp: under it, Codex warns that it won't make its helper binaries there and its terminal
  // UI stalls. Codex on the fake model (a provider of its own needs no login), the project trusted, and nothing that goes online
  // at start: no update check, plugins, analytics or tips. (Its announcement fetch still fails quietly, offline.)
  // A thread nothing has open is unloaded after a second, not Codex's default minute (`thread_unload_delay_secs` in
  // Codex's config.schema.json), so the continue test waits on Codex's own unload without sitting idle for a minute.
  writeFileSync(join(codexHome, "config.toml"), [
    `model = "mock-model"`, `model_provider = "mock"`, `check_for_update_on_startup = false`, `thread_unload_delay_secs = 1`, ``,
    `[model_providers.mock]`, `name = "Mock"`, `base_url = "${mock.url}/v1"`, `wire_api = "responses"`, ``,
    // A literal string: in a basic one, a Windows folder's backslashes (C:\Users) would be read as escapes.
    `[projects.'${cwd}']`, `trust_level = "trusted"`, ``,
    `[features]`, `plugins = false`, `plugin_discovery_prefetch = false`, `remote_plugin = false`, ``,
    `[analytics]`, `enabled = false`, ``,
    `[tui]`, `screen_reader_detection_done = true`, `show_tooltips = false`, ``].join("\n"));
  // The cleanup's `daemon stop` asks the daemon to exit, then stops it after `shutdownGraceSeconds` (60 by default:
  // Codex's app-server-daemon/README.md), and here it took the whole minute. The tests are done by then: no grace.
  mkdirSync(join(codexHome, "app-server-daemon"));
  writeFileSync(join(codexHome, "app-server-daemon", "settings.json"), JSON.stringify({ shutdownGraceSeconds: 0 }));
  const env = { CODEX_HOME: codexHome };
  process.env.CODEX_HOME = codexHome;

  const adapter = new CodexAdapter({ codexHome, db: join(state, "codex.db"), stateDir: state, log: (m) => t.diagnostic(m), acceptanceTimeoutMs: 30_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  // What the brain is told of who wrote (the engine's stage 3.9): every send below is 10 & 2's, recorded as it goes.
  const typed = typedOf(adapter);
  let typedFrom = 0, typedTo = 0;
  const starts: string[] = [];
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
    // Shift+Tab, again until plan mode shows: on a busy machine Codex's terminal UI sometimes misses it just after a
    // turn (2 of 12 runs of this file alone, on 2 CPUs each shared with a busy loop, 22 November). It switches plan mode
    // off as well as on, so it's pressed again only once the screen, looked at first, still doesn't show it.
    await wait("plan mode", async () => {
      if (tui.screen().includes("Plan mode")) return true;
      tui.key("BTab");
      for (let i = 0; i < 30; i++) { await sleep(100); if (tui.screen().includes("Plan mode")) return true; }
      return false;
    });
    await submit("Please ASKQ now");
    await wait("the question to be read", async () => /Which one\? Options: Alpha \/ Beta\./.test((await adapter.report(id)).question ?? ""), 60_000);
    assert.equal(await status(), "waiting");
    assert.deepEqual(await follow("answer", "Beta, please"), { ok: true });
    await wait("the answer to reach the model", () => tui.screen().includes(`ACK RESULT {"answers":{"pick":{"answers":["Beta"]}}}`), 60_000);
    await wait("the question to be gone", async () => (await adapter.report(id)).question === null);
  });

  await t.test("tap: its question is input, its own options its choices; a stale questionId sends nothing, and an option's label answers it", async () => {
    await submit("Please ASKQ again");
    await wait("the question to be held", async () => (await adapter.report(id)).choices?.length === 2, 60_000);
    assert.deepEqual((await adapter.report(id)).choices, ["Alpha", "Beta"]);
    const item = (await adapter.list()).find((i) => i.id === id)!;
    assert.equal(item.questionKind, "input");
    const tap = (questionId: string): Action => ({ kind: "follow_up", itemId: id, message: "Alpha", questionId });
    assert.deepEqual(await local(adapter).execute(tap("an-earlier-question"), "tap-stale"), { ok: false, error: ANSWERED });
    assert.deepEqual(await local(adapter).execute(tap(item.questionId!), "tap"), { ok: true });
    await wait("the tapped option to reach the model", () => tui.screen().includes(`ACK RESULT {"answers":{"pick":{"answers":["Alpha"]}}}`), 60_000);
    await wait("the question to be gone", async () => (await adapter.report(id)).question === null);
  });

  // Fable on 3.9 and 3.10: Codex dates a message queued with Tab while a turn runs when it takes it, as that turn ends
  // (0.167.0, measured), so it isn't counted as typed: "typed" below finds the prompt typed before it.
  await t.test("queued: a message queued with Tab while a turn runs is sent as it ends, and isn't counted as typed then", async () => {
    // Typed a while after the last turn ended, as a person reads a reply first (one whose turn starts as the turn before
    // it ends was queued while that ran): the last prompt "typed" finds.
    await wait("the last turn to end", async () => await status() === "completed", 60_000);
    await sleep(4000);
    typedFrom = Date.now();
    await submit("Slow work SLOW6 QUEUEONE");
    await wait("the slow turn to start", () => mock.saw("SLOW6 QUEUEONE"));
    typedTo = Date.now();
    await wait("it to show as running", async () => await status() === "running");
    tui.key("-l", "Queued words QUEUEDONE");
    await sleep(700);
    tui.key("Tab");
    await wait("the queued message to reach the model", () => mock.saw("Queued words QUEUEDONE"), 60_000);
    await wait("its turn to end", async () => await status() === "completed", 60_000);
    const turns: any = await (adapter as any).rpc.request("thread/turns/list", { threadId: id, limit: 2, sortDirection: "desc", itemsView: "summary" });
    const [queued, busy] = turns.data;
    t.diagnostic(`the busy turn ended ${busy.completedAt}; the queued message's turn started ${queued.startedAt}, the message dated ${queued.items[0]?.startedAtMs}`);
    assert.ok((queued.items[0]?.startedAtMs ?? queued.startedAt * 1000) - busy.completedAt * 1000 < 3000, "taken as the busy turn ended");
  });

  await t.test("continue: a session nothing has open is continued in the daemon", async () => {
    // Nothing has it open once the terminal is gone and Codex unloads it: a second later, as configured above (a
    // minute on a Codex older than the setting, which it ignores; hence the long wait). The adapter hears it from the
    // daemon (thread/status/changed), so this took about a second, but its 30 s refresh would find it too.
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
    starts.push(newId);
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
    starts.push(wtId);
    await wait("its reply to be read", async () => (await adapter.report(wtId)).text === "ACK Worktree words WTONE", 60_000);
    assert.deepEqual(adapter.places().map((p) => p.id), [place], "the worktree isn't a project of its own");
  });

  await t.test("typed: what's typed in its terminal is yours, at this computer; 10 & 2's follow-ups, answers, continuing and new work aren't", async () => {
    const mine = await typed(id);
    assert.ok(mine?.desk && Date.parse(mine.desk) >= typedFrom - 2000 && Date.parse(mine.desk) <= typedTo, `the last prompt typed (${JSON.stringify(mine)})`);
    assert.equal(mine.at, mine.desk);
    for (const s of starts) assert.deepEqual(await typed(s), { at: null, desk: null }, "new work 10 & 2 started");
  });

  await t.test("checks: a test run's pass and failure, from its command's exit code, are the run's (mid-run) and the reply's checks", async () => {
    const profile: LaunchProfile = { name: "Full", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    await checksByStart(adapter, adapter.places()[0]!.id, profile, cwd);
  });
  await t.test("schedule: a message set up for later goes at its time and not before, held and sent by the connector (the engine's stage 4a)", async () => {
    await wait("it to be idle", async () => { const i = (await adapter.list()).find((x) => x.id === id); return !!i && i.status !== "running"; }, 60_000);
    const held = await scheduled(adapter, id, "Later words LATERONE");
    assert.equal(held.state, "sent", JSON.stringify(held));
    await wait("the model to get it", () => mock.saw("Later words LATERONE"), 60_000);
    await wait("its reply to be read", async () => (await adapter.report(id)).text === "ACK Later words LATERONE", 60_000);
  });
});
