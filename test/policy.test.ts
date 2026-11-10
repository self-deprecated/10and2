import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allows, answers, ceilingFor, parsePolicy, steers, visible, withinCeiling } from "../src/policy.ts";

const base = { brain: "wss://brain.example/connector" };

test("an empty policy sees nothing, does nothing and launches nothing wider than approval-required", () => {
  const p = parsePolicy(JSON.stringify(base));
  assert.equal(visible(p, "/home/x/project"), false);
  assert.equal(allows(p, "settle"), false);
  assert.equal(withinCeiling(p, { runtimeMode: "approval-required" }), true);
  assert.equal(withinCeiling(p, { runtimeMode: "full-access" }), false);
  assert.equal(p.claude, false);
});

test("a folder makes itself and what's inside it visible, and nothing beside it", () => {
  const root = mkdtempSync(join(tmpdir(), "policy-"));
  mkdirSync(join(root, "work", "a"), { recursive: true });
  mkdirSync(join(root, "workshop"), { recursive: true });
  const p = parsePolicy(JSON.stringify({ ...base, projects: [join(root, "work")] }));
  assert.equal(visible(p, join(root, "work")), true);
  assert.equal(visible(p, join(root, "work", "a")), true);
  assert.equal(visible(p, join(root, "workshop")), false);
  assert.equal(visible(p, root), false);
  assert.equal(visible(p, null), false);
});

test("a symlink inside a visible folder that points outside it isn't visible", () => {
  const root = mkdtempSync(join(tmpdir(), "policy-"));
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "secret"));
  symlinkSync(join(root, "secret"), join(root, "work", "link"));
  const p = parsePolicy(JSON.stringify({ ...base, projects: [join(root, "work")] }));
  assert.equal(visible(p, join(root, "work", "link")), false);
});

test('"*" sees everything; actions and the ceiling are what it says', () => {
  const p = parsePolicy(JSON.stringify({ ...base, projects: "*", actions: ["settle", "follow_up"], maxRuntimeMode: "auto" }));
  assert.equal(visible(p, "/anywhere"), true);
  assert.equal(allows(p, "settle"), true);
  assert.equal(allows(p, "archive"), false);
  assert.equal(allows(p, "unsettle"), true, "undoing a settle wherever settling is allowed");
  assert.equal(allows(p, "unsnooze"), false, "and a snooze only where snoozing is");
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, actions: ["unsnooze"] })), /actions must be a list of/, "a policy names only the five");
  assert.equal(withinCeiling(p, { runtimeMode: "auto" }), true);
  assert.equal(withinCeiling(p, { runtimeMode: "full-access" }), false);
});

test("a bad policy is refused rather than read loosely", () => {
  assert.throws(() => parsePolicy("{"), /isn't JSON/);
  assert.throws(() => parsePolicy(JSON.stringify({ brain: "https://x" })), /brain/);
  assert.throws(() => parsePolicy(JSON.stringify({ brain: "ws://brain.example/connector" })), /wss/);
  assert.doesNotThrow(() => parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:8790/connector" })));
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, projects: ["relative/dir"] })), /absolute/);
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, actions: ["delete"] })), /actions/);
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, maxRuntimeMode: "yolo" })), /maxRuntimeMode/);
});

test("T3 is read unless turned off, and a machine must read something", () => {
  assert.equal(parsePolicy(JSON.stringify(base)).t3, true);
  const claudeOnly = parsePolicy(JSON.stringify({ ...base, t3: false, claude: true }));
  assert.equal(claudeOnly.t3, false);
  assert.equal(claudeOnly.claude, true);
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, t3: false })), /nothing to connect/);
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, t3: "yes" })), /t3 must be/);
});

test("new worktrees start from the checkout unless the policy names a branch, and only a branch name or HEAD", () => {
  assert.equal(parsePolicy(JSON.stringify(base)).worktreeBase, "HEAD");
  assert.equal(parsePolicy(JSON.stringify({ ...base, worktreeBase: "main" })).worktreeBase, "main");
  assert.equal(parsePolicy(JSON.stringify({ ...base, worktreeBase: "release/2.0" })).worktreeBase, "release/2.0");
  for (const bad of ["", "-f", "main..dev", "main@origin", "a b", "trunk()", "x/", 3]) {
    assert.throws(() => parsePolicy(JSON.stringify({ ...base, worktreeBase: bad })), /worktreeBase/, String(bad));
  }
});


