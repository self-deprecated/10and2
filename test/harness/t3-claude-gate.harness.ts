// Commands that wait (docs/launch/engine.md §11 stage 4; spike/two-key-hold) in a T3 Code thread run by Claude (T3's
// Claude Agent SDK provider, `claudeAgent`), for real: T3 Code's own server (`t3 serve`) on the fake model, the user's
// Claude settings with 10 & 2's hooks (the list's PreToolUse among them), the connector's Claude adapter on the hook
// socket and its T3 adapter, wired as `10and2 run` wires them (`claimGate`). The thread, in full access, runs a `git push
// --force` on the list to a local bare repository: held by the T3 thread itself; Stop it from the phone keeps the remote
// as it was; asked again, Let it run from the release path hands it back to the thread's runtime mode, and the push
// lands. Runs in the harness container only (run.sh t3-claude-gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3Adapter } from "../../src/t3/adapter.ts";
import { ClaudeAdapter } from "../../src/claude/adapter.ts";
import { Local } from "../../src/local.ts";
import { NO_LONGER, TAP_TO_RUN } from "../../src/gate.ts";
import type { Policy } from "../../src/policy.ts";
import { issueSession, revokeSession, CONNECTOR_SCOPES } from "../../src/t3/auth.ts";
import { RpcClient } from "../../src/t3/rpc.ts";
import { installHooks } from "../../src/claude/hooks.ts";
import type { LaunchProfile } from "../../src/contract.ts";
import { has, home, inContainer, mockModel, project, sleep, until } from "./lib.ts";

const skip = !inContainer || !has("t3") || !has("claude") ? "runs in the harness container (test/harness/run.sh)" : false;
const PORT = 3773;
const KEY = "sk-ant-mock-00000000000000000000000000";

