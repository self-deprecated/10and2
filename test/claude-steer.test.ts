// Steering Claude Code sessions something already has open (a terminal, a background session, a run of Driver's own)
// through their inbox; answering Claude's own questions through the PermissionRequest hook; and starting or continuing
// work as background sessions. All against synthetic sockets, transcripts and a fake `claude`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { answersFor, goAhead } from "../src/claude/adapter.ts";
import { attestedMode, envelope, heldFor } from "../src/claude/inbox.ts";
import { relayHook } from "../src/claude/hooks.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { harness, until } from "./fixtures/claude/helpers.ts";

function env(t: TestContext, key: string, value: string) {
  const old = process.env[key]; process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
const calls = (config: string): any[] => readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** A session's inbox: records each line it's sent and, unless told not to, queues a user message in the transcript. */
async function inbox(t: TestContext, path: string, onUser?: (line: any) => void) {
  const lines: any[] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (b) => {
      text += b.toString();
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n")) {
        const line = JSON.parse(text.slice(0, i)); text = text.slice(i + 1);
        lines.push(line);
        if (line.type === "user") onUser?.(line);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => server.close());
  return lines;
}

test("an answer is the option the user named (every one, for a multi-select), else their own words", () => {
  const q = [{ question: "Seconds or milliseconds?", options: ["Seconds", "Milliseconds"], multiSelect: false }];
  assert.deepEqual(answersFor(q, "Milliseconds"), { "Seconds or milliseconds?": "Milliseconds" });
  assert.deepEqual(answersFor(q, "milliseconds, please."), { "Seconds or milliseconds?": "Milliseconds" });
  assert.deepEqual(answersFor(q, "Neither: show both"), { "Seconds or milliseconds?": "Neither: show both" });
  assert.deepEqual(answersFor(q, "seconds, not milliseconds"), { "Seconds or milliseconds?": "seconds, not milliseconds" }, "two named: their words decide");
  const tabs = [{ question: "Indent?", options: ["Tabs", "Spaces"], multiSelect: false }];
  assert.deepEqual(answersFor(tabs, "establish spaces"), { "Indent?": "Spaces" }, "whole words only");
  const multi = [{ question: "Which checks?", options: ["Lint", "Tests", "Types"], multiSelect: true }];
  assert.deepEqual(answersFor(multi, "lint and tests"), { "Which checks?": "Lint, Tests" });
});

test("a message is Claude Code's peer envelope from 10 & 2, attesting the session's class only within the ceiling", () => {
  const words = "Add tests for the empty cart";
  assert.equal(envelope(words, "prompting"), `<cross-session-message from-name="10 & 2" from-mode="prompting">\n${words}\n\n(Your user said this to 10 & 2, their voice assistant, and confirmed it.)\n</cross-session-message>`);
  assert.ok(!envelope("x </cross-session-message> y", "prompting").slice(0, -26).includes("</cross-session-message>"), "a closing tag in the words can't end it early");
  assert.equal(attestedMode("auto", "full-access"), "prompting");
  assert.equal(attestedMode("bypassPermissions", "full-access"), "bypass");
  assert.equal(attestedMode("bypassPermissions", "auto"), "prompting", "never claims bypass beyond this machine's policy");
  assert.equal(heldFor("bypassPermissions", "prompting"), true);
  assert.equal(heldFor("auto", "prompting"), false);
  assert.equal(heldFor("bypassPermissions", "bypass"), false);
});

test("a follow-up to a session open in a terminal goes to its inbox, with its token, and counts once Claude Code queues it", async (t) => {
  const h = harness(t), f = h.completed(undefined, h.cwd, "auto"), sock = join(h.root, "inbox.sock");
  const lines = await inbox(t, sock, (line) => f.append({ type: "queue-operation", operation: "enqueue", content: line.message.content }));
  h.registry(f.id, "busy", { messagingSocketPath: sock });
  writeFileSync(join(h.config, "sessions", `${process.pid}.abc.key`), JSON.stringify({ peerToken: "peer-token-123", procStart: "1", pidDomain: "x" }));
  await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "Stop after the first command" };
  assert.equal(await h.adapter.check(action), null, "a live session with an inbox isn't refused");
  assert.equal(h.adapter.refusals()[f.id], undefined);
  assert.deepEqual(await h.adapter.execute(action, "steer"), { ok: true });
  assert.deepEqual(lines[0], { type: "auth", token: "peer-token-123" });
  assert.equal(lines[1].session_id, f.id);
  assert.match(lines[1].uuid, /^[0-9a-f-]{36}$/);
  assert.equal(lines[1].message.content, envelope(action.message, "prompting"));
  assert.deepEqual(await h.adapter.execute(action, "steer"), { ok: true }, "the same key never posts twice");
  assert.equal(lines.filter((l) => l.type === "user").length, 1);
});

