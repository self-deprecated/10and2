// T3 Code, for real, against the fake model: its own server (`t3 serve`) with one project, its threads run by Codex. The
// connector mints its scoped session with T3's CLI and connects; new work starts in the checkout and in a worktree, and
// on a model T3 offers; a thread is listed and read, followed up idle and while busy (queued behind the run), its
// question answered, and it is settled and snoozed. Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3Adapter } from "../../src/t3/adapter.ts";
import { issueSession, revokeSession, CONNECTOR_SCOPES } from "../../src/t3/auth.ts";
import { RpcClient } from "../../src/t3/rpc.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { ANSWERED } from "../../src/util.ts";
import { checksByStart, has, inContainer, local, mockModel, project, scheduled, sleep, typedOf, until } from "./lib.ts";

const skip = !inContainer || !has("t3") || !has("codex") ? "runs in the harness container (test/harness/run.sh)" : false;
const PORT = 3773;

test("T3 Code: start work, list, read, follow up idle and busy, answer a question, settle and snooze", { skip, timeout: 420_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project();
  // T3 runs its Codex threads with this Codex home: the fake model as a provider of its own, the project trusted, nothing online.
  const codexHome = join(mkdtempSync(join(homedir(), "harness-t3-codex-")), ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), [
    `model = "mock-model"`, `model_provider = "mock"`, `check_for_update_on_startup = false`, ``,
    `[model_providers.mock]`, `name = "Mock"`, `base_url = "${mock.url}/v1"`, `wire_api = "responses"`, ``,
    // A literal string: in a basic one, a Windows folder's backslashes (C:\Users) would be read as escapes.
    `[projects.'${cwd}']`, `trust_level = "trusted"`, ``,
    `[features]`, `plugins = false`, `plugin_discovery_prefetch = false`, `remote_plugin = false`, `daemon_auto_start = false`, ``,
    `[analytics]`, `enabled = false`, ``].join("\n"));
  process.env.CODEX_HOME = codexHome;

  // T3's own server, in the project, on its default port (T3's data in this container's ~/.t3, beside its runtime).
  // Its own process group: `t3` is a launcher for the server it starts, which outlives it otherwise.
  const server = spawn("t3", ["serve", "--no-browser", "--host", "127.0.0.1", "--port", String(PORT), cwd], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let serverLog = "";
  server.stdout!.on("data", (b) => { serverLog += b; }); server.stderr!.on("data", (b) => { serverLog += b; });
  const baseUrl = `http://127.0.0.1:${PORT}`;
  t.after(() => { try { process.kill(-server.pid!, "SIGKILL"); } catch { /* gone */ } });
  // Any answer will do (its web root may redirect, or hang while it starts), or its own word that it's listening.
  try { await until("T3's server", async () => /Listening on http/.test(serverLog) || (await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(2000) }).catch(() => null)) !== null, 180_000); }
  catch (e) { t.diagnostic(serverLog.slice(-4000)); throw e; }
  // `t3 project add` goes through the running server only if it answers within a second (T3's
  // PROJECT_CLI_LIVE_SERVER_PROBE_TIMEOUT); otherwise it opens T3's data itself, which the server owns, and stops with
  // ServerAlreadyRunningError. A server still starting misses that second when the container is busy, as after the other
  // harnesses, so it's tried again until the server answers; any other failure is the test's, with what T3 said.
  for (const end = Date.now() + 60_000; ;) {
    try { execFileSync("t3", ["project", "add", cwd, "--title", "lap-timer"], { encoding: "utf8", stdio: "pipe", timeout: 60_000 }); break; }
    catch (e: any) {
      const said = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (!said.includes("ServerAlreadyRunningError") || Date.now() > end) throw new Error(`t3 project add failed: ${said.slice(-2000)}`, { cause: e });
      await sleep(500);
    }
  }

  const adapter = new T3Adapter({ baseUrl, cli: ["t3"], label: "10and2-harness", log: (m) => t.diagnostic(m), worktreeBase: "HEAD" });
  t.after(async () => { await adapter.close(); });
  // What the brain is told of who wrote (the engine's stage 3.9): every send below is 10 & 2's, recorded as it goes.
  const typed = typedOf(adapter);
  const starts: string[] = [];

  // Each feature is its own subtest, so an older T3 Code can pass some and fail others (src/versions.ts).
  let id = "", place = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);
  const item = async () => (await adapter.list()).find((i) => i.id === id);

  await t.test("connect: a scoped session is minted and the project is a place", async () => {
    // The adapter retries a failed connect for good; a T3 Code it can't connect to fails here, not at the test's timeout.
    // The minute's timer is cleared once that's settled: left running, it kept this file's process alive until the minute
    // was up, on CI about 50 s after its last test (21 November).
    let minute: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { minute = setTimeout(() => reject(new Error("T3 didn't connect within a minute")), 60_000); });
    try { await Promise.race([adapter.start(), late]); } finally { clearTimeout(minute); }
    await until("the project to be a place", () => adapter.places().some((p) => p.name === "lap-timer"), 30_000);
    // Only this test's: another of that name in T3's data (a harness run before, in the same container) would take the
    // work into its folder, where the checks' test files aren't (stage 4's final review: the "checks" subtest's flake).
    assert.equal(adapter.places().filter((p) => p.name === "lap-timer").length, 1, JSON.stringify(adapter.places()));
    place = adapter.places().find((p) => p.name === "lap-timer")!.id;
    // A new project has no default model; T3's own clients set one. The test does it with a session of its own.
    const s = await issueSession({ cli: ["t3"], label: "10and2-harness-setup", ttl: "10m", scopes: CONNECTOR_SCOPES });
    const rpc = await RpcClient.connect(baseUrl, s.token);
    await rpc.request("projects.mutate", { type: "project.update", commandId: `harness-${Date.now()}`, projectId: place, defaultModelSelection: { instanceId: "codex", model: "mock-model" } });
    rpc.close(); await revokeSession(["t3"], s.sessionId);
    await until("the project's model to arrive", () => adapter.modelFor(place) !== null, 30_000);
  });

  await t.test("start: new work in the checkout, listed and read", async () => {
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    id = (started as { itemId: string }).itemId;
    starts.push(id);
    await until("the model to get the new work", () => mock.saw("Start words STARTONE"), 90_000);
    await until("it to be listed, done", async () => (await item())?.status === "completed", 90_000);
    assert.equal((await item())!.title, "Harness start");
    assert.equal((await adapter.report(id)).text, "ACK Start words STARTONE");
  });

  await t.test("follow up: an idle thread gets a new run", async () => {
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Idle words IDLEONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Idle words IDLEONE", 60_000);
  });

  await t.test("steer: a busy thread is queued into, taken once the run ends", async () => {
    assert.deepEqual(await follow("slow", "Slow work SLOW6 BUSYONE"), { ok: true });
    await until("the slow run to start", () => mock.saw("SLOW6 BUSYONE"), 60_000);
    await until("it to be running", async () => (await item())?.status === "running", 30_000);
    assert.deepEqual(await follow("busy", "Queued words QUEUEONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Queued words QUEUEONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Queued words QUEUEONE", 60_000);
  });

  await t.test("answer: a thread's question (Codex's request_user_input in plan mode) is answered", async () => {
    const profile: LaunchProfile = { name: "Plan", runtimeMode: "full-access", workspace: "root", interactionMode: "plan" };
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness question", message: "Please ASKQ now", profile }, "ask");
    assert.equal(started.ok, true, JSON.stringify(started));
    const askId = (started as { itemId: string }).itemId;
    starts.push(askId);
    await until("the question to be read", async () => /Which one\? Options: Alpha \/ Beta/.test((await adapter.report(askId)).question ?? ""), 90_000);
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: askId, message: "Beta, please" } as Action, "answer"), { ok: true });
    // The fake model echoes the tool's result as its reply.
    await until("the answer to come back from the model", async () => /^ACK RESULT .*Beta/.test((await adapter.report(askId)).text ?? ""), 60_000);
    await until("the question to be gone", async () => (await adapter.report(askId)).question === null, 30_000);
  });

  await t.test("tap: a thread's question is input, its own options its choices; a stale questionId sends nothing, and an option's label answers it", async () => {
    const profile: LaunchProfile = { name: "Plan", runtimeMode: "full-access", workspace: "root", interactionMode: "plan" };
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness tap", message: "Please ASKQ by tap", profile }, "ask-tap");
    assert.equal(started.ok, true, JSON.stringify(started));
    const tapId = (started as { itemId: string }).itemId;
    starts.push(tapId);
    await until("the question to be read", async () => (await adapter.report(tapId)).choices?.length === 2, 90_000);
    assert.deepEqual((await adapter.report(tapId)).choices, ["Alpha", "Beta"]);
    const asked = (await adapter.list()).find((i) => i.id === tapId)!;
    assert.equal(asked.questionKind, "input");
    const tap = (questionId: string): Action => ({ kind: "follow_up", itemId: tapId, message: "Alpha", questionId });
    assert.deepEqual(await local(adapter).execute(tap("an-earlier-question"), "tap-stale"), { ok: false, error: ANSWERED });
    assert.deepEqual(await local(adapter).execute(tap(asked.questionId!), "tap"), { ok: true });
    await until("the tapped option to come back from the model", async () => /^ACK RESULT .*Alpha/.test((await adapter.report(tapId)).text ?? ""), 60_000);
    await until("the question to be gone", async () => (await adapter.report(tapId)).question === null, 30_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree", async () => {
    const profile: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };
    const started = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile }, "start-wt");
    assert.equal(started.ok, true, JSON.stringify(started));
    const wtId = (started as { itemId: string }).itemId;
    starts.push(wtId);
    await until("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 90_000);
    await until("its reply to be read", async () => (await adapter.report(wtId)).text === "ACK Worktree words WTONE", 90_000);
  });

  await t.test("typed: a message from T3's web app is yours at a computer, from its phone app yours away from one; 10 & 2's follow-ups and new work aren't", async () => {
    await until("the last run to end", async () => (await item())?.status === "completed", 60_000);
    // T3's own clients, as the user would type in them: a session of the test's own.
    const s = await issueSession({ cli: ["t3"], label: "10and2-harness-typed", ttl: "10m", scopes: CONNECTOR_SCOPES });
    const rpc = await RpcClient.connect(baseUrl, s.token);
    const send = (text: string, creationSource: "web" | "mobile") => rpc.request("orchestration.dispatchCommand", {
      type: "message.dispatch", commandId: `harness-${creationSource}-${Date.now()}`, threadId: id, messageId: `harness-${creationSource}-${Date.now()}`, text, attachments: [],
      createdBy: "user", creationSource, dispatchMode: { type: "queue_after_active" } });
    try {
      // So far only 10 & 2 has written in it: its launch (from 10 & 2, "mobile") and its follow-ups.
      assert.equal((await typed(id))?.desk, null, "10 & 2's own sends aren't a person's at a computer");
      const from = Date.now();
      await send("Web words WEBONE", "web");
      await until("the model to get the web message", () => mock.saw("Web words WEBONE"), 60_000);
      await until("it to be typed at a computer", async () => !!(await typed(id))?.desk, 30_000);
      const web = (await typed(id))!;
      assert.ok(Date.parse(web.desk!) >= from - 2000 && Date.parse(web.desk!) <= Date.now(), JSON.stringify(web));
      assert.equal(web.at, web.desk);
      await until("the web message's run to end", async () => (await item())?.status === "completed", 60_000);
      await send("Phone words PHONEONE", "mobile");
      await until("the model to get the phone message", () => mock.saw("Phone words PHONEONE"), 60_000);
      await until("it to be yours, not at a computer", async () => (await typed(id))?.at !== web.at, 30_000);
      const phone = (await typed(id))!;
      assert.equal(phone.desk, web.desk, "the phone's isn't at a computer");
      assert.deepEqual(await follow("after-typed", "Follow words FOLLOWTWO"), { ok: true });
      await until("the model to get it", () => mock.saw("Follow words FOLLOWTWO"), 60_000);
      await until("its run to end", async () => (await item())?.status === "completed", 60_000);
      await sleep(1500);
      assert.deepEqual(await typed(id), phone, "10 & 2's follow-up isn't yours");
      for (const s of starts.slice(1)) assert.equal((await typed(s))?.desk, null, "new work 10 & 2 started isn't yours at a computer");
    } finally {
      rpc.close(); await revokeSession(["t3"], s.sessionId);
    }
  });

  await t.test("start on a chosen model: the project offers T3's models, and new work starts on the one named", async () => {
    // T3 checks its providers after it starts; the connector reads them at connect, each launch and every 10 minutes.
    const offered = () => adapter.places().find((p) => p.id === place)?.models ?? [];
    await until("the project's models", async () => { await (adapter as any).refreshConfig(); return offered().some((m) => m.id.startsWith("codex:")); }, 120_000);
    t.diagnostic(`offered: ${offered().map((m) => `${m.id} (${m.name} on ${m.provider})`).join(", ")}`);
    const chosen = offered().find((m) => m.id.startsWith("codex:"))!;
    assert.equal(chosen.provider, "Codex", "named as T3's picker names its provider");
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    // Titled, so T3 asks no model for a title (it would, on a small one of its own).
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness model", message: "Model words MODELONE", profile, model: chosen.id }, "start-model");
    assert.equal(started.ok, true, JSON.stringify(started));
    const modelId = (started as { itemId: string }).itemId;
    await until("its reply to be read", async () => (await adapter.report(modelId)).text === "ACK Model words MODELONE", 90_000);
    const slug = chosen.id.slice(chosen.id.indexOf(":") + 1);
    assert.ok(mock.requests().some((r) => r.texts.some((x) => x.includes("MODELONE")) && r.model === slug), `asked of ${slug}: ${JSON.stringify(mock.requests().filter((r) => r.texts.some((x) => x.includes("MODELONE"))).map((r) => r.model))}`);
    assert.deepEqual(await adapter.execute({ kind: "start_work", placeId: place, message: "Not this", profile, model: "codex:not-a-model" }, "start-no-model"),
      { ok: false, error: "T3 Code doesn't offer that model for this project now." });
  });

  await t.test("checks: a test run's pass and failure, from its command's exit, are the run's (mid-run) and the reply's checks", async () => {
    const profile: LaunchProfile = { name: "Full", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    await checksByStart(adapter, place, profile, cwd);
  });

  await t.test("schedule: a message set up for later goes at its time and not before, held and sent by the connector (the engine's stage 4a)", async () => {
    await until("it to be idle", async () => { const i = (await adapter.list()).find((x) => x.id === id); return !!i && i.status !== "running"; }, 60_000);
    const held = await scheduled(adapter, id, "Later words LATERONE");
    assert.equal(held.state, "sent", JSON.stringify(held));
    await until("the model to get it", () => mock.saw("Later words LATERONE"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Later words LATERONE", 60_000);
  });

  await t.test("tidy: a thread is settled and snoozed", async () => {
    assert.deepEqual(await adapter.execute({ kind: "settle", itemId: id } as Action, "settle"), { ok: true });
    await until("it to be settled", async () => (await item())?.settled === true, 30_000);
    const until_ = new Date(Date.now() + 3_600_000).toISOString();
    assert.deepEqual(await adapter.execute({ kind: "snooze", itemId: id, until: until_ } as Action, "snooze"), { ok: true });
    await until("it to be snoozed", async () => !!(await item())?.snoozedUntil, 30_000);
  });
});
