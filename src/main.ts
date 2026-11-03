#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// 10and2: the connector. Credentials and backend code live here, on the machine doing the work; the brain holds only
// a hash of this machine's credential.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Credentials, installed, parseCredential, type Store } from "./credential.ts";
import { Ledger } from "./ledger.ts";
import { Link } from "./link.ts";
import { Local } from "./local.ts";
import { Expired, linkUrl, originOf, pair } from "./pair.ts";
import { configDirectory, hookSocket, stateDirectory } from "./paths.ts";
import { defaultPolicyPath, loadPolicy, parsePolicy, visible } from "./policy.ts";
import { ACTIONS, VERSION } from "./protocol.ts";
import { Service } from "./service.ts";
import { T3Adapter } from "./t3/adapter.ts";
import { ClaudeAdapter, hooksStatus, installHooks, relayHook, uninstallHooks } from "./claude/index.ts";
import { describe } from "./util.ts";
import { accent, ago, ask, bad, bold, Cancelled, cmd, confirm, dim, keys, note, ok, say, spinner, warn } from "./ui.ts";

const DEFAULT_ORIGIN = "https://10and2.selfdep.com";
const usage = () => `${bold("10and2")} ${VERSION} ${dim("·")} connects this computer's coding agents (T3 Code, Claude Code) to 10 & 2

  ${cmd("10and2 setup")}     connect this computer (opens your browser to approve it)
  ${cmd("10and2 status")}    whether it's connected, and what Driver can see and do here
  ${cmd("10and2 revoke")}    disconnect this computer

More
  ${cmd("10and2 autostart on|off|status")}     start at login
  ${cmd("10and2 hooks install|uninstall|status")}  Claude Code sessions update instantly
  ${cmd("10and2 run")}                         run in this terminal instead of at login
  ${cmd("10and2 token")}                       a token, for a self-hosted setup

Setup options: --name=<what Driver calls it>  --yes  --no-autostart  --brain=<url>
Settings: ${defaultPolicyPath()}`;

const argv = process.argv.slice(2);
const flags = new Map(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.length ? v.join("=") : "true"] as const; }));
const [command, sub] = argv.filter((a) => !a.startsWith("--"));
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const statusFile = () => join(stateDirectory(), "status.json");
const fail = (s: string, code = 1) => { console.error(s); process.exitCode = code; };
/** The default account's host is left out of what's shown: it's the only one most people ever use. */
const hostOf = (origin: string) => new URL(origin).host;
const account = (origin: string) => origin === DEFAULT_ORIGIN ? "your 10 & 2 account" : `your 10 & 2 account at ${hostOf(origin)}`;

try {
  switch (command) {
    case "setup": await setup(); break;
    case "run": await runConnector(); break;
    case "status": await status(); break;
    case "revoke": await revoke(); break;
    case "autostart": await autostart(); break;
    case "hook": await relayHook(process.stdin, hookSocket()); break; // Claude Code runs this; it must stay silent
    case "hooks": await hooks(); break;
    case "token": {
      const token = randomBytes(32).toString("base64url");
      say(`TENANDTWO_TOKEN=${token}\ntokenSha256=${createHash("sha256").update(token).digest("hex")}`);
      break;
    }
    case "version": case "-v": say(VERSION); break;
    case undefined: case "help": case "-h":
      if (flags.has("version")) say(VERSION);
      else if (command === undefined && !flags.has("help") && !readPolicyFile()) say(`${usage()}\n\nNot connected yet: start with ${cmd("10and2 setup")}.`);
      else say(usage());
      break;
    default: fail(`There's no "${command}" command. ${cmd("10and2 help")} lists them.`, 64);
  }
} catch (e) {
  if (e instanceof Cancelled) fail("Cancelled.", 130);
  else fail(`✗ ${describe(e)}`);
}

