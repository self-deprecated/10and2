import { readFile, writeFile, copyFile, mkdir, chmod, unlink } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { sessionId } from "./registry.ts";
import { matchesOf } from "../guard.ts";
import { hidesCode, shownWhole } from "../gate.ts";
import { defaultPolicyPath, readGuard } from "../policy.ts";
import { proves, randomHex, replaceFile } from "../util.ts";
import { hookSocket, type HookSocket } from "../paths.ts";
import { envVar, which } from "../command.ts";

/** Events that only make a change show up at once: asynchronous, so they never hold Claude up. */
const NOTIFY = ["SessionStart", "SessionEnd", "Stop", "Notification"];
/**
 * Claude's own questions (AskUserQuestion) and its plan's "go ahead?" (ExitPlanMode) wait on this one, so Driver can
 * answer by voice: Claude Code shows them in the terminal meanwhile, and whichever answers first wins. It returns at
 * once, deciding nothing, when the connector isn't running or doesn't take it; it waits at most six hours. It never
 * decides any other tool's permission.
 */
const ASK = { event: "PermissionRequest", matcher: "AskUserQuestion|ExitPlanMode", timeout: 21_600 };
const ASKING = ["AskUserQuestion", "ExitPlanMode"];
/**
 * Commands that wait (docs/launch/engine.md §11 stage 4; spike/two-key-hold): every Bash call asks this one first,
 * installed only while this computer's list has something on it. A command nothing on the list matches (policy.ts
 * `guard`, read here) passes at once, deciding nothing, with no socket round trip. One that matches waits while 10 & 2
 * shows it on the phone: Let it run hands it back to Claude Code's own permission mode (this prints nothing); Stop it,
 * the user's words, no answer in time, or no connector to hold it denies it. 10 & 2 never allows anything here.
 */
export const GATE = { event: "PreToolUse", matcher: "Bash", timeout: 21_600 };
/**
 * Edit, Write and MultiEdit ask this one, installed with the gate, only so the agent can't change the list's own
 * settings with them (`GATE_SETTINGS`). Its own entry, with no fallback: a `10and2 hook` that can't start decides
 * nothing here, so a broken install never blocks every file edit (stage 4's fix4 review); the Bash entry still fails
 * closed.
 */
export const FILES = { event: "PreToolUse", matcher: "Edit|Write|MultiEdit", timeout: 60 };
/** The tools that write a file, which may change any file but the gate's own settings (`hookProtects`). */
const FILE_TOOLS = ["Edit", "Write", "MultiEdit"];
const EVENTS = [...NOTIFY, ASK.event, GATE.event];
/** Why a command on the list wasn't run, said to Claude when there's no connector to hold it (Fable's 4-H3). */
export const GATE_NOT_RUNNING = "Not run: this command is on the user's list of commands 10 & 2 holds for their OK on their phone, and 10 & 2 isn't running on this computer to ask them. Don't run it another way; ask the user to run it themselves.";
const MARKER = " # 10and2-hook";
/** A word for the shell, quoted as it is. */
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The gate's entry: Claude Code treats a hook that fails any other way than exit code 2 as deciding nothing, so the
 * command would run. A `10and2 hook` that can't start (not on PATH under an IDE or T3 Code, a broken install) or exits
 * with an error blocks it instead, with why on stderr, which Claude Code shows the agent. It names this computer's
 * settings (`policy`, connector.json) and the connector's socket (`socket`, none on Windows: `entrySocket`) by their
 * full paths, so a session whose own XDG_CONFIG_HOME, XDG_RUNTIME_DIR or HOME differs (an IDE, a direnv or Nix shell,
 * T3 Code) reads the same list and is held by the same connector; there, a missing file is a list not known (fails
 * closed). It names the Claude Code settings it's written in too (`settings`): neither those nor the list's may the
 * agent change with Edit, Write or MultiEdit (`hookProtects`).
 */
