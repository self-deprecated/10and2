// The connector protocol (docs/launch/contracts.md §2): an MCP server over the WebSocket the connector opens to its
// brain. It accepts only the voice-shaped contract: a request can't smuggle backend RPCs, paths or shell text.
import type { Action, ActionKind } from "./contract.ts";

/** The WebSocket subprotocol; the brain refuses any other with HTTP 426. */
export const SUBPROTOCOL = "10and2.mcp.1";
/** The MCP revision whose message shapes both ends speak. */
export const MCP_VERSION = "2025-06-18";
/** This connector's version, as `serverInfo.version` (kept equal to package.json's). */
export const VERSION = "0.3.0";
export const MAX_FRAME = 8 << 20;
/** The keep-alive frames, outside JSON-RPC, so the brain's auto-response answers them without waking. */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';
export const PING_MS = 30_000;
export const SILENCE_MS = 75_000;
/** The longest an action may wait between the brain sending it and the connector dispatching it. */
export const MAX_TTL_MS = 25_000;
export const MAX_REQUESTS = 128;
/** The machine's view, as an MCP resource. */
export const WORK_URI = "tenandtwo://work";
/** Close codes the brain sends. */
export const CLOSE = { revoked: 4001, replaced: 4002, protocol: 4003 } as const;
/** JSON-RPC error codes; -32602 and -32601 mean nothing was done. */
export const ERR = { parse: -32700, invalidRequest: -32600, noMethod: -32601, invalidParams: -32602, internal: -32603, busy: -32000 } as const;

export const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128_000;

export const ACTIONS: readonly ActionKind[] = ["follow_up", "settle", "snooze", "archive", "start_work"];

function onlyFields(value: object, fields: string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unknown action fields aren't supported.");
}

export function actionOf(v: any): Action {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("An action is required.");
  if (v.kind === "start_work") {
    onlyFields(v, ["kind", "placeId", "title", "message", "profile"]);
    const p = v.profile;
    if (!text(v.placeId) || !text(v.title) || !text(v.message) || !p || !text(p.name) ||
      !["worktree", "root"].includes(p.workspace) || !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(p.runtimeMode) ||
      !["default", "plan"].includes(p.interactionMode)) throw new Error("That launch profile or project isn't valid.");
    onlyFields(p, ["name", "workspace", "runtimeMode", "interactionMode"]);
    return { kind: v.kind, placeId: v.placeId, title: v.title, message: v.message, profile: { name: p.name, workspace: p.workspace, runtimeMode: p.runtimeMode, interactionMode: p.interactionMode } };
  }
  if (!text(v.itemId)) throw new Error("A thread is required.");
  switch (v.kind) {
    case "archive": case "settle":
      onlyFields(v, ["kind", "itemId"]);
      return { kind: v.kind, itemId: v.itemId };
    case "follow_up":
      onlyFields(v, ["kind", "itemId", "message"]);
      if (text(v.message)) return { kind: v.kind, itemId: v.itemId, message: v.message }; break;
    case "snooze":
      onlyFields(v, ["kind", "itemId", "until"]);
      if (text(v.until) && Number.isFinite(Date.parse(v.until))) return { kind: v.kind, itemId: v.itemId, until: v.until }; break;
  }
  throw new Error("That action isn't supported.");
}

const str = { type: "string", minLength: 1 } as const;
const obj = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const profile = obj({ name: str, workspace: { enum: ["worktree", "root"] }, runtimeMode: { enum: ["approval-required", "auto-accept-edits", "auto", "full-access"] }, interactionMode: { enum: ["default", "plan"] } });
type Tool = { name: string; description: string; inputSchema: object };

const READING: Tool[] = [
  { name: "read_report", description: "The latest reply of a thread or session, its progress while running, and any open question.", inputSchema: obj({ id: str }) },
  { name: "past_replies", description: "Every finished run's reply in a thread or session, newest first.", inputSchema: obj({ id: str }) },
  { name: "mark_read", description: "Marks a thread as seen up to a watermark, where the work system tracks that. Key in _meta.", inputSchema: obj({ id: str, watermark: str }) },
];
const ACTING: Record<ActionKind, Tool> = {
  follow_up: { name: "follow_up", description: "Sends the user's message to a thread or session.", inputSchema: obj({ itemId: str, message: str }) },
  settle: { name: "settle", description: "Marks a thread as dealt with.", inputSchema: obj({ itemId: str }) },
  snooze: { name: "snooze", description: "Hides a thread until a time.", inputSchema: obj({ itemId: str, until: str }) },
  archive: { name: "archive", description: "Archives a thread.", inputSchema: obj({ itemId: str }) },
  start_work: { name: "start_work", description: "Starts new work in a place, with a named launch profile.", inputSchema: obj({ placeId: str, title: str, message: str, profile }) },
};

/** The tools this machine offers: reading always, acting only as its local policy allows. */
export function tools(allowed: readonly ActionKind[]): Tool[] {
  return [...READING, ...ACTIONS.filter((a) => allowed.includes(a)).map((a) => ACTING[a])];
}
