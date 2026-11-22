// When you last wrote in a thread yourself (`WorkItem.typed`, docs/launch/engine.md §11 stage 3.9; spike/away-watch's
// `personWrote`): which messages each work system marks as a person's, and 10 & 2's own sends left out by what the Ledger
// recorded as they went. Records shaped as each work system writes them (their keys and provenance values; the words are
// made up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Adapter, WorkItem } from "../src/contract.ts";
import { personWrote as claudeWrote, Transcript } from "../src/claude/transcript.ts";
import { personWrote as t3Wrote, personWrites as t3Writes, T3Adapter } from "../src/t3/adapter.ts";
import { CodexAdapter } from "../src/codex/adapter.ts";
import { view, type Msg, type Part } from "../src/opencode/db.ts";
import { PiSession } from "../src/pi/session.ts";
import { Ledger } from "../src/ledger.ts";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { digestOf, newest, typedOf, type Write } from "../src/typed.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const T = Date.parse("2026-11-14T03:00:00Z");

/** Claude Code's records as 2.1.312 to 2.1.325 write them (read from real transcripts). */
const typed = (at: number, content: string) => ({
  type: "user", uuid: randomUUID(), promptId: randomUUID(), isSidechain: false, timestamp: iso(at), entrypoint: "cli", userType: "external",
  permissionMode: "auto", promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human", message: { role: "user", content },
});
const notice = (at: number) => ({
  type: "user", uuid: randomUUID(), isSidechain: false, timestamp: iso(at), entrypoint: "cli", promptSource: "system", origin: { kind: "task-notification", producer: "background-task" },
  turnOrigin: "task_notification", message: { role: "user", content: "<task-notification>\n<task-id>b7x2</task-id>\n<status>completed</status>\n</task-notification>" },
});

