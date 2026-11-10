// T3 Code, for real, against the fake model: its own server (`t3 serve`) with one project, its threads run by Codex. The
// connector mints its scoped session with T3's CLI and connects; new work starts in the checkout and in a worktree, a
// thread is listed and read, followed up idle and while busy (queued behind the run), its question answered, and it
// is settled and snoozed. Runs in the harness container only (run.sh).
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
import { has, inContainer, mockModel, project, sleep, until } from "./lib.ts";

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
    `[projects."${cwd}"]`, `trust_level = "trusted"`, ``,
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
  execFileSync("t3", ["project", "add", cwd, "--title", "lap-timer"], { stdio: "ignore", timeout: 60_000 });

  const adapter = new T3Adapter({ baseUrl, cli: ["t3"], label: "10and2-harness", log: (m) => t.diagnostic(m), worktreeBase: "HEAD" });
  t.after(async () => { await adapter.close(); });

  // Each feature is its own subtest, so an older T3 Code can pass some and fail others (src/versions.ts).
  let id = "", place = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);
  const item = async () => (await adapter.list()).find((i) => i.id === id);

  await t.test("connect: a scoped session is minted and the project is a place", async () => {
    // The adapter retries a failed connect for good; a T3 Code it can't connect to fails here, not at the test's timeout.
    await Promise.race([adapter.start(), sleep(60_000).then(() => { throw new Error("T3 didn't connect within a minute"); })]);
    await until("the project to be a place", () => adapter.places().some((p) => p.name === "lap-timer"), 30_000);
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
    await until("the question to be read", async () => /Which one\? Options: Alpha \/ Beta/.test((await adapter.report(askId)).question ?? ""), 90_000);
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: askId, message: "Beta, please" } as Action, "answer"), { ok: true });
    // The fake model echoes the tool's result as its reply.
    await until("the answer to come back from the model", async () => /^ACK RESULT .*Beta/.test((await adapter.report(askId)).text ?? ""), 60_000);
    await until("the question to be gone", async () => (await adapter.report(askId)).question === null, 30_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree", async () => {
    const profile: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };
    const started = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile }, "start-wt");
    assert.equal(started.ok, true, JSON.stringify(started));
    const wtId = (started as { itemId: string }).itemId;
    await until("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 90_000);
    await until("its reply to be read", async () => (await adapter.report(wtId)).text === "ACK Worktree words WTONE", 90_000);
  });

  await t.test("tidy: a thread is settled and snoozed", async () => {
    assert.deepEqual(await adapter.execute({ kind: "settle", itemId: id } as Action, "settle"), { ok: true });
    await until("it to be settled", async () => (await item())?.settled === true, 30_000);
    const until_ = new Date(Date.now() + 3_600_000).toISOString();
    assert.deepEqual(await adapter.execute({ kind: "snooze", itemId: id, until: until_ } as Action, "snooze"), { ok: true });
    await until("it to be snoozed", async () => !!(await item())?.snoozedUntil, 30_000);
  });
});
