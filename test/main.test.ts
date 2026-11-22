import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { proof, randomHex } from "../src/util.ts";
import { NODE, removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";

import { installHooks } from "../src/claude/hooks.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const timeout = 5000 * SLOW;
test("token prints 32 fresh random bytes and their SHA-256 without requiring configuration", () => {
  const run = () => spawnSync(NODE, [main, "token"], { encoding: "utf8", timeout });
  const a = run(); const b = run();
  assert.equal(a.status, 0, a.stderr);
  const token = /^TENANDTWO_TOKEN=(.+)$/m.exec(a.stdout)![1];
  const hash = /^tokenSha256=(.+)$/m.exec(a.stdout)![1];
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(a.stdout, b.stdout);
});

test("hooks install, report and uninstall in the Claude Code settings they're pointed at, keeping the user's own", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-hooks-"));
  t.after(() => removeDir(dir));
  const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] }, theme: "dark" };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(own));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const run = (...args: string[]) => spawnSync(NODE, [main, "hooks", ...args], { env, encoding: "utf8", timeout });
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /are installed/);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("my-own-hook"));
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("10and2 hook"));
  // The one PermissionRequest hook is limited to Claude's own questions, and waits rather than running in the background.
  assert.deepEqual(settings.hooks.PermissionRequest.map((e: any) => [e.matcher, e.hooks[0].async, e.hooks[0].timeout]), [["AskUserQuestion|ExitPlanMode", undefined, 21600]]);
  assert.equal(run("uninstall").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), own);
  assert.match(run("status").stdout, /aren't installed/);
  assert.equal(run("bogus").status, 1);
});