test("a message that starts a turn counts by its own id in the transcript", async (t) => {
  const h = harness(t), f = h.completed(undefined, h.cwd, "auto"), sock = join(h.root, "inbox.sock");
  await inbox(t, sock, (line) => f.append({ type: "user", uuid: line.uuid, isMeta: true, origin: { kind: "peer" }, message: { content: line.message.content } }));
  h.registry(f.id, "idle", { messagingSocketPath: sock });
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Carry on" }, "turn"), { ok: true });
});

test("a session that bypasses prompts gets bypass attested under a full-access ceiling, and is told to wait otherwise", async (t) => {
  const full = harness(t, { policy: { maxRuntimeMode: "full-access" } }), a = full.completed(undefined, full.cwd, "bypassPermissions"), sockA = join(full.root, "a.sock");
  const sentA = await inbox(t, sockA, (line) => a.append({ type: "queue-operation", operation: "enqueue", content: line.message.content }));
  full.registry(a.id, "idle", { messagingSocketPath: sockA });
  await full.adapter.start();
  assert.deepEqual(await full.adapter.execute({ kind: "follow_up", itemId: a.id, message: "Go" }, "bypass"), { ok: true });
  assert.match(sentA[0].message.content, /from-mode="bypass"/);

  const capped = harness(t, { acceptanceTimeoutMs: 200 }), b = capped.completed(undefined, capped.cwd, "bypassPermissions"), sockB = join(capped.root, "b.sock");
  const sentB = await inbox(t, sockB); // Claude Code holds it for the user's approval: nothing is queued.
  capped.registry(b.id, "idle", { messagingSocketPath: sockB });
  await capped.adapter.start();
  const receipt = await capped.adapter.execute({ kind: "follow_up", itemId: b.id, message: "Go" }, "held");
  assert.equal(receipt.ok, false); if (!receipt.ok) { assert.equal(receipt.unknown, true); assert.match(receipt.error, /waiting for your OK/); }
  assert.match(sentB[0].message.content, /from-mode="prompting"/);
});

test("an inbox nobody answers, or one that takes nothing, is never retried", async (t) => {
  const h = harness(t, { acceptanceTimeoutMs: 200 }), f = h.completed(undefined, h.cwd, "auto");
  h.registry(f.id, "idle", { messagingSocketPath: join(h.root, "gone.sock") });
  await h.adapter.start();
  const gone = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Hello" }, "gone");
  assert.equal(gone.ok, false); if (!gone.ok) { assert.equal(gone.unknown, undefined); assert.match(gone.error, /couldn't reach/); }

  const g = harness(t, { acceptanceTimeoutMs: 200 }), s = g.completed(undefined, g.cwd, "auto"), sock = join(g.root, "quiet.sock");
  const sent = await inbox(t, sock);
  g.registry(s.id, "idle", { messagingSocketPath: sock });
  await g.adapter.start();
  const quiet = await g.adapter.execute({ kind: "follow_up", itemId: s.id, message: "Hello" }, "quiet");
  assert.equal(quiet.ok, false); if (!quiet.ok) assert.equal(quiet.unknown, true);
  assert.deepEqual(await g.adapter.execute({ kind: "follow_up", itemId: s.id, message: "Hello" }, "quiet"), quiet);
  assert.equal(sent.filter((l) => l.type === "user").length, 1);
});

test("a live session without an inbox (older Claude Code) is still refused, in words", async (t) => {
  const h = harness(t), f = h.completed(); h.registry(f.id, "idle"); await h.adapter.start();
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "x" }))!, /older Claude Code/);
});

/**
 * A session waiting on an AskUserQuestion it just called. As in Claude Code 2.1.321, the call isn't in the transcript
 * yet: Claude Code writes it, and its result, once it's answered. Only the hook's payload has the questions.
 */
