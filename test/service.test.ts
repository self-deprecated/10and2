// Starting at login on Windows: the startup entry and the Service's reg.exe calls (on every system, with a fake
// runner), and the supervisor it runs (supervisor.ts), for real, with a fake connector (fixtures/supervised.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Runner } from "../src/credential.ts";
import { Ledger, ledgerHeld } from "../src/ledger.ts";
import { BRAIN, CONNECTOR, connectorRunning, RUN_KEY, runEntry, Service, STARTUP_APPROVED } from "../src/service.ts";
import { ask, backoff, controlPipe, HIDDEN, loginFile, mergePath, readLogin, restartsAfter, rotate, saveLogin, supervise, withPath } from "../src/supervisor.ts";
import { randomHex, replaceFile } from "../src/util.ts";
import { assertPrivate, ipcPath, NODE, nodeCommand, removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";

const SUPERVISED = fileURLToPath(new URL("./fixtures/supervised.ts", import.meta.url));
const SUPERVISOR = fileURLToPath(new URL("../src/supervisor.ts", import.meta.url));
// As src/main.ts's own shebang starts it: on Node 22, node:sqlite's experimental notice would otherwise be the output.
const MAIN = ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/main.ts", import.meta.url))];

function temp(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "10and2-service-"));
  t.after(() => removeDir(dir));
  return dir;
}
/**
 * A folder and a control pipe, with its secret, for a supervisor this test runs in its own process: stopped, if it
 * still runs (a failed test), before the folder goes, which would take its socket file with it and leave it running.
 * `pipes` are the pipe and each new one the supervisor took (renew); `ask` asks the newest.
 */
