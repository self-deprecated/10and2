#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// 10and2: the connector. Credentials and backend code live here, on the machine doing the work; the brain holds only
// a hash of this machine's credential.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Credentials, installed, parseCredential, run as runCommand, type Store } from "./credential.ts";
import { Ledger } from "./ledger.ts";
import { Link } from "./link.ts";
import { Local } from "./local.ts";
import { Expired, linkUrl, originOf, pair } from "./pair.ts";
import { configDirectory, hookSocket, stateDirectory } from "./paths.ts";
import { addMachine, brainDb, brainEnvPath, brainOrigin, brainPort, DEFAULT_PORT, machines, readBrainEnv, removeMachine, validName, writeBrainEnv } from "./brain.ts";
import { defaultPolicyPath, loadPolicy, parsePolicy, visible } from "./policy.ts";
import { ACTIONS, VERSION } from "./protocol.ts";
import { BRAIN, Service } from "./service.ts";
import { T3Adapter } from "./t3/adapter.ts";
import { ClaudeAdapter, hooksStatus, installHooks, relayHook, uninstallHooks } from "./claude/index.ts";
import { describe } from "./util.ts";
import { accent, ago, ask, bad, bold, Cancelled, cmd, confirm, dim, keys, note, ok, say, secret, spinner, warn } from "./ui.ts";

const DEFAULT_ORIGIN = "https://10and2.selfdep.com";
/** Someone running their own brain needs to know which key to make (Jordan, 5 Nov: the CLI may say OpenAI). */
const OWN_KEY = "your OpenAI key"; // provider-name-ok: see above
const usage = () => `${bold("10and2")} ${VERSION} ${dim("·")} connects this computer's coding agents (T3 Code, Claude Code) to 10 & 2

  ${cmd("10and2 setup")}     connect this computer (opens your browser to approve it)
  ${cmd("10and2 status")}    whether it's connected, and what Driver can see and do here
  ${cmd("10and2 revoke")}    disconnect this computer

More
  ${cmd("10and2 autostart on|off|status")}     start at login
  ${cmd("10and2 hooks install|uninstall|status")}  Claude Code sessions update instantly
  ${cmd("10and2 run")}                         run in this terminal instead of at login
  ${cmd("10and2 token")}                       a token, for a brain you configure by hand

Setup options: --name=<what Driver calls it>  --yes  --no-autostart  --brain=<url>  --token (a brain of your own)
Settings: ${defaultPolicyPath()}

Your own brain ${dim(`(instead of your 10 & 2 account: ${OWN_KEY}, your computer)`)}
  ${cmd("10and2 brain setup")}                 run Driver's brain on this computer ${dim("(--port=8790)")}
  ${cmd("10and2 brain status")}                whether it's running, and which computers it accepts
  ${cmd("10and2 brain add <name> <hash>")}     accept another computer ${dim("(set up there with --brain=<address> --token)")}
  ${cmd("10and2 brain remove <name>")}         stop accepting a computer
  ${cmd("10and2 brain autostart on|off|status")}
  ${cmd("10and2 brain run")}                   run it in this terminal instead of at login`;

const argv = process.argv.slice(2);
const flags = new Map(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.length ? v.join("=") : "true"] as const; }));
const positional = argv.filter((a) => !a.startsWith("--"));
const [command, sub] = positional;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const statusFile = () => join(stateDirectory(), "status.json");
const fail = (s: string, code = 1) => { console.error(s); process.exitCode = code; };
/** The default account's host is left out of what's shown: it's the only one most people ever use. */
const hostOf = (origin: string) => new URL(origin).host;
/** A key from pairing with a 10 & 2 account; a brain of your own takes a plain token instead (`--token`, `brain setup`). */
const paired = (secret: string | undefined) => secret === undefined || parseCredential(secret) !== null;
/** What this computer is connected to, given its key when there is one. */
const account = (origin: string, secret?: string) => !paired(secret) ? `your brain at ${hostOf(origin)}`
  : origin === DEFAULT_ORIGIN ? "your 10 & 2 account" : `your 10 & 2 account at ${hostOf(origin)}`;

// `--help` or `-h` anywhere only prints the help: `10and2 setup --help` must never start a pairing.
const wantsHelp = command !== "hook" && (flags.has("help") || argv.includes("-h"));