export const gateCommand = (command: string, policy: string, socket: string | null, settings: string) =>
  `${command} hook --policy ${quoted(policy)}${socket === null ? "" : ` --socket ${quoted(socket)}`} --settings ${quoted(settings)} || { echo "${HOOK_FAILED}" >&2; exit 2; }${MARKER}`;
/** The file tools' entry (`FILES`): the same settings named, and nothing done when it can't start. */
export const filesCommand = (command: string, policy: string, settings: string) =>
  `${command} hook --policy ${quoted(policy)} --settings ${quoted(settings)}${MARKER}`;
/** Said to the agent by the gate's entry itself when `10and2 hook` fails (no quotes or `$`: it's inside the shell's). */
export const HOOK_FAILED = "Not run: the 10and2 hook could not check this command against the user's list of commands that wait for their OK. Don't run it another way; ask the user to run it themselves.";
/** The settings (connector.json) can't be read, so the list isn't known: every Bash call waits on it (fails closed). */
export const GATE_UNREADABLE = "Not run: 10 & 2 can't read this computer's settings (connector.json), so it can't tell whether this command is on the user's list of commands it holds for their OK. Don't run it another way; ask the user to fix the settings (10and2 status says what's wrong).";
/**
 * Where `10and2 hook` reads the list (`args`, its command line): the settings its entry names (`--policy`, the gate's
 * entry, there only while they have a list, so a missing file is a list not known), else the default place.
 */
export const hookGuard = (args: readonly string[]) => {
  const policy = argOf(args, "--policy");
  return () => (policy ? readGuard(policy, null) : readGuard());
};
/** The connector's socket `10and2 hook` asks: the one its entry names (`--socket`), else the one this environment finds. */
export const hookSocketOf = (args: readonly string[]) => argOf(args, "--socket") ?? hookSocket();
/**
 * The socket the gate's entry names (`--socket`): this environment's socket file. None on Windows, whose pipe is new at
 * each start and proves itself with the secret beside its name (hooks.pipe), which `10and2 hook` reads there itself.
 */
const entrySocket = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) => (platform === "win32" ? null : hookSocket(env, platform)!.path);
/** The files the agent may not change with Edit, Write or MultiEdit: the list's settings and the gate's own entry's. */
export const hookProtects = (args: readonly string[]) => [argOf(args, "--policy") ?? defaultPolicyPath(), ...(argOf(args, "--settings") ? [argOf(args, "--settings")!] : [])];
/** `10and2 hook` (`args`, its command line): one event relayed, with the list, socket and settings its entry names. */
export const runHook = (args: readonly string[]) => relayHook(process.stdin, hookSocketOf(args), undefined, hookGuard(args), hookProtects(args));
const argOf = (args: readonly string[], flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : undefined;
};
/**
 * One call running two or more commands on the list: one tap would let them all run while the phone names one (the
 * code review of stage 4), so it's never held. Each on its own is held and shown.
 */
export const GATE_ONE_EACH = "Not run: this call runs more than one command on the user's list of commands 10 & 2 holds for their OK on their phone, and one OK would let them all run. Run each of them on its own, so the user sees each one.";
/** A call with a command on the list that's longer than the phone shows whole (gate.ts `SHOWN_MAX`): never held either. */
export const GATE_TOO_LONG = "Not run: this call runs a command on the user's list of commands 10 & 2 holds for their OK on their phone, and it's too long for their phone to show whole. Run that command on its own, in a shorter call, so the user sees all of what they let run.";
/**
 * A call whose credential-shaped part, masked on the phone, could hide more than its value (gate.ts `hidesCode`): never
 * held either. Says what would work, so an agent doesn't try the same call again (Fable's should on fix4).
 */
export const GATE_MASKED = "Not run: this call runs a command on the user's list of commands 10 & 2 holds for their OK on their phone, and a credential in it would be masked there in a way that could hide other words (a space, a quote, a backslash, braces, brackets, a wildcard or shell code in its value), so they wouldn't see all of what they let run. Give that value another way, such as a variable set beforehand or a file, and run the command on its own.";
/**
 * Edit, Write or MultiEdit on the list's settings (connector.json) or on the Claude Code settings the gate's entry is in:
 * the agent it holds could empty the list or take the entry out (stage 4's final review). A Bash command that writes
 * them isn't seen (engine.md, "Stage 4's final review").
 */
