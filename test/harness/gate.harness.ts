// Commands that wait (docs/launch/engine.md §11 stage 4; spike/two-key-hold) with Claude Code, for real, against the fake
// model, in its terminal UI in bypass mode (full access): the agent runs `git push --force origin main` to a local bare
// repository. With the command on the computer's list, Claude Code's PreToolUse hook holds it while the adapter reports
// the thread holding it, with its own id and no answer buttons. A follow-up whose words would let it run (a spoken yes,
// an answer button with its id) is refused and it stays held; Stop it from the phone denies it and the remote's main is
// unchanged; on the next try, Let it run from the release path (`answer_hold`) hands it back to bypass mode, which runs
// it, and the remote's main moves. A command not on the list runs with no hold. Runs in the harness container only
// (run.sh gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ClaudeAdapter } from "../../src/claude/adapter.ts";
import { HOOK_FAILED, installHooks } from "../../src/claude/hooks.ts";
import { Local } from "../../src/local.ts";
import { GATE_STOPPED, NO_LONGER, TAP_TO_RUN } from "../../src/gate.ts";
import type { Policy } from "../../src/policy.ts";
import { has, home, inContainer, mockModel, project, Terminal, until } from "./lib.ts";
import { HOLDS_OPEN_FROM } from "../../src/choose.ts";
import { versionAtLeast } from "../../src/claude/registry.ts";

const skip = !inContainer || !has("claude") ? "runs in the harness container (test/harness/run.sh)" : false;
const KEY = "sk-ant-mock-00000000000000000000000000";
/** Whether this Claude Code's sessions already open hold a command once the list is added (measured below; choose.ts). */
const version = has("claude") ? execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0] : "";
const SNAPSHOT_HELD = versionAtLeast(version, HOLDS_OPEN_FROM);

