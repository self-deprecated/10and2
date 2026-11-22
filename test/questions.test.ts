// The engine's stage 2, before any tap reaches the connector (docs/launch/engine.md): a question's own options
// (`Report.choices`), what it waits on (`questionKind`), and an answer to one question only (`questionId`), refused once
// the thread has moved on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf, tools } from "../src/protocol.ts";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { Sent } from "../src/view.ts";
import { ANSWERED, choicesOf } from "../src/util.ts";
import { answersFor as claudeAnswers } from "../src/claude/adapter.ts";
import { answersFor as codexAnswers } from "../src/codex/adapter.ts";
import { answersFor as openCodeAnswers } from "../src/opencode/adapter.ts";
import { answersFor as t3Answers } from "../src/t3/adapter.ts";
import { FakeAdapter, item } from "./fakes.ts";

const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:8790/connector", projects: "*", actions: ["follow_up", "settle"] }));

test("a follow-up may carry the questionId it answers; the tool lists it, not required, and refuses a bad one", () => {
  const tap = { kind: "follow_up" as const, itemId: "a", message: "Rebase", questionId: "r-1" };
  assert.deepEqual(actionOf(tap), tap);
  assert.deepEqual(actionOf({ kind: "follow_up", itemId: "a", message: "Rebase" }), { kind: "follow_up", itemId: "a", message: "Rebase" }, "none given, none added");
  for (const questionId of ["", "x".repeat(201), 7, null]) assert.throws(() => actionOf({ ...tap, questionId }), /isn't supported/, String(questionId));
  assert.throws(() => actionOf({ ...tap, requestId: "x" }), /Unknown action fields/);
  const schema = tools(["follow_up"]).find((t) => t.name === "follow_up")!.inputSchema as any;
  assert.deepEqual([Object.keys(schema.properties), schema.required], [["itemId", "message", "questionId"], ["itemId", "message"]]);
});

test("choices are the one question's own options, word for word, when it lists two or more", () => {
  assert.deepEqual(choicesOf([{ options: ["Rebase onto main", "Merge"] }]), ["Rebase onto main", "Merge"]);
  assert.deepEqual(choicesOf([{ options: ["A", "B", "C", "D"] }]), ["A", "B", "C", "D"], "how many a notification shows is the brain's to decide");
  assert.equal(choicesOf([{ options: ["Only one"] }]), null);
  assert.equal(choicesOf([{ options: [] }]), null, "an open question");
  assert.equal(choicesOf([{ options: ["A", "B"] }, { options: ["C", "D"] }]), null, "two questions at once: one tap can't answer both");
  assert.equal(choicesOf([]), null);
});

test("a tapped option is matched by its own label before any looser match", () => {
  // "C#" and "C++" read the same once punctuation is dropped; "Deploy (later)" and "Deploy" once the parenthetical is.
  const claude = [{ question: "Which?", options: ["C++", "C#"], multiSelect: false }];
  assert.deepEqual(claudeAnswers(claude, "C#"), { "Which?": "C#" });
  assert.deepEqual(claudeAnswers(claude, "C++"), { "Which?": "C++" });
  assert.deepEqual(openCodeAnswers([{ question: "Which?", options: ["C++", "C#"], multiple: false }], "C#"), [["C#"]]);
  const deploy = [{ id: "q", question: "When?", options: [{ label: "Deploy" }, { label: "Deploy (later)" }] }];
  assert.deepEqual(codexAnswers(deploy, "Deploy (later)"), { answers: { q: { answers: ["Deploy (later)"] } } });
  assert.deepEqual(codexAnswers(deploy, "Deploy"), { answers: { q: { answers: ["Deploy"] } } });
  assert.deepEqual(t3Answers([{ id: "q", options: [{ label: "Deploy", value: "now" }, { label: "Deploy (later)", value: "later" }] }], "Deploy (later)"), { q: "later" });
  // Words that only name an option still pick it, as before.
  assert.deepEqual(claudeAnswers([{ question: "Unit?", options: ["Seconds", "Milliseconds"], multiSelect: false }], "Milliseconds, please."), { "Unit?": "Milliseconds" });
});

test("an answer to one question is refused, and nothing sent, once the thread asks another or nothing", async () => {
  const fake = new FakeAdapter([item("a", { status: "waiting", pendingQuestion: true, questionId: "q2", questionKind: "input" })]);
  const local = new Local([{ prefix: "claude", adapter: fake }], policy);
  const tap = (questionId: string) => ({ kind: "follow_up" as const, itemId: "claude:a", message: "Rebase", questionId });
  assert.equal(await local.check(tap("q1")), ANSWERED, "asked again since");
  assert.deepEqual(await local.execute(tap("q1"), "T-1:claude:a"), { ok: false, error: ANSWERED });
  assert.equal(await local.refusal(tap("q1"), Date.now() + 5000), ANSWERED, "looked at again last thing before dispatch");
  assert.equal(fake.executed.length, 0);
  assert.equal(await local.check(tap("q2")), null);
  assert.deepEqual(await local.execute(tap("q2"), "T-2:claude:a"), { ok: true });
  assert.deepEqual(fake.executed.map((e) => e.action), [{ kind: "follow_up", itemId: "a", message: "Rebase", questionId: "q2" }]);
  // Answered at the computer: it asks nothing now.
  Object.assign(fake.items[0]!, { status: "running", pendingQuestion: false, questionId: null });
  assert.deepEqual(await local.execute(tap("q2"), "T-3:claude:a"), { ok: false, error: ANSWERED });
  assert.equal(fake.executed.length, 1);
  // A follow-up without one is sent as before, whatever the thread asks.
  assert.deepEqual(await local.execute({ kind: "follow_up", itemId: "claude:a", message: "Carry on" }, "T-4:claude:a"), { ok: true });
  // A work system that hasn't loaded is never listed for it; its own check refuses.
  const late = Object.assign(new FakeAdapter([]), { isLoaded: false, check: async () => "Not loaded yet." });
  late.list = async () => { throw new Error("must not list an unloaded backend"); };
  assert.equal(await new Local([{ prefix: "", adapter: late }], policy).check({ kind: "follow_up", itemId: "a", message: "Rebase", questionId: "q" }), "Not loaded yet.");
});

test("what a question waits on reaches the brain: a change of questionKind alone is news", () => {
  const sent = new Sent();
  const view = (over = {}) => ({ items: [item("a", { status: "waiting", pendingQuestion: true, questionId: "q", ...over })], places: [], connections: [], refusals: {}, ceiling: "full-access" as const });
  sent.read(view(), null);
  assert.equal(sent.changed(view()).any, false);
  assert.deepEqual(sent.changed(view({ questionKind: "input" })), { any: true, urgent: false });
});
