import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Credentials, parseCredential, type Runner } from "../src/credential.ts";
import { Expired, linkUrl, originOf, pair } from "../src/pair.ts";
import { launchAgent, Service, systemdUnit } from "../src/service.ts";

const main = new URL("../src/main.ts", import.meta.url).pathname;
const credential = `dc1.${Buffer.from("user_abc123").toString("base64url")}.${"d".repeat(22)}.${"s".repeat(43)}`;

function temp(t: { after: (f: () => void) => void }, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a credential names its user and device; anything else isn't one", () => {
  assert.deepEqual(parseCredential(credential), { userId: "user_abc123", deviceId: "d".repeat(22) });
  assert.equal(parseCredential("static-token"), null);
  assert.equal(parseCredential(`dc1.${Buffer.from("someone").toString("base64url")}.${"d".repeat(22)}.x`), null);
});

test("the Keychain and libsecret get the secret on stdin, never as an argument; the file is the fallback, 0600", async (t) => {
  const dir = temp(t, "creds-");
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const stored = new Map<string, string>();
  const runner: Runner = async (command, args, input) => {
    calls.push({ command, args, input });
    if (command === "security" && args[0] === "-i") { stored.set("k", /-w (\S+)/.exec(input!)![1]); return ""; }
    if (command === "security" && args[0] === "find-generic-password") return stored.get("k") ?? null;
    if (command === "secret-tool" && args[0] === "store") { stored.set("l", input!); return ""; }
    if (command === "secret-tool" && args[0] === "lookup") return stored.get("l") ?? null;
    return "";
  };
  const env = { XDG_CONFIG_HOME: dir };
  const mac = new Credentials({ runner, platform: "darwin", env });
  assert.equal(await mac.save("https://10and2.selfdep.com", credential), "keychain");
  assert.deepEqual(await mac.load("https://10and2.selfdep.com"), { secret: credential, store: "keychain" });
  const linux = new Credentials({ runner, platform: "linux", env });
  assert.equal(await linux.save("https://10and2.selfdep.com", credential), "libsecret");
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes(credential)), `${c.command} ${c.args.join(" ")}`);

  // A keyring that can't store (a headless server) falls back to a private file.
  const broken = new Credentials({ runner: async () => null, platform: "linux", env });
  assert.equal(await broken.save("https://10and2-stg.selfdep.com", credential), "file");
  const file = join(dir, "10and2", "credentials.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await broken.load("https://10and2-stg.selfdep.com"), { secret: credential, store: "file" });
  await broken.delete("https://10and2-stg.selfdep.com");
  assert.equal(await broken.load("https://10and2-stg.selfdep.com"), null);
  chmodSync(file, 0o644);
  await assert.rejects(broken.load("https://10and2-stg.selfdep.com"), /mode 0600/);
});