test("Claude Code in bypass mode: a force push on the list is held; no follow-up lets it go; Stop it keeps the remote as it was; Let it run from the release path lets it land", { skip, timeout: 300_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), config = join(home("claude"), ".claude"), state = join(config, "..", "connector");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  // The remote: a bare repository with main as the project has it now.
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const remote = join(cwd, "..", "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git("remote", "add", "origin", remote); git("push", "-q", "origin", "main");
  const before = git("rev-parse", "origin/main");
  // History rewritten here, so only a force push puts it on the remote.
  writeFileSync(join(cwd, "README.md"), "# Lap timer\n\nRewritten.\n");
  git("commit", "-q", "-a", "--amend", "-m", "Start, rewritten");
  const rewritten = git("rev-parse", "HEAD");
  const remoteMain = () => execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();

  // The computer's settings: the guard list, set here only. The hook reads it from this file, as `10and2 hook` does.
  const policy: Policy = { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
    claude: true, t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", guard: ["git push*--force*"] };
  const policyFile = join(state, "connector.json"), hookLog = join(state, "hooks.jsonl");
  writeFileSync(policyFile, JSON.stringify(policy));
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`, true, policyFile, join(state, "hooks.sock"));
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: join(state, "hooks.sock"), HARNESS_POLICY: policyFile, HARNESS_HOOK_LOG: hookLog };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config });

  const adapter = new ClaudeAdapter({ configDir: config, db: join(state, "claude.db"), stateDir: state, hookSocketPath: join(state, "hooks.sock"), log: (m) => t.diagnostic(m), policy });
  const local = new Local([{ prefix: "", adapter }], policy);
  const tui = new Terminal("claude-gate");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });
  const hooks = () => existsSync(hookLog) ? readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const sessions = () => readdirSync(join(config, "sessions")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(config, "sessions", f), "utf8")));

  tui.start("claude --dangerously-skip-permissions", cwd, env);
  await until("the terminal to be ready", () => tui.screen().includes("❯"), 60_000);
  await adapter.start();
  await tui.type("First words GATEONE");
  await until("its first reply", () => tui.screen().includes("ACK First words GATEONE"), 60_000);
  await until("its registry entry", () => sessions().length > 0);
  const id = sessions()[0].sessionId as string;
  await until("it to be listed", async () => (await adapter.list()).some((i) => i.id === id));
  const item = async () => (await adapter.list()).find((i) => i.id === id)!;

  await t.test("not on the list: runs at once, with no hold", async () => {
    await tui.type("Status words RUNCMD[git status --short]");
    await until("its result to reach the model", () => mock.requests().some((r) => r.texts.some((x: string) => /git status/.test(x))) && tui.screen().includes("ACK RESULT"), 60_000);
    const passed = hooks().filter((h) => h.input?.hook_event_name === "PreToolUse");
    assert.equal(passed.length, 1);
    assert.deepEqual([passed[0].input.tool_name, passed[0].input.tool_input.command, passed[0].printed], ["Bash", "git status --short", ""]);
    t.diagnostic(`PreToolUse as Claude Code sent it: ${JSON.stringify({ ...passed[0].input, transcript_path: "…" })}`);
    t.diagnostic(`the hook took ${passed[0].ms} ms after starting (not counting Node's start)`);
  });

  let questionId = "";
  await t.test("held: the thread holds it, with its own id and no answer buttons; no follow-up lets it go; Stop it denies it", async () => {
    await tui.type("Push words RUNCMD[git push --force origin main]");
    await until("the command to be held", async () => !!(await item()).gate, 60_000);
    const held = await item();
    questionId = held.questionId!;
    const report = await adapter.report(id);
    assert.deepEqual([held.pendingQuestion, held.gate?.matched, report.question, report.choices], [true, "git push --force origin main", "wants to run git push --force origin main", null]);
    // A spoken yes, and an answer button's "Let it run" with the hold's own id: refused, it stays held.
    for (const [key, questionId_] of [["voice-yes", undefined], ["button", questionId]] as const) {
      const said = await local.execute({ kind: "follow_up", itemId: id, message: "Let it run", ...(questionId_ ? { questionId: questionId_ } : {}) }, key);
      assert.deepEqual(said, { ok: false, error: TAP_TO_RUN }, key);
    }
    assert.equal((await item()).questionId, questionId, "still held");
    assert.equal(remoteMain(), before, "not run while held");
    // Stop it from the phone: denied; the model is told why, and the remote is as it was.
    assert.deepEqual(await local.answerHold(id, questionId, false), { ok: true });
    await until("the model to get the refusal", () => mock.saw("the user said no from their phone"), 60_000);
    assert.ok(GATE_STOPPED.includes("the user said no from their phone"));
    assert.equal(remoteMain(), before, "the force push didn't run");
    assert.equal((await item()).gate, undefined, "no longer held");
  });

  await t.test("Let it run from the release path, with its own id: bypass mode runs it, and the remote's main moves", async () => {
    await tui.type("Again words RUNCMD[git push --force origin main]");
    await until("the command to be held again", async () => !!(await item()).gate && (await item()).questionId !== questionId, 60_000);
    const again = (await item()).questionId!;
    // The earlier notification's answer: that hold is over, nothing sent.
    assert.deepEqual(await local.answerHold(id, questionId, true), { ok: false, error: NO_LONGER });
    assert.deepEqual(await local.answerHold(id, again, true), { ok: true });
    await until("the force push to land", () => remoteMain() === rewritten, 60_000);
    const gates = hooks().filter((h) => h.input?.tool_input?.command === "git push --force origin main");
    assert.equal(gates.length, 2);
    assert.match(gates[0].printed, /"permissionDecision":"deny"/);
    assert.equal(gates[1].printed, "", "Let it run decides nothing: Claude Code's own mode does");
  });

  await t.test("two commands on the list in one call: stopped at once, neither held nor run, the agent told to run each on its own", async () => {
    const marker = join(cwd, "..", "BOTH-RAN");
    await tui.type(`Both words RUNCMD[git push --force origin main && touch ${marker} && git push --force origin HEAD:other]`);
    await until("the model to be told to run each on its own", () => mock.saw("Run each of them on its own"), 60_000);
    assert.equal(existsSync(marker), false, "nothing of the call ran");
    assert.equal((await item()).gate, undefined, "never held");
    const last = hooks().filter((h) => h.input?.hook_event_name === "PreToolUse").at(-1);
    assert.match(last.printed, /"permissionDecision":"deny"/);
    // The gate's entry names the settings it reads (`--policy`) and the connector's socket (`--socket`): the list here
    // came from that file, and the holds above from that socket.
    const entry = JSON.parse(readFileSync(join(config, "settings.json"), "utf8")).hooks.PreToolUse.at(-1).hooks[0].command as string;
    assert.ok(entry.includes(`--policy '${policyFile}' --socket '${join(state, "hooks.sock")}'`), entry);
  });

  await t.test("the hook itself can't run (10and2 not on PATH): the gate's entry blocks the command, with why for the agent", async () => {
    // Claude Code treats any other failure of a hook as deciding nothing: only exit code 2 blocks (stage 4's review). It
    // can't check any command then, so every Bash call is blocked. A session started after the change (an older Claude
    // Code's open sessions keep the hooks they started with).
    await installHooks(config, "/nonexistent/10and2", true, policyFile, join(state, "hooks.sock"));
    const unhooked = new Terminal("claude-gate-unhooked");
    t.after(() => unhooked.stop());
    unhooked.start("claude --dangerously-skip-permissions", cwd, env);
    await until("the new terminal to be ready", () => unhooked.screen().includes("❯"), 60_000);
    const marker = join(cwd, "..", "UNHOOKED-RAN");
    await unhooked.type(`Unhooked words RUNCMD[touch ${marker}]`);
    await until("the model to be told it wasn't run", () => mock.saw(HOOK_FAILED), 60_000);
    assert.equal(existsSync(marker), false, "never run");
    unhooked.stop();
    await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`, true, policyFile, join(state, "hooks.sock"));
  });
});

test("a Claude Code session already running when the list is added: is its next command on it held?", { skip, timeout: 240_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project("snapshot"), config = join(home("claude-snap"), ".claude"), state = join(config, "..", "connector");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  const marker = join(cwd, "..", "GUARDED-RAN");
  const policy: Policy = { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
    claude: true, t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", guard: ["touch *GUARDED-RAN*"] };
  const policyFile = join(state, "connector.json"), hookLog = join(state, "hooks.jsonl"), sock = join(state, "hooks.sock");
  writeFileSync(policyFile, JSON.stringify(policy));
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  // 10 & 2's hooks as before a guard list: no PreToolUse.
  await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`, false);
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: sock, HARNESS_POLICY: policyFile, HARNESS_HOOK_LOG: hookLog };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config });
  const adapter = new ClaudeAdapter({ configDir: config, db: join(state, "claude.db"), stateDir: state, hookSocketPath: sock, log: (m) => t.diagnostic(m), policy });
  const tui = new Terminal("claude-gate-snapshot");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });
  tui.start("claude --dangerously-skip-permissions", cwd, env);
  await until("the terminal to be ready", () => tui.screen().includes("❯"), 60_000);
  await adapter.start();
  await tui.type("First words SNAPONE");
  await until("its first reply", () => tui.screen().includes("ACK First words SNAPONE"), 60_000);
  // `10and2 setup` adds the guard while the session runs.
  await installHooks(config, `node ${join(import.meta.dirname, "hook.ts")}`, true, policyFile, join(state, "hooks.sock"));
  await new Promise((r) => setTimeout(r, 3000));
  await tui.type(`Touch words RUNCMD[touch ${marker}]`);
  const held = async () => (await adapter.list()).some((i) => !!i.gate);
  await until("the command to be held or run", async () => existsSync(marker) || await held(), 60_000);
  const wasHeld = await held();
  t.diagnostic(`a session started before the guard: ${wasHeld ? "held" : "ran unheld"}; screen: ${JSON.stringify(tui.screen().split("\n").filter((l) => /hook|PreToolUse|settings/i.test(l)).slice(0, 5))}`);
  if (wasHeld) {
    const item = (await adapter.list()).find((i) => i.gate)!;
    await new Local([{ prefix: "", adapter }], policy).answerHold(item.id, item.questionId!, false);
  }
  // A session started after it: held.
  const after = new Terminal("claude-gate-snapshot-after");
  t.after(() => after.stop());
  after.start("claude --dangerously-skip-permissions", cwd, env);
  await until("the second terminal to be ready", () => after.screen().includes("❯"), 60_000);
  await after.type(`Touch words RUNCMD[touch ${marker}-2]`);
  await until("the second session's command to be held or run", async () => existsSync(`${marker}-2`) || await held(), 60_000);
  const afterHeld = await held();
  t.diagnostic(`a session started after the guard: ${afterHeld ? "held" : "ran unheld"}`);
  assert.equal(afterHeld, true);
  assert.equal(wasHeld, SNAPSHOT_HELD, `a session running when the guard was added: ${wasHeld ? "held" : "ran unheld"}`);
});
