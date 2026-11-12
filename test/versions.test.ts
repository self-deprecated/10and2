import { test } from "node:test";
import assert from "node:assert/strict";
import { MINIMUM, shortfall, versionWarning } from "../src/versions.ts";
import { AGENTS } from "../src/policy.ts";

test("the versions the harness measured on are new enough for everything", () => {
  const measured = { claude: "2.1.321", codex: "0.167.0", pi: "1.5.1", opencode: "1.19.5", t3: "0.1.8" } as const;
  for (const a of AGENTS) assert.equal(shortfall(a, measured[a]), null, a);
});

test("an agent just below a feature's floor is too old for that feature alone", () => {
  assert.deepEqual(shortfall("claude", "2.1.312"), { features: ["answer"], needs: "2.1.314" });
  assert.deepEqual(shortfall("claude", "2.1.300"), { features: ["answer", "start_worktree"], needs: "2.1.314" });
  assert.deepEqual(shortfall("codex", "0.156.0"), { features: ["follow_up", "steer", "answer", "continue"], needs: "0.157.0" });
  assert.equal(shortfall("codex", "0.157.0"), null);
});

test("the warning says what won't work and how to update", () => {
  assert.equal(versionWarning("codex", "Codex", "0.156.0"),
    "Codex 0.156.0 is too old for 10 & 2 to follow up, steer, answer its questions or continue its closed sessions. Update to 0.157.0 or newer: codex update");
  assert.equal(versionWarning("claude", "Claude Code", "2.1.312"), "Claude Code 2.1.312 is too old for 10 & 2 to answer its questions. Update to 2.1.314 or newer: claude update");
  // Too old to see its sessions is too old to use.
  assert.equal(versionWarning("codex", "Codex", "0.150.0"), "Codex 0.150.0 is too old for 10 & 2 to use. Update to 0.157.0 or newer: codex update");
  assert.equal(versionWarning("t3", "T3 Code", "0.0.45"), "T3 Code 0.0.45 is too old for 10 & 2 to use. Update to 0.1.0 or newer: t3 update");
  assert.equal(versionWarning("pi", "Pi", "0.80.3"), "Pi 0.80.3 is too old for 10 & 2 to use. Update to 0.80.5 or newer: pi update self");
});

test("a version with a suffix counts as its release; an unknown one warns of nothing", () => {
  assert.equal(shortfall("t3", "0.1.6-dev.2d3bbb1aba"), null);
  assert.deepEqual(shortfall("t3", "0.0.45-nightly.1")?.needs, "0.1.0");
  for (const v of [null, "", "dev", "1.2"]) assert.equal(versionWarning("codex", "Codex", v), null);
});

test("every agent's floors are well-formed releases", () => {
  for (const a of AGENTS) for (const v of Object.values(MINIMUM[a])) assert.match(v!, /^\d+\.\d+\.\d+$/, a);
});
