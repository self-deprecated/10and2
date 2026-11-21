// The Cursor CLI adapter against chat files laid out as Cursor's CLI writes them, and a fake `cursor-agent`
// (fixtures/cursor/cursor.mjs) for its runs. No real Cursor, no model, no network.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CursorAdapter, modeFlags, shortTitle } from "../src/cursor/adapter.ts";
import { asked, CursorChat, sentAt } from "../src/cursor/chat.ts";
import { bucketOf, slugOf, transcriptPaths } from "../src/cursor/paths.ts";
import { isCursor, openChats } from "../src/cursor/open.ts";
import { chatSettings, parseModels, runArgs } from "../src/cursor/cli.ts";
import type { Policy, RuntimeMode } from "../src/policy.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { nodeCommand, removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";

const fake = resolve(import.meta.dirname, "fixtures", "cursor", "cursor.mjs");
const build: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };

function harness(t: TestContext, o: { ceiling?: RuntimeMode; open?: Set<string>; models?: boolean } = {}) {
  // Resolved: a Mac's temp folder is behind a symlink, and Cursor records the folder as the process sees it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "10and2-cursor-")));
  const config = join(root, "cursor"), project = join(root, "project"), state = join(root, "state"), log = join(root, "runs.jsonl");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const open = o.open ?? new Set<string>();
  const policy: Policy = { brain: "wss://unused.invalid/connector", projects: [root], actions: ["follow_up", "settle", "snooze", "archive", "start_work"],
    maxRuntimeMode: o.ceiling ?? "full-access", claude: false, t3: false, codex: false, opencode: false, pi: false, cursor: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" };
  const prior = { ...process.env };
  Object.assign(process.env, { FAKE_CURSOR_LOG: log });
  t.after(() => { for (const k of ["FAKE_CURSOR_LOG", "FAKE_CURSOR_FAIL"]) if (prior[k] === undefined) delete process.env[k]; });
  // Every scan asks which chats are open: how many there have been.
  let scans = 0;
  const adapter = new CursorAdapter({ policy, db: join(state, "cursor.db"), stateDir: state, log: () => {}, configDir: config, dataDir: config,
    cursorCommand: nodeCommand(fake), readCacheMs: 0, acceptanceTimeoutMs: 10_000, openChats: () => { scans++; return open; }, readModels: o.models ?? false });
  // Closed before its folder is removed: Windows can't remove a folder while a file in it (its cursor.db) is open, and
  // node:test runs none of a test's later after hooks once one fails.
  t.after(async () => { await adapter.close(); removeDir(root); });
  /** A chat as Cursor leaves it: its meta.json, and its transcript's lines. */
  const chat = (lines: object[], meta: Record<string, unknown> = {}, cwd = project) => {
    const id = randomUUID(), dir = join(config, "chats", bucketOf(cwd), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now() - 60_000, hasConversation: true, updatedAtMs: Date.now(), cwd, ...meta }));
    const path = transcriptPaths(config, cwd, id)[0]!;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, lines.map((l) => JSON.stringify(l) + "\n").join(""));
    return { id, dir, path };
  };
  const runs = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { root, config, project, policy, adapter, chat, open, runs, scans: () => scans };
}
const user = (text: string, at = "Saturday, Nov 21, 2026, 12:38 PM (UTC+1)") => ({ role: "user", message: { content: [{ type: "text", text: `<timestamp>${at}</timestamp>\n<user_query>\n${text}\n</user_query>` }] } });
const assistant = (text: string, tools: string[] = []) => ({ role: "assistant", message: { content: [...(text ? [{ type: "text", text }] : []), ...tools.map((name) => ({ type: "tool_use", name, input: {} }))] } });
const ended = (status = "success") => ({ type: "turn_ended", status });

