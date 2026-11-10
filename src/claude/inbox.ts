import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { RuntimeMode } from "../policy.ts";

/**
 * A live Claude Code session's inbox (Claude Code 2.1.224+, "cross-session messaging"): a Unix socket each session binds,
 * named in its registry entry (`messagingSocketPath`), where a script may post a message
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
 */
export function envelope(message: string, mode: "bypass" | "prompting"): string {
  // A closing tag inside the words would end the envelope early, and Claude Code would then reject it whole.
  const words = message.replaceAll("</cross-session-message>", "</cross-session-message >");
  return `<cross-session-message from-name="${SENDER}" from-mode="${mode}">\n${words}\n\n(Your user said this to 10 & 2, their voice assistant, and confirmed it.)\n</cross-session-message>`;
}

/**
 * The session's peer token, which Claude Code publishes beside its registry entry (`<pid>.<hash>.key`) for other
 * processes of the same user. On macOS and Linux the inbox takes a message without it; it's sent when it's there.
 */
export function peerToken(configDir: string, pid: number): string | null {
  const dir = join(configDir, "sessions");
  try {
    const file = readdirSync(dir).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    if (!file) return null;
    const token = JSON.parse(readFileSync(join(dir, file), "utf8"))?.peerToken;
    return typeof token === "string" && /^[A-Za-z0-9_-]{8,256}$/.test(token) ? token : null;
  } catch { return null; }
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
