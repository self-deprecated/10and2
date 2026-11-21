#!/usr/bin/env node
// A stand-in for a coding agent's ACP mode (`gemini --acp`), for the ACP adapter's unit tests: it speaks ACP on stdio
// and keeps its sessions as Gemini CLI does, in $FAKE_GEMINI_DIR/tmp/<folder>/chats/session-<time>-<id>.jsonl. Every
// request it gets is appended to $FAKE_ACP_LOG. A prompt's reply is "ACK <words>"; words with PERM in them first ask
// permission for a tool, and the reply says what the client chose. Words with SLOW<n> take n seconds.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_GEMINI_DIR, log = process.env.FAKE_ACP_LOG;
const sessions = new Map();
let nextId = 1000;
const pending = new Map();
const write = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); write({ id, method, params }); });
const now = () => new Date().toISOString();
const models = { availableModels: [{ modelId: "m-flash", name: "Flash" }, { modelId: "m-pro", name: "Pro" }], currentModelId: "m-flash" };
const modes = (current) => ({ availableModes: ["default", "autoEdit", "yolo", "plan"].map((id) => ({ id, name: id })), currentModeId: current });

function fileFor(id) {
  for (const folder of existsSync(join(dir, "tmp")) ? readdirSync(join(dir, "tmp")) : []) {
    const chats = join(dir, "tmp", folder, "chats");
    const f = existsSync(chats) && readdirSync(chats).find((n) => n.endsWith(`-${id.slice(0, 8)}.jsonl`));
    if (f) return join(chats, f);
  }
  return null;
}

async function handle(m) {
  if (log) appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + "\n");
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    case "session/new": {
      const id = randomUUID(), folder = join(dir, "tmp", basename(p.cwd));
      mkdirSync(join(folder, "chats"), { recursive: true });
      writeFileSync(join(folder, ".project_root"), p.cwd);
      const file = join(folder, "chats", `session-${now().slice(0, 16).replace(/:/g, "-")}-${id.slice(0, 8)}.jsonl`);
      sessions.set(id, { file, mode: process.env.FAKE_DEFAULT_MODE ?? "default", model: models.currentModelId });
      // Gemini writes the file only once something is said; the header goes first then.
      return { sessionId: id, models, modes: modes(sessions.get(id).mode) };
    }
    case "session/load": {
      const file = fileFor(p.sessionId);
      if (!file) throw { code: -32002, message: "Session not found" };
      sessions.set(p.sessionId, { file, mode: process.env.FAKE_DEFAULT_MODE ?? "default", model: models.currentModelId, loaded: true });
      return { models, modes: modes(sessions.get(p.sessionId).mode) };
    }
    case "session/set_mode": {
      if (p.modeId === "yolo" && process.env.FAKE_UNTRUSTED) throw { code: -32603, message: "Internal error", data: { details: "Cannot enable privileged approval modes in an untrusted folder." } };
      sessions.get(p.sessionId).mode = p.modeId; return {};
    }
    case "session/set_model": sessions.get(p.sessionId).model = p.modelId; return {};
    case "session/prompt": {
      const s = sessions.get(p.sessionId), text = p.prompt.map((b) => b.text).join("");
      if (!existsSync(s.file)) appendFileSync(s.file, JSON.stringify({ sessionId: p.sessionId, projectHash: "x", startTime: now(), lastUpdated: now(), kind: "main" }) + "\n");
      appendFileSync(s.file, JSON.stringify({ id: randomUUID(), timestamp: now(), type: "user", content: [{ text }] }) + "\n");
      let said = "";
      if (/PERM/.test(text)) {
        const r = await ask("session/request_permission", { sessionId: p.sessionId, toolCall: { toolCallId: "t1", title: "touch it", kind: "edit" },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }] });
        said = ` (permission: ${r.outcome?.optionId ?? r.outcome?.outcome})`;
      }
      const slow = Number(/SLOW(\d+)/.exec(text)?.[1] ?? 0);
      if (slow) await new Promise((r) => setTimeout(r, slow * 1000));
      appendFileSync(s.file, JSON.stringify({ id: randomUUID(), timestamp: now(), type: "gemini", content: `ACK ${text.trim()}${said} [${s.mode}/${s.model}]` }) + "\n");
      return { stopReason: "end_turn" };
    }
  }
  throw { code: -32601, message: `no ${m.method}` };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); return; }
  if (m.id === undefined) return;
  try { write({ id: m.id, result: await handle(m) }); }
  catch (e) { write({ id: m.id, error: { code: e.code ?? -32603, message: e.message ?? String(e), ...(e.data ? { data: e.data } : {}) } }); }
}).on("close", () => process.exit(0));