test("paths are Cursor's own: the folder's MD5 for chats, its slug for transcripts", () => {
  // The MD5 of the folder as resolved: on Windows a folder has a drive (there "/home/me/proj" is the current drive's).
  const [folder, md5] = WINDOWS ? ["C:\\home\\me\\proj", "e3e164de514d700f6d3dd135e008acb8"] : ["/home/me/proj", "1c76789e4940e3a34113521951d8a1ae"];
  assert.equal(bucketOf(folder), md5);
  assert.equal(bucketOf(folder + sep), bucketOf(folder));
  assert.equal(slugOf("/home/me/my.proj/x"), "home-me-my-proj-x");
  // Windows joins them with "\": the same layout.
  assert.deepEqual(transcriptPaths("/c", "/home/me/proj", "abc").map((p) => p.replaceAll(sep, "/")), ["/c/projects/home-me-proj/agent-transcripts/abc/abc.jsonl", "/c/projects/home-me-proj/agent-transcripts/abc.jsonl"]);
  assert.equal(asked("<user_info>OS</user_info>\n<user_query>\nFix it\n</user_query>"), "Fix it");
  assert.equal(asked("Plain words"), "Plain words");
});

test("chats are listed with their state, title and folder; subagents, empty, hidden and old ones aren't", async (t) => {
  const h = harness(t);
  const done = h.chat([user("Make it faster"), assistant("", ["Read"]), assistant("Done, it's faster."), ended()], { title: "Lap timer speed" });
  const failed = h.chat([user("Break"), ended("error")]);
  const aborted = h.chat([user("Stop me"), assistant("Partial"), ended("aborted")]);
  const pending = h.chat([user("A very long first message that goes on and on about what the lap timer should do next, and more")]);
  h.chat([user("sub")], { isSubagent: true });
  h.chat([], { hasConversation: false });
  const elsewhere = mkdtempSync(join(tmpdir(), "10and2-cursor-hidden-")); t.after(() => removeDir(elsewhere));
  h.chat([user("hidden"), assistant("x"), ended()], {}, elsewhere);
  h.chat([user("old"), assistant("x"), ended()], { updatedAtMs: Date.now() - 20 * 86_400_000 });
  await h.adapter.start();
  const items = new Map((await h.adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.size, 4);
  assert.deepEqual([done, failed, aborted, pending].map((c) => items.get(c.id)!.status), ["completed", "failed", "cancelled", "idle"]);
  assert.equal(items.get(done.id)!.title, "Lap timer speed");
  assert.equal(items.get(pending.id)!.title, shortTitle("A very long first message that goes on and on about what the lap timer should do next, and more"));
  assert.equal(items.get(done.id)!.group, "project");
  assert.equal((await h.adapter.report(done.id)).text, "Done, it's faster.");
  assert.deepEqual(await h.adapter.firstAsk(done.id), { text: "Make it faster", at: items.get(done.id)!.createdAt, complete: true });
  assert.equal(h.adapter.places().length, 1);
  assert.equal(h.adapter.places()[0]!.name, "project");
});

test("in plan mode the plan is the reply", async (t) => {
  const h = harness(t);
  const plan = { role: "assistant", message: { content: [{ type: "tool_use", name: "CreatePlan", input: { name: "Add CHANGELOG", plan: "# Add CHANGELOG.md\n\n1. Create it." } }] } };
  const c = h.chat([user("Plan a changelog"), assistant("Checking the repo briefly so the plan can be concrete.", ["Read", "Glob"]), plan, ended()]);
  await h.adapter.start();
  assert.equal((await h.adapter.report(c.id)).text, "# Add CHANGELOG.md\n\n1. Create it.");
});

test("every finished turn's reply is kept, newest first, with the words that started it", async (t) => {
  const h = harness(t);
  const c = h.chat([user("One"), assistant("First reply"), ended(), user("Two"), assistant("Working"), assistant("Second reply"), ended(), user("Three")]);
  await h.adapter.start();
  const replies = await h.adapter.replies(c.id);
  assert.deepEqual(replies.map((r) => [r.text, r.prompt]), [["Second reply", "Two"], ["First reply", "One"]]);
  assert.ok(replies[0]!.at > replies[1]!.at);
  assert.equal(replies[1]!.at, "2026-11-21T11:38:00.000Z", "an older reply has its turn's own time");
  const item = (await h.adapter.list())[0]!;
  assert.equal(item.status, "idle", "an unfinished turn nothing has open is idle");
});

test("a chat a process has open is listed as running, and a follow-up to it is refused in words", async (t) => {
  const open = new Set<string>();
  const h = harness(t, { open });
  const c = h.chat([user("Work"), assistant("Reading files")]);
  open.add(c.id);
  await h.adapter.start();
  const item = (await h.adapter.list()).find((i) => i.id === c.id)!;
  assert.equal(item.status, "running");
  assert.equal((await h.adapter.report(c.id)).progress, "Reading files");
  const action: Action = { kind: "follow_up", itemId: c.id, message: "More" };
  assert.match((await h.adapter.check(action))!, /open in Cursor/);
  assert.match(h.adapter.refusals()[c.id]!.follow_up!, /open in Cursor/);
  assert.equal(h.runs().length, 0);
});

test("a closed chat is continued: its words on stdin, its own permissions within the ceiling, sent once", async (t) => {
  const h = harness(t, { ceiling: "auto" });
  const c = h.chat([user("Start"), assistant("Started"), ended()]);
  await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: c.id, message: "Now add tests" };
  assert.deepEqual(await h.adapter.execute(action, "k1"), { ok: true });
  const run = h.runs().at(-1);
  assert.equal(run.words, "Now add tests");
  assert.ok(!run.args.includes("Now add tests"), "the words aren't on the command line");
  assert.deepEqual(run.args.slice(0, 6), ["-p", "--output-format", "stream-json", "--trust", "--resume", c.id]);
  // No settings of its own (no store.db): it runs as the ceiling, auto, never with --force.
  assert.ok(run.args.includes("--auto-review") && !run.args.includes("--force"));
  assert.equal((await h.adapter.report(c.id)).text, "ACK Now add tests");
  assert.deepEqual(await h.adapter.execute(action, "k1"), { ok: true }, "the same key returns its receipt");
  assert.equal(h.runs().length, 1, "and isn't sent again");
  assert.match((await h.adapter.execute({ ...action, message: "Other" }, "k1") as { error: string }).error, /already used/);
});

