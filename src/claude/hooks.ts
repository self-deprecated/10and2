import { readFile, writeFile, copyFile, rename, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { sessionId } from "./registry.ts";

const EVENTS = ["SessionStart", "SessionEnd", "Stop", "Notification"];
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
    (s.hooks[event] ??= []).push({ hooks: [{ type: "command", command: `${command} hook${MARKER}`, async: true }] });
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
export async function relayHook(stdin: string | NodeJS.ReadableStream, socketPath: string): Promise<void> {
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
