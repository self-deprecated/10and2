// The connector protocol (docs/launch/contracts.md §2): an MCP server over the WebSocket the connector opens to its
// brain. It accepts only the voice-shaped contract: a request can't smuggle backend RPCs, paths or shell text.
import type { Action, ActionKind, Report } from "./contract.ts";
import { cleanChecks } from "../brain/src/receipts.ts";

/** The WebSocket subprotocol; the brain refuses any other with HTTP 426. */
export const SUBPROTOCOL = "10and2.mcp.1";
/** The MCP revision whose message shapes both ends speak. */
export const MCP_VERSION = "2025-06-18";
/** This connector's version, as `serverInfo.version` (kept equal to package.json's). */
export const VERSION = "0.13.2";
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

/** The actions a machine's policy names. */
export const ACTIONS: readonly ActionKind[] = ["follow_up", "settle", "snooze", "archive", "start_work"];
/** Every action tool: the policy's, and undoing a snooze or a settle (allowed wherever doing it is, `allows`). */
export const TOOL_ACTIONS: readonly ActionKind[] = [...ACTIONS, "unsnooze", "unsettle"];

function onlyFields(value: object, fields: string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unknown action fields aren't supported.");
}

export function actionOf(v: any): Action {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("An action is required.");
  if (v.kind === "start_work") {
    onlyFields(v, ["kind", "placeId", "title", "message", "profile", "model"]);
    const p = v.profile;
    // No title: the work system names the thread from its prompt (a brain before 8 November always sends one).
    if (!text(v.placeId) || (v.title !== undefined && !text(v.title)) || !text(v.message) || !p || !text(p.name) ||
      !["worktree", "root"].includes(p.workspace) || !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(p.runtimeMode) ||
      !["default", "plan"].includes(p.interactionMode)) throw new Error("That launch profile or project isn't valid.");
    onlyFields(p, ["name", "workspace", "runtimeMode", "interactionMode"]);
    // One of the place's models, by the id this connector gave it; none, the coding app's own default. Copied only when
    // given, so a start without one hashes in the ledger exactly as before.
    if (v.model !== undefined && !(typeof v.model === "string" && v.model.length <= 200 && v.model.trim() === v.model && v.model !== "")) throw new Error("That model isn't valid.");
    return { kind: v.kind, placeId: v.placeId, ...(v.title !== undefined ? { title: v.title } : {}), message: v.message, profile: { name: p.name, workspace: p.workspace, runtimeMode: p.runtimeMode, interactionMode: p.interactionMode }, ...(v.model !== undefined ? { model: v.model } : {}) };
  }
  if (!text(v.itemId)) throw new Error("A thread is required.");
  switch (v.kind) {
    case "archive": case "settle": case "unsnooze": case "unsettle":
      onlyFields(v, ["kind", "itemId"]);
      return { kind: v.kind, itemId: v.itemId };
    case "follow_up":
      // `questionId`: an answer to that question only (a tap); Local refuses it once the thread no longer asks it.
      onlyFields(v, ["kind", "itemId", "message", "questionId"]);
      if (v.questionId !== undefined && !(text(v.questionId) && v.questionId.length <= 200)) break;
      if (text(v.message)) return { kind: v.kind, itemId: v.itemId, message: v.message, ...(v.questionId !== undefined ? { questionId: v.questionId } : {}) }; break;
    case "snooze":
      onlyFields(v, ["kind", "itemId", "until"]);
      if (text(v.until) && Number.isFinite(Date.parse(v.until))) return { kind: v.kind, itemId: v.itemId, until: v.until }; break;
  }
  throw new Error("That action isn't supported.");
}

/**
 * A report as it leaves the machine (docs/launch/engine.md §11 stage 3.10): its `checks` and `running` carry only kinds,
 * pass or fail, counts, `stale`, `edited` and a label of at most two words (`cleanChecks`), whatever an adapter put in
 * them; none, none sent. `runningSince` and `runningId` (the run's id, as its reply carries it) only with `running`.
 */
export function reportOut(r: Report): Report {
  const { checks, checksUnread, running, runningSince, runningId, ...rest } = r;
  const clean = cleanChecks(checks), now = cleanChecks(running);
  const since = now && typeof runningSince === "string" && Number.isFinite(Date.parse(runningSince)) ? new Date(runningSince).toISOString() : null;
  const run = now && typeof runningId === "string" && runningId.length > 0 && runningId.length <= 200 ? runningId : null;
  return { ...rest, ...(clean ? { checks: clean } : checksUnread === true ? { checksUnread: true as const } : {}), ...(now ? { running: now, ...(since ? { runningSince: since } : {}), ...(run ? { runningId: run } : {}) } : {}) };
}

