#!/usr/bin/env node
// Synthetic Claude process: it never calls a model or reads the user's Claude configuration.
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const bg = process.env.FAKE_CLAUDE_BG === "1";
if (args.includes("--help")) { console.log(`-w, --worktree [name]${bg ? "\n  --bg, --background  Start the session in the background" : ""}`); process.exit(0); }
if (args.includes("--version")) { console.log(bg ? "2.1.321 (Claude Code)" : process.env.FAKE_CLAUDE_WORKTREE === "1" ? "2.1.312 (Claude Code)" : "2.1.309 (Claude Code)"); process.exit(0); }
const config = process.env.CLAUDE_CONFIG_DIR;
if (!config) process.exit(2);
if (args.includes("--bg")) {
  // A background start: Claude Code's supervisor takes the session, and this command only reports its short id.
  appendFileSync(join(config, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, bg: true }) + "\n");
  if (process.env.FAKE_CLAUDE_BG_REFUSE === "1") { console.error("Workspace not trusted"); process.exit(1); }
  const id = args.includes("--resume") ? value("--resume") : randomUUID();
  const where = args.includes("--worktree") ? join(process.cwd(), ".claude", "worktrees", value("--worktree")) : process.cwd();
  const folder = join(config, "projects", where.replace(/[/.]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const message = args[args.indexOf("--") + 1];
  if (process.env.FAKE_CLAUDE_NEVER_ECHO !== "1") appendFileSync(join(folder, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd: where, entrypoint: "cli", origin: { kind: "human" }, timestamp: new Date().toISOString(), version: "2.1.321", permissionMode: value("--permission-mode"), uuid: randomUUID(), message: { role: "user", content: message } }) + "\n");
  console.log(`backgrounded · ${id.slice(0, 8)}${args.includes("--name") ? ` · ${value("--name")}` : ""}`);
  process.exit(0);
}
if (!args.includes("-p") || !args.includes("--permission-mode")) process.exit(2);
const id = args.includes("--resume") ? value("--resume") : value("--session-id");
const cwd = args.includes("--worktree") ? join(process.cwd(), ".claude", "worktrees", value("--worktree")) : process.cwd();
if (args.includes("--worktree")) { mkdirSync(join(cwd, ".git"), { recursive: true }); process.chdir(cwd); }
const dir = join(config, "projects", cwd.replace(/[/.]/g, "-"));
mkdirSync(dir, { recursive: true }); mkdirSync(join(config, "sessions"), { recursive: true });
const transcript = join(dir, `${id}.jsonl`), registry = join(config, "sessions", `${process.pid}.json`);
appendFileSync(join(config, "calls.jsonl"), JSON.stringify({ args, cwd, id, pid: process.pid }) + "\n");
if (args.includes("--session-id") && existsSync(transcript)) { console.error("Session ID is already in use"); process.exit(1); }
const start = process.platform === "linux" ? readFileSync(`/proc/${process.pid}/stat`, "utf8").slice(readFileSync(`/proc/${process.pid}/stat`, "utf8").lastIndexOf(")") + 1).trim().split(/\s+/)[19] : null;
const stamp = () => new Date().toISOString();
function register(status) { writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, cwd, procStart: start, version: "2.1.310", kind: "interactive", entrypoint: "sdk-cli", status, statusUpdatedAt: Date.now() })); }
function record(r) { appendFileSync(transcript, JSON.stringify({ sessionId: id, cwd, entrypoint: "sdk-cli", timestamp: stamp(), version: "2.1.310", ...r }) + "\n"); }
function clean() { try { unlinkSync(registry); } catch {} }
process.on("SIGINT", () => { record({ type: "user", interruptedByShutdown: true }); clean(); process.exit(0); });
process.on("SIGTERM", () => { clean(); process.exit(0); });
register("busy");
let input;
for await (const line of createInterface({ input: process.stdin })) { input = JSON.parse(line); break; }
if (!input) { clean(); process.exit(1); }
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_BEFORE_ACCEPT_MS ?? 0)));
if (process.env.FAKE_CLAUDE_NEVER_ECHO !== "1") {
  const name = args.find((a) => a.startsWith("--name="));
  if (name) record({ type: "agent-name", agentName: name.slice(7) });
  if (process.env.FAKE_CLAUDE_NO_USER_RECORD !== "1") record({ type: "user", uuid: input.uuid, promptId: input.uuid, permissionMode: value("--permission-mode"), message: input.message });
  if (process.env.FAKE_CLAUDE_SKIP_INIT !== "1") console.log(JSON.stringify({ type: "system", subtype: "init", session_id: id, permissionMode: value("--permission-mode") }));
  if (process.env.FAKE_CLAUDE_NO_REPLAY !== "1") console.log(JSON.stringify({ ...input, session_id: id, uuid: process.env.FAKE_CLAUDE_WRONG_UUID === "1" ? randomUUID() : input.uuid }));
}
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_HOLD_MS ?? 15)));
if (process.env.FAKE_CLAUDE_NEVER_ECHO !== "1") record({ type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: "Synthetic reply." }], stop_reason: "end_turn" } });
register("idle"); clean();