test("Claude Code: typed prompts, slash and shell commands typed are a person's; notices, another session's message (10 & 2's own follow-up), headless and SDK prompts and command output aren't", () => {
  assert.equal(claudeWrote(typed(T, "Fix the flaky test.")), true);
  assert.equal(claudeWrote({ type: "user", entrypoint: "cli", message: { content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" } }), true, "a slash command typed (its record says nothing more)");
  assert.equal(claudeWrote({ type: "user", entrypoint: "cli", message: { content: "<bash-input>ssh prism</bash-input>" } }), true, "a shell command typed with !");
  assert.equal(claudeWrote({ type: "user", version: "2.1.280", message: { content: "Older records say nothing of where they came from." } }), true);
  assert.equal(claudeWrote(notice(T)), false);
  assert.equal(claudeWrote({ ...notice(T), promptSource: undefined, origin: undefined, turnOrigin: undefined }), false, "a notice by its tag alone");
  assert.equal(claudeWrote({ type: "user", origin: { kind: "peer" }, turnOrigin: "peer", promptSource: "system", message: { content: "<cross-session-message from-name=\"10 & 2\" from-mode=\"prompting\">\nCarry on.\n</cross-session-message>" } }), false, "10 & 2's follow-up through the session's inbox");
  assert.equal(claudeWrote({ type: "user", message: { content: "<cross-session-message from-name=\"10 & 2\" from-mode=\"bypass\">\nCarry on.\n</cross-session-message>" } }), false, "the inbox's envelope by its tag alone");
  assert.equal(claudeWrote({ ...typed(T, "Reply with one sentence."), entrypoint: "sdk-cli", promptSource: "sdk", origin: undefined, turnOrigin: "sdk" }), false, "a headless run's prompt (10 & 2's own claude -p, a script's)");
  assert.equal(claudeWrote({ ...typed(T, "Go."), entrypoint: "t3-code", promptSource: "sdk", origin: undefined, turnOrigin: "sdk" }), false, "T3 Code's");
  assert.equal(claudeWrote({ type: "user", message: { content: "<local-command-stdout>Compacted.</local-command-stdout>" } }), false);
  assert.equal(claudeWrote({ type: "user", message: { content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" } }), false);
  assert.equal(claudeWrote({ ...typed(T, "Meta."), isMeta: true }), false);

  const t = new Transcript("/nowhere.jsonl");
  t.apply(typed(T, "Start the migration."));
  t.apply(notice(T + 60_000));
  t.apply(typed(T + 120_000, "Now open the PR."));
  assert.deepEqual(t.writes, [
    { at: iso(T), digest: digestOf("Start the migration."), desk: true, first: true },
    { at: iso(T + 120_000), digest: digestOf("Now open the PR."), desk: true },
  ], "each a person's, the session's first marked; the notice isn't one");
});

// The Skeptic on 3.10: a prompt typed while Claude Code is busy is written once it takes it, as `promptSource` "queued"
// (Claude Code 2.1.321 in the harness: origin human, entrypoint cli). Coming back to a busy session and typing is the
// commonest way back from Away.
test("Claude Code: a prompt typed while it was busy (queued) and a suggested prompt sent are a person's at this computer; another session's queued message still isn't", () => {
  assert.equal(claudeWrote({ ...typed(T, "Also fix the README."), promptSource: "queued" }), true);
  assert.equal(claudeWrote({ ...typed(T, "Run the tests."), promptSource: "suggestion_accepted" }), true);
  assert.equal(claudeWrote({ ...typed(T, "Carry on."), promptSource: "queued", origin: { kind: "peer" }, turnOrigin: "peer" }), false, "10 & 2's inbox message, queued");
  assert.equal(claudeWrote({ ...typed(T, "Go."), promptSource: "queued", entrypoint: "sdk-cli" }), false);
  const t = new Transcript("/nowhere.jsonl");
  t.apply(typed(T, "Refactor billing."));
  t.apply({ type: "queue-operation", operation: "enqueue", timestamp: iso(T + 90_000), content: "Also fix the README." });
  t.apply({ ...typed(T + 95_000, "Also fix the README."), promptSource: "queued" });
  assert.deepEqual(typedOf("claude:x", t.writes, []), { at: iso(T + 90_000), desk: iso(T + 90_000) });
});

// The Skeptic on 3.9 and 3.10: Claude Code writes a queued prompt only once it takes it, with that time, which can be the
// end of a long run; it wrote a `queue-operation` enqueue with the same words as it was typed. Records as 2.1.321 writes
// them in the harness (typed 21:49:34.613, enqueued 34.616, the busy turn's end 41.842, the queued record 41.867).
test("Claude Code: a prompt typed while it was busy is dated when it was typed (its enqueue), not when Claude Code took it; with no enqueue, no later than the run it waited behind", () => {
  const t = new Transcript("/nowhere.jsonl");
  t.apply(typed(T, "Run the whole suite."));
  t.apply({ type: "queue-operation", operation: "enqueue", timestamp: iso(T + 2 * 60_000), content: "Also fix the README." });
  t.apply({ type: "queue-operation", operation: "enqueue", timestamp: iso(T + 3 * 60_000), content: "<cross-session-message from-name=\"10 & 2\" from-mode=\"prompting\">\nCarry on.\n</cross-session-message>" });
  t.apply({ type: "queue-operation", operation: "dequeue", timestamp: iso(T + 32 * 60_000) });
  t.apply({ type: "assistant", uuid: randomUUID(), timestamp: iso(T + 32 * 60_000), message: { content: [{ type: "text", text: "Suite passes." }], stop_reason: "end_turn" } });
  t.apply({ ...typed(T + 32 * 60_000 + 30, "Also fix the README."), promptSource: "queued" });
  assert.deepEqual(typedOf("claude:x", t.writes, []), { at: iso(T + 2 * 60_000), desk: iso(T + 2 * 60_000) }, "typed 2 minutes in, not 32");
  // One whose enqueue isn't there (a transcript rotated, its words edited in the queue): no later than the run it waited
  // behind began, so it neither ends Away late nor takes that run's reply as seen.
  const u = new Transcript("/nowhere.jsonl");
  u.apply(typed(T, "Run the whole suite."));
  u.apply({ ...typed(T + 32 * 60_000, "Then the docs."), promptSource: "queued" });
  assert.equal(u.writes.at(-1)!.at, iso(T));
  // Typed in the ordinary way, its own time, enqueue or not.
  u.apply({ type: "queue-operation", operation: "enqueue", timestamp: iso(T + 40 * 60_000), content: "Ship it." });
  u.apply(typed(T + 41 * 60_000, "Ship it."));
  assert.equal(u.writes.at(-1)!.at, iso(T + 41 * 60_000));
  // That enqueue was its: a later queued "Ship it." with none of its own isn't dated by it.
  u.apply({ ...typed(T + 50 * 60_000, "Ship it."), promptSource: "queued" });
  assert.equal(u.writes.at(-1)!.at, iso(T + 41 * 60_000));
});

// The Skeptic on 3.9 and 3.10: Claude Code also takes a person's turn relayed from Slack or an email, and marks its record
// so (read from 2.1.321's binary; unmeasured): a person's, away from a computer.
test("Claude Code: a turn relayed from Slack or an email is a person's, but not at this computer", () => {
  const t = new Transcript("/nowhere.jsonl");
  t.apply(typed(T, "Start the migration."));
  t.apply({ ...typed(T + 60_000, "How's it going?"), verifiedSlackHumanTurn: true });
  t.apply({ ...typed(T + 120_000, "Ship it."), emailSenderTurn: "me@example.invalid" });
  assert.deepEqual(typedOf("claude:x", t.writes, []), { at: iso(T + 120_000), desk: iso(T) });
});

test("T3 Code: a message typed in its web or desktop app is a person's at a computer, in its phone app a person's away from one; its own sends, 10 & 2's, other agents', schedules' and notices aren't", () => {
  const m = (over: object) => ({ id: randomUUID(), role: "user", text: "Ship it.", createdBy: "user", creationSource: "web", createdAt: iso(T), ...over });
  assert.equal(t3Wrote(m({})), true);
  assert.equal(t3Wrote(m({ creationSource: "mobile" })), true);
  for (const [why, over] of [
    ["a usage limit's resume", { id: "limit-resume:abc:legacy", creationSource: "server", text: "Continue where you left off." }],
    ["a resume by its id alone", { id: "limit-resume:abc:legacy" }],
    ["a relayed answer or a restart's (server)", { creationSource: "server" }],
    ["10 & 2's own follow-up", { id: "driver:op-1", creationSource: "mobile" }],
    ["another agent's, through T3's MCP", { creationSource: "mcp" }],
    ["a provider's", { creationSource: "provider" }],
    ["a scheduled task's", { scheduledTaskId: "st-1" }],
    ["another thread's", { senderThreadId: "t-9" }],
    ["a notice", { notification: { source: { kind: "monitor" }, outcome: "completed", summary: "Done" } }],
    ["a workflow's script", { workflowScript: true }],
    ["an idle compaction", { idleCompaction: true }],
    ["the agent's own note", { createdBy: "agent" }],
    ["one that doesn't say where it came from", { creationSource: undefined }],
  ] as const) assert.equal(t3Wrote(m(over)), false, why);
  assert.deepEqual(t3Writes([m({ createdAt: iso(T + 60_000), creationSource: "mobile", text: "From the phone." }), m({ id: "driver:k", createdAt: iso(T + 90_000) }), m({})]), [
    { at: iso(T), digest: digestOf("Ship it."), desk: true },
    { at: iso(T + 60_000), digest: digestOf("From the phone."), desk: false },
  ], "oldest first; the phone's isn't at a computer");
});

test("OpenCode and Pi: the user's messages after a session's first are a person's, not known to be at a computer; the first, which neither says a person typed, isn't; Pi's extension notices aren't messages", () => {
  const msgs: Msg[] = [
    { id: "m1", role: "user", parentId: null, created: T, completed: null, finish: null, error: null, agent: "build", summary: false },
    { id: "m2", role: "assistant", parentId: "m1", created: T + 1000, completed: T + 2000, finish: "stop", error: null, agent: "build", summary: false },
    { id: "m3", role: "user", parentId: null, created: T + 60_000, completed: null, finish: null, error: null, agent: "build", summary: false },
  ];
  const parts: Part[] = [
    { id: "p1", messageId: "m1", type: "text", text: "Start it.", synthetic: false, tool: null, status: null, input: null },
    { id: "p2", messageId: "m2", type: "text", text: "Started.", synthetic: false, tool: null, status: null, input: null },
    { id: "p3", messageId: "m3", type: "text", text: "Now test it.", synthetic: false, tool: null, status: null, input: null },
  ];
  // Not at a computer as far as anyone can tell: a plugin's "continue" is the same user message (the Skeptic on 3.9 and 3.10).
  assert.deepEqual(view(msgs, parts).writes, [{ at: iso(T + 60_000), digest: digestOf("Now test it."), desk: false }]);

  const s = new PiSession("/nowhere.jsonl");
  const entries = [
    { type: "session", id: "s1", cwd: "/w", timestamp: iso(T), version: 3 },
    { type: "message", id: "e1", parentId: null, timestamp: iso(T), message: { role: "user", content: [{ type: "text", text: "Watch the build." }] } },
    { type: "message", id: "e2", parentId: "e1", timestamp: iso(T + 1000), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Watching." }] } },
    { type: "custom_message", id: "e3", parentId: "e2", timestamp: iso(T + 30_000), customType: "ad-process:notification", content: "exited 0", display: true },
    { type: "message", id: "e4", parentId: "e3", timestamp: iso(T + 60_000), message: { role: "user", content: [{ type: "text", text: "Now deploy it." }] } },
  ];
  for (const e of entries) s.apply(e);
  assert.deepEqual(s.projection.writes, [{ at: iso(T + 60_000), digest: digestOf("Now deploy it."), desk: false }], "an extension's sendUserMessage is the same");
});

test("typedOf: each of 10 & 2's sends takes the first write after it with its words, in its thread, once; new work only a thread's first; the rest are yours, at a computer or not", () => {
  const w = (at: number, words: string, over: Partial<Write> = {}): Write => ({ at: iso(at), digest: digestOf(words), desk: true, ...over });
  const send = (at: number, words: string, item: string | null = "a") => ({ key: `op-${at}`, item, digest: digestOf(words), at });
  assert.deepEqual(typedOf("a", [], []), { at: null, desk: null });
  assert.deepEqual(typedOf("a", [w(T, "Fix it.")], []), { at: iso(T), desk: iso(T) });
  // A follow-up agreed in a call, queued behind a long run: written 3 hours later, still 10 & 2's.
  assert.deepEqual(typedOf("a", [w(T, "Fix it."), w(T + 3 * 3600_000, "Carry on.")], [send(T + 60_000, "Carry on.")]), { at: iso(T), desk: iso(T) });
  // The same words, yours after it: one send takes one write.
  assert.deepEqual(typedOf("a", [w(T + 120_000, "Carry on."), w(T + 180_000, "Carry on.")], [send(T + 60_000, "Carry on.")]), { at: iso(T + 180_000), desk: iso(T + 180_000) });
  // Stamped a little before the send (two clocks read), still its; long before, or another thread's, or 13 hours on, yours.
  assert.deepEqual(typedOf("a", [w(T - 30_000, "Carry on.")], [send(T, "Carry on.")]), { at: null, desk: null });
  assert.deepEqual(typedOf("a", [w(T - 5 * 60_000, "Carry on.")], [send(T, "Carry on.")]).at, iso(T - 5 * 60_000));
  assert.deepEqual(typedOf("a", [w(T + 60_000, "Carry on.")], [send(T, "Carry on.", "b")]).at, iso(T + 60_000));
  assert.deepEqual(typedOf("a", [w(T + 13 * 3600_000, "Carry on.")], [send(T, "Carry on.")]).at, iso(T + 13 * 3600_000));
  // New work: its thread isn't known as it's sent, so it takes only a thread's first message.
  assert.deepEqual(typedOf("a", [w(T + 5000, "Start the docs.", { first: true })], [send(T, "Start the docs.", null)]), { at: null, desk: null });
  assert.deepEqual(typedOf("a", [w(T + 5000, "Start the docs.")], [send(T, "Start the docs.", null)]).at, iso(T + 5000));
  // And only in a thread made as it went (the skeptic on 7717d10f3219): by its creation time, else its first message's.
  assert.deepEqual(typedOf("a", [w(T + 30 * 60_000, "Start the docs.", { first: true })], [send(T, "Start the docs.", null)]).at, iso(T + 30 * 60_000));
  assert.deepEqual(typedOf("a", [w(T + 5000, "Start the docs.", { first: true })], [send(T, "Start the docs.", null)], undefined, iso(T - 3600_000)).at, iso(T + 5000));
  assert.deepEqual(typedOf("a", [w(T + 5000, "Start the docs.", { first: true })], [send(T, "Start the docs.", null)], undefined, iso(T + 3000)).at, null);
  // T3 Code's phone app: yours, not at a computer.
  assert.deepEqual(typedOf("a", [w(T, "At the desk."), w(T + 60_000, "From the phone.", { desk: false })], []), { at: iso(T + 60_000), desk: iso(T) });
  assert.equal(digestOf("  Carry  on.\n"), digestOf("Carry on."), "however it's spaced");
});

test("through the Ledger and Local: a follow-up 10 & 2 sent never moves typed, whatever the work system records; one it refused leaves nothing behind, and the user's own words still count", async () => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "typed-ledger-")));
  const writes = new Map<string, Write[]>([["a", [{ at: iso(Date.now() - 3600_000), digest: digestOf("Earlier."), desk: true }]]]);
  const items: WorkItem[] = [{ id: "a", title: "API", group: "proj", status: "completed", updatedAt: iso(Date.now()), settled: false, snoozedUntil: null, parentId: null, pendingQuestion: false }];
  let refuse = false;
  const adapter = {
    name: "fake", actions: ["follow_up"] as const, connected: () => true, list: async () => items.map((i) => ({ ...i })), report: async () => ({ text: "", question: null }),
    watch: () => () => {}, close: async () => {},
    execute: async (a: any) => {
      if (refuse) return { ok: false as const, error: "No." };
      // The work system writes it as the user's, as T3 Code, OpenCode and Pi do.
      writes.get(a.itemId)!.push({ at: iso(Date.now()), digest: digestOf(a.message), desk: true });
      return { ok: true as const };
    },
    personWrites: (id: string) => writes.get(id) ?? [],
  } satisfies Adapter & { personWrites(id: string): Write[] };
  const local = new Local([{ prefix: "", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })), () => ledger.sends());
  const before = (await local.list())[0]!.typed;
  assert.equal(before?.desk, writes.get("a")![0]!.at);
  const action = { kind: "follow_up" as const, itemId: "a", message: "Carry on." };
  assert.deepEqual(await ledger.execute(action, "op-1", { retrySafe: false, execute: () => local.dispatch(action, "op-1") }), { ok: true });
  assert.deepEqual((await local.list())[0]!.typed, before, "10 & 2's own send isn't you writing");
  refuse = true;
  const other = { ...action, message: "Something else." };
  await ledger.execute(other, "op-2", { retrySafe: false, execute: () => local.dispatch(other, "op-2") });
  assert.deepEqual(ledger.sends().map((s) => s.digest), [digestOf("Carry on.")], "a refused send isn't kept");
  // The user types the refused words themselves: theirs.
  const mine = iso(Date.now() + 1000);
  writes.get("a")!.push({ at: mine, digest: digestOf("Something else."), desk: true });
  assert.equal((await local.list())[0]!.typed?.desk, mine);
  await ledger.close();
});

test("through the real Claude adapter: background notices on Saturday night, 10 & 2's inbox message and a headless run leave typed where it was, though each starts a turn; the user typing at the terminal moves it", async (t) => {
  const { harness } = await import("./fixtures/claude/helpers.ts");
  const h = harness(t);
  const friday = Date.parse("2026-11-13T18:00:00Z");
  const f = h.transcript();
  const at = (ms: number) => ({ timestamp: iso(ms) });
  f.append({ ...typed(friday - 3_600_000, "Run the long migration in the background and watch it."), ...at(friday - 3_600_000) });
  f.append({ type: "assistant", uuid: randomUUID(), ...at(friday - 3_590_000), message: { content: [{ type: "text", text: "Started it." }], stop_reason: "end_turn" } });
  h.clock.now = friday;
  await h.adapter.start();
  const local = new Local([{ prefix: "claude", adapter: h.adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })));
  const typedNow = async () => (await local.list())[0]!.typed;
  assert.deepEqual(await typedNow(), { at: iso(friday - 3_600_000), desk: iso(friday - 3_600_000) });
  const saturday = Date.parse("2026-11-14T03:12:00Z");
  f.append({ ...notice(saturday), ...at(saturday) });
  f.append({ type: "assistant", uuid: randomUUID(), ...at(saturday + 20_000), message: { content: [{ type: "text", text: "The migration finished." }], stop_reason: "end_turn" } });
  f.append({ type: "user", uuid: randomUUID(), ...at(saturday + 60_000), origin: { kind: "peer" }, turnOrigin: "peer", promptSource: "system", message: { content: "<cross-session-message from-name=\"10 & 2\" from-mode=\"prompting\">\nOpen the PR.\n\n(Your user said this to 10 & 2, their voice assistant, and confirmed it.)\n</cross-session-message>" } });
  f.append({ type: "user", uuid: randomUUID(), ...at(saturday + 120_000), entrypoint: "sdk-cli", promptSource: "sdk", turnOrigin: "sdk", message: { content: "Carry on." } });
  f.append({ type: "assistant", uuid: randomUUID(), ...at(saturday + 130_000), message: { content: [{ type: "text", text: "Carried on." }], stop_reason: "end_turn" } });
  h.clock.now = saturday + 200_000;
  const items = await local.list();
  assert.deepEqual([items[0]!.lastRunAt, items[0]!.typed], [iso(saturday + 130_000), { at: iso(friday - 3_600_000), desk: iso(friday - 3_600_000) }], "runs end; nobody typed");
  const monday = Date.parse("2026-11-16T09:05:00Z");
  f.append({ ...typed(monday, "Good. Now open the PR."), ...at(monday) });
  h.clock.now = monday + 1000;
  assert.deepEqual(await typedNow(), { at: iso(monday), desk: iso(monday) });
});

// Fable on 3.9: a send's claim on its message lasted only 12 hours (`sends()` returned the last 12 hours), so on a long
// Away 10 & 2's own follow-up became "yours at a computer" 13 hours later and ended Away with "You wrote in …".
test("through the Ledger and Local: a follow-up OpenCode or Pi writes as the user's is still 10 & 2's 13 and 80 hours later", async (t) => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "typed-ledger-")));
  t.after(() => ledger.close());
  const sentAt = Date.now();
  const writes: Write[] = [{ at: iso(sentAt - 3600_000), digest: digestOf("Earlier."), desk: true }];
  const items: WorkItem[] = [{ id: "s", title: "Migration", group: "proj", status: "running", updatedAt: iso(sentAt), settled: false, snoozedUntil: null, parentId: null, pendingQuestion: false }];
  const adapter = {
    name: "fake", actions: ["follow_up"] as const, connected: () => true, list: async () => items.map((i) => ({ ...i })), report: async () => ({ text: "", question: null }),
    watch: () => () => {}, close: async () => {},
    // Written as the user's message, as OpenCode and Pi write a follow-up.
    execute: async (a: any) => (writes.push({ at: iso(Date.now()), digest: digestOf(a.message), desk: true }), { ok: true as const }),
    personWrites: () => writes,
  } satisfies Adapter & { personWrites(id: string): Write[] };
  const local = new Local([{ prefix: "pi", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })), () => ledger.sends());
  const action = { kind: "follow_up" as const, itemId: "pi:s", message: "Yes, go ahead." };
  assert.deepEqual(await ledger.execute(action, "op-1", { retrySafe: false, execute: () => local.dispatch(action, "op-1"), leftOut: () => local.sendLeftOut(action, "op-1") }), { ok: true });
  const before = { at: iso(sentAt - 3600_000), desk: iso(sentAt - 3600_000) };
  assert.deepEqual((await local.list())[0]!.typed, before);
  for (const hours of [13, 80]) {
    t.mock.method(Date, "now", () => sentAt + hours * 3600_000);
    assert.deepEqual((await local.list())[0]!.typed, before, `${hours} hours on, still 10 & 2's`);
    t.mock.restoreAll();
  }
});

