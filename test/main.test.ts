import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { proof, randomHex } from "../src/util.ts";
import { removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const timeout = 5000 * SLOW;
test("token prints 32 fresh random bytes and their SHA-256 without requiring configuration", () => {
  const run = () => spawnSync(process.execPath, [main, "token"], { encoding: "utf8", timeout });
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
  const run = (...args: string[]) => spawnSync(process.execPath, [main, "hooks", ...args], { env, encoding: "utf8", timeout });
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
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", main, "hook"], {
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
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "hook"], { env: { ...process.env, XDG_RUNTIME_DIR: dir, XDG_STATE_HOME: dir }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { out += b; });
  child.stdin.end(JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", hook_event_name: "Stop" }));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, out);
  assert.equal(out, "");
  assert.match(got.join(""), /"hook_event_name":"Stop"/);
});

test("no command prints the usage instead of starting a connector", () => {
  const r = spawnSync(process.execPath, [main], { encoding: "utf8", timeout });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /10and2 setup/);
  const wrong = spawnSync(process.execPath, [main, "nonsense"], { encoding: "utf8", timeout });
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
  const child = spawn(process.execPath, [main, "run", "--wait-for-credential=0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  const once = spawnSync(process.execPath, [main, "run"], { env, encoding: "utf8", timeout });
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
  const r = spawnSync(process.execPath, [win32, main, "run", "--wait-for-credential=0.1"], { env, encoding: "utf8", timeout });
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
  const r = spawnSync(process.execPath, [win32, main, "run", "--wait-for-credential"], { env, encoding: "utf8", timeout: timeout + 10_000 });
  assert.equal(r.status, 78, `${r.stdout}${r.stderr}`);
  assert.ok(Date.now() - started >= 6000, "tried twice more, 3 s apart");
  assert.match(r.stdout, /isn't paired/);
});