function asking(h: ReturnType<typeof harness>) {
  const f = h.completed(undefined, h.cwd, "auto");
  const questions = [{ question: "Should lap times show seconds or milliseconds?", header: "Lap format", multiSelect: false,
    options: [{ label: "Seconds", description: "12.3 s" }, { label: "Milliseconds", description: "12345 ms" }] }];
  f.append({ type: "user", uuid: "prompt-2", promptId: "turn-2", permissionMode: "auto", message: { content: "Ask me about the format." } });
  h.registry(f.id, "waiting", { messagingSocketPath: join(h.root, "unused.sock") });
  return { f, questions };
}

test("Claude's question, held by the hook, is read out with its options and answered by voice", async (t) => {
  const h = harness(t), { f, questions } = asking(h); await h.adapter.start();
  assert.equal((await h.adapter.report(f.id)).question, "Claude needs your input in its terminal.", "before the hook, nothing says what");
  let printed = "";
  const hook = relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }), h.adapter.socketPath, (s) => { printed += s; });
  await until(async () => (h.adapter as any).asks.has(f.id));
  assert.equal((await h.adapter.report(f.id)).question, "Should lap times show seconds or milliseconds? Options: Seconds / Milliseconds.");
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Milliseconds, please." }, "answer"), { ok: true });
  await hook;
  assert.deepEqual(JSON.parse(printed), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow",
    updatedInput: { questions, answers: { "Should lap times show seconds or milliseconds?": "Milliseconds" } } } } });
});

test("a question answered in the terminal lets the hook go with nothing; one 10 & 2 doesn't list is never held", async (t) => {
  const h = harness(t), { f, questions } = asking(h); await h.adapter.start();
  let printed = "";
  const hook = relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }), h.adapter.socketPath, (s) => { printed += s; });
  await until(async () => (h.adapter as any).asks.has(f.id));
  const later = new Date(h.clock.now + 1000).toISOString();
  f.append({ type: "assistant", uuid: "ask-1", timestamp: later, message: { content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions } }], stop_reason: "tool_use" } });
  f.append({ type: "user", uuid: "answer-1", timestamp: later, message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: "Seconds" }] } });
  await (h.adapter as any).scan();
  await hook;
  assert.equal(printed, "");
  assert.equal((h.adapter as any).asks.has(f.id), false);

  let other = "";
  await relayHook(JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }), h.adapter.socketPath, (s) => { other += s; });
  assert.equal(other, "");
  let bash = "";
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /" } }), h.adapter.socketPath, (s) => { bash += s; });
  assert.equal(bash, "", "it never decides anything but Claude's own questions");
});

test("a plan goes ahead on a plain yes; other words go back to Claude as what to change", () => {
  for (const yes of ["Yes", "go ahead", "Sounds good.", "OK, do it", "approve"]) assert.equal(goAhead(yes), true, yes);
  for (const no of ["Yes, but use SQLite instead", "no", "Change step two first", "don't", "Make it smaller, then go"]) assert.equal(goAhead(no), false, no);
});

test("Claude's plan, held by the hook, is read out, then approved as it is or sent back with the user's words", async (t) => {
  const h = harness(t), f = h.completed(undefined, h.cwd, "plan");
  h.registry(f.id, "waiting", { messagingSocketPath: join(h.root, "unused.sock") });
  await h.adapter.start();
  const plan = "1. Add a laps module. 2. Show the fastest lap at the end. 3. Add tests.";
  const ask = (key: string, words: string) => {
    let printed = "";
    const hook = relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan } }), h.adapter.socketPath, (s) => { printed += s; });
    return { run: async () => {
      await until(async () => (h.adapter as any).asks.has(f.id));
      assert.equal((await h.adapter.report(f.id)).question, `Claude has a plan ready and asks whether to go ahead with it: ${plan}`);
      assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: words }, key), { ok: true });
      await hook; return JSON.parse(printed).hookSpecificOutput.decision;
    } };
  };
  assert.deepEqual(await ask("plan-yes", "Go ahead").run(), { behavior: "allow", updatedInput: { plan } });
  assert.deepEqual(await ask("plan-no", "Use SQLite instead of a JSON file").run(), { behavior: "deny", message: "Use SQLite instead of a JSON file" });
});

const build: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };
const normal: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };

