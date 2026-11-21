import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Credentials, parseCredential, powershellArgs, type Runner } from "../src/credential.ts";
import { Expired, linkUrl, originOf, pair } from "../src/pair.ts";
import { carried, launchAgent, launchFor, NO_SYSTEMD, Service, systemdUnit, temporary } from "../src/service.ts";
import { assertPrivate, removeDir, WINDOWS } from "./fixtures/platform.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const credential = `dc1.${Buffer.from("user_abc123").toString("base64url")}.${"d".repeat(22)}.${"s".repeat(43)}`;

function temp(t: { after: (f: () => void) => void }, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => removeDir(dir));
  return dir;
}

/**
 * A test's environment: this one's (Windows can't run much without SystemRoot and the rest), with nothing of the user's
 * own agents or 10 & 2, no colour (`node --test` forces it at a terminal), and `home` as the home folder (HOME, or
 * USERPROFILE on Windows).
 */
function testEnv(home: string, vars: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(XDG_|CLAUDE_|CODEX_|PI_|T3|OPENCODE|TENANDTWO_|OPENAI_|DRIVER_|FORCE_COLOR$)/i.test(k)) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, ...vars };
}

/** A command on PATH that prints `out`: a shell script, or on Windows a command script as npm writes one, run as Node and its script. */
function fakeCommand(bin: string, name: string, out: string) {
  if (!WINDOWS) return writeFileSync(join(bin, name), `#!/bin/sh\necho ${out}\n`, { mode: 0o755 });
  writeFileSync(join(bin, `${name}.mjs`), `console.log(${JSON.stringify(out)});\n`);
  writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${name}.mjs" %*\r\n`);
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
  assertPrivate(file);
  assert.deepEqual(await broken.load("https://10and2-stg.selfdep.com"), { secret: credential, store: "file" });
  await broken.delete("https://10and2-stg.selfdep.com");
  assert.equal(await broken.load("https://10and2-stg.selfdep.com"), null);
  // Windows has no file modes to check: its profile's own permissions keep the file private.
  if (WINDOWS) return;
  chmodSync(file, 0o644);
  await assert.rejects(broken.load("https://10and2-stg.selfdep.com"), /mode 0600/);
});

