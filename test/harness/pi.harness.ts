// Pi, for real, against the fake model, with 10 & 2's Pi extension installed: a session open in its terminal UI is
// listed, read, followed up when idle, steered mid-turn, has the extension's question answered; a closed one is
// continued headless through the runner; new work starts. Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PiAdapter } from "../../src/pi/adapter.ts";
import { installPiExtension, piExtensionStatus } from "../../src/pi/extension.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { ANSWERED } from "../../src/util.ts";
import { has, home, inContainer, local, mockModel, project, scheduled, Terminal, typedOf, until } from "./lib.ts";

const skip = !inContainer || !has("pi") ? "runs in the harness container (test/harness/run.sh)" : false;

test("Pi: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 300_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), root = home("pi"), agent = join(root, ".pi", "agent"), state = join(root, "connector");
  mkdirSync(agent, { recursive: true }); mkdirSync(state, { recursive: true });
  // Pi on the fake model: a provider with any key counts as signed in; every folder trusted.
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `${mock.url}/v1`, api: "openai-completions", apiKey: "mock",
    models: [{ id: "mock-model", name: "Mock Model", contextWindow: 128000, maxTokens: 4096 }] } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model", defaultThinkingLevel: "off",
    defaultProjectTrust: "always", enableInstallTelemetry: false, quietStartup: true }));
  assert.equal(piExtensionStatus(agent).state, "missing");
  installPiExtension(agent);
  assert.equal(piExtensionStatus(agent).state, "installed");
  // The runner the adapter starts (and the Pi it runs) inherit this; the terminal gets it explicitly.
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agent });
  const env = { HOME: root, PI_CODING_AGENT_DIR: agent, TENANDTWO_PI_TEST: "1" };

  const adapter = new PiAdapter({ agentDir: agent, db: join(state, "pi.db"), stateDir: state, log: (m) => t.diagnostic(m),
    entryScript: resolve(import.meta.dirname, "..", "fixtures", "pi", "turn.ts"), acceptanceTimeoutMs: 30_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: false, t3: false, codex: false, opencode: false, pi: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  // What the brain is told of who wrote (the engine's stage 3.9): every send below is 10 & 2's, recorded as it goes.
  const typed = typedOf(adapter);
  let typedFrom = 0, typedTo = 0;
  const starts: string[] = [];
  const tui = new Terminal("pi");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });

  // The extension's registry: which sessions are open, and what they're doing.
  const registry = () => { try { return readdirSync(join(agent, "10and2")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(agent, "10and2", f), "utf8"))); } catch { return []; } };

  // Each feature is its own subtest, so an older Pi can pass some and fail others (src/versions.ts).
  let id = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);

  await t.test("read: a session open in its terminal is listed and read", async () => {
    // Pi writes no file before the first message.
    tui.start("pi", cwd, env);
    await until("the terminal's registry entry", () => registry().some((r) => r.mode === "tui"));
    await tui.type("First words PIONE");
    await until("its first reply", () => tui.screen().includes("ACK First words PIONE"));
    await adapter.start();
    id = registry().find((r) => r.mode === "tui").sessionId;
    await until("it to be listed", async () => (await adapter.list()).some((i) => i.id === id && i.status === "completed"));
    assert.equal((await adapter.report(id)).text, "ACK First words PIONE");
    assert.equal((await adapter.list()).find((i) => i.id === id)!.title, "First words PIONE");
  });

  await t.test("follow up: an idle open session gets a new turn in its terminal", async () => {
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await until("the terminal to show the reply", () => tui.screen().includes("ACK Idle words IDLEONE"));
    assert.ok(mock.saw("Idle words IDLEONE"));
  });

  await t.test("steer: a busy open session is steered, delivered once the reply ends", async () => {
    typedFrom = Date.now();
    await tui.type("Slow work SLOW6 BUSYONE");
    await until("the slow turn to start", () => mock.saw("SLOW6 BUSYONE"));
    await until("it to be running", async () => (await adapter.list()).find((i) => i.id === id)?.status === "running");
    typedTo = Date.now();
    assert.deepEqual(await follow("busy", "Steer words STEERONE"), { ok: true });
    await until("the model to get the steer", () => mock.saw("Steer words STEERONE"), 60_000);
    await until("the steer's reply", async () => (await adapter.report(id)).text === "ACK Steer words STEERONE", 30_000);
  });

  await t.test("answer: the extension's question is answered", async () => {
    await until("it to be idle", () => registry().some((r) => r.sessionId === id && r.status === "idle"));
    await tui.type("/tt-ask Which database?");
    await until("the question to be listed", async () => (await adapter.list()).find((i) => i.id === id)?.pendingQuestion === true);
    assert.equal((await adapter.report(id)).question, "Which database? Options: Postgres / SQLite / Skip.");
    assert.deepEqual(await follow("answer", "SQLite, please"), { ok: true });
    await until("the terminal to show the answer", () => tui.screen().includes("Answer: SQLite (from 10 & 2)"));
    await until("the question to be gone", async () => (await adapter.list()).find((i) => i.id === id)?.pendingQuestion === false);
  });

  await t.test("tap: the extension's question is input, its own options its choices; a stale questionId sends nothing, and an option's label answers it", async () => {
    await until("it to be idle", () => registry().some((r) => r.sessionId === id && r.status === "idle"));
    await tui.type("/tt-ask Which database?");
    await until("the question to be listed", async () => (await adapter.report(id)).choices?.length === 3);
    assert.deepEqual((await adapter.report(id)).choices, ["Postgres", "SQLite", "Skip"]);
    const item = (await adapter.list()).find((i) => i.id === id)!;
    assert.equal(item.questionKind, "input");
    const tap = (questionId: string): Action => ({ kind: "follow_up", itemId: id, message: "Postgres", questionId });
    assert.deepEqual(await local(adapter).execute(tap("an-earlier-question"), "tap-stale"), { ok: false, error: ANSWERED });
    assert.deepEqual(await local(adapter).execute(tap(item.questionId!), "tap"), { ok: true });
    await until("the terminal to show the answer", () => tui.screen().includes("Answer: Postgres (from 10 & 2)"));
    await until("the question to be gone", async () => (await adapter.list()).find((i) => i.id === id)?.pendingQuestion === false);
  });

  await t.test("continue: a closed session is continued headless through the runner", async () => {
    tui.stop();
    await until("the terminal's registry entry to go", () => !registry().some((r) => r.sessionId === id));
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("closed", "Closed words CLOSEDONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words CLOSEDONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Closed words CLOSEDONE", 30_000);
    await until("the headless run to end", () => !registry().some((r) => r.sessionId === id), 30_000);
  });

  await t.test("start: new work in the checkout", async () => {
    // Pi runs its tools without asking, so it starts only with a full-access profile.
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness root", message: "Root words ROOTONE", profile }, "start-root");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the new work", () => mock.saw("Root words ROOTONE"), 60_000);
    const itemId = started.ok ? started.itemId! : "";
    starts.push(itemId);
    await until("the new work to be listed and read", async () => (await adapter.list()).some((i) => i.id === itemId && i.title === "Harness root")
      && (await adapter.report(itemId)).text === "ACK Root words ROOTONE", 30_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree inside the project", async () => {
    const profile: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the new work", () => mock.saw("Start words STARTONE"), 60_000);
    const itemId = started.ok ? started.itemId! : "";
    starts.push(itemId);
    await until("the new work to be listed and read", async () => (await adapter.list()).some((i) => i.id === itemId && i.title === "Harness start")
      && (await adapter.report(itemId)).text === "ACK Start words STARTONE", 30_000);
    assert.ok(readdirSync(join(cwd, ".pi", "worktrees")).some((d) => d.startsWith("10and2-")), "it ran in a worktree");
    assert.deepEqual(adapter.places().map((p) => p.id), [place], "the worktree isn't a project of its own");
  });

  await t.test("typed: what's typed in its terminal after a session's first prompt is yours, not known to be at a computer; 10 & 2's follow-ups, steers, answers, continuing and new work aren't", async () => {
    const mine = await typed(id);
    assert.ok(mine?.at && Date.parse(mine.at) >= typedFrom - 2000 && Date.parse(mine.at) <= typedTo, `the last prompt typed (${JSON.stringify(mine)})`);
    // Never known to be at a computer: a plugin or extension writes the same user message (the Skeptic on 3.9 and 3.10).
    assert.equal(mine.desk, null);
    for (const s of starts) assert.deepEqual(await typed(s), { at: null, desk: null }, "new work 10 & 2 started");
  });

  await t.test("checks: Pi's threads say their test runs aren't read, and its reports carry none", async () => {
    assert.equal((await local(adapter).list()).find((i) => i.id === id)?.testRuns, false);
    const r = await adapter.report(id);
    assert.equal(r.checks, undefined);
    assert.equal(r.running, undefined);
  });
  await t.test("schedule: a message set up for later goes at its time and not before, held and sent by the connector (the engine's stage 4a)", async () => {
    await until("it to be idle", async () => { const i = (await adapter.list()).find((x) => x.id === id); return !!i && i.status !== "running"; }, 60_000);
    const held = await scheduled(adapter, id, "Later words LATERONE");
    assert.equal(held.state, "sent", JSON.stringify(held));
    await until("the model to get it", () => mock.saw("Later words LATERONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Later words LATERONE", 60_000);
  });
});