test("T3 Code's Claude thread: a force push on the list is held by the thread; Stop it keeps the remote; Let it run lands it", { skip, timeout: 480_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project();
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const remote = join(cwd, "..", "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git("remote", "add", "origin", remote); git("push", "-q", "origin", "main");
  writeFileSync(join(cwd, "README.md"), "# Lap timer\n\nRewritten.\n");
  git("commit", "-q", "-a", "--amend", "-m", "Start, rewritten");
  const before = execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim(), rewritten = git("rev-parse", "HEAD");
  const remoteMain = () => execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();

  // The user's Claude Code, as T3's Claude threads find it: its config folder, 10 & 2's hooks, the guard list.
  const config = join(home("t3-claude"), ".claude"), state = join(config, "..", "connector");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  const policy: Policy = { brain: "wss://unused.invalid/connector", projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
    claude: true, t3: true, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", guard: ["git push*--force*"] };
  const policyFile = join(state, "connector.json"), hookLog = join(state, "hooks.jsonl"), sock = join(state, "hooks.sock");
  writeFileSync(policyFile, JSON.stringify(policy));
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`, true, policyFile, sock);
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY,
    HARNESS_HOOK_SOCKET: sock, HARNESS_POLICY: policyFile, HARNESS_HOOK_LOG: hookLog });

  // T3's data of its own (T3CODE_HOME, with the image's T3 runtime linked in, as there's no network to fetch it): in the
  // container's ~/.t3 it outlived this file, and t3.harness.ts, run next by run.sh, then found this project by its name
  // and started there, or, once T3 had folded its projects' settings in, found its own project's default model ignored.
  const t3Home = join(home("t3-gate-data"), ".t3");
  mkdirSync(t3Home, { recursive: true });
  symlinkSync(join(homedir(), ".t3", "runtime"), join(t3Home, "runtime"));
  process.env.T3CODE_HOME = t3Home;
  const server = spawn("t3", ["serve", "--no-browser", "--host", "127.0.0.1", "--port", String(PORT), cwd], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let serverLog = "";
  server.stdout!.on("data", (b) => { serverLog += b; }); server.stderr!.on("data", (b) => { serverLog += b; });
  const baseUrl = `http://127.0.0.1:${PORT}`;
  t.after(() => { try { process.kill(-server.pid!, "SIGKILL"); } catch { /* gone */ } });
  try { await until("T3's server", async () => /Listening on http/.test(serverLog) || (await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(2000) }).catch(() => null)) !== null, 180_000); }
  catch (e) { t.diagnostic(serverLog.slice(-4000)); throw e; }
  // T3's server answers before it takes CLI commands: `project add` is tried until it does.
  await until("t3 project add", () => { try { execFileSync("t3", ["project", "add", cwd, "--title", "gate-timer"], { encoding: "utf8", timeout: 60_000, stdio: "pipe" }); return true; } catch { return false; } }, 180_000);

  const log = (m: string) => t.diagnostic(m);
  const t3 = new T3Adapter({ baseUrl, cli: ["t3"], label: "10and2-harness", log, worktreeBase: "HEAD" });
  const claude = new ClaudeAdapter({ configDir: config, db: join(state, "claude.db"), stateDir: state, hookSocketPath: sock, log, policy,
    claimGate: (session, socket, command, matched) => t3.claimGate(session, socket, command, matched) });
  const local = new Local([{ prefix: "", adapter: t3, retrySafe: true }, { prefix: "claude", adapter: claude }], policy);
  t.after(async () => { await local.close(); });
  await Promise.race([t3.start(), sleep(60_000).then(() => { throw new Error("T3 didn't connect within a minute"); })]);
  await claude.start();
  // Its own title: T3's data is the container's ~/.t3, which t3.harness.ts, run after this, shares.
  await until("the project to be a place", () => t3.places().some((p) => p.name === "gate-timer"), 30_000);
  const place = t3.places().find((p) => p.name === "gate-timer")!.id;
  const s = await issueSession({ cli: ["t3"], label: "10and2-harness-setup", ttl: "10m", scopes: CONNECTOR_SCOPES });
  const rpc = await RpcClient.connect(baseUrl, s.token);
  await rpc.request("projects.mutate", { type: "project.update", commandId: `harness-${Date.now()}`, projectId: place, defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" } });
  rpc.close(); await revokeSession(["t3"], s.sessionId);
  await until("the project's model to arrive", () => t3.modelFor(place) !== null, 30_000);
  const hooks = () => existsSync(hookLog) ? readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  const profile: LaunchProfile = { name: "Full", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
  const started = await local.execute({ kind: "start_work", placeId: place, title: "Harness push", message: "Please RUNCMD[git push --force origin main]", profile }, "t3-claude-push");
  assert.equal(started.ok, true, JSON.stringify(started));
  const id = (started as { itemId: string }).itemId;
  const item = async () => (await local.list()).find((i) => i.id === id);
  let questionId = "";

  await t.test("held by the T3 thread itself; a spoken yes is refused; Stop it keeps the remote as it was", async () => {
    try { await until("the command to be held", async () => !!(await item())?.gate, 120_000); }
    catch (e) { t.diagnostic(`hooks: ${JSON.stringify(hooks().map((h) => [h.input?.hook_event_name, h.input?.tool_name, h.printed]))}`); t.diagnostic(serverLog.slice(-4000)); throw e; }
    const held = (await item())!;
    questionId = held.questionId!;
    const report = await local.report(id);
    assert.deepEqual([held.status, held.pendingQuestion, held.gate?.matched, report.question, report.choices], ["waiting", true, "git push --force origin main", "wants to run git push --force origin main", null]);
    assert.deepEqual(await local.execute({ kind: "follow_up", itemId: id, message: "Yes, let it run" }, "voice-yes"), { ok: false, error: TAP_TO_RUN });
    assert.equal(remoteMain(), before, "not run while held");
    assert.deepEqual(await local.answerHold(id, questionId, false), { ok: true });
    await until("the model to get the refusal", () => mock.saw("the user said no from their phone"), 90_000);
    assert.equal(remoteMain(), before, "the force push didn't run");
    // The hook's log line is written once it has answered.
    await until("the hook's log", () => hooks().some((h) => h.input?.hook_event_name === "PreToolUse"), 10_000);
    const gate = hooks().find((h) => h.input?.hook_event_name === "PreToolUse");
    t.diagnostic(`PreToolUse from T3's Claude thread: ${JSON.stringify({ ...gate?.input, transcript_path: "…" })}`);
    assert.equal(gate?.input?.permission_mode, "bypassPermissions", "T3's full access is Claude Code's bypass mode");
    await until("its reply", async () => /^ACK RESULT/.test((await local.report(id)).text ?? ""), 90_000);
    assert.equal((await item())?.gate, undefined, "no longer held");
  });

  await t.test("asked again in the thread: held with a new id; Let it run from the release path lets the thread's full access run it", async () => {
    assert.deepEqual(await local.execute({ kind: "follow_up", itemId: id, message: "Please RUNCMD[git push --force origin main]" }, "follow-up"), { ok: true });
    await until("the command to be held again", async () => !!(await item())?.gate && (await item())?.questionId !== questionId, 120_000);
    const again = (await item())!.questionId!;
    assert.deepEqual(await local.answerHold(id, questionId, true), { ok: false, error: NO_LONGER });
    assert.deepEqual(await local.answerHold(id, again, true), { ok: true });
    await until("the force push to land", () => remoteMain() === rewritten, 90_000);
    const gates = hooks().filter((h) => h.input?.tool_input?.command === "git push --force origin main");
    assert.equal(gates.length, 2);
    assert.match(gates[0].printed, /"permissionDecision":"deny"/);
    assert.equal(gates[1].printed, "", "Let it run decides nothing: the thread's own mode does");
  });
});
