import { readFile, writeFile, copyFile, mkdir, chmod } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { sessionId } from "./registry.ts";
import { proves, randomHex, replaceFile } from "../util.ts";
import type { HookSocket } from "../paths.ts";
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
const EVENTS = [...NOTIFY, ASK.event];
const MARKER = " # 10and2-hook";
const ours = (h: any) => h?.type === "command" && typeof h.command === "string" && h.command.endsWith(MARKER);

async function settings(configDir: string): Promise<any> {
  try {
    // Windows PowerShell 5.1 (and some editors) save UTF-8 with a byte-order mark, which JSON.parse refuses.
    const s = JSON.parse((await readFile(join(configDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (!s || typeof s !== "object" || Array.isArray(s) || (s.hooks !== undefined && (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)))) throw new Error("Claude settings are not an object");
    return s;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}

async function save(configDir: string, s: any): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, "settings.json");
  try {
    const backup = `${path}.driver-backup-${randomUUID()}`;
    await copyFile(path, backup); await chmod(backup, 0o600);
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const tmp = `${path}.driver-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  replaceFile(tmp, path);
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

/** Adds 10 & 2's hooks, keeping the user's own. Refuses where they can't work (hooksUnavailable). */
export async function installHooks(configDir: string, command: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Hook command must be a single nonempty command");
  const unavailable = hooksUnavailable(configDir, env, platform);
  if (unavailable) throw new Error(unavailable);
  const s = await settings(configDir), before = JSON.stringify(s);
  remove(s); s.hooks ??= {};
  for (const event of EVENTS) {
    if (s.hooks[event] !== undefined && !Array.isArray(s.hooks[event])) throw new Error(`Claude ${event} hooks are not a list`);
    (s.hooks[event] ??= []).push(event === ASK.event
      ? { matcher: ASK.matcher, hooks: [{ type: "command", command: `${command} hook${MARKER}`, timeout: ASK.timeout }] }
      : { hooks: [{ type: "command", command: `${command} hook${MARKER}`, async: true }] });
  }
  if (JSON.stringify(s) !== before) await save(configDir, s);
}

export async function uninstallHooks(configDir: string): Promise<void> {
  const s = await settings(configDir), before = JSON.stringify(s);
  remove(s);
  if (JSON.stringify(s) !== before) await save(configDir, s);
}

export async function hooksStatus(configDir: string): Promise<{ installed: boolean; events: string[] }> {
  const s = await settings(configDir);
  const events = EVENTS.filter((event) => Array.isArray(s.hooks?.[event]) && s.hooks[event].some((e: any) => Array.isArray(e.hooks) && e.hooks.some(ours)));
  return { installed: events.length === EVENTS.length, events };
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
 * (on Windows, none has named its pipe yet). A bare path is a socket file, which its private folder keeps to the user.
 */
export async function relayHook(stdin: string | NodeJS.ReadableStream, socket: HookSocket | string | null, out: (s: string) => void = (s) => { process.stdout.write(s); }): Promise<void> {
  if (socket === null) return;
  const target = typeof socket === "string" ? { path: socket, secret: null } : socket;
  try {
    let input: string;
    if (typeof stdin === "string") input = stdin;
    else input = await new Promise<string>((resolve) => {
      let text = "";
      const finish = () => { clearTimeout(timer); stdin.removeListener("data", data); stdin.removeListener("end", finish); stdin.removeListener("error", finish); stdin.pause(); resolve(text); };
      const data = (b: Buffer | string) => { text += b.toString(); if (text.length > 64 * 1024) { text = ""; finish(); } };
      const timer = setTimeout(finish, 150); timer.unref();
      stdin.on("data", data); stdin.once("end", finish); stdin.once("error", finish);
    });
    if (input.length > 64 * 1024) return;
    const r = JSON.parse(input);
    if (!sessionId(r.session_id) || !EVENTS.includes(r.hook_event_name)) return;
    if (r.hook_event_name === ASK.event) { await waitForAnswer(r, target, out); return; }
    const event = { session_id: r.session_id, hook_event_name: r.hook_event_name,
      notification_type: typeof r.notification_type === "string" ? r.notification_type.slice(0, 100) : undefined };
    const socket = await reach(target);
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 150); timer.unref();
      socket.on("error", () => { clearTimeout(timer); resolve(); });
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.unref();
      socket.end(JSON.stringify(event) + "\n");
    });
  } catch { /* Notifications accelerate local reads; their loss must be invisible to the caller. */ }
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
 * JSON with every character past ASCII written as a `\u` escape, which reads back the same. On Windows the line can
 * pass through PowerShell, which may re-encode it in the console's code page and garble the user's words.
 */
export const ascii = (json: string) => json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
