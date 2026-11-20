import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChoice, applyFlags, capsFor, choiceOf, defaultChoice, policyFields, startingChoice, summary, type Choice } from "../src/choose.ts";
import { describeFound, detect, type Found } from "../src/agents.ts";
import { allows, answers, ceilingFor, parsePolicy, steers } from "../src/policy.ts";
import { listStep, marks, type ListState } from "../src/ui.ts";
import { removeDir, WINDOWS } from "./fixtures/platform.ts";

const found = (installed: Partial<Record<Found["agent"], boolean>>): Found[] =>
  (["claude", "codex", "pi", "opencode", "t3"] as const).map((agent) => ({
    agent, name: agent, installed: !!installed[agent], version: installed[agent] ? "1.0.0" : null, sessions: installed[agent] ? 3 : null, open: null,
  }));
const flags = (o: Record<string, string>) => new Map(Object.entries(o));
const base = { brain: "wss://brain.example/connector", projects: "*" };

test("every agent found starts on, with everything allowed", () => {
  const c = defaultChoice(found({ claude: true, pi: true }));
  assert.deepEqual(c.on, { t3: false, claude: true, codex: false, opencode: false, pi: true });
  assert.ok(Object.values(c.caps).every(Boolean));
  assert.equal(c.ceiling, "full-access");
});

test("a choice written and read back is the same choice, and the policy enforces what it says", () => {
  const c: Choice = { ...defaultChoice(found({ claude: true, codex: true, pi: true })), off: { codex: ["steer", "start_work"] } };
  const written = applyChoice({ ...base, claude: true, t3: true }, c);
  assert.equal(written.t3, undefined, "the older top-level booleans give way to agents");
  assert.deepEqual(written.agents, { claude: true, codex: { steer: false, actions: ["follow_up", "settle", "snooze", "archive"] }, pi: true, opencode: false, t3: false });
  assert.deepEqual(choiceOf(written), c);

  const p = parsePolicy(JSON.stringify(written));
  assert.equal(steers(p, "claude"), true);
  assert.equal(steers(p, "codex"), false);
  assert.equal(answers(p, "codex"), true);
  assert.equal(allows(p, "start_work", "codex"), false);
  assert.equal(allows(p, "start_work", "claude"), true);
  assert.equal(allows(p, "archive", "codex"), true);
  assert.equal(p.opencode, false);
  assert.equal(ceilingFor(p, "codex"), "full-access");
  assert.deepEqual(capsFor(c, "codex"), ["follow_up", "answer", "tidy"]);
});

test("switching follow-ups off takes steering and answering with it", () => {
  const c = { ...defaultChoice(found({ claude: true })), caps: { follow_up: false, steer: true, answer: true, start_work: true, tidy: true } };
  const p = parsePolicy(JSON.stringify(applyChoice(base, c)));
  assert.equal(steers(p, "claude"), false);
  assert.equal(answers(p, "claude"), false);
  assert.deepEqual(capsFor(c, "claude"), ["start_work", "tidy"]);
});

test("a file from before agents reads as the same choice", () => {
  const c = choiceOf({ ...base, claude: true, actions: ["follow_up", "settle", "snooze", "archive"], maxRuntimeMode: "auto" });
  assert.deepEqual(c.on, { t3: true, claude: true, codex: false, opencode: false, pi: false });
  assert.deepEqual(c.caps, { follow_up: true, steer: true, answer: true, start_work: false, tidy: true });
  assert.equal(c.ceiling, "auto");
});

test("flags choose without a terminal, and narrow one agent when given names", () => {
  const start = defaultChoice(found({ claude: true, codex: true, pi: true }));
  const only = applyFlags(start, flags({ agents: "claude,pi", "no-steer": "true", "no-start": "true" }));
  assert.deepEqual(only.on, { t3: false, claude: true, codex: false, opencode: false, pi: true });
  assert.equal(only.caps.steer, false);
  assert.equal(only.caps.start_work, false);
  assert.equal(start.caps.steer, true, "the choice given isn't changed");

  const narrowed = applyFlags(start, flags({ off: "codex", "no-answer": "pi" }));
  assert.equal(narrowed.on.codex, false);
  assert.deepEqual(narrowed.off, { pi: ["answer"] });
  assert.equal(narrowed.caps.answer, true);

  const ro = applyFlags(start, flags({ "read-only": "true" }));
  assert.ok(Object.values(ro.caps).every((v) => !v));
  assert.throws(() => applyFlags(start, flags({ agents: "claude,cursor" })), /no agent called "cursor"/);
});

test("the closing words say who 10 & 2 reaches, what it may do, and what's narrower", () => {
  const c: Choice = { ...defaultChoice(found({ claude: true, codex: true, pi: true, opencode: true })), off: { codex: ["steer", "start_work"] } };
  c.on.opencode = false;
  const lines = summary(c, found({ claude: true, codex: true, pi: true, opencode: true }));
  assert.match(lines[0]!, /^10 & 2 can reach Claude Code, Codex and Pi \(OpenCode is off\), and can follow up, steer an open session/);
  assert.equal(lines[1], "For Codex: no steering, no new work.");
  const none = summary({ ...c, caps: { follow_up: false, steer: false, answer: false, start_work: false, tidy: false } }, found({ claude: true }));
  assert.match(none[0]!, /can only read/);
  assert.equal(none.length, 1, "nothing is narrower than nothing");
});