test("the hook command is silent and succeeds when no connector is listening", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-hook-"));
  // As src/main.ts's own shebang starts it (the launchers do the same): on Node 22, node:sqlite's experimental notice
  // would otherwise be the output.
  const r = spawnSync(NODE, ["--disable-warning=ExperimentalWarning", main, "hook"], {
    // Its own state folder too: on Windows the pipe's name is read from there, and this computer's connector may be running.
    env: { ...process.env, XDG_RUNTIME_DIR: dir, XDG_STATE_HOME: dir }, input: JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", hook_event_name: "Stop" }), encoding: "utf8", timeout,
  });
  removeDir(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("the hook command is silent and succeeds when a connector is listening, and its event arrives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-hook-"));
  t.after(() => removeDir(dir));
  // The adapter's end, as claude/adapter.ts listens: a socket file, or on Windows a pipe named in hooks.pipe that first
  // proves itself to the hook.
  const secret = randomHex();
  const path = WINDOWS ? `\\\\.\\pipe\\10and2-hooktest-${randomHex()}` : join(dir, "10and2", "hooks.sock");
  if (WINDOWS) { mkdirSync(join(dir, "10and2", "claude"), { recursive: true }); writeFileSync(join(dir, "10and2", "claude", "hooks.pipe"), `${path}\n${secret}`); }
  else mkdirSync(join(dir, "10and2"));
  const got: string[] = [];
  const server = createServer((c) => {
    let text = "";
    c.on("data", (b) => {
      text += b;
      if (WINDOWS && text.includes("\n") && !got.length && text.startsWith("{\"nonce\"")) {
        const [line, rest = ""] = [text.slice(0, text.indexOf("\n")), text.slice(text.indexOf("\n") + 1)];
        c.write(proof(secret, JSON.parse(line).nonce) + "\n");
        text = rest;
      }
    });
    c.on("end", () => { got.push(text.trim()); c.end(); });
  });
  await new Promise<void>((r) => server.listen(path, r));
  t.after(() => server.close());
  const child = spawn(NODE, ["--disable-warning=ExperimentalWarning", main, "hook"], { env: { ...process.env, XDG_RUNTIME_DIR: dir, XDG_STATE_HOME: dir }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  child.stdin.end(JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", hook_event_name: "Stop" }));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, out);
  assert.equal(out, "");
  assert.match(got.join(""), /"hook_event_name":"Stop"/);
});

test("no command prints the usage instead of starting a connector", () => {
  const r = spawnSync(NODE, [main], { encoding: "utf8", timeout });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /10and2 setup/);
  const wrong = spawnSync(NODE, [main, "nonsense"], { encoding: "utf8", timeout });
  assert.equal(wrong.status, 64);
  assert.match(wrong.stderr, /There's no "nonsense" command\. .*10and2 help.* lists them/);
});

test("a login service started before the keyring opens waits for the credential instead of giving up", { skip: WINDOWS && "Windows has no keyring to wait for" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-wait-"));
  const config = join(dir, "config", "10and2");
  mkdirSync(config, { recursive: true });
  // Port 9 refuses at once; the link only has to start, not succeed.
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: [], t3: false, claude: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_TOKEN: "" };
  const child = spawn(NODE, [main, "run", "--wait-for-credential=0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  // Stopped, and waited for, before its folder goes: Windows won't remove a file a running process holds.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once("exit", r); child.kill("SIGKILL"); });
    removeDir(dir);
  });
  let out = "";
  const seen = (re: RegExp) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never saw ${re} in:\n${out}`)), timeout);
    const check = () => { if (re.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", (d) => { out += d; check(); });
    child.stderr.on("data", (d) => { out += d; check(); });
    check();
  });
  await seen(/no credential readable/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, "still waiting, not exited");
  writeFileSync(join(config, "credentials.json"), JSON.stringify({ "http://127.0.0.1:9": "dc1.x.y.z" }), { mode: 0o600 });
  await seen(/linking to http:\/\/127\.0\.0\.1:9/);
  assert.doesNotMatch(readFileSync(join(dir, "state", "10and2", "status.json"), "utf8"), /waiting for the credential/, "no longer waiting");

  // Run by hand (no flag), an unpaired machine is told so and the connector exits.
  rmSync(join(config, "credentials.json"));
  const once = spawnSync(NODE, [main, "run"], { env, encoding: "utf8", timeout });
  assert.equal(once.status, 78);
  assert.match(once.stdout + once.stderr, /isn't paired/);
});

test("on Windows the login service doesn't wait for a key it can't read: it stops as unpaired, and says what to do", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-nowait-"));
  t.after(() => removeDir(dir));
  const config = join(dir, "config", "10and2");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: [], t3: false, claude: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_TOKEN: "" };
  // As Windows' supervisor runs it (service.ts CONNECTOR), on a Windows of the test's own: no key in credentials.json.
  const win32 = `--import=data:text/javascript,Object.defineProperty(process, "platform", { value: "win32" })`;
  const r = spawnSync(NODE, [win32, main, "run", "--wait-for-credential=0.1"], { env, encoding: "utf8", timeout });
  assert.equal(r.status, 78, `stopped, not restarted: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /isn't paired with http:\/\/127\.0\.0\.1:9\. Run `10and2 setup`/);
  assert.doesNotMatch(r.stdout + r.stderr, /keyring|checking every/);
  assert.equal(JSON.parse(readFileSync(join(dir, "state", "10and2", "status.json"), "utf8")).error, "not paired");
});

test("on Windows a key that's there but can't be read is tried again before the connector stops as unpaired", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-retry-"));
  t.after(() => removeDir(dir));
  const config = join(dir, "config", "10and2");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: [], t3: false, claude: true }));
  // A DPAPI key whose PowerShell can't start here (there's none on this machine), as one failed start at sign-in.
  writeFileSync(join(config, "credentials.json"), JSON.stringify({ "http://127.0.0.1:9": "dpapi:AAAA" }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_TOKEN: "", PATH: join(dir, "nothing") };
  const win32 = `--import=data:text/javascript,Object.defineProperty(process, "platform", { value: "win32" })`;
  const started = Date.now();
  const r = spawnSync(NODE, [win32, main, "run", "--wait-for-credential"], { env, encoding: "utf8", timeout: timeout + 10_000 });
  assert.equal(r.status, 78, `${r.stdout}${r.stderr}`);
  assert.ok(Date.now() - started >= 6000, "tried twice more, 3 s apart");
  assert.match(r.stdout, /isn't paired/);
});