test("on Windows the credential is encrypted for the Windows account through Windows PowerShell, the secret only on stdin", async (t) => {
  const dir = temp(t, "creds-win-");
  const calls: { command: string; args: string[]; input?: string }[] = [];
  // DPAPI as a reversible stand-in, so what's kept can be told from the secret: base64 in, base64 out.
  const flip = (b64: string) => Buffer.from(Buffer.from(b64, "base64").map((x) => x ^ 0x5a)).toString("base64");
  const dpapi = (opts: { protect?: boolean; unprotect?: boolean } = {}): Runner => async (command, args, input) => {
    calls.push({ command, args, input });
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    if (/::Protect\(/.test(script)) return opts.protect === false ? null : flip(input!);
    if (/::Unprotect\(/.test(script)) return opts.unprotect === false ? null : flip(input!);
    return null;
  };
  const env = { XDG_CONFIG_HOME: dir, SystemRoot: "D:\\Win" };
  const origin = "https://10and2.selfdep.com";
  const file = join(dir, "10and2", "credentials.json");
  const win = new Credentials({ runner: dpapi(), platform: "win32", env });
  assert.equal(await win.save(origin, credential), "dpapi");
  const kept = JSON.parse(readFileSync(file, "utf8"))[origin] as string;
  assert.match(kept, /^dpapi:[A-Za-z0-9+/]+=*$/);
  assert.ok(!kept.includes(credential) && !kept.includes(Buffer.from(credential).toString("base64")), "never kept as it is");
  assert.deepEqual(await win.load(origin), { secret: credential, store: "dpapi" });
  for (const c of calls) {
    assert.equal(c.command, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.ok(!c.args.some((a) => a.includes(credential) || a.includes(Buffer.from(credential).toString("base64"))), "the secret is never an argument");
    assert.ok(c.args.every((a) => !Buffer.from(a, "base64").toString("utf16le").includes(credential)), "nor inside the script");
  }
  assert.ok(calls.some((c) => c.input === Buffer.from(credential).toString("base64")), "it goes on stdin");
  assert.deepEqual(powershellArgs("Protect"), calls[0].args);
  await win.delete(origin);
  assert.equal(await win.load(origin), null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});

  // Where PowerShell can't (Constrained Language Mode), or what it encrypts won't decrypt, the plain file instead.
  assert.equal(await new Credentials({ runner: async () => null, platform: "win32", env }).save(origin, credential), "file");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[origin], credential);
  assert.deepEqual(await new Credentials({ runner: async () => null, platform: "win32", env }).load(origin), { secret: credential, store: "file" });
  assert.equal(await new Credentials({ runner: dpapi({ unprotect: false }), platform: "win32", env }).save(origin, credential), "file");
  // A key encrypted for another account (a copied profile) can't be read: as good as none, so setup pairs again.
  await win.save(origin, credential);
  assert.equal(await new Credentials({ runner: dpapi({ unprotect: false }), platform: "win32", env }).load(origin), null);
  // TENANDTWO_CREDENTIAL_STORE=file never asks PowerShell, and reads what's kept plainly.
  calls.length = 0;
  const plain = new Credentials({ runner: dpapi(), platform: "win32", env: { ...env, TENANDTWO_CREDENTIAL_STORE: "file" } });
  assert.equal(await plain.save("http://127.0.0.1:8790", "a-token"), "file");
  assert.deepEqual(await plain.load("http://127.0.0.1:8790"), { secret: "a-token", store: "file" });
  assert.equal(calls.length, 0);
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

test("login services run what they're given with setup's PATH, and don't restart a revoked connector", () => {
  const l = { program: ["/usr/bin/node", "/opt/10and2 app/dist/10and2.js"], path: "/usr/local/bin:/usr/bin" };
  const unit = systemdUnit(l);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/opt\/10and2 app\/dist\/10and2.js" run --wait-for-credential$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/local\/bin:\/usr\/bin$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  const plist = launchAgent(l, "/Users/x/Library/Logs/10and2.log");
  assert.match(plist, /<string>--fatal-exit=0<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<string>\/opt\/10and2 app\/dist\/10and2.js<\/string>/);
});

// macOS's and Linux's login services; Windows' entry runs `10and2` from the PATH at sign-in instead (service.ts runEntry).
test("a login service runs the 10and2 on PATH when it's this install, by the path PATH names (npm, Nix), else this node and script", { skip: WINDOWS && "macOS's and Linux's login services" }, (t) => {
  // Resolved: macOS's temporary folder is a link (/var to /private/var), and launchFor names resolved paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (p: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/usr/bin/env node\n"); chmodSync(p, 0o755); return p; };
  // npm: <prefix>/bin/10and2 links to the package's bin/10and2.js; the script is that link as run.
  const prefix = join(root, "npm");
  file(join(prefix, "lib/node_modules/10and2/bin/10and2.js"));
  mkdirSync(join(prefix, "bin"));
  symlinkSync("../lib/node_modules/10and2/bin/10and2.js", join(prefix, "bin/10and2"));
  assert.deepEqual(launchFor(join(prefix, "bin/10and2"), "/nix/store/x-node/bin/node", { PATH: `/nowhere:${join(prefix, "bin")}` }),
    { program: [join(prefix, "bin/10and2")], path: `/nowhere:${join(prefix, "bin")}`, env: {}, left: [] });
  // Nix: the profile's bin/10and2 links to <out>/bin/10and2, a wrapper running <out>/lib/10and2/dist/10and2.js.
  const out = join(root, "store/abc-10and2-0.10.1");
  file(join(out, "bin/10and2"));
  const bundle = file(join(out, "lib/10and2/dist/10and2.js"));
  mkdirSync(join(root, "profile/bin"), { recursive: true });
  symlinkSync(join(out, "bin/10and2"), join(root, "profile/bin/10and2"));
  assert.deepEqual(launchFor(bundle, "/x/node", { PATH: join(root, "profile/bin") }).program, [join(root, "profile/bin/10and2")]);
  // Another install's 10and2 on PATH, or none: this node and this script, resolved.
  assert.deepEqual(launchFor(bundle, "/x/node", { PATH: join(prefix, "bin") }).program, ["/x/node", bundle]);
  assert.deepEqual(launchFor(join(prefix, "bin/10and2"), "/x/node", { PATH: "/nowhere" }).program, ["/x/node", join(prefix, "lib/node_modules/10and2/bin/10and2.js")]);
});

test("login services get setup's agent folders, Node's certificates and proxy, never a proxy password", () => {
  const env = {
    PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/work-claude", CODEX_HOME: "/home/u/.codex-work", XDG_STATE_HOME: "/home/u/state",
    NODE_EXTRA_CA_CERTS: "/etc/corp/ca.pem", HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "localhost,.corp", http_proxy: "http://jane:s3cret@proxy.corp:3128",
    OPENAI_API_KEY: "sk-nope", TENANDTWO_TOKEN: "nope", HOME: "/home/u", T3CODE_HOME: "~/t3 100%",
  };
  const { env: vars, left } = carried(env);
  assert.deepEqual(left, ["http_proxy"]);
  assert.deepEqual(Object.keys(vars).sort(), ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "T3CODE_HOME", "XDG_STATE_HOME"]);
  const l = { program: ["/usr/bin/10and2"], path: "/usr/bin", env: vars };
  const unit = systemdUnit(l);
  assert.match(unit, /^Environment=CLAUDE_CONFIG_DIR=\/home\/u\/work-claude$/m);
  assert.match(unit, /^Environment=HTTPS_PROXY=http:\/\/proxy.corp:3128$/m);
  assert.match(unit, /^Environment="T3CODE_HOME=~\/t3 100%%"$/m, "systemd's specifiers escaped");
  assert.doesNotMatch(unit, /sk-nope|s3cret|TENANDTWO_TOKEN/);
  const plist = launchAgent(l, "/l");
  assert.match(plist, /<key>NODE_EXTRA_CA_CERTS<\/key><string>\/etc\/corp\/ca.pem<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin<\/string>/);
  assert.doesNotMatch(plist, /sk-nope|s3cret/);
});

test("fnm's per-terminal folder is written as fnm's default alias, Volta's shim is kept, and npx's copy is temporary", { skip: WINDOWS && "macOS's and Linux's login services" }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managers-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (p: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/usr/bin/env node\n"); chmodSync(p, 0o755); return p; };
  // fnm: /run/user/…/fnm_multishells/<pid>/ links to one Node's installation; aliases/default links to the same one.
  const fnm = join(root, "fnm"), install = join(fnm, "node-versions/v24.1.0/installation");
  const script = file(join(install, "lib/node_modules/10and2/bin/10and2.js"));
  mkdirSync(join(install, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/10and2/bin/10and2.js", join(install, "bin/10and2"));
  mkdirSync(join(root, "run/fnm_multishells"), { recursive: true });
  const shell = join(root, "run/fnm_multishells/123_456");
  symlinkSync(install, shell);
  mkdirSync(join(fnm, "aliases"), { recursive: true });
  symlinkSync(install, join(fnm, "aliases/default"));
  const l = launchFor(join(shell, "bin/10and2"), join(shell, "bin/node"), { PATH: `${join(shell, "bin")}:/usr/bin`, FNM_DIR: fnm });
  assert.deepEqual(l.program, [join(fnm, "aliases/default/bin/10and2")]);
  assert.equal(l.path, `${join(fnm, "aliases/default/bin")}:/usr/bin`);
  assert.equal(l.env?.FNM_DIR, undefined, "FNM_DIR isn't carried: nothing in the service reads it");
  // Without the alias (another default), that Node's own folder, which outlives the terminal.
  assert.deepEqual(launchFor(script, "/x/node", { PATH: join(shell, "bin") }).program, [join(install, "bin/10and2")]);
  // Volta: ~/.volta/bin/10and2 links to volta-shim, which runs the package Volta keeps under tools/image/packages.
  const volta = join(root, ".volta");
  file(join(volta, "bin/volta-shim"));
  symlinkSync("volta-shim", join(volta, "bin/10and2"));
  const voltaScript = file(join(volta, "tools/image/packages/10and2/lib/node_modules/10and2/bin/10and2.js"));
  assert.deepEqual(launchFor(voltaScript, join(volta, "tools/image/node/24.1.0/bin/node"), { PATH: join(volta, "bin") }).program, [join(volta, "bin/10and2")]);
  // npx: its cache isn't somewhere a login service can rely on.
  const npx = file(join(root, ".npm/_npx/8a1f/node_modules/10and2/bin/10and2.js"));
  const viaNpx = launchFor(npx, "/usr/bin/node", { PATH: `${join(root, ".npm/_npx/8a1f/node_modules/.bin")}:/usr/bin` });
  assert.equal(temporary(viaNpx), true);
  assert.equal(viaNpx.path, "/usr/bin");
  assert.match(new Service({ platform: "linux", env: {} }).unavailable(viaNpx) ?? "", /npm i -g 10and2/);
});

test("on Linux, lingering is turned on for a login with no desktop, said when refused, and turned off again with the last service", { skip: WINDOWS && "a systemctl found on a Unix PATH" }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "linger-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "");
  chmodSync(join(bin, "systemctl"), 0o755);
  const calls: string[] = [];
  let linger = "no", allowed = true;
  const runner: Runner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "loginctl" && args[0] === "show-user") return `${linger}\n`;
    if (command === "loginctl" && args[0] === "enable-linger") { if (!allowed) return null; linger = "yes"; return ""; }
    if (command === "loginctl" && args[0] === "disable-linger") { linger = "no"; return ""; }
    if (args.includes("is-active")) return "active\n";
    return "";
  };
  const env = { PATH: bin, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: "/run/user/1", SSH_CONNECTION: "1 2 3 4", TENANDTWO_SYSTEMD_DIR: home };
  const l = { program: ["/usr/bin/10and2"], path: "/usr/bin" };
  const s = await new Service({ platform: "linux", home, env, runner, sleep: async () => {} }).install(l);
  assert.match(s.note ?? "", /Keeps running after you log out/);
  assert.equal(linger, "yes");
  // Already on: nothing said, nothing changed.
  assert.equal((await new Service({ platform: "linux", home, env, runner, sleep: async () => {} }).install(l)).note, undefined);
  // The brain's service is still there: lingering stays on until it goes too.
  writeFileSync(join(home, ".config/systemd/user/10and2-brain.service"), "");
  await new Service({ platform: "linux", home, env, runner, sleep: async () => {} }).uninstall();
  assert.equal(linger, "yes");
  rmSync(join(home, ".config/systemd/user/10and2-brain.service"));
  await new Service({ platform: "linux", home, env, runner, sleep: async () => {} }).uninstall();
  assert.equal(linger, "no");
  // Refused: what to run.
  allowed = false;
  const refused = await new Service({ platform: "linux", home, env, runner, sleep: async () => {} }).install(l);
  assert.match(refused.note ?? "", /sudo loginctl enable-linger \S+/);
  // With a desktop it's left alone, as a LaunchAgent stops at logout too.
  calls.length = 0;
  await new Service({ platform: "linux", home, env: { ...env, SSH_CONNECTION: undefined, WAYLAND_DISPLAY: "wayland-0" }, runner, sleep: async () => {} }).install(l);
  assert.ok(!calls.some((c) => c.startsWith("loginctl")));
  // No systemd: said before anything is written, with what to do instead.
  const none = new Service({ platform: "linux", home, env: { ...env, TENANDTWO_SYSTEMD_DIR: join(home, "nowhere") }, runner });
  assert.equal(none.unavailable(l), NO_SYSTEMD);
  await assert.rejects(none.install(l), /doesn't run systemd/);
});

test("a login service whose program is gone is stale (systemd and launchd), and one whose program is there isn't", (t) => {
  const home = mkdtempSync(join(tmpdir(), "stale-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const real = join(home, "10and2 real");
  writeFileSync(real, "");
  const linux = new Service({ platform: "linux", home, env: { XDG_CONFIG_HOME: join(home, ".config") }, runner: async () => "" });
  const unit = join(home, ".config/systemd/user/10and2.service");
  mkdirSync(join(unit, ".."), { recursive: true });
  assert.equal(linux.program(), null);
  assert.equal(linux.missing(), null, "nothing installed isn't stale");
  writeFileSync(unit, systemdUnit({ program: [real], path: "/usr/bin" }));
  assert.deepEqual(linux.program(), [real, "run", "--wait-for-credential"], "a quoted path read back");
  assert.equal(linux.missing(), null);
  writeFileSync(unit, systemdUnit({ program: ["/home/u/.nvm/versions/node/v24.22.1/bin/10and2"], path: "/usr/bin" }));
  assert.equal(linux.missing(), "/home/u/.nvm/versions/node/v24.22.1/bin/10and2");
  const mac = new Service({ platform: "darwin", home, runner: async () => "" });
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  const plist = join(home, "Library/LaunchAgents/com.selfdeprecated.10and2.plist");
  // Quartz, 20 November: the Node it ran was still there, the script gone.
  writeFileSync(plist, launchAgent({ program: [real, "/nix/store/gone-10and2-0.2.0/lib/10and2/10and2.js"], path: "/usr/bin" }, "/l"));
  assert.deepEqual(mac.program(), [real, "/nix/store/gone-10and2-0.2.0/lib/10and2/10and2.js", "run", "--fatal-exit=0"]);
  assert.equal(mac.missing(), "/nix/store/gone-10and2-0.2.0/lib/10and2/10and2.js");
  writeFileSync(plist, launchAgent({ program: [real], path: "/usr/bin" }, "/l"));
  assert.equal(mac.missing(), null);
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

test("setup refuses an address given as a word or a mistyped flag before pairing anywhere; every command refuses what it wouldn't read", async (t) => {
  const dir = temp(t, "setup-stray-");
  const env = testEnv(dir, { PATH: join(dir, "nonexistent"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1" });
  const run = await cli(["setup", "10and2-stg.selfdep.com", "--no-autostart"], env);
  assert.notEqual(run.status, 0);
  assert.match(run.out, /10and2 setup --brain=10and2-stg\.selfdep\.com/);
  assert.ok(!existsSync(join(dir, "config", "10and2", "credentials.json")), "nothing paired");
  const typo = await cli(["setup", "--brian=10and2-stg.selfdep.com", "--no-autostart"], env);
  assert.equal(typo.status, 64);
  assert.match(typo.out, /no --brian/);
  assert.ok(!existsSync(join(dir, "config", "10and2", "credentials.json")), "a mistyped flag pairs nothing either");
  const extra = await cli(["status", "now"], env);
  assert.equal(extra.status, 64);
  assert.match(extra.out, /doesn't take "now"/);
  assert.match((await cli(["setup", "--brain=x", "--help"], env)).out, /10and2 setup/, "help still wins");
});

test("setup pairs in the browser, keeps the credential private, writes a policy; status shows it; revoke undoes it", async (t) => {
  const dir = temp(t, "setup-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  fakeCommand(bin, "t3", "1.0");
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
  const env = testEnv(dir, { PATH: bin, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude"), TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1" });

  const setup = await cli(["setup", `--brain=${origin}`, "--name=testbox", "--no-autostart"], env);
  assert.equal(setup.status, 0, setup.out);
  assert.match(setup.out, /ABCD-EFGH/);
  assert.ok(!setup.out.includes(credential), "the credential is never printed");
  assert.match(seen[0].body, /"name":"testbox"/);
  const creds = join(dir, "config", "10and2", "credentials.json");
  assertPrivate(creds);
  assert.equal(JSON.parse(readFileSync(creds, "utf8"))[origin], credential);
  const policy = JSON.parse(readFileSync(join(dir, "config", "10and2", "connector.json"), "utf8"));
  assert.deepEqual(policy, { brain: `${origin.replace("http", "ws")}/connector`, projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], steer: true, answer: true, maxRuntimeMode: "full-access", agents: { claude: false, codex: false, pi: false, opencode: false, gemini: false, copilot: false, t3: true }, worktreeBase: "main" });

  const again = await cli(["setup", "--no-autostart"], env);
  assert.equal(again.status, 0);
  assert.match(again.out, /already connected/);
  assert.equal(seen.filter((s) => s.path === "/connector/pair").length, 1);

  const status = await cli(["status"], env);
  assert.match(status.out, /Not running/);
  assert.match(status.out, /Sees +every project in T3 Code/);
  assert.match(status.out, /T3 Code +on +follow up · steer · answer · start · tidy/);
  assert.match(status.out, /Claude Code +off/);
  assert.match(status.out, /New work runs with at most full access/);
  assert.match(status.out, /New T3 Code worktrees start from the latest main on origin/);
  assert.doesNotMatch(status.out, /brain/i, "no internals in what people read");
  assert.ok(!status.out.includes(credential));
  const verbose = await cli(["status", "--verbose"], env);
  assert.match(verbose.out, /device d{22} of user_abc123/);
  assert.ok(!verbose.out.includes(credential));

  const narrowed = await cli(["agents", "--no-steer", "--no-start=t3", "--yes"], env);
  assert.equal(narrowed.status, 0, narrowed.out);
  assert.match(narrowed.out, /can follow up, answer questions, start new work, settle, snooze and archive/);
  assert.match(narrowed.out, /For T3 Code: no new work\./);
  const chosen = JSON.parse(readFileSync(join(dir, "config", "10and2", "connector.json"), "utf8"));
  assert.equal(chosen.steer, false);
  assert.deepEqual(chosen.agents.t3, { actions: ["follow_up", "settle", "snooze", "archive"] });
  assert.equal(chosen.brain, policy.brain, "choosing again keeps the rest");
  assert.equal(chosen.worktreeBase, "main");
  const none = await cli(["agents", "--off=t3", "--yes"], env);
  assert.notEqual(none.status, 0);
  assert.match(none.out, /Every coding agent is switched off/);
  assert.equal(JSON.parse(readFileSync(join(dir, "config", "10and2", "connector.json"), "utf8")).steer, false, "nothing is saved");

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
  const s = await service.install({ program: ["/usr/bin/node", "/opt/10and2.js"], path: "/usr/bin" });
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
  const env = testEnv(dir, { PATH: join(dir, "nonexistent"), XDG_CONFIG_HOME: dir, XDG_STATE_HOME: join(dir, "state"), TENANDTWO_CREDENTIAL_STORE: "file" });
  const unpaired = await cli(["run"], env);
  assert.equal(unpaired.status, 78);
  assert.match(unpaired.out, /isn't paired/);
  // Windows has no file modes to check: its profile's own permissions keep the file private.
  if (WINDOWS) return;
  writeFileSync(join(dir, "10and2", "credentials.json"), JSON.stringify({ "http://127.0.0.1:1": "private-token" }), { mode: 0o644 });
  chmodSync(join(dir, "10and2", "credentials.json"), 0o644);
  const open = await cli(["run"], env);
  assert.equal(open.status, 78);
  assert.match(open.out, /mode 0600/);
  assert.ok(!open.out.includes("private-token"));
});

test("uninstall removes everything 10and2 added, and leaves what isn't its own", async (t) => {
  const dir = temp(t, "uninstall-");
  const claude = join(dir, "claude"), pi = join(dir, "pi");
  const env = testEnv(dir, { PATH: join(dir, "nonexistent"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CONFIG_DIR: claude, PI_CODING_AGENT_DIR: pi, TENANDTWO_CREDENTIAL_STORE: "file", TENANDTWO_NO_SERVICE: "1", TENANDTWO_COMMAND: "10and2" });
  mkdirSync(claude, { recursive: true });
  // The user's own hook, beside 10and2's, stays.
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  for (const args of [["hooks", "install"], ["pi", "install"], ["opencode", "install"]]) assert.equal((await cli(args, env)).status, 0, args.join(" "));
  mkdirSync(join(dir, "config", "10and2"), { recursive: true });
  writeFileSync(join(dir, "config", "10and2", "connector.json"), JSON.stringify({ brain: "wss://127.0.0.1:1/connector", projects: "*" }));
  mkdirSync(join(dir, "state", "10and2"), { recursive: true });
  const run = await cli(["uninstall", "--yes"], env);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /Removed its Claude Code hooks[\s\S]*Removed its Pi extension[\s\S]*Removed its OpenCode plugin[\s\S]*Deleted its settings and files[\s\S]*npm uninstall -g 10and2/);
  const settings = readFileSync(join(claude, "settings.json"), "utf8");
  assert.doesNotMatch(settings, /10and2-hook/);
  assert.match(settings, /say done/);
  assert.equal(existsSync(join(pi, "extensions", "10and2.ts")), false);
  assert.equal(existsSync(join(dir, "config", "opencode", "plugins", "10and2.js")), false);
  assert.equal(existsSync(join(dir, "config", "10and2")), false);
  assert.equal(existsSync(join(dir, "state", "10and2")), false);
  // Again, there's nothing left to remove, and it says only how to remove the program.
  const again = await cli(["uninstall", "--yes"], env);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.out, /Removed/);
});