test("Ctrl-C while waiting for approval stops at once, not at the next poll", async () => {
  const pending = (async (url: string) => new Response(JSON.stringify(url.endsWith("/pair") ? { deviceCode: "d", userCode: "u", verificationUrl: "https://x/connect", expiresIn: 600, interval: 5 } : { status: "pending" }))) as typeof fetch;
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pair("https://x", { name: "b", platform: "linux" }, { fetch: pending, show: () => {}, signal: controller.signal }), /cancelled/);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("pairing shows the code, polls until approved, and refuses an approval page off https", async () => {
  const answers = [{ status: "pending" }, { status: "pending" }, { status: "approved", credential }];
  const posts: string[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    posts.push(`${url} ${init.body}`);
    const body = url.endsWith("/connector/pair")
      ? { deviceCode: "ABCDEFGH.x", userCode: "ABCD-EFGH", verificationUrl: "https://10and2.selfdep.com/connect?code=ABCD-EFGH", expiresIn: 600, interval: 5 }
      : answers.shift();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const shown: string[] = [];
  const got = await pair("https://10and2.selfdep.com", { name: "box", platform: "linux" }, { fetch: fakeFetch, sleep: async () => {}, show: (p) => shown.push(p.userCode) });
  assert.equal(got, credential);
  assert.deepEqual(shown, ["ABCD-EFGH"]);
  assert.equal(posts.length, 4);
  assert.match(posts[0], /"name":"box","platform":"linux"/);

  const denied = (async (url: string) => new Response(JSON.stringify(url.endsWith("/pair") ? { deviceCode: "d", userCode: "u", verificationUrl: "https://x/connect", expiresIn: 600, interval: 1 } : { status: "denied" }))) as typeof fetch;
  await assert.rejects(pair("https://x", { name: "b", platform: "linux" }, { fetch: denied, sleep: async () => {}, show: () => {} }), /turned down/);
  const expired = (async (url: string) => new Response(JSON.stringify(url.endsWith("/pair") ? { deviceCode: "d", userCode: "u", verificationUrl: "https://x/connect", expiresIn: 600, interval: 1 } : { status: "expired" }))) as typeof fetch;
  await assert.rejects(pair("https://x", { name: "b", platform: "linux" }, { fetch: expired, sleep: async () => {}, show: () => {} }), Expired);
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(pair("https://10and2.selfdep.com", { name: "b", platform: "linux" }, { fetch: offline, show: () => {} }), /Couldn't reach 10and2\.selfdep\.com\. Check your internet connection/);
  const phishing = (async () => new Response(JSON.stringify({ deviceCode: "d", userCode: "u", verificationUrl: "http://evil.example/connect", expiresIn: 600, interval: 1 }))) as typeof fetch;
  await assert.rejects(pair("https://x", { name: "b", platform: "linux" }, { fetch: phishing, sleep: async () => {}, show: () => assert.fail("shown") }), /https/);
});

test("the brain's origin and link URL come from each other", () => {
  assert.equal(originOf("wss://10and2.selfdep.com/connector"), "https://10and2.selfdep.com");
  assert.equal(originOf("ws://127.0.0.1:8790/connector"), "http://127.0.0.1:8790");
  assert.equal(linkUrl("https://10and2.selfdep.com"), "wss://10and2.selfdep.com/connector");
  assert.equal(linkUrl("http://127.0.0.1:8790"), "ws://127.0.0.1:8790/connector");
});

test("login services run this node and script with setup's PATH, and don't restart a revoked connector", () => {
  const l = { node: "/usr/bin/node", script: "/opt/10and2 app/dist/10and2.js", path: "/usr/local/bin:/usr/bin" };
  const unit = systemdUnit(l);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/opt\/10and2 app\/dist\/10and2.js" run --wait-for-credential$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/local\/bin:\/usr\/bin$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  const plist = launchAgent(l, "/Users/x/Library/Logs/10and2.log");
  assert.match(plist, /<string>--fatal-exit=0<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<string>\/opt\/10and2 app\/dist\/10and2.js<\/string>/);
});

/** Runs the CLI against a fake brain; returns its output and exit status. */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [main, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
}

test("setup pairs in the browser, keeps the credential private, writes a policy; status shows it; revoke undoes it", async (t) => {
  const dir = temp(t, "setup-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "t3"), "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
  const seen: { path: string; auth?: string; body: string }[] = [];
  let polls = 0;
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.push({ path: req.url!, auth: req.headers.authorization, body });
    const port = (server.address() as AddressInfo).port;
    const json = (v: object, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.url === "/connector/pair") return json({ deviceCode: "ABCDEFGH.secret", userCode: "ABCD-EFGH", verificationUrl: `http://127.0.0.1:${port}/connect?code=ABCD-EFGH`, expiresIn: 600, interval: 1 });
    if (req.url === "/connector/pair/poll") return json(++polls < 2 ? { status: "pending" } : { status: "approved", credential });
    if (req.url === "/connector/revoke") return json({ ok: true });
    json({ error: "no" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: NodeJS.ProcessEnv = { HOME: dir, PATH: bin, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1" };

  const setup = await cli(["setup", `--brain=${origin}`, "--name=testbox", "--no-autostart"], env);
  assert.equal(setup.status, 0, setup.out);
  assert.match(setup.out, /ABCD-EFGH/);
  assert.ok(!setup.out.includes(credential), "the credential is never printed");
  assert.match(seen[0].body, /"name":"testbox"/);
  const creds = join(dir, "config", "10and2", "credentials.json");
  assert.equal(statSync(creds).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(creds, "utf8"))[origin], credential);
  const policy = JSON.parse(readFileSync(join(dir, "config", "10and2", "connector.json"), "utf8"));
  assert.deepEqual(policy, { brain: `${origin.replace("http", "ws")}/connector`, projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", t3: true, claude: false });

  const again = await cli(["setup", "--no-autostart"], env);
  assert.equal(again.status, 0);
  assert.match(again.out, /already connected/);
  assert.equal(seen.filter((s) => s.path === "/connector/pair").length, 1);

  const status = await cli(["status"], env);
  assert.match(status.out, /Not running/);
  assert.match(status.out, /Sees +every project in T3 Code/);
  assert.match(status.out, /Can +follow up, start work, settle, snooze and archive, after your spoken yes/);
  assert.doesNotMatch(status.out, /brain/i, "no internals in what people read");
  assert.ok(!status.out.includes(credential));
  const verbose = await cli(["status", "--verbose"], env);
  assert.match(verbose.out, /device d{22} of user_abc123/);
  assert.ok(!verbose.out.includes(credential));

  const revoke = await cli(["revoke", "--yes"], env);
  assert.equal(revoke.status, 0, revoke.out);
  assert.equal(seen.at(-1)!.path, "/connector/revoke");
  assert.equal(seen.at(-1)!.auth, `Bearer ${credential}`);
  assert.deepEqual(JSON.parse(readFileSync(creds, "utf8")), {});
  assert.ok(existsSync(join(dir, "config", "10and2", "connector.json")), "the policy is kept");
});

test("a LaunchAgent is loaded only once launchd has let go of the old one, and reported running once it runs", async (t) => {
  const home = temp(t, "agent-");
  // launchd as it behaves: bootout returns while the job is still going for a few polls; a bootstrap then fails;
  // after a bootstrap the job takes a few polls to be running.
  let job: "running" | "stopping" | "starting" | null = "running";
  let polls = 0;
  const calls: string[] = [];
  const runner: Runner = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === "bootout") { if (job) { job = "stopping"; polls = 0; } return job ? "" : null; }
    if (args[0] === "print") {
      if (job === "stopping" && ++polls > 3) job = null;
      if (job === "starting" && ++polls > 3) job = "running";
      return job ? `state = ${job === "running" ? "running" : "waiting"}` : null;
    }
    if (args[0] === "bootstrap") { if (job) return null; job = "starting"; polls = 0; return ""; }
    return "";
  };
  const service = new Service({ runner, platform: "darwin", home, sleep: async () => {} });
  const s = await service.install({ node: "/usr/bin/node", script: "/opt/10and2.js", path: "/usr/bin" });
  assert.equal(s.running, true);
  assert.equal(calls.filter((c) => c === "bootstrap").length, 1, "never bootstrapped while the old job was still there");
  await service.uninstall();
  assert.equal(job, null);
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", "com.selfdeprecated.10and2.plist")), false);
});

test("run refuses with 78 when the machine isn't paired, or its credentials file is readable by others", async (t) => {
  const dir = temp(t, "run-");
  mkdirSync(join(dir, "10and2"));
  writeFileSync(join(dir, "10and2", "connector.json"), JSON.stringify({ brain: "ws://127.0.0.1:1/connector" }));
  const env: NodeJS.ProcessEnv = { HOME: dir, PATH: "/nonexistent", XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, "state"), TENANDTWO_CREDENTIAL_STORE: "file" };
  const unpaired = await cli(["run"], env);
  assert.equal(unpaired.status, 78);
  assert.match(unpaired.out, /isn't paired/);
  writeFileSync(join(dir, "10and2", "credentials.json"), JSON.stringify({ "http://127.0.0.1:1": "private-token" }), { mode: 0o644 });
  chmodSync(join(dir, "10and2", "credentials.json"), 0o644);
  const open = await cli(["run"], env);
  assert.equal(open.status, 78);
  assert.match(open.out, /mode 0600/);
  assert.ok(!open.out.includes("private-token"));
});
