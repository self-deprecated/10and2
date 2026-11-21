// `10and2 acp-turn`: one turn of a session nothing has open, or of new work, for a coding agent reached through its ACP
// mode (Gemini CLI, GitHub Copilot CLI), run by the connector in its own detached process so the turn carries on if the
// connector stops. It starts the agent's ACP mode, loads the session (or makes one), sets its mode, approvals and model,
// sends the user's words, and stops the agent once the turn ends. It says the session's id on stdout as one JSON line as
// soon as it has it, and when the words go; everything else the connector reads from the agent's own session files.
import { AcpClient } from "./rpc.ts";

/** The agent's own mode id, and its session options (`{allow_all: "off"}`), as a launch sets them. */
export type Settings = { mode?: string; options?: Record<string, string> };

/**
 * What to run, read as one JSON line on stdin (so the words never show in a process list). `command`: the agent's ACP
 * mode, as its program and arguments. `load`: the session to continue; without it, new work. `exact`: set `settings` as
 * they are; otherwise keep what the session has where `allowed` allows it, and set `settings` where it doesn't.
 */
export type Turn = {
  command: string[]; cwd: string; message: string; load?: string; model?: string;
  settings?: Settings; exact?: boolean; allowed?: { modes: string[]; options: Record<string, string[]> };
};

/** Exit codes: the agent couldn't be started, so nothing was sent. */
export const NOT_STARTED = 127;

const strings = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string");
const isTurn = (t: any): t is Turn => !!t && strings(t.command) && t.command.length > 0 && typeof t.cwd === "string" && typeof t.message === "string"
  && (t.load === undefined || typeof t.load === "string") && (t.model === undefined || typeof t.model === "string");

/** What to change, given what the session has now: `[kind, id, value]` in order, the mode before the options. */
export function changes(turn: Turn, current: { mode: string | null; options: Record<string, string> }): ["mode" | "option", string, string][] {
  const out: ["mode" | "option", string, string][] = [];
  const want = turn.settings ?? {};
  let moved = false;
  if (want.mode && want.mode !== current.mode && (turn.exact || !turn.allowed?.modes.includes(current.mode ?? ""))) { out.push(["mode", "mode", want.mode]); moved = true; }
  for (const [k, v] of Object.entries(want.options ?? {})) {
    const now = current.options[k];
    // After a mode change an option may have moved with it, so it's set again.
    if (turn.exact ? now !== v : moved || (now !== undefined && !turn.allowed?.options[k]?.includes(now))) out.push(["option", k, v]);
  }
  return out;
}

/** Reads the turn from `input`, runs it, and resolves with the exit code. */
export async function runAcpTurn(input: NodeJS.ReadableStream = process.stdin, out: (line: string) => void = (l) => { try { process.stdout.write(l + "\n"); } catch { /* the connector stopped listening */ } }): Promise<number> {
  process.stdout.on("error", () => {});
  let text = "";
  for await (const chunk of input) text += chunk.toString();
  let turn: Turn;
  try { turn = JSON.parse(text); if (!isTurn(turn)) throw new Error("bad turn"); } catch { return 64; }
  let client: AcpClient;
  try { client = new AcpClient(turn.command, turn.cwd, process.env); } catch { return NOT_STARTED; }
  const started = await new Promise<boolean>((resolve) => { client.child.once("spawn", () => resolve(true)); client.child.once("error", () => resolve(false)); });
  if (!started) return NOT_STARTED;
  client.onAsked = (a) => out(JSON.stringify({ refused: a.title }));
  try {
    await client.initialize();
    const s = await client.session(turn.cwd, turn.load);
    if (!s.sessionId) throw new Error("the agent made no session");
    out(JSON.stringify({ sessionId: s.sessionId }));
    const options: Record<string, string> = {};
    const note = (list: any[]) => { for (const o of list) if (typeof o?.id === "string" && typeof o.currentValue === "string") options[o.id] = o.currentValue; };
    note(s.configOptions);
    client.onUpdate = (_, u) => { if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) note(u.configOptions); };
    const mode = s.currentModeId ?? options.mode ?? null;
    for (const [kind, id, value] of changes(turn, { mode, options })) {
      // An agent lists its modes (Gemini), or has a `mode` option instead (Copilot).
      const r = kind === "mode" && s.modes.length ? await client.setMode(s.sessionId, value)
        : await client.request("session/set_config_option", { sessionId: s.sessionId, configId: id, value });
      if (Array.isArray(r?.configOptions)) note(r.configOptions);
    }
    if (turn.model && turn.model !== (s.currentModelId ?? options.model)) {
      if (s.models.length) await client.setModel(s.sessionId, turn.model);
      else await client.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: turn.model });
    }
    out(JSON.stringify({ sending: true }));
    const stop = await client.prompt(s.sessionId, turn.message);
    out(JSON.stringify({ stopReason: stop }));
    client.stop();
    return 0;
  } catch (e) {
    out(JSON.stringify({ error: (e as Error).message }));
    client.stop();
    return 1;
  }
}