// The Skeptic on 3.10: a send that never shows as a person's message (Claude Code's inbox or headless run, an answer to a
// question, one left out by its own id) kept its row, which took the user's own same words, typed later, for 12 hours.
test("through the Ledger and Local: a follow-up that's never a person's message leaves no claim behind, so your same words an hour later are yours", async (t) => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "typed-ledger-")));
  t.after(() => ledger.close());
  const writes: Write[] = [];
  const items: WorkItem[] = [{ id: "x", title: "API", group: "proj", status: "running", updatedAt: iso(Date.now()), settled: false, snoozedUntil: null, parentId: null, pendingQuestion: false }];
  const unwritten = new Set<string>();
  const adapter = {
    name: "fake", actions: ["follow_up"] as const, connected: () => true, list: async () => items.map((i) => ({ ...i })), report: async () => ({ text: "", question: null }),
    watch: () => () => {}, close: async () => {},
    // Through the session's inbox: Claude Code records another session's message, never a person's prompt.
    execute: async (_a: any, key: string) => (unwritten.add(key), { ok: true as const }),
    personWrites: () => writes,
    sendLeftOut: (_a: any, key: string) => unwritten.delete(key),
  } satisfies Adapter & { personWrites(id: string): Write[]; sendLeftOut(a: any, key: string): boolean };
  const local = new Local([{ prefix: "claude", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })), () => ledger.sends());
  const action = { kind: "follow_up" as const, itemId: "claude:x", message: "Yes, go ahead." };
  assert.deepEqual(await ledger.execute(action, "op-1", { retrySafe: false, execute: () => local.dispatch(action, "op-1"), leftOut: () => local.sendLeftOut(action, "op-1") }), { ok: true });
  assert.deepEqual(ledger.sends(), [], "nothing of it will show as a person's message: no claim kept");
  const mine = iso(Date.now() + 3600_000);
  writes.push({ at: mine, digest: digestOf("Yes, go ahead."), desk: true });
  assert.deepEqual((await local.list())[0]!.typed, { at: mine, desk: mine });
});