test("the running connector names its own socket and settings in the gate's entries, where they're installed (stage 4's fix4 review)", { skip: WINDOWS && "the gate's entry names no socket on Windows: its pipe is new at each start" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-gate-"));
  const config = join(dir, "config", "10and2"), claude = join(dir, "claude");
  mkdirSync(config, { recursive: true }); mkdirSync(claude, { recursive: true });
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: ["follow_up"], t3: false, claude: true, guard: ["terraform apply*"] }));
  writeFileSync(join(config, "credentials.json"), JSON.stringify({ "http://127.0.0.1:9": "dc1.x.y.z" }), { mode: 0o600 });
  // Installed by a setup whose environment had no XDG_RUNTIME_DIR: another socket than the service's.
  await installHooks(claude, "10and2", true, join(config, "connector.json"), join(dir, "setup-shell", "hooks.sock"));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: dir, CLAUDE_CONFIG_DIR: claude, TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_TOKEN: "" };
  const child = spawn(process.execPath, [main, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  // Stopped, and waited for, before its folder goes: Windows won't remove a file a running process holds.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once("exit", r); child.kill("SIGKILL"); });
    removeDir(dir);
  });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never linked:\n${out}`)), 10_000);
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { out += d; if (/linking to/.test(out)) { clearTimeout(timer); resolve(); } });
  });
  assert.match(out, /the hook that holds commands on your list now names this connector's socket and settings/);
  const bash = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).hooks.PreToolUse.find((e: any) => e.matcher === "Bash").hooks[0].command as string;
  assert.ok(bash.includes(` --socket '${join(dir, "10and2", "hooks.sock")}' `), bash);
});

test("status says what this computer may do for later, and lists what it holds, on its own clock", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-held-"));
  t.after(() => removeDir(dir));
  const config = join(dir, "config", "10and2"), state = join(dir, "state", "10and2");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: ["follow_up", "start_work"], t3: false, claude: true, rules: "start" }));
  const at = new Date(Date.now() + 3 * 60_000);
  writeFileSync(join(state, "status.json"), JSON.stringify({ pid: process.pid, linked: true, since: new Date().toISOString(), schedules: [
    { at: at.toISOString(), said: "Send “carry on” to API" }, { at: null, said: "Sending “rebase” to API when Schema finishes" },
  ] }));
  const env: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC", XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1", TENANDTWO_TOKEN: "" };
  const r = spawnSync(process.execPath, [main, "status"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  const hm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  assert.match(r.stdout, /For later +send messages and start threads/);
  assert.ok(r.stdout.includes(`Holding 2 for later: ${hm}${at.getUTCDate() === new Date().getUTCDate() ? "" : " tomorrow"} Send “carry on” to API; Sending “rebase” to API when Schema finishes`), r.stdout);
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: ["follow_up"], t3: false, claude: true, rules: "start", documents: "all" }));
  writeFileSync(join(state, "status.json"), JSON.stringify({ pid: process.pid, linked: true, since: new Date().toISOString(), schedules: [] }));
  const narrowed = spawnSync(process.execPath, [main, "status"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.match(narrowed.stdout, /For later +send messages\n/, "starting threads later needs new work allowed too");
  assert.match(narrowed.stdout, /Documents +project and plan folders\n/);
  assert.doesNotMatch(narrowed.stdout, /Holding/);

  const changed = spawnSync(process.execPath, [main, "agents", "--yes", "--documents=project"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(readFileSync(join(config, "connector.json"), "utf8")).documents, "project");
  const after = spawnSync(process.execPath, [main, "status"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.match(after.stdout, /Documents +project folders\n/);

  const featOn = spawnSync(process.execPath, [main, "features", "documents", "on"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.equal(featOn.status, 0, featOn.stderr);
  assert.equal(JSON.parse(readFileSync(join(config, "connector.json"), "utf8")).documents, "all");
  const featList = spawnSync(process.execPath, [main, "features", "list"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.equal(featList.status, 0, featList.stderr);
  assert.match(featList.stdout, /documents +on \(project and plan folders\)/);
  const featOff = spawnSync(process.execPath, [main, "features", "documents", "off"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.equal(featOff.status, 0, featOff.stderr);
  assert.equal(JSON.parse(readFileSync(join(config, "connector.json"), "utf8")).documents, "off");
  const badFeat = spawnSync(process.execPath, [main, "features", "nope", "on"], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.notEqual(badFeat.status, 0);
  assert.match(badFeat.stderr, /Unknown feature "nope"/);
});

/** A computer of the test's own: nothing of this one's agents, settings or login services is read or changed. */
function isolated(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(XDG_|CLAUDE_|CODEX_|PI_|T3|OPENCODE|GEMINI_|COPILOT_|CURSOR_|TENANDTWO_|FORCE_COLOR$)/i.test(k)) delete env[k];
  return { ...env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"),
    PI_CODING_AGENT_DIR: join(dir, "pi"), COPILOT_HOME: join(dir, "copilot"), PATH: join(dir, "nothing"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1", TENANDTWO_COMMAND: "10and2", TENANDTWO_TOKEN: "" };
}
/** A computer set up with a brain at port 9, its key on disk, and `status` as the connector last wrote it. */
function connectedComputer(t: { after: (f: () => void) => void }, status: object) {
  const dir = mkdtempSync(join(tmpdir(), "connector-state-"));
  t.after(() => removeDir(dir));
  const config = join(dir, "config", "10and2"), state = join(dir, "state", "10and2");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", t3: false, claude: true }));
  writeFileSync(join(config, "credentials.json"), JSON.stringify({ "http://127.0.0.1:9": "a-token" }), { mode: 0o600 });
  writeFileSync(join(state, "status.json"), JSON.stringify(status));
  const env = isolated(dir);
  return (...args: string[]) => spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8", timeout: 10_000 * SLOW });
}

test("a computer 10 & 2 disconnected says so in status and setup, and how to connect it again, not 'already connected'", (t) => {
  // Stopped for good (exit 78), as the connector leaves it when its key is refused.
  const run = connectedComputer(t, { pid: 2 ** 22 + 17, linked: false, fatal: true, error: "this computer was disconnected (revoked on the website, or set up again elsewhere)" });
  const status = run("status");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout + status.stderr, /Disconnected from your brain at 127\.0\.0\.1:9: this computer was disconnected \(revoked on the website/);
  assert.match(status.stdout, /To connect it again: 10and2 revoke, then 10and2 setup\./);
  const setup = run("setup", "--yes", "--no-autostart");
  assert.equal(setup.status, 1);
  assert.doesNotMatch(setup.stdout + setup.stderr, /already connected/);
  assert.match(setup.stdout + setup.stderr, /This computer was disconnected from your brain at 127\.0\.0\.1:9/);
  assert.match(setup.stdout, /To connect it again: 10and2 revoke, then 10and2 setup\./);
});

test("status says when the running connector is an older version than the one installed, and when T3 Code stopped on its own", { skip: WINDOWS && "Windows tells a running connector by its ledger's lock" }, (t) => {
  const run = connectedComputer(t, { pid: process.pid, version: "0.0.1", linked: true, since: new Date().toISOString(), t3Error: "T3 Code refused 10 & 2's session (revoked there?)" });
  const status = run("status");
  assert.equal(status.status, 0, status.stderr);
  const out = status.stdout + status.stderr;
  assert.match(out, /It's running 0\.0\.1, and \d+\.\d+\.\d+ is installed: stop it and 10and2 run again for/);
  assert.match(out, /T3 Code refused 10 & 2's session \(revoked there\?\)\. The other agents stay connected/);
  const current = connectedComputer(t, { pid: process.pid, version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, linked: true, since: new Date().toISOString() });
  assert.doesNotMatch(current("status").stdout, /It's running/);
});

test("uninstall removes 10and2's Copilot extension too, and turns off the experimental features it turned on", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-uninstall-copilot-"));
  t.after(() => removeDir(dir));
  const env = isolated(dir);
  const run = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { env, encoding: "utf8", timeout: 10_000 * SLOW });
  assert.equal(run("copilot", "install").status, 0);
  const extension = join(dir, "copilot", "extensions", "10and2", "extension.mjs");
  assert.ok(existsSync(extension));
  const r = run("uninstall", "--yes");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Removed its Copilot extension[\s\S]*Deleted its settings and files/);
  assert.equal(existsSync(extension), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "copilot", "settings.json"), "utf8")).experimental, false);
  assert.doesNotMatch(run("uninstall", "--yes").stdout, /Removed/, "nothing left to remove");
});