export const GATE_SETTINGS = "Not run: this file holds the settings of the commands 10 & 2 holds for the user's OK on their phone, which only the user changes. Don't change it another way; ask the user to change it themselves.";
/** The call itself couldn't be read (too long, cut short, not JSON), so it can't be checked against the list. */
export const GATE_UNCHECKED = "Not run: 10 & 2 couldn't check this command against the user's list of commands it holds for their OK (it was too long or couldn't be read). Don't run it another way; split it into smaller commands, or ask the user to run it themselves.";
/** The most of a hook's input read; a Bash call longer than this can't be checked, so with a list it's refused. */
export const MAX_HOOK_INPUT = 4 * 1024 * 1024;
/** How long the hook waits for Claude Code to finish writing its input (it writes it and closes stdin at once). */
const STDIN_MS = 10_000;
const ours = (h: any) => h?.type === "command" && typeof h.command === "string" && h.command.endsWith(MARKER);

async function settings(configDir: string): Promise<any> {
  try {
    // Windows PowerShell 5.1 (and some editors) save UTF-8 with a byte-order mark, which JSON.parse refuses.
    const s = JSON.parse((await readFile(join(configDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (!s || typeof s !== "object" || Array.isArray(s) || (s.hooks !== undefined && (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)))) throw new Error("Claude settings are not an object");
    return s;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}

/**
 * Writes Claude Code's settings. A settings.json that's a link (stow, home-manager, chezmoi) stays one: its target is
 * written instead. What was there before is kept as one backup beside it (`settings.json.driver-backup`), replaced at
 * each save, never one more file per save. Only you can read either (your own permissions on the file otherwise kept).
 */
async function save(configDir: string, s: any): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const link = join(configDir, "settings.json");
  let path = link;
  let mode = 0o600;
  try {
    if (lstatSync(link).isSymbolicLink()) path = realpathSync(link);
    mode = (statSync(path).mode & 0o700) | 0o600;
    const backup = `${link}.driver-backup`;
    await copyFile(path, backup); await chmod(backup, 0o600);
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const payload = JSON.stringify(s, null, 2) + "\n";
  const writeTo = async (dest: string) => {
    const tmp = join(dirname(dest), `.${basename(dest)}.driver-${randomUUID()}`);
    try {
      await writeFile(tmp, payload, { mode });
      await chmod(tmp, mode);
      replaceFile(tmp, dest);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  };
  try {
    await writeTo(path);
  } catch (e) {
    // A symlink into a read-only store (e.g. Nix Home Manager `/nix/store`): fall back to writing beside the link.
    const code = (e as NodeJS.ErrnoException).code;
    if (path !== link && (code === "EACCES" || code === "EPERM" || code === "EROFS")) await writeTo(link);
    else throw e;
  }
}

function remove(s: any) {
  for (const event of EVENTS) {
    if (!Array.isArray(s.hooks?.[event])) continue;
    s.hooks[event] = s.hooks[event].flatMap((entry: any) => {
      if (!Array.isArray(entry?.hooks) || !entry.hooks.some(ours)) return [entry];
      const hooks = entry.hooks.filter((h: any) => !ours(h));
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    if (!s.hooks[event].length) delete s.hooks[event];
  }
}

/**
 * Git Bash, which Claude Code runs hooks in on Windows, found exactly as Claude Code (2.1.325) finds it, so the hooks are
 * added only where Claude will run them there: CLAUDE_CODE_GIT_BASH_PATH when it names a bash or sh that exists, else
 * Git for Windows under Program Files (either one), else beside the `git` on PATH (Git for Windows' cmd\git.exe and
 * bin\bash.exe). Claude Code doesn't look in a per-user install's folder, so neither does this.
 */
export function gitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  const set = envVar(env, "CLAUDE_CODE_GIT_BASH_PATH");
  const git = which("git", env, platform);
  const roots = [envVar(env, "ProgramFiles") && join(envVar(env, "ProgramFiles")!, "Git"),
    envVar(env, "ProgramFiles(x86)") && join(envVar(env, "ProgramFiles(x86)")!, "Git"), git && dirname(dirname(git))];
  return [set && ["bash.exe", "sh.exe", "bash", "sh"].includes(win32.basename(set).toLowerCase()) ? set : null,
    ...roots.map((r) => r && join(r, "bin", "bash.exe"))].find((p): p is string => !!p && isFile(p)) ?? null;
}

/**
 * The environment as Claude Code sees it for CLAUDE_CODE_GIT_BASH_PATH: its settings.json's "env" is set over its own
 * environment, so a value there wins (even one that isn't a shell, which sends Claude Code on to look for Git).
 */
function claudeEnv(configDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    const set = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""))?.env;
    const path = set && typeof set === "object" ? envVar(set, "CLAUDE_CODE_GIT_BASH_PATH") : undefined;
    if (typeof path === "string") return { ...env, CLAUDE_CODE_GIT_BASH_PATH: path };
  } catch { /* No settings, or ones Claude Code can't read either: its own environment. */ }
  return env;
}

/**
 * Why the hooks can't be added here, or null. Without Git Bash, Claude Code on Windows runs hooks in PowerShell, where
 * a question hook that fails (10and2 not on that Claude's PATH, or uninstalled) denies Claude's question instead of
 * leaving it to the terminal. Nearly everyone there has Git for Windows, so the hooks are left out rather than shaped
 * for PowerShell (Jordan, 20 November: a doctor check, kept simple).
 */
export function hooksUnavailable(configDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" && !gitBash(claudeEnv(configDir, env), platform)
    ? "Claude Code runs these hooks in Git Bash, which isn't on this computer. Install Git for Windows (git-scm.com), then run 10and2 hooks install."
    : null;
}

/**
 * Adds 10 & 2's hooks, keeping the user's own. Refuses where they can't work (hooksUnavailable). `gate`: with Commands
 * that wait's PreToolUse hooks too (`FILES`, then `GATE`), only while this computer's list has something on it, so a
 * computer without one starts no hook on each Bash call. Installing again without it takes it out. `socket`: the one
 * the gate's entry names, else this environment's (`entrySocket`).
 */
export async function installHooks(configDir: string, command: string, gate = false, policy = defaultPolicyPath(), socket?: string | null, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Hook command must be a single nonempty command");
  const unavailable = hooksUnavailable(configDir, env, platform);
  if (unavailable) throw new Error(unavailable);
  const s = await settings(configDir), before = JSON.stringify(s);
  withHooks(s, join(configDir, "settings.json"), command, gate, policy, socket === undefined ? entrySocket(platform, env) : socket);
  if (JSON.stringify(s) !== before) await save(configDir, s);
}

/** `s` (Claude Code's settings) with 10and2's hooks as `installHooks` writes them, its own taken out first. */
function withHooks(s: any, entryIn: string, command: string, gate: boolean, policy: string, socket: string | null) {
  remove(s); s.hooks ??= {};
  for (const event of gate ? EVENTS : EVENTS.filter((e) => e !== GATE.event)) {
    if (s.hooks[event] !== undefined && !Array.isArray(s.hooks[event])) throw new Error(`Claude ${event} hooks are not a list`);
    const entries = event === GATE.event
      ? [{ matcher: FILES.matcher, hooks: [{ type: "command", command: filesCommand(command, policy, entryIn), timeout: FILES.timeout }] },
        { matcher: GATE.matcher, hooks: [{ type: "command", command: gateCommand(command, policy, socket, entryIn), timeout: GATE.timeout }] }]
      : event === ASK.event ? [{ matcher: ASK.matcher, hooks: [{ type: "command", command: `${command} hook${MARKER}`, timeout: ASK.timeout }] }]
      : [{ hooks: [{ type: "command", command: `${command} hook${MARKER}`, async: true }] }];
    (s.hooks[event] ??= []).push(...entries);
  }
}

/**
 * The running connector's own look at the gate's entries, as it starts: where they're installed, rewritten as this
 * connector would write them (its settings, its socket, `FILES` beside `GATE`) when they differ, with the command
 * they already run (taken from 10and2's other hooks), so the socket a session asks is the one the connector listens at,
 * whatever the environment setup ran in, and an entry from an older 10and2 is brought up to this one's. True when
 * rewritten; nothing is added where the gate isn't installed.
 */
export async function refreshGate(configDir: string, policy = defaultPolicyPath(), socket = entrySocket()): Promise<boolean> {
  const s = await settings(configDir), before = JSON.stringify(s);
  const of = (event: string): string[] => (Array.isArray(s.hooks?.[event]) ? s.hooks[event] : [])
    .flatMap((x: any) => (Array.isArray(x?.hooks) ? x.hooks : []).filter(ours).map((h: any) => h.command as string));
  // The command 10and2's other hooks run (`<command> hook # 10and2-hook`): the gate's is the same.
  const plain = [...NOTIFY, ASK.event].flatMap(of).find((c) => c.endsWith(` hook${MARKER}`));
  if (!of(GATE.event).length || !plain) return false;
  withHooks(s, join(configDir, "settings.json"), plain.slice(0, -` hook${MARKER}`.length), true, policy, socket);
  if (JSON.stringify(s) === before) return false;
  await save(configDir, s);
  return true;
}

export async function uninstallHooks(configDir: string): Promise<void> {
  const s = await settings(configDir), before = JSON.stringify(s);
  remove(s);
  if (JSON.stringify(s) !== before) await save(configDir, s);
}

/** `installed`: the hooks every computer needs; `gate`: Commands that wait's too. */
export async function hooksStatus(configDir: string): Promise<{ installed: boolean; events: string[]; gate: boolean }> {
  const s = await settings(configDir);
  const events = EVENTS.filter((event) => Array.isArray(s.hooks?.[event]) && s.hooks[event].some((e: any) => Array.isArray(e.hooks) && e.hooks.some(ours)));
  return { installed: EVENTS.every((e) => e === GATE.event || events.includes(e)), events, gate: events.includes(GATE.event) };
}

/** A hook's input as read: all of it (`complete`), or as much as came before it was too long or never finished. */
type Input = { text: string; complete: boolean };

function readInput(stdin: string | NodeJS.ReadableStream): Promise<Input> {
  if (typeof stdin === "string") return Promise.resolve({ text: stdin, complete: stdin.length <= MAX_HOOK_INPUT });
  return new Promise<Input>((resolve) => {
    let text = "", done = false;
    const finish = (complete: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer); stdin.removeListener("data", data); stdin.removeListener("end", ended); stdin.removeListener("error", failed); stdin.pause();
      resolve({ text, complete });
    };
    const data = (b: Buffer | string) => { text += b.toString(); if (text.length > MAX_HOOK_INPUT) finish(false); };
    const ended = () => finish(true), failed = () => finish(false);
    const timer = setTimeout(() => finish(false), STDIN_MS); timer.unref();
    stdin.on("data", data); stdin.once("end", ended); stdin.once("error", failed);
  });
}

/**
 * How long a notification waits for the connector to connect and, with a secret, prove itself: a busy connector may
 * take a moment, and nothing waits on it meanwhile (notifications are asynchronous).
 */
const REACH_MS = 5000;
/**
 * How long a question waits for it: a minute, since the terminal shows the question meanwhile, and a connector that's
 * busy for a while should still get the question once it's free.
 */
const ASK_REACH_MS = 60_000;

/**
 * A connection to the adapter, once it has shown it's this user's connector. With a secret (Windows, from hooks.pipe)
 * it must first answer a fresh nonce with proof(secret, nonce): another account can see a pipe's name and take it once
 * the connector that had it has stopped, but can't read the secret. Null, as when nothing listens, when it doesn't.
 */
function reach({ path, secret }: HookSocket, ms = REACH_MS): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path), nonce = randomHex();
    let text = "";
    const settle = (ok: boolean) => {
      clearTimeout(timer); socket.off("error", fail).off("close", fail).off("data", data);
      if (ok) resolve(socket); else { socket.destroy(); resolve(null); }
    };
    const fail = () => settle(false);
    const data = (b: Buffer) => {
      text += b.toString();
      const end = text.indexOf("\n");
      if (end >= 0) settle(proves(text.slice(0, end), secret!, nonce)); else if (text.length > 128) fail();
    };
    const timer = setTimeout(fail, ms);
    socket.on("error", fail).on("close", fail);
    socket.on("connect", () => {
      if (secret === null) { settle(true); return; }
      socket.on("data", data);
      socket.write(JSON.stringify({ nonce }) + "\n");
    });
  });
}

