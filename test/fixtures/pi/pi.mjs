#!/usr/bin/env node
// Synthetic `pi --mode rpc`: it never calls a model or reads the user's Pi configuration. It keeps sessions the way Pi
// 1.5.1 does (<agentDir>/sessions/--<cwd>--/<ts>_<id>.jsonl) under $PI_CODING_AGENT_DIR, and records each call in
// calls.jsonl there. FAKE_PI_NEVER_ECHO=1: takes the prompt but writes nothing. FAKE_PI_HOLD_MS: how long a turn takes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const agent = process.env.PI_CODING_AGENT_DIR;
if (!agent || value("--mode") !== "rpc") process.exit(2);
appendFileSync(join(agent, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, headless: process.env.TENANDTWO_PI_HEADLESS ?? null }) + "\n");

const hex = () => randomBytes(4).toString("hex");
const now = () => new Date().toISOString();
let file = value("--session"), last = null;
if (file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  last = lines.at(-1)?.id ?? null;
} else {
  const id = value("--session-id"), cwd = process.cwd();
  const folder = join(agent, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
  mkdirSync(folder, { recursive: true });
  file = (existsSync(folder) && readdirSync(folder).map((f) => join(folder, f)).find((f) => f.endsWith(`_${id}.jsonl`))) || join(folder, `${now().replace(/[:.]/g, "-")}_${id}.jsonl`);
  if (!existsSync(file)) {
    process.stderr.write(`Warning: No project session found with id '${id}'; creating a new session with that id.\n`);
    appendFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: now(), cwd }) + "\n");
    if (value("--name")) { last = hex(); appendFileSync(file, JSON.stringify({ type: "session_info", id: last, parentId: null, timestamp: now(), name: value("--name") }) + "\n"); }
  }
}
const entry = (e) => { const id = hex(); appendFileSync(file, JSON.stringify({ ...e, id, parentId: last, timestamp: now() }) + "\n"); last = id; };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let buf = "", running = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.type !== "prompt") continue;
    appendFileSync(join(agent, "calls.jsonl"), JSON.stringify({ prompt: cmd.message, pid: process.pid }) + "\n");
    out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    running = running.then(async () => {
      out({ type: "agent_start" });
      if (process.env.FAKE_PI_NEVER_ECHO !== "1") entry({ type: "message", message: { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: Date.now() } });
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_PI_HOLD_MS ?? 10)));
      if (process.env.FAKE_PI_NEVER_ECHO !== "1") entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `ACK ${cmd.message}` }], stopReason: "stop", timestamp: Date.now() } });
      out({ type: "agent_settled", aborted: false });
    });
  }
});
process.stdin.on("end", () => running.then(() => process.exit(0)));
