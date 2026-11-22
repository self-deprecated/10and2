import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import type { RuntimeMode } from "../policy.ts";
import { PIPE } from "./registry.ts";
import type { How } from "../local.ts";
import { clockOf, prevDate, validZone } from "../../brain/src/zone.ts";

/**
 * A live Claude Code session's inbox (Claude Code 2.1.224+, "cross-session messaging"): a Unix socket each session binds
 * (a named pipe on Windows, from 2.1.234), named in its registry entry (`messagingSocketPath`), where a script may post a message
 * (code.claude.com/docs/en/cross-session-messaging, "The session's inbox socket"). A busy session reads it between tool
 * calls; an idle one starts a turn with it. It reaches Claude as a message from another session, never as the user's
 * consent, so it can't answer a permission prompt.
 */

/** Who the message says it's from, shown in the terminal as "Message from @10-2". */
export const SENDER = "10 & 2";

/**
 * The permission class a message attests (the envelope's `from-mode`). A session that bypasses permission prompts holds a
 * message from a prompting sender for its user's approval, and a prompting one holds a bypassing sender's. Driver speaks
 * for the user, so it matches the session's class, but claims `bypass` only where this machine's policy lets Driver's
 * own work bypass prompts too; otherwise the message waits for the user's OK in that session.
 */
export function attestedMode(sessionMode: string | null, ceiling: RuntimeMode): "bypass" | "prompting" {
  return sessionMode === "bypassPermissions" && ceiling === "full-access" ? "bypass" : "prompting";
}

/** Whether a message to a session in `sessionMode` will be held for its user's approval rather than delivered. */
export function heldFor(sessionMode: string | null, mode: "bypass" | "prompting"): boolean {
  return (sessionMode === "bypassPermissions") !== (mode === "bypass");
}

/**
 * The message as Claude Code's own peer envelope, so the session names its sender and checks its class: the user's
 * confirmed words, unchanged and first (the terminal shows a message's first line), then one line saying whose they are.
 * One set up for later says when it was set up and when it was to go, on the user's clock (docs/launch/engine.md §5).
 */
export function envelope(message: string, mode: "bypass" | "prompting", scheduled?: How["scheduled"]): string {
  // A closing tag inside the words would end the envelope early, and Claude Code would then reject it whole.
  const words = message.replaceAll("</cross-session-message>", "</cross-session-message >");
  const whose = scheduled ? setUp(scheduled) : "(Your user said this to 10 & 2, their voice assistant, and confirmed it.)";
  return `<cross-session-message from-name="${SENDER}" from-mode="${mode}">\n${words}\n\n${whose}\n</cross-session-message>`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * "(Your user set this up with 10 & 2 at 22:14, to be sent at 03:00, and confirmed it then.)", in the zone the user
 * agreed in (this computer's when that one isn't known here); the day said when it was set up on another ("yesterday at
 * 22:14", "on Thursday at 22:14"). A chain's: "to be sent when another thread finished".
 */
export function setUp(s: NonNullable<How["scheduled"]>): string {
  const zone = validZone(s.zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const agreed = clockOf(Date.parse(s.agreedAt), zone);
  const due = clockOf(s.at ? Date.parse(s.at) : Date.now(), zone);
  const hm = (c: { hour: number; minute: number }) => `${pad(c.hour)}:${pad(c.minute)}`;
  const when = agreed.date === due.date ? `at ${hm(agreed)}` : agreed.date === prevDate(due.date) ? `yesterday at ${hm(agreed)}` : `on ${agreed.weekday} at ${hm(agreed)}`;
  return `(Your user set this up with 10 & 2 ${when}, ${s.at ? `to be sent at ${hm(due)}` : "to be sent when another thread finished"}, and confirmed it then.)`;
}

/**
 * The session's peer token, which Claude Code publishes beside its registry entry for other processes of the same user,
 * in `<pid>.<sha256 of its inbox>.key`: the pipe's name lower-cased after `\\.\pipe\` on Windows, the socket's resolved
 * path elsewhere. A key file of that pid named otherwise counts only when it records the session's own start, since a
 * crashed session's file stays behind and Windows soon gives its pid to another. On macOS and Linux the inbox takes a
 * message without it, and it's sent when it's there; on Windows the inbox reads nothing until it has it.
 */
export function peerToken(configDir: string, pid: number, socket: string, start: string | null): string | null {
  const dir = join(configDir, "sessions");
  const read = (file: string) => { try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return null; } };
  const valid = (key: any) => typeof key?.peerToken === "string" && /^[A-Za-z0-9_-]{8,256}$/.test(key.peerToken) ? key.peerToken as string : null;
  const own = valid(read(peerKeyFile(pid, socket)));
  if (own) return own;
  if (start === null) return null;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.startsWith(`${pid}.`) && f.endsWith(".key")); } catch { return null; }
  for (const file of files) {
    const key = read(file), recorded = key?.procStart ?? key?.procStartFt;
    if ((typeof recorded === "string" || typeof recorded === "number") && String(recorded) === start && valid(key)) return valid(key);
  }
  return null;
}
/** The key file Claude Code names for a session's inbox. */
export function peerKeyFile(pid: number, socket: string): string {
  const pipe = PIPE.test(socket) ? socket.replace(/^\\\\[.?]\\pipe\\/i, "") : null;
  const canonical = pipe !== null ? `\\\\.\\pipe\\${pipe.toLowerCase()}` : resolve(socket);
  return `${pid}.${createHash("sha256").update(canonical).digest("hex")}.key`;
}

/**
 * Posts one user message to an inbox: the optional auth line, then the message, each a JSON line. True once both were
 * written and the connection closed cleanly. Delivery is proven separately, from the session's transcript.
 */
export function post(socketPath: string, token: string | null, sessionId: string, uuid: string, content: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); resolve(ok); } };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      const lines = (token ? JSON.stringify({ type: "auth", token }) + "\n" : "")
        + JSON.stringify({ type: "user", session_id: sessionId, uuid, message: { role: "user", content } }) + "\n";
      socket.end(lines, () => finish(true));
    });
    socket.on("data", () => { /* The inbox answers nothing for a user message; anything else is ignored. */ });
  });
}
