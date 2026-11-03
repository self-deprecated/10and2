import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = new URL("../src/main.ts", import.meta.url);
test("token prints 32 fresh random bytes and their SHA-256 without requiring configuration", () => {
  const run = () => spawnSync(process.execPath, [main.pathname, "token"], { encoding: "utf8", timeout: 5000 });
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] }, theme: "dark" };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(own));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const run = (...args: string[]) => spawnSync(process.execPath, [main.pathname, "hooks", ...args], { env, encoding: "utf8", timeout: 5000 });
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /are installed/);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("my-own-hook"));
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("10and2 hook"));
  assert.equal(settings.hooks.PermissionRequest, undefined);
  assert.equal(run("uninstall").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), own);
  assert.match(run("status").stdout, /aren't installed/);
  assert.equal(run("bogus").status, 1);
});

test("the hook command is silent and succeeds when no connector is listening", () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-hook-"));
  const r = spawnSync(process.execPath, [main.pathname, "hook"], {
    env: { ...process.env, XDG_RUNTIME_DIR: dir }, input: JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", hook_event_name: "Stop" }), encoding: "utf8", timeout: 5000,
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
});

test("no command prints the usage instead of starting a connector", () => {
  const r = spawnSync(process.execPath, [main.pathname], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /10and2 setup/);
  const wrong = spawnSync(process.execPath, [main.pathname, "nonsense"], { encoding: "utf8", timeout: 5000 });
  assert.equal(wrong.status, 64);
  assert.match(wrong.stderr, /There's no "nonsense" command\. .*10and2 help.* lists them/);
});

test("a login service started before the keyring opens waits for the credential instead of giving up", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "connector-wait-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config", "10and2");
  mkdirSync(config, { recursive: true });
  // Port 9 refuses at once; the link only has to start, not succeed.
  writeFileSync(join(config, "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:9/connector", projects: "*", actions: [], t3: false, claude: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_TOKEN: "" };
  const child = spawn(process.execPath, [main.pathname, "run", "--wait-for-credential=0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  const seen = (re: RegExp) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never saw ${re} in:\n${out}`)), 5000);
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

  // Run by hand (no flag), an unpaired machine is told so and the connector exits.
  rmSync(join(config, "credentials.json"));
  const once = spawnSync(process.execPath, [main.pathname, "run"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(once.status, 78);
  assert.match(once.stdout + once.stderr, /isn't paired/);
});
