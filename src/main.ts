#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// 10and2: the connector. Credentials and backend code live here, on the machine doing the work; the brain holds only
// a hash of this machine's credential.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Credentials, parseCredential, run as runCommand, type Store } from "./credential.ts";
import { hookLauncher } from "./command.ts";
import { Ledger } from "./ledger.ts";
import { Link } from "./link.ts";
import { Local } from "./local.ts";
import { Expired, linkUrl, originOf, pair } from "./pair.ts";
import { configDirectory, databasePath, hookSocket, stateDirectory } from "./paths.ts";
import { addMachine, brainDb, brainEnvPath, brainOrigin, brainPort, DEFAULT_PORT, machines, readBrainEnv, removeMachine, validName, writeBrainEnv } from "./brain.ts";
import { AGENTS, type Agent, defaultPolicyPath, DOCUMENT_MODES, type DocumentAccess, loadPolicy, parsePolicy, readGuard, readSettings, rulesOf, validBase, visible } from "./policy.ts";
import type { HeldSummary } from "./gate.ts";
import { describeFound, detect, NAMES, ORDER, type Found } from "./agents.ts";
import { versionWarning } from "./versions.ts";
import { applyChoice, applyFlags, capsFor, CAP_SHORT, CEILING_LABEL, chooseDocuments, chooseInteractively, chooseWaiting, choiceOf, DOCUMENTS_LABEL, openSessionsNote, RULES_LABEL, startingChoice, summary, WAIT_WORDS, waitKinds, type Choice } from "./choose.ts";
import { VERSION } from "./protocol.ts";
import { proxyAdvice, useSystemNetwork } from "./net.ts";
import { BRAIN, checkout, CONNECTOR, connectorRunning, launchFor, Service, temporary, type ServiceState } from "./service.ts";
import { pidState } from "./claude/registry.ts";
import { loginService, stopLikeSigterm } from "./supervisor.ts";
import { T3Adapter } from "./t3/adapter.ts";
import { ClaudeAdapter, hooksStatus, hooksUnavailable, installHooks, refreshGate, runHook, uninstallHooks } from "./claude/index.ts";
import { CodexAdapter, defaultCodexHome } from "./codex/adapter.ts";
import { PiAdapter } from "./pi/adapter.ts";
import { CursorAdapter } from "./cursor/adapter.ts";
import { installPiExtension, piAgentDir, piExtensionStatus, uninstallPiExtension } from "./pi/extension.ts";
import { runPiTurn } from "./pi/turn.ts";
import { AcpAdapter } from "./acp/adapter.ts";
import { runAcpTurn } from "./acp/turn.ts";
import { GeminiSource } from "./gemini/source.ts";
import { CopilotSource, copilotDir } from "./copilot/source.ts";
import { copilotExtensionStatus, installCopilotExtension, uninstallCopilotExtension, updateCopilotExtension } from "./copilot/extension.ts";
import { installOpenCodePlugin, OpenCodeAdapter, openCodePluginStatus, uninstallOpenCodePlugin } from "./opencode/index.ts";
import { describe, replaceFile } from "./util.ts";
import { openBrowser, opener } from "./browser.ts";
import { cancelWaiting, deviceOf, Schedules } from "./schedules.ts";
import { shownClock } from "../brain/src/zone.ts";
import { accent, ago, ask, bad, bold, Cancelled, cmd, confirm, dim, keys, mark, note, ok, say, secret, spinner, warn } from "./ui.ts";

const DEFAULT_ORIGIN = "https://10and2.selfdep.com";
/** Said once setup is done (and in the README): a computer asleep is offline. */
const AWAKE = "Keep this computer awake while you drive: closing a laptop's lid sleeps it, and takes it offline.";
/** The 10 & 2 service's own addresses (production and staging): any other is a brain of your own. */
const SERVICE = [DEFAULT_ORIGIN, "https://10and2-stg.selfdep.com"];
/** Someone running their own brain needs to know which key to make (Jordan, 5 Nov: the CLI may say OpenAI). */
const OWN_KEY = "your OpenAI key"; // provider-name-ok: see above
const usage = () => `${bold("10and2")} ${VERSION} ${dim("·")} connects this computer's coding agents (Claude Code, Codex, Pi, OpenCode, Gemini CLI, Copilot CLI, Cursor, T3 Code) to 10 & 2

  ${cmd("10and2 setup")}     connect this computer (opens your browser to approve it)
  ${cmd("10and2 status")}    whether it's connected, and what 10 & 2 can see and do here
  ${cmd("10and2 agents")}    choose which coding agents to connect, and what 10 & 2 may do
  ${cmd("10and2 revoke")}    disconnect this computer
  ${cmd("10and2 uninstall")} remove everything 10and2 added to this computer

More
  ${cmd("10and2 autostart on|off|status")}     start at login
  ${cmd("10and2 hooks install|uninstall|status")}  10 & 2 answers Claude Code's questions; updates are instant
  ${cmd("10and2 pi install|uninstall|status")}     10 & 2 reaches the Pi sessions you have open
  ${cmd("10and2 opencode install|uninstall|status")}  10 & 2 reaches the OpenCode sessions you have open
  ${cmd("10and2 copilot install|uninstall|status")}   10 & 2 reaches the Copilot CLI sessions you have open
  ${cmd("10and2 run")}                         run in this terminal instead of at login
  ${cmd("10and2 token")}                       a token, for a brain you configure by hand

Setup options: --name=<what 10 & 2 calls it>  --worktree-base=<branch, or HEAD>  --documents=off|project|all  --yes  --no-autostart  --brain=<url>  --token (a brain of your own)
Choosing without a terminal: --agents=claude,pi  --off=codex  --read-only  --no-steer  --no-answer  --no-start  --no-tidy  (--no-steer=codex: that agent only)
Settings: ${defaultPolicyPath()}

Your own brain ${dim(`(instead of your 10 & 2 account: ${OWN_KEY}, your computer)`)}
  ${cmd("10and2 brain setup")}                 run 10 & 2's brain on this computer ${dim("(--port=8790)")}
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
/**
 * A key from pairing with a 10 & 2 account; a brain of your own takes a plain token instead (`--token`, `brain setup`).
 * Without a key (revoked, or one this account can't read), the address says which.
 */
const paired = (origin: string, secret?: string) => secret === undefined ? SERVICE.includes(origin) : parseCredential(secret) !== null;
/** What this computer is connected to, given its key when there is one. */
const account = (origin: string, secret?: string) => !paired(origin, secret) ? `your brain at ${hostOf(origin)}`
  : origin === DEFAULT_ORIGIN ? "your 10 & 2 account" : `your 10 & 2 account at ${hostOf(origin)}`;

// `--help` or `-h` anywhere only prints the help: `10and2 setup --help` must never start a pairing.
const wantsHelp = command !== "hook" && (flags.has("help") || argv.includes("-h"));

/** The flags that choose agents and permissions without a terminal (choose.ts `applyFlags`). */
const CHOOSING = ["agents", "off", "no-steer", "no-answer", "no-start", "no-follow-up", "no-tidy", "read-only", "later", "documents"];
/** What each command takes after its name: at most how many words, and which flags. */
const TAKES: Record<string, { words: number; flags: string[] }> = {
  setup: { words: 0, flags: ["brain", "token", "name", "worktree-base", "yes", "no-autostart", ...CHOOSING] },
  agents: { words: 0, flags: ["yes", "worktree-base", ...CHOOSING] },
  run: { words: 0, flags: ["wait-for-credential", "fatal-exit"] },
  status: { words: 0, flags: ["verbose"] },
  revoke: { words: 0, flags: ["yes"] },
  uninstall: { words: 0, flags: ["yes"] },
  autostart: { words: 1, flags: [] },
  hooks: { words: 1, flags: [] },
  pi: { words: 1, flags: [] },
  opencode: { words: 1, flags: [] },
  copilot: { words: 1, flags: [] },
  "pi-turn": { words: 0, flags: [] },
  "acp-turn": { words: 0, flags: [] },
  "login-service": { words: 1, flags: [] },
  brain: { words: 3, flags: ["port", "code", "name", "yes", "no-autostart", ...CHOOSING] },
  token: { words: 0, flags: [] },
};

/**
 * An argument the command wouldn't read, said before it does anything: `10and2 setup 10and2-stg.selfdep.com` once
 * paired with the default address, the word ignored. `hook` is Claude Code's and stays silent.
 */
function unread(): string | null {
  const takes = TAKES[command ?? ""];
  if (!takes || wantsHelp) return null;
  const word = positional[1 + takes.words];
  if (word !== undefined) {
    if (command === "setup") return `${cmd("10and2 setup")} doesn't take "${word}". To connect to 10 & 2 at another address: ${cmd(`10and2 setup --brain=${word}`)}`;
    return `${cmd(`10and2 ${command}`)} doesn't take "${word}". ${cmd("10and2 help")} lists what each command takes.`;
  }
  const flag = [...flags.keys()].find((f) => !takes.flags.includes(f));
  return flag === undefined ? null : `${cmd(`10and2 ${command}`)} has no ${cmd(`--${flag}`)}. ${cmd("10and2 help")} lists what each command takes.`;
}