test("a run that fails says so, and one with no evidence is unknown and never resent", async (t) => {
  const h = harness(t);
  const c = h.chat([user("Start"), assistant("Started"), ended()]);
  await h.adapter.start();
  process.env.FAKE_CURSOR_FAIL = "1";
  const r = await h.adapter.execute({ kind: "follow_up", itemId: c.id, message: "x" }, "f1");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signed in/);
});

test("new work: a chat made by Cursor first, run in the project, listed by its id", async (t) => {
  const h = harness(t, { models: true });
  h.chat([user("Earlier"), assistant("Done"), ended()]);
  await h.adapter.start();
  await new Promise((r) => setTimeout(r, 1500));
  const place = h.adapter.places()[0]!;
  assert.deepEqual(place.models, [{ id: "auto", name: "Auto" }, { id: "gpt-5.5", name: "GPT-5.5" }, { id: "claude-opus-5-5-thinking", name: "Opus 5.5 Thinking" }]);
  const start: Action = { kind: "start_work", placeId: place.id, message: "Build the thing", profile: { ...build, interactionMode: "plan" }, model: "gpt-5.5" } as Action;
  const r = await h.adapter.execute(start, "s1") as { ok: true; itemId: string };
  assert.equal(r.ok, true);
  const run = h.runs().at(-1);
  assert.equal(run.cwd, resolve(h.project));
  assert.ok(run.args.includes("--force") && run.args.includes("--plan"));
  assert.deepEqual(run.args.slice(run.args.indexOf("--model"), run.args.indexOf("--model") + 2), ["--model", "gpt-5.5"]);
  const item = (await h.adapter.list()).find((i) => i.id === r.itemId)!;
  assert.equal(item.title, "Fake chat");
  assert.equal((await h.adapter.report(r.itemId)).text, "ACK Build the thing");
  assert.match((await h.adapter.check({ ...start, model: "nope" } as Action))!, /doesn't offer that model/);
});

test("permissions: Cursor's flags for each mode, and nothing below editing without asking", async (t) => {
  assert.deepEqual(modeFlags("full-access"), ["--force"]);
  assert.deepEqual(modeFlags("auto"), ["--auto-review"]);
  assert.deepEqual(modeFlags("auto-accept-edits"), []);
  assert.equal(modeFlags("approval-required"), null);
  const h = harness(t, { ceiling: "approval-required" });
  const c = h.chat([user("Start"), assistant("Started"), ended()]);
  await h.adapter.start();
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: c.id, message: "x" }))!, /without asking/);
  assert.match((await h.adapter.check({ kind: "start_work", placeId: h.adapter.places()[0]?.id ?? "none", message: "x", profile: { ...build, runtimeMode: "approval-required" } } as Action))!, /without asking|isn't visible/);
});

