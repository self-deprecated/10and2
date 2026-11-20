import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVar, execFileCommand, resolveCommand, shimTarget, which } from "../src/command.ts";

// Windows' rules, on whatever system runs the tests: real files, found through a PATH split on ";".
const dir = () => mkdtempSync(join(tmpdir(), "10and2-command-"));
const NPM_SHIM = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`;

test("a command is found through PATH and PATHEXT, whatever case Path has", () => {
  const a = dir(), b = dir();
  writeFileSync(join(b, "codex.cmd"), "");
  writeFileSync(join(b, "claude.exe"), "");
  const env = { Path: `${a};"${b}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(envVar(env, "PATH"), env.Path);
  assert.equal(which("codex", env, "win32"), join(b, "codex.cmd"));
  assert.equal(which("claude", env, "win32"), join(b, "claude.exe"));
  assert.equal(which("claude.exe", env, "win32"), join(b, "claude.exe"));
  assert.equal(which("pi", env, "win32"), null);
  // Elsewhere, only the name itself.
  assert.equal(which("codex", { PATH: b }, "linux"), null);
});

test("an npm command script runs the Node script it names, with the words as they are", () => {
  const bin = dir();
  const js = join(bin, "node_modules", "@openai", "codex", "bin");
  mkdirSync(js, { recursive: true });
  writeFileSync(join(js, "codex.js"), "");
  writeFileSync(join(bin, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  writeFileSync(join(bin, "node.exe"), "");
  const env = { PATH: bin };
  const words = 'fix the "login" bug & then run %PATH% ^tests | tee';
  const r = resolveCommand("codex", ["--", words], env, "win32");
  assert.deepEqual(r, { file: join(bin, "node.exe"), args: [join(js, "codex.js"), "--", words] });
  assert.equal(r.verbatim, undefined);
});

test("a command script that starts an .exe runs the .exe", () => {
  const bin = dir();
  mkdirSync(join(bin, "node_modules", "opencode-ai", "bin"), { recursive: true });
  writeFileSync(join(bin, "node_modules", "opencode-ai", "bin", "opencode.exe"), "");
  writeFileSync(join(bin, "opencode.cmd"), `@ECHO off\r\n"%~dp0\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n`);
  assert.deepEqual(shimTarget(join(bin, "opencode.cmd"), {}, "win32"), { file: join(bin, "node_modules", "opencode-ai", "bin", "opencode.exe"), args: [] });
  assert.deepEqual(resolveCommand("opencode", ["serve"], { PATH: bin }, "win32").file, join(bin, "node_modules", "opencode-ai", "bin", "opencode.exe"));
});

test("Yarn v1's global command, a script that runs the package's own script, runs the Node script that one names", () => {
  // `yarn global add`: Yarn\bin\claude.cmd runs Data\global\node_modules\.bin\claude.cmd, both as Yarn 1.22's cmd-shim
  // writes them (no node.exe of its own beside either, so the Node on PATH).
  const local = dir(), nodeDir = dir();
  const yarnBin = join(local, "Yarn", "bin"), dotBin = join(local, "Yarn", "Data", "global", "node_modules", ".bin");
  const cli = join(local, "Yarn", "Data", "global", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  mkdirSync(yarnBin, { recursive: true }); mkdirSync(join(cli, ".."), { recursive: true }); mkdirSync(dotBin, { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env node\n");
  writeFileSync(join(nodeDir, "node.exe"), "");
  writeFileSync(join(yarnBin, "claude.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd"   %*\r\n`);
  writeFileSync(join(dotBin, "claude.cmd"), `@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r
) ELSE (\r
  @SETLOCAL\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r
)`);
  const words = 'fix the "login" bug & then run %PATH%';
  assert.deepEqual(resolveCommand("claude", ["--bg", "--", words], { PATH: `${yarnBin};${nodeDir}` }, "win32"),
    { file: join(nodeDir, "node.exe"), args: [cli, "--bg", "--", words] });
  // Scripts that run each other are followed only so far.
  const loop = dir();
  writeFileSync(join(loop, "a.cmd"), `@"%~dp0\\b.cmd" %*\r\n`); writeFileSync(join(loop, "b.cmd"), `@"%~dp0\\a.cmd" %*\r\n`);
  assert.equal(shimTarget(join(loop, "a.cmd"), {}, "win32"), null);
});

test("any other command script goes through cmd.exe only with plain words, and is refused otherwise", () => {
  const bin = dir();
  writeFileSync(join(bin, "tool.bat"), "@echo off\r\necho %1\r\n");
  const env = { PATH: bin, ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(resolveCommand("tool", ["--version"], env, "win32"),
    { file: "C:\\Windows\\system32\\cmd.exe", args: ["/d", "/s", "/c", `""${join(bin, "tool.bat")}" --version"`], verbatim: true });
  assert.throws(() => resolveCommand("tool", ["a & calc"], env, "win32"), /can't be given these words safely/);
  assert.throws(() => resolveCommand("tool", ["%PATH%"], env, "win32"), /can't be given these words safely/);
});

test("an .exe is run as it is; a missing one isn't left for Windows to look for in the current folder", () => {
  const bin = dir();
  writeFileSync(join(bin, "git.exe"), "");
  assert.deepEqual(resolveCommand("git", ["status"], { PATH: bin }, "win32"), { file: join(bin, "git.exe"), args: ["status"] });
  assert.throws(() => resolveCommand("nothing", ["x"], { PATH: bin }, "win32"), (e: any) => e.code === "ENOENT");
  // Elsewhere spawn finds it, and reports a missing one itself.
  assert.deepEqual(resolveCommand("codex", ["a & b"], { PATH: bin }, "linux"), { file: "codex", args: ["a & b"] });
});

test("only programs and command scripts are run from PATH, not the rest of PATHEXT", () => {
  const a = dir(), b = dir();
  writeFileSync(join(a, "codex.js"), "");
  writeFileSync(join(a, "codex.ps1"), "");
  writeFileSync(join(b, "codex.exe"), "");
  assert.equal(which("codex", { PATH: `${a};${b}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1" }, "win32"), join(b, "codex.exe"));
});

test("Pi's own launcher runs with the Node Pi's installer chose for it, when there is one", () => {
  const bin = dir(), local = dir();
  writeFileSync(join(bin, "pi-launcher.js"), "");
  writeFileSync(join(bin, "pi.cmd"), `@echo off\r
SET "node=node"\r
IF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"\r
"%node%" "%~dp0pi-launcher.js" %*\r
`);
  const elsewhere = dir();
  writeFileSync(join(elsewhere, "node.exe"), "");
  const env = { PATH: `${bin};${elsewhere}`, LOCALAPPDATA: local };
  // No Node of Pi's own: the one on PATH.
  assert.deepEqual(resolveCommand("pi", ["--mode", "rpc"], env, "win32"), { file: join(elsewhere, "node.exe"), args: [join(bin, "pi-launcher.js"), "--mode", "rpc"] });
  mkdirSync(join(local, "pi-node", "current"), { recursive: true });
  writeFileSync(join(local, "pi-node", "current", "node.exe"), "");
  assert.equal(resolveCommand("pi", [], env, "win32").file, join(local, "pi-node", "current", "node.exe"));
});

test("T3 Code's desktop command, which runs the app as Node, goes through cmd.exe with plain words only", () => {
  const bin = dir();
  writeFileSync(join(bin, "t3.cmd"), `@echo off\r
set "T3CODE_HOME=C:\\Users\\me\\.t3"\r
set ELECTRON_RUN_AS_NODE=1\r
"C:\\Program Files\\T3 Code\\T3 Code.exe" "C:\\Program Files\\T3 Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs" %*\r
`);
  const env = { PATH: bin, ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const r = resolveCommand("t3", ["auth", "session", "issue", "--json"], env, "win32");
  assert.equal(r.file, env.ComSpec);
  assert.equal(r.verbatim, true);
  assert.throws(() => resolveCommand("t3", ["two words"], env, "win32"), /can't be given these words safely/);
});

test("execFileCommand gives every failure to its callback, starting it included", async () => {
  const err = await new Promise<any>((resolve) => execFileCommand("10and2-no-such-command", [], { env: { PATH: dir() } }, (e) => resolve(e)));
  assert.equal(err.code, "ENOENT");
});