/**
 * Best effort only: a stopped connector must never hold up Claude's own hooks. A null socket is no connector listening
 * (on Windows, none has named its pipe yet); a bare path is a socket file, which its private folder keeps to the user.
 * The one exception is Commands that wait's PreToolUse call (`guard`, read only for it): it fails closed. A command on
 * the list with no connector to hold it (none listening included), a list that can't be read (`guard` null or
 * throwing), or a call that can't be read whole while there's a list (too long, cut short, not JSON, any error checking
 * it) is denied; it passes only when it's certain nothing on the list matches it.
 */
export async function relayHook(stdin: string | NodeJS.ReadableStream, socket: HookSocket | string | null, out: (s: string) => void = (s) => { process.stdout.write(s); },
  guard: () => readonly string[] | null = () => [], protects: readonly string[] = []): Promise<void> {
  const target = socket === null ? null : typeof socket === "string" ? { path: socket, secret: null } : socket;
  let input: Input;
  try { input = await readInput(stdin); } catch { input = { text: "", complete: false }; }
  let r: any = null;
  if (input.complete) { try { r = JSON.parse(input.text); } catch { r = null; } }
  if (r && (typeof r !== "object" || Array.isArray(r))) r = null;
  // The event, from the call, or from its raw text when it can't be read (Claude Code names it near the start).
  if (r ? r.hook_event_name === GATE.event : /"hook_event_name"\s*:\s*"PreToolUse"/.test(input.text)) return gateHook(r, input.text, target, out, guard, protects);
  if (!r || target === null) return;
  try {
    if (!sessionId(r.session_id) || !EVENTS.includes(r.hook_event_name)) return;
    if (r.hook_event_name === ASK.event) { await waitForAnswer(r, target, out); return; }
    const event = { session_id: r.session_id, hook_event_name: r.hook_event_name,
      notification_type: typeof r.notification_type === "string" ? r.notification_type.slice(0, 100) : undefined };
    const socket = await reach(target);
    if (!socket) return;
    // Waited for, 150 ms at most: let go of, 10and2 could end first with this still pending (Node's exit 13 and its
    // warning, which Claude Code shows as the hook failing).
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 150);
      socket.on("error", () => { clearTimeout(timer); resolve(); });
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.end(JSON.stringify(event) + "\n");
    });
  } catch { /* Notifications accelerate local reads; their loss must be invisible to the caller. */ }
}