test("which of 10 & 2's sends each work system never writes as a person's: Codex's every one (its own ids, or a question's answer), T3 Code's follow-ups (driver: ids, relayed answers) but not its new work", () => {
  const follow = { kind: "follow_up" as const, itemId: "t", message: "Carry on." };
  const start = { kind: "start_work" as const, placeId: "p", message: "Start.", profile: { name: "N", runtimeMode: "auto" as const, workspace: "root" as const, interactionMode: "default" as const } };
  assert.deepEqual([CodexAdapter.prototype.sendLeftOut(follow), CodexAdapter.prototype.sendLeftOut(start)], [true, true]);
  assert.deepEqual([T3Adapter.prototype.sendLeftOut(follow), T3Adapter.prototype.sendLeftOut(start)], [true, false]);
});

// Sol on 45ec9eccdf6f (F5): a send's claim was worked out afresh at every look from the newest 20 writes, so once its own
// message left that window it took the next message with the same words: you typing "Continue" 15 minutes into Away,
// 20 messages on, was taken for 10 & 2's, and Away stayed on. A send keeps the message it was found as, in the Ledger,
// and never takes another, after a restart too.
test("through the Ledger and Local: a send keeps the message it was found as once that leaves the newest 20, and after a restart; your same words later are yours", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "typed-ledger-"));
  let ledger = new Ledger(dir);
  t.after(() => ledger.close());
  const start = Date.now();
  const writes: Write[] = [];
  const items: WorkItem[] = [{ id: "s", title: "Migration", group: "proj", status: "running", updatedAt: iso(start), settled: false, snoozedUntil: null, parentId: null, pendingQuestion: false }];
  const adapter = {
    name: "fake", actions: ["follow_up"] as const, connected: () => true, list: async () => items.map((i) => ({ ...i })), report: async () => ({ text: "", question: null }),
    watch: () => () => {}, close: async () => {},
    // Written as the user's message, as OpenCode and Pi write a follow-up; the newest 20 kept, as every adapter does.
    execute: async (a: any) => (writes.push({ at: iso(start + 1000), digest: digestOf(a.message), desk: true }), { ok: true as const }),
    personWrites: () => newest(writes),
  } satisfies Adapter & { personWrites(id: string): Write[] };
  const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] }));
  const localOf = (l: Ledger) => new Local([{ prefix: "pi", adapter }], policy, () => l.sends(), (key, found) => l.claim(key, found));
  let local = localOf(ledger);
  const action = { kind: "follow_up" as const, itemId: "pi:s", message: "Continue" };
  assert.deepEqual(await ledger.execute(action, "op-1", { retrySafe: false, execute: () => local.dispatch(action, "op-1"), leftOut: () => local.sendLeftOut(action, "op-1") }), { ok: true });
  assert.deepEqual((await local.list())[0]!.typed, { at: null, desk: null }, "10 & 2's, found as its message");
  // A restart, then 19 messages of yours.
  await ledger.close();
  ledger = new Ledger(dir);
  local = localOf(ledger);
  for (let n = 1; n <= 19; n++) writes.push({ at: iso(start + n * 60_000), digest: digestOf(`Message ${n}.`), desk: true });
  assert.equal((await local.list())[0]!.typed?.desk, iso(start + 19 * 60_000));
  // 15 minutes on you type "Continue" yourself: the 21st write, and 10 & 2's own message leaves the newest 20.
  const yours = iso(start + 34 * 60_000);
  writes.push({ at: yours, digest: digestOf("Continue"), desk: true });
  assert.deepEqual((await local.list())[0]!.typed, { at: yours, desk: yours }, "was 19 minutes in: the old send took your message");
  await ledger.close();
  ledger = new Ledger(dir);
  assert.deepEqual((await localOf(ledger).list())[0]!.typed, { at: yours, desk: yours }, "after a restart too");
});