test("a deleted directory under an excluded symlink target stays invisible", (t) => {
  const root = mkdtempSync(join(tmpdir(), "policy-deleted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "work")); mkdirSync(join(root, "secret", "deleted"), { recursive: true });
  symlinkSync(join(root, "secret"), join(root, "work", "link"));
  const p = parsePolicy(JSON.stringify({ ...base, projects: [join(root, "work")] }));
  rmSync(join(root, "secret", "deleted"), { recursive: true });
  assert.equal(visible(p, join(root, "work", "link", "deleted", "child")), false);
  symlinkSync("loop", join(root, "work", "loop"));
  symlinkSync(join(root, "absent"), join(root, "work", "dangling"));
  for (const name of ["loop", "dangling"]) {
    assert.equal(visible(p, join(root, "work", name, "child")), false);
    assert.equal(visible({ ...p, projects: "*" }, join(root, "work", name)), false);
  }
});

test("plaintext endpoints use parsed loopback hosts and never accept user-info", () => {
  for (const brain of ["ws://127.0.0.1", "ws://localhost", "ws://[::1]:8790/connector", "wss://remote.example"]) {
    assert.doesNotThrow(() => parsePolicy(JSON.stringify({ brain })));
  }
  for (const brain of ["ws://127.0.0.1:80@evil.example/", "ws://localhost@evil.example/", "ws://localhost.evil/", "ws://[::2]/", "wss://user:pass@remote.example/", "ws://localhost:bad/"]) {
    assert.throws(() => parsePolicy(JSON.stringify({ brain })), /brain/);
  }
});

test("agents: each on or off, or narrowed; the older top-level booleans still read the same", () => {
  const brain = "wss://b.example/connector";
  const p = parsePolicy(JSON.stringify({ brain, projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
    agents: { claude: true, codex: { steer: false, actions: ["follow_up", "settle"], maxRuntimeMode: "auto" }, pi: { answer: false }, opencode: false, t3: false } }));
  assert.deepEqual([p.t3, p.claude, p.codex, p.opencode, p.pi], [false, true, true, false, true]);
  assert.equal(steers(p, "claude"), true);
  assert.equal(steers(p, "codex"), false, "codex can't steer");
  assert.equal(answers(p, "pi"), false);
  assert.equal(answers(p, "codex"), true);
  assert.equal(allows(p, "start_work", "codex"), false, "its own list only narrows");
  assert.equal(allows(p, "start_work", "claude"), true);
  assert.equal(allows(p, "unsettle", "codex"), true, "undoing follows doing");
  assert.equal(ceilingFor(p, "codex"), "auto");
  assert.equal(ceilingFor(p, "claude"), "full-access");
  assert.equal(withinCeiling(p, { runtimeMode: "full-access" }, "codex"), false);

  const narrow = parsePolicy(JSON.stringify({ brain, actions: ["settle"], steer: false, agents: { claude: { actions: ["follow_up", "settle"] } } }));
  assert.equal(allows(narrow, "follow_up", "claude"), false, "an agent never gets more than the machine");
  assert.equal(steers(narrow, "claude"), false);

  const old = parsePolicy(JSON.stringify({ brain, claude: true, t3: false }));
  assert.deepEqual([old.t3, old.claude, old.codex, old.steer, old.answer], [false, true, false, true, true]);

  assert.throws(() => parsePolicy(JSON.stringify({ brain, agents: { cursor: true } })), /no agent called "cursor"/);
  assert.throws(() => parsePolicy(JSON.stringify({ brain, agents: { claude: { steer: "no" } } })), /agents.claude.steer must be true or false/);
  assert.throws(() => parsePolicy(JSON.stringify({ brain, agents: { t3: false, claude: false } })), /every coding agent is off/);
});