/** Claude Code's deny for a Bash call, with what the agent is told. */
const gateDeny = (reason: string) => ascii(JSON.stringify({ hookSpecificOutput: { hookEventName: GATE.event, permissionDecision: "deny", permissionDecisionReason: reason } })) + "\n";

/**
 * Commands that wait's PreToolUse call (`r`, null when it couldn't be read): nothing printed only when there's no list,
 * it isn't a Bash call, or nothing on the list matches it; held while the phone shows it when one command does and the
 * phone shows the whole call; denied at once when two do, it's too long to show, or its masking would hide shell code
 * (one tap lets the whole call run), and whenever any of that can't be known.
 */
async function gateHook(r: any, raw: string, target: HookSocket | null, out: (s: string) => void, guard: () => readonly string[] | null, protects: readonly string[]): Promise<void> {
  let printed = false;
  const say = (s: string) => { printed = true; out(s); };
  try {
    // A file written: only the gate's own settings are refused, whatever the list. A call too long to read (a big
    // Write) is judged by its path, which Claude Code writes before the contents; none to be found, it's refused.
    const tool = r ? r.tool_name : /"tool_name"\s*:\s*"(\w+)"/.exec(raw)?.[1];
    if (FILE_TOOLS.includes(tool)) {
      const path = r ? r.tool_input?.file_path : pathOf(raw);
      if (typeof path !== "string" || !path) return say(gateDeny(GATE_UNCHECKED));
      const cwd = r && typeof r.cwd === "string" ? r.cwd : process.cwd();
      if (protects.some((p) => samePath(resolve(cwd, path), p))) return say(gateDeny(GATE_SETTINGS));
      return;
    }
    let list: readonly string[] | null;
    try { list = guard(); } catch { list = null; }
    if (list === null) return say(gateDeny(GATE_UNREADABLE));
    if (!list.length) return;
    if (!r) return say(gateDeny(GATE_UNCHECKED));
    if (r.tool_name !== "Bash") return;
    const command = r.tool_input?.command;
    const hits = matchesOf(list, command, typeof r.cwd === "string" ? r.cwd : undefined);
    if (!hits.length) return;
    if (hits.length > 1) return say(gateDeny(GATE_ONE_EACH));
    if (!shownWhole(command)) return say(gateDeny(GATE_TOO_LONG));
    if (hidesCode(command)) return say(gateDeny(GATE_MASKED));
    await waitForGate(r.session_id, command, hits[0]!.matched, target, say);
  } catch {
    if (!printed) say(gateDeny(GATE_UNCHECKED));
  }
}

