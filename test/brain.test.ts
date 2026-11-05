import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMachine, machines, readBrainEnv, removeMachine, writeBrainEnv } from "../src/brain.ts";
import { BRAIN, launchAgent, systemdUnit } from "../src/service.ts";

const main = new URL("../src/main.ts", import.meta.url).pathname;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY = "sk-test-key-that-must-never-be-printed";

function temp(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "brain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home with Claude Code "installed" (a fake `claude` on PATH), no service manager and a file credential store. */
function home(dir: string): NodeJS.ProcessEnv {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
  return { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), T3_CLI: join(dir, "no-t3"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1" };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [main, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
}

const config = (env: NodeJS.ProcessEnv, file: string) => join(env.XDG_CONFIG_HOME!, "10and2", file);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("the brain's settings are a private file whose JSON values survive the round trip", (t) => {
  const path = join(temp(t), "c", "brain.env");
  const vars = addMachine({ OPENAI_API_KEY: KEY, DRIVER_PORT: "8790" }, { name: "lattice", tokenSha256: "A".repeat(64), local: true });
  writeBrainEnv(vars, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const back = readBrainEnv(path)!;
  assert.equal(back.OPENAI_API_KEY, KEY);
  assert.deepEqual(machines(back), [{ name: "lattice", tokenSha256: "a".repeat(64), local: true }]);
  assert.throws(() => writeBrainEnv({ X: "it's" }, path), /can't be written/);
  assert.throws(() => writeBrainEnv({ X: "a\nB=1" }, path), /can't be written/);
});

test("a brain accepts a computer once, by a name it can say and a token's hash; removing it forgets it", () => {
  let vars = addMachine({}, { name: "lattice", tokenSha256: "a".repeat(64), local: true });
  vars = addMachine(vars, { name: "quartz", tokenSha256: "b".repeat(64) });
  assert.deepEqual(machines(vars).map((m) => m.name), ["lattice", "quartz"]);
  assert.throws(() => addMachine(vars, { name: "quartz", tokenSha256: "c".repeat(64) }), /already has a computer called quartz/);
  assert.throws(() => addMachine(vars, { name: "prism", tokenSha256: "B".repeat(64) }), /already has a computer with that token/);
  assert.throws(() => addMachine(vars, { name: "two words", tokenSha256: "c".repeat(64) }), /can't be a computer's name/);
  assert.throws(() => addMachine(vars, { name: "prism", tokenSha256: "abc" }), /64 hex digits/);
  assert.deepEqual(machines(removeMachine(vars, "quartz")).map((m) => m.name), ["lattice"]);
  assert.throws(() => removeMachine(vars, "prism"), /no computer called prism/);
});

test("the brain's login service runs `brain run` under its own name, beside the connector's", () => {
  const l = { node: "/usr/bin/node", script: "/opt/10and2/dist/10and2.js", path: "/usr/bin" };
  assert.match(systemdUnit(l, BRAIN), /^ExecStart=\/usr\/bin\/node \/opt\/10and2\/dist\/10and2.js brain run$/m);
  assert.match(systemdUnit(l, BRAIN), /^Description=10and2 brain/m);
  const plist = launchAgent(l, "/Users/x/Library/Logs/10and2-brain.log", BRAIN);
  assert.match(plist, /<key>Label<\/key><string>com\.selfdeprecated\.10and2\.brain<\/string>/);
  assert.match(plist, /<string>brain<\/string>\n {4}<string>run<\/string>/);
  assert.doesNotMatch(plist, /fatal-exit/);
});

test("brain setup links this computer to a brain of its own, and another computer joins it with a token", async (t) => {
  const env: NodeJS.ProcessEnv = { ...home(temp(t)), OPENAI_API_KEY: KEY };
  const setup = await cli(["brain", "setup", "--name=desk", "--port=18799", "--yes"], env);
  assert.equal(setup.status, 0, setup.out);
  const vars = readBrainEnv(config(env, "brain.env"))!;
  assert.equal(statSync(config(env, "brain.env")).mode & 0o777, 0o600);
  assert.equal(vars.OPENAI_API_KEY, KEY);
  assert.equal(vars.DRIVER_PORT, "18799");
  assert.ok(vars.DRIVER_ACCESS_CODE.length >= 12);
  // The connector here reaches it over loopback with a token whose hash is all the brain keeps.
  const origin = "http://127.0.0.1:18799";
  const token = json(config(env, "credentials.json"))[origin];
  assert.deepEqual(machines(vars), [{ name: "desk", tokenSha256: sha256(token), local: true }]);
  assert.equal(json(config(env, "connector.json")).brain, "ws://127.0.0.1:18799/connector");
  // The phone's access code is shown; the AI key and the token never are.
  assert.match(setup.out, new RegExp(`Access code +${vars.DRIVER_ACCESS_CODE}`));
  assert.match(setup.out, /Self-hosted brain/);
  assert.ok(!setup.out.includes(KEY) && !setup.out.includes(token));
  assert.match((await cli(["brain", "setup"], env)).out, /already set up/);

  // Another computer: a token made there, its hash added here.
  const other = home(temp(t));
  const join_ = await cli(["setup", `--brain=${origin}`, "--token", "--name=laptop", "--no-autostart"], other);
  assert.equal(join_.status, 0, join_.out);
  const otherToken = json(config(other, "credentials.json"))[origin];
  assert.ok(!join_.out.includes(otherToken));
  const add = /10and2 brain add (\S+) (\S+)/.exec(join_.out)!;
  assert.deepEqual([add[1], add[2]], ["laptop", sha256(otherToken)]);
  assert.match(join_.out, /connects once your brain accepts it|10and2 run/);
  assert.match((await cli(["setup", "--no-autostart"], other)).out, /already connected to your brain at 127\.0\.0\.1:18799/);
  assert.match((await cli(["setup", "--token", "--no-autostart"], home(temp(t)))).out, /give its address too/);

  assert.equal((await cli(["brain", "add", add[1], add[2]], env)).status, 0);
  const status = await cli(["brain", "status"], env);
  assert.match(status.out, /Not running/);
  assert.match(status.out, /Accepts +desk \(this computer\), laptop/);
  assert.ok(!status.out.includes(vars.DRIVER_ACCESS_CODE), "the code only with --code");
  assert.match((await cli(["brain", "status", "--code"], env)).out, new RegExp(vars.DRIVER_ACCESS_CODE));
  assert.match((await cli(["brain", "add", "laptop", sha256("x")], env)).out, /already has a computer called laptop/);
  assert.equal((await cli(["brain", "remove", "laptop"], env)).status, 0);
  assert.deepEqual(machines(readBrainEnv(config(env, "brain.env"))!).map((m) => m.name), ["desk"]);

  // Disconnecting the other computer from a brain of your own: nothing to call, the brain is told what to remove.
  const revoke = await cli(["revoke", "--yes"], other);
  assert.equal(revoke.status, 0, revoke.out);
  assert.match(revoke.out, /10and2 brain remove/);
  assert.deepEqual(json(config(other, "credentials.json")), {});
});

test("brain setup won't take over a computer connected to a 10 & 2 account, and brain run needs a brain set up", async (t) => {
  const env: NodeJS.ProcessEnv = { ...home(temp(t)), OPENAI_API_KEY: KEY };
  const credential = `dc1.${Buffer.from("user_abc123").toString("base64url")}.${"d".repeat(22)}.${"s".repeat(43)}`;
  mkdirSync(join(env.XDG_CONFIG_HOME!, "10and2"), { recursive: true, mode: 0o700 });
  writeFileSync(config(env, "connector.json"), JSON.stringify({ brain: "wss://10and2.selfdep.com/connector", projects: "*", actions: [], t3: false, claude: true }));
  writeFileSync(config(env, "credentials.json"), JSON.stringify({ "https://10and2.selfdep.com": credential }), { mode: 0o600 });
  const setup = await cli(["brain", "setup", "--yes"], env);
  assert.equal(setup.status, 1);
  assert.match(setup.out, /connected to your 10 & 2 account\. 10and2 revoke disconnects it/);

  const bare = home(temp(t));
  const run = await cli(["brain", "run"], bare);
  assert.equal(run.status, 1);
  assert.match(run.out, /no brain set up on this computer: 10and2 brain setup/);
});
