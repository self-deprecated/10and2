#!/usr/bin/env node
// A stand-in for Cursor's CLI agent, writing a chat's files as the real one does (src/cursor/paths.ts), so the adapter's
// runs can be tested without Cursor or a model:
//   create-chat                      makes an empty chat for this folder and prints its id
//   models                           prints a model list
//   -p … --resume <id>               reads the words on stdin, records them and "ACK <words>" as a finished turn
// Every run's arguments (and the words) are appended to $FAKE_CURSOR_LOG as JSON lines. $FAKE_CURSOR_FAIL=1 exits 1
// before writing anything; $FAKE_CURSOR_SLOW=<ms> waits that long before answering.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const config = process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
const data = process.env.CURSOR_DATA_DIR || join(homedir(), ".cursor");
const cwd = resolve(process.cwd());
const chatDir = (id) => join(config, "chats", createHash("md5").update(cwd).digest("hex"), id);
const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
const log = (o) => { if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(o) + "\n"); };

if (args[0] === "create-chat") {
  const id = randomUUID();
  mkdirSync(chatDir(id), { recursive: true });
  log({ args, cwd });
  console.log(id);
} else if (args[0] === "models") {
  log({ args });
  console.log("Available models\n\nauto - Auto\ngpt-5.5 - GPT-5.5  (current)\nclaude-opus-5-5-thinking - Opus 5.5 Thinking\n\nTip: use --model <id> to switch.");
} else if (args.includes("-p")) {
  let words = "";
  for await (const chunk of process.stdin) words += chunk;
  const id = args[args.indexOf("--resume") + 1];
  log({ args, cwd, words });
  if (process.env.FAKE_CURSOR_FAIL) process.exit(1);
  const dir = chatDir(id);
  mkdirSync(dir, { recursive: true });
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { /* new */ }
  const now = Date.now();
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: meta.createdAtMs ?? now, hasConversation: true, title: meta.title ?? "Fake chat", updatedAtMs: now, cwd }));
  const transcript = join(data, "projects", slug, "agent-transcripts", id, `${id}.jsonl`);
  mkdirSync(join(transcript, ".."), { recursive: true });
  const line = (o) => appendFileSync(transcript, JSON.stringify(o) + "\n");
  line({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Saturday, Nov 21, 2026, 12:38 PM (UTC+1)</timestamp>\n<user_query>\n${words}\n</user_query>` }] } });
  if (process.env.FAKE_CURSOR_SLOW) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CURSOR_SLOW)));
  line({ role: "assistant", message: { content: [{ type: "text", text: `ACK ${words.trim()}` }] } });
  line({ type: "turn_ended", status: "success" });
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `ACK ${words.trim()}`, session_id: id }));
} else {
  process.exit(64);
}
