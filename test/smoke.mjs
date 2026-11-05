// The published file runs on its own: no TypeScript, no node_modules, on whichever Node runs this script.
// `npm run check` runs it after the build; run it under Node 22 too (`nix shell nixpkgs#nodejs_22 -c node test/smoke.mjs`).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

// The launcher npm puts on PATH (bin/10and2.js), which loads the bundle, with no flags: what a user runs.
const bin = new URL("../bin/10and2.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "10and2-smoke-"));
const env = { HOME: dir, PATH: process.env.PATH, XDG_CONFIG_HOME: join(dir, "c"), XDG_STATE_HOME: join(dir, "s"), XDG_RUNTIME_DIR: dir, TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1" };
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", timeout: 10_000, input: "" });
try {
  const version = run("version");
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match(run().stdout, /10and2 setup/);
  assert.match(run("token").stdout, /^TENANDTWO_TOKEN=/);
  // Help for a command prints the help and does nothing else: no pairing, no browser.
  for (const args of [["setup", "--help"], ["setup", "-h"], ["revoke", "--help"]]) {
    const help = run(...args);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /10and2 setup {5}connect this computer/);
    assert.doesNotMatch(help.stdout, /Approve|[A-Z]{4}-[A-Z]{4}/);
  }
  const status = run("status");
  assert.match(status.stdout, /Not connected yet/);
  assert.equal(status.stderr, "", "no warnings in the user's terminal");
  const hook = run("hook");
  assert.equal(hook.status, 0); assert.equal(hook.stdout + hook.stderr, "");
  // Every command loads node:sqlite (a static import), so getting this far proves it works on this Node.
  const unpaired = run("run");
  assert.equal(unpaired.status, 78);

  // A brain of your own, from the same package: set up, run, refuse the phone without its code, and link this
  // computer's connector to it. A fake Claude Code; the AI key is never used (nothing here starts a conversation).
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
  // A port nothing else holds, from the OS (a random one collided now and then on a busy machine).
  const port = await new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const brainEnv = { ...env, PATH: `${join(dir, "bin")}:${env.PATH}`, T3_CLI: join(dir, "no-t3"), CLAUDE_CONFIG_DIR: join(dir, "claude") };
  const setup = spawnSync(process.execPath, [bin, "brain", "setup", "--name=smoke", `--port=${port}`, "--yes"], { env: { ...brainEnv, OPENAI_API_KEY: "sk-smoke" }, encoding: "utf8", timeout: 10_000, input: "" });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const code = /Access code +(\S+)/.exec(setup.stdout)[1];
  // Their output is kept, and shown when something here fails.
  const output = [];
  const start = (name, args) => {
    const child = spawn(process.execPath, [bin, ...args], { env: brainEnv, stdio: ["ignore", "pipe", "pipe"] });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => output.push(`${name}: ${String(d).trimEnd()}`));
    child.on("exit", (code, signal) => { child.exited = true; output.push(`${name}: exited (${signal ?? code})`); });
    return child;
  };
  const children = [start("brain", ["brain", "run"]), start("connector", ["run"])];
  const failed = (what) => new Error(`${what}\n${output.join("\n") || "(no output from the brain or the connector)"}`);
  try {
    const origin = `http://127.0.0.1:${port}`;
    // Up to 30 s for a loaded machine; at once if either process has stopped.
    const until = async (what, f) => {
      for (let i = 0; i < 300; i++) {
        if (children.some((c) => c.exited)) throw failed(`${what}: a process stopped`);
        const v = await f().catch(() => null);
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw failed(`${what}: timed out`);
    };
    const page = await until("the brain's page", () => fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok && r.text()));
    assert.match(page, /<html/i);
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    const state = await until("the brain's state, with the access code", () => fetch(`${origin}/api/state`, { headers: { "x-driver-access": code }, signal: AbortSignal.timeout(2000) }).then((r) => r.ok && r.json()));
    assert.match(state.version.rev, /^10and2-\d/);
    const status = await until("the connector linked to the brain", async () => { const s = spawnSync(process.execPath, [bin, "status"], { env: brainEnv, encoding: "utf8" }).stdout; return /Connected to your brain at 127\.0\.0\.1/.test(s) && s; });
    assert.ok(status);
  } finally { for (const c of children) c.kill("SIGTERM"); }
  console.log(`smoke: bin/10and2.js, dist/10and2.js and the brain run on Node ${process.versions.node}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