function place(t: { after: (f: () => Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "10and2-service-"));
  const secret = randomHex(), pipes = [ipcPath(dir, "control.sock")];
  const renew = () => { pipes.push(ipcPath(dir, `control-${pipes.length}.sock`)); return pipes.at(-1)!; };
  t.after(async () => { for (const pipe of pipes) await ask(pipe, "stop", secret, 10_000 * SLOW); removeDir(dir); });
  return { dir, pipes, control: { pipe: pipes[0]!, secret, renew }, ask: (line: string, ms?: number) => ask(pipes.at(-1)!, line, secret, ms) };
}
async function until(what: string, done: () => boolean | Promise<boolean>, ms = 5000 * SLOW) {
  for (const started = Date.now(); !await done();) {
    if (Date.now() - started > ms) throw new Error(`never ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : "";
const starts = (notes: string) => read(notes).split("\n").filter((l) => l.startsWith("start "));
const status = async (p: ReturnType<typeof place>) => JSON.parse(await p.ask("status") ?? "null") as { pid: number; child: number | null; since: string | null } | null;
// The restart policy's times, short: the grace a stop gets is still long enough for a child to stop in.
const FAST = { first: 30, most: 120, settled: 60_000, grace: 2000 * SLOW, retry: 20 };

test("a crash is started again after 5 s, doubling to 5 minutes and back to 5 s after 10 minutes up; 0 and 78 aren't", () => {
  for (const code of [1, 2, null, 143]) assert.equal(restartsAfter(code), true, `after ${code}`);
  for (const code of [0, 78]) assert.equal(restartsAfter(code), false, `after ${code}`);
  let wait: number | null = null;
  const waits = Array.from({ length: 8 }, () => (wait = backoff(wait, 1000)));
  assert.deepEqual(waits, [5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(backoff(300_000, 600_000), 5000);
});

test("the PATH setup saw comes first, each folder once (ignoring case on Windows), under the name PATH already has", () => {
  assert.equal(mergePath("/opt/t3/bin:/usr/bin", "/usr/bin:/bin:", "linux"), "/opt/t3/bin:/usr/bin:/bin");
  assert.equal(mergePath("/Opt/bin", "/opt/bin", "linux"), "/Opt/bin:/opt/bin");
  assert.equal(mergePath("C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows", "c:\\windows;C:\\Tools", "win32"), "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows;C:\\Tools");
  assert.equal(mergePath("", "C:\\Windows", "win32"), "C:\\Windows");
  assert.deepEqual(withPath({ Path: "a", X: "1" }, "b"), { Path: "b", X: "1" });
  assert.deepEqual(withPath({ X: "1" }, "b"), { X: "1", PATH: "b" });
});

test("a log over its size starts afresh at the next start, keeping the one before", (t) => {
  const dir = temp(t);
  const log = join(dir, "10and2.log");
  rotate(log, 10); // none yet
  writeFileSync(log, "short\n");
  rotate(log, 10);
  assert.equal(read(log), "short\n");
  writeFileSync(log, "x".repeat(11));
  writeFileSync(`${log}.1`, "older");
  rotate(log, 10);
  assert.equal(existsSync(log), false);
  assert.equal(read(`${log}.1`), "x".repeat(11));
});

test("the token naming the control pipe and the secret it proves itself with are made once, private, and kept when setup saves a new PATH", (t) => {
  const dir = temp(t);
  const file = join(dir, "state", "login-connector.json");
  assert.deepEqual(readLogin(file), {});
  const first = saveLogin(file, "/usr/bin");
  assert.match(first.token, /^[0-9a-f]{32}$/);
  assert.match(first.secret, /^[0-9a-f]{32}$/);
  assert.notEqual(first.secret, first.token);
  assertPrivate(file);
  assert.deepEqual(saveLogin(file), first, "the supervisor keeps what setup saved");
  assert.deepEqual(saveLogin(file, "/opt/bin"), { token: first.token, secret: first.secret, path: "/opt/bin" });
  const renewed = saveLogin(file, undefined, true);
  assert.notEqual(renewed.token, first.token, "a fresh token when its pipe's name is taken");
  assert.deepEqual(readLogin(file), { token: renewed.token, secret: first.secret, path: "/opt/bin" });
  assert.equal(controlPipe(CONNECTOR, first.token, {}, "win32"), `\\\\.\\pipe\\10and2-connector-${first.token}`);
  assert.equal(controlPipe(BRAIN, first.token, {}, "win32"), `\\\\.\\pipe\\10and2-brain-${first.token}`);
});

test("the supervisor starts a crashed connector again, with the PATH it's given and its output in the log, and stops after 78 or 0", async (t) => {
  const p = place(t), { dir } = p;
  const notes = join(dir, "notes"), code = join(dir, "code"), log = join(dir, "10and2.log");
  // Replaced, not rewritten: a start between a rewrite's emptying and its writing would read no code and run for good.
  const exitWith = (c: string) => { writeFileSync(`${code}.tmp`, c); replaceFile(`${code}.tmp`, code); };
  exitWith("1");
  const path = mergePath(join(dir, "setup-bin"), process.env.PATH ?? "");
  const run = supervise({ name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes, `code=${code}`], env: withPath(process.env, path), log, timing: FAST });
  await until("restarted twice", () => starts(notes).length >= 3);
  exitWith("78");
  await run;
  const after = starts(notes).length;
  assert.ok(starts(notes).every((l) => l.endsWith(` ${path}`)), "each start had the PATH setup saw first");
  assert.match(read(log), /supervised: started/);
  assert.match(read(log), /login-service: the connector exited 1; starting it again in 0\.03 s/);
  assert.match(read(log), /login-service: the connector exited 1; starting it again in 0\.06 s/);
  assert.match(read(log), /login-service: the connector exited 78; not starting it again/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(starts(notes).length, after, "nothing started after 78");

  writeFileSync(code, "0");
  writeFileSync(notes, "");
  await supervise({ name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes, `code=${code}`], env: process.env, log, timing: FAST });
  assert.equal(starts(notes).length, 1);
  assert.match(read(log), /the connector exited 0; not starting it again/);
});

test("status, restart and stop on the control pipe, one line in and one out; a stop lets the connector shut down", async (t) => {
  const p = place(t), { dir } = p;
  const notes = join(dir, "notes");
  const run = supervise({ name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes], env: process.env, log: join(dir, "10and2.log"), timing: FAST });
  await until("started", () => starts(notes).length === 1);
  const first = (await status(p))!;
  assert.match(starts(notes)[0]!, new RegExp(`^start ${first.child} `));
  assert.equal(first.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(first.since!)));
  assert.equal(await p.ask("nonsense"), "unknown");
  assert.equal(await ask(p.control.pipe, "status", randomHex()), null, "asked without its secret, its answer proves nothing");

  assert.equal(await p.ask("restart", 10_000 * SLOW), "ok");
  assert.match(read(notes), new RegExp(`^stopped ${first.child}$`, "m"), "asked to stop over IPC, it shut down as on SIGTERM");
  await until("started again", () => starts(notes).length === 2);
  const second = (await status(p))!;
  assert.equal(typeof second.child, "number");
  assert.notEqual(second.child, first.child);

  assert.equal(await p.ask("stop", 10_000 * SLOW), "ok");
  await run;
  assert.match(read(notes), new RegExp(`^stopped ${second.child}$`, "m"));
  assert.equal(await p.ask("status"), null, "the supervisor has gone");
});

test("a connector that doesn't stop when asked is ended after the grace period", async (t) => {
  const p = place(t), { dir } = p;
  const notes = join(dir, "notes"), log = join(dir, "10and2.log");
  const run = supervise({ name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes, "stubborn"], env: process.env, log, timing: { ...FAST, grace: 200 } });
  await until("started", () => starts(notes).length === 1);
  assert.equal(await p.ask("stop", 10_000 * SLOW), "ok");
  await run;
  assert.match(read(log), /the connector didn't stop within 0\.2 s; ending it/);
});

test("a second supervisor for the same job leaves it to the first", async (t) => {
  const p = place(t), { dir } = p;
  const notes = join(dir, "notes");
  const options = { name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes], env: process.env, log: join(dir, "10and2.log"), timing: FAST };
  const first = supervise(options);
  await until("started", () => starts(notes).length === 1);
  await supervise(options);
  assert.equal(starts(notes).length, 1, "the second started nothing");
  assert.equal(p.pipes.length, 1, "nor took a new name");
  assert.equal(typeof (await status(p))?.child, "number", "the first still runs it");
  assert.equal(await p.ask("stop", 10_000 * SLOW), "ok");
  await first;
});

test("something else on the supervisor's pipe name (another account's, on Windows) counts as no supervisor, and the supervisor takes a new name", async (t) => {
  const p = place(t), { dir } = p;
  const notes = join(dir, "notes"), log = join(dir, "10and2.log");
  // Answers as a supervisor with a child would, but can't prove it.
  const squatter = createServer((s) => { s.on("error", () => {}); s.once("data", () => s.end(`${"0".repeat(64)} ${JSON.stringify({ pid: 1, child: 2, since: null })}\n`)); });
  await new Promise<void>((resolve, reject) => { squatter.once("error", reject); squatter.listen(p.control.pipe, resolve); });
  t.after(() => squatter.close());
  assert.equal(await p.ask("status"), null, "an answer without the proof counts as no supervisor");
  // Windows' way: a pipe someone else holds can't be removed, as a socket file can.
  const run = supervise({ name: "connector", ...p.control, command: [...nodeCommand(SUPERVISED), notes], env: process.env, log, timing: FAST, platform: "win32" });
  await until("started", () => starts(notes).length === 1);
  assert.equal(p.pipes.length, 2);
  assert.match(read(log), /something else has its control pipe's name; listening on a new one/);
  assert.equal(typeof (await status(p))?.child, "number", "asked at its new name, it proves itself");
  assert.equal(await p.ask("stop", 10_000 * SLOW), "ok");
  await run;
});

test("on Windows, closing the console (SIGHUP) stops the connector as SIGTERM does", { skip: WINDOWS && "Windows can't send SIGHUP" }, async (t) => {
  const dir = temp(t);
  const notes = join(dir, "notes");
  const child = spawn(NODE, [SUPERVISED, notes, "", "win32"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  await until("started", () => starts(notes).length === 1);
  child.kill("SIGHUP");
  assert.equal(await exited, 0);
  assert.match(read(notes), /^stopped /m);
});

test("the IPC channel doesn't keep a connector running once its work is done", async () => {
  const script = `const { stopLikeSigterm } = await import(${JSON.stringify(pathToFileURL(SUPERVISOR).href)}); stopLikeSigterm();`;
  const child = spawn(NODE, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("still running")); }, 5000 * SLOW);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
});

test("10and2 login-service supervises the connector, hidden, and stops when it can't run (78); without the marker it starts itself hidden", async (t) => {
  const dir = temp(t);
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_TOKEN: "" };
  delete env[HIDDEN];
  const log = join(dir, "state", "10and2", "10and2.log");
  saveLogin(loginFile(CONNECTOR, env), join(dir, "setup-bin"));
  // Not set up: the connector exits 78, which isn't restarted, so the supervisor exits too.
  const hidden = spawnSync(NODE, [...MAIN, "login-service", "connector"], { env: { ...env, [HIDDEN]: "1" }, encoding: "utf8", timeout: 20_000 * SLOW });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout + hidden.stderr, "", "silent");
  assert.match(read(log), /connector: .*10and2 setup/);
  assert.match(read(log), /login-service: the connector exited 78; not starting it again/);

  writeFileSync(log, "");
  const shown = spawnSync(NODE, [...MAIN, "login-service", "connector"], { env, encoding: "utf8", timeout: 20_000 * SLOW });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout + shown.stderr, "", "silent");
  // The hidden copy it started runs the connector, which exits as above.
  await until("supervised by the hidden copy", () => /not starting it again/.test(read(log)), 20_000 * SLOW);
  const saved = readLogin(loginFile(CONNECTOR, env));
  assert.match(saved.secret ?? "", /^[0-9a-f]{32}$/, "the supervisor has a secret to prove itself with");
  const pipe = controlPipe(CONNECTOR, saved.token!, env);
  await until("the hidden copy exited", async () => await ask(pipe, "status", saved.secret!) === null);

  assert.equal(spawnSync(NODE, [...MAIN, "login-service", "nonsense"], { env, encoding: "utf8" }).status, 64);
});

/** Windows' registry as reg.exe shows it, and a supervisor that answers on its pipe, with everything asked in order. */
function fakeWindows(dir: string) {
  const values = new Map<string, string>();
  const asked: string[] = [];
  const started: { command: string[]; env: NodeJS.ProcessEnv }[] = [];
  const pipes = new Set<string>(), secrets = new Set<string>();
  let running = false;
  // whoami's groups: an ordinary terminal's, unless a test makes it one run as administrator.
  const who = { groups: WHOAMI_MEDIUM as string | null };
  // Startup apps' switch: an entry it has turned off.
  const approved = new Map<string, string>();
  const runner: Runner = async (command, args) => {
    if (command === "C:\\Windows\\System32\\whoami.exe") { assert.deepEqual(args, ["/groups"]); return who.groups; }
    assert.equal(command, "C:\\Windows\\System32\\reg.exe");
    if (args[1] === STARTUP_APPROVED && args[0] === "query") return approved.has(args[3]!) ? `\r\n${STARTUP_APPROVED}\r\n    ${args[3]}    REG_BINARY    ${approved.get(args[3]!)}\r\n` : null;
    if (args[1] === STARTUP_APPROVED) { assert.deepEqual([args[0], args[4]], ["delete", "/f"]); return approved.delete(args[3]!) ? "" : null; }
    assert.equal(args[1], RUN_KEY);
    asked.push(`reg ${args[0]} ${args[3]}`);
    if (args[0] === "add") { values.set(args[3]!, args[7]!); return "The operation completed successfully.\r\n"; }
    if (args[0] === "query") return values.has(args[3]!) ? `\r\n${RUN_KEY}\r\n    ${args[3]}    REG_SZ    ${values.get(args[3]!)}\r\n` : null;
    if (args[0] === "delete") return values.delete(args[3]!) ? "" : null;
    return null;
  };
  const control = async (pipe: string, line: string, secret: string) => {
    pipes.add(pipe);
    secrets.add(secret);
    asked.push(`control ${line}`);
    if (!running) return null;
    if (line === "stop") { running = false; return "ok"; }
    if (line === "restart") return "ok";
    return JSON.stringify({ pid: 10, child: 11, since: new Date().toISOString() });
  };
  const start = (command: string[], env: NodeJS.ProcessEnv) => { asked.push("start"); started.push({ command, env }); running = true; };
  const npm = join(dir, "npm");
  mkdirSync(npm, { recursive: true });
  writeFileSync(join(npm, "10and2.cmd"), "@ECHO off\r\n");
  const env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD", XDG_STATE_HOME: join(dir, "state") };
  const service = (job = CONNECTOR, more: NodeJS.ProcessEnv = {}) => new Service({ runner, control, start, platform: "win32", env: { ...env, ...more }, home: dir, sleep: async () => {}, job });
  return { values, asked, started, pipes, secrets, runner, service, npm, env, who, approved };
}

/** `whoami /groups` as Windows prints it, in an ordinary terminal and in one run as administrator (or as SYSTEM). */
const whoami = (label: string) => [
  "", "GROUP INFORMATION", "-----------------", "",
  "Group Name                             Type             SID          Attributes",
  "====================================== ================ ============ ==================================================",
  "Everyone                               Well-known group S-1-1-0      Mandatory group, Enabled by default, Enabled group",
  "BUILTIN\\Administrators                 Alias            S-1-5-32-544 Group used for deny only",
  `Mandatory Label\\${label}`, "",
].join("\r\n");
const WHOAMI_MEDIUM = whoami("Medium Mandatory Level           Label            S-1-16-8192");
const WHOAMI_HIGH = whoami("High Mandatory Level             Label            S-1-16-12288");
const WHOAMI_SYSTEM = whoami("System Mandatory Level           Label            S-1-16-16384");

test("on Windows, autostart adds a Run entry that runs 10and2 from the PATH through cmd.exe, and starts the supervisor now", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const l = { program: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\10and2\\bin\\10and2.js"], path: [w.npm, "C:\\Windows"].join(";") };
  const service = w.service();
  assert.equal(service.supported, true);
  assert.equal(service.unavailable(l), null);
  const s = await service.install(l);
  assert.deepEqual(w.asked.slice(0, 3), ["control stop", "reg add 10and2", "start"]);
  assert.equal(w.values.get("10and2"), '"C:\\Windows\\System32\\cmd.exe" /d /c 10and2 login-service connector');
  assert.deepEqual(w.started[0]!.command, [...l.program, "login-service", "connector"]);
  assert.equal(w.started[0]!.env[HIDDEN], "1", "started as the supervisor itself, with no window to close");
  assert.deepEqual(s, { installed: true, running: true, where: `${RUN_KEY}\\10and2`, logs: join(dir, "state", "10and2", "10and2.log") });
  const saved = readLogin(loginFile(CONNECTOR, w.env));
  assert.equal(saved.path, l.path, "the PATH setup saw, kept for the supervisor");
  assert.deepEqual([...w.pipes], [`\\\\.\\pipe\\10and2-connector-${saved.token}`]);
  assert.deepEqual([...w.secrets], [saved.secret], "each ask needs the supervisor's proof of the secret beside its token");

  // Again: the supervisor running goes first, so the new one runs this version.
  w.asked.length = 0;
  await service.install(l);
  assert.deepEqual(w.asked.slice(0, 3), ["control stop", "control status", "reg add 10and2"]);
  assert.equal(w.started.length, 2);

  w.asked.length = 0;
  await service.restart();
  assert.deepEqual(w.asked, ["control restart"]);

  // Off: the supervisor stops the connector and goes, then the entry goes.
  w.asked.length = 0;
  await service.uninstall();
  assert.deepEqual(w.asked, ["control stop", "control status", "reg delete 10and2"]);
  assert.deepEqual(await service.state(), { installed: false, running: false, where: `${RUN_KEY}\\10and2`, logs: join(dir, "state", "10and2", "10and2.log") });
  // Nothing to stop and nothing to delete is fine.
  await service.uninstall();
});

test("on Windows, your own brain gets its own Run entry and supervisor", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const l = { program: ["C:\\node.exe", "C:\\10and2.js"], path: w.npm };
  const s = await w.service(BRAIN).install(l);
  assert.equal(s.running, true);
  assert.equal(w.values.get("10and2-brain"), '"C:\\Windows\\System32\\cmd.exe" /d /c 10and2 login-service brain');
  assert.deepEqual(w.started[0]!.command.slice(2), ["login-service", "brain"]);
  assert.equal(s.logs, join(dir, "state", "10and2", "10and2-brain.log"));
  assert.ok([...w.pipes][0]!.startsWith("\\\\.\\pipe\\10and2-brain-"));
});

test("on Windows, starting at login is refused, before anything is written, when 10and2 is on the PATH only for now (npx) or not at all", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const npx = join(dir, "npm-cache", "_npx", "8a1f", "node_modules", ".bin");
  mkdirSync(npx, { recursive: true });
  writeFileSync(join(npx, "10and2.cmd"), "@ECHO off\r\n");
  for (const path of ["C:\\Windows", npx]) {
    const service = w.service();
    const l = { program: ["C:\\node.exe", "C:\\10and2.js"], path };
    assert.match(service.unavailable(l) ?? "", /^To start at login, 10and2 needs to be installed: npm i -g 10and2$/);
    await assert.rejects(service.install(l), /npm i -g 10and2/);
  }
  assert.deepEqual(w.asked, []);
  assert.deepEqual(w.started, []);
  assert.equal(existsSync(loginFile(CONNECTOR, w.env)), false);
  // Installed as well, it's that one, and npx's folder isn't kept for the supervisor.
  const both = { program: ["C:\\node.exe", "C:\\10and2.js"], path: [npx, w.npm, "C:\\Windows"].join(";") };
  assert.equal(w.service().unavailable(both), null);
  await w.service().install(both);
  assert.equal(readLogin(loginFile(CONNECTOR, w.env)).path, [w.npm, "C:\\Windows"].join(";"));
  // On a Mac, launchd runs the script setup ran (Linux: setup.test.ts).
  assert.equal(new Service({ platform: "darwin", env: {} }).unavailable({ program: ["/usr/bin/node", "/x.js"], path: "/nonexistent" }), null);
});

test("on Windows, a TENANDTWO_COMMAND with spaces is one word to cmd.exe", (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const own = join(dir, "Jane Doe", "10and2.cmd");
  mkdirSync(join(dir, "Jane Doe"));
  writeFileSync(own, "@ECHO off\r\n");
  assert.equal(runEntry(CONNECTOR, { SystemRoot: "D:\\Win", TENANDTWO_COMMAND: own }), `"D:\\Win\\System32\\cmd.exe" /d /s /c ""${own}" login-service connector"`);
  assert.equal(w.service(CONNECTOR, { TENANDTWO_COMMAND: own }).unavailable({ program: ["", ""], path: "" }), null);
  assert.equal(runEntry(CONNECTOR, { TENANDTWO_COMMAND: "10and2-dev" }), '"C:\\Windows\\System32\\cmd.exe" /d /c 10and2-dev login-service connector');
});

test("on Windows, autostart from a terminal run as administrator adds the Run entry but starts nothing now, and leaves one running as it is", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const l = { program: ["C:\\node.exe", "C:\\10and2.js"], path: w.npm };
  const logs = join(dir, "state", "10and2", "10and2.log");
  for (const groups of [WHOAMI_HIGH, WHOAMI_SYSTEM]) {
    w.who.groups = groups;
    w.values.clear();
    w.asked.length = 0;
    const s = await w.service().install(l);
    assert.deepEqual(s, { installed: true, running: false, where: `${RUN_KEY}\\10and2`, logs, elevated: true });
    assert.equal(w.values.get("10and2"), '"C:\\Windows\\System32\\cmd.exe" /d /c 10and2 login-service connector');
    assert.deepEqual(w.started, [], "not started as a child of an administrator's terminal");
    assert.ok(!w.asked.includes("control stop"));
  }
  // One already running, started from an ordinary terminal, keeps running: the one at the next sign-in replaces it.
  w.who.groups = WHOAMI_MEDIUM;
  assert.equal((await w.service().install(l)).elevated, undefined);
  assert.equal(w.started.length, 1);
  w.who.groups = WHOAMI_HIGH;
  w.asked.length = 0;
  const s = await w.service().install(l);
  assert.deepEqual([s.running, s.elevated], [true, true]);
  assert.ok(!w.asked.includes("control stop"));
  assert.equal(w.started.length, 1);
  // whoami failing says nothing: started now, as before.
  w.who.groups = null;
  assert.equal((await w.service().install(l)).elevated, undefined);
  assert.equal(w.started.length, 2);
});

test("on Windows, autostart turns its entry back on where Startup apps had turned it off", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const l = { program: ["C:\\node.exe", "C:\\10and2.js"], path: w.npm };
  // Windows skips a Run entry whose StartupApproved value starts with an odd byte (turned off).
  w.approved.set("10and2", "030000000000000000000000");
  w.approved.set("10and2-brain", "030000000000000000000000");
  assert.equal((await w.service().install(l)).running, true);
  assert.deepEqual([...w.approved.keys()], ["10and2-brain"], "only its own entry's");
  // With nothing turned off, there's nothing to delete, which is fine.
  assert.equal((await w.service().install(l)).running, true);
});

test("on Windows, an entry Startup apps turned off doesn't start at login, as status says", async (t) => {
  const dir = temp(t);
  const w = fakeWindows(dir);
  const service = w.service();
  await service.install({ program: ["C:\\node.exe", "C:\\10and2.js"], path: w.npm });
  assert.equal((await service.state()).installed, true, "no StartupApproved value: on");
  for (const [value, on] of [["020000000000000000000000", true], ["060000000000000000000000", true], ["030000000000000000000000", false], ["07A1B2C3D4E5F60718293A4B", false]] as const) {
    w.approved.set("10and2", value);
    assert.equal((await service.state()).installed, on, value);
  }
  // Another entry's switch is its own.
  w.approved.set("10and2", "020000000000000000000000");
  w.approved.set("10and2-brain", "030000000000000000000000");
  assert.equal((await service.state()).installed, true);
  // No Run entry: not installed, whatever the switch says.
  w.values.clear();
  w.approved.set("10and2", "020000000000000000000000");
  assert.equal((await service.state()).installed, false);
});

test("status counts the connector as running on Windows only while one holds its ledger, whatever its pid is now", async (t) => {
  const dir = temp(t);
  const held = () => ledgerHeld(dir);
  // This test's pid is a live Node's, as a dead connector's may be by now: there that says nothing.
  assert.equal(connectorRunning(process.pid, "win32", held), false, "no ledger yet: can't be told, so not running");
  const ledger = new Ledger(dir);
  assert.equal(connectorRunning(process.pid, "win32", held), true);
  await ledger.close();
  assert.equal(connectorRunning(process.pid, "win32", held), false, "a live Node's pid, but no connector holds the ledger");
  // Elsewhere, whether it answers.
  const gone = spawnSync(NODE, ["-e", ""]).pid!;
  assert.equal(connectorRunning(process.pid, "linux"), true);
  assert.equal(connectorRunning(gone, "linux"), false);
});