// Claude Code's hooks and Pi's turns talk only to this computer, and start often: no need to read certificates for them.
if (!["hook", "pi-turn"].includes(command ?? "")) useSystemNetwork();

try {
  const refused = unread();
  if (refused) { fail(`${mark.bad} ${refused}`, 64); process.exit(); }
  switch (wantsHelp ? "help" : command) {
    case "setup": await setup(); break;
    case "agents": await agentsCommand(); break;
    case "run": await runConnector(); break;
    case "status": await status(); break;
    case "revoke": await revoke(); break;
    case "uninstall": await uninstall(); break;
    case "autostart": await autostart(); break;
    case "hook": await runHook(argv); break; // Claude Code runs this (bin/10and2.js loads hook.ts's bundle for it); it must stay silent
    case "hooks": await hooks(); break;
    case "pi": piCommand(); break;
    case "opencode": await openCodeCommand(); break;
    case "copilot": copilotCommand(); break;
    case "pi-turn": process.exitCode = await runPiTurn(); break; // the connector runs this; it must stay silent
    case "acp-turn": process.exitCode = await runAcpTurn(); break; // the connector runs this; it must stay silent
    // Windows runs this at login (service.ts runEntry); it must stay silent.
    case "login-service": {
      const job = [CONNECTOR, BRAIN].find((j) => j.name === sub);
      if (job) await loginService(job); else process.exitCode = 64;
      break;
    }
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
  else fail(`${mark.bad} ${describe(e)}`);
}

function readPolicyFile(): any | null {
  const path = defaultPolicyPath();
  if (!existsSync(path)) return null;
  try { return JSON.parse(readSettings(path)); } catch { throw new Error(`${path} isn't JSON; fix or remove it, then run setup again.`); }
}
function writePrivate(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  replaceFile(tmp, path);
}
function where(s: Store) {
  const file = join(configDirectory(), "credentials.json");
  return s === "keychain" ? "your login Keychain" : s === "libsecret" ? "your keyring (libsecret)" : s === "dpapi" ? `${file} (encrypted for your Windows account)` : `${file} (only you can read it)`;
}
/**
 * Said when a job set to start at login wasn't (re)started now, from a terminal run as administrator: one that already
 * runs keeps running as it was. `again` (re)starts it. Signing in again is said first: with the built-in Administrator
 * account, or UAC off, every terminal runs as one.
 */
function startsAtSignIn(s: ServiceState, ...again: string[]) {
  const sooner = `sign out and back in, or run ${words(again.map(cmd))} in a terminal that isn't run as administrator.`;
  if (s.running) warn(`Starts at login, and keeps running as it was until your next sign-in: this terminal runs as administrator. To restart it sooner, ${sooner}`);
  else warn(`Starts at your next sign-in, not now: this terminal runs as administrator. To start it sooner, ${sooner}`);
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
  if (had && readStatus()?.fatal) {
    // Its key is still here, but 10 & 2 refused it (revoked on the website, or set up again elsewhere): forgetting it
    // is what connects it again.
    bad(`This computer was disconnected from ${account(origin, had.secret)}${readStatus()?.error ? ` (${readStatus().error})` : ""}.`);
    say(`  To connect it again: ${cmd("10and2 revoke")}, then ${cmd("10and2 setup")}.`);
    process.exitCode = 1;
    return;
  }
  if (had) {
    say(`This computer is already connected to ${account(origin, had.secret)}.\n`);
    await status();
    say(`\n${cmd("10and2 revoke")} disconnects it, if you want to connect it again.`);
    return;
  }

  say(`${bold("10 & 2")} ${dim("·")} connect this computer\n`);
  const proxy = proxyAdvice();
  if (proxy) warn(proxy);
  const { found, choice } = await chooseAgents("10and2 setup", existing);
  const policy = withDocuments(withWaiting(await policyFor(origin, existing, choice), await waitingFor(existing, choice, found)), await documentsFor(existing));
  const name = await machineName();
  if (byToken && !validName(name)) throw new Error(`Your brain can't call it "${name}": start with a letter or digit (${cmd("--name=")}).`);
  say();
  const credential = byToken ? randomBytes(32).toString("base64url") : await approve(origin, name);
  // Seconds on Windows, where it's encrypted through PowerShell.
  const saving = spinner("Saving its key");
  const store = await creds.save(origin, credential).finally(() => saving.clear());
  writePrivate(defaultPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
  if (byToken) {
    ok(`Made its key ${dim(`· in ${store === "file" ? "a file only you can read" : where(store)}`)}`);
    say(`\n  On your brain's computer, run this so it accepts this one:`);
    say(`    ${cmd(`10and2 brain add ${name} ${sha256(credential)}`)}\n`);
  } else ok(`Approved ${dim(`· its key is in ${store === "file" ? "a file only you can read" : where(store)}`)}`);
  await offerHelpers(choice);

  const login = await startAtLogin(new Service(), "Keep it connected, starting at login?", "10and2 autostart on");
  // From a terminal run as administrator, one already running isn't restarted with the new key: nothing to wait for.
  const started = login?.running === true && !login.elevated;
  // A brain of your own accepts this computer only once it's been added there.
  if (started && !byToken) await connected(origin, credential);
  else if (started) note(`It connects once your brain accepts it; ${cmd("10and2 status")} says when.`);
  // From a terminal run as administrator, startAtLogin has said when it starts, and how to start it sooner.
  else if (!login?.elevated) note(`To connect: ${cmd("10and2 run")} in a terminal you keep open, or ${cmd("10and2 autostart on")}.`);
  canDo(policy, choice, found);
  if (started && !byToken) say(`\n  ${bold("Next:")} open 10 & 2 on your phone and tap Start.`);
  note(dim(AWAKE));
}

/**
 * Which coding agents are here, which of them to connect, and what Driver may do with them: the two screens at a
 * terminal (docs/launch/mockups/connector-setup), else everything found and allowed, narrowed by flags. Refuses when no
 * agent is found or every one is switched off, since there'd be nothing to connect.
 */
async function chooseAgents(again: string, existing: any | null): Promise<{ found: Found[]; choice: Choice }> {
  const found = await detect();
  if (!found.some((f) => f.installed)) {
    throw new Error(`No coding agent 10 & 2 works with is on this computer (Claude Code, Codex, Pi, OpenCode, Gemini CLI, Copilot CLI, Cursor or T3 Code), so there's nothing to connect. Install one, then run ${cmd(again)} again.`);
  }
  let choice = applyFlags(startingChoice(existing, found), flags, found);
  if (!flags.has("yes") && process.stdin.isTTY && process.stdout.isTTY) choice = await chooseInteractively(found, choice);
  else {
    // Git Bash's own window (mintty) gives a program pipes, not a terminal, so nothing can be asked there.
    if (!flags.has("yes") && process.platform === "win32" && process.env.MSYSTEM) warn(`Git Bash can't show the choices here, so the defaults apply. To choose, run ${cmd(again)} in PowerShell or Windows Terminal.`);
    for (const f of found) (f.installed && choice.on[f.agent] ? ok : note)(f.installed && choice.on[f.agent] ? `${f.name} ${dim(`· ${describeFound(f)}`)}` : dim(`${f.name} ${f.installed ? "· off" : "not found"}`));
  }
  if (!AGENTS.some((a) => choice.on[a])) throw new Error(`Every coding agent is switched off, so there's nothing to connect. Run ${cmd(again)} again and switch one on.`);
  warnOld(found.filter((f) => choice.on[f.agent]));
  return { found, choice };
}

/** An agent older than what Driver needs, and how to update it (versions.ts). */
function warnOld(found: Found[]) {
  for (const f of found) {
    const w = f.installed ? versionWarning(f.agent, f.name, f.version) : null;
    if (w) warn(w.replace(/: (\S.*)$/, (_, c: string) => `: ${cmd(c)}`));
  }
}

/**
 * A policy the user already has is kept, pointed at this brain; a new one lets 10 & 2 see and do everything the spoken
 * readback and "yes" allow, which is what setup promised. Either way, with T3 Code, where its new worktrees start is
 * asked when the policy doesn't say. Written once the computer is approved.
 */
async function policyFor(origin: string, existing: any, choice: Choice) {
  const policy: any = applyChoice(existing ? { ...existing, brain: linkUrl(origin) } : { brain: linkUrl(origin), projects: "*" }, choice);
  if (choice.on.t3 && policy.worktreeBase === undefined) policy.worktreeBase = await worktreeBase();
  parsePolicy(JSON.stringify(policy));
  return policy;
}

/**
 * Commands that wait (docs/launch/engine.md §11 stage 4; Fable's 4-H1): which commands an agent waits on until the user
 * lets them run from the phone. Asked at a terminal with Claude Code on (the only agent that holds one, with T3 Code's
 * Claude threads); otherwise the list stays as it is, so nothing is ever added without its owner choosing it here.
 */
async function waitingFor(raw: any, choice: Choice, found: Found[]): Promise<string[] | undefined> {
  const current: string[] | null = Array.isArray(raw?.guard) ? raw.guard : null;
  if (!choice.on.claude || flags.has("yes") || !process.stdin.isTTY || !process.stdout.isTTY) return current ?? undefined;
  const guard = await chooseWaiting(current, choice.on);
  if (guard.length) note(dim(WAIT_WORDS.phone));
  const open = guard.length ? openSessionsNote(found.find((f) => f.agent === "claude")?.version ?? null) : null;
  if (open) note(dim(open));
  return guard;
}
/** The policy with its list as chosen; none chosen (never asked) leaves the file without one. */
function withWaiting(policy: any, guard: string[] | undefined) {
  const out = { ...policy };
  if (guard) out.guard = guard; else delete out.guard;
  return out;
}

/**
 * Linked documents: opt-in reading of prose docs linked by agent replies (plans, design docs). Asked on its own
 * screen at a terminal in `setup` and `agents` (with an explanation and example); off unless chosen or passed via `--documents`.
 */
async function documentsFor(raw: any): Promise<DocumentAccess | undefined> {
  if (flags.has("documents")) {
    const v = flags.get("documents")!;
    if (!DOCUMENT_MODES.includes(v as DocumentAccess)) throw new Error(`--documents takes ${DOCUMENT_MODES.join(", ")}.`);
    return v as DocumentAccess;
  }
  const current: DocumentAccess | null = DOCUMENT_MODES.includes(raw?.documents) ? raw.documents : null;
  if (flags.has("yes") || !process.stdin.isTTY || !process.stdout.isTTY) return current ?? undefined;
  return chooseDocuments(current);
}
function withDocuments(policy: any, documents: DocumentAccess | undefined) {
  const out = { ...policy };
  if (documents !== undefined) out.documents = documents; else delete out.documents;
  return out;
}

/** A branch fetched from origin by default: a checkout left on older work would otherwise start every new thread stale. */
async function worktreeBase() {
  const wanted = flags.get("worktree-base") ?? (flags.has("yes") ? "main"
    : await ask(`New T3 Code worktrees start from the latest of which branch on origin? ${dim(`(${bold("HEAD")}: whatever each project's checkout is on)`)}`, "main"));
  if (!validBase(wanted)) throw new Error(`"${wanted}" isn't a branch name; give one, such as ${cmd("main")}, or ${cmd("HEAD")}.`);
  return wanted;
}
function baseText(base: string) {
  return base === "HEAD" ? "whatever the project's checkout is on" : `the latest ${base} on origin`;
}

async function machineName() {
  const wanted = flags.get("name") ?? (flags.has("yes") ? defaultName() : await ask("What should 10 & 2 call this computer?", defaultName()));
  // 10 & 2 keeps a machine's name to one word (it's part of every thread's id); say so rather than change it quietly.
  const name = oneWord(wanted);
  if (name !== wanted) say(`    ${dim(`It'll be ${bold(name)}: one word, so it can name your threads.`)}`);
  return name;
}

/**
 * Offers to start a job at login (unless --no-autostart; --yes accepts): what installing it gave, or null when it wasn't installed.
 * `again` are the commands that start it now (and whatever is installed after it) when a terminal run as administrator didn't.
 */
async function startAtLogin(service: Service, question: string, ...again: string[]): Promise<ServiceState | null> {
  if (flags.has("no-autostart") || !service.supported) return null;
  // Run through npx on Windows, there's no 10and2 for Windows to start at login: not asked, and said why.
  const l = launch();
  const why = service.unavailable(l);
  if (why) { note(why); return null; }
  if (!flags.has("yes") && !await confirm(question, true)) return null;
  // Paired by now: a service that can't be set up is said, and setup goes on.
  let s: ServiceState;
  try { s = await service.install(l); } catch (e) { warn(describe(e)); return null; }
  if (s.elevated) startsAtSignIn(s, ...again);
  else if (s.running) ok("Starts at login");
  else warn(`Installed at ${s.where}, but it isn't running: see ${s.logs}`);
  if (s.note) note(s.note);
  return s;
}

function canDo(policy: any, choice: Choice, found: Found[]) {
  say();
  for (const line of summary(choice, found)) say(`  ${line}`);
  if (policy.projects !== "*") say(`  It sees ${seesText(policy)}.`);
  if (choice.on.t3 && choice.caps.start_work) say(`  New T3 Code worktrees start from ${baseText(policy.worktreeBase ?? "HEAD")}.`);
  if (policy.documents && policy.documents !== "off") say(`  Linked documents: ${DOCUMENTS_LABEL[policy.documents as DocumentAccess]}.`);
  if (choice.caps.steer && AGENTS.some((a) => choice.on[a] && a !== "t3")) say(`  ${dim("Messages reach a session open in a terminal between its steps, or as its next turn.")}`);
  say(`  ${dim(`${cmd("10and2 agents")} changes this.`)}`);
}

/**
 * `10and2 agents`: the same two screens as setup, on this computer's settings, without pairing again; saved, and the
 * connector restarted if it runs at login so the change applies at once.
 */
async function agentsCommand() {
  const raw = readPolicyFile();
  if (!raw) throw new Error(`This computer isn't set up yet: ${cmd("10and2 setup")} connects it.`);
  const { found, choice } = await chooseAgents("10and2 agents", raw);
  const next: any = withDocuments(withWaiting(applyChoice(raw, choice), await waitingFor(raw, choice, found)), await documentsFor(raw));
  if (choice.on.t3 && next.worktreeBase === undefined) next.worktreeBase = await worktreeBase();
  parsePolicy(JSON.stringify(next));
  writePrivate(defaultPolicyPath(), JSON.stringify(next, null, 2) + "\n");
  ok(`Saved ${dim(`· ${defaultPolicyPath()}`)}`);
  await offerHelpers(choice);
  say();
  for (const line of summary(choice, found)) say(`  ${line}`);
  if (next.documents && next.documents !== "off") say(`  Linked documents: ${DOCUMENTS_LABEL[next.documents as DocumentAccess]}.`);
  const service = new Service();
  if (service.supported && (await service.state()).running) { await service.restart(); ok("The connector restarted with it"); }
  else note(dim(`It applies when the connector next starts (${cmd("10and2 run")}, or ${cmd("10and2 autostart on")}).`));
}

/**
 * What each connected agent needs for Driver to answer its questions and reach its open sessions (Claude Code's hooks,
 * the Pi extension), asked for once. Each edits the agent's own settings, so it's only added here, when asked, or by
 * its own command; off a terminal, or with --yes, they're added.
 */
async function offerHelpers(choice: Choice) {
  const wants = (a: Agent) => choice.on[a] && choice.caps.follow_up && !(choice.off[a] ?? []).includes("follow_up");
  const helpers: { name: string; add: () => Promise<void>; undo: string }[] = [];
  // A list that can't be read is taken as one, so the hook that holds it stays (it fails closed).
  const hooked = await hooksStatus(claudeDir()).catch(() => null), gate = (readGuard() ?? ["?"]).length > 0;
  // Where Claude Code can't run them (no Git Bash on Windows), they're never added, and setup says why.
  const unavailable = hooksUnavailable(claudeDir());
  if (wants("claude") && !hooked?.installed) {
    if (unavailable) note(dim(unavailable));
    else helpers.push({ name: "Claude Code hooks", undo: "10and2 hooks uninstall", add: () => installHooks(claudeDir(), hookCommand(), gate) });
  } else if (hooked?.installed && hooked.gate !== gate && !unavailable) {
    // Commands that wait: the hook that holds one, only while the list has something on it.
    await installHooks(claudeDir(), hookCommand(), gate);
    ok(gate ? "Claude Code's commands on your list now wait for you" : "Claude Code's commands no longer wait");
  }
  if (wants("pi") && piExtensionStatus(piAgentDir()).state !== "installed") {
    helpers.push({ name: "Pi extension", undo: "10and2 pi uninstall", add: async () => { installPiExtension(piAgentDir()); } });
  }
  if (wants("opencode") && !(await openCodePluginStatus().catch(() => null))?.current) {
    helpers.push({ name: "OpenCode plugin", undo: "10and2 opencode uninstall", add: async () => { await installOpenCodePlugin(); } });
  }
  await offerCopilotExtension(wants("copilot"));
  if (!helpers.length) return;
  const names = helpers.map((h) => h.name).join(" and ");
  if (!flags.has("yes") && !await confirm(`Let 10 & 2 answer questions and reach open sessions? It adds the ${names}`, true)) {
    note(dim(`Not added. ${helpers.map((h) => cmd(h.undo.replace("uninstall", "install"))).join(" and ")} adds ${helpers.length > 1 ? "them" : "it"} later.`));
    return;
  }
  for (const h of helpers) {
    try { await h.add(); ok(`${h.name} added ${dim(`· ${cmd(h.undo)} removes ${h.name.endsWith("s") ? "them" : "it"}`)}`); }
    catch (e) { warn(`Couldn't add the ${h.name} (${describe(e)}). ${cmd(h.undo.replace("uninstall", "install"))} tries again.`); }
  }
}

/**
 * Copilot's extension, asked for on its own: Copilot loads extensions only with its experimental features on, which it
 * turns on for everything Copilot does, so it's never added without a yes here (not with --yes, nor off a terminal).
 */
async function offerCopilotExtension(wanted: boolean) {
  let state;
  try { state = copilotExtensionStatus(copilotDir()).state; } catch { return; }
  if (!wanted || state === "installed" || state === "foreign") return;
  const later = `${cmd("10and2 copilot install")} adds it later.`;
  if (flags.has("yes") || !process.stdin.isTTY) { note(dim(`10 & 2 reaches open Copilot CLI sessions with its Copilot extension, which needs Copilot's experimental features on: ${later}`)); return; }
  if (!await confirm("Let 10 & 2 send to Copilot CLI sessions you have open, and answer their questions? It adds 10and2's Copilot extension and turns on Copilot's experimental features, which extensions need", true)) {
    note(dim(`Not added. ${later}`)); return;
  }
  try { installCopilotExtension(copilotDir()); ok(`Copilot extension added ${dim(`· restart any open Copilot · ${cmd("10and2 copilot uninstall")} removes it`)}`); }
  catch (e) { warn(`Couldn't add the Copilot extension (${describe(e)}). ${cmd("10and2 copilot install")} tries again.`); }
}

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

function defaultName() { return oneWord(hostname().replace(/\.(local|lan|home)$/i, "")); }
/** As the cloud names machines (cloud/src/links.ts machineName), before it adds a number to a name already taken. */
function oneWord(name: string) { return name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "computer"; }

/** Shows the code, opens the browser and waits for the approval: Enter opens the page again; at a terminal, an expired code can be renewed. */
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
          wait = spinner(`Waiting for you to approve it ${dim(!process.stdin.isTTY ? "" : opener(p.verificationUrl) ? "· Enter opens the page again · Ctrl-C cancels" : "· Ctrl-C cancels")}`);
        },
      });
    } catch (e) {
      wait?.clear();
      if (controller.signal.aborted) throw new Cancelled();
      if (!(e instanceof Expired)) throw e;
      // Off a terminal, or with --yes, nobody may be there to approve a new code: renewing would open the browser every 10
      // minutes, for good.
      if (!process.stdin.isTTY || flags.has("yes")) throw new Error(`The code expired before it was approved. To get a new one, run ${cmd(`10and2 setup${flags.has("brain") ? ` --brain=${flags.get("brain")}` : ""}`)} again.`);
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
  const on = choiceOf(p).on;
  const where = words(ORDER.filter((a) => on[a]).map((a) => NAMES[a]));
  const what = p.projects === "*" ? "every project" : Array.isArray(p.projects) && p.projects.length ? `only ${words(p.projects)}` : "no projects";
  return `${what} in ${where}`;
}

/** One send or start held for later, as `status` lists it: "03:00 tell API “carry on”", on this computer's clock. */
function heldText(h: { at: string | null; said: string }): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return h.at && Number.isFinite(Date.parse(h.at)) ? `${shownClock(Date.parse(h.at), zone, Date.now())} ${h.said}` : h.said;
}

/**
 * What the login service runs, and this PATH (service.ts launchFor). Windows' startup entry names neither (it runs
 * `10and2` from the PATH): there they start its supervisor this once, and the PATH is kept for it.
 */
function launch() {
  return launchFor(process.argv[1], process.execPath, process.env);
}

/**
 * A login service whose program is gone can never start: its install was removed or upgraded away (nvm's uninstall, a
 * Nix garbage collection). Written again for this install, when it's an installed one (on PATH), never a checkout.
 */
async function repairService(service: Service) {
  const gone = service.supported ? service.missing() : null;
  if (!gone) return;
  const l = launch();
  // A checkout run with node, or npx's copy, isn't put in: never a service that runs a checkout or a cache.
  if (checkout(l) || temporary(l)) return;
  const s = await service.install(l);
  (s.running ? ok : warn)(`Starts at login again: it ran ${gone}, which is gone, and now runs ${l.program[0]}${s.running ? "" : `, but isn't running: see ${s.logs}`}`);
}

async function runConnector() {
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
  // Windows' supervisor asks it to stop over IPC, where SIGTERM never arrives: shutdown() below runs for both.
  stopLikeSigterm();
  const fatalExit = Number(flags.get("fatal-exit") ?? 78);
  let state = { pid: process.pid, version: VERSION, startedAt: new Date().toISOString(), brain: "", linked: false, since: null as string | null, error: null as string | null, fatal: false, threads: undefined as number | undefined, projects: undefined as number | undefined, privacy: [] as string[],
    schedules: [] as { at: string | null; said: string }[],
    // Commands that wait: what's held now, by work system, and how many were stopped at once (a session nobody shows).
    holds: {} as Record<string, HeldSummary[]>, unheld: 0, unheldAt: null as string | null,
    /** T3 Code stopped on its own (its session refused), while the rest stays connected. */
    t3Error: null as string | null };
  const record = (s: Partial<typeof state>) => { state = { ...state, ...s }; try { writePrivate(statusFile(), JSON.stringify(state) + "\n"); } catch { /* status is a convenience */ } };
  let policy;
  try { policy = loadPolicy(); }
  catch (e) { log(`connector: ${describe(e)} (policy: ${defaultPolicyPath()}; run \`10and2 setup\`)`); process.exitCode = fatalExit; return; }
  const origin = originOf(policy.brain);
  record({ brain: origin });
  for (const p of policy.unresolved ?? []) log(`connector: project folder "${p}" can't be found or read; leaving it out (${defaultPolicyPath()})`);
  let token = process.env.TENANDTWO_TOKEN;
  // The login service's way: a start before the keyring opens (boot, with lingering) waits for it instead of giving up.
  // Windows has no keyring: DPAPI reads the key from sign-in or never (made for another account), so it stops as unpaired.
  const wait = process.platform === "win32" ? undefined : flags.get("wait-for-credential");
  const waitMs = wait === "true" ? 15_000 : Number(wait) * 1000;
  try {
    token ||= (await new Credentials().load(origin))?.secret;
    // Reading it takes a PowerShell start, which can fail once at sign-in: a key that's there is tried again first.
    for (let i = 0; !token && process.platform === "win32" && i < 2 && new Credentials().stored(origin); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      token = (await new Credentials().load(origin))?.secret;
    }
    if (!token && wait) {
      log(`connector: no credential readable for ${origin} yet (is the keyring locked until you log in?); checking every ${waitMs / 1000}s`);
      record({ error: "waiting for the credential (keyring locked?)" });
      while (!token) {
        await new Promise((r) => setTimeout(r, waitMs));
        token = (await new Credentials().load(origin))?.secret;
      }
      log("connector: the credential is readable now");
      record({ error: null });
    }
  }
  catch (e) { log(`connector: ${describe(e)}`); process.exitCode = fatalExit; return; }
  if (!token) { log(`connector: this machine isn't paired with ${origin}. Run \`10and2 setup\`.`); record({ error: "not paired" }); process.exitCode = fatalExit; return; }

  const ledger = new Ledger();
  let link: Link | undefined;
  const stop = (code: number) => { record({ linked: false }); link?.close(); process.exit(code); };
  const t3 = policy.t3
    ? new T3Adapter({
      // Without T3_URL, where T3 says it is, at each connect (it moves off 3773 when that's taken).
      ...(process.env.T3_URL ? { baseUrl: process.env.T3_URL } : {}), cli: [process.env.T3_CLI ?? "t3"], label: "10and2-connector", log,
      visible: (root) => visible(policy, root), worktreeBase: policy.worktreeBase, policy,
      // T3 Code alone stops: the other agents stay connected (status says T3's, and how to bring it back).
      onRevoked: () => record({ t3Error: "T3 Code refused 10 & 2's session (revoked there?)" }),
      onHolds: (held) => record({ holds: { ...state.holds, t3: held } }),
    })
    : null;
  // Claude Code has no command ids, so a lost outcome is never sent again (the ledger reports it unknown).
  const claude = policy.claude
    ? new ClaudeAdapter({ policy, configDir: claudeDir(), db: join(stateDirectory(), "claude.db"), stateDir: join(stateDirectory(), "claude"),
      // On Windows the adapter makes a new pipe at each start and names it where hookSocket() reads it.
      hookSocketPath: process.platform === "win32" ? undefined : hookSocket()?.path, log,
      // Commands that wait: a T3 Code thread run by Claude holds its own; one nobody shows is counted for status.
      // T3 decides for its own threads, and stops one at once where it may not answer (never the Claude adapter's then).
      claimGate: t3 ? (session, socket, command, matched) => t3.claimGate(session, socket, command, matched) : undefined,
      onUnheld: () => record({ unheld: state.unheld + 1, unheldAt: new Date().toISOString() }),
      onHolds: (held) => record({ holds: { ...state.holds, claude: held } }) })
    : null;
  // A copy of 10and2's Pi extension from an older 10and2 is brought up to this one's: Pi loads it in each Pi started after.
  if (policy.pi) { try { if (piExtensionStatus(piAgentDir()).state === "outdated") { installPiExtension(piAgentDir()); log("pi: updated 10and2's Pi extension"); } } catch (e) { log(`pi: ${describe(e)}`); } }
  if (policy.copilot) { try { if (updateCopilotExtension(copilotDir())) log("copilot: updated 10and2's Copilot extension"); } catch (e) { log(`copilot: ${describe(e)}`); } }
  if (policy.opencode) { try { const s = await openCodePluginStatus(); if (s.installed && !s.current) { await installOpenCodePlugin(); log("opencode: updated 10and2's OpenCode plugin"); } } catch (e) { log(`opencode: ${describe(e)}`); } }
  // Commands that wait's entries, where installed, name this connector's own settings and socket (setup may have run
  // with another XDG_RUNTIME_DIR, XDG_STATE_HOME or HOME than the service has), as this 10and2 writes them.
  if (policy.claude) { try { if (await refreshGate(claudeDir())) log("claude: the hook that holds commands on your list now names this connector's socket and settings"); } catch (e) { log(`claude: ${describe(e)}`); } }
  // Codex doesn't dedupe a message it's sent twice, so a lost outcome is never sent again.
  const codex = policy.codex ? new CodexAdapter({ policy, codexHome: defaultCodexHome(), db: join(stateDirectory(), "codex.db"), stateDir: join(stateDirectory(), "codex"), log }) : null;
  const opencode = policy.opencode ? new OpenCodeAdapter({ policy, db: join(stateDirectory(), "opencode.db"), stateDir: join(stateDirectory(), "opencode"), log }) : null;
  const cursor = policy.cursor ? new CursorAdapter({ policy, db: join(stateDirectory(), "cursor.db"), stateDir: join(stateDirectory(), "cursor"), log }) : null;
  const pi = policy.pi ? new PiAdapter({ policy, agentDir: piAgentDir(), db: join(stateDirectory(), "pi.db"), stateDir: join(stateDirectory(), "pi"), log }) : null;
  // Gemini CLI and Copilot CLI, through their ACP mode: neither dedupes a prompt, so a lost outcome is never sent again.
  const acp = (source: GeminiSource | CopilotSource) => new AcpAdapter({ policy, source, db: join(stateDirectory(), `${source.agent}.db`), stateDir: join(stateDirectory(), source.agent), log });
  const gemini = policy.gemini ? acp(new GeminiSource()) : null;
  const copilot = policy.copilot ? acp(new CopilotSource()) : null;
  const adapter = new Local([
    ...(t3 ? [{ prefix: "", adapter: t3, retrySafe: true }] : []),
    ...(claude ? [{ prefix: "claude", adapter: claude }] : []),
    ...(codex ? [{ prefix: "codex", adapter: codex }] : []),
    ...(pi ? [{ prefix: "pi", adapter: pi }] : []),
    ...(opencode ? [{ prefix: "opencode", adapter: opencode }] : []),
    ...(gemini ? [{ prefix: "gemini", adapter: gemini }] : []),
    ...(copilot ? [{ prefix: "copilot", adapter: copilot }] : []),
    ...(cursor ? [{ prefix: "cursor", adapter: cursor }] : []),
  ], policy, () => ledger.sends(), (key, found) => { try { ledger.claim(key, found); } catch (e) { log(`ledger: couldn't keep a send's message (${describe(e)})`); } });
  let privacyAsking = false;
  // Sends and starts set up for later, held here and run at their time while the link says nothing was stopped since.
  const schedules = new Schedules({ ledger, local: adapter, policy, device: deviceOf(token, parseCredential(token)?.deviceId), gate: () => link?.fireable() ?? false, log });
  const held = () => record({ schedules: schedules.summary() });
  schedules.watch(held);
  held();
  link = new Link({
    url: policy.brain, token, adapter, ledger, log, schedules,
    onRevoked: () => { try { schedules.revoke(); } catch (e) { log(`schedules: ${describe(e)}`); } },
    onFatal: () => { record({ error: "this computer was disconnected (revoked on the website, or set up again elsewhere)", fatal: true }); stop(fatalExit); },
    onView: (n) => {
      if (n.threads !== state.threads || n.projects !== state.projects) record(n);
      // Once every work system has been read: which protected folders macOS keeps from this program. The first ask
      // makes macOS show its prompt, at login, while someone is at the Mac; later views ask again (at most every 30 s
      // per folder), so `status` stops saying it once it's allowed (privacy.ts).
      if (!adapter.allLoaded || privacyAsking) return;
      privacyAsking = true;
      void adapter.privacy().then((privacy) => {
        for (const why of privacy) if (!state.privacy.includes(why)) log(`connector: ${why}`);
        if (JSON.stringify(privacy) !== JSON.stringify(state.privacy)) record({ privacy });
      }, () => {}).finally(() => { privacyAsking = false; });
    },
    onState: (s) => record({ linked: s.linked, ...(s.linked !== state.linked ? { since: new Date().toISOString() } : {}), ...(s.linked ? { error: null } : s.error ? { error: s.error } : {}) }),
  });
  link.start();
  schedules.start();
  log(`connector ${VERSION}: linking to ${origin}`);
  const proxy = proxyAdvice();
  if (proxy) log(`connector: ${proxy}`);
  // Running on, it leaves a first run that hasn't answered yet to finish (agents.ts onPath).
  void detect(process.env, undefined, true, (a) => !!policy[a]).then((found) => { for (const f of found) { const w = policy[f.agent] && f.installed ? versionWarning(f.agent, f.name, f.version) : null; if (w) log(`${f.agent}: ${w}`); } }, () => {});
  // T3 Code that can't be reached stops only itself; every other agent stays connected.
  void t3?.start().catch((e) => { log(`t3: ${describe(e)}; not restarting`); record({ t3Error: `T3 Code: ${describe(e)}` }); });
  void claude?.start().then(() => log("claude: reading sessions"), (e) => log(`claude: ${describe(e)}`));
  void codex?.start().then(() => log("codex: reading sessions"), (e) => log(`codex: ${describe(e)}`));
  void opencode?.start().then(() => log("opencode: reading sessions"), (e) => log(`opencode: ${describe(e)}`));
  void pi?.start().then(() => log("pi: reading sessions"), (e) => log(`pi: ${describe(e)}`));
  for (const a of [gemini, copilot]) void a?.start().then(() => log(`${a.name}: reading sessions`), (e) => log(`${a.name}: ${describe(e)}`));
  void cursor?.start().then(() => log("cursor: reading chats"), (e) => log(`cursor: ${describe(e)}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    link?.close();
    schedules.stop();
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
  await repairService(service);
  const s = await service.state();
  const st = readStatus();
  const alive = st?.pid ? connectorRunning(st.pid) : false;

  // A brain of your own has no website to approve this computer on, so plain setup can't connect it again.
  if (!cred && !token) bad(`Not connected to ${account(origin, key)}: ${cmd(paired(origin) ? "10and2 setup" : `10and2 setup --brain=${origin} --token`)} connects it.`);
  // A log that isn't there yet: it has never run (set up from a terminal run as administrator, on Windows).
  // Stopped for good (exit 78): its key was refused. Forgetting it is what connects it again.
  else if (!alive && st?.fatal) {
    bad(`Disconnected from ${account(origin, key)}${st.error ? `: ${st.error}` : ""}`);
    say(`  To connect it again: ${cmd("10and2 revoke")}, then ${cmd("10and2 setup")}.`);
  }
  else if (!alive) bad(`Not running. ${!s.installed ? `${cmd("10and2 autostart on")} keeps it running.` : isAbsolute(s.logs) && !existsSync(s.logs) ? "It starts at your next sign-in." : `It should start at login; see ${s.logs}`}${st?.error ? ` ${dim(`(last: ${st.error})`)}` : ""}`);
  else if (st.linked) ok(`Connected to ${account(origin, key)} ${dim(`· ${Date.now() - Date.parse(st.since) < 10_000 ? "just now" : `for ${ago(st.since)}`}`)}${st.threads !== undefined ? ` ${dim("·")} ${sizeText(st)}` : ""}`);
  else warn(`Connecting to ${account(origin, key)}${st.error ? `: ${st.error}` : ""}`);
  // What macOS keeps from the running connector (privacy.ts), as it last found.
  if (alive) for (const why of Array.isArray(st.privacy) ? st.privacy : []) warn(why);
  // T3 Code stopped on its own; the other agents are still connected.
  if (alive && typeof st.t3Error === "string") warn(`${st.t3Error}. The other agents stay connected; ${cmd(s.installed ? "10and2 autostart on" : "10and2 run")} restarts it to try T3 Code again.`);
  // Upgraded while it runs: the running one is still the old version until it restarts.
  if (alive && typeof st.version === "string" && st.version !== VERSION) warn(`It's running ${st.version}, and ${VERSION} is installed: ${s.installed ? `${cmd("10and2 autostart on")} restarts it with ${VERSION}` : `stop it and ${cmd("10and2 run")} again for ${VERSION}`}.`);
  // Not running is said once, above; running (here, or in another terminal), whether it also starts at login.
  if ((cred || token) && alive) {
    if (s.installed) (s.running ? ok : warn)(s.running ? "Starts at login" : `Starts at login, but isn't running: see ${s.logs}`);
    else note(dim(`Doesn't start at login (${cmd("10and2 autostart on")})`));
  }
  say();
  note(`Sees   ${seesText(policy)}`);
  for (const p of policy.unresolved ?? []) warn(`The project folder ${p} can't be found or read, so it's left out. Connect its drive, or take it out of "projects" in ${defaultPolicyPath()}.`);
  if (Array.isArray(policy.projects)) for (const p of policy.projects) if (!existsSync(p)) warn(`The project folder ${p} isn't there (moved, or its drive isn't connected), so there's nothing to see in it.`);
  // Each agent, and what Driver may do with it after the spoken yes (choose.ts).
  const choice = choiceOf(readPolicyFile());
  for (const a of ORDER) {
    if (!choice.on[a] && readPolicyFile()?.agents?.[a] === undefined) continue;
    const caps = capsFor(choice, a).map((c) => CAP_SHORT[c]).join(" · ") || "read only";
    note(`${NAMES[a].padEnd(12)} ${choice.on[a] ? `on    ${caps}` : dim("off")}`);
  }
  warnOld((await detect()).filter((f) => choice.on[f.agent]));
  if (policy.actions.includes("start_work")) {
    note(`New work runs with at most ${CEILING_LABEL[policy.maxRuntimeMode]}`);
    if (policy.t3) note(`New T3 Code worktrees start from ${baseText(policy.worktreeBase)}`);
  }
  // What a send or start set up for later may do here, as far as the actions allow it too.
  const rules = !policy.actions.includes("follow_up") ? "off" : rulesOf(policy) === "start" && !policy.actions.includes("start_work") ? "send" : rulesOf(policy);
  note(`For later    ${RULES_LABEL[rules]}`);
  note(`Documents    ${DOCUMENTS_LABEL[policy.documents ?? "off"]}`);
  const later: { at: string | null; said: string }[] = Array.isArray(st?.schedules) ? st.schedules : [];
  if (later.length) note(`Holding ${later.length} for later: ${later.map(heldText).join("; ")}`);
  if (policy.claude) {
    const h = await hooksStatus(claudeDir()).catch(() => null);
    if (!h?.installed) note(dim(hooksUnavailable(claudeDir()) ?? `${cmd("10and2 hooks install")} lets 10 & 2 answer Claude Code's questions, and makes updates instant`));
    // Commands that wait (Fable's 4-H1): how many kinds are on, and what waits now.
    const guard = policy.guard ?? [];
    if (guard.length) {
      const holds: HeldSummary[] = alive && st?.holds && typeof st.holds === "object" ? Object.values(st.holds as Record<string, HeldSummary[]>).flat().filter((x) => x && typeof x.command === "string") : [];
      const kinds = waitKinds(guard);
      note(`${WAIT_WORDS.heading}: ${kinds} ${kinds === 1 ? "kind" : "kinds"} on.${holds.length ? ` ${holds.length} waiting now: ${holds.map((x) => `${x.command}${x.thread ? ` (${x.thread})` : ""}`).join(", ")}.` : ""}`);
      if (!h?.gate) note(dim(`They don't wait yet: ${cmd("10and2 hooks install")} adds the hook that holds them.`));
      if (alive && st?.unheld) warn(`${st.unheld} ${st.unheld === 1 ? "command on your list was" : "commands on your list were"} stopped at once since it started (last ${ago(st.unheldAt)} ago): ${st.unheld === 1 ? "its session isn't" : "their sessions aren't"} one 10 & 2 shows (a headless claude -p, another app), so ${st.unheld === 1 ? "it" : "they"} couldn't wait for you`);
    }
    const db = join(stateDirectory(), "claude.db");
    if (existsSync(db)) {
      const conn = new DatabaseSync(databasePath(db), { readOnly: true });
      try {
        const runs = conn.prepare("SELECT sessionId, pid, procStart FROM claude_runs WHERE pid IS NOT NULL").all() as { sessionId: string; pid: number; procStart: string | null }[];
        // As the adapter tells a run from a later process given its pid (on Windows, perhaps another account's).
        const live = runs.filter((r) => pidState(r.pid, r.procStart) !== "dead");
        if (live.length) note(`Claude Code runs 10 & 2 started, still going: ${live.map((r) => `${r.sessionId} (pid ${r.pid})`).join(", ")}`);
      } catch { /* an older or empty database */ } finally { conn.close(); }
    }
  }
  note(dim(`Settings ${defaultPolicyPath()}`));
  if (flags.has("verbose")) {
    const device = cred ? parseCredential(cred.secret) : null;
    note(dim(!cred && !token ? "No key it can read" : `Key in ${cred ? where(cred.store) : "TENANDTWO_TOKEN"}${device ? `, device ${device.deviceId} of ${device.userId}` : ""}`));
    note(dim(`Link ${policy.brain}${st?.pid ? `, pid ${st.pid}, version ${st.version}` : ""}`));
  }
}

/** `10and2 revoke`; `uninstalling`, as part of `10and2 uninstall`, which says what's left itself. */
async function revoke(uninstalling = false) {
  const policy = readPolicyFile();
  const origin = policy?.brain ? originOf(policy.brain) : DEFAULT_ORIGIN;
  const creds = new Credentials();
  const cred = await creds.load(origin).catch(() => null);
  if (!cred) say(`This computer isn't connected to ${account(origin)}.`);
  if (cred && !flags.has("yes") && !await confirm(`Disconnect this computer from ${account(origin, cred.secret)}?`, true)) throw new Cancelled();
  if (cred && !paired(origin, cred.secret)) note(`Your brain still accepts this computer's old key until you remove it there: ${cmd("10and2 brain remove <name>")}.`);
  else if (cred) {
    const spin = spinner("Disconnecting");
    try {
      const res = await fetch(`${origin}/connector/revoke`, { method: "POST", headers: { authorization: `Bearer ${cred.secret}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok || res.status === 401) spin.ok(`Disconnected from ${account(origin, cred.secret)}`);
      else spin.warn(`10 & 2 didn't confirm it (error ${res.status}): remove this computer on your account page too`);
    } catch { spin.warn(`Couldn't reach ${hostOf(origin)}: remove this computer on your account page too`); }
  }
  await new Service().uninstall();
  // What it held for later goes with it. A connector still running here (by hand) holds the database, and cancels them
  // itself when 10 & 2 tells it it's disconnected.
  try {
    const db = join(stateDirectory(), "connector.db");
    if (existsSync(db)) { const conn = new DatabaseSync(db); try { cancelWaiting(conn); } finally { conn.close(); } }
  } catch { /* held by a running connector */ }
  await creds.delete(origin);
  rmSync(statusFile(), { force: true });
  if (cred) ok(`Forgot its key, and it no longer starts at login${uninstalling ? "" : ` ${dim(`· your settings stay in ${defaultPolicyPath()}; ${cmd("10and2 uninstall")} removes everything`)}`}`);
}

/**
 * What Claude Code's hooks run. This Node and this 10and2 first, as setup ran them: Claude Code started from the
 * desktop app has hardly any PATH, and in a project whose .nvmrc picks another Node, PATH's 10and2 is missing or runs
 * on a Node too old for it. Once either is gone (an upgrade), the `10and2` on PATH. Windows runs the hooks in Git Bash,
 * where that's `10and2`; a checkout's hooks run `10and2` too. As a shell function (`hookLauncher`), so a Commands that
 * wait entry's own arguments reach whichever runs and its `|| … exit 2` still fails closed (the engine's stage 4c).
 */
function hookCommand(): string {
  if (process.env.TENANDTWO_COMMAND) return process.env.TENANDTWO_COMMAND;
  const l = launch();
  if (process.platform === "win32" || checkout(l) || temporary(l)) return "10and2";
  return hookLauncher(process.execPath, realpathOr(process.argv[1]));
}
function realpathOr(p: string) { try { return realpathSync(p); } catch { return p; } }

/**
 * `10and2 uninstall`: everything 10and2 added to this computer, gone: disconnected, no longer started at login (nor a
 * brain of your own), its Claude Code hooks, Pi extension, OpenCode plugin and Copilot extension removed, and its
 * settings, key and files deleted. Each part is tried even when one fails. The program itself is the package manager's
 * to remove, said last.
 */
async function uninstall() {
  if (!flags.has("yes") && !await confirm(`Remove 10and2 from this computer? It disconnects it, stops it starting at login, removes its Claude Code hooks, Pi extension, OpenCode plugin and Copilot extension, and deletes its settings and files (${configDirectory()}, ${stateDirectory()})`, true)) throw new Cancelled();
  flags.set("yes", "true");
  const step = async (what: string, f: () => Promise<boolean | void>) => {
    try { if (await f() !== false) ok(what); } catch (e) { warn(`Couldn't ${what.charAt(0).toLowerCase()}${what.slice(1)} (${describe(e)})`); }
  };
  const policy = (() => { try { return readPolicyFile(); } catch { return null; } })();
  const origin = policy?.brain ? originOf(policy.brain) : DEFAULT_ORIGIN;
  if (await new Credentials().load(origin).catch(() => null)) await revoke(true);
  await step("Stopped, and no longer starts at login", async () => { await new Service().uninstall(); await new Service({ job: BRAIN }).uninstall(); });
  await step("Removed its Claude Code hooks", async () => {
    if (!(await hooksStatus(claudeDir())).events.length) return false;
    await uninstallHooks(claudeDir());
  });
  await step("Removed its Pi extension", async () => {
    if (!["installed", "outdated"].includes(piExtensionStatus(piAgentDir()).state)) return false;
    uninstallPiExtension(piAgentDir());
  });
  await step("Removed its OpenCode plugin", async () => {
    if (!(await openCodePluginStatus()).installed) return false;
    await uninstallOpenCodePlugin();
  });
  await step("Removed its Copilot extension", async () => {
    if (!["installed", "outdated", "off"].includes(copilotExtensionStatus(copilotDir()).state)) return false;
    uninstallCopilotExtension(copilotDir());
  });
  await step(`Deleted its settings and files`, async () => {
    for (const dir of [configDirectory(), stateDirectory(), ...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, "10and2")] : [])]) rmSync(dir, { recursive: true, force: true });
  });
  say(`
  Last, remove the program itself: ${cmd(removeCommand())}`);
}
/** How this copy of 10and2 was installed, as the command that removes it. */
function removeCommand(): string {
  const at = realpathOr(process.argv[1]).replace(/\\/g, "/");
  return at.includes("/.volta/") ? "volta uninstall 10and2" : at.includes("/pnpm/") ? "pnpm remove -g 10and2" : at.includes("/nix/store/") ? "nix profile remove 10and2" : "npm uninstall -g 10and2";
}

async function autostart() {
  const service = new Service();
  if (sub === "on") {
    // Not set up, it would only exit at each sign-in.
    const policy = readPolicyFile();
    if (!policy) throw new Error(`This computer isn't set up yet: ${cmd("10and2 setup")} connects it.`);
    const s = await service.install(launch());
    if (s.elevated) { startsAtSignIn(s, "10and2 autostart on"); return; }
    if (!s.running) { warn(`Installed at ${s.where}, but not running: see ${s.logs}`); return; }
    ok("Starts at login, and (re)started now");
    if (s.note) note(s.note);
    if (policy.brain) await connected(originOf(policy.brain), (await new Credentials().load(originOf(policy.brain)).catch(() => null))?.secret);
  }
  else if (sub === "off") { await service.uninstall(); ok("Stopped, and no longer starts at login"); }
  else if (sub === "status" || sub === undefined) { const s = await service.state(); say(s.installed ? `${s.running ? "Running" : "Not running"}; starts at login ${dim(`(${s.where})`)}.` : "Doesn't start at login."); }
  else throw new Error(`${cmd("10and2 autostart")} takes on, off or status.`);
}

async function hooks() {
  // Hooks edit the user's own Claude Code settings, so they're only ever installed or removed when asked (here, or by
  // setup's question).
  if (sub === "install") await installHooks(claudeDir(), hookCommand(), (readGuard() ?? ["?"]).length > 0);
  else if (sub === "uninstall") await uninstallHooks(claudeDir());
  else if (sub !== "status") throw new Error(`${cmd("10and2 hooks")} takes install, uninstall or status.`);
  const s = await hooksStatus(claudeDir());
  say(s.installed ? `10and2's Claude Code hooks are installed in ${claudeDir()}.` : s.events.length ? `Some of 10and2's Claude Code hooks are installed: ${s.events.join(", ")}.` : `10and2's Claude Code hooks aren't installed in ${claudeDir()}.`);
}

/** `10and2 pi …`: 10and2's extension in Pi's own extensions folder, asked for here or by setup's question. */
function piCommand() {
  const dir = piAgentDir();
  const s = sub === "install" ? installPiExtension(dir) : sub === "uninstall" ? uninstallPiExtension(dir) : sub === "status" ? piExtensionStatus(dir) : null;
  if (!s) throw new Error(`${cmd("10and2 pi")} takes install, uninstall or status.`);
  say({
    installed: `10and2's Pi extension is installed (${s.path}). Pi sessions started from now on can be reached; one already open needs restarting.`,
    outdated: `An older copy of 10and2's Pi extension is installed (${s.path}). ${cmd("10and2 pi install")} updates it.`,
    missing: `10and2's Pi extension isn't installed${sub === "uninstall" ? " anymore" : ""}. ${cmd("10and2 pi install")} adds it.`,
    foreign: `${s.path} is another extension, not 10and2's, so it's left as it is.`,
  }[s.state]);
}

/** `10and2 copilot …`: 10and2's extension in Copilot's own extensions folder, with Copilot's experimental features on. */
function copilotCommand() {
  const dir = copilotDir();
  const s = sub === "install" ? installCopilotExtension(dir) : sub === "uninstall" ? uninstallCopilotExtension(dir) : sub === "status" ? copilotExtensionStatus(dir) : null;
  if (!s) throw new Error(`${cmd("10and2 copilot")} takes install, uninstall or status.`);
  say({
    installed: `10and2's Copilot extension is installed (${s.path}), and Copilot's experimental features are on. A Copilot started from now on, in a folder you trust in it, can be reached; one already open needs restarting.`,
    outdated: `An older copy of 10and2's Copilot extension is installed (${s.path}). ${cmd("10and2 copilot install")} updates it.`,
    off: `10and2's Copilot extension is installed (${s.path}), but Copilot's experimental features are off, so Copilot doesn't load it. ${cmd("10and2 copilot install")} turns them on.`,
    missing: `10and2's Copilot extension isn't installed${sub === "uninstall" ? " anymore" : ""}. ${cmd("10and2 copilot install")} adds it, and turns on Copilot's experimental features, which extensions need.`,
    foreign: `${s.path} is another extension, not 10and2's, so it's left as it is.`,
  }[s.state]);
}

/** `10and2 opencode …`: 10and2's plugin in OpenCode's own plugins folder, asked for here or by setup's question. */
async function openCodeCommand() {
  if (sub === "install") await installOpenCodePlugin();
  else if (sub === "uninstall") await uninstallOpenCodePlugin();
  else if (sub !== "status") throw new Error(`${cmd("10and2 opencode")} takes install, uninstall or status.`);
  const s = await openCodePluginStatus();
  say(!s.installed ? `10and2's OpenCode plugin isn't installed${sub === "uninstall" ? " anymore" : ""}. ${cmd("10and2 opencode install")} adds it.`
    : !s.current ? `An older copy of 10and2's OpenCode plugin is installed (${s.path}). ${cmd("10and2 opencode install")} updates it.`
    : `10and2's OpenCode plugin is installed (${s.path}). OpenCode started from now on can be reached; one already open needs restarting.`);
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
        if (s.elevated) startsAtSignIn(s, "10and2 brain autostart on");
        else if (s.running) ok("Your brain starts at login, and (re)started now"); else warn(`Installed at ${s.where}, but not running: see ${s.logs}`);
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
  const { found, choice } = await chooseAgents("10and2 brain setup", existing);
  // From the environment when it's there (a script, or pasted where nobody sees it), else asked for without showing it.
  const key = process.env.OPENAI_API_KEY || await secret(`Your OpenAI API key ${dim("(from platform.openai.com; it stays on this computer)")}`); // provider-name-ok: which key to make (Jordan, 5 Nov)
  if (!key) throw new Error("Your brain needs your OpenAI API key, to talk and to read your threads. Run this again in a terminal, or with the key in OPENAI_API_KEY.");
  const name = await machineName();
  say();

  const origin = `http://127.0.0.1:${port}`;
  const policy = withDocuments(await policyFor(origin, existing, choice), await documentsFor(existing));
  // This computer's own connector, linked to it over loopback with a token only the two of them know.
  const token = randomBytes(32).toString("base64url");
  const vars = addMachine({
    OPENAI_API_KEY: key,
    // The phone sends it with every request (Settings → Advanced → Self-hosted brain).
    DRIVER_ACCESS_CODE: randomBytes(18).toString("base64url"),
    DRIVER_PORT: String(port),
  }, { name, tokenSha256: sha256(token), local: true });
  writeBrainEnv(vars, path);
  const saving = spinner("Saving this computer's key");
  const store = await new Credentials().save(origin, token).finally(() => saving.clear());
  writePrivate(defaultPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
  ok(`Set up ${dim(`· your key and its settings are in ${path}, which only you can read`)}`);
  if (store !== "file") ok(`This computer's key to it is in ${where(store)}`);

  const brain = await startAtLogin(service, "Run your brain, and keep this computer connected to it, starting at login?", "10and2 brain autostart on", "10and2 autostart on");
  // From a terminal run as administrator the brain starts at the next sign-in, and this computer's connection with it,
  // so neither is waited for now.
  if (brain?.running || brain?.elevated) {
    const s = await new Service().install(launch());
    if (s.elevated) { if (!brain.elevated) startsAtSignIn(s, "10and2 autostart on"); }
    else if (s.running) await connected(origin, token);
    else warn(`This computer's connection is installed at ${s.where}, but isn't running: see ${s.logs}`);
  } else note(`To run it: ${cmd("10and2 brain run")} and ${cmd("10and2 run")}, each in a terminal you keep open; or ${cmd("10and2 brain autostart on")} and ${cmd("10and2 autostart on")}.`);
  canDo(policy, choice, found);
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
  await repairService(service);
  const origin = brainOrigin(vars);
  const up = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const s = await service.state();
  if (!up) bad(`Not running. ${!s.installed ? `${cmd("10and2 brain run")} runs it, or ${cmd("10and2 brain autostart on")}.` : isAbsolute(s.logs) && !existsSync(s.logs) ? "It starts at your next sign-in." : `It should start at login; see ${s.logs}`}`);
  else {
    ok(`Running at ${origin}`);
    if (s.installed) (s.running ? ok : warn)(s.running ? "Starts at login" : `Starts at login, but isn't running: see ${s.logs}`);
    else note(dim(`Doesn't start at login (${cmd("10and2 brain autostart on")})`));
  }
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
  // The brain shuts down on SIGTERM; on Windows its supervisor asks over IPC instead, and the console has its own signals.
  stopLikeSigterm();
  await import(bundle.href);
}
