// `10and2 pi-turn`: one turn of a Pi session nothing has open, or of new work, run by the connector in its own detached
// process, so the turn carries on if the connector stops. It runs `pi --mode rpc` (10 & 2's Pi extension registers it
// like any open Pi, so Driver can steer it meanwhile), sends the user's words, and stops Pi once it settles: nothing
// keeps the session open afterwards, and a Pi the user opens later doesn't collide with it.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * What to run, read as one JSON line on stdin (so the words never show in a process list). `session`: the file of a
 * session to continue (a path works from any folder). `sessionId` (and `name`): new work under that id.
 */
export type Turn = { pi: string; cwd: string; message: string; session?: string; sessionId?: string; name?: string };

/** The exit code when Pi couldn't be started at all: nothing was sent. */
export const NOT_STARTED = 127;

export function turnArgs(turn: Turn): string[] {
  if (turn.session) return ["--mode", "rpc", "--session", turn.session];
  if (!turn.sessionId) throw new Error("pi-turn needs a session or a session id");
  return ["--mode", "rpc", "--session-id", turn.sessionId, ...(turn.name ? ["--name", turn.name] : [])];
}

/**
 * The words as Pi's `prompt` command gets them. Pi runs words starting with "/" as a command or template; the user said
 * them, so a space in front keeps them words (measured on 1.5.1: stored and sent as typed, with the space).
 */
export const promptText = (message: string) => message.startsWith("/") ? ` ${message}` : message;

/** Reads the turn from `input`, runs it, and resolves with the exit code: Pi's own, or NOT_STARTED. */
export async function runPiTurn(input: NodeJS.ReadableStream = process.stdin): Promise<number> {
  let text = "";
  for await (const chunk of input) text += chunk.toString();
  let turn: Turn;
  try {
    turn = JSON.parse(text);
    if (typeof turn.pi !== "string" || typeof turn.cwd !== "string" || typeof turn.message !== "string") throw new Error("bad turn");
  } catch { return 64; }
  return new Promise<number>((resolve) => {
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      // Driver's headless run: nobody sits at a picker the extension would show (extensions/pi/10and2.ts).
      child = spawn(turn.pi, turnArgs(turn), { cwd: turn.cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, TENANDTWO_PI_HEADLESS: "1" } });
    } catch { resolve(NOT_STARTED); return; }
    let started = false, done = false;
    const end = () => { if (!done) { done = true; child.stdin.end(); } };
    const send = (o: object) => { if (!done) child.stdin.write(JSON.stringify(o) + "\n"); };
    child.on("spawn", () => { started = true; });
    child.on("error", () => { if (!started) resolve(NOT_STARTED); });
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => {});
    // Records are split on LF only: a JSON string may hold U+2028, which a line reader would split on.
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10)) {
        const line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        // The prompt refused, or taken by something that started no turn: there's nothing to wait for.
        if (ev.type === "response" && ev.id === "turn" && (!ev.success || ev.data?.disposition === "handled")) end();
        // A dialog (another extension's approval, say) has nobody to answer it here: it's declined.
        if (ev.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(ev.method)) send({ type: "extension_ui_response", id: ev.id, cancelled: true });
        // Pi carries on by itself after `agent_end` (retries, queued messages); `agent_settled` is the end.
        if (ev.type === "agent_settled") end();
      }
      if (buf.length > 64 * 1024 * 1024) buf = Buffer.alloc(0);
    });
    send({ id: "turn", type: "prompt", message: promptText(turn.message) });
  });
}