test("what's found is described briefly", () => {
  assert.equal(describeFound({ agent: "pi", name: "Pi", installed: true, version: "1.5.1", sessions: 9, open: 1 }), "1.5.1 · 9 sessions · 1 open now");
  assert.equal(describeFound({ agent: "t3", name: "T3 Code", installed: false, version: null, sessions: null, open: null }), "not found");
  assert.equal(describeFound({ agent: "opencode", name: "OpenCode", installed: true, version: null, sessions: null, open: 0 }), "found");
});

test("the checklist moves, switches, opens an agent and cycles a choice", () => {
  const s: ListState = { at: 0, rows: [
    { kind: "box", label: "Claude Code", on: true, open: true },
    { kind: "box", label: "T3 Code", on: false, disabled: true },
    { kind: "choice", label: "New work may run with", options: ["a", "b", "c"], index: 2 },
  ] };
  assert.deepEqual(listStep(s, "right"), { done: true, open: 0 });
  assert.deepEqual(listStep(s, "space"), { done: false });
  assert.equal((s.rows[0] as { on: boolean }).on, false);
  assert.deepEqual(listStep(s, "right"), { done: false }, "an agent switched off has nothing to narrow");
  listStep(s, "down");
  listStep(s, "space");
  assert.equal((s.rows[1] as { on: boolean }).on, false, "a missing agent can't be switched on");
  listStep(s, "down");
  listStep(s, "right");
  assert.equal((s.rows[2] as { index: number }).index, 0);
  listStep(s, "left");
  assert.equal((s.rows[2] as { index: number }).index, 2);
  listStep(s, "down");
  assert.equal(s.at, 0, "moving wraps");
  assert.deepEqual(listStep(s, "enter"), { done: true });
  assert.deepEqual(listStep(s, "cancel"), { done: true, cancelled: true });
  assert.deepEqual(listStep({ ...s, at: 0 }, "left"), { done: false }, "← does nothing on a first screen");
  assert.deepEqual(listStep({ ...s, at: 0, back: true }, "left"), { done: true }, "← goes back from an agent's own screen");
});

test("choosing again starts from the file; agents a file from before agents doesn't mention start as found", () => {
  const all = found({ claude: true, codex: true, pi: true });
  const old = startingChoice({ ...base, claude: true, t3: false, actions: ["follow_up"] }, all);
  assert.deepEqual(old.on, { t3: false, claude: true, codex: true, opencode: false, pi: true });
  const chosen = startingChoice(applyChoice(base, { ...defaultChoice(all), on: { t3: false, claude: true, codex: false, opencode: false, pi: false } }), all);
  assert.equal(chosen.on.codex, false, "a choice made with agents stays as made");
  assert.equal(startingChoice({ ...base, claude: true, codex: false }, all).on.codex, false, "an agent the file names stays as named");
  assert.deepEqual(startingChoice(null, all).on, defaultChoice(all).on);
});

test("an agent is found by its command on PATH or by its own folder; T3 Code by its command, or one that didn't answer where T3 has run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  t.after(() => removeDir(dir));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), PI_CODING_AGENT_DIR: join(dir, "pi"),
    XDG_DATA_HOME: join(dir, "data"), T3CODE_HOME: join(dir, "t3"), T3_CLI: "t3",
  };
  const installed = async () => (await detect(env)).filter((f) => f.installed).map((f) => [f.agent, f.version]);
  assert.deepEqual(await installed(), []);
  mkdirSync(join(dir, "t3", "userdata"), { recursive: true });
  mkdirSync(join(dir, "pi", "sessions"), { recursive: true });
  assert.deepEqual(await installed(), [["pi", null]], "T3's folder without its command: the connector couldn't reach it");
  // A command npm installed: on Windows the script it writes (codex.cmd), which is run as Node and its script.
  const command = (name: string, out: string, code = 0) => {
    if (!WINDOWS) return writeFileSync(join(bin, name), `#!/bin/sh\necho ${out}\nexit ${code}\n`, { mode: 0o755 });
    writeFileSync(join(bin, `${name}.mjs`), `console.log(${JSON.stringify(out)}); process.exitCode = ${code};\n`);
    writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${name}.mjs" %*\r\n`);
  };
  command("codex", "codex-cli 0.169.0");
  command("t3", "", 1);
  assert.deepEqual(await installed(), [["codex", "0.169.0"], ["pi", null], ["t3", null]]);
});

test("the old Windows console gets marks its fonts have; Windows Terminal, VS Code's terminal and every other system get Unicode", () => {
  const unicode = marks("linux", {});
  assert.equal(unicode.ok, "✓");
  assert.deepEqual(marks("darwin", {}), unicode);
  const old = marks("win32", {});
  assert.match(old.spinner, /^[\x21-\x7e]+$/, "an ASCII spinner");
  assert.notEqual(old.ok, unicode.ok);
  assert.notEqual(old.cursor, unicode.cursor);
  assert.deepEqual(marks("win32", { WT_SESSION: "3f1c" }), unicode);
  assert.deepEqual(marks("win32", { TERM_PROGRAM: "vscode" }), unicode);
});