/** A file tool's path, from a call too long to read whole: the first `file_path`, its JSON string's escapes read. */
function pathOf(raw: string): string | undefined {
  const m = /"file_path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
  try { return m ? JSON.parse(m[1]!) : undefined; } catch { return undefined; }
}

/** Whether two paths are one file: each with its links followed where it exists, and case folded where macOS folds it. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    let x = resolve(p);
    try { x = realpathSync.native(x); } catch { /* not there: as written */ }
    return process.platform === "darwin" || process.platform === "win32" ? x.toLowerCase() : x;
  };
  return real(a) === real(b);
}

/**
 * Holds an AskUserQuestion or ExitPlanMode open for Driver: tells the connector which session asks what, and waits for
 * its reply (one JSON line). With answers, prints Claude Code's PermissionRequest decision: allow, with the questions as
 * asked and the answers by question; for a plan, allow as it is, or deny with the user's words, so Claude revises it.
 * With nothing (the connector isn't running, didn't take it, or let it go because the terminal answered), prints
 * nothing, so it stays the terminal's.
 */
async function waitForAnswer(r: any, target: HookSocket, out: (s: string) => void): Promise<void> {
  const questions = r.tool_input?.questions, plan = r.tool_input?.plan;
  if (!ASKING.includes(r.tool_name) || (r.tool_name === "AskUserQuestion" ? !Array.isArray(questions) : typeof plan !== "string")) return;
  const socket = await reach(target, ASK_REACH_MS);
  if (!socket) return;
  const reply = await new Promise<any>((resolve) => {
    let text = "";
    socket.on("error", () => resolve(null));
    socket.on("data", (b) => { text += b.toString(); if (text.length > 64 * 1024) socket.destroy(); });
    socket.on("close", () => { try { resolve(JSON.parse(text.slice(0, text.indexOf("\n")))); } catch { resolve(null); } });
    // What's asked comes from here: Claude Code writes the call to its transcript only once it's answered.
    socket.write(JSON.stringify({ session_id: r.session_id, hook_event_name: ASK.event, tool: r.tool_name,
      ...(r.tool_name === "AskUserQuestion" ? { questions } : { plan: plan.slice(0, 20_000) }) }) + "\n");
  });
  const decide = (decision: object) => out(ascii(JSON.stringify({ hookSpecificOutput: { hookEventName: ASK.event, decision } })) + "\n");
  if (r.tool_name === "ExitPlanMode") {
    if (reply?.approve === true) decide({ behavior: "allow", updatedInput: r.tool_input });
    else if (typeof reply?.revise === "string" && reply.revise.trim()) decide({ behavior: "deny", message: reply.revise });
    return;
  }
  const answers = reply?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return;
  // The connector keys answers by the question as it read it (at most 2,000 characters).
  const chosen: Record<string, string> = {};
  for (const q of questions) {
    const a = typeof q?.question === "string" ? answers[q.question] ?? answers[q.question.slice(0, 2000)] : undefined;
    if (typeof a === "string" && a.trim()) chosen[q.question] = a;
  }
  if (!Object.keys(chosen).length) return;
  decide({ behavior: "allow", updatedInput: { ...r.tool_input, answers: chosen } });
}