test("a chat's own settings: how it last ran, from its store.db metadata", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "10and2-cursor-store-")); t.after(() => removeDir(dir));
  const write = (m: object) => {
    const db = new DatabaseSync(join(dir, "store.db"));
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('0', ?)").run(Buffer.from(JSON.stringify(m)).toString("hex"));
    db.close();
  };
  assert.deepEqual(chatSettings(dir), { runtimeMode: null, mode: null });
  write({ agentId: "x", mode: "plan", isRunEverything: false, approvalMode: "allowlist" });
  assert.deepEqual(chatSettings(dir), { runtimeMode: "auto-accept-edits", mode: "plan" });
  write({ agentId: "x", mode: "default", isRunEverything: true });
  assert.equal(chatSettings(dir).runtimeMode, "full-access");
  write({ agentId: "x", mode: "default", isRunEverything: false, approvalMode: "auto-review" });
  assert.equal(chatSettings(dir).runtimeMode, "auto");
});

test("settle, snooze and archive are kept here", async (t) => {
  const h = harness(t);
  const c = h.chat([user("Start"), assistant("Started"), ended()]);
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "settle", itemId: c.id }, "t1"), { ok: true });
  assert.equal((await h.adapter.list())[0]!.settled, true);
  assert.deepEqual(await h.adapter.execute({ kind: "archive", itemId: c.id }, "t2"), { ok: true });
  assert.equal((await h.adapter.list()).length, 0);
});

test("a chats folder that's removed is let go, and watched again once it's made again", async (t) => {
  const h = harness(t);
  h.chat([user("Start"), assistant("Started"), ended()]);
  await h.adapter.start();
  const chats = join(h.config, "chats"), heard = new Set<string>();
  h.adapter.watch((ids) => { for (const id of ids) heard.add(id); });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));
  removeDir(chats);
  await wait(500);
  const scans = h.scans();
  await wait(500);
  assert.equal(h.scans(), scans, "once it's read as gone, nothing more is read (Windows reported a removed folder without end)");
  mkdirSync(chats);
  await h.adapter.list();
  // The scans its making brings have run: the new chat is heard of only if the folder itself is watched.
  await wait(500);
  const c = h.chat([user("Again"), assistant("Back"), ended()]);
  for (const end = Date.now() + 5000 * SLOW; !heard.has(c.id) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(heard.has(c.id), "a new chat there is heard of at once, not at the next periodic scan");
});

test("open chats are the ones with SQLite's WAL beside their store.db, while Cursor runs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "10and2-cursor-open-")); t.after(() => removeDir(dir));
  for (const id of ["a1", "b2"]) mkdirSync(join(dir, "bucket", id), { recursive: true });
  writeFileSync(join(dir, "bucket", "a1", "store.db"), ""); writeFileSync(join(dir, "bucket", "a1", "store.db-wal"), "");
  writeFileSync(join(dir, "bucket", "b2", "store.db"), "");
  assert.deepEqual([...openChats(dir, () => true)], ["a1"]);
  assert.deepEqual([...openChats(dir, () => false)], [], "a WAL a crash left behind, with no Cursor running");
  assert.deepEqual([...openChats(join(dir, "none"), () => true)], []);
  assert.ok(isCursor("/nix/store/x-cursor-cli/share/cursor-agent/node --use-system-ca /nix/store/x/share/cursor-agent/index.js"));
  assert.ok(isCursor("/home/me/.local/bin/cursor-agent --resume x"));
  assert.ok(!isCursor("node /usr/lib/10and2/dist/10and2.js run") && !isCursor("vim cursor-agent.md"));
});

