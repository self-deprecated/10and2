// 10and2 Copilot extension (installed by `10and2 copilot install`)
/**
 * Lets 10 & 2's connector reach this Copilot (measured on Copilot CLI 1.0.112). Copilot starts it in every Copilot it
 * runs, as a child joined to that Copilot's session (`joinSession`), once extensions are on (`"experimental": true` in
 * its settings.json). It listens on a private local socket and keeps a registry file saying where:
 *   <COPILOT_HOME or ~/.copilot>/10and2/<pid>.sock  (on Windows a named pipe, \\.\pipe\10and2-copilot-<random uuid>)
 *   <COPILOT_HOME or ~/.copilot>/10and2/<pid>.json  { sessionId, cwd, pid, status, questions, socket, updatedAt }
 *
 * Wire protocol: newline-delimited JSON, one object per line, both directions (the same as 10 & 2's Pi extension).
 *   → {"type":"user","text":"…","id":"x"}   the user's words: idle, they start a turn; busy, they go into the turn
 *                                            running now (Copilot's "immediate")
 *   ← {"type":"ack","id":"x"}  or  {"type":"error","id":"x","error":"…"}
 *   → {"type":"answer","id":"x","questionId":"…","value":"Beta"}   an answer to the question Copilot is showing
 *   ← {"type":"ack","id":"x"}  or  {"type":"error","id":"x","error":"answered"} when the terminal answered first
 * status: "idle" | "busy" | "waiting" (a question is showing). Permission prompts aren't answerable from here at all.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const WINDOWS = process.platform === "win32";
const dir = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "10and2");
const regPath = path.join(dir, `${process.pid}.json`);
const sockPath = WINDOWS ? `\\\\.\\pipe\\10and2-copilot-${randomUUID()}` : path.join(dir, `${process.pid}.sock`);

let status = "idle";
/** questionId → { title, options, kind: "elicitation" (its form's `field`) | "input" }. */
const questions = new Map();

const session = await joinSession({});

function writeRegistry() {
  const entry = {
    sessionId: session.sessionId, cwd: process.cwd(), pid: process.pid, status: questions.size ? "waiting" : status,
    questions: [...questions].map(([questionId, q]) => ({ questionId, title: q.title, options: q.options })),
    socket: sockPath, updatedAt: new Date().toISOString(),
  };
  const tmp = `${regPath}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 }); fs.renameSync(tmp, regPath); } catch { /* the next change writes it again */ }
}

session.on((event) => {
  const d = event?.data ?? {};
  switch (event?.type) {
    case "user.message": case "assistant.turn_start": if (status !== "busy") { status = "busy"; writeRegistry(); } return;
    case "session.idle": status = "idle"; questions.clear(); writeRegistry(); return;
    case "elicitation.requested": {
      // ask_user's form: its first field, with the choices it offers (an enum), or free words.
      const [field, prop] = Object.entries(d.requestedSchema?.properties ?? {})[0] ?? [];
      if (!field) return;
      const options = Array.isArray(prop?.enum) ? prop.enum.filter((o) => typeof o === "string") : [];
      questions.set(d.requestId, { title: String(d.message ?? ""), options, kind: "elicitation", field });
      writeRegistry(); return;
    }
    case "user_input.requested":
      questions.set(d.requestId, { title: String(d.question ?? ""), options: Array.isArray(d.choices) ? d.choices.filter((o) => typeof o === "string") : [], kind: "input" });
      writeRegistry(); return;
    case "elicitation.completed": case "user_input.completed": if (questions.delete(d.requestId)) writeRegistry(); return;
  }
});

async function handle(m) {
  if (m?.type === "user" && typeof m.text === "string") {
    await session.send({ prompt: m.text, ...(status === "busy" ? { mode: "immediate" } : {}) });
    return { type: "ack", id: m.id };
  }
  if (m?.type === "answer" && typeof m.value === "string") {
    const q = questions.get(m.questionId);
    if (!q) return { type: "error", id: m.id, error: "answered" };
    const r = q.kind === "elicitation"
      ? await session.rpc.ui.handlePendingElicitation({ requestId: m.questionId, result: { action: "accept", content: { [q.field]: m.value } } })
      : await session.rpc.ui.handlePendingUserInput({ requestId: m.questionId, response: { answer: m.value, wasFreeform: !q.options.includes(m.value) } });
    if (r && r.success === false) return { type: "error", id: m.id, error: "answered" };
    questions.delete(m.questionId); writeRegistry();
    return { type: "ack", id: m.id };
  }
  return { type: "error", id: m?.id, error: "unknown request" };
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!WINDOWS) { try { fs.rmSync(sockPath, { force: true }); } catch { /* none */ } }
const server = net.createServer((conn) => {
  let buf = "";
  conn.on("error", () => {});
  conn.on("data", async (chunk) => {
    buf += chunk.toString();
    if (buf.length > 1024 * 1024) { conn.destroy(); return; }
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      let reply;
      try { reply = await handle(m); } catch (e) { reply = { type: "error", id: m?.id, error: String(e?.message ?? e).slice(0, 500) }; }
      try { conn.write(JSON.stringify(reply) + "\n"); } catch { /* gone */ }
    }
  });
});
server.listen(sockPath, () => { if (!WINDOWS) { try { fs.chmodSync(sockPath, 0o600); } catch { /* still private: the folder is 0700 */ } } writeRegistry(); });

const cleanup = () => { try { fs.rmSync(regPath, { force: true }); if (!WINDOWS) fs.rmSync(sockPath, { force: true }); } catch { /* gone */ } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(0); });
