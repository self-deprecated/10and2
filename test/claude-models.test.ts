// Choosing the model a new Claude Code session starts on (docs/launch/thread-model.md): the list read from a `claude -p`
// asked only to initialize, and `--model` on both ways a start runs. Against the synthetic Claude (fixtures/claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { claudeModels, listClaudeModels } from "../src/claude/adapter.ts";
import type { LaunchProfile } from "../src/contract.ts";
import { harness, until } from "./fixtures/claude/helpers.ts";

function env(t: TestContext, key: string, value: string) {
  const old = process.env[key]; process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
const lines = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const normal: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };
const OFFERED = [
  { id: "opus", name: "Claude Opus 5.5" }, { id: "claude-fable-5-2[1m]", name: "Claude Fable 5.2" },
  { id: "sonnet", name: "Claude Sonnet 5.5" }, { id: "haiku", name: "Claude Haiku 4.5" },
];

test("Claude Code's models are named as they're said, once each, without its own default", () => {
  assert.deepEqual(claudeModels([
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
    { value: "opus[1m]", resolvedModel: "claude-opus-5-5", displayName: "Opus (1M context)" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
    { value: "claude-fable-5-2[1m]", resolvedModel: "claude-fable-5-2", displayName: "Fable" },
    { value: "claude-sonnet-4-20250514", resolvedModel: "claude-sonnet-4-20250514", displayName: "Sonnet 4" },
    { value: "my-gateway-model", displayName: "My Gateway Model" }, { value: "my-gateway-model-2", displayName: "My gateway-model" },
    { value: " padded", displayName: "Padded" }, { value: "x".repeat(201), displayName: "Long" }, { displayName: "No value" }, "opus",
  ]), [
    { id: "opus", name: "Claude Opus 5.5" }, { id: "claude-fable-5-2[1m]", name: "Claude Fable 5.2" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" }, { id: "my-gateway-model", name: "My Gateway Model" },
  ]);
  assert.deepEqual(claudeModels(null), []);
});

test("every Claude Code place offers the models it lists, read without starting a session; nothing else of its answer is kept", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  assert.deepEqual(h.adapter.places()[0]!.models, OFFERED);
  const probes = lines(join(h.config, "probes.jsonl"));
  assert.equal(probes.length, 1);
  // Without the user's hooks and MCP servers: a session they never started runs none of theirs.
  assert.deepEqual(probes[0].args, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true })]);
  assert.ok(!JSON.stringify(h.adapter.places()).includes("example.com") && !h.logs.join("\n").includes("example.com"), "the account isn't kept");
  assert.deepEqual(lines(join(h.config, "calls.jsonl")), [], "no session was started");
  await until(() => { try { process.kill(probes[0].pid, 0); return false; } catch { return true; } }, 3000);
});

test("a Claude Code that doesn't list its models offers none, and a start on one is refused", async (t) => {
  env(t, "FAKE_CLAUDE_NO_MODELS", "1");
  const h = harness(t); h.completed(); await h.adapter.start();
  assert.deepEqual(h.adapter.places()[0]!.models, []);
  assert.ok(h.logs.some((l) => /couldn't read Claude Code's models/.test(l)));
  const start = { kind: "start_work" as const, placeId: h.adapter.places()[0]!.id, message: "Go", profile: normal, model: "opus" };
  assert.equal(await h.adapter.check(start), "Claude Code doesn't offer that model now.");
  assert.deepEqual(await h.adapter.execute(start, "no-list"), { ok: false, error: "Claude Code doesn't offer that model now." });
  assert.deepEqual(lines(join(h.config, "calls.jsonl")), [], "nothing was started");
});

test("a start on a chosen model passes it to a background session, before the words; none chosen, none passed", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1");
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }); h.completed(); await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: place, title: "Fastest lap", message: "Show the fastest lap", profile: normal, model: "claude-fable-5-2[1m]" }, "bg-model")).ok, true);
  const call = lines(join(h.config, "calls.jsonl")).find((c) => c.bg)!;
  assert.deepEqual(call.args.slice(0, 5), ["--bg", "--permission-mode", "auto", "--name", "Fastest lap"]);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-fable-5-2[1m]");
  assert.deepEqual(call.args.slice(-2), ["--", "Show the fastest lap"]);
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: place, message: "Tidy up", profile: normal }, "bg-default")).ok, true);
  assert.equal(lines(join(h.config, "calls.jsonl")).filter((c) => c.bg)[1].args.includes("--model"), false);
});

test("a headless start, and a background start Claude Code refuses, keep the chosen model", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: place, message: "Go", profile: normal, model: "sonnet" }, "headless")).ok, true);
  const args: string[] = lines(join(h.config, "calls.jsonl"))[0].args;
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  // Refused before anything is started: a model it doesn't list, or one only a T3 project offers.
  for (const model of ["opus[1m]", "claudeAgent:claude-opus-5-5"]) {
    assert.deepEqual(await h.adapter.execute({ kind: "start_work", placeId: place, message: "Go", profile: normal, model }, `no-${model}`), { ok: false, error: "Claude Code doesn't offer that model now." });
  }
  assert.equal(lines(join(h.config, "calls.jsonl")).length, 1);
});

test("a background start refused before starting anything runs headless on the same model", async (t) => {
  env(t, "FAKE_CLAUDE_BG", "1"); env(t, "FAKE_CLAUDE_BG_REFUSE", "1");
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }); h.completed(); await h.adapter.start();
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: h.adapter.places()[0]!.id, message: "Go", profile: normal, model: "haiku" }, "fallback")).ok, true);
  const [bg, headless] = lines(join(h.config, "calls.jsonl"));
  assert.equal(bg.args[bg.args.indexOf("--model") + 1], "haiku");
  assert.equal(headless.args[0], "-p");
  assert.equal(headless.args[headless.args.indexOf("--model") + 1], "haiku");
});

test("a Claude Code that isn't there lists nothing, and leaves nothing on the adapter's signal however often it's asked", async () => {
  const signal = new AbortController();
  for (let n = 0; n < 5; n++) assert.equal(await listClaudeModels(["/nonexistent/claude"], process.env, tmpdir(), signal.signal), null);
  assert.equal(getEventListeners(signal.signal, "abort").length, 0);
  signal.abort();
  assert.equal(await listClaudeModels(["/nonexistent/claude"], process.env, tmpdir(), signal.signal), null, "closed: not even tried");
});
