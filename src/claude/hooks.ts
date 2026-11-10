import { readFile, writeFile, copyFile, rename, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { sessionId } from "./registry.ts";

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
    const s = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
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
  await rename(tmp, path);
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

export async function installHooks(configDir: string, command: string): Promise<void> {
  if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Hook command must be a single nonempty command");
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

/** Best effort only: a stopped connector must never hold up Claude's own hooks. */
export async function relayHook(stdin: string | NodeJS.ReadableStream, socketPath: string, out: (s: string) => void = (s) => { process.stdout.write(s); }): Promise<void> {
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
    if (r.hook_event_name === ASK.event) { await waitForAnswer(r, socketPath, out); return; }
    const event = { session_id: r.session_id, hook_event_name: r.hook_event_name,
      notification_type: typeof r.notification_type === "string" ? r.notification_type.slice(0, 100) : undefined };
    await new Promise<void>((resolve) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 150); timer.unref();
      socket.on("error", () => { clearTimeout(timer); resolve(); });
      socket.on("connect", () => socket.end(JSON.stringify(event) + "\n"));
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.unref();
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
async function waitForAnswer(r: any, socketPath: string, out: (s: string) => void): Promise<void> {
  const questions = r.tool_input?.questions, plan = r.tool_input?.plan;
  if (!ASKING.includes(r.tool_name) || (r.tool_name === "AskUserQuestion" ? !Array.isArray(questions) : typeof plan !== "string")) return;
  const reply = await new Promise<any>((resolve) => {
    let text = "";
    const socket = createConnection(socketPath);
    socket.on("error", () => resolve(null));
    // What's asked comes from here: Claude Code writes the call to its transcript only once it's answered.
    socket.on("connect", () => socket.write(JSON.stringify({ session_id: r.session_id, hook_event_name: ASK.event, tool: r.tool_name,
      ...(r.tool_name === "AskUserQuestion" ? { questions } : { plan: plan.slice(0, 20_000) }) }) + "\n"));
    socket.on("data", (b) => { text += b.toString(); if (text.length > 64 * 1024) socket.destroy(); });
    socket.on("close", () => { try { resolve(JSON.parse(text.slice(0, text.indexOf("\n")))); } catch { resolve(null); } });
  });
  const decide = (decision: object) => out(JSON.stringify({ hookSpecificOutput: { hookEventName: ASK.event, decision } }) + "\n");
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