test("a turn's time is the minute Cursor stamps on the words", () => {
  assert.equal(new Date(sentAt("<timestamp>Saturday, Nov 21, 2026, 12:38 PM (UTC+1)</timestamp>\n<user_query>x</user_query>")!).toISOString(), "2026-11-21T11:38:00.000Z");
  assert.equal(new Date(sentAt("<timestamp>Monday, Jan 5, 2027, 12:05 AM (UTC-5:30)</timestamp>")!).toISOString(), "2027-01-05T05:35:00.000Z");
  assert.equal(new Date(sentAt("<timestamp>Monday, Jan 5, 2027, 9:05 AM (UTC)</timestamp>")!).toISOString(), "2027-01-05T09:05:00.000Z");
  assert.equal(sentAt("no stamp"), null);
});

test("models and a turn's arguments", () => {
  assert.deepEqual(parseModels("\x1b[1mAvailable models\x1b[0m\n\nauto - Auto\ngpt-5.5 - GPT-5.5  (current)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\nauto - Auto (default)\n\nTip: use --model <id>"), [{ id: "auto", name: "Auto" }, { id: "gpt-5.5", name: "GPT-5.5" }, { id: "grok-4.7-low-fast", name: "Grok 4.7 Low Fast" }]);
  assert.deepEqual(runArgs({ id: "x", flags: ["--force"] }), ["-p", "--output-format", "stream-json", "--trust", "--resume", "x", "--force"]);
});

test("a transcript Cursor rewrites from the start is read again", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "10and2-cursor-chat-")); t.after(() => removeDir(dir));
  const cwd = join(dir, "p"), id = randomUUID(), chatDir = join(dir, "chats", bucketOf(cwd), id);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, "meta.json"), JSON.stringify({ createdAtMs: 1, updatedAtMs: 2, hasConversation: true, cwd }));
  const path = transcriptPaths(dir, cwd, id)[0]!;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [user("a"), assistant("long reply here"), ended()].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const chat = new CursorChat(id, chatDir);
  chat.read(dir);
  assert.equal(chat.projection.replies[0]!.text, "long reply here");
  writeFileSync(path, JSON.stringify(user("b")) + "\n");
  chat.read(dir);
  assert.equal(chat.projection.replies.length, 0);
  assert.equal(chat.projection.prompt, "b");
  appendFileSync(path, JSON.stringify(assistant("ok")) + "\n" + JSON.stringify(ended()) + "\n");
  chat.read(dir);
  assert.equal(chat.projection.replies[0]!.text, "ok");
  assert.ok(existsSync(path));
});

test("a resumed chat's transcript, rewritten in place without the older turn's end, keeps its replies and their ids", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "10and2-cursor-chat-")); t.after(() => removeDir(dir));
  const cwd = join(dir, "p"), id = randomUUID(), chatDir = join(dir, "chats", bucketOf(cwd), id);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, "meta.json"), JSON.stringify({ createdAtMs: 1, updatedAtMs: 2, hasConversation: true, cwd }));
  const path = transcriptPaths(dir, cwd, id)[0]!;
  mkdirSync(join(path, ".."), { recursive: true });
  const write = (lines: object[]) => writeFileSync(path, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  // What Cursor wrote (measured on 2026.11.19): the first turn with its end, then, resumed, the whole file again.
  write([user("Reply with exactly: ACK ONE"), assistant("ACK ONE"), ended()]);
  const chat = new CursorChat(id, chatDir);
  chat.read(dir);
  const first = chat.projection.replies[0]!;
  assert.equal(chat.projection.asks, 1);
  write([user("Reply with exactly: ACK ONE"), assistant("ACK ONE"), user("Now reply with exactly: ACK TWO")]);
  chat.read(dir);
  assert.deepEqual(chat.projection.replies.map((r) => r.text), ["ACK ONE"], "the first turn ended when the second was asked");
  assert.equal(chat.projection.replies[0]!.messageId, first.messageId);
  assert.equal(chat.projection.open, true);
  assert.deepEqual(chat.asksSince(1), ["Now reply with exactly: ACK TWO"]);
  appendFileSync(path, JSON.stringify(assistant("ACK TWO")) + "\n" + JSON.stringify(ended()) + "\n");
  chat.read(dir);
  assert.deepEqual(chat.projection.replies.map((r) => r.text), ["ACK TWO", "ACK ONE"]);
  assert.equal(chat.projection.replies[1]!.messageId, first.messageId);
  assert.equal(chat.projection.status, "completed");
});