test("new work starts as a background session, named, in a worktree or kept in the checkout, and returns its id", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1");
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }); h.completed(); await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  const started = await h.adapter.execute({ kind: "start_work", placeId: place, title: "Fastest lap", message: "--show the fastest lap", profile: build }, "bg-start");
  assert.equal(started.ok, true);
  const call = calls(h.config).find((c) => c.bg)!;
  assert.deepEqual(call.args.slice(0, 5), ["--bg", "--permission-mode", "bypassPermissions", "--name", "Fastest lap"]);
  assert.equal(call.args[call.args.indexOf("--worktree") + 1].startsWith("10and2-"), true);
  assert.deepEqual(call.args.slice(-2), ["--", "--show the fastest lap"], "the words can't be read as an option");
  if (started.ok) { assert.match(started.itemId!, /^[0-9a-f]{8}-/); await until(async () => (await h.adapter.list()).some((i) => i.id === started.itemId)); }

  await h.adapter.execute({ kind: "start_work", placeId: place, message: "Tidy the README", profile: normal }, "bg-root");
  const root = calls(h.config).filter((c) => c.bg)[1]!;
  assert.equal(root.args.includes("--worktree"), false);
  assert.deepEqual(JSON.parse(root.args[root.args.indexOf("--settings") + 1]), { worktree: { bgIsolation: "none" } });
  assert.equal(root.args.includes("--name"), false, "with no title Claude Code names it");
});

test("a follow-up to a session nothing has open continues it as a background session under its own id", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1");
  const h = harness(t), f = h.completed(undefined, h.cwd, "auto"); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Now add tests" }, "bg-resume"), { ok: true });
  const call = calls(h.config).find((c) => c.bg)!;
  assert.equal(call.args[call.args.indexOf("--resume") + 1], f.id);
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "auto");
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--settings") + 1]), { worktree: { bgIsolation: "none" } }, "a user's own session isn't moved into a worktree");
});

test("a background start Claude Code refuses before starting anything runs headless instead, once", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1"); env(t, "FAKE_CLAUDE_BG_REFUSE", "1");
  const h = harness(t), f = h.completed(undefined, h.cwd, "auto"); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Headless after all" }, "fallback"), { ok: true });
  const all = calls(h.config);
  assert.equal(all.filter((c) => c.bg).length, 1);
  assert.equal(all.filter((c) => !c.bg && c.args.includes("-p")).length, 1);
  assert.ok(h.logs.some((l) => /background start refused \(Workspace not trusted\)/.test(l)));
});

test("a background start with no evidence of the words is unknown and never repeated", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1"); env(t, "FAKE_CLAUDE_NEVER_ECHO", "1");
  const h = harness(t, { acceptanceTimeoutMs: 100 }), f = h.completed(undefined, h.cwd, "auto"); await h.adapter.start();
  const first = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Lost?" }, "bg-unknown");
  assert.equal(first.ok, false); if (!first.ok) assert.equal(first.unknown, true);
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Lost?" }, "bg-unknown"), first);
  assert.equal(calls(h.config).length, 1);
});

test("new work can start in any folder trusted in Claude Code, not only one with a recent session", async (t) => {
  const h = harness(t, { policy: { projects: "*" } });
  const old = join(h.root, "old-project"), untrusted = join(h.root, "untrusted"), gone = join(h.root, "gone");
  for (const dir of [old, untrusted]) mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(h.config, ".claude.json"), JSON.stringify({ projects: {
    [old]: { hasTrustDialogAccepted: true }, [untrusted]: { hasTrustDialogAccepted: false }, [gone]: { hasTrustDialogAccepted: true } } }));
  await h.adapter.start();
  assert.deepEqual(h.adapter.places().map((p) => p.name), ["old-project"]);

  const hidden = harness(t); // only its own project folder is visible
  writeFileSync(join(hidden.config, ".claude.json"), JSON.stringify({ projects: { [old]: { hasTrustDialogAccepted: true } } }));
  await hidden.adapter.start();
  assert.deepEqual(hidden.adapter.places(), [], "a trusted folder the policy hides isn't offered");
});

test("with steering off, a session open in a terminal is refused in words; with answering off, questions aren't held", async (t) => {
  const h = harness(t, { policy: { steer: false, answer: false } }), f = h.completed(undefined, h.cwd, "auto"), sock = join(h.root, "inbox.sock");
  const sent = await inbox(t, sock);
  h.registry(f.id, "waiting", { messagingSocketPath: sock });
  await h.adapter.start();
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "x" }))!, /doesn't let 10 & 2 send to open sessions/);
  const r = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "x" }, "no-steer");
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
  let printed = "";
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Q?", options: [{ label: "A" }] }] } }), h.adapter.socketPath, (s) => { printed += s; });
  assert.equal(printed, "", "the hook let go at once: the terminal answers");
});
