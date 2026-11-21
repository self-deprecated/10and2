import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVar, execFileCommand, resolveCommand, shimTarget, which } from "../src/command.ts";

// Windows' rules, on whatever system runs the tests: real files, found through a PATH split on ";".
const made: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "10and2-command-")); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
/** What a program starts with; Windows refuses an .exe that doesn't. */
const EXE = "MZ";
/** npm's script for a package's Node script, with the Node flags from its `#!` line. */
const NPM_SHIM = (target: string, flags = "") => `@ECHO off\r
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
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${flags} "%dp0%\\${target}" %*\r
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
  writeFileSync(join(bin, "node.exe"), EXE);
  const env = { PATH: bin };
  const words = 'fix the "login" bug & then run %PATH% ^tests | tee';
  const r = resolveCommand("codex", ["--", words], env, "win32");
  assert.deepEqual(r, { file: join(bin, "node.exe"), args: [join(js, "codex.js"), "--", words] });
  assert.equal(r.verbatim, undefined);
});

test("a command script that starts an .exe runs the .exe", () => {
  const bin = dir();
  mkdirSync(join(bin, "node_modules", "opencode-ai", "bin"), { recursive: true });
  writeFileSync(join(bin, "node_modules", "opencode-ai", "bin", "opencode.exe"), EXE);
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
  writeFileSync(join(nodeDir, "node.exe"), EXE);
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

test("a script's own Node flags and plain words are kept; one that does more goes through cmd.exe, with plain words only", () => {
  const bin = dir();
  const js = join(bin, "node_modules", "echo", "bin", "echo.js"), node = join(bin, "node.exe");
  mkdirSync(join(js, ".."), { recursive: true });
  writeFileSync(js, ""); writeFileSync(node, EXE);
  // npm's, for a script that starts `#!/usr/bin/env node --no-deprecation`.
  writeFileSync(join(bin, "npm.cmd"), NPM_SHIM("node_modules\\echo\\bin\\echo.js", "--no-deprecation"));
  // pnpm's (@zkochan/cmd-shim 9), with the words it adds after the script.
  writeFileSync(join(bin, "pnpm.cmd"), `@SETLOCAL\r
@IF NOT DEFINED NODE_PATH (\r
  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules"\r
) ELSE (\r
  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules;%NODE_PATH%"\r
)\r
@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe" --no-deprecation "%~dp0\\node_modules\\echo\\bin\\echo.js" --from-pnpm %*\r
) ELSE (\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node --no-deprecation "%~dp0\\node_modules\\echo\\bin\\echo.js" --from-pnpm %*\r
)\r
`);
  // A script of the user's own that adds words, around another that's npm's.
  writeFileSync(join(bin, "mine.cmd"), `@"%~dp0npm.cmd" --model opus %*\r\n`);
  // One with comments, as a wrapper (or a package manager's shim) may have.
  writeFileSync(join(bin, "noted.cmd"), `@ECHO off\r\nrem Runs echo.\r\n:: with its own flag\r\n@REM\r\n"%~dp0npm.cmd" %*\r\n`);
  const env = { PATH: bin, ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const words = 'fix the "login" bug';
  assert.deepEqual(resolveCommand("npm", [words], env, "win32"), { file: node, args: ["--no-deprecation", js, words] });
  assert.deepEqual(resolveCommand("pnpm", [words], env, "win32"), { file: node, args: ["--no-deprecation", js, "--from-pnpm", words] });
  assert.deepEqual(resolveCommand("mine", [words], env, "win32"), { file: node, args: ["--no-deprecation", js, "--model", "opus", words] });
  assert.deepEqual(resolveCommand("noted", [words], env, "win32"), { file: node, args: ["--no-deprecation", js, words] });

  // A setting for the program (an app run as Node, which the Node on PATH isn't), an app named as the one running the
  // script, another command, or words cmd.exe reads can't be passed on without cmd.exe.
  mkdirSync(join(bin, "resources", "app"), { recursive: true });
  writeFileSync(join(bin, "App.exe"), EXE); writeFileSync(join(bin, "resources", "app", "cli.js"), "");
  writeFileSync(join(bin, "setting.cmd"), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0App.exe" "%~dp0resources\\app\\cli.js" %*\r\n`);
  // (Named apart from App.exe: Windows' names ignore case, and it would find App.exe first.)
  writeFileSync(join(bin, "appcli.cmd"), `@echo off\r\n"%~dp0App.exe" "%~dp0resources\\app\\cli.js" %*\r\n`);
  writeFileSync(join(bin, "other.cmd"), `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0node_modules\\echo\\bin\\echo.js" %*\r\n`);
  writeFileSync(join(bin, "syntax.cmd"), `@"%~dp0node.exe" "%~dp0node_modules\\echo\\bin\\echo.js" --home "%USERPROFILE%" %*\r\n`);
  for (const command of ["setting", "appcli", "other", "syntax"]) {
    assert.equal(resolveCommand(command, ["--version"], env, "win32").file, env.ComSpec, command);
    assert.throws(() => resolveCommand(command, [words], env, "win32"), /can't be given these words safely/, command);
  }
});

test("an npm command whose program is gone is said to be not fully installed, whatever the words", () => {
  const bin = dir();
  writeFileSync(join(bin, "node.exe"), EXE);
  writeFileSync(join(bin, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  writeFileSync(join(bin, "opencode.cmd"), `@ECHO off\r\n"%~dp0\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n`);
  for (const command of ["codex", "opencode"]) for (const words of [["--version"], ["two words"]]) {
    assert.throws(() => resolveCommand(command, words, { PATH: bin }, "win32"),
      (e: any) => e.code === "ENOENT" && e.message === `${command} isn't fully installed; install it again.`, `${command} ${words}`);
  }
});

test("an .exe npm left as a placeholder (its install step skipped) is said to be not fully installed, before it's started", () => {
  // npm leaves the short text the package ships in its place, which Windows refuses with an error Node can't name.
  const bin = dir();
  const exe = join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, `echo "Error: claude's install step didn't run." >&2\nexit 1\n`);
  writeFileSync(join(bin, "claude.cmd"), `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`);
  writeFileSync(join(bin, "pi.exe"), "");
  for (const command of ["claude", "pi"]) {
    assert.throws(() => resolveCommand(command, ["--version"], { PATH: bin }, "win32"),
      (e: any) => e.code === "EFTYPE" && e.message === `${command} isn't fully installed (its install step didn't run); install it again.`, command);
  }
});

test("without ComSpec, cmd.exe is still started by its path, never looked for in the current folder", () => {
  const bin = dir();
  writeFileSync(join(bin, "tool.bat"), "@echo off\r\necho %1\r\n");
  assert.equal(resolveCommand("tool", ["x"], { PATH: bin, SystemRoot: "D:\\Windows" }, "win32").file, "D:\\Windows\\System32\\cmd.exe");
  assert.equal(resolveCommand("tool", ["x"], { PATH: bin }, "win32").file, "C:\\Windows\\System32\\cmd.exe");
});

test("an .exe is run as it is; a missing one isn't left for Windows to look for in the current folder", () => {
  const bin = dir();
  writeFileSync(join(bin, "git.exe"), EXE);
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
  // As pi.dev's install.ps1 writes it, with what it does once Pi has ended.
  writeFileSync(join(bin, "pi.cmd"), `@ECHO off\r
SETLOCAL\r
SET "node=node"\r
IF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"\r
"%node%" "%~dp0pi-launcher.js" %*\r
SET "pi_exit_code=%ERRORLEVEL%"\r
IF "%pi_exit_code%"=="9009" (\r
  IF "%node%"=="node" (\r
    "%SystemRoot%\\System32\\where.exe" /Q node\r
    IF ERRORLEVEL 1 GOTO node_missing\r
  ) ELSE IF NOT EXIST "%node%" GOTO node_missing\r
)\r
EXIT /B %pi_exit_code%\r
:node_missing\r
ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2\r
EXIT /B %pi_exit_code%\r
`);
  const elsewhere = dir();
  writeFileSync(join(elsewhere, "node.exe"), EXE);
  const env = { PATH: `${bin};${elsewhere}`, LOCALAPPDATA: local };
  // No Node of Pi's own: the one on PATH.
  assert.deepEqual(resolveCommand("pi", ["--mode", "rpc"], env, "win32"), { file: join(elsewhere, "node.exe"), args: [join(bin, "pi-launcher.js"), "--mode", "rpc"] });
  mkdirSync(join(local, "pi-node", "current"), { recursive: true });
  writeFileSync(join(local, "pi-node", "current", "node.exe"), EXE);
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
