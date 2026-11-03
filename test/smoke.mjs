// The published file runs on its own: no TypeScript, no node_modules, on whichever Node runs this script.
// `npm run check` runs it after the build; run it under Node 22 too (`nix shell nixpkgs#nodejs_22 -c node test/smoke.mjs`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const status = run("status");
  assert.match(status.stdout, /Not connected yet/);
  assert.equal(status.stderr, "", "no warnings in the user's terminal");
  const hook = run("hook");
  assert.equal(hook.status, 0); assert.equal(hook.stdout + hook.stderr, "");
  // Every command loads node:sqlite (a static import), so getting this far proves it works on this Node.
  const unpaired = run("run");
  assert.equal(unpaired.status, 78);
  console.log(`smoke: bin/10and2.js and dist/10and2.js run on Node ${process.versions.node}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
