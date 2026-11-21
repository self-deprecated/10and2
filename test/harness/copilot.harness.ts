// GitHub Copilot CLI, for real, against the fake model (its own models, offline: COPILOT_PROVIDER_BASE_URL and
// COPILOT_OFFLINE, so it never reaches GitHub): a session open in its terminal UI is listed and read, its question is
// read out, and it isn't sent to while it's open; once closed it's continued through Copilot's ACP mode, where a
// permission it asks for is refused; new work starts in the checkout (allow-all, which runs its tool), in a worktree,
// and on a model Copilot lists. Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpAdapter } from "../../src/acp/adapter.ts";
import { CopilotSource } from "../../src/copilot/source.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, home, inContainer, mockModel, project, sleep, Terminal, until } from "./lib.ts";

const skip = (!inContainer && process.env.TENANDTWO_HARNESS_HERE !== "1") || !has("copilot") ? "runs in the harness container (test/harness/run.sh)" : false;

test("Copilot CLI: list, read, its question, refuse an open session, continue a closed one, refuse its permission, start work", { skip, timeout: 300_000 }, async (t) => {
  // The real path: macOS's temp folder is a link (/var → /private/var), and the agents record where they really ran.
  const mock = await mockModel(t), cwd = realpathSync(project()), root = home("copilot"), state = join(root, "connector");
  mkdirSync(state, { recursive: true });
  // The runner the adapter starts (and the Copilot it runs) inherit this; the terminal gets it explicitly.
  const env = { HOME: root, COPILOT_HOME: join(root, ".copilot"), COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: `${mock.url}/v1`, COPILOT_MODEL: "mock-model", COPILOT_AUTO_UPDATE: "false" };
  Object.assign(process.env, env);

  const adapter = new AcpAdapter({ source: new CopilotSource({ dir: env.COPILOT_HOME }), db: join(state, "copilot.db"), stateDir: state, log: (m) => t.diagnostic(m),
    entryScript: resolve(import.meta.dirname, "..", "fixtures", "acp", "turn.ts"), acceptanceTimeoutMs: 60_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
      claude: false, t3: false, codex: false, opencode: false, pi: false, copilot: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("copilot");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });

  let id = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);
  const start = (key: string, message: string, profile: Partial<LaunchProfile> = {}, model?: string) => adapter.execute({ kind: "start_work", placeId: adapter.places()[0]!.id,
    title: `Harness ${key}`, message, profile: { name: "Build", runtimeMode: "full-access", workspace: "root", interactionMode: "default", ...profile }, ...(model ? { model } : {}) }, key);
  const item = async () => (await adapter.list()).find((i) => i.id === id);

  await t.test("read: a session open in its terminal is listed and read, and isn't sent to while it's open", async () => {
    tui.start("copilot", cwd, env);
    await until("the folder trust question", () => tui.screen().includes("Do you trust the files in this folder?"), 60_000);
    tui.key("Enter");
    await until("the terminal to be ready", () => tui.screen().includes("Manual Approval"), 30_000);
    await tui.type("First words CPONE");
    await until("its first reply", () => tui.screen().includes("ACK First words CPONE"), 60_000);
    await adapter.start();
    await until("it to be listed", async () => { const items = await adapter.list(); id = items[0]?.id ?? ""; return items.length === 1 && items[0]!.status === "completed"; });
    assert.equal((await adapter.report(id)).text, "ACK First words CPONE");
    assert.equal((await item())!.title, "First words CPONE");
    assert.match(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }) ?? "", /open in Copilot CLI/);
  });

  await t.test("question: Copilot's ask_user, open in its terminal, is read out and answered there", async () => {
    await tui.type("Ask me CPASKQ");
    await until("the question to be listed", async () => (await item())?.pendingQuestion === true, 60_000);
    assert.equal((await item())!.status, "waiting");
    assert.equal((await adapter.report(id)).question, "Which one? Options: Alpha / Beta.");
    assert.match(await adapter.check({ kind: "follow_up", itemId: id, message: "Alpha" }) ?? "", /waiting for your answer in Copilot CLI/);
    tui.key("Enter");
    await until("the answer's reply", async () => (await adapter.report(id)).text.startsWith("ACK RESULT"), 60_000);
    assert.equal((await item())!.pendingQuestion, false);
  });

  await t.test("continue: once the terminal is closed, the session is continued through ACP", async () => {
    tui.stop();
    await until("the session to be closed", async () => (await adapter.check({ kind: "follow_up", itemId: id, message: "x" })) === null, 30_000);
    assert.deepEqual(await follow("closed", "Closed words CPCLOSED"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words CPCLOSED"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Closed words CPCLOSED", 60_000);
  });

  await t.test("refused: a tool Copilot asks permission for, with allow-all off, never runs, and Copilot stops the turn", async () => {
    await until("the last run to end", async () => (await adapter.check({ kind: "follow_up", itemId: id, message: "x" })) === null, 60_000);
    assert.deepEqual(await follow("refuse", "Please TOUCH=refused-by-driver"), { ok: true });
    // Copilot takes a refused permission as the user stopping the turn (an `abort`), unlike Gemini, which goes on.
    await until("the turn to stop", async () => (await item())?.status === "cancelled", 60_000);
    assert.ok(!existsSync(join(cwd, "refused-by-driver")), "the tool didn't run");
  });

  await t.test("start: new work in the checkout, with allow-all, runs its tool", async () => {
    const started = await start("root", "Root words TOUCH=made-by-allow-all");
    assert.equal(started.ok, true, JSON.stringify(started));
    const itemId = started.ok ? started.itemId! : "";
    await until("its tool to run", () => existsSync(join(cwd, "made-by-allow-all")), 60_000);
    await until("the new work to be listed and read", async () => (await adapter.list()).some((i) => i.id === itemId && i.title === "Harness root")
      && (await adapter.report(itemId)).text.startsWith("ACK RESULT"), 60_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree inside the project", async () => {
    const started = await start("worktree", "Worktree words CPTREE", { workspace: "worktree" });
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get it", () => mock.saw("Worktree words CPTREE"), 60_000);
    assert.ok(readdirSync(join(cwd, ".copilot", "worktrees")).some((d) => d.startsWith("10and2-")), "it ran in a worktree");
    assert.equal(adapter.places().length, 1, "the worktree isn't a project of its own");
  });

  await t.test("model: new work on a model Copilot lists", async () => {
    await until("Copilot's models to be read", () => (adapter.places()[0]?.models ?? []).some((m) => m.id === "mock-model"), 60_000);
    const started = await start("model", "Model words CPMODEL", {}, "mock-model");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get it", () => mock.saw("Model words CPMODEL"), 60_000);
    await sleep(300);
    assert.ok(mock.requests().some((r) => r.texts.some((x) => x.includes("CPMODEL")) && r.model === "mock-model"));
  });
});