/**
 * Holds a Bash command on the list until the connector answers: `{ release: true }` prints nothing, so Claude Code's own
 * permission mode decides, as if 10 & 2 weren't there; anything else is Claude Code's deny, with the connector's reason
 * (`{ stop }`) or this hook's own. The connector is reached as the question hook reaches it (`reach`): on Windows its pipe
 * must prove it's this user's connector first, so no other account's pipe can let a command on the list run; none
 * listening, or none that proves itself, is a deny. The connector answers a minute before Claude Code's timeout would
 * kill this (gate.ts `GATE_MS`), since a killed hook decides nothing and the command would run; this waits that long
 * too, reaching the connector included.
 */
async function waitForGate(session: unknown, command: string, matched: string, target: HookSocket | null, out: (s: string) => void): Promise<void> {
  const end = Date.now() + (GATE.timeout - 30) * 1000;
  const socket = target ? await reach(target, Math.min(ASK_REACH_MS, end - Date.now())) : null;
  const reply = !socket ? { stop: GATE_NOT_RUNNING } : await new Promise<any>((resolve) => {
    let text = "", done = false;
    const finish = (v: any) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(v); };
    const timer = setTimeout(() => finish({ stop: GATE_UNANSWERED_HERE }), Math.max(0, end - Date.now()));
    socket.on("error", () => finish({ stop: GATE_NOT_RUNNING }));
    socket.on("data", (b) => { text += b.toString(); if (text.length > 64 * 1024) socket.destroy(); });
    socket.on("close", () => { let v = null; try { v = JSON.parse(text.slice(0, text.indexOf("\n"))); } catch { /* no answer */ } finish(v ?? { stop: GATE_NOT_RUNNING }); });
    socket.write(JSON.stringify({ session_id: session, hook_event_name: GATE.event, tool: "Bash", command: command.slice(0, 20_000), matched: matched.slice(0, 2000) }) + "\n");
  });
  if (reply?.release === true) return;
  const reason = typeof reply?.stop === "string" && reply.stop.trim() ? reply.stop.slice(0, 2000) : GATE_NOT_RUNNING;
  out(gateDeny(reason));
}
/** The hook's own last word, if the connector never answered within Claude Code's limit (it answers first, gate.ts). */
const GATE_UNANSWERED_HERE = "Not run: the user didn't answer on their phone within 6 hours (10 & 2). Don't run it another way; tell them what you needed it for.";

/**
 * JSON with every character past ASCII written as a `\u` escape, which reads back the same. On Windows the line can
 * pass through PowerShell, which may re-encode it in the console's code page and garble the user's words.
 */
export const ascii = (json: string) => json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