function readPolicyFile(): any | null {
  const path = defaultPolicyPath();
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`${path} isn't JSON; fix or remove it, then run setup again.`); }
}
function writePrivate(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function where(s: Store) { return s === "keychain" ? "your login Keychain" : s === "libsecret" ? "your keyring (libsecret)" : `${join(configDirectory(), "credentials.json")} (only you can read it)`; }
function openBrowser(url: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener) return;
  try { spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

async function setup() {
  const existing = readPolicyFile();
  const given = flags.get("brain");
  const origin = given ? originOf(given.includes("://") ? given : `https://${given}`) : existing?.brain ? originOf(existing.brain) : DEFAULT_ORIGIN;
  const creds = new Credentials();
  if (await creds.load(origin)) {
    say(`This computer is already connected to ${account(origin)}.\n`);
    await status();
    say(`\n${cmd("10and2 revoke")} disconnects it, if you want to connect it again.`);
    return;
  }

  say(`${bold("10 & 2")} ${dim("·")} connect this computer\n`);
  const [t3, claudeCli] = await Promise.all([installed(process.env.T3_CLI ?? "t3"), installed("claude")]);
  const claude = claudeCli || existsSync(join(claudeDir(), "projects"));
  if (!t3 && !claude) {
    throw new Error(`Neither T3 Code nor Claude Code is on this computer (no ${cmd("t3")} or ${cmd("claude")} on your PATH), so there's nothing to connect. Install one, then run ${cmd("10and2 setup")} again.`);
  }
  (t3 ? ok : note)(t3 ? "T3 Code" : dim("T3 Code not found"));
  (claude ? ok : note)(claude ? "Claude Code" : dim("Claude Code not found"));

  // A policy the user already has is kept, pointed at this account; a new one lets 10 & 2 see and do everything the
  // spoken readback and "yes" allow, which is what setup promised. Written once the computer is approved.
  const policy = existing ? { ...existing, brain: linkUrl(origin) } : {
    brain: linkUrl(origin), projects: "*", actions: [...ACTIONS], maxRuntimeMode: "full-access", t3, claude,
  };
  parsePolicy(JSON.stringify(policy));

  const wanted = flags.get("name") ?? (flags.has("yes") ? defaultName() : await ask("What should Driver call this computer?", defaultName()));
  // 10 & 2 keeps a machine's name to one word (it's part of every thread's id); say so rather than change it quietly.
  const name = oneWord(wanted);
  if (name !== wanted) say(`    ${dim(`It'll be ${bold(name)}: one word, so it can name your threads.`)}`);
  say();
  const credential = await approve(origin, name);
  const store = await creds.save(origin, credential);
  writePrivate(defaultPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
  ok(`Approved ${dim(`· its key is in ${store === "file" ? "a file only you can read" : where(store)}`)}`);

  const service = new Service();
  let started = false;
  if (!flags.has("no-autostart") && service.supported && await confirm("Keep it connected, starting at login?", true)) {
    const s = await service.install(launch());
    if (s.running) { ok("Starts at login"); started = true; }
    else warn(`Installed at ${s.where}, but it isn't running: see ${s.logs}`);
  }
  if (started) await connected(origin);
  else note(`To connect: ${cmd("10and2 run")} in a terminal you keep open, or ${cmd("10and2 autostart on")}.`);

  say();
  say(`  Driver can see ${seesText(policy)}, and can ${mayText(policy)}: each only after you hear it read back and say yes.`);
  say(`  ${dim(`To change that, edit ${defaultPolicyPath()}, then ${cmd("10and2 autostart on")}.`)}`);
  if (policy.claude) say(`  ${dim(`For Claude Code sessions to update instantly: ${cmd("10and2 hooks install")}.`)}`);
  if (started) say(`\n  ${bold("Next:")} open 10 & 2 on your phone and tap Start.`);
}

function defaultName() { return oneWord(hostname().replace(/\.(local|lan|home)$/i, "")); }
/** As the cloud names machines (cloud/src/links.ts machineName), before it adds a number to a name already taken. */
function oneWord(name: string) { return name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "computer"; }

/** Shows the code, opens the browser and waits for the approval: Enter opens the page again; an expired code can be renewed. */
async function approve(origin: string, name: string): Promise<string> {
  for (;;) {
    const controller = new AbortController();
    let url = "";
    const stopKeys = keys(() => { if (url) openBrowser(url); }, () => controller.abort());
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    let wait: ReturnType<typeof spinner> | undefined;
    try {
      return await pair(origin, { name, platform: process.platform }, {
        signal: controller.signal,
        show: (p) => {
          url = p.verificationUrl;
          say(`  Approve ${bold(name)} in your browser, signed in to 10 & 2:`);
          say(`    ${accent(p.verificationUrl)}`);
          say(`    The page should show the code ${bold(p.userCode)}.\n`);
          openBrowser(p.verificationUrl);
          wait = spinner(`Waiting for you to approve it ${dim(process.stdin.isTTY ? "· Enter opens the page again · Ctrl-C cancels" : "")}`);
        },
      });
    } catch (e) {
      wait?.clear();
      if (controller.signal.aborted) throw new Cancelled();
      if (!(e instanceof Expired)) throw e;
      warn("The code expired before it was approved.");
      if (!await confirm("Get a new code?", true)) throw new Cancelled();
    } finally {
      wait?.clear();
      stopKeys();
      process.off("SIGINT", onSigint);
    }
  }
}

/** Waits for the login service to link, up to 30 s, and says what 10 & 2 can see. */
async function connected(origin: string) {
  const spin = spinner(`Connecting to ${account(origin)}`);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    await new Promise((r) => setTimeout(r, 250));
    const st = readStatus();
    if (st?.linked && Date.parse(st.since ?? "") >= started - 5000 && st.threads !== undefined) { spin.ok(`Connected ${dim("·")} ${sizeText(st)}`); return; }
    if (st?.fatal) { spin.bad(`Couldn't connect: ${st.error}`); return; }
  }
  spin.warn(`Still connecting. ${cmd("10and2 status")} shows how it's going.`);
}

function readStatus(): any {
  try { return JSON.parse(readFileSync(statusFile(), "utf8")); } catch { return null; }
}
function plural(n: number, one: string) { return `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`; }
function sizeText(st: { threads: number; projects: number }) { return `${plural(st.threads, "thread")} in ${plural(st.projects, "project")}`; }
function words(list: string[]) { return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`; }
function seesText(p: any) {
  const where = words([p.t3 !== false && "T3 Code", p.claude && "Claude Code"].filter(Boolean) as string[]);
  const what = p.projects === "*" ? "every project" : Array.isArray(p.projects) && p.projects.length ? `only ${words(p.projects)}` : "no projects";
  return `${what} in ${where}`;
}
function mayText(p: any) {
  const order = ["follow_up", "start_work", "settle", "snooze", "archive"];
  const acts = order.filter((a) => (p.actions ?? []).includes(a)).map((a) => a.replace("_", " "));
  return acts.length ? words(acts) : "only listen in (no changes)";
}

function launch() {
  return { node: process.execPath, script: realpathSync(process.argv[1]), path: process.env.PATH ?? "/usr/bin:/bin" };
}

async function runConnector() {
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
  const fatalExit = Number(flags.get("fatal-exit") ?? 78);
  let state = { pid: process.pid, version: VERSION, startedAt: new Date().toISOString(), brain: "", linked: false, since: null as string | null, error: null as string | null, fatal: false, threads: undefined as number | undefined, projects: undefined as number | undefined };
  const record = (s: Partial<typeof state>) => { state = { ...state, ...s }; try { writePrivate(statusFile(), JSON.stringify(state) + "\n"); } catch { /* status is a convenience */ } };
  let policy;
  try { policy = loadPolicy(); }
  catch (e) { log(`connector: ${describe(e)} (policy: ${defaultPolicyPath()}; run \`10and2 setup\`)`); process.exitCode = fatalExit; return; }
  const origin = originOf(policy.brain);
  record({ brain: origin });
  let token = process.env.TENANDTWO_TOKEN;
  // The login service's way: a start before the keyring opens (boot, with lingering) waits for it instead of giving up.
  const wait = flags.get("wait-for-credential");
  const waitMs = wait === "true" ? 15_000 : Number(wait) * 1000;
  try {
    token ||= (await new Credentials().load(origin))?.secret;
    if (!token && wait) {
      log(`connector: no credential readable for ${origin} yet (is the keyring locked until you log in?); checking every ${waitMs / 1000}s`);
      record({ error: "waiting for the credential (keyring locked?)" });
      while (!token) {
        await new Promise((r) => setTimeout(r, waitMs));
        token = (await new Credentials().load(origin))?.secret;
      }
      log("connector: the credential is readable now");
    }
  }
  catch (e) { log(`connector: ${describe(e)}`); process.exitCode = fatalExit; return; }
  if (!token) { log(`connector: this machine isn't paired with ${origin}. Run \`10and2 setup\`.`); record({ error: "not paired" }); process.exitCode = fatalExit; return; }

  const ledger = new Ledger();
  let link: Link | undefined;
  const stop = (code: number) => { record({ linked: false }); link?.close(); process.exit(code); };
  const t3 = policy.t3
    ? new T3Adapter({
      baseUrl: process.env.T3_URL ?? "http://127.0.0.1:3773", cli: [process.env.T3_CLI ?? "t3"], label: "10and2-connector", log,
      visible: (root) => visible(policy, root), onRevoked: () => { record({ error: "T3 revoked the connector's session" }); stop(fatalExit); },
    })
    : null;
  // Claude Code has no command ids, so a lost outcome is never sent again (the ledger reports it unknown).
  const claude = policy.claude
    ? new ClaudeAdapter({ policy, configDir: claudeDir(), db: join(stateDirectory(), "claude.db"), stateDir: join(stateDirectory(), "claude"), hookSocketPath: hookSocket(), log })
    : null;
  const adapter = new Local([...(t3 ? [{ prefix: "", adapter: t3, retrySafe: true }] : []), ...(claude ? [{ prefix: "claude", adapter: claude }] : [])], policy);
  link = new Link({
    url: policy.brain, token, adapter, ledger, log,
    onFatal: () => { record({ error: "this computer was disconnected (revoked on the website, or set up again elsewhere)", fatal: true }); stop(fatalExit); },
    onView: (n) => record(n),
    onState: (s) => record({ linked: s.linked, ...(s.linked !== state.linked ? { since: new Date().toISOString() } : {}), ...(s.linked ? { error: null } : s.error ? { error: s.error } : {}) }),
  });
  link.start();
  log(`connector ${VERSION}: linking to ${origin}`);
  void t3?.start().catch((e) => { log(`t3: ${describe(e)}; not restarting`); record({ error: `T3 Code: ${describe(e)}` }); stop(fatalExit); });
  void claude?.start().then(() => log("claude: reading sessions"), (e) => log(`claude: ${describe(e)}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    link?.close();
    await adapter.close();
    await ledger.close();
    record({ linked: false });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function status() {
  const policyFile = readPolicyFile();
  if (!policyFile) { say(`Not connected yet. ${cmd("10and2 setup")} connects this computer.`); return; }
  let policy;
  try { policy = parsePolicy(JSON.stringify(policyFile)); } catch (e) { bad(describe(e)); process.exitCode = 1; return; }
  const origin = originOf(policy.brain);
  const cred = await new Credentials().load(origin).catch((e) => { bad(describe(e)); return null; });
  const token = !cred && process.env.TENANDTWO_TOKEN;
  const service = new Service();
  const s = await service.state();
  const st = readStatus();
  const alive = st?.pid ? (() => { try { process.kill(st.pid, 0); return true; } catch { return false; } })() : false;

  if (!cred && !token) bad(`Not connected to ${account(origin)}: ${cmd("10and2 setup")} connects it.`);
  else if (!alive) bad(`Not running. ${s.installed ? `It should start at login; see ${s.logs}` : `${cmd("10and2 autostart on")} keeps it running.`}`);
  else if (st.linked) ok(`Connected to ${account(origin)} ${dim(`· ${Date.now() - Date.parse(st.since) < 10_000 ? "just now" : `for ${ago(st.since)}`}`)}${st.threads !== undefined ? ` ${dim("·")} ${sizeText(st)}` : ""}`);
  else warn(`Connecting to ${account(origin)}${st.error ? `: ${st.error}` : ""}`);
  if (cred || token) {
    if (s.installed) (s.running ? ok : warn)(s.running ? "Starts at login" : `Starts at login, but isn't running: see ${s.logs}`);
    else if (alive) note(dim(`Doesn't start at login (${cmd("10and2 autostart on")})`));
  }
  say();
  note(`Sees   ${seesText(policy)}`);
  note(`Can    ${mayText(policy)}, after your spoken yes`);
  if (policy.actions.includes("start_work")) note(`       New work runs with at most ${policy.maxRuntimeMode}`);
  if (policy.claude) {
    const h = await hooksStatus(claudeDir()).catch(() => null);
    if (!h?.installed) note(dim(`Claude Code updates within seconds; ${cmd("10and2 hooks install")} makes it instant`));
    const db = join(stateDirectory(), "claude.db");
    if (existsSync(db)) {
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        const runs = conn.prepare("SELECT sessionId, pid FROM claude_runs WHERE pid IS NOT NULL").all() as { sessionId: string; pid: number }[];
        const live = runs.filter((r) => { try { process.kill(r.pid, 0); return true; } catch { return false; } });
        if (live.length) note(`Claude Code runs Driver started, still going: ${live.map((r) => `${r.sessionId} (pid ${r.pid})`).join(", ")}`);
      } catch { /* an older or empty database */ } finally { conn.close(); }
    }
  }
  note(dim(`Settings ${defaultPolicyPath()}`));
  if (flags.has("verbose")) {
    const device = cred ? parseCredential(cred.secret) : null;
    note(dim(`Key in ${cred ? where(cred.store) : "TENANDTWO_TOKEN"}${device ? `, device ${device.deviceId} of ${device.userId}` : ""}`));
    note(dim(`Link ${policy.brain}${st?.pid ? `, pid ${st.pid}, version ${st.version}` : ""}`));
  }
}

async function revoke() {
  const policy = readPolicyFile();
  const origin = policy?.brain ? originOf(policy.brain) : DEFAULT_ORIGIN;
  const creds = new Credentials();
  const cred = await creds.load(origin).catch(() => null);
  if (!cred) say(`This computer isn't connected to ${account(origin)}.`);
  if (cred && !flags.has("yes") && !await confirm(`Disconnect this computer from ${account(origin)}?`, true)) throw new Cancelled();
  if (cred) {
    const spin = spinner("Disconnecting");
    try {
      const res = await fetch(`${origin}/connector/revoke`, { method: "POST", headers: { authorization: `Bearer ${cred.secret}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok || res.status === 401) spin.ok(`Disconnected from ${account(origin)}`);
      else spin.warn(`10 & 2 didn't confirm it (error ${res.status}): remove this computer on your account page too`);
    } catch { spin.warn(`Couldn't reach ${hostOf(origin)}: remove this computer on your account page too`); }
  }
  await new Service().uninstall();
  await creds.delete(origin);
  rmSync(statusFile(), { force: true });
  if (cred) ok(`Forgot its key, and it no longer starts at login ${dim(`· your settings stay in ${defaultPolicyPath()}`)}`);
}

async function autostart() {
  const service = new Service();
  if (sub === "on") {
    const s = await service.install(launch());
    if (!s.running) { warn(`Installed at ${s.where}, but not running: see ${s.logs}`); return; }
    ok("Starts at login, and (re)started now");
    const policy = readPolicyFile();
    if (policy?.brain) await connected(originOf(policy.brain));
  }
  else if (sub === "off") { await service.uninstall(); ok("Stopped, and no longer starts at login"); }
  else if (sub === "status" || sub === undefined) { const s = await service.state(); say(s.installed ? `${s.running ? "Running" : "Not running"}; starts at login ${dim(`(${s.where})`)}.` : "Doesn't start at login."); }
  else throw new Error(`${cmd("10and2 autostart")} takes on, off or status.`);
}

async function hooks() {
  // Hooks edit the user's own Claude Code settings, so they're only ever installed or removed when asked. The command is
  // found on PATH, so an upgrade doesn't leave hooks pointing at an old copy.
  const hookCommand = process.env.TENANDTWO_COMMAND || "10and2";
  if (sub === "install") await installHooks(claudeDir(), hookCommand);
  else if (sub === "uninstall") await uninstallHooks(claudeDir());
  else if (sub !== "status") throw new Error(`${cmd("10and2 hooks")} takes install, uninstall or status.`);
  const s = await hooksStatus(claudeDir());
  say(s.installed ? `10and2's Claude Code hooks are installed in ${claudeDir()}.` : s.events.length ? `Some of 10and2's Claude Code hooks are installed: ${s.events.join(", ")}.` : `10and2's Claude Code hooks aren't installed in ${claudeDir()}.`);
}
