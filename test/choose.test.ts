import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { applyChoice, applyFlags, capsFor, choiceOf, defaultChoice, policyFields, startingChoice, summary, type Choice } from "../src/choose.ts";
import { describeFound, detect, type Found } from "../src/agents.ts";
import { allows, answers, ceilingFor, parsePolicy, steers } from "../src/policy.ts";
import { drawList, listStep, marks, type ListState } from "../src/ui.ts";
import { NODE, removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";

const found = (installed: Partial<Record<Found["agent"], boolean>>): Found[] =>
  (["claude", "codex", "pi", "opencode", "t3"] as const).map((agent) => ({
    agent, name: agent, installed: !!installed[agent], version: installed[agent] ? "1.0.0" : null, sessions: installed[agent] ? 3 : null, open: null,
  }));
const flags = (o: Record<string, string>) => new Map(Object.entries(o));
const base = { brain: "wss://brain.example/connector", projects: "*" };

test("every agent found starts on, with everything allowed", () => {
  const c = defaultChoice(found({ claude: true, pi: true }));
  assert.deepEqual(c.on, { t3: false, claude: true, codex: false, opencode: false, pi: true, gemini: false, copilot: false, cursor: false });
  assert.ok(Object.values(c.caps).every(Boolean));
  assert.equal(c.ceiling, "full-access");
});

test("a choice written and read back is the same choice, and the policy enforces what it says", () => {
  const c: Choice = { ...defaultChoice(found({ claude: true, codex: true, pi: true })), off: { codex: ["steer", "start_work"] } };
  const written = applyChoice({ ...base, claude: true, t3: true }, c);
  assert.equal(written.t3, undefined, "the older top-level booleans give way to agents");
  assert.deepEqual(written.agents, { claude: true, codex: { steer: false, actions: ["follow_up", "settle", "snooze", "archive"] }, pi: true, opencode: false, gemini: false, copilot: false, cursor: false, t3: false });
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
  assert.deepEqual(c.on, { t3: true, claude: true, codex: false, opencode: false, pi: false, gemini: false, copilot: false, cursor: false });
  assert.deepEqual(c.caps, { follow_up: true, steer: true, answer: true, start_work: false, tidy: true });
  assert.equal(c.ceiling, "auto");
});

test("flags choose without a terminal, and narrow one agent when given names", () => {
  const here = found({ claude: true, codex: true, pi: true });
  const start = defaultChoice(here);
  const only = applyFlags(start, flags({ agents: "claude,pi", "no-steer": "true", "no-start": "true" }), here);
  assert.deepEqual(only.on, { t3: false, claude: true, codex: false, opencode: false, pi: true, gemini: false, copilot: false, cursor: false });
  assert.equal(only.caps.steer, false);
  assert.equal(only.caps.start_work, false);
  assert.equal(start.caps.steer, true, "the choice given isn't changed");

  const narrowed = applyFlags(start, flags({ off: "codex", "no-answer": "pi" }), here);
  assert.equal(narrowed.on.codex, false);
  assert.deepEqual(narrowed.off, { pi: ["answer"] });
  assert.equal(narrowed.caps.answer, true);

  const ro = applyFlags(start, flags({ "read-only": "true" }), here);
  assert.ok(Object.values(ro.caps).every((v) => !v));
  assert.throws(() => applyFlags(start, flags({ agents: "claude,aider" }), here), /no agent called "aider"/);
});

test("agent lists take spaces as well as commas: PowerShell hands npm's script --agents=claude,pi as \"claude pi\"", () => {
  const here = found({ claude: true, codex: true, pi: true });
  const c = applyFlags(defaultChoice(here), flags({ agents: "claude pi", "no-steer": "claude  pi" }), here);
  assert.deepEqual(c.on, { t3: false, claude: true, codex: false, opencode: false, pi: true, gemini: false, copilot: false, cursor: false });
  assert.deepEqual(c.off, { claude: ["steer"], pi: ["steer"] });
  assert.deepEqual(applyFlags(defaultChoice(here), flags({ off: "codex pi" }), here).on, { t3: false, claude: true, codex: false, opencode: false, pi: false, gemini: false, copilot: false, cursor: false });
});

test("--agents can't switch on an agent that wasn't found, and says which", () => {
  const here = found({ claude: true });
  // Its words, coloured or not: `node --test` passes FORCE_COLOR to its files when it writes to a terminal, as in Nix's build.
  const says = (re: RegExp) => (e: unknown) => re.test(stripVTControlCharacters(String(e)));
  assert.throws(() => applyFlags(defaultChoice(here), flags({ agents: "claude,codex" }), here),
    says(/^Error: Codex wasn't found on this computer, so 10 & 2 can't connect it\. Install it, or leave it out of --agents\.$/));
  assert.throws(() => applyFlags(defaultChoice(here), flags({ agents: "codex,pi" }), here), says(/^Error: Codex and Pi weren't found on this computer, so 10 & 2 can't connect them\./));
});

test("the closing words say who 10 & 2 reaches, what it may do, and what's narrower", () => {
  const c: Choice = { ...defaultChoice(found({ claude: true, codex: true, pi: true, opencode: true })), off: { codex: ["steer", "start_work"] } };
  c.on.opencode = false;
  const lines = summary(c, found({ claude: true, codex: true, pi: true, opencode: true }));
  assert.match(lines[0]!, /^10 & 2 can reach Claude Code, Codex and Pi \(OpenCode is off\), and can follow up, steer an open session/);
  assert.match(lines[0]!, /: each only after you hear it read back and say yes\.$/);
  assert.equal(lines[1], "For Codex: no steering, no new work.");
  const none = summary({ ...c, caps: { follow_up: false, steer: false, answer: false, start_work: false, tidy: false } }, found({ claude: true }));
  assert.equal(none[0], "10 & 2 can reach Claude Code, Codex and Pi, and can only read.", "nothing to hear read back");
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

test("in colour, an agent not found lines up with the others", (t) => {
  const was = process.env.FORCE_COLOR;
  t.after(() => { if (was === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = was; });
  process.env.FORCE_COLOR = "1";
  const lines = drawList("Coding agents on this computer", { at: 0, rows: [
    { kind: "box", label: "Claude Code", detail: "0 sessions", on: true },
    { kind: "box", label: "Pi", detail: "not found", on: false, disabled: true },
  ] }, "enter continue");
  assert.match(lines[2]!, /\x1b\[2m/, "the row not found is dimmed");
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(plain[2]!.indexOf("not found"), plain[1]!.indexOf("0 sessions"));
});

test("choosing again starts from the file; agents a file from before agents doesn't mention start as found", () => {
  const all = found({ claude: true, codex: true, pi: true });
  const old = startingChoice({ ...base, claude: true, t3: false, actions: ["follow_up"] }, all);
  assert.deepEqual(old.on, { t3: false, claude: true, codex: true, opencode: false, pi: true, gemini: false, copilot: false, cursor: false });
  const chosen = startingChoice(applyChoice(base, { ...defaultChoice(all), on: { t3: false, claude: true, codex: false, opencode: false, pi: false, gemini: false, copilot: false, cursor: false } }), all);
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
    XDG_DATA_HOME: join(dir, "data"), T3CODE_HOME: join(dir, "t3"), T3_CLI: "t3", GEMINI_CLI_HOME: join(dir, "gemini"), COPILOT_HOME: join(dir, "copilot"), CURSOR_CONFIG_DIR: join(dir, "cursor"),
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
  // Cursor's CLI agent: by its command (its version is a date), or its chats folder.
  command("cursor-agent", "2026.11.19-f005e9d");
  assert.deepEqual((await detect(env)).find((f) => f.agent === "cursor")!.version, "2026.11.19-f005e9d");
  // Asked about some agents only (the connector, about those it uses), the others' commands aren't run.
  assert.deepEqual((await detect(env, 4000, false, (a) => a === "cursor")).filter((f) => f.version).map((f) => f.agent), ["cursor"]);
});

test("a command still running when detection stops waiting is found, version unknown; stopped, except by the connector, which leaves it to finish", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  t.after(() => removeDir(dir));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), PI_CODING_AGENT_DIR: join(dir, "pi"),
    XDG_DATA_HOME: join(dir, "data"), T3CODE_HOME: join(dir, "t3"), T3_CLI: "t3", GEMINI_CLI_HOME: join(dir, "gemini"), COPILOT_HOME: join(dir, "copilot"),
  };
  // npm's `t3` on its first run, which downloads T3's runtime before it answers; T3 has never run here.
  const installedMark = join(dir, "installed");
  writeFileSync(join(bin, "t3.mjs"), `import { writeFileSync } from "node:fs";\nsetTimeout(() => { writeFileSync(${JSON.stringify(installedMark)}, ""); console.log("t3 v0.1.11"); }, ${1500 * SLOW});\n`);
  if (WINDOWS) writeFileSync(join(bin, "t3.cmd"), `@ECHO off\r\nnode "%~dp0\\t3.mjs" %*\r\n`);
  else writeFileSync(join(bin, "t3"), `#!/bin/sh\nexec "${NODE}" "${join(bin, "t3.mjs")}" "$@"\n`, { mode: 0o755 });
  const finished = async () => {
    for (let i = 0; i < 60 * SLOW && !existsSync(installedMark); i++) await new Promise((r) => setTimeout(r, 50));
    return existsSync(installedMark);
  };

  // A short command (setup, status) stops it, so a hung one isn't left behind.
  let t3 = (await detect(env, 200)).find((f) => f.agent === "t3")!;
  assert.deepEqual([t3.installed, t3.version], [true, null]);
  assert.equal(await finished(), false, "stopped");

  t3 = (await detect(env, 200, true)).find((f) => f.agent === "t3")!;
  assert.deepEqual([t3.installed, t3.version], [true, null]);
  assert.equal(existsSync(installedMark), false, "it was still going");
  assert.ok(await finished(), "it finished rather than being stopped part-way");
});

test("a short command that stops a slow --version isn't kept running by what that started", { skip: WINDOWS && "a POSIX script's child stands for it" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  t.after(() => removeDir(dir));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A launcher that leaves its own child holding the output (as cmd.exe running T3's desktop app does on Windows).
  writeFileSync(join(bin, "t3"), `#!/bin/sh\n"${NODE}" -e "setTimeout(() => {}, 8000)"\necho t3 v0.1.11\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), PI_CODING_AGENT_DIR: join(dir, "pi"), XDG_DATA_HOME: join(dir, "data"), T3CODE_HOME: join(dir, "t3"), T3_CLI: "t3", GEMINI_CLI_HOME: join(dir, "gemini"), COPILOT_HOME: join(dir, "copilot") };
  const agents = new URL("../src/agents.ts", import.meta.url).href;
  const started = Date.now();
  const r = spawnSync(NODE, ["--input-type=module", "-e", `const { detect } = await import(${JSON.stringify(agents)}); const f = (await detect(process.env, 200)).find((a) => a.agent === "t3"); console.log(JSON.stringify([f.installed, f.version]));`], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.stdout.trim(), "[true,null]", r.stderr);
  assert.ok(Date.now() - started < 6000, `exited ${Date.now() - started} ms after starting, not when the script's sleep ended`);
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

test("sends and starts for later: send until chosen, written only when chosen, and --later chooses without a terminal", () => {
  const all = found({ claude: true });
  assert.equal(defaultChoice(all).rules, "send", "starting threads later is turned on by hand, never offered on");
  assert.equal(policyFields(defaultChoice(all)).rules, undefined, "a file stays as it was until its owner chooses");
  assert.equal(parsePolicy(JSON.stringify({ ...base })).rules, "send", "every install, new or existing");
  const start = applyFlags(defaultChoice(all), flags({ later: "start" }), all);
  const written = applyChoice({ ...base, rules: "off" }, start);
  assert.equal(written.rules, "start");
  assert.equal(choiceOf(written).rules, "start");
  assert.equal(parsePolicy(JSON.stringify(written)).rules, "start");
  assert.equal(applyChoice(written, defaultChoice(all)).rules, undefined, "back to send: the field goes");
  assert.throws(() => applyFlags(defaultChoice(all), flags({ later: "yes" }), all), /--later takes off, send, start/);
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, rules: "always" })), /rules must be one of off, send, start/);
  assert.equal(summary(start, all).at(-1), "What you set up for later in a call, it sends or starts at its time, from this computer.");
  assert.equal(summary(defaultChoice(all), all).at(-1), "What you set up for later in a call, it sends at its time, from this computer.");
  assert.ok(!summary({ ...defaultChoice(all), rules: "off" }, all).some((l) => l.includes("later")));
});

test("linked documents: off until chosen, written only when chosen, and --documents chooses without a terminal", () => {
  const all = found({ claude: true });
  assert.equal(defaultChoice(all).documents, "off", "linked documents are opt-in, off by default");
  assert.equal(policyFields(defaultChoice(all)).documents, undefined, "a file stays without documents until opted in");
  assert.equal(parsePolicy(JSON.stringify({ ...base })).documents, "off");
  const docsAll = applyFlags(defaultChoice(all), flags({ documents: "all" }), all);
  const written = applyChoice({ ...base }, docsAll);
  assert.equal(written.documents, "all");
  assert.equal(choiceOf(written).documents, "all");
  assert.equal(parsePolicy(JSON.stringify(written)).documents, "all");
  assert.equal(applyChoice(written, defaultChoice(all)).documents, undefined, "back to off: the field goes");
  assert.throws(() => applyFlags(defaultChoice(all), flags({ documents: "yes" }), all), /--documents takes off, project, all/);
  assert.equal(summary(docsAll, all).at(-1), "Linked documents: project and plan folders.");
  assert.ok(!summary(defaultChoice(all), all).some((l) => l.includes("Linked documents")));
});
