// Tests passed or failed (docs/launch/engine.md §11 stage 3.10; spike/run-receipts): which commands are checks, which
// exits tell their result, and what of them may leave the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOf, checksIn, receipts, stepsOf, Tested, verdictOf } from "../src/checks.ts";
import { reportOut } from "../src/protocol.ts";
import { redactOutbound } from "../src/redact.ts";
import { green } from "../brain/src/receipts.ts";
import { parsePolicy } from "../src/policy.ts";
import { removeDir, WINDOWS } from "./fixtures/platform.ts";

test("receipts: real runner commands are checks of the right kind, labelled from the table", () => {
  const table: [string, string, string][] = [
    ["npm test", "test", "npm test"],
    ["npm t", "test", "npm test"],
    ["npm run test:unit -- --reporter=dot", "test", "npm test"],
    ["pnpm test", "test", "pnpm test"],
    ["pnpm --filter @app/api test", "test", "pnpm test"],
    ["pnpm -r run build", "build", "pnpm build"],
    ["yarn lint", "lint", "yarn lint"],
    ["bun test", "test", "bun test"],
    ["bun run typecheck", "build", "bun typecheck"],
    ["npm run check", "test", "npm check"],
    ["npx vitest run src/billing.test.ts", "test", "vitest"],
    ["npx jest --ci", "test", "jest"],
    ["node --test test/*.test.ts", "test", "node --test"],
    ["node --experimental-strip-types --test", "test", "node --test"],
    ["pytest -x tests/test_api.py", "test", "pytest"],
    ["python -m pytest -q", "test", "pytest"],
    ["uv run pytest", "test", "pytest"],
    ["cargo test -p core", "test", "cargo test"],
    ["cargo build --release", "build", "cargo build"],
    ["cargo clippy -- -D warnings", "lint", "cargo clippy"],
    ["go test ./...", "test", "go test"],
    ["go build ./cmd/api", "build", "go build"],
    ["swift test", "test", "swift test"],
    ["xcodebuild -scheme Driver -destination 'platform=iOS Simulator,name=iPhone 17' test", "test", "xcodebuild"],
    ["xcodebuild -scheme Driver build", "build", "xcodebuild"],
    ["make test", "test", "make test"],
    ["make check", "test", "make check"],
    ["just test", "test", "just test"],
    ["./gradlew test", "test", "gradlew test"],
    ["npx tsc --noEmit", "build", "tsc"],
    ["tsc -p tsconfig.json", "build", "tsc"],
    ["eslint src", "lint", "eslint"],
    ["ruff check .", "lint", "ruff"],
    ["CI=1 FORCE_COLOR=0 pnpm test", "test", "pnpm test"],
    ["timeout 600 npm test", "test", "npm test"],
    ["(npm test)", "test", "npm test"],
  ];
  for (const [command, kind, label] of table) assert.deepEqual(checkOf(command), { kind, label }, command);
});

test("receipts: everything else isn't a check", () => {
  for (const command of ["git status", "ls -la", "cat package.json", "npm install", "npm ci", "pnpm add vitest", "grep -rn test src", "echo npm test",
    "rg 'npm test' docs", "node scripts/build-docs.mjs", "cargo run", "go run .", "./ci.sh", "ruff format .", "npm run dev", "git commit -m 'make test pass'",
    "sed -i 's/test/spec/' x.ts", "jj log", "npx prettier --write ."]) {
    assert.equal(checkOf(command), null, command);
  }
});