// The skeptic on 7717d10f3219 (F5): new work's send, its thread not known as it went, was found as whichever thread's
// first message with its words a look reached first, within 12 hours. A thread you started yourself with the same words
// could take it, and its first message then wasn't yours (Away stayed on), while 10 & 2's own thread's was. Its thread
// is made as it's sent: one made later is yours.
test("through the Ledger and Local: new work's send is found in the thread made as it went, never one you started later with the same words", async (t) => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "typed-ledger-")));
  t.after(() => ledger.close());
  const start = Date.now();
  const writes = new Map<string, Write[]>();
  const items: WorkItem[] = [];
  const thread = (id: string, at: number, words: string) => {
    // Yours, listed first.
    items.unshift({ id, title: words, group: "proj", status: "running", updatedAt: iso(at), settled: false, snoozedUntil: null, parentId: null, pendingQuestion: false, createdAt: iso(at) });
    writes.set(id, [{ at: iso(at), digest: digestOf(words), desk: true, first: true }]);
  };
  const adapter = {
    name: "fake", actions: ["start_work"] as const, connected: () => true, list: async () => items.map((i) => ({ ...i })), report: async () => ({ text: "", question: null }),
    watch: () => () => {}, close: async () => {},
    // T3 Code writes new work's message as the user's, its thread made as it's sent.
    execute: async (a: any) => (thread("launched", start + 2000, a.message), { ok: true as const, itemId: "launched" }),
    personWrites: (id: string) => writes.get(id) ?? [],
  } satisfies Adapter & { personWrites(id: string): Write[] };
  const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["start_work"] }));
  const local = new Local([{ prefix: "", adapter }], policy, () => ledger.sends(), (key, found) => ledger.claim(key, found));
  const action = { kind: "start_work" as const, placeId: "p1", message: "Fix the login bug.", profile: { name: "Default", runtimeMode: "auto" as const, workspace: "root" as const, interactionMode: "default" as const } };
  assert.equal((await ledger.execute(action, "op-1", { retrySafe: false, execute: () => local.dispatch(action, "op-1") })).ok, true);
  // Half an hour on, before a look (the brain away), you start a thread with the same words yourself.
  thread("yours", start + 30 * 60_000, "Fix the login bug.");
  const typed = Object.fromEntries((await local.list()).map((i) => [i.id, i.typed]));
  assert.deepEqual(typed, { yours: { at: iso(start + 30 * 60_000), desk: iso(start + 30 * 60_000) }, launched: { at: null, desk: null } }, "was yours taken for 10 & 2's, and 10 & 2's for yours");
  assert.deepEqual(ledger.sends().map((s) => s.found), [{ item: "launched", at: iso(start + 2000) }]);
});