const str = { type: "string", minLength: 1 } as const;
const obj = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const profile = obj({ name: str, workspace: { enum: ["worktree", "root"] }, runtimeMode: { enum: ["approval-required", "auto-accept-edits", "auto", "full-access"] }, interactionMode: { enum: ["default", "plan"] } });
type Tool = { name: string; description: string; inputSchema: object };

const READING: Tool[] = [
  { name: "read_report", description: "The latest reply of a thread or session, its progress while running, and any open question.", inputSchema: obj({ id: str }) },
  { name: "past_replies", description: "Every finished run's reply in a thread or session, newest first.", inputSchema: obj({ id: str }) },
  { name: "first_ask", description: "The user's first message to a thread or session and when they wrote it; null when it has none yet.", inputSchema: obj({ id: str }) },
  { name: "mark_read", description: "Marks a thread as seen up to a watermark, where the work system tracks that. Key in _meta.", inputSchema: obj({ id: str, watermark: str }) },
];
const READ_DOCUMENT: Tool = {
  name: "read_document",
  description: "The redacted text of a prose document linked by a thread's reply, by opaque doc id.",
  inputSchema: obj({ id: str, docId: str }),
};
const ACTING: Record<ActionKind, Tool> = {
  // `questionId` isn't required: a brain that sees it listed sends a tapped answer with it (brain/src/connector-client.ts).
  follow_up: { name: "follow_up", description: "Sends the user's message to a thread or session; with questionId, only as the answer to that question while it's asked.", inputSchema: obj({ itemId: str, message: str, questionId: str }, ["itemId", "message"]) },
  settle: { name: "settle", description: "Marks a thread as dealt with.", inputSchema: obj({ itemId: str }) },
  snooze: { name: "snooze", description: "Hides a thread until a time.", inputSchema: obj({ itemId: str, until: str }) },
  archive: { name: "archive", description: "Archives a thread.", inputSchema: obj({ itemId: str }) },
  unsnooze: { name: "unsnooze", description: "Wakes a snoozed thread now.", inputSchema: obj({ itemId: str }) },
  unsettle: { name: "unsettle", description: "Brings a settled thread back.", inputSchema: obj({ itemId: str }) },
  // `title` isn't required: a brain that sees so lets the work system name the thread (brain/src/connector-client.ts).
  // `model` listed is how a brain knows it may send one (docs/launch/thread-model.md).
  start_work: { name: "start_work", description: "Starts new work in a place, with a named launch profile, on one of the place's models if given one; named by the work system from its message unless given a title.", inputSchema: obj({ placeId: str, title: str, message: str, profile, model: { ...str, maxLength: 200 } }, ["placeId", "message", "profile"]) },
};

/**
 * Sends and starts held here for later (docs/launch/engine.md §5; schedules.ts): listed whatever the policy, so the brain
 * tells a connector too old for them (no tool) from one whose policy doesn't allow them (the view's `rules`).
 */
const SET_SCHEDULES: Tool = {
  name: "set_schedules",
  description: "Replaces this computer's sends and starts set up for later with the brain's full set; `seq` only goes up, and `_meta` carries the brain's clock.",
  inputSchema: obj({ seq: { type: "integer", minimum: 1 }, schedules: { type: "array", items: { type: "object" } } }),
};

/**
 * Commands that wait (docs/launch/engine.md §11 stage 4; connector/src/gate.ts): the one path that lets a held command
 * run, or stops it, for that hold's own `questionId` while it's held. Listed while this computer has a list of them (a
 * hold is only ever made then), whatever else the policy allows.
 */
const ANSWER_HOLD: Tool = {
  name: "answer_hold",
  description: "Lets a command this computer holds for the user run (run: true), or stops it; only for that hold's questionId while it's held. Never a message to the thread.",
  inputSchema: obj({ itemId: str, questionId: str, run: { type: "boolean" } }),
};

/**
 * The tools this machine offers: reading always, linked documents when opted in, acting only as its local policy allows;
 * `set_schedules` when it holds them; `answer_hold` when it has commands that wait.
 */
export function tools(allowed: readonly ActionKind[], schedules = false, holds = false, documents = false): Tool[] {
  return [...READING, ...(documents ? [READ_DOCUMENT] : []), ...TOOL_ACTIONS.filter((a) => allowed.includes(a)).map((a) => ACTING[a]), ...(schedules ? [SET_SCHEDULES] : []), ...(holds ? [ANSWER_HOLD] : [])];
}