try {
  switch (wantsHelp ? "help" : command) {
    case "setup": await setup(); break;
    case "run": await runConnector(); break;
    case "status": await status(); break;
    case "revoke": await revoke(); break;
    case "autostart": await autostart(); break;
    case "hook": await relayHook(process.stdin, hookSocket()); break; // Claude Code runs this; it must stay silent
    case "hooks": await hooks(); break;
    case "brain": await brain(); break;
    case "token": {
      const token = randomBytes(32).toString("base64url");
      say(`TENANDTWO_TOKEN=${token}\ntokenSha256=${sha256(token)}`);
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
  // A brain of your own has no website to approve this computer on: it accepts a token's hash instead.
  const byToken = flags.has("token");
  if (byToken && !given) throw new Error(`${cmd("--token")} is for a brain you run yourself: give its address too, ${cmd("--brain=https://…")}.`);
  const origin = given ? originOf(given.includes("://") ? given : `https://${given}`) : existing?.brain ? originOf(existing.brain) : DEFAULT_ORIGIN;
  const creds = new Credentials();
  const had = await creds.load(origin);
  if (had) {
    say(`This computer is already connected to ${account(origin, had.secret)}.\n`);
    await status();
    say(`\n${cmd("10and2 revoke")} disconnects it, if you want to connect it again.`);
    return;
  }

  say(`${bold("10 & 2")} ${dim("·")} connect this computer\n`);
  const policy = policyFor(origin, existing, await agents("10and2 setup"));
  const name = await machineName();
  if (byToken && !validName(name)) throw new Error(`Your brain can't call it "${name}": start with a letter or digit (${cmd("--name=")}).`);
  say();
  const credential = byToken ? randomBytes(32).toString("base64url") : await approve(origin, name);
  const store = await creds.save(origin, credential);
  writePrivate(defaultPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
  if (byToken) {
    ok(`Made its key ${dim(`· in ${store === "file" ? "a file only you can read" : where(store)}`)}`);
    say(`\n  On your brain's computer, run this so it accepts this one:`);
    say(`    ${cmd(`10and2 brain add ${name} ${sha256(credential)}`)}\n`);
  } else ok(`Approved ${dim(`· its key is in ${store === "file" ? "a file only you can read" : where(store)}`)}`);

  const started = await startAtLogin(new Service(), "Keep it connected, starting at login?");
  // A brain of your own accepts this computer only once it's been added there.
  if (started && !byToken) await connected(origin, credential);
  else if (!started) note(`To connect: ${cmd("10and2 run")} in a terminal you keep open, or ${cmd("10and2 autostart on")}.`);
  else note(`It connects once your brain accepts it; ${cmd("10and2 status")} says when.`);
  canDo(policy);
  if (started && !byToken) say(`\n  ${bold("Next:")} open 10 & 2 on your phone and tap Start.`);
}

/** Which coding agents are here; refuses when there are none, since there'd be nothing to connect. */
async function agents(again: string) {
  const [t3, claudeCli] = await Promise.all([installed(process.env.T3_CLI ?? "t3"), installed("claude")]);
  const claude = claudeCli || existsSync(join(claudeDir(), "projects"));
  if (!t3 && !claude) {
    throw new Error(`Neither T3 Code nor Claude Code is on this computer (no ${cmd("t3")} or ${cmd("claude")} on your PATH), so there's nothing to connect. Install one, then run ${cmd(again)} again.`);
  }
  (t3 ? ok : note)(t3 ? "T3 Code" : dim("T3 Code not found"));
  (claude ? ok : note)(claude ? "Claude Code" : dim("Claude Code not found"));
  return { t3, claude };
}

/**
 * A policy the user already has is kept, pointed at this brain; a new one lets 10 & 2 see and do everything the spoken
 * readback and "yes" allow, which is what setup promised. Written once the computer is approved.
 */
function policyFor(origin: string, existing: any, found: { t3: boolean; claude: boolean }) {
  const policy = existing ? { ...existing, brain: linkUrl(origin) } : {
    brain: linkUrl(origin), projects: "*", actions: [...ACTIONS], maxRuntimeMode: "full-access", ...found,
  };
  parsePolicy(JSON.stringify(policy));
  return policy;
}

async function machineName() {
  const wanted = flags.get("name") ?? (flags.has("yes") ? defaultName() : await ask("What should Driver call this computer?", defaultName()));
  // 10 & 2 keeps a machine's name to one word (it's part of every thread's id); say so rather than change it quietly.
  const name = oneWord(wanted);
  if (name !== wanted) say(`    ${dim(`It'll be ${bold(name)}: one word, so it can name your threads.`)}`);
  return name;
}

/** Offers to start a job at login (unless --no-autostart); whether it's running now. */
async function startAtLogin(service: Service, question: string) {
  if (flags.has("no-autostart") || !service.supported || !await confirm(question, true)) return false;
  const s = await service.install(launch());
  if (s.running) ok("Starts at login");
  else warn(`Installed at ${s.where}, but it isn't running: see ${s.logs}`);
  return s.running;
}

function canDo(policy: any) {
  say();
  say(`  Driver can see ${seesText(policy)}, and can ${mayText(policy)}: each only after you hear it read back and say yes.`);
  say(`  ${dim(`To change that, edit ${defaultPolicyPath()}, then ${cmd("10and2 autostart on")}.`)}`);
  if (policy.claude) say(`  ${dim(`For Claude Code sessions to update instantly: ${cmd("10and2 hooks install")}.`)}`);
}

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

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
async function connected(origin: string, secret?: string) {
  const spin = spinner(`Connecting to ${account(origin, secret)}`);
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
  const key = cred?.secret ?? (token || undefined);
  const service = new Service();
  const s = await service.state();
  const st = readStatus();
  const alive = st?.pid ? (() => { try { process.kill(st.pid, 0); return true; } catch { return false; } })() : false;

  if (!cred && !token) bad(`Not connected to ${account(origin, key)}: ${cmd("10and2 setup")} connects it.`);
  else if (!alive) bad(`Not running. ${s.installed ? `It should start at login; see ${s.logs}` : `${cmd("10and2 autostart on")} keeps it running.`}`);
  else if (st.linked) ok(`Connected to ${account(origin, key)} ${dim(`· ${Date.now() - Date.parse(st.since) < 10_000 ? "just now" : `for ${ago(st.since)}`}`)}${st.threads !== undefined ? ` ${dim("·")} ${sizeText(st)}` : ""}`);
  else warn(`Connecting to ${account(origin, key)}${st.error ? `: ${st.error}` : ""}`);
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
  if (cred && !flags.has("yes") && !await confirm(`Disconnect this computer from ${account(origin, cred.secret)}?`, true)) throw new Cancelled();
  if (cred && !paired(cred.secret)) note(`Your brain still accepts this computer's old key until you remove it there: ${cmd("10and2 brain remove <name>")}.`);
  else if (cred) {
    const spin = spinner("Disconnecting");
    try {
      const res = await fetch(`${origin}/connector/revoke`, { method: "POST", headers: { authorization: `Bearer ${cred.secret}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok || res.status === 401) spin.ok(`Disconnected from ${account(origin, cred.secret)}`);
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
    if (policy?.brain) await connected(originOf(policy.brain), (await new Credentials().load(originOf(policy.brain)).catch(() => null))?.secret);
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

/** `10and2 brain …`: a brain of your own on this computer, instead of your 10 & 2 account's. */
async function brain() {
  const service = new Service({ job: BRAIN });
  const path = brainEnvPath();
  const settings = () => {
    const vars = readBrainEnv(path);
    if (!vars) throw new Error(`There's no brain set up on this computer: ${cmd("10and2 brain setup")} sets one up.`);
    return vars;
  };
  /** A running brain reads its settings once, at start. */
  const reload = async () => {
    if ((await service.state()).running) { await service.restart(); ok("Your brain restarted with it"); }
    else note(`Your brain reads it when it next starts (${cmd("10and2 brain run")}, or ${cmd("10and2 brain autostart on")}).`);
  };
  switch (sub) {
    case "setup": return brainSetup(service, path);
    case "run": return brainRun(path);
    case "status": case undefined: return brainStatus(service, path);
    case "add": {
      const [name, hash] = positional.slice(2);
      if (!name || !hash) throw new Error(`${cmd("10and2 brain add <name> <hash>")}: the name and hash ${cmd("10and2 setup --brain=… --token")} printed on the other computer.`);
      writeBrainEnv(addMachine(settings(), { name, tokenSha256: hash }), path);
      ok(`Your brain accepts ${bold(name)} now`);
      return reload();
    }
    case "remove": {
      const name = positional[2];
      if (!name) throw new Error(`${cmd("10and2 brain remove <name>")}: which computer (${cmd("10and2 brain status")} lists them).`);
      writeBrainEnv(removeMachine(settings(), name), path);
      ok(`Your brain no longer accepts ${bold(name)}`);
      return reload();
    }
    case "autostart": {
      const on = positional[2];
      if (on === "on") {
        settings();
        const s = await service.install(launch());
        if (s.running) ok("Your brain starts at login, and (re)started now"); else warn(`Installed at ${s.where}, but not running: see ${s.logs}`);
      } else if (on === "off") { await service.uninstall(); ok("Your brain stopped, and no longer starts at login"); }
      else if (on === "status" || on === undefined) { const s = await service.state(); say(s.installed ? `${s.running ? "Running" : "Not running"}; starts at login ${dim(`(${s.where})`)}.` : "Doesn't start at login."); }
      else throw new Error(`${cmd("10and2 brain autostart")} takes on, off or status.`);
      return;
    }
    default: throw new Error(`There's no "brain ${sub}" command. ${cmd("10and2 help")} lists them.`);
  }
}

async function brainSetup(service: Service, path: string) {
  if (readBrainEnv(path)) {
    say(`Your brain is already set up on this computer.\n`);
    return brainStatus(service, path);
  }
  const existing = readPolicyFile();
  const had = existing?.brain ? await new Credentials().load(originOf(existing.brain)) : null;
  if (had) {
    throw new Error(`This computer is connected to ${account(originOf(existing.brain), had.secret)}. ${cmd("10and2 revoke")} disconnects it; then run ${cmd("10and2 brain setup")} again.`);
  }
  const port = Number(flags.get("port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${cmd("--port")} is a port number, like ${DEFAULT_PORT}.`);

  say(`${bold("10 & 2")} ${dim("·")} your own brain, on this computer\n`);
  const found = await agents("10and2 brain setup");
  // From the environment when it's there (a script, or pasted where nobody sees it), else asked for without showing it.
  const key = process.env.OPENAI_API_KEY || await secret(`Your OpenAI API key ${dim("(from platform.openai.com; it stays on this computer)")}`); // provider-name-ok: which key to make (Jordan, 5 Nov)
  if (!key) throw new Error("Your brain needs your OpenAI API key, to talk and to read your threads. Run this again in a terminal, or with the key in OPENAI_API_KEY.");
  const name = await machineName();
  say();

  const origin = `http://127.0.0.1:${port}`;
  const policy = policyFor(origin, existing, found);
  // This computer's own connector, linked to it over loopback with a token only the two of them know.
  const token = randomBytes(32).toString("base64url");
  const vars = addMachine({
    OPENAI_API_KEY: key,
    // The phone sends it with every request (Settings → Advanced → Self-hosted brain).
    DRIVER_ACCESS_CODE: randomBytes(18).toString("base64url"),
    DRIVER_PORT: String(port),
  }, { name, tokenSha256: sha256(token), local: true });
  writeBrainEnv(vars, path);
  const store = await new Credentials().save(origin, token);
  writePrivate(defaultPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
  ok(`Set up ${dim(`· your key and its settings are in ${path}, which only you can read`)}`);
  if (store !== "file") ok(`This computer's key to it is in ${where(store)}`);

  const started = await startAtLogin(service, "Run your brain, and keep this computer connected to it, starting at login?");
  if (started) {
    const s = await new Service().install(launch());
    if (s.running) await connected(origin, token);
    else warn(`This computer's connection is installed at ${s.where}, but isn't running: see ${s.logs}`);
  } else note(`To run it: ${cmd("10and2 brain run")} and ${cmd("10and2 run")}, each in a terminal you keep open; or ${cmd("10and2 brain autostart on")} and ${cmd("10and2 autostart on")}.`);
  canDo(policy);
  await phone(vars);
}

/** What to enter on the phone, and how the phone reaches this computer (it only talks HTTPS). */
async function phone(vars: Record<string, string>) {
  const port = brainPort(vars);
  const tailnet = await tailnetName();
  say(`\n  ${bold("Your phone")} reaches your brain over HTTPS. ${tailnet ? "With Tailscale, run this once here:" : "Put it behind an HTTPS proxy, or use Tailscale and run this once here:"}`);
  say(`    ${cmd(`tailscale serve --bg ${port}`)}`);
  say(`\n  Then in 10 & 2 on your phone: Settings → Advanced → Self-hosted brain ${dim("(or “I run my own brain” when you sign in)")}`);
  note(`Address      ${bold(tailnet ? `https://${tailnet}` : "your proxy's https:// address")}`);
  note(`Access code  ${bold(vars.DRIVER_ACCESS_CODE)}`);
  note(dim(`${cmd("10and2 brain status --code")} shows them again.`));
  say(`\n  ${dim(`Other computers: ${cmd(`10and2 setup --brain=${tailnet ? `https://${tailnet}` : "<address>"} --token`)} there, then ${cmd("10and2 brain add …")} here.`)}`);
}

/** This computer's name on its tailnet (host.tailnet.ts.net), when Tailscale is running. */
async function tailnetName(): Promise<string | null> {
  const out = await runCommand("tailscale", ["status", "--json"]);
  try { return (JSON.parse(out ?? "").Self?.DNSName as string | undefined)?.replace(/\.$/, "") || null; } catch { return null; }
}

async function brainStatus(service: Service, path: string) {
  const vars = readBrainEnv(path);
  if (!vars) { say(`No brain of your own on this computer. ${cmd("10and2 brain setup")} sets one up.`); return; }
  const origin = brainOrigin(vars);
  const up = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const s = await service.state();
  if (up) ok(`Running at ${origin}`);
  else bad(`Not running. ${s.installed ? `It should start at login; see ${s.logs}` : `${cmd("10and2 brain run")} runs it, or ${cmd("10and2 brain autostart on")}.`}`);
  if (s.installed) (s.running ? ok : warn)(s.running ? "Starts at login" : `Starts at login, but isn't running: see ${s.logs}`);
  else if (up) note(dim(`Doesn't start at login (${cmd("10and2 brain autostart on")})`));
  say();
  const list = machines(vars);
  note(`Accepts  ${list.length ? list.map((m) => m.local ? `${m.name} ${dim("(this computer)")}` : m.name).join(", ") : "no computers"}`);
  if (flags.has("code")) {
    const tailnet = await tailnetName();
    note(`Address  ${tailnet ? `https://${tailnet} ${dim(`(with ${cmd(`tailscale serve --bg ${brainPort(vars)}`)})`)}` : "your HTTPS proxy's address"}`);
    note(`Code     ${vars.DRIVER_ACCESS_CODE}`);
  } else note(dim(`The phone's address and access code: ${cmd("10and2 brain status --code")}`));
  note(dim(`Settings ${path}`));
}

/** Loads the brain built into this package, with this computer's settings; it runs until stopped. */
async function brainRun(path: string) {
  // Settings already in the environment win over the file (so does a brain set up entirely by hand, with no file).
  if (existsSync(path)) process.loadEnvFile(path);
  else if (!process.env.OPENAI_API_KEY) throw new Error(`There's no brain set up on this computer: ${cmd("10and2 brain setup")} sets one up.`);
  // The connector's own settings: the brain refuses them (it once read them itself), but here they're the connector's.
  delete process.env.T3_URL;
  delete process.env.T3_CLI;
  process.env.DRIVER_DB ||= brainDb();
  mkdirSync(dirname(process.env.DRIVER_DB), { recursive: true, mode: 0o700 });
  // Next to this file both in the package (dist/10and2.js) and in a checkout (src/main.ts, after `npm run build`).
  const bundle = new URL("../dist/brain/main.js", import.meta.url);
  if (!existsSync(bundle)) throw new Error("This copy of 10and2 was built without the brain: `npm run build` builds it.");
  await import(bundle.href);
}