test("receipts: only an exit that is the check's tells its result; piped on, only its runner's summary can", () => {
  const one = (kind: string, label: string, exit = true, cleanPasses = exit, told = true) => ({ found: [{ kind, label, told, ...(told ? { whole: true } : {}) }], exit, cleanPasses });
  // The exit is the check's, and the line a whole run's (One rule for a pass): `cd <folder> &&`, then a run from FULL.
  // After `cd api &&`, a failing exit may be the cd's (`gated`): the check's only as its output tells (F4), for a script
  // npm or pnpm runs, only with its banner (`banner`, the skeptic on 7717d10f3219).
  assert.deepEqual(checksIn("cd api && pnpm test"), { found: [{ kind: "test", label: "pnpm test", told: true, whole: true, scope: "pnpm test\tapi\t" }], exit: true, cleanPasses: true, gated: true, banner: "test" });
  assert.deepEqual(checksIn("bash -lc 'cd api && npm test'"), { found: [{ kind: "test", label: "npm test", told: true, whole: true, scope: "npm test\tapi\t" }], exit: true, cleanPasses: true, gated: true, banner: "test" }, "Codex's shell wrapper");
  assert.deepEqual(checksIn("/bin/zsh -lc \"go test ./...\""), one("test", "go test"));
  assert.deepEqual(checksIn("npm test \\\n  -- --verbose"), one("test", "npm test"));
  // A run that isn't on the list, in a whole run's line: its exit 0 is its own (`plain`), never a pass.
  assert.deepEqual(checksIn("npm test --silent"), { found: [{ kind: "test", label: "npm test", told: false, plain: true, scope: "npm test\t\t--silent" }], exit: true, cleanPasses: true });
  // Its exit, but after `;`: a failure is its own, a pass can't be told (the skeptics of 3.9 and 3.10, 20 November).
  assert.deepEqual(checksIn("cd api; npm test 2>&1"), { found: [{ kind: "test", label: "npm test", told: false, scope: "npm test\tapi\t" }], exit: true, cleanPasses: true });
  // Not the check's: piped on, swallowed, or followed by something else.
  for (const line of ["npm test | tail -30", "npm test 2>&1 | tail -30", "npm test || true", "npm test || echo failed", "npm test; echo done", "npm test\necho done"]) {
    assert.deepEqual(checksIn(line), one("test", "npm test", false, false, false), line);
  }
  assert.deepEqual(checksIn("npm test |& tee log"), one("test", "npm test", false, false, false), "into tee: tee's exit, never the runner's");
  assert.deepEqual(checksIn("set -o pipefail && npm test |& tee log"), { ...one("test", "npm test", true, false), gated: true, banner: "test" }, "into tee with pipefail: the runner's own exit");
  // Followed by `&&` and something else (the skeptic, 16 November): a clean exit is still the tests' exit 0, but the line
  // isn't a whole run's, so it's never a pass; a failure may be the other command's (the commit), so then only the
  // runner's summary can tell a failure.
  const chained = checksIn("npm test && git commit -am wip")!;
  assert.deepEqual(chained, one("test", "npm test", false, true, false));
  assert.deepEqual(checksIn("npm test && echo ok"), one("test", "npm test", false, true, false));
  assert.deepEqual(stepsOf(chained, true), [{ kind: "test", label: "npm test", ok: null }], "was a pass: not a whole run's line");
  assert.deepEqual(stepsOf(chained, false, "ℹ tests 12\nℹ pass 12\nℹ fail 0\nnothing to commit"), [{ kind: "test", label: "npm test", ok: null }], "the commit failed, or the tests did: unknown, never a pass");
  assert.deepEqual(stepsOf(chained, false, "ℹ fail 1"), [{ kind: "test", label: "npm test", ok: false }]);
  assert.deepEqual(stepsOf(chained, false, "error: nothing to commit"), [{ kind: "test", label: "npm test", ok: null }], "no summary: unknown, never a failed test run");
  assert.deepEqual(checksIn("npm run build && npm test && git push")!.cleanPasses, true);
  // `$'…'` quotes as this doesn't read (`\'` is a quote there): the line is unknown, its exit no one's.
  const ansi = checksIn("npm run build -- $'\\'' || true #'")!;
  assert.deepEqual([ansi.exit, ansi.cleanPasses, ansi.found[0].told], [false, false, false]);
  // In the background: not finished when the line is.
  assert.equal(checksIn("npm test &"), null);
  assert.equal(checksIn("git status | head"), null, "no check");
  // A build and a test run: a clean exit passes the build (one of its kind, joined by `&&`); the test run isn't a whole
  // run's line, so it's unknown; a failure tells neither.
  const two = checksIn("npm run build && npm test")!;
  assert.deepEqual(two, { found: [{ kind: "build", label: "npm build", told: true, whole: true }, { kind: "test", label: "npm test", told: false }], exit: false, cleanPasses: true });
  assert.deepEqual(stepsOf(two, true).map((s) => typeof s === "object" && [s.kind, s.ok]), [["build", true], ["test", null]]);
  assert.deepEqual(stepsOf(two, false), [{ kind: "build", label: "npm build", ok: null }, { kind: "test", label: "npm test", ok: null }]);
  assert.deepEqual(stepsOf(checksIn("npm test"), null), [], "no exit code known: nothing");
  // Piped on: the exit is tail's, and tail keeps only the end, so its runner's summary can show a failure, never a pass.
  const piped = checksIn("npm test 2>&1 | tail -20");
  assert.deepEqual(stepsOf(piped, true, "...\nℹ tests 12\nℹ pass 11\nℹ fail 1\n"), [{ kind: "test", label: "npm test", ok: false }], "tail exited 0; the tests didn't pass");
  assert.deepEqual(stepsOf(piped, true, "ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), [{ kind: "test", label: "npm test", ok: null }], "a passing summary through tail: unknown");
  assert.deepEqual(stepsOf(piped, true, "some output, cut before the summary"), [{ kind: "test", label: "npm test", ok: null }], "no summary: unknown");
  assert.deepEqual(stepsOf(piped, null, "ℹ fail 0"), [], "a refused or unfinished command: nothing");
  // Into tee: its passing summary isn't its exit (a coverage threshold, an unhandled error or a lint after it can fail the
  // run; the skeptic on 5828b30370cf), so never a pass; its failing summary is a failure.
  const teed = checksIn("npm test 2>&1 | tee test.log");
  assert.deepEqual(stepsOf(teed, true, "ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), [{ kind: "test", label: "npm test", ok: null }], "was a pass");
  assert.deepEqual(stepsOf(teed, true, "ℹ tests 12\nℹ pass 11\nℹ fail 1\n"), [{ kind: "test", label: "npm test", ok: false }]);
  assert.deepEqual(stepsOf(teed, false, "ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), [{ kind: "test", label: "npm test", ok: null }]);
  // With the runner's own exit kept (pipefail), its exit tells, as a plain run's does.
  const kept = checksIn("set -o pipefail && npm test 2>&1 | tee test.log");
  assert.deepEqual(stepsOf(kept, true, "all good"), [{ kind: "test", label: "npm test", ok: true, whole: true }]);
  assert.deepEqual(stepsOf(kept, false, "ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), [{ kind: "test", label: "npm test", ok: false, whole: true }]);
  // Its own exit 0 with its output saying a test failed (a script ending `|| true`): a failure.
  assert.deepEqual(stepsOf(checksIn("npm test"), true, "ℹ tests 12\nℹ pass 11\nℹ fail 1\n"), [{ kind: "test", label: "npm test", ok: false, whole: true }]);
  // A run not on the list, exiting 0 in a whole run's line: unknown, marked `again` (it settles only its own failure).
  assert.deepEqual(stepsOf(checksIn("npm test -- src/a.test.ts"), true, ""), [{ kind: "test", label: "npm test", ok: null, scope: "npm test\t\t-- src/a.test.ts", again: true }]);
});

test("receipts: runners' own summary lines, as they print them", () => {
  const cases: [string, "test" | "build" | "lint", boolean | null][] = [
    ["ℹ tests 1047\nℹ suites 0\nℹ pass 1047\nℹ fail 0\nℹ cancelled 0", "test", true],
    ["ℹ pass 1000\nℹ fail 2", "test", false],
    ["# tests 3\n# pass 3\n# fail 0", "test", true],
    ["\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m | 4 passed (5)\n\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m | 40 passed (42)", "test", false],
    ["      Tests  42 passed (42)\n   Duration  1.2s", "test", true],
    ["Tests:       1 failed, 41 passed, 42 total\nSnapshots:   0 total", "test", false],
    ["Tests:       42 passed, 42 total", "test", true],
    // A test file that didn't compile fails the run while every test that ran passed (the skeptic, 16 November).
    ["Test Suites: 1 failed, 2 passed, 3 total\nTests:       42 passed, 42 total\nSnapshots:   0 total", "test", false],
    ["Test Suites: 3 passed, 3 total\nTests:       42 passed, 42 total", "test", true],
    [" Test Files  1 failed | 2 passed (3)\n      Tests  40 passed (40)", "test", false],
    [" Test Files  1 failed (1)\n      Tests  no tests", "test", false],
    ["======================== 1 failed, 41 passed in 2.31s ========================", "test", false],
    ["42 passed in 0.87s", "test", true],
    ["=== 3 passed, 1 error in 1.1s ===", "test", false],
    ["test result: ok. 42 passed; 0 failed; 0 ignored", "test", true],
    ["test result: FAILED. 41 passed; 1 failed", "test", false],
    ["ok  \tgithub.com/x/api\t0.123s\nok  \tgithub.com/x/db\t(cached)", "test", true],
    ["--- FAIL: TestBilling (0.00s)\nFAIL\nFAIL\tgithub.com/x/api\t0.2s", "test", false],
    ["✔ Test run with 555 tests in 40 suites passed after 3.2 seconds.", "test", true],
    ["Test Suite 'All tests' failed at 2026-11-16", "test", false],
    ["** TEST FAILED **", "test", false],
    [" 41 pass\n 1 fail\nRan 42 tests across 3 files.", "test", false],
    ["  42 passing (1s)", "test", true],
    ["  41 passing (1s)\n  1 failing", "test", false],
    ["BUILD SUCCESSFUL in 12s", "test", true],
    ["src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.", "build", false],
    ["** BUILD SUCCEEDED **", "build", true],
    ["error: could not compile `api` (lib) due to 2 previous errors", "build", false],
    ["✖ 3 problems (3 errors, 0 warnings)", "lint", false],
    ["All checks passed!", "lint", true],
    ["Done in 2.1s.", "test", null],
    ["", "test", null],
    ["ok 1 - adds\nok 2 - subtracts", "test", null],
    // The last summary is the runner's own, after whatever its tests print (measured on this machine's Codex runs).
    ["✔ parses xcodebuild's output\n** TEST FAILED **\n✔ another\nℹ tests 40\nℹ pass 40\nℹ fail 0\nℹ cancelled 0", "test", true],
    ["ℹ tests 40\nℹ pass 39\nℹ fail 0\nℹ cancelled 1\nℹ skipped 0", "test", false],
    ["--- FAIL: TestBilling (0.01s)\nFAIL\tgithub.com/x/api\t0.2s\nok  \tgithub.com/x/db\t0.1s\nFAIL", "test", false],
  ];
  for (const [out, kind, want] of cases) assert.equal(verdictOf(out, kind), want, JSON.stringify(out));
});

// The skeptic of 3.9 and 3.10: runners that print a result per package, test binary, environment or workspace and carry
// on after a failure can end on a passing line. Each output below is the runner's own, printed on this machine (go
// 1.27.3, cargo 1.99.0, pytest 9.1.1 with xdist 3.8.0, tox 4.34.1, jest 29.7.0 with projects, npm 11.19.1, pnpm 12.9.0,
// yarn 1), with only machine paths shortened.
const GO_FAIL = "--- FAIL: TestParse (0.00s)\n    parse_test.go:5: bad parse\nFAIL\nFAIL\texample.com/app/parse\t0.001s\nok  \texample.com/app/server\t0.001s\nok  \texample.com/app/store\t(cached)\nFAIL\n";
const GO_PASS = "ok  \texample.com/app/server\t(cached)\nok  \texample.com/app/store\t(cached)\n";
const CARGO_RAN = (crate: string, result: string) => `     Running unittests src/lib.rs (target/debug/deps/${crate}-29004ce578a007ec)\n\nrunning 1 test\ntest tests::fine ... ok\n\ntest result: ${result}. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n`;
const CARGO_FAILED = "     Running unittests src/lib.rs (target/debug/deps/alpha-efc52a6d3cb8a8f2)\n\nrunning 2 tests\ntest tests::adds ... FAILED\ntest tests::ok ... ok\n\nfailures:\n\n---- tests::adds stdout ----\n\nthread 'tests::adds' (417858) panicked at alpha/src/lib.rs:4:17:\nassertion `left == right` failed\n  left: 4\n right: 5\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    tests::adds\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nerror: test failed, to rerun pass `-p alpha --lib`\n";
const CARGO_NO_FAIL_FAST = "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.00s\n" + CARGO_FAILED + CARGO_RAN("beta", "ok") + CARGO_RAN("gamma", "ok") +
  "   Doc-tests gamma\n\nrunning 1 test\ntest gamma/src/lib.rs - g (line 1) ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s\n\nerror: 1 target failed:\n    `-p alpha --lib`\n";
const CARGO_PASS = "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.00s\n" + CARGO_RAN("beta", "ok") + CARGO_RAN("gamma", "ok");
const XDIST = (result: string, failures = "") => `============================= test session starts ==============================\nplatform linux -- Python 3.14.10, pytest-9.1.1, pluggy-1.7.0\nrootdir: /tmp/py\nplugins: xdist-3.8.0\ncreated: 2/2 workers\n2 workers [4 items]\n\n..F.                                                                     [100%]\n${failures}${result}\n`;
const XDIST_FAILURES = "=================================== FAILURES ===================================\n___________________________________ test_one ___________________________________\n[gw0] linux -- Python 3.14.10 /usr/bin/python\n\n    def test_one():\n>       assert 1 == 2\nE       assert 1 == 2\n\ntests/test_a.py:2: AssertionError\n=========================== short test summary info ============================\nFAILED tests/test_a.py::test_one - assert 1 == 2\n";
const TOX = "a: commands[0]> python -m pytest tests/test_a.py\n" + XDIST("========================= 1 failed, 1 passed in 0.01s ==========================", XDIST_FAILURES) +
  "a: exit 1 (0.15 seconds) /tmp/py> python -m pytest tests/test_a.py pid=421639\na: FAIL ✖ in 0.2 seconds\nb: commands[0]> python -m pytest tests/test_b.py\n============================= test session starts ==============================\ncollected 2 items\n\ntests/test_b.py ..                                                       [100%]\n\n============================== 2 passed in 0.01s ===============================\n" +
  "  a: FAIL code 1 (0.20=setup[0.06]+cmd[0.15] seconds)\n  b: OK (0.16=setup[0.02]+cmd[0.14] seconds)\n  evaluation failed :( (0.39 seconds)\n";
const TOX_PASS = "\n============================== 2 passed in 0.01s ===============================\n  b: OK (0.17=setup[0.03]+cmd[0.14] seconds)\n  congratulations :) (0.18 seconds)\n";
const JEST_PROJECTS = "PASS p2 p2/b.test.js\nFAIL p1 p1/a.test.js\n  ● adds\n\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: 3\n    Received: 2\n\n      at Object.<anonymous> (a.test.js:1:42)\n\nTest Suites: 1 failed, 1 passed, 2 total\nTests:       1 failed, 2 passed, 3 total\nSnapshots:   0 total\nTime:        0.269 s\nRan all test suites in 2 projects.\n";
const JEST_PROJECTS_PASS = "PASS p2 p2/b.test.js\n\nTest Suites: 2 passed, 2 total\nTests:       3 passed, 3 total\nSnapshots:   0 total\nTime:        0.174 s, estimated 1 s\nRan all test suites in 2 projects.\n";
const NODE_SUMMARY = (pass: number, fail: number) => `ℹ tests ${pass + fail}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 39.321561\n`;
const NODE_A_FAILS = "\n> a@1.0.0 test\n> node --test\n\n✖ adds (0.741316ms)\n✔ ok (0.094237ms)\n" + NODE_SUMMARY(1, 1) +
  "\n✖ failing tests:\n\ntest at a.test.mjs:3:1\n✖ adds (0.741316ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  2 !== 3\n  \n      at TestContext.<anonymous> (file:///tmp/ws/packages/a/a.test.mjs:3:27)\n    operator: 'strictEqual',\n    diff: 'simple'\n  }\n";
const NODE_B_PASSES = "\n> b@1.0.0 test\n> node --test\n\n✔ fine (0.333818ms)\n" + NODE_SUMMARY(1, 0);
const NPM_WORKSPACES = NODE_A_FAILS + "npm error Lifecycle script `test` failed with error:\nnpm error code 1\nnpm error path /tmp/ws/packages/a\nnpm error workspace a@1.0.0\nnpm error location /tmp/ws/packages/a\nnpm error command failed\nnpm error command sh -c node --test\n\n" + NODE_B_PASSES;
const prefixed = (pkg: string, lines: string) => lines.split("\n").filter(Boolean).map((l) => `packages/${pkg} test: ${l}`).join("\n") + "\n";
const PNPM_RECURSIVE = (aFails: boolean) => "Scope: 2 of 3 workspace projects\npackages/a test$ node --test\npackages/b test$ node --test\n" + prefixed("b", NODE_SUMMARY(1, 0)) + prefixed("a", NODE_SUMMARY(aFails ? 1 : 2, aFails ? 1 : 0)) +
  (aFails ? "packages/b test: Done\npackages/a test: Failed\n[ELIFECYCLE] Test failed. See above for more details.\nError: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n" : "packages/b test: Done\npackages/a test: Done\n");

test("receipts: a run of several packages, binaries, environments or workspaces that carried on after a failure is never a pass", () => {
  const cases: [string, string, boolean | null][] = [
    ["go test ./...", GO_FAIL, false],
    ["go test ./... | tail -3", GO_FAIL.split("\n").slice(-4).join("\n"), false],
    ["go test ./..., without its last FAIL (the skeptic's)", GO_FAIL.split("\n").slice(0, -2).join("\n"), false],
    ["go test ./... passing", GO_PASS, true],
    ["cargo test --no-fail-fast", CARGO_NO_FAIL_FAST, false],
    ["cargo test --no-fail-fast | tail -5", CARGO_NO_FAIL_FAST.split("\n").slice(-6).join("\n"), false],
    ["cargo test --workspace", "   Compiling alpha v0.1.0 (/tmp/cargo/alpha)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.17s\n" + CARGO_FAILED, false],
    ["cargo test passing", CARGO_PASS, true],
    ["pytest -n 2", XDIST("========================= 1 failed, 3 passed in 0.22s ==========================", XDIST_FAILURES), false],
    ["pytest -n 2 -q", XDIST("1 failed, 3 passed in 0.21s", XDIST_FAILURES), false],
    ["pytest -n 2 passing", XDIST("============================== 2 passed in 0.24s ==============================="), true],
    ["tox -e a,b", TOX, false],
    ["tox -e a,b | tail -3", TOX.split("\n").slice(-4).join("\n"), false],
    ["tox -e b", TOX_PASS, true],
    ["jest with projects", JEST_PROJECTS, false],
    ["jest with projects passing", JEST_PROJECTS_PASS, true],
    ["npm test --workspaces", NPM_WORKSPACES, false],
    ["npm test --workspaces -s", NODE_A_FAILS + "\n" + NODE_B_PASSES, false],
    ["pnpm -r test", PNPM_RECURSIVE(true), false],
    ["pnpm -r test passing (each line prefixed: no summary of its own)", PNPM_RECURSIVE(false), null],
    ["yarn test", "    operator: 'strictEqual',\n    diff: 'simple'\n  }\nerror Command failed with exit code 1.\ninfo Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.\n", false],
    ["make test", "ok  \texample.com/app/server\t0.001s\nmake: *** [Makefile:2: test] Error 1\n", false],
  ];
  for (const [what, out, want] of cases) assert.equal(verdictOf(out, "test"), want, what);
  // A run over several workspaces cut by `tail` can hide an earlier one's failure, and npm -s prints none of its own:
  // a pass from its output can't be sure, so it's unknown; a failure seen is still a failure.
  const tail = (s: string, n: number) => s.split("\n").slice(-n - 1).join("\n");
  const ws = checksIn("npm test --workspaces -s 2>&1 | tail -12")!;
  assert.equal(ws.several, true);
  assert.equal(verdictOf(tail(NODE_A_FAILS + NODE_B_PASSES, 12), "test"), true, "all the output shows is b's pass");
  assert.deepEqual(stepsOf(ws, true, tail(NODE_A_FAILS + NODE_B_PASSES, 12)), [{ kind: "test", label: "npm test", ok: null, scope: "npm test --workspaces\t\t-s" }]);
  assert.deepEqual(stepsOf(ws, true, NPM_WORKSPACES), [{ kind: "test", label: "npm test", ok: false, scope: "npm test --workspaces\t\t-s" }]);
  for (const line of ["npm run test -ws | tail", "pnpm -r test | tail -20", "pnpm --recursive run test 2>&1 | tail", "npm test -w a -w b | tail", "npm test --workspaces 2>&1 | tee log"]) assert.equal(checksIn(line)!.several, true, line);
  for (const line of ["npm test | tail", "npm test -w api | tail", "npm test -- -r spec | tail", "go test ./... | tail -20", "pnpm --filter api test | tail"]) assert.equal(checksIn(line)!.several, undefined, line);
  const goAll = "go test\t\t./...";
  assert.deepEqual(stepsOf(checksIn("go test ./... 2>&1 | head -2"), true, GO_PASS), [{ kind: "test", label: "go test", ok: null, scope: goAll }], "head keeps the start; a later package may have failed");
  // Its exit is its own (npm exits 1 if any workspace failed), but it isn't a whole run: never a pass, and its exit 0
  // settles only its own earlier failure (`again`).
  assert.deepEqual(stepsOf(checksIn("npm test -ws"), true), [{ kind: "test", label: "npm test", ok: null, scope: "npm test -ws\t\t", again: true }]);
  // The line's exit failed: never a pass from the output (`set -o pipefail`; a coverage threshold after a clean summary).
  assert.deepEqual(stepsOf(checksIn("go test ./... 2>&1 | tail -20"), false, GO_PASS), [{ kind: "test", label: "go test", ok: null, scope: goAll }]);
  assert.deepEqual(stepsOf(checksIn("go test ./... 2>&1 | tail -20"), true, GO_PASS), [{ kind: "test", label: "go test", ok: null, scope: goAll }], "through tail: never a pass");
  assert.deepEqual(stepsOf(checksIn("go test ./... 2>&1 | tail -20"), true, GO_FAIL), [{ kind: "test", label: "go test", ok: false, scope: goAll }]);
});

// The skeptics of 3.9 and 3.10 (20 November), one false "tests pass" at a time; now one rule for the whole class
// (checks.ts): a pass needs a whole run from FULL as a whole line, its own exit 0 and nothing in its output failing.
// Every line below, with how it exited and what it printed, is unknown or a failure, never a pass. The npm and node outputs and make's were printed on this machine (npm 11.19.1,
// node 24.22.3, GNU Make 4.4.1: a's one test fails, b's pass), the rest as their runners print them.
const last = (s: string, n: number) => s.split("\n").slice(-n - 1).join("\n");
const A_ERROR = "test at x.test.mjs:3:1\n✖ broken (0.601133ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\n      at TestContext.<anonymous> (file:///tmp/w/a/x.test.mjs:3:29)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1402:25)\n      at Test.start (node:internal/test_runner/test:1262:17)\n      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: '==',\n    diff: 'simple'\n  }\n";
const A_RUN = "\n> test\n> node --test\n\n✖ broken (0.601133ms)\n" + NODE_SUMMARY(0, 1) + "\n✖ failing tests:\n\n" + A_ERROR;
const B_RUN = (n = 3) => "\n> test\n> node --test\n\n" + Array.from({ length: n }, (_, i) => `✔ case ${i} (0.0${i % 10}4161ms)\n`).join("") + NODE_SUMMARY(n, 0);
const MOCHA_FAILS = "\n> test\n> mocha\n\n\n  ✔ adds\n  1) subtracts\n\n  1 passing (3ms)\n  1 failing\n\n  1) subtracts:\n\n      AssertionError [ERR_ASSERTION]: 1 == 2\n      at Context.<anonymous> (test/x.test.js:4:33)\n\n\n\n";
const MAKE_I = "cd a && node --test\n✖ broken (1.063774ms)\n" + NODE_SUMMARY(0, 1) + "\n✖ failing tests:\n\n" + A_ERROR + "make: [Makefile:2: test] Error 1 (ignored)\n";
const MAVEN_IGNORED = "[INFO] Running com.example.AppTest\n[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.031 s <<< FAILURE! -- in com.example.AppTest\n[ERROR] com.example.AppTest.adds -- Time elapsed: 0.012 s <<< FAILURE!\norg.opentest4j.AssertionFailedError: expected: <3> but was: <2>\n\n[INFO] Results:\n[INFO] \n[ERROR] Failures: \n[ERROR]   AppTest.adds:12 expected: <3> but was: <2>\n[INFO] \n[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0\n[INFO] \n[ERROR] There are test failures.\n\nPlease refer to /w/target/surefire-reports for the individual test results.\n[INFO] ------------------------------------------------------------------------\n[INFO] BUILD SUCCESS\n[INFO] ------------------------------------------------------------------------\n";
const GRADLE_IGNORED = "> Task :test\n\nAppTest > adds() FAILED\n    org.opentest4j.AssertionFailedError at AppTest.java:12\n\n2 tests completed, 1 failed\n\nThere were failing tests. See the report at: file:///w/build/reports/tests/test/index.html\n\nBUILD SUCCESSFUL in 2s\n3 actionable tasks: 1 executed, 2 up-to-date\n";
const GO_START = "ok  \texample.com/app/server\t0.001s\nok  \texample.com/app/store\t(cached)\n";

test("receipts: no line of any shape that can hide a failure is ever a pass: unknown, or a failure when one shows", () => {
  const cases: [why: string, line: string, exitedClean: boolean, output: string, want: (boolean | null)[]][] = [
    // A loop over folders exits as its last folder did (the skeptic on c6cbc519bde1, with real npm and node).
    ["loop, each folder through tail", "for d in a b; do (cd $d && npm test 2>&1 | tail -15); done", true, last(A_RUN, 15) + last(B_RUN(), 15), [null]],
    ["loop, through tail", "for d in a b; do (cd $d && npm test 2>&1); done | tail -15", true, last(A_RUN + B_RUN(), 15), [null]],
    ["loop, whole", "for d in a b; do (cd $d && npm test); done", true, A_RUN + B_RUN(), [false]],
    ["loop, the failure more than 6000 characters back", "for d in a b; do (cd $d && npm test); done", true, A_RUN + B_RUN(300), [false]],
    ["loop, mocha failing then node passing", "for d in a b; do (cd $d && npm test); done", true, MOCHA_FAILS + B_RUN(), [false]],
    ["loop with --prefix", "for d in a b; do npm test --prefix $d; done", true, last(B_RUN(), 15), [null]],
    ["while loop", "while read d; do (cd \"$d\" && npm test); done < dirs.txt", true, B_RUN(), [null]],
    // zsh's short form has no `;` (real: zsh 5.9.2 exits 0 after a's failure); Claude Code saved its long output to a file.
    ["zsh's short loop", "for d (a b) { (cd $d && npm test) }", true, "<persisted-output>\nOutput too large (88.2KB). Full output saved to: /w/tool-results/b2.txt\n\nPreview (first 2KB):\n\n> test\n> node --test\n\n✔ case 0 (0.04ms)\n</persisted-output>", [null]],
    ["zsh's short loop, whole", "for d (a b) { (cd $d && npm test 2>&1) }", true, A_RUN + B_RUN(), [false]],
    ["retried until it passed", "until npm test; do sleep 5; done", true, A_RUN + B_RUN(), [false]],
    ["retried, stopping at a pass", "for i in 1 2 3; do npm test && break; done", true, B_RUN(), [null]],
    ["a condition", "if npm test; then echo ok; else echo failed; fi", true, B_RUN() + "ok\n", [null]],
    ["negated", "! npm test", true, A_RUN, []],
    // Several test runs in one line, however joined.
    ["two folders, ;", "cd a && npm test; cd ../b && npm test", true, B_RUN(), [null, null]],
    ["two folders, &&", "(cd a && npm test) && (cd b && npm test)", true, B_RUN() + B_RUN(), [null, null]],
    ["two workspaces, &&", "npm test -w a && npm test -w b", true, B_RUN() + B_RUN(), [null, null]],
    ["retried once on failure", "npm test || npm test", true, A_RUN + B_RUN(), [false, false]],
    // `;`, `||`, `|| true`, `|| :`, `set +e`: the line's exit isn't the test run's, or a failure carries on.
    ["; after", "npm test; echo done", true, B_RUN() + "done\n", [null]],
    ["; before", "cd api; npm test", true, B_RUN(), [null]],
    ["|| true", "npm test || true", true, B_RUN(), [null]],
    ["|| true, failing", "npm test || true", true, A_RUN, [false]],
    ["|| :", "npm test || :", true, "", [null]],
    ["|| echo", "npm test || echo 'tests failed'", true, "tests failed\n", [null]],
    ["set +e;", "set +e; npm test", true, B_RUN(), [null]],
    ["set +e &&", "set +e && npm test", true, B_RUN(), [null]],
    ["set +o errexit in Codex's shell", "bash -lc 'set +o errexit && npm test'", true, B_RUN(), [null]],
    // A pipe into anything but tee: a filter or a cut (the skeptic on c6cbc519bde1).
    ["tail", "npm test 2>&1 | tail -20", true, B_RUN(), [null]],
    ["head", "npm test 2>&1 | head -40", true, B_RUN(), [null]],
    ["sed -n", "npm test 2>&1 | sed -n '1,80p'", true, B_RUN(), [null]],
    ["awk NR<=", "npm test 2>&1 | awk 'NR<=80'", true, B_RUN(), [null]],
    ["grep | head", "npm test 2>&1 | grep -v DEBUG | head -40", true, B_RUN(), [null]],
    ["cut", "npm test 2>&1 | cut -c1-200", true, B_RUN(), [null]],
    ["cat", "npm test | cat", true, B_RUN(), [null]],
    ["piped into the run", "yes | npm test", true, B_RUN(), [null]],
    ["tee, then tail", "npm test 2>&1 | tee test.log | tail -5", true, last(B_RUN(), 5), [null]],
    ["go test | grep '^ok' keeps only the passes", "go test ./... 2>&1 | grep '^ok'", true, GO_FAIL.split("\n").filter((l) => l.startsWith("ok")).join("\n") + "\n", [null]],
    ["go test | grep -v keeps the failure", "go test ./... 2>&1 | grep -v 'no test files'", true, GO_FAIL, [false]],
    ["go test | head, its failure later", "go test ./... 2>&1 | head -2", true, GO_START, [null]],
    ["go test | sed, its failure later", "go test ./... 2>&1 | sed -n '1,2p'", true, GO_START, [null]],
    // Options that let a run exit 0 with a test failing, or with none run.
    ["make -i", "make -i test", true, MAKE_I, [false]],
    ["make -i, only make's line", "make -i test", true, "./run-tests.sh\nmake: [Makefile:2: test] Error 1 (ignored)\n", [false]],
    ["make test -i", "make test -i", true, "", [null]],
    ["make -ki", "make -ki test", true, "", [null]],
    ["make -n", "make -n test", true, "cd a && node --test\n", [null]],
    ["maven, failures ignored", "mvn test -Dmaven.test.failure.ignore=true", true, MAVEN_IGNORED, [false]],
    ["maven, failures ignored, before the goal", "mvn -Dmaven.test.failure.ignore=true test", true, "", [null]],
    ["maven, testFailureIgnore", "mvn test -DtestFailureIgnore=true", true, "", [null]],
    ["maven, --fail-never", "mvn test -fn", true, "", [null]],
    ["maven, tests skipped", "mvn test -DskipTests", true, "[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS\n", [null]],
    ["gradle, failures ignored in its build file", "./gradlew test", true, GRADLE_IGNORED, [false]],
    ["gradle, a dry run", "./gradlew test --dry-run", true, ":test SKIPPED\n\nBUILD SUCCESSFUL in 1s\n", [null]],
    ["npm --if-present, no test script (real: exit 0, nothing printed)", "npm test --if-present", true, "", [null]],
    ["jest --passWithNoTests", "npx jest --passWithNoTests", true, "No tests found, exiting with code 0\n", [null]],
    ["jest --onlyChanged", "npx jest --onlyChanged", true, "No tests found related to files changed since last commit.\n", [null]],
    ["vitest --changed", "npx vitest run --changed", true, "No test files found, exiting with code 0\n", [null]],
    ["jest --listTests", "npx jest --listTests", true, "/w/a.test.js\n", [null]],
    ["pytest --collect-only", "pytest --collect-only -q", true, "tests/test_api.py::test_adds\n\n1 test collected in 0.01s\n", [null]],
    ["pytest --co", "python -m pytest --co", true, "", [null]],
    ["pytest --version", "pytest --version", true, "pytest 9.1.1\n", [null]],
    ["cargo test --no-run", "cargo test --no-run", true, "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.02s\n  Executable unittests src/lib.rs (target/debug/deps/alpha-efc52a6d3cb8a8f2)\n", [null]],
    ["cargo test -- --list", "cargo test -- --list", true, "tests::adds: test\n\n1 test, 0 benchmarks\n", [null]],
    ["go test -c", "go test -c ./parse", true, "", [null]],
    ["go test -run '^$'", "go test -run '^$' ./...", true, "ok  \texample.com/app/server\t0.001s [no tests to run]\n", [null]],
    ["go test -list", "go test -list . ./...", true, "TestParse\nok  \texample.com/app/parse\t0.001s\n", [null]],
    ["ruff --exit-zero", "ruff check --exit-zero .", true, "Found 3 errors.\n", [false]],
    // Into tee, but the output wasn't seen whole: each work system's cut.
    ["Claude Code cut its middle", "npm test --workspaces -s 2>&1 | tee test.log", true, "\n> test\n> mocha\n\n  ✔ adds\n\n... [212 lines truncated] ...\n\n" + B_RUN(), [null]],
    ["Claude Code saved it to a file", "npm test 2>&1 | tee test.log", true, "<persisted-output>\nOutput too large (100.4KB). Full output saved to: /w/tool-results/b1.txt\n\nPreview (first 2KB):\n" + B_RUN() + "</persisted-output>", [null]],
    ["Codex omitted lines", "go test ./... 2>&1 | tee go.log", true, "Total output lines: 4120\n\nok  \texample.com/app/a\t0.1s\n[... omitted 4100 of 4120 lines ...]\nok  \texample.com/app/z\t0.1s\n", [null]],
    ["OpenCode cut it", "npm test 2>&1 | tee test.log", true, "...48213 bytes truncated...\n\n" + B_RUN(), [null]],
    ["T3 Code cut it", "npm test 2>&1 | tee test.log", true, B_RUN() + "\n… output truncated for transport", [null]],
    ["longer than is read", "npm test 2>&1 | tee test.log", true, "✔ x\n".repeat(150_000) + B_RUN(), [null]],
    // The earlier reviews' shapes.
    ["go test | tail (the first skeptic of 3.9 and 3.10)", "go test ./... 2>&1 | tail -20", true, GO_FAIL, [false]],
    ["go test | tail -3", "go test ./... | tail -3", true, last(GO_FAIL, 3), [false]],
    ["go test | tail, exited 1", "go test ./... 2>&1 | tail -20", false, GO_PASS, [null]],
    ["cargo --no-fail-fast | tail -5", "cargo test --no-fail-fast 2>&1 | tail -5", true, last(CARGO_NO_FAIL_FAST, 5), [false]],
    ["cargo --no-fail-fast | tail -1, only the failed target", "cargo test --no-fail-fast 2>&1 | tail -1", true, last(CARGO_NO_FAIL_FAST, 1), [null]],
    ["tox | tail -3", "tox -e a,b | tail -3", true, last(TOX, 3), [false]],
    ["npm workspaces, silent, through tail", "npm test --workspaces -s 2>&1 | tail -12", true, last(NODE_A_FAILS + NODE_B_PASSES, 12), [null]],
    ["pnpm -r through tail", "pnpm -r test 2>&1 | tail -20", true, PNPM_RECURSIVE(false), [null]],
    ["jest, a suite that didn't load (the skeptic, 16 November)", "npx jest 2>&1 | tail -6", true, "Test Suites: 1 failed, 2 passed, 3 total\nTests:       42 passed, 42 total\nSnapshots:   0 total\nTime:        1.2 s\nRan all test suites.\n", [false]],
    ["the commit failed after a clean summary (the skeptic, 16 November)", "npm test && git commit -am wip", false, NODE_SUMMARY(12, 0) + "nothing to commit, working tree clean\n", [null]],
  ];
  for (const [why, line, clean, output, want] of cases) {
    const steps = stepsOf(checksIn(line), clean, output);
    assert.deepEqual(steps.map((s) => typeof s === "object" && s.ok), want, `${why}: ${line}`);
    assert.notEqual(receipts(steps)?.tests?.ok, true, `${why}: ${line}`);
  }
});

// The skeptic on 5828b30370cf (20 November): six more ways to a false "tests pass". The outputs are as printed on this
// machine (node 24.22.3, npm 11.19.1, vitest 3.2.4, jest 29.7.0, pytest 9.1.1 with pytest-cov 7.1.0, go and cargo as the
// skeptic ran them, GNU Make 4.4.1), with only machine paths shortened; each row is one of the skeptic's repros (s1 to
// s20, cx.ts) or the same hole in another form. Each is its own subtest, so each was seen failing with its fix undone.
const NODE_COVERAGE = "✔ a (0.689218ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 61.355638\nℹ Error: 50.00% function coverage does not meet threshold of 100%.\nℹ start of coverage report\nℹ ----------------------------------------------------------\nℹ file      | line % | branch % | funcs % | uncovered lines\nℹ ----------------------------------------------------------\nℹ lib.mjs   | 100.00 |    66.67 |   50.00 | \nℹ ----------------------------------------------------------\nℹ all files | 100.00 |    66.67 |   50.00 | \nℹ ----------------------------------------------------------\nℹ end of coverage report\n";
const NPM_LINT_AFTER = "\n> n2@1.0.0 test\n> node --test && node lint.mjs\n\n✔ a (0.356ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 40.175835\nlib.mjs:3  'b' is defined but never used\n";
const VITEST_UNHANDLED = "\n RUN  v3.2.4 /w/js/v\n\n ✓ a.test.js (2 tests) 22ms\n⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n\nVitest caught 1 unhandled error during the test run.\nThis might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.\n\n⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯\nError: boom after test\n ❯ Timeout._onTimeout a.test.js:2:64\n      1| import { test, expect } from \"vitest\";\n      2| test(\"ok\", () => { expect(1).toBe(1); setTimeout(() => { throw new Err…\n       |                                                                ^\n      3| test(\"ok2\", async () => { await new Promise(r => setTimeout(r, 20)); e…\n      4| \n ❯ listOnTimeout node:internal/timers:685:17\n ❯ processTimers node:internal/timers:618:7\n\nThis error originated in \"a.test.js\" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.\nThe latest test that might've caused the error is \"ok2\". It might mean one of the following:\n- The error was thrown, while Vitest was running this test.\n- If the error occurred after the test had been completed, this was the last documented test before it was thrown.\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n     Errors  1 error\n   Start at  02:57:03\n   Duration  204ms (transform 10ms, setup 0ms, collect 7ms, tests 22ms, environment 0ms, prepare 45ms)\n\n";
const JEST_COVERAGE = "PASS ./a.test.js\n  ✓ a (1 ms)\n\n----------|---------|----------|---------|---------|-------------------\nFile      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s \n----------|---------|----------|---------|---------|-------------------\nAll files |      75 |       50 |      50 |     100 |                   \n lib.js   |      75 |       50 |      50 |     100 | 1                 \n----------|---------|----------|---------|---------|-------------------\nJest: \"global\" coverage threshold for functions (100%) not met: 50%\nTest Suites: 1 passed, 1 total\nTests:       1 passed, 1 total\nSnapshots:   0 total\nTime:        0.159 s\nRan all test suites.\n";
const PYTEST_COV = "============================= test session starts ==============================\nplatform linux -- Python 3.14.10, pytest-9.1.1, pluggy-1.7.0\nrootdir: /w/py\nplugins: cov-7.1.0\ncollected 1 item\n\ntest_a.py .\nERROR: Coverage failure: total of 67 is less than fail-under=100\n                                                                         [100%]\n\n================================ tests coverage ================================\n_______________ coverage: platform linux, python 3.14.10-final-0 _______________\n\nName     Stmts   Miss  Cover\n----------------------------\nlib.py       6      2    67%\n----------------------------\nTOTAL        6      2    67%\nFAIL Required test coverage of 100% not reached. Total coverage: 66.67%\n============================== 1 passed in 0.02s ===============================\n";
const PYTEST_FAIL = "============================= test session starts ==============================\nplatform linux -- Python 3.14.10, pytest-9.1.1, pluggy-1.7.0\nrootdir: /w/py\ncollected 3 items\n\ntest_a.py .F                                                             [ 66%]\ntest_b.py .                                                              [100%]\n\n=================================== FAILURES ===================================\n___________________________________ test_bad ___________________________________\n\n>   def test_bad(): assert a(0) == 1\n                    ^^^^^^^^^^^^^^^^\nE   assert 2 == 1\nE    +  where 2 = a(0)\n\ntest_a.py:3: AssertionError\n=========================== short test summary info ============================\nFAILED test_a.py::test_bad - assert 2 == 1\n========================= 1 failed, 2 passed in 0.02s ==========================\n";
const PYTEST_DESELECTED = "============================= test session starts ==============================\nplatform linux -- Python 3.14.10, pytest-9.1.1, pluggy-1.7.0\nrootdir: /w/py\nplugins: cov-7.1.0\ncollected 3 items / 1 deselected / 2 selected\n\ntest_a.py .                                                              [ 50%]\ntest_b.py .                                                              [100%]\n\n======================= 2 passed, 1 deselected in 0.01s ========================\n";
const PYTEST_GREP = "FAILED test_a.py::test_bad - assert 2 == 1\n";
const PYTEST_ONE = ".                                                                        [100%]\n1 passed in 0.00s\n";
const PYTEST_OK = "============================= test session starts ==============================\nplatform linux -- Python 3.14.10, pytest-9.1.1, pluggy-1.7.0\nrootdir: /w/pyok\ncollected 1 item\n\ntest_b.py .                                                              [100%]\n\n============================== 1 passed in 0.01s ===============================\n";
const GO_ALL_FAIL = "ok  \texample.com/x\t0.001s\n--- FAIL: TestBroken (0.00s)\n    b_test.go:3: broken\nFAIL\nFAIL\texample.com/x/pkg/b\t0.001s\nFAIL\n";
const GO_FLAGS_OUT = "ok  \texample.com/x\t0.001s [no tests to run]\nok  \texample.com/x/pkg/b\t0.001s\n";
const GO_NONE = "ok  \texample.com/x\t0.001s [no tests to run]\nok  \texample.com/x/pkg/b\t0.001s [no tests to run]\n";
const GO_SKIPPED = "ok  \texample.com/x\t0.002s\nok  \texample.com/x/pkg/b\t0.001s\n";
const GO_TEE_FAIL = "ok  \texample.com/x\t(cached)\n--- FAIL: TestBroken (0.00s)\n    b_test.go:3: broken\nFAIL\nFAIL\texample.com/x/pkg/b\t0.002s\nFAIL\n";
const GO_OK = "ok  \texample.com/x\t(cached)\n";
const API_FAIL = "\n> api@1.0.0 test\n> node --test test/*.test.mjs\n\n✖ api broken (0.676393ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 39.027995\n\n✖ failing tests:\n\ntest at test/a.test.mjs:1:65\n✖ api broken (0.676393ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\n      at TestContext.<anonymous> (file:///w/mono/api/test/a.test.mjs:1:97)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1402:25)\n      at Test.start (node:internal/test_runner/test:1262:17)\n      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: '==',\n    diff: 'simple'\n  }\n";
const ROOT_OK = "\n> root@1.0.0 test\n> node --test test/*.test.mjs\n\n✔ root ok (0.347334ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 36.72542\n";
const MAKE_C_FAIL = "make: Entering directory '/w/mono/api'\nnode --test test/*.test.mjs\n✖ api broken (0.624486ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 36.88519\n\n✖ failing tests:\n\ntest at test/a.test.mjs:1:65\n✖ api broken (0.624486ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\n      at TestContext.<anonymous> (file:///w/mono/api/test/a.test.mjs:1:97)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1402:25)\n      at Test.start (node:internal/test_runner/test:1262:17)\n      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: '==',\n    diff: 'simple'\n  }\nmake: *** [Makefile:3: test] Error 1\nmake: Leaving directory '/w/mono/api'\n";
const CARGO_P_FAIL = "   Compiling api v0.1.0 (/w/rs/api)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.40s\n     Running unittests src/lib.rs (target/debug/deps/api-20ede7c41e42c227)\n\nrunning 1 test\ntest t::broken ... FAILED\n\nfailures:\n\n---- t::broken stdout ----\n\nthread 't::broken' (1389923) panicked at api/src/lib.rs:1:44:\nassertion `left == right` failed\n  left: 1\n right: 2\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    t::broken\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nerror: test failed, to rerun pass `-p api --lib`\n";
const CARGO_ROOT_OK = "   Compiling root v0.1.0 (/w/rs)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.12s\n     Running unittests src/lib.rs (target/debug/deps/root-13d9e692ea7f4419)\n\nrunning 1 test\ntest t::ok ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests root\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n";
const JEST_NONE_FOUND = "No tests found, exiting with code 0\n";
const JEST_FAILING = "FAIL ./a.test.js\n  ✕ broken (2 ms)\n\n  ● broken\n\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: 2\n    Received: 1\n\n    > 1 | test(\"broken\", () => expect(1).toBe(2));\n        |                                        ^\n      2 |\n\n      at Object.<anonymous> (a.test.js:1:40)\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 1 total\nSnapshots:   0 total\nTime:        0.113 s, estimated 1 s\nRan all test suites.\n";
const VITEST_NONE = "\n RUN  v3.2.4 /w/js/v\n\n ↓ a.test.js (2 tests | 2 skipped)\n\n Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n   Start at  03:27:44\n   Duration  192ms (transform 11ms, setup 0ms, collect 6ms, tests 0ms, environment 0ms, prepare 60ms)\n\n";
const JEST_NONE = "Test Suites: 1 skipped, 0 of 1 total\nTests:       1 skipped, 1 total\nSnapshots:   0 total\nTime:        0.131 s, estimated 1 s\nRan all test suites with tests matching \"nomatch\".\n";
const NODE_NONE = "ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 6.031151\n";
const MAKE_OK = "node --test test/*.test.mjs\n✔ root ok (0.475014ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 44.113262\n";
type Ran_ = [line: string, exit: number, output: string, cwd?: string];
/** A run's receipt from its commands in order (the line, its exit, its output, and the folder its work system gave). */
const told = (...runs: (Ran_ | "edit")[]) => receipts(runs.flatMap((r) => (r === "edit" ? ["edit" as const] : stepsOf(checksIn(r[0]), r[1] === 0, r[2], r[3]))));
const VITEST_PASS = " Test Files  1 passed (1)\n      Tests  2 passed (2)\n";

test("receipts: the skeptic's last holes (tee, the folder, env vars, ignore flags, escapes, a narrower pass after a change) are never 'the tests pass'", async (t) => {
  const rows: [why: string, runs: (Ran_ | "edit")[]][] = [
    // 1. Into tee, the line's exit is tee's: a passing summary isn't the runner's exit (s1 to s4, s7).
    ["tee: node's coverage threshold failed the run after its summary passed (s1)", [["node --test --experimental-test-coverage --test-coverage-functions=100 2>&1 | tee test.log", 0, NODE_COVERAGE]]],
    ["tee: npm's script ran a lint after the tests, and it failed (s2)", [["npm test 2>&1 | tee test.log", 0, NPM_LINT_AFTER]]],
    ["tee: vitest's unhandled error after every test passed (s3)", [["npx vitest run 2>&1 | tee vitest.log", 0, VITEST_UNHANDLED]]],
    ["tee: jest's coverage threshold (s4)", [["npx jest --coverage 2>&1 | tee jest.log", 0, JEST_COVERAGE]]],
    ["tee: pytest's --cov-fail-under (s7)", [["pytest --cov=lib --cov-fail-under=100 2>&1 | tee pytest.log", 0, PYTEST_COV]]],
    ["tee: |&", [["npx vitest run |& tee vitest.log", 0, VITEST_UNHANDLED]]],
    ["tee: PIPESTATUS where the shell isn't known (zsh has none)", [["npx jest --coverage 2>&1 | tee jest.log; exit ${PIPESTATUS[0]}", 0, JEST_COVERAGE]]],
    ["tee: bash's PIPESTATUS in zsh, which exits as tee did", [["/bin/zsh -lc 'npx jest --coverage 2>&1 | tee jest.log; exit ${PIPESTATUS[0]}'", 0, JEST_COVERAGE]]],
    ["tee: pipefail set in a subshell that ended", [["(set -o pipefail) && npx jest --coverage 2>&1 | tee jest.log", 0, JEST_COVERAGE]]],
    ["tee: pipefail set, then unset", [["set -o pipefail && set +o pipefail && npx jest --coverage 2>&1 | tee jest.log", 0, JEST_COVERAGE]]],
    ["tee: pipefail, with tail after tee", [["set -o pipefail && npx jest --coverage 2>&1 | tee jest.log | tail -5", 0, last(JEST_COVERAGE, 5)]]],
    // 2. Where it ran: the folder its work system gives, and options that pick the folder or package (s9, s10, s16, cx.ts).
    ["folder: npm --prefix api failed; the root's npm test isn't api's (s9)", [["npm --prefix api test", 1, API_FAIL], "edit", ["npm test", 0, ROOT_OK]]],
    ["folder: make -C api failed; the root's make test (s10)", [["make -C api test", 2, MAKE_C_FAIL], "edit", ["make test", 0, MAKE_OK]]],
    ["folder: cargo test -p api failed; cargo test runs the root package only (s16)", [["cargo test -p api", 101, CARGO_P_FAIL], "edit", ["cargo test", 0, CARGO_ROOT_OK]]],
    ["folder: -papi", [["cargo test -papi", 101, CARGO_P_FAIL], "edit", ["cargo test", 0, CARGO_ROOT_OK]]],
    ["folder: --manifest-path", [["cargo test --manifest-path api/Cargo.toml", 101, CARGO_P_FAIL], "edit", ["cargo test", 0, CARGO_ROOT_OK]]],
    ["folder: pnpm -C", [["pnpm -C api test", 1, API_FAIL], "edit", ["pnpm test", 0, ROOT_OK]]],
    ["folder: npm -w", [["npm test -w api", 1, API_FAIL], "edit", ["npm test", 0, ROOT_OK]]],
    ["folder: pnpm --filter", [["pnpm --filter api test", 1, API_FAIL], "edit", ["pnpm test", 0, ROOT_OK]]],
    ["folder: go test -C", [["go test -C api ./...", 1, GO_ALL_FAIL], "edit", ["go test ./...", 0, GO_OK]]],
    ["folder: gradle -p", [["./gradlew -p api test", 1, ""], "edit", ["./gradlew test", 0, ""]]],
    ["folder: mvn -pl", [["mvn -pl api test", 1, ""], "edit", ["mvn test", 0, ""]]],
    ["folder: jest --rootDir", [["npx jest --rootDir api", 1, JEST_FAILING], "edit", ["npx jest", 0, ""]]],
    ["folder: a subshell's cd ended before the run", [["(cd api) && npm test", 1, API_FAIL], "edit", ["cd api && npm test", 0, ROOT_OK]]],
    ["folder: a cd that can't be read", [["cd $PKG && npm test", 1, API_FAIL], "edit", ["cd $PKG && npm test", 0, ROOT_OK]]],
    ["folder: Codex ran it in api, then in the root (commandExecution.cwd; cx.ts)", [["/bin/zsh -lc 'npm test'", 1, API_FAIL, "/w/mono/api"], "edit", ["/bin/zsh -lc 'npm test'", 0, ROOT_OK, "/w/mono"]]],
    ["folder: Claude Code's shell left in api by an earlier cd", [["npm test", 1, API_FAIL, "/w/mono/api"], "edit", ["npm test", 0, ROOT_OK, "/w/mono"]]],
    // 3. Env vars that narrow a run or ignore failures (s5, s12, s18).
    ["env: PYTEST_ADDOPTS deselects the failing test (s5)", [["pytest", 1, PYTEST_FAIL], "edit", [`PYTEST_ADDOPTS="-k 'not test_bad'" pytest`, 0, PYTEST_DESELECTED]]],
    ["env: GOFLAGS=-run picks the passing test (s12)", [["go test ./...", 1, GO_ALL_FAIL], "edit", ["GOFLAGS=-run=TestFine go test ./...", 0, GO_FLAGS_OUT]]],
    ["env: npm_config_if_present, no test script (s18; real: exit 0, nothing printed)", [["npm_config_if_present=true npm test", 0, ""]]],
    ["env: exported before it", [[`export PYTEST_ADDOPTS="-k 'not test_bad'" && pytest`, 0, PYTEST_DESELECTED]]],
    ["env: through env", [["env GOFLAGS=-run=TestFine go test ./...", 0, GO_FLAGS_OUT]]],
    ["env: MAKEFLAGS=-i", [["MAKEFLAGS=-i make test", 0, MAKE_OK]]],
    ["env: MAKEFLAGS as make's argument", [["make test MAKEFLAGS=-i", 0, MAKE_OK]]],
    ["env: CARGO_*", [["CARGO_BUILD_TARGET=wasm32-wasip1 cargo test", 0, CARGO_ROOT_OK]]],
    ["env: any var whose value narrows", [["NODE_OPTIONS=--test-only node --test", 0, ROOT_OK]]],
    // 4. Options that ignore failures or run nothing, in every form (s13, s18), and output saying no test ran.
    ["ignore: jest --testFailureExitCode=0, its failure on stderr dropped (s18; real: exit 0, nothing printed)", [["npx jest --testFailureExitCode=0 2>/dev/null", 0, ""]]],
    ["ignore: --testFailureExitCode 0, spaced", [["npx jest --testFailureExitCode 0 2>/dev/null", 0, ""]]],
    ["ignore: --passWithNoTests=true (s18)", [["npx jest --passWithNoTests=true", 0, JEST_NONE_FOUND]]],
    ["ignore: npm --if-present=true", [["npm test --if-present=true", 0, ""]]],
    ["ignore: go test -run matching nothing, [no tests to run] everywhere (s13)", [["go test -run TestNothing ./...", 0, GO_NONE]]],
    ["ignore: jest -t matching nothing, every test skipped (real: exit 0)", [["npx jest -t nomatch", 0, JEST_NONE]]],
    ["ignore: vitest -t matching nothing (real: exit 0)", [["npx vitest run -t nomatch", 0, VITEST_NONE]]],
    ["ignore: node --test with no test files (real: exit 0, tests 0)", [["node --test", 0, NODE_NONE]]],
    ["ignore: vitest -u updates the snapshots it would fail", [["npx vitest run -u", 0, VITEST_PASS]]],
    ["ignore: jest -o, only what changed", [["npx jest -o", 0, ""]]],
    ["ignore: vitest --dangerouslyIgnoreUnhandledErrors", [["npx vitest run --dangerouslyIgnoreUnhandledErrors", 0, VITEST_UNHANDLED]]],
    ["ignore: mvn -D skipTests, spaced", [["mvn test -D skipTests", 0, ""]]],
    ["ignore: gradle --exclude-task=test", [["./gradlew check --exclude-task=test", 0, ""]]],
    ["ignore: go test -n prints the commands, runs nothing", [["go test -n ./...", 0, ""]]],
    ["ignore: tox --skip-missing-interpreters", [["tox --skip-missing-interpreters=true", 0, ""]]],
    ["ignore: cargo nextest --no-tests=pass", [["cargo nextest run --no-tests=pass", 0, ""]]],
    ["ignore: deno test --permit-no-files", [["deno test --permit-no-files", 0, ""]]],
    // 5. A backslash escapes a quote outside quotes (s19), and inside double quotes; a comment's quote isn't one.
    ["escape: an unquoted \\' isn't a quote, so || true still swallows the failure (s19)", [["node --test --test-name-pattern=it\\'s > test.log 2>&1 || true", 0, ""]]],
    ["escape: an unquoted \\\"", [["npm test -- -t it\\\"s || true", 0, ROOT_OK]]],
    ["escape: \\\" inside double quotes", [[`npm test -- -t "say \\"hi" || true`, 0, ROOT_OK]]],
    ["escape: Codex's quoting of a quote, taken off before the line is read", [[`/bin/zsh -lc 'npm test -- -t "it'"'"'s" || true'`, 0, ROOT_OK]]],
    ["escape: a quote left open (a shell refuses the line)", [["npm test -- -t it's || true", 0, ROOT_OK]]],
    ["escape: a quote in a comment", [["npm test # it's done\nnpm test || true", 0, ROOT_OK]]],
    // 6. After a change, only a run at least as broad as the last run of everything (s6, s20).
    ["after a change: pytest passed, then one file of it (s20)", [["pytest", 0, PYTEST_OK], "edit", ["pytest tests/test_one.py", 0, PYTEST_OK]]],
    ["after a change: the whole run's result unknown (through grep), then one test (s6)", [["pytest -q 2>&1 | grep FAILED", 0, PYTEST_GREP], "edit", ["pytest -q test_a.py::test_a", 0, PYTEST_ONE]]],
    ["after a change: pytest -k", [["pytest", 0, PYTEST_OK], "edit", ["pytest -k test_b", 0, PYTEST_OK]]],
    ["after a change: one go package", [["go test ./...", 0, GO_OK], "edit", ["go test .", 0, GO_OK]]],
    ["after a change: one file through npm test", [["npm test", 0, ROOT_OK], "edit", ["npm test -- test/r.test.mjs", 0, ROOT_OK]]],
    ["after a change: one cargo test", [["cargo test", 0, CARGO_ROOT_OK], "edit", ["cargo test t::ok", 0, CARGO_ROOT_OK]]],
    ["after a change: the whole run in another folder", [["cd api && npm test", 0, ROOT_OK], "edit", ["npm test", 0, ROOT_OK]]],
  ];
  for (const [why, runs] of rows) await t.test(why, () => assert.equal(green(told(...runs)), false, JSON.stringify(told(...runs))));
});

// The skeptic on 15f35a277892 (20 November, /tmp/skp2): the deny-list's last holes, each a false "tests pass" with the
// code before the allowlist (One rule for a pass: only a whole run from FULL passes). Outputs as the skeptic gave them.
const VITEST_ONE = " Tests  1 passed (1)\n";
const VITEST_THREE = " Tests  3 passed (3)\n";
const PY_FIVE = "5 passed in 0.1s\n";
const PY_ONE_PASSED = "1 passed in 0.1s\n";
const GO_ONE = "ok  \tx\t0.1s\n";
const CARGO_FAILED_ONE = "test result: FAILED. 2 passed; 1 failed\n";
const CARGO_OK_THREE = "test result: ok. 3 passed; 0 failed\n";
test("receipts: the allowlist closes the second round of holes (vitest run as whole, filters, env prefixes, $( ), $'…', deno --allow-none) and runs not on the list", async (t) => {
  const rows: [why: string, runs: (Ran_ | "edit")[]][] = [
    // `npx vitest run` is a whole run (its `run` was taken for a narrowing), so a narrower run after a change is stale (R6).
    ["vitest run, then one file of it after a change (R6)", [["npx vitest run", 0, VITEST_THREE], "edit", ["npx vitest run src/a.test.ts", 0, VITEST_ONE]]],
    ["vitest run, then -t after a change (R6)", [["npx vitest run", 0, VITEST_THREE], "edit", ["npx vitest run -t foo", 0, " Tests  1 passed | 2 skipped (3)\n"]]],
    ["pytest tests/, then one file after a change (R6)", [["pytest tests/", 0, PY_FIVE], "edit", ["pytest tests/test_one.py", 0, PY_ONE_PASSED]]],
    ["go test with no package, then -run after a change (R6)", [["go test", 0, GO_ONE], "edit", ["go test -run TestOne", 0, GO_ONE]]],
    ["pytest -n auto, then one file after a change (R6)", [["pytest -n auto", 0, PY_FIVE], "edit", ["pytest -n auto tests/test_one.py", 0, PY_ONE_PASSED]]],
    ["pytest -ra, then -k after a change (R6)", [["pytest -ra", 0, PY_FIVE], "edit", ["pytest -k one", 0, "1 passed, 4 deselected in 0.1s\n"]]],
    // A filter or selection, alone.
    ["pytest -k 'not test_bad'", [["pytest -k 'not test_bad'", 0, "4 passed, 1 deselected in 0.1s\n"]]],
    ["pytest --lf", [["pytest --lf", 0, PY_ONE_PASSED]]],
    ["pytest --deselect", [["pytest --deselect tests/test_a.py::test_bad", 0, "4 passed, 1 deselected in 0.1s\n"]]],
    ["go test -skip", [["go test -skip TestBroken ./...", 0, GO_ONE]]],
    ["go test -short", [["go test -short ./...", 0, GO_ONE]]],
    ["npm test -- -t", [["npm test -- -t foo", 0, ""]]],
    ["vitest -t", [["npx vitest run -t foo", 0, " Tests  1 passed | 4 skipped (5)\n"]]],
    ["vitest --project", [["npx vitest run --project unit", 0, VITEST_ONE]]],
    ["vitest --shard", [["npx vitest run --shard=1/4", 0, VITEST_ONE]]],
    ["jest --onlyFailures", [["npx jest --onlyFailures", 0, "Tests:       1 passed, 1 total\n"]]],
    ["jest -f", [["npx jest -f", 0, "Tests:       1 passed, 1 total\n"]]],
    // A reporter's value is never an option: `--reporters -u` updates snapshots (the skeptic on 7b8da01ae5b2).
    ["npm test -- --reporters -u", [["npm test -- --reporters -u", 0, ""]]],
    ["npm test -- --reporters -u --reporters default", [["npm test -- --reporters -u --reporters default", 0, ""]]],
    ["yarn test -- --reporters -u", [["yarn test -- --reporters -u", 0, ""]]],
    ["pnpm test -- --reporters -o", [["pnpm test -- --reporters -o", 0, ""]]],
    ["npx vitest run --reporter -u", [["npx vitest run --reporter -u", 0, VITEST_ONE]]],
    ["npx mocha -R -g", [["npx mocha -R -g foo", 0, ""]]],
    // `bun run test` (a package script) failing isn't settled by `bun test` (bun's own runner), in another turn either.
    ["bun run test fails, then bun test passes", [["bun run test", 1, " 1 fail\n"], ["bun test", 0, " 3 pass\n 0 fail\n"]]],
    // Snapshot updates and other ways to pass, through an env var or an option.
    ["INSTA_UPDATE=always after cargo test failed", [["cargo test", 101, CARGO_FAILED_ONE], "edit", ["INSTA_UPDATE=always cargo test", 0, CARGO_OK_THREE]]],
    ["INSTA_FORCE_PASS=1 after cargo test failed", [["cargo test", 101, CARGO_FAILED_ONE], ["INSTA_FORCE_PASS=1 cargo test", 0, CARGO_OK_THREE]]],
    ["UPDATE_EXPECT=1 after cargo test failed", [["cargo test", 101, CARGO_FAILED_ONE], ["UPDATE_EXPECT=1 cargo test", 0, CARGO_OK_THREE]]],
    ["UPDATE_SNAPSHOTS=1 after npm test failed", [["npm test", 1, API_FAIL], ["UPDATE_SNAPSHOTS=1 npm test", 0, ""]]],
    ["NEXTEST_NO_TESTS=pass", [["NEXTEST_NO_TESTS=pass cargo nextest run", 0, ""]]],
    ["go test -update", [["go test ./... -update", 0, GO_ONE]]],
    ["TESTS=… make test after make test failed", [["make test", 2, "make: *** [Makefile:2: test] Error 1\n"], "edit", ["TESTS=tests/test_ok.py make test", 0, ""]]],
    ["make test TESTS=… after make test failed", [["make test", 2, "make: *** [Makefile:2: test] Error 1\n"], "edit", ["make test TESTS=tests/test_ok.py", 0, ""]]],
    ["TEST_PATTERN=ok npm test after npm test failed", [["npm test", 1, API_FAIL], "edit", ["TEST_PATTERN=ok npm test", 0, ""]]],
    ["any env var, however harmless (CI=1)", [["CI=1 FORCE_COLOR=0 NODE_OPTIONS=--max-old-space-size=4096 npm test", 0, ROOT_OK]]],
    ["jest's ESM switch through NODE_OPTIONS", [["NODE_OPTIONS=--experimental-vm-modules npx jest", 0, "Tests:       1 passed, 1 total\n"]]],
    // $( … ): the run inside it, its `cd` and `&&` too.
    ["$( ) with &&: true $(cd api && npm test)", [["true $(cd api && npm test 2>/dev/null)", 0, ""]]],
    ["$( ) with &&: out=$(cd api && npm test)", [["out=$(cd api && npm test 2>&1)", 0, ""]]],
    ["$( ) with &&, its output dropped", [["echo $(cd api && npm test) >/dev/null 2>&1", 0, ""]]],
    ["$( ) in double quotes", [[`echo "$(cd api && npm test)"`, 0, ""]]],
    ["cd into a command's output", [[`cd "$(git rev-parse --show-toplevel)" && npm test`, 0, ROOT_OK]]],
    // $'…' quoting: `\'` is a quote there, so a `|| true` after it was read as inside a quote.
    ["$'…' hides || true", [["npm test -- -t $'\\'' || true #'", 0, ""]]],
    // `set` as written: `env set -o pipefail` runs no `set` (the review of this change), so tee's exit is the line's.
    ["env set -o pipefail; … | tee", [["env set -o pipefail; npm test | tee log", 0, ROOT_OK]]],
    ["deno test --allow-none", [["deno test --allow-none", 0, "ok | 0 passed | 0 failed (1ms)\n"]]],
    // Not on the list: a pass of any other runner, option or spelling is never "the tests pass".
    ["a quoted test name", [[`npm test -- -t "say \\"hi\\""`, 0, ROOT_OK]]],
    ["npm test --prefix (was the same folder twice)", [["npm --prefix api test", 1, API_FAIL], "edit", ["npm --prefix api test", 0, ROOT_OK]]],
    ["make -C (was the same folder twice)", [["make -C api test", 2, MAKE_C_FAIL], "edit", ["make -C api test", 0, MAKE_OK]]],
    ["node --test", [["node --test", 0, ROOT_OK]]],
    ["npm run test", [["npm run test", 0, ROOT_OK]]],
    ["time npm test", [["time npm test", 0, ROOT_OK]]],
    ["npm test, then tail its log", [["npm test > log 2>&1 && tail -5 log", 0, ""]]],
    ["pytest -n auto after pytest failed", [["pytest", 1, PYTEST_FAIL], "edit", ["pytest -n auto", 0, PY_FIVE]]],
    ["cargo test --lib after cargo test failed", [["cargo test", 101, CARGO_FAILED_ONE], "edit", ["cargo test --lib", 0, CARGO_OK_THREE]]],
    ["jest --shard after npx jest failed", [["npx jest", 1, "Tests:       1 failed, 4 passed, 5 total\n"], "edit", ["npx jest --shard=1/2", 0, "Tests:       2 passed, 2 total\n"]]],
    ["uv run --with after uv run pytest failed", [["uv run pytest", 1, PYTEST_FAIL], "edit", ["uv run --with pytest-xdist pytest", 0, PY_FIVE]]],
    ["tox -e after tox failed", [["tox", 1, "  py311: FAIL code 1 (1.0s)\n"], "edit", ["tox -e py312", 0, "  congratulations :)\n"]]],
    // Another runner's whole run after a failure, in the same folder: that runner's failure stands.
    ["npm test after npx vitest run failed", [["npx vitest run", 1, " Tests  1 failed (1)\n"], "edit", ["npm test", 0, ROOT_OK]]],
    ["yarn test after npm test failed", [["npm test", 1, API_FAIL], "edit", ["yarn test", 0, ROOT_OK]]],
    ["npx jest after npm test failed", [["npm test", 1, API_FAIL], "edit", ["npx jest", 0, "Tests:       5 passed, 5 total\n"]]],
    ["pnpm test after pnpm --filter api test failed", [["pnpm --filter api test", 1, API_FAIL], "edit", ["pnpm test", 0, ROOT_OK]]],
  ];
  for (const [why, runs] of rows) await t.test(why, () => assert.equal(green(told(...runs)), false, JSON.stringify(told(...runs))));
});

test("receipts: plain runs, and the runner's own exit through tee, still pass", async (t) => {
  const rows: [why: string, runs: (Ran_ | "edit")[]][] = [
    ["npm test", [["npm test", 0, ROOT_OK]]],
    ["its output redirected", [["npm test >/dev/null 2>&1", 0, ""]]],
    ["pipefail, then tee", [["set -o pipefail && npm test 2>&1 | tee test.log", 0, ROOT_OK]]],
    ["pipefail, then tee -a", [["set -o pipefail && npm test 2>&1 | tee -a test.log", 0, ROOT_OK]]],
    ["set -euo pipefail;", [["set -euo pipefail; npx vitest run | tee vitest.log", 0, VITEST_PASS]]],
    ["bash's PIPESTATUS, bash known", [["bash -lc 'npm test 2>&1 | tee test.log; exit ${PIPESTATUS[0]}'", 0, ROOT_OK]]],
    ["bash's PIPESTATUS after cd", [["/bin/bash -lc 'cd api && npm test | tee log; exit ${PIPESTATUS[0]}'", 0, ROOT_OK]]],
    ["zsh's pipestatus, zsh known", [["/bin/zsh -lc 'npm test 2>&1 | tee test.log; exit $pipestatus[1]'", 0, ROOT_OK]]],
    ["Codex's zsh with pipefail", [["/bin/zsh -lc 'set -o pipefail; npm test 2>&1 | tee log'", 0, ROOT_OK]]],
    ["a comment", [["npm test # it's done", 0, ROOT_OK]]],
    ["the same folder, however it got there (Codex)", [["/bin/zsh -lc 'cd api && npm test'", 1, API_FAIL, "/w/mono"], "edit", ["/bin/zsh -lc 'npm test'", 0, ROOT_OK, "/w/mono/api"]]],
    ["the same folder, however it got there (Claude Code's shell, then cd)", [["npm test", 1, API_FAIL, "/w/mono/api"], "edit", ["cd /w/mono/api && npm test", 0, ROOT_OK, "/w/mono"]]],
    ["the same folder, however it's spelled", [["cd api/ && npm test", 1, API_FAIL], "edit", ["cd ./api && npm test", 0, ROOT_OK]]],
    ["--prefix's folder, then a whole run there", [["npm --prefix api test", 1, API_FAIL], "edit", ["cd api && npm test", 0, ROOT_OK]]],
    ["pnpm -C's folder, then a whole run there", [["pnpm -C api test", 1, API_FAIL], "edit", ["cd api && pnpm test", 0, ROOT_OK]]],
    ["make -C's folder, then a whole run there", [["make -C api test", 2, MAKE_C_FAIL], "edit", ["cd api && make test", 0, MAKE_OK]]],
    ["pytest, then python -m pytest", [["pytest", 1, PYTEST_FAIL], "edit", ["python -m pytest", 0, PYTEST_OK]]],
    ["after a change, the whole run again", [["pytest", 0, PYTEST_OK], "edit", ["pytest -q", 0, PYTEST_OK]]],
    ["after a change, one file, then the whole run", [["pytest", 0, PYTEST_OK], "edit", ["pytest tests/test_one.py", 0, PYTEST_ONE], ["pytest", 0, PYTEST_OK]]],
    ["vitest run, a change, vitest run", [["npx vitest run", 0, VITEST_PASS], "edit", ["npx vitest run", 0, VITEST_PASS]]],
    ["one package after the whole run passed, nothing changed", [["go test ./...", 0, GO_OK], ["go test .", 0, GO_OK]]],
    // Each runner on the list, with its output options.
    ["npm test -- reporter and verbosity", [["npm test -- --reporter=dot --verbose", 0, ROOT_OK]]],
    ["pnpm test, yarn test", [["pnpm test", 0, ROOT_OK], ["yarn test", 0, ROOT_OK]]],
    ["npx vitest run --reporter", [["npx vitest run --reporter dot --silent", 0, VITEST_PASS]]],
    ["npx jest --silent --verbose", [["npx jest --silent --verbose --reporters=default", 0, "Tests:       1 passed, 1 total\n"]]],
    ["npx mocha -R", [["npx mocha -R spec --no-colors", 0, "  3 passing (5ms)\n"]]],
    ["python3 -m pytest with output options", [["python3 -m pytest -q -rA --tb=short --color=no -p no:cacheprovider", 0, PYTEST_OK]]],
    ["uv run pytest, poetry run pytest", [["uv run pytest -vv", 0, PYTEST_OK], ["poetry run pytest", 0, PYTEST_OK]]],
    ["go test with -v -race -count=1 -timeout", [["go test -race -count=1 ./... -v -timeout 10m", 0, GO_OK]]],
    ["cargo test --workspace --all-features -q", [["cargo test --workspace --all-features -q --color never", 0, CARGO_ROOT_OK]]],
    ["make test, bun test, deno test", [["make test", 0, MAKE_OK], ["bun test", 0, " 3 pass\n 0 fail\n"], ["deno test", 0, "ok | 3 passed | 0 failed (5ms)\n"]]],
    // The known limit: it reads commands and output, not the tests, so a skipped test still passes (engine.md).
    ["the known limit: a test skipped (it.skip, @pytest.mark.skip)", [["pytest", 0, "4 passed, 1 skipped in 0.1s\n"]]],
  ];
  for (const [why, runs] of rows) await t.test(why, () => assert.equal(green(told(...runs)), true, JSON.stringify(told(...runs))));
});

// One rule for a pass: where a thread's test runs stand is remembered across its runs (its turns: `Tested`), so a later
// run's unknown, narrower or other-folder run never turns an earlier failure into a pass, and a pass after a change
// needs a whole run after it in every place.
// Sol on 45ec9eccdf6f (F4): `cd no-such-subproject && npm test` exits 1 from the cd, and npm never starts, but its exit
// was taken for the tests', a failed test run that rang an only-trouble watch and stayed in the thread's memory. A
// failure is the check's only when it surely ran: nothing before it that could stop it (`&&`, `||`), or its runner's own
// output saying how it went; else unknown.
test("receipts: a setup command that failed before the check isn't the check failing; the runner's own output still is", { skip: WINDOWS && "bash runs the commands, as agents run them on macOS and Linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "driver-checks-"));
  try {
    for (const line of ["cd no-such-subproject && npm test", "cd no-such-subproject && cargo test", "cd no-such-subproject && npm run build", "false && npm test"]) {
      const run = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8" });
      assert.notEqual(run.status, 0, line);
      assert.equal(receipts(stepsOf(checksIn(line), false, run.stdout + run.stderr, dir)), undefined, `${line}: was a failure (${run.stderr.trim()})`);
    }
  } finally { removeDir(dir); }
  // Codex's shell, its folder not there.
  assert.equal(receipts(stepsOf(checksIn("/bin/zsh -lc 'cd no-such && npm test'"), false, "zsh:cd:1: no such file or directory: no-such\n", "/w/mono")), undefined);
  // The runner ran: its output says it failed, or that it ran (a passing summary, then a coverage threshold failing it).
  assert.deepEqual(receipts(stepsOf(checksIn("cd api && npm test"), false, API_FAIL)), { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  assert.deepEqual(receipts(stepsOf(checksIn("cd api && npm test"), false, `${ROOT_OK}ERROR: Coverage for lines (71%) does not meet global threshold (90%)\n`)), { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  assert.deepEqual(receipts(stepsOf(checksIn("set -o pipefail && npm test | tee log"), false, ROOT_OK)), { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  // Nothing before it that could stop it: its exit is its own, output or not.
  for (const line of ["npm test", "cd api; npm test", "npm test 2>&1", "cargo build"]) assert.equal(receipts(stepsOf(checksIn(line), false, ""))?.[line.startsWith("cargo") ? "build" : "tests"]?.ok, false, line);
  // A failing cd isn't remembered as a failing folder: the thread's whole run passing afterwards is a pass.
  const memory = new Tested();
  memory.receipts("t", "r1", stepsOf(checksIn("cd no-such && npm test"), false, "bash: line 1: cd: no-such: No such file or directory\n"));
  assert.equal(green(memory.receipts("t", "r2", ["edit", ...stepsOf(checksIn("npm test"), true, ROOT_OK)])), true);
});

// The skeptic on 7717d10f3219: F4's fix took a failing exit after `cd x &&` for the check's only with a runner's summary,
// and npm 11 prints nothing of its own when a script fails, nor do vite, next, go build, swift build or playwright print
// a summary the table knows, so `cd web && npm run build` failing (the way agents build) was unknown. Now it's the check's
// unless the output shows a command before it failed (a cd, a command or a file not found, a missing script), npm's or
// pnpm's banner is missing where it always prints one, or nothing was printed at all. The outputs are real ones' shapes;
// npm's own runs here for real.
test("receipts: after a cd, a build or a runner with no summary failing is still a failure; a setup step that failed, or npm never starting, isn't", { skip: WINDOWS && "bash runs the commands, as agents run them on macOS and Linux" }, () => {
  const built = (line: string, output: string) => receipts(stepsOf(checksIn(line), false, output, "/p"));
  const failed = (kind: "tests" | "build" | "lint", label: string) => ({ [kind]: { ok: false, runs: 1, failed: 1, label } });
  const VITE = "vite v5.4.11 building for production...\ntransforming...\n✓ 3 modules transformed.\nx Build failed in 120ms\nerror during build:\n[vite]: Rollup failed to resolve import \"./x\" from \"/p/web/src/main.ts\".\n";
  const banner = (script: string, cmd: string) => `\n> web@1.0.0 ${script}\n> ${cmd}\n\n`;
  const ran: [line: string, output: string, kind: "tests" | "build" | "lint", label: string][] = [
    ["cd web && npm run build", banner("build", "vite build") + VITE, "build", "npm build"],
    ["/bin/zsh -lc 'cd web && npm run build'", banner("build", "vite build") + VITE, "build", "npm build"],
    ["cd /p && npm run build", "\n> proj@0.1.0 build\n> next build\n\n   ▲ Next.js 15.1.0\n\n   Creating an optimized production build ...\nFailed to compile.\n\n./app/page.tsx:3:1\nType error: Cannot find name 'x'.\n", "build", "npm build"],
    ["cd web && pnpm build", "\n> web@1.0.0 build /p/web\n> vite build\n\n" + VITE, "build", "pnpm build"],
    ["cd /p && go build ./...", "# example.com/x\n./main.go:3:2: undefined: y\n", "build", "go build"],
    ["cd /p && swift build", "Building for debugging...\n/p/Sources/App/main.swift:3:1: error: cannot find 'y' in scope\nerror: emit-module command failed with exit code 1 (use -v to see invocation)\n", "build", "swift build"],
    ["cd /p && npx playwright test", "Running 5 tests using 2 workers\n\n  1) [chromium] › a.spec.ts:3:1 › x\n\n  1 failed\n    [chromium] › a.spec.ts:3:1 › x\n  4 passed (3.2s)\n", "tests", "playwright test"],
    ["cd api && deno test", "running 2 tests from ./a_test.ts\nx ... FAILED (2ms)\ny ... ok (1ms)\n\nFAILED | 1 passed | 1 failed (5ms)\n\nerror: Test failed\n", "tests", "deno test"],
    // npm started, and the script's own tool wasn't there: npm test failed.
    ["cd api && npm test", "\n> api@1.0.0 test\n> vitest run\n\nsh: 1: vitest: not found\n", "tests", "npm test"],
    // Silenced, npm prints no banner: the runner's output shows it ran.
    ["cd web && npm run build --silent", VITE, "build", "npm build"],
  ];
  for (const [line, output, kind, label] of ran) assert.deepEqual(built(line, output), failed(kind, label), `${line}: was unknown`);
  const never: [line: string, output: string][] = [
    // npm always prints its banner as a script starts: without it, npm never ran its script.
    ["git pull && npm test", "fatal: not a git repository (or any of the parent directories): .git\n"],
    ["cd api && npm run build", "npm error Missing script: \"build\"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n"],
    ["cd api && pnpm -C web run build", " ERR_PNPM_NO_SCRIPT  Missing script: build\n"],
    // The shell saying a command before it failed (bash 5.3, zsh as Codex and Claude Code run it).
    ["cd /p && go build ./...", "bash: line 1: cd: /p: No such file or directory\n"],
    ["cd /p && go build ./...", "zsh:cd:1: no such file or directory: /p\n"],
    ["cd /etc/passwd && cargo test", "zsh:cd:1: not a directory: /etc/passwd\n"],
    ["cd /p && pytest", "bash: line 1: pytest: command not found\n"],
    ["cd /p && pytest", "zsh:1: command not found: pytest\n"],
    ["cd app && ./gradlew test", "bash: line 1: ./gradlew: No such file or directory\n"],
    ["cd app && ./gradlew test", "zsh:1: no such file or directory: ./gradlew\n"],
    ["source .venv/bin/activate && pytest", "bash: line 1: .venv/bin/activate: No such file or directory\n"],
    ["source .venv/bin/activate && pytest", "(eval):source:1: no such file or directory: .venv/bin/activate\n"],
    ["cd /p && swift build", "sh: 1: cd: can't cd to /p\n"],
    // Nothing printed: a check that fails says why.
    ["test -d api && go test ./...", ""],
  ];
  for (const [line, output] of never) assert.equal(built(line, output), undefined, `${line}: was a failure (${output.trim()})`);
  // npm itself, run for real: its banner, then the script's failure, and nothing of npm's own after it. At npm's own
  // log level, whatever this run was started with (`npm run --silent check`, as scripts/connector-release runs it, hides
  // the banner).
  const dir = mkdtempSync(join(tmpdir(), "driver-checks-"));
  try {
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "package.json"), JSON.stringify({ name: "web", version: "1.0.0", scripts: { build: "echo 'error during build:' >&2; exit 1", test: "exit 1" } }));
    for (const [line, kind, label] of [["cd web && npm run build", "build", "npm build"], ["cd web && npm test", "tests", "npm test"]] as const) {
      const run = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false", npm_config_loglevel: "notice" } });
      assert.notEqual(run.status, 0, line);
      assert.deepEqual(built(line, run.stdout + run.stderr), failed(kind, label), `${line}: ${run.stdout + run.stderr}`);
    }
  } finally { removeDir(dir); }
});

test("receipts: a thread's test runs are remembered across its runs, in the store, until it ends", async (t) => {
  const steps = (runs: (Ran_ | "edit")[]) => runs.flatMap((r) => (r === "edit" ? ["edit" as const] : stepsOf(checksIn(r[0]), r[1] === 0, r[2], r[3])));
  const turns = (memory: Tested, thread: string, ...runs: (Ran_ | "edit")[][]) => runs.map((r, n) => memory.receipts(thread, `run-${n}`, steps(r))).at(-1);
  const never: [why: string, runs: (Ran_ | "edit")[][]][] = [
    ["a narrow pass in the next run", [[["npm test", 1, API_FAIL]], [["npm test -- test/a.test.mjs", 0, ROOT_OK]]]],
    ["a narrow pass in the next run, after a change", [[["npm test", 1, API_FAIL]], ["edit", ["npm test -- test/a.test.mjs", 0, ROOT_OK]]]],
    ["another folder's whole run in the next run", [[["cd api && npm test", 1, API_FAIL]], ["edit", ["npm test", 0, ROOT_OK]]]],
    ["--prefix's folder failed; the root's whole run in the next run (s9)", [[["npm --prefix api test", 1, API_FAIL]], ["edit", ["npm test", 0, ROOT_OK]]]],
    ["Codex's folder in the next run", [[["/bin/zsh -lc 'npm test'", 1, API_FAIL, "/w/mono/api"]], ["edit", ["/bin/zsh -lc 'npm test'", 0, ROOT_OK, "/w/mono"]]]],
    ["a pass, a change, then another folder's whole run in the next run", [[["cd api && npm test", 0, ROOT_OK], "edit"], [["cd web && npm test", 0, ROOT_OK]]]],
    ["a narrow failure, then another runner in the next run", [[["pytest tests/test_x.py", 1, PYTEST_FAIL]], [["npm test", 0, ROOT_OK]]]],
    ["a pass, then a run that can't be told in the next run", [[["npm test", 0, ROOT_OK]], [["npm test 2>&1 | tail -5", 0, last(ROOT_OK, 5)]]]],
    ["three runs: a failure, a run with no tests, a narrow pass", [[["pytest", 1, PYTEST_FAIL]], ["edit"], [["pytest tests/test_one.py", 0, PYTEST_ONE]]]],
  ];
  for (const [why, runs] of never) await t.test(why, () => assert.equal(green(turns(new Tested(), "t", ...runs)), false));
  const passes: [why: string, runs: (Ran_ | "edit")[][]][] = [
    ["the whole run again in the next run", [[["npm test", 1, API_FAIL]], ["edit", ["npm test", 0, ROOT_OK]]]],
    ["each folder's whole run again", [[["cd api && npm test", 1, API_FAIL]], ["edit", ["cd api && npm test", 0, ROOT_OK], ["npm test", 0, ROOT_OK]]]],
    ["--prefix's failure, then a whole run in its folder", [[["npm --prefix api test", 1, API_FAIL]], ["edit", ["cd api && npm test", 0, ROOT_OK]]]],
    ["a narrow failure, then the whole run in the next run", [[["pytest tests/test_x.py", 1, PYTEST_FAIL]], ["edit", ["pytest", 0, PYTEST_OK]]]],
  ];
  for (const [why, runs] of passes) await t.test(why, () => assert.equal(green(turns(new Tested(), "t", ...runs)), true));
  await t.test("a run read again (still going) is folded again from where it started", () => {
    const m = new Tested();
    assert.equal(m.receipts("t", "r1", steps([["npm test", 1, API_FAIL]]))?.tests?.ok, false);
    assert.equal(green(m.receipts("t", "r1", steps([["npm test", 1, API_FAIL], "edit", ["npm test", 0, ROOT_OK]]))), true);
    assert.equal(green(m.receipts("t", "r2", steps([["pytest", 0, PYTEST_OK]]))), true, "the next run starts from r1's end");
    assert.equal(m.receipts("other", "r1", steps([["pytest", 0, PYTEST_OK]]))?.tests?.ok, true, "each thread its own");
  });
  await t.test("kept in the adapter's store across a restart; forgotten when the thread ends", () => {
    const db = new DatabaseSync(":memory:");
    new Tested(db).receipts("t", "r1", steps([["cd api && npm test", 1, API_FAIL]]));
    const again = new Tested(db);
    assert.equal(green(again.receipts("t", "r2", steps(["edit", ["npm test", 0, ROOT_OK]]))), false, "api's failure, from the store");
    again.forget("t");
    assert.equal(green(again.receipts("t", "r3", steps([["npm test", 0, ROOT_OK]]))), true);
    db.close();
  });
});

test("receipts: a narrower rerun after a broader failing one isn't the tests passing; a run at least as broad is", () => {
  // A failing run prints its runner's failing summary, as a real one does (after `cd a &&`, what makes it the run's: F4).
  const run = (...lines: [string, boolean][]) => receipts(lines.flatMap(([line, ok]) => [...stepsOf(checksIn(line), ok, ok ? "" : "ℹ fail 1"), "edit" as const]).slice(0, -1));
  const narrower: [string, [string, boolean][]][] = [
    ["a path", [["pytest", false], ["pytest tests/test_billing.py", true]]],
    ["a -k filter", [["python -m pytest", false], ["python -m pytest -k billing", true]]],
    ["a -t filter", [["npx jest", false], ["npx jest -t adds", true]]],
    ["a --grep filter", [["npx mocha", false], ["npx mocha --grep adds", true]]],
    ["the last failures only", [["pytest", false], ["pytest --lf", true]]],
    ["one package", [["go test ./...", false], ["go test ./parse", true]]],
    ["the folder's package only", [["go test ./...", false], ["go test", true]]],
    ["a -run filter", [["go test ./...", false], ["go test -run TestParse ./...", true]]],
    ["one crate", [["cargo test", false], ["cargo test -p core", true]]],
    ["a test name", [["cargo test", false], ["cargo test parses", true]]],
    ["a test named run", [["cargo test", false], ["cargo test run", true]]],
    ["one workspace package", [["pnpm test", false], ["pnpm --filter api test", true]]],
    ["one npm workspace", [["npm test", false], ["npm test -w api", true]]],
    ["a file through npm", [["npm test", false], ["npm test -- src/billing.test.ts", true]]],
    ["another script", [["npm test", false], ["npm run test:unit", true]]],
    ["a node --test file", [["node --test", false], ["node --test test/billing.test.ts", true]]],
    ["a vitest file", [["npx vitest run", false], ["npx vitest run src/billing.test.ts", true]]],
    ["xcodebuild -only-testing", [["xcodebuild -scheme Driver test", false], ["xcodebuild -scheme Driver -only-testing:DriverTests/BillingTests test", true]]],
    ["swift test --filter", [["swift test", false], ["swift test --filter BillingTests", true]]],
    ["gradle --tests", [["./gradlew test", false], ["./gradlew test --tests AppTest", true]]],
    ["another folder", [["cd a && npm test", false], ["cd b && npm test", true]]],
    ["another runner", [["npm test", false], ["npx vitest run", true]]],
    ["narrowed and failing, then passing, after the whole suite failed", [["pytest", false], ["pytest tests/test_x.py", false], ["pytest tests/test_x.py", true]]],
    ["two narrow failures, then one of them passing", [["pytest tests/a.py", false], ["pytest tests/b.py", false], ["pytest tests/a.py", true]]],
  ];
  for (const [why, lines] of narrower) assert.equal(run(...lines)?.tests?.ok, false, why);
  // Told by the failure: the narrower pass isn't counted.
  assert.deepEqual(run(["pytest", false], ["pytest tests/test_x.py", true]), { tests: { ok: false, runs: 1, failed: 1, label: "pytest", stale: true } });
  const broadEnough: [string, [string, boolean][]][] = [
    ["the same run", [["pytest", false], ["pytest", true]]],
    ["only its output changed", [["npm test", false], ["npm test 2>&1", true]]],
    ["quieter", [["pytest", false], ["pytest -q", true]]],
    ["the whole suite after a narrow failure", [["pytest tests/test_x.py", false], ["pytest", true]]],
    ["all packages after one", [["go test ./parse", false], ["go test -count=1 ./...", true]]],
    ["narrow, then the whole suite again", [["pytest", false], ["pytest tests/test_x.py", true], ["pytest", true]]],
    ["the same folder", [["cd api && npm test", false], ["cd api && npm test 2>&1", true]]],
    ["vitest's run again", [["npx vitest run", false], ["npx vitest run --reporter=dot", true]]],
  ];
  for (const [why, lines] of broadEnough) assert.equal(run(...lines)?.tests?.ok, true, why);
  // The same narrow run passing again settles its own failure, but isn't a whole run: no pass (One rule for a pass).
  assert.equal(run(["pytest -k billing", false], ["pytest -k billing", true]), undefined);
  assert.deepEqual(run(["pytest", false], ["pytest tests/test_x.py", true], ["pytest", true]), { tests: { ok: true, runs: 2, failed: 1, label: "pytest", edited: true } });
  // Mid-run, the same receipt is what "call me when the tests pass" looks at: the failure, with a change after it, never rings.
  assert.deepEqual(run(["go test ./...", false], ["go test ./parse", true]), { tests: { ok: false, runs: 1, failed: 1, label: "go test", stale: true } });
});

test("receipts: a test run whose result can't be told leaves no earlier pass standing", () => {
  const steps = [...stepsOf(checksIn("npm test"), true), ...stepsOf(checksIn("go test ./... 2>&1 | tail -2"), true, "    parse_test.go:5: bad parse\n")];
  assert.deepEqual(steps.at(-1), { kind: "test", label: "go test", ok: null, scope: "go test\t\t./..." });
  assert.equal(receipts(steps), undefined, "the last test run isn't known: no pass");
  // A failure before it stays (it's what was seen), and a later run is told as before.
  const t = (ok: boolean | null) => ({ kind: "test" as const, label: "npm test", ok });
  assert.deepEqual(receipts([t(false), t(null)]), { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  assert.deepEqual(receipts(["edit", t(true), t(null), t(true)]), { tests: { ok: true, runs: 2, failed: 0, label: "npm test", edited: true } });
  assert.deepEqual(receipts([{ kind: "build", label: "tsc", ok: true }, t(null)]), { build: { ok: true, runs: 1, failed: 0, label: "tsc" } }, "only its own kind");
});

test("receipts: a run's steps make its receipt: counts, the last result, files changed after it, and files changed before it", () => {
  const t = (ok: boolean) => ({ kind: "test" as const, label: "pnpm test", ok });
  assert.deepEqual(receipts([t(true), "edit", t(false), "edit", t(true)]), { tests: { ok: true, runs: 3, failed: 1, label: "pnpm test", edited: true } });
  assert.deepEqual(receipts([t(true), "edit"]), { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test", stale: true } });
  // A pass before the run changed anything (a flaky test passing on the first try) isn't `edited`; the next one after an edit is.
  assert.deepEqual(receipts([t(true)]), { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test" } });
  assert.deepEqual(receipts([t(true), "edit", t(true)]), { tests: { ok: true, runs: 2, failed: 0, label: "pnpm test", edited: true } });
  assert.deepEqual(receipts([{ kind: "build", label: "tsc", ok: false }, t(true)]), { build: { ok: false, runs: 1, failed: 1, label: "tsc" }, tests: { ok: true, runs: 1, failed: 0, label: "pnpm test" } });
  assert.equal(receipts(["edit"]), undefined);
  assert.equal(receipts([]), undefined);
});

test("receipts: a machine's own checks come from its policy, labelled in its own first two words", () => {
  const policy = parsePolicy(JSON.stringify({ brain: "wss://x.invalid/connector", checks: { "./scripts/ci.sh": "test", "just lint-all": "lint" } }));
  assert.deepEqual(policy.checks, { "./scripts/ci.sh": "test", "just lint-all": "lint" });
  assert.deepEqual(checkOf("./scripts/ci.sh --fast", policy.checks), { kind: "test", label: "ci.sh" }, "a script by its name, never its folder");
  assert.deepEqual(checkOf("just lint-all", policy.checks), { kind: "lint", label: "just lint-all" });
  assert.equal(checkOf("./scripts/ci.sh"), null, "not without the policy");
  assert.throws(() => parsePolicy(JSON.stringify({ brain: "wss://x.invalid/connector", checks: { "just ci": "deploy" } })), /checks."just ci" must be "test", "build" or "lint"/);
});

// The code review of 3.9 and 3.10: an own check whose name has a character a label can't carry was dropped whole as it
// left, so a run it matched (before the table) said no test ran.
test("receipts: an own check named with characters a label can't carry still leaves the machine with its pass or failure", () => {
  const own = parsePolicy(JSON.stringify({ brain: "wss://x.invalid/connector", checks: { "./scripts/test+lint.sh": "test", "pnpm test:e2e@ci": "test", "./测试": "build" } })).checks!;
  const sent = (line: string, ok: boolean) => reportOut({ text: "Done.", question: null, checks: receipts(stepsOf(checksIn(line, own), ok, "")) }).checks;
  assert.deepEqual(sent("./scripts/test+lint.sh", false), { tests: { ok: false, runs: 1, failed: 1, label: "test-lint.sh" } });
  assert.deepEqual(sent("pnpm test:e2e@ci", true), { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test:e2e-ci" } }, "run as written there: a whole run");
  assert.equal(sent("pnpm test:e2e@ci --shard 1", true), undefined, "with more: never a pass");
  assert.deepEqual(sent("./测试", false), { build: { ok: false, runs: 1, failed: 1, label: "own check" } });
  assert.throws(() => parsePolicy(JSON.stringify({ brain: "wss://x.invalid/connector", checks: ["just ci"] })), /checks must be an object/);
});

// Sol on 45ec9eccdf6f (F3): an own check's label was its first two words as written, so `pytest --token=canary123` sent
// "pytest --token-canary123" off the machine. A label is only a safe executable's name, and a second word only where it
// names what a runner runs (a script, a recipe, a subcommand), never an option, an assignment or a value; else "own
// check". The canaries are made up, shaped as credentials are, and go through the real policy parser, the checks, the
// report as it leaves (`reportOut`) and the outbound filter (`redactOutbound`).
test("receipts: an own check's label never carries an argument's value off the machine, credential-shaped or not", () => {
  const cases: [check: string, label: string][] = [
    ["pytest --token=canary123", "pytest"],
    ["pytest --key=ghp_CANARY12345678", "pytest"],
    ["pytest canary123", "pytest"],
    ["pytest -k CANARYSECRET", "pytest"],
    ["./scripts/ci.sh sk-CANARY1234567890", "ci.sh"],
    ["just ci --password=CANARYPASS", "just ci"],
    ["just ghp_CANARY12345678", "just"],
    ["npm run test -- --token=CANARY42", "npm run"],
    ["make test TOKEN=CANARY77", "make test"],
    ["./ghp_CANARY12345678/run.sh", "run.sh"],
    ["sk-CANARY1234567890 test", "own check"],
  ];
  for (const [check, label] of cases) {
    const policy = parsePolicy(JSON.stringify({ brain: "wss://brain.invalid/connector", checks: { [check]: "test" } }));
    const out = JSON.stringify(redactOutbound(reportOut({ text: "Done", question: null, checks: receipts(stepsOf(checksIn(check, policy.checks), false, "")) })));
    assert.doesNotMatch(out, /canary|token|password|=/i, check);
    assert.equal(JSON.parse(out).checks?.tests?.label, label, check);
  }
  // The outbound filter redacts a label too, whatever made it (defence in depth).
  assert.deepEqual(redactOutbound({ checks: { tests: { ok: true, runs: 1, failed: 0, label: "ghp_CANARY12345678" } } }), { checks: { tests: { ok: true, runs: 1, failed: 0, label: "[REDACTED]" } } });
});

test("receipts: a report leaves the machine with only kinds, results, counts and a short label", () => {
  const out = reportOut({
    text: "Done.", question: null,
    checks: { tests: { ok: false, runs: 2, failed: 1, label: "pnpm test --filter api src/billing.test.ts", stale: true, command: "pnpm test --filter api", output: "FAIL src/billing.test.ts" } as any, lint: { ok: "yes" } as any, extra: { ok: true } } as any,
  });
  assert.deepEqual(out.checks, { tests: { ok: false, runs: 2, failed: 1, label: "pnpm test", stale: true } });
  assert.doesNotMatch(JSON.stringify(out), /billing|FAIL|--filter|command|output/);
  assert.deepEqual(reportOut({ text: "Done.", question: null, checks: { tests: { ok: true, runs: 1, failed: 0, label: "/home/me/app/run tests" } } }), { text: "Done.", question: null }, "a label that isn't one of ours isn't sent");
  assert.deepEqual(reportOut({ text: "Done.", question: null }), { text: "Done.", question: null }, "none, none sent");
  // A running run's checks so far leave the same way.
  assert.deepEqual(reportOut({ text: "", question: null, running: { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test", edited: true, output: "SECRET" } as any } }),
    { text: "", question: null, running: { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test", edited: true } } });
  // Its run's id (F6) only with it, and only as a short string.
  const running = { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test" } };
  assert.equal(reportOut({ text: "", question: null, running, runningId: "turn-2" }).runningId, "turn-2");
  assert.equal(reportOut({ text: "", question: null, runningId: "turn-2" }).runningId, undefined);
  assert.equal(reportOut({ text: "", question: null, running, runningId: 7 as any }).runningId, undefined);
});

// The review's finding on 3.10: a run whose checks couldn't be read says so (`checksUnread`), only with no checks, only
// as true, so the brain never takes it for "no test ran".
test("receipts: a report whose checks couldn't be read says so, and only that", () => {
  assert.deepEqual(reportOut({ text: "Done.", question: null, checksUnread: true }), { text: "Done.", question: null, checksUnread: true });
  assert.deepEqual(reportOut({ text: "Done.", question: null, checksUnread: "yes" } as any), { text: "Done.", question: null });
  assert.deepEqual(reportOut({ text: "Done.", question: null, checksUnread: true, checks: { tests: { ok: true, runs: 1, failed: 0, label: "npm test" } } }),
    { text: "Done.", question: null, checks: { tests: { ok: true, runs: 1, failed: 0, label: "npm test" } } }, "with checks read, they are what's said");
});
