// Tests passed or failed (docs/launch/engine.md §11 stage 3.10; spike/run-receipts): which of a run's shell commands
// were checks (its tests, a build, a lint) and how they exited, so 10 & 2 can say what the agent actually ran, not only
// what it says. Pure. A command is matched against a fixed table (and the machine's own `checks` in its policy file);
// what leaves the machine is the kind, pass or fail, counts, and a label from the table (at most two words), never the
// command or its output.
//
// One rule for a pass (engine.md, "One rule for a pass"): "the tests pass" comes only from a standard run of a whole
// suite, matched as a whole against a short list (`FULL`: `npm test`, `npx vitest run`, `pytest`, `go test ./...`,
// `cargo test`, `make test` and a few more, with only output options), after any `cd <dir> &&`, with its output
// redirected or through tee only where the line keeps the runner's own exit; its own exit 0, nothing in its output
// failing or saying no test ran, and every whole run its thread made, in any folder, passing with no file changed since
// (`receipts`, across the thread's runs: `Tested`). Everything else is unknown, never a pass. A failure is believed from
// any evidence. A build's or a lint's pass (neither is ever "the tests pass") is read as before: one of its kind in a line
// of commands joined by `&&`, with nothing that narrows it or hides a failure (`ignores`, `narrowingEnv`). It reads
// commands and their output, never the tests: an agent that skips, deletes or rewrites tests can still pass.
import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Checks, CheckRun } from "./contract.ts";
import { redactText } from "./redact.ts";

export type CheckKind = "test" | "build" | "lint";
/** The machine's own checks (policy `checks`): a command's start, as typed, and what kind of check it is. */
export type OwnChecks = Readonly<Record<string, CheckKind>>;

type Entry = { re: RegExp; kind: CheckKind | ((m: RegExpExecArray) => CheckKind); label: (m: RegExpExecArray) => string; suite?: (m: RegExpExecArray) => string };
/**
 * The fixed table: a command's start (after `cd`, env assignments, `npx` and such) and what it is. The label is the
 * table's, so nothing from the command itself (a path, a test name) leaves the machine. `suite`, kept on the machine,
 * is what ran it when that's more than the label (`npm run test:unit` is `npm test:unit`); a `flags` group is options
 * before the script or target, which narrow it as options after it do.
 */
const TABLE: Entry[] = [
  // npm test, pnpm run check, yarn lint, bun run typecheck, npm run test:unit
  { re: /^(npm|pnpm|yarn|bun)(?<flags>(?: (?:--filter|-F|-C|--dir|--prefix|--workspace|-w|--cwd) \S+| -{1,2}[\w-]+(?:=\S+)?)*)(?<run> run(?:-script)?)? (test|t|check|build|lint|typecheck|type-check|tsc)(?<suffix>:[\w:-]+)?(?=\s|$)/, kind: (m) => scriptKind(m[4]), label: (m) => `${m[1]} ${m[4] === "t" ? "test" : m[4]}`, suite: (m) => `${m[1]}${m[1] === "bun" && m.groups?.run ? " run" : ""} ${m[4] === "t" ? "test" : m[4]}${m.groups?.suffix ?? ""}` },
  { re: /^(vitest|jest|mocha|ava|playwright test|deno test)(?=\s|$)/, kind: "test", label: (m) => m[1] },
  { re: /^node(?: [\w=-]+)* --test(?=\s|$)/, kind: "test", label: () => "node --test" },
  { re: /^(?:python3? -m )?(pytest|py\.test|unittest|tox|nox)(?=\s|$)/, kind: "test", label: (m) => (m[1] === "py.test" ? "pytest" : m[1]) },
  { re: /^cargo (test|nextest|build|check|clippy)(?=\s|$)/, kind: (m) => (m[1] === "clippy" ? "lint" : m[1] === "build" || m[1] === "check" ? "build" : "test"), label: (m) => `cargo ${m[1]}` },
  { re: /^go (test|build|vet)(?=\s|$)/, kind: (m) => (m[1] === "vet" ? "lint" : m[1] === "build" ? "build" : "test"), label: (m) => `go ${m[1]}` },
  { re: /^swift (test|build)(?=\s|$)/, kind: (m) => (m[1] === "build" ? "build" : "test"), label: (m) => `swift ${m[1]}` },
  { re: /^xcodebuild(?=\s|$)(?=.*\s(test|build|build-for-testing|test-without-building)(?:\s|$))/, kind: (m) => (m[1].startsWith("test") ? "test" : "build"), label: () => "xcodebuild" },
  // make test, make -i test, just check, make -C api test
  { re: /^(make|just)(?<flags>(?: (?:-[CfIjlo]|--directory|--file|--makefile|--include-dir|--jobs) \S+| -{1,2}[\w-]+(?:=\S+)?)*) (test|tests|check|build|lint)(?=\s|$)/, kind: (m) => scriptKind(m[3]), label: (m) => `${m[1]} ${m[3]}` },
  // ./gradlew test, mvn -q test, ./gradlew -p api test, mvn -pl api test
  { re: /^(?:\.\/)?(gradlew|gradle|mvn)(?<flags>(?: (?:-p|--project-dir|-b|--build-file|-c|--settings-file|-f|--file|-pl|--projects|-rf|--resume-from|-D|-P|-x|--exclude-task) \S+| -{1,2}[\w.-]+(?:=\S+)?)*) (test|check|build)(?=\s|$)/, kind: (m) => scriptKind(m[3]), label: (m) => `${m[1]} ${m[3]}` },
  { re: /^(tsc|vue-tsc)(?=\s|$)/, kind: "build", label: (m) => m[1] },
  { re: /^(eslint|ruff check|biome (?:check|lint|ci)|oxlint|swiftlint|golangci-lint run|mypy|pyright|shellcheck|prettier --check)(?=\s|$)/, kind: (m) => (m[1] === "mypy" || m[1] === "pyright" ? "build" : "lint"), label: (m) => m[1].split(" ")[0] },
];

function scriptKind(s: string): CheckKind {
  if (s === "build" || s === "typecheck" || s === "type-check" || s === "tsc") return "build";
  return s === "lint" ? "lint" : "test";
}

const REPORTER = String.raw`--reporters?(?:=| )(?!-)[\w.,-]+|--test-reporter=(?!-)[\w.-]+`;
const DURATION = String.raw`(?:\d+(?:\.\d+)?(?:ns|us|ms|s|m|h))+|0`;
const GO_OPT = String.raw`-v|-race|-count(?:=| )1|-timeout(?:=| )(?:${DURATION})`;
/**
 * The whole test runs (engine.md, "One rule for a pass"): a test run's pass is told only of one of these, its words
 * matched as a whole, with no option but the output options listed for it. Each is a run of its folder's whole suite.
 */
const FULL: { re: RegExp; label: (m: RegExpExecArray) => string }[] = [
  { re: new RegExp(String.raw`^(npm|pnpm|yarn) test(?: --(?: (?:${REPORTER}|--verbose|--silent|--colou?rs?|--no-colou?rs?))*)?$`), label: (m) => `${m[1]} test` },
  { re: new RegExp(String.raw`^npx vitest run(?: (?:${REPORTER}|--silent|--no-color))*$`), label: () => "vitest" },
  { re: /^npx jest(?: (?:--reporters=(?!-)[\w.,-]+|--silent|--verbose|--colors))*$/, label: () => "jest" },
  { re: /^npx mocha(?: (?:(?:--reporter|-R)(?:=| )(?!-)[\w.-]+|--colors?|--no-colors?))*$/, label: () => "mocha" },
  { re: /^(?:pytest|python3? -m pytest|uv run pytest|poetry run pytest)(?: (?:-q+|-v+|-r[fEsxXpPaAwN]+|--tb(?:=| )(?:auto|long|short|line|native|no)|--color(?:=| )(?:yes|no|auto)|-p no:cacheprovider))*$/, label: () => "pytest" },
  { re: new RegExp(String.raw`^go test(?: (?:${GO_OPT}))* \./\.\.\.(?: (?:${GO_OPT}))*$`), label: () => "go test" },
  { re: /^cargo test(?: (?:--workspace|--all|--all-features|-q|--quiet|--color(?:=| )(?:auto|always|never)))*$/, label: () => "cargo test" },
  { re: /^(make test|bun test|deno test)$/, label: (m) => m[1] },
];
/** The runners `FULL` names, by label: a failure of one of them in a folder is settled by a whole run of it there. */
const WHOLE_RUNNERS = new Set(["npm test", "pnpm test", "yarn test", "vitest", "jest", "mocha", "pytest", "go test", "cargo test", "make test", "bun test", "deno test"]);

/** What runs a command without changing what it is: `npx`, `pnpm exec`, `uv run`, `time`, `timeout 600`. */
const WRAPPER = String.raw`(?:env|time|nice|command|exec)\s+|timeout\s+(?:-\S+\s+)*\d+[smh]?\s+|(?:npx|bunx|pnpx)(?:\s+-y|\s+--yes)?\s+|(?:pnpm|yarn|npm)\s+exec\s+(?:--\s+)?|(?:uv|poetry|pipenv|hatch)\s+run\s+|nix\s+develop\s+(?:\S+\s+)?-c\s+|devenv\s+shell\s+`;
/** An env var set for a command: `FOO=1`, `FOO="-k 'not slow'"`. */
const ASSIGN = String.raw`[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s"'\\]|\\.)*)`;
/** What a command starts with that isn't what it is: its env vars and wrappers (`CI=1 timeout 600 npx`). */
const PREFIX = new RegExp(String.raw`^(?:${ASSIGN}\s+|${WRAPPER})+`);
/** A shell running the command as a string, as Codex gives it: `bash -lc 'npm test'`; which shell (its string: `word`). */
const SHELL = /^(?:\S*\/)?((?:ba|z)?sh)\s+-l?c\s+/;
/** A loop or a condition: a check inside one is never a pass (its exit isn't the line's, and a loop runs it again). */
const KEYWORD = /^(?:for|while|until|select|if|elif|then|else|do|done|fi|case|esac|function)(?=\s|;|$)|^[{}](?=\s|$)/;
const LOOP = /^(?:for|while|until|select)(?=\s)/;
/** `set +e` (or `set +o errexit`): a failure no longer stops what follows. */
const ERREXIT_OFF = /^set\s+(?:-\w+\s+)*(?:\+\w*e|\+o\s+errexit)/;
const TEE = /^tee(?=\s|$)/;
/** The line's exit made the runner's again after `| tee`, by shell: bash's `PIPESTATUS[0]`, zsh's `pipestatus[1]`. */
const PIPESTATUS: Record<string, RegExp> = { bash: /^exit\s+"?(?:\$\{PIPESTATUS\[0\]\}|\$PIPESTATUS)"?$/, zsh: /^exit\s+"?(?:\$pipestatus\[1\]|\$\{pipestatus\[1\]\})"?$/ };

/**
 * One shell word from `i`, its quotes and backslashes taken off (`'it'\''s'` is `it's`), and where it ends; null when a
 * quote isn't closed.
 */
function word(s: string, i: number): { value: string; end: number } | null {
  let value = "", quote: string | null = null;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") { if (ch === "'") quote = null; else value += ch; continue; }
    if (ch === "\\") { if (quote && !'$`"\\\n'.includes(s[i + 1] ?? "")) value += ch; value += s[++i] ?? ""; continue; }
    if (quote) { if (ch === quote) quote = null; else value += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) break;
    value += ch;
  }
  return quote ? null : { value, end: i };
}

/** A line run by `bash -lc '…'` (or zsh, sh): the shell and the line it runs; null for any other line. */
function wrapped(line: string): { shell: string; inner: string } | null {
  const m = SHELL.exec(line);
  const w = m && word(line, m[0].length);
  return w && !line.slice(w.end).trim() ? { shell: m![1], inner: w.value } : null;
}

/**
 * The commands in a command line, with the operator that follows each: `&&`, `||`, `;` (or a new line), `|`, or none;
 * `open` when a quote is left open (a line a shell refuses, or one this misreads: a heredoc's apostrophe), or the line
 * quotes the way this doesn't read (`$'…'`, where `\'` is a quote, and `$"…"`).
 */
function segments(line: string): { segs: { cmd: string; then: string }[]; open: boolean } {
  const out: { cmd: string; then: string }[] = [];
  let cur = "", quote: string | null = null, odd = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    // A backslash outside single quotes escapes what follows: `\'` and `\"` aren't quotes, `\;` and `\|` aren't operators.
    if (ch === "\\" && quote !== "'") { cur += ch + (line[i + 1] ?? ""); i++; continue; }
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === "$" && (line[i + 1] === "'" || line[i + 1] === '"')) odd = true;
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    // A comment runs to the end of its line: nothing in it runs (`npm test # it's done` has no quote).
    if (ch === "#" && (!cur || /\s$/.test(cur))) { while (i + 1 < line.length && line[i + 1] !== "\n") i++; continue; }
    const two = line.slice(i, i + 2);
    // `2>&1`, `&>` and `>&` are redirections, not a background `&`; `|&` pipes.
    const redirect = ch === "&" && (line[i - 1] === ">" || line[i + 1] === ">");
    const op = two === "&&" || two === "||" ? two : two === "|&" ? "|&" : ch === ";" || ch === "\n" ? ";" : ch === "|" ? "|" : ch === "&" && !redirect ? "&" : null;
    if (!op) { cur += ch; continue; }
    out.push({ cmd: cur.trim(), then: op });
    cur = "";
    if (op.length === 2) i++;
  }
  out.push({ cmd: cur.trim(), then: "" });
  const segs = out.filter((s) => s.cmd || s.then);
  // A `;` that ends the line separates nothing.
  if (segs.at(-1)?.then === ";") segs.at(-1)!.then = "";
  return { segs, open: quote !== null || odd };
}

/** A command's shell words, as written; null when a quote isn't closed. */
function words(cmd: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; ; ) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) return out;
    const w = word(cmd, i);
    if (!w) return null;
    out.push(cmd.slice(i, w.end));
    i = w.end;
  }
}

/** A segment as written, without the grouping or negation in front of it, for its first word. */
const lead = (cmd: string) => cmd.replace(/^[\s({!]+/, "");

/**
 * One command, as the table reads it: without its prefixes, its grouping (a subshell's parentheses, braces) or the
 * keyword it follows in a loop or condition (`do npm test`), and with plain spacing. A `!` stays: `! npm test` isn't one.
 */
function bare(cmd: string): string {
  let c = cmd.replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== c; ) {
    prev = c;
    c = c.replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "").replace(/^(?:do|then|else|if|elif|while|until)\s+/, "").replace(PREFIX, "");
  }
  return c;
}

/** Runners whose second word names what they run (a script, a recipe, a target, a subcommand), never a value. */
const SUBCOMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "deno", "just", "make", "cargo", "go", "uv", "poetry", "pipenv", "hatch", "nox", "tox",
  "mix", "rake", "bundle", "gradle", "gradlew", "mvn", "task", "nx", "turbo", "dotnet", "swift", "flutter", "dart", "composer"]);
/** A name a label may carry: plain, not an option, an assignment, a path or a credential's shape (`redactText`). */
const NAME = /^[A-Za-z0-9_][\w.:@+-]{0,31}$/;
const nameOf = (w: string | undefined) => (w && NAME.test(w) && redactText(w) === w ? w.replace(/[@+]+/g, "-") : null);
/**
 * An own check's label (the review of 45ec9eccdf6f, F3: it was its first two words, so `pytest --token=canary123` sent the
 * value): its executable's name, a script by its file name ("./scripts/ci.sh" is "ci.sh", never its folder), and a
 * second word only after a runner whose second word names what it runs (`SUBCOMMANDS`: "just ci", "pnpm test:e2e@ci"),
 * never an option, an assignment, a path or a value; a character a label can't carry (`cleanChecks`) made "-", so "pnpm
 * test:e2e@ci" is still sent, as "pnpm test:e2e-ci" (the code review of 3.9 and 3.10). "own check" when its executable
 * isn't a plain name.
 */
function ownLabel(s: string): string {
  const [first, second] = s.split(" ");
  const exe = nameOf(first.split("/").pop());
  if (!exe) return "own check";
  const sub = SUBCOMMANDS.has(exe) ? nameOf(second) : null;
  return sub ? `${exe} ${sub}` : exe;
}

/**
 * A check as matched: its kind and label, what ran it (`suite`), the options and arguments it ran with (`rest`), and
 * whether it's one of the policy's own checks (`own`).
 */
type Matched = { kind: CheckKind; label: string; suite: string; rest: string; own?: true };

/** What one bare command is, from the policy's own checks first, then the table; null when it isn't a check. */
function matched(c: string, own: OwnChecks): Matched | null {
  if (!c) return null;
  for (const [start, kind] of Object.entries(own)) {
    const s = start.replace(/\s+/g, " ").trim();
    if (s && (c === s || c.startsWith(`${s} `))) return { kind, label: ownLabel(s), suite: s, rest: c.slice(s.length), own: true };
  }
  for (const t of TABLE) {
    const m = t.re.exec(c);
    if (!m) continue;
    const label = t.label(m);
    return { kind: typeof t.kind === "function" ? t.kind(m) : t.kind, label, suite: t.suite?.(m) ?? label, rest: `${m.groups?.flags ?? ""} ${c.slice(m[0].length)}` };
  }
  return null;
}

/** What one command is, from the policy's own checks first, then the table; null when it isn't a check. */
export function checkOf(command: string, own: OwnChecks = {}): { kind: CheckKind; label: string } | null {
  const m = matched(bare(command), own);
  return m && { kind: m.kind, label: m.label };
}

/**
 * Options that let a check exit 0 with tests failing or none run, in every form (`--flag`, `--flag=value`, `--flag
 * value`): ignoring failures (`make -i`, Maven's `-Dmaven.test.failure.ignore=true`, `-fn`, jest's
 * `--testFailureExitCode=0`, vitest's `--dangerouslyIgnoreUnhandledErrors`, `ruff --exit-zero`), passing what it would
 * fail (updating snapshots: `-u`), running nothing (`--if-present` with no script, `--passWithNoTests=true`,
 * `--collect-only`, `--listTests`, `cargo test --no-run`, `go test -c`, `-n` or `-exec`, a dry run, skipped tests), or
 * only what changed (`--onlyChanged`, `-o`, `--changed`, `--related`). A check run with one is never a pass.
 */
const NEVER = new RegExp(String.raw`(?:^|\s)(?:${[
  "--if-present", "--ignore-scripts", "--pass-?with-?no-?tests", "--passWithNoTests", "--permit-no-files", "--no-tests",
  "--testFailureExitCode", "--test-failure-exit-code", "--dangerouslyIgnoreUnhandledErrors", "--pass-on-failing-test-suite",
  "--skip-missing-interpreters", "--no-error-on-unmatched-pattern", "--ignore-snapshots", "--exit-zero", "--fail-never", "-fn",
  "--collect-only", "--co", "--setup-only", "--setup-plan", "--list", "--list-tests", "--listTests", "--no-run", "--notest",
  "--dry-run", "-dry-run", "--help", "-h", "--version", "--show-?config", "--showConfig", "--suppress-no-test-exit-code",
  "--only-?changed", "--onlyChanged", "--changed(?:Since|FilesWithAncestor)?", "--lastCommit", "--findRelatedTests", "--related",
  "-u", "--update", "--updateSnapshot", "--update-?snapshots?", "--snapshot-update",
].join("|")})(?:=\S*)?(?=\s|$)`);
/** Maven's switches that ignore failures or skip the tests, `-Dname` or `-D name`, unless set to false. */
const MAVEN_NEVER = /(?:^|\s)(?:-D\s*|--define[=\s])(?:maven\.test\.failure\.ignore|testFailureIgnore|skipTests|skipITs|maven\.test\.skip(?:\.exec)?|surefire\.skip)(?:=(?!false(?:\s|$))\S*)?(?=\s|$)/;
function ignores(c: string, suite: string): boolean {
  if (NEVER.test(c) || MAVEN_NEVER.test(c)) return true;
  // make's -i (ignore errors), -n (dry run), -q (question), -t (touch), alone or among other single letters.
  if (/^(?:make|just)\b/.test(suite)) return /(?:^|\s)(?:-[A-Za-z]*[intq][A-Za-z]*|--(?:ignore-errors|just-print|recon|question|touch))(?=\s|$)/.test(c);
  if (/^(?:gradlew|gradle) /.test(suite)) return /(?:^|\s)(?:-x|--exclude-task)(?:\s+|=)\S*test\b|(?:^|\s)-m(?=\s|$)/i.test(c);
  if (suite === "go test") return /(?:^|\s)-(?:c|list|n|exec)(?=[\s=]|$)|(?:^|\s)-run[= ]['"]?\^\$/.test(c);
  // jest's -o (only what changed), also through a package script.
  if (suite === "jest" || /^(?:npm|pnpm|yarn|bun) /.test(suite)) return /(?:^|\s)-o(?=\s|$)/.test(c);
  return false;
}

/** Options that change only how a run reports or how fast it goes, not which tests it runs: in an env var's value. */
const HARMLESS = new Set(["--", "-q", "--quiet", "-s", "--silent", "-v", "-vv", "-vvv", "--verbose", "--ci", "--color", "--colors", "--no-color",
  "--no-colors", "--colour", "--run", "--runInBand", "-i", "--no-coverage", "--coverage", "-race", "-cover", "--release", "--no-fail-fast",
  "--fail-fast", "-failfast", "--bail", "-x", "--exitfirst", "--no-watch", "--forceExit", "--detectOpenHandles", "--no-cache",
  "--enable-source-maps", "--experimental-vm-modules", "--no-warnings", "--no-deprecation", "--trace-warnings"]);
const HARMLESS_VALUE = /^--?(?:reporters?|test-reporter(?:-destination)?|tb|colou?r|max-?workers|maxWorkers|workers|timeout|testTimeout|count|jobs|durations|bail|max-old-space-size)=\S*$|^-j\d+$/;
/** A redirection: `2>&1`, `> out.log`, `2>/dev/null`, `&>log`, `< in`. */
const REDIRECT = /^(?:\d*>>?|&>>?|\d*<)/;

/**
 * Env vars that narrow a run or let it pass with a test failing (`PYTEST_ADDOPTS`, `GOFLAGS`, `npm_config_if_present`,
 * `MAKEFLAGS`, …), by name; any other whose value carries an option that isn't harmless (`NODE_OPTIONS=--test-only`) is
 * read the same. A check run with one set in its line is never a pass.
 */
const NARROWING_ENV = /^(?:PYTEST_\w*|GOFLAGS|(?:npm|pnpm)_config_\w+|YARN_\w+|JEST_\w*|VITEST_\w*|CARGO_\w*|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|TOX_\w*)=/i;
function narrowingEnv(assignment: string): boolean {
  if (NARROWING_ENV.test(assignment)) return true;
  const value = assignment.slice(assignment.indexOf("=") + 1).replace(/^(["'])([\s\S]*)\1$/, "$2");
  return value.split(/\s+/).some((w) => /^['"]?-/.test(w) && !HARMLESS.has(w) && !HARMLESS_VALUE.test(w));
}
const SETS = new RegExp(String.raw`^(${ASSIGN})(?:\s+|$)`);
const ONE_WRAPPER = new RegExp(`^(?:${WRAPPER})`);
const EXPORT = /^(?:export|declare|typeset|readonly|local)(?:\s+-\w+)*\s+/;
const ONLY_SETS = new RegExp(String.raw`^(?:${ASSIGN}\s*)+$`);
/** The env vars a command sets for what it runs: `FOO=1 npm test`, `env FOO=1 …`, `export FOO=1`. */
function assignments(cmd: string): string[] {
  let c = cmd.replace(/\s+/g, " ").trim().replace(/^[({]\s*/, "").replace(/^(?:do|then|else|if|elif|while|until)\s+/, "").replace(EXPORT, "");
  const out: string[] = [];
  for (let m: RegExpExecArray | null; (m = SETS.exec(c) ?? ONE_WRAPPER.exec(c)); c = c.slice(m[0].length)) if (m[1]) out.push(m[1]);
  return out;
}
/**
 * The env vars check `i` of a line runs with, as far as the line shows: its own (`PYTEST_ADDOPTS=… pytest`, and `NAME=…`
 * among its arguments, as make takes them), and those an earlier command in it exports (`export GOFLAGS=… && go test`).
 */
function envOf(segs: { cmd: string }[], i: number): string[] {
  const before = segs.slice(0, i).filter((s) => EXPORT.test(lead(s.cmd)) || ONLY_SETS.test(lead(s.cmd)));
  const args = bare(segs[i].cmd).split(" ").filter((w) => /^[A-Za-z_]\w*=/.test(w));
  return [...before.flatMap((s) => assignments(s.cmd)), ...assignments(segs[i].cmd), ...args];
}

/**
 * Options that pick where a run runs, by runner: its folder (`folder`: `npm --prefix api`, `make -C api`, `go test -C
 * api`, read as a `cd`), or its package, workspace, project or device (`valued`, with a value: `cargo test -p api`,
 * `pnpm --filter api`, `npm -w api`, `-papi`, `--package=api`; `flags`, without: `--workspaces`). The second kind are
 * part of what ran it (`scopeOf`'s suite), so a whole run of its runner never settles its failure.
 */
const WHERE: { re: RegExp; folder: string[]; valued: string[]; flags: string[] }[] = [
  { re: /^(?:npm|pnpm|yarn|bun) /, folder: ["--prefix", "-C", "--dir", "--cwd"], valued: ["-w", "--workspace", "--filter", "-F", "--filter-prod"],
    flags: ["--workspaces", "-ws", "--ws", "-r", "--recursive", "--include-workspace-root", "--workspace-root", "-W", "-g", "--global"] },
  { re: /^make /, folder: ["-C", "--directory"], valued: ["-f", "--file", "--makefile", "-I", "--include-dir"], flags: [] },
  { re: /^just /, folder: ["-d", "--working-directory"], valued: ["-f", "--justfile"], flags: [] },
  { re: /^cargo /, folder: [], valued: ["-p", "--package", "--manifest-path", "--exclude", "--target"], flags: ["--workspace", "--all"] },
  { re: /^go /, folder: ["-C"], valued: ["-modfile"], flags: [] },
  { re: /^(?:gradlew|gradle) /, folder: ["-p", "--project-dir"], valued: ["-b", "--build-file", "-c", "--settings-file", "--include-build"], flags: [] },
  { re: /^mvn /, folder: [], valued: ["-f", "--file", "-pl", "--projects", "-rf", "--resume-from"], flags: ["-am", "--also-make", "-amd", "--also-make-dependents"] },
  { re: /^(?:pytest|tox|nox)$/, folder: [], valued: ["--rootdir", "-c", "--config-file", "--confcutdir", "--root"], flags: [] },
  { re: /^(?:jest|vitest|mocha|playwright test|deno test)$/, folder: [], valued: ["--rootDir", "--root", "--dir", "--config", "-c", "--project", "--selectProjects", "--workspace"], flags: [] },
  { re: /^swift /, folder: [], valued: ["--package-path"], flags: [] },
  { re: /^xcodebuild$/, folder: [], valued: ["-project", "-workspace", "-scheme", "-destination", "-testPlan", "-configuration"], flags: [] },
];

/**
 * Where a check ran and what it ran, never sent: `suite\tdir\targs`. `suite` is what ran it with the options that pick
 * its package (`WHERE`); `dir` the folder the line's `cd`s (and a folder option) moved to (`folderOf`; `stepsOf` puts it
 * under the folder the work system ran it in); `args` the rest of its words as written, but redirections. Undefined
 * for the label's own runner with nothing else, from where the line started.
 */
function scopeOf(m: Matched, at: string): string | undefined {
  const where: string[] = [], words: string[] = [];
  let dir = at;
  const opts = WHERE.find((w) => w.re.test(m.suite));
  const all = m.rest.trim().split(" ").filter(Boolean);
  const option = (list: string[] | undefined, w: string) => list?.find((o) => w === o || w.startsWith(`${o}=`) || (/^-\w$/.test(o) && w.startsWith(o) && !opts!.flags.includes(w)));
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    if (REDIRECT.test(w)) { if (/^(?:\d*>>?|&>>?|\d*<)$/.test(w)) i++; continue; }
    if (opts?.flags.includes(w)) { where.push(w); continue; }
    const f = option(opts?.folder, w);
    if (f) { dir = moved(dir, w === f ? all[++i] : w.slice(w.startsWith(`${f}=`) ? f.length + 1 : f.length)); continue; }
    const o = option(opts?.valued, w);
    if (o) { where.push(w === o ? `${w} ${all[++i] ?? ""}` : w); continue; }
    words.push(w);
  }
  const suite = [m.suite, ...where.sort()].join(" ");
  const args = words.join(" ");
  return suite === m.label && !dir && !args ? undefined : `${suite}\t${dir}\t${args}`;
}

/** Where `cd target` moves from `dir`: "~" for home, "?" for a folder that can't be read (`$d`, `-`, a command's output). */
function moved(dir: string, target: string | undefined): string {
  const to = target === undefined ? "~" : word(target, 0)?.value;
  if (dir === "?" || to === undefined || to === "-" || /[$`*?]/.test(to)) return "?";
  const out = /^[/~]/.test(to) ? posix.normalize(to) : posix.join(dir || ".", to);
  return out === "." ? "" : out.replace(/\/$/, "");
}

/**
 * The folder line command `i` runs in, relative to where the line started, from the `cd`s (and `pushd`s) before it: a
 * subshell's (`(cd api) && npm test`) only while it lasts. "?" when one can't be read.
 */
function folderOf(segs: { cmd: string }[], i: number): string {
  const frames: string[] = [];
  let dir = "";
  for (let n = 0; n < i; n++) {
    const raw = segs[n].cmd;
    for (let k = /^\(*/.exec(raw)![0].length; k > 0; k--) frames.push(dir);
    const c = bare(raw);
    const cd = /^(?:cd|pushd)(?:\s+-[LPe@]+)*(?:\s+(.+))?$/.exec(c);
    if (cd) dir = moved(dir, cd[1]);
    else if (/^popd(?=\s|$)/.test(c)) dir = "?";
    for (let k = /\)*$/.exec(raw)![0].length; k > 0 && frames.length; k--) dir = frames.pop()!;
  }
  return dir;
}

/**
 * The checks a command line runs, as `checksIn` finds them, kept instead of the line. Each check's `told`: a pass of it
 * can be told at all (a test run: a whole run, `whole`; a build or a lint: one of its kind in a line of commands joined
 * by `&&`, with no option or env var that narrows it or hides a failure); `whole`: a test run in `FULL`, run as a whole
 * line (`checksIn`), or a build or lint told with nothing but its runner; `plain`: a test run that isn't whole, in a
 * whole run's line, so its exit 0 is its own (`stepsOf`'s `again`); and its `scope` (`scopeOf`). `exit`: one check,
 * whose own exit is the line's (its last command, or into tee with the line keeping its exit), so a non-zero exit is
 * its failure. `cleanPasses`: the line exiting 0 means each check exited 0 (nothing but `&&` after each), though a
 * failure may be another command's (`npm run build && git commit -am wip`, where the commit may be what failed).
 * `several`: several runs (a loop, more than one check of a kind, a run over several workspaces), so any runner's
 * failure in the output is one of theirs. `gated`: a command before the check could have stopped it (`&&`, `||`: `cd
 * no-such && npm test` exits 1 from the cd, and npm never starts; the review of 45ec9eccdf6f, F4), so the line's failing
 * exit is the check's only as its output tells (`gateFailed`). `banner`, with `gated`: the script npm or pnpm runs as
 * the check, whose start it always prints (`> web@1.0.0 build`), so without that it never started.
 */
export type Ran = { found: { kind: CheckKind; label: string; told: boolean; whole?: true; plain?: true; scope?: string }[]; exit: boolean; cleanPasses: boolean; several?: true; gated?: true; banner?: string };

/** An npm, pnpm, yarn or bun run over several workspaces (before any `--`, which passes the rest to the script). */
function severalWorkspaces(cmd: string): boolean {
  const c = bare(cmd).split(" -- ")[0];
  if (!/^(?:npm|pnpm|yarn|bun) /.test(c)) return false;
  return /\s(?:--workspaces|-ws|--ws|-r|--recursive)(?=\s|=|$)/.test(c) || (c.match(/\s(?:-w|--workspace)(?:=|\s)\S+/g)?.length ?? 0) > 1;
}

/**
 * Whether `set` turns pipefail on (`set -o pipefail`, `set -euo pipefail`) or off (`set +o pipefail`); else undefined.
 * Only `set` itself, as written: `env set -o pipefail` runs no `set` at all.
 */
function pipefail(cmd: string): boolean | undefined {
  const w = cmd.replace(/\s+/g, " ").trim().split(" ");
  if (w[0] !== "set") return undefined;
  let on: boolean | undefined;
  w.forEach((x, i) => { if (w[i + 1] === "pipefail" && /^[-+][a-z]*o$/.test(x)) on = x[0] === "-"; });
  return on;
}
/** A command in a subshell or group, or closing one: a line with one keeps its runner's exit through tee only plainly. */
const grouped = (s: { cmd: string }) => /^[({!]|[)}]$/.test(s.cmd);

/** A word a whole run's line may have unquoted: a folder, an option, a value or a file name, nothing the shell expands. */
const PLAIN = /^[\w./:=@%+,-]+$/;
const REDIRECTION = /^(?:\d?>&\d|&>>?|\d?>>?|\d?<)/;
/**
 * A command's words as a whole run's line has them, its redirections and their files left out; null when any word
 * isn't plain (quoted, escaped, `$`, a glob, a brace, a bracket, a tilde).
 */
function plainWords(cmd: string): string[] | null {
  const ws = words(cmd);
  if (!ws) return null;
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], r = REDIRECTION.exec(w);
    if (!r) { if (!PLAIN.test(w)) return null; out.push(w); continue; }
    if (/&\d$/.test(r[0]) && w === r[0]) continue;
    const file = w.slice(r[0].length) || ws[++i];
    if (!file || !PLAIN.test(file)) return null;
  }
  return out;
}
/** A whole run's line before its run: `cd <folder> &&`, and `set -o pipefail` (with `&&` or `;`). */
function before(s: { cmd: string; then: string }): boolean {
  const w = plainWords(s.cmd);
  if (!w) return false;
  return (s.then === "&&" && w.length === 2 && w[0] === "cd" && !w[1].startsWith("-")) || ((s.then === "&&" || s.then === ";") && pipefail(s.cmd) === true);
}
/** A test run of `FULL` (or the policy's own test check, as written there), by its plain words. */
const whole = (w: string[], h: Matched) => h.kind === "test" && (h.own ? w.join(" ") === h.suite : FULL.some((f) => f.re.test(w.join(" "))));

/**
 * The checks a shell command line runs, and what its exit and output can tell of them (engine.md, "One rule for a
 * pass"). A test run's pass can be told only of a whole run (`whole`, `FULL`) in a line of this shape: only `cd
 * <folder> &&` before it (and `set -o pipefail`), every word plain (no env var, quote, `$` or glob), its output
 * redirected or into tee only where the line keeps the runner's own exit (`set -o pipefail` before it, tee ending the
 * line; or `; exit ${PIPESTATUS[0]}` after it in a line bash runs, `$pipestatus[1]` in zsh). A build's or a lint's
 * can be told of commands joined by `&&` (`cd api && npm run build && npm test`, `set -o pipefail; …`), one check of
 * its kind, no loop or condition, no option or env var that narrows it or hides a failure (`ignores`,
 * `narrowingEnv`). Anything else (`;`, `||`, `set +e`, a pipe into `tail` or into tee without the runner's exit, a
 * loop, two test runs) can show a failure but never a pass. Null when it runs no check, or runs one in the background
 * (`npm test &`), which hasn't finished when the line has.
 */
export function checksIn(line: string, own: OwnChecks = {}): Ran | null {
  const joined = line.replace(/\\\n/g, " ");
  const sh = wrapped(joined.trim());
  const { segs, open } = segments(sh ? sh.inner : joined);
  const at: number[] = [], hits: Matched[] = [];
  segs.forEach((s, i) => {
    const m = matched(bare(s.cmd), own);
    if (m) { at.push(i); hits.push(m); }
  });
  if (!hits.length || at.some((i) => segs[i].then === "&")) return null;
  const last = at[at.length - 1];
  // Into tee, whose exit is tee's: the runner's own exit only with pipefail set before it, or bash's PIPESTATUS after.
  const tee = hits.length === 1 && (segs[last].then === "|" || segs[last].then === "|&") && TEE.test(bare(segs[last + 1]?.cmd ?? "")) ? last + 1 : -1;
  const kept = tee > 0 && !segs.slice(0, tee + 1).some(grouped) && (
    (tee === segs.length - 1 && segs.slice(0, last).reduce<boolean>((on, s) => pipefail(s.cmd) ?? on, false))
    || (tee === segs.length - 2 && segs[tee].then === ";" && !!sh && !!PIPESTATUS[sh.shell]?.test(segs[tee + 1].cmd)));
  const exit = !open && hits.length === 1 && (last === segs.length - 1 || kept);
  // Run whatever came before it: only `;` or a pipe into it.
  const gated = exit && segs.slice(0, last).some((s) => s.then === "&&" || s.then === "||");
  // A script npm or pnpm runs as it is, its start printed (not with an option, nor its log level set: `--silent`).
  const script = gated ? BANNERED.exec(bare(segs[last].cmd))?.[1] : undefined;
  const banner = script && !envOf(segs, last).some((a) => /^(?:npm|pnpm)_config_/i.test(a)) ? (script === "t" || script === "tst" ? "test" : script) : undefined;
  const cleanPasses = !open && at.every((i) => segs.slice(i).every((s) => !s.then || s.then === "&&"));
  const shape = !open && !segs.some((s) => KEYWORD.test(lead(s.cmd)) || ERREXIT_OFF.test(bare(s.cmd)))
    && segs.every((s, i) => !s.then || s.then === "&&" || (s.then === ";" && pipefail(s.cmd)) || (kept && (i === last || i === tee)));
  // A whole run's line: one check, ending it or into tee with its exit kept, with only `before`'s commands before it.
  const lined = exit && segs.slice(0, last).every(before) && (tee < 0 || plainWords(segs[tee].cmd)?.[0] === "tee");
  const of = (k: CheckKind) => hits.filter((h) => h.kind === k).length;
  const several = segs.some((s) => LOOP.test(lead(s.cmd))) || hits.some((h) => of(h.kind) > 1) || at.some((i) => severalWorkspaces(segs[i].cmd));
  const found = hits.map((h, n) => {
    const i = at[n];
    const dir = folderOf(segs, i);
    const scope = scopeOf(h, dir);
    if (h.kind === "test") {
      const w = lined ? plainWords(segs[i].cmd) : null;
      if (w && whole(w, h)) {
        const where = h.suite === h.label && !dir ? undefined : `${h.suite}\t${dir}\t`;
        return { kind: h.kind, label: h.label, told: true, whole: true as const, ...(where ? { scope: where } : {}) };
      }
      // Its own runner, with no env var or wrapper: `npx`, `uv run` and `poetry run` launch it as a whole run's do.
      const plain = !!w && !!matched(w.join(" ").replace(/^(?:npx|uv run|poetry run) /, ""), own);
      return { kind: h.kind, label: h.label, told: false, ...(plain ? { plain: true as const } : {}), ...(scope ? { scope } : {}) };
    }
    const told = shape && of(h.kind) === 1 && !ignores(bare(segs[i].cmd), h.suite) && !envOf(segs, i).some(narrowingEnv);
    const { suite, args } = scopeParts({ label: h.label, scope });
    return { kind: h.kind, label: h.label, told, ...(told && suite === h.label && !args ? { whole: true as const } : {}), ...(scope ? { scope } : {}) };
  });
  return { found, exit, cleanPasses, ...(several ? { several: true as const } : {}), ...(gated ? { gated: true as const } : {}), ...(banner ? { banner } : {}) };
}

/** npm or pnpm running a script with no option (`npm test`, `pnpm run build -- --mode ci`): which script. */
const BANNERED = /^(?:npm|pnpm)(?: run(?:-script)?)? ([\w:.-]+)(?=$| --(?: |$)| 2>&1(?: |$))/;
/** npm's and pnpm's start of script `s` (or its `pre` script): `> web@1.0.0 build` (pnpm's folder after it), then `> vite build`. */
const bannerOf = (s: string) => new RegExp(String.raw`^> (?:\S+ )?(?:pre)?${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: [^\n]*)?\n> \S`, "m");
/** A check's runner started: npm's or pnpm's banner (above, for any script), yarn's start (`yarn run v1.22.22`). */
const STARTED = [/^> \S[^\n]*\n> \S/m, /^yarn run v\d/m];
/**
 * A command before the check failing, as the shell or npm says it: a folder it couldn't enter (bash's `cd: no-such: No
 * such file or directory`, zsh's `cd:1: no such file or directory: no-such`, `Not a directory`, dash's `can't cd`), a
 * command or file it couldn't find (`command not found`; `./gradlew: No such file or directory`, `source`'s file,
 * as the shell says it, in bash, zsh, sh, or zsh's `(eval)` as Claude Code runs it), or a script that isn't there
 * (npm's and pnpm's `Missing script`).
 */
const SETUP_FAILED = [
  /\bcd(?::\d+)?: (?:[^\n]*: )?(?:no such file or directory|not a directory|permission denied)\b|\bcd: can't cd to\b/i,
  /\bcommand not found\b/i,
  /^(?:\S*\/)?(?:(?:ba|z|da|k)?sh|\(eval\))(?::[\w-]+)*(?: line \d+)?: (?:no such file or directory: |[^\n]*: (?:no such file or directory|not found)$)/im,
  /\bMissing script: /,
];

/**
 * Whether a check's failing exit, after a command that could have stopped it (`Ran.gated`), is its own, by what its
 * output shows (the skeptic on 7717d10f3219: only a runner's summary made it one, so `cd web && npm run build` failing
 * with vite's error, or `cd api && go build ./...`, was unknown). A summary of its kind says so first (`stepsOf`). Then:
 * for a script npm or pnpm runs (`Ran.banner`), only with its start printed; else its runner's start shown (`STARTED`),
 * or something printed and nothing showing a command before it failed (`SETUP_FAILED`). An empty output shows nothing
 * ran: a check that fails says why.
 */
export function gateFailed(ran: Ran, output: string): boolean {
  const text = output.slice(0, READ_MAX).replace(ANSI, "");
  if (ran.banner) return bannerOf(ran.banner).test(text);
  return STARTED.some((re) => re.test(text)) || (text.trim() !== "" && !SETUP_FAILED.some((re) => re.test(text)));
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
type Summary = [runner: string, re: RegExp, ok: (m: RegExpExecArray) => boolean | null];
/**
 * What a runner's own summary line says, by kind, with the runner that prints it: each finds every summary in the
 * output, true for passed, false for failed.
 */
const SUMMARIES: Record<CheckKind, Summary[]> = {
  test: [
    // node --test (ℹ fail 0, then ℹ cancelled 0: a test that timed out is cancelled, and fails the run; TAP's # fail 0),
    // bun test ( 1 fail), mocha (  2 failing).
    ["node", /^\s*(?:ℹ|#)\s*fail (\d+)\s*$/gm, (m) => m[1] === "0"],
    ["node", /^\s*(?:ℹ|#)\s*cancelled ([1-9]\d*)\s*$/gm, () => false],
    ["bun", /^\s*(\d+) fail\s*$/gm, (m) => m[1] === "0"],
    ["mocha", /^\s*(\d+) failing\b/gm, () => false],
    ["mocha", /^\s*\d+ passing\b/gm, () => true],
    // vitest (Tests  1 failed | 4 passed (5)), jest (Tests:       1 failed, 4 passed, 5 total); with the line before it
    // when that's the files' or suites' count, since a file that didn't load fails the run with every test passing
    // (Test Suites: 1 failed, 2 passed / Tests: 4 passed; vitest's Test Files).
    ["jest", /^(?:[ \t]*Test (?:Suites|Files):?[ \t]+(.*)\n)?[ \t]*Tests:?[ \t]+(.*)$/gm, (m) => {
      const said = `${m[1] ?? ""} ${m[2]}`;
      return /\b(?:passed|failed)\b/.test(said) ? !/\b[1-9]\d* failed\b/.test(said) : null;
    }],
    // pytest (=== 1 failed, 4 passed in 0.12s ===, or with -q without the rules); tox's own, after its environments'.
    ["pytest", /^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s\b/gm, (m) => !/\b(?:failed|errors?)\b/.test(m[1])],
    ["tox", /^\s*congratulations :\)/gm, () => true],
    // cargo (test result: ok. / FAILED., one per test binary), go test (ok  pkg / FAIL pkg, one per package, then FAIL
    // if any failed), XCTest and swift-testing, xcodebuild, gradle (with failures ignored, "There were failing tests")
    // and maven (surefire's Tests run: 3, Failures: 1, Errors: 0, one per class and one of them all).
    ["cargo", /^test result: (ok|FAILED)\./gm, (m) => m[1] === "ok"],
    ["go", /^(?:--- )?FAIL\b/gm, () => false],
    ["go", /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm, () => true],
    ["xctest", /Test Suite 'All tests' (passed|failed)/g, (m) => m[1] === "passed"],
    ["swift-testing", /Test run with \d+ tests? (?:in \d+ suites? )?(passed|failed)/g, (m) => m[1] === "passed"],
    ["xcodebuild", /\*\* TEST (SUCCEEDED|FAILED) \*\*/g, (m) => m[1] === "SUCCEEDED"],
    ["gradle", /^BUILD (SUCCESSFUL|SUCCESS|FAILED|FAILURE)\b/gm, (m) => m[1].startsWith("SUCCESS")],
    ["gradle", /^There were failing tests\b/gm, () => false],
    ["maven", /^(?:\[\w+\]\s+)?Tests run: \d+, Failures: (\d+), Errors: (\d+)/gm, (m) => m[1] === "0" && m[2] === "0"],
    ["maven", /^\[ERROR\] There (?:are|were) test failures/gm, () => false],
  ],
  build: [
    ["xcodebuild", /\*\* BUILD (SUCCEEDED|FAILED) \*\*/g, (m) => m[1] === "SUCCEEDED"],
    ["tsc", /\berror TS\d+:|^Found \d+ errors?\b/gm, () => false],
    ["cargo", /^error: could not compile\b/gm, () => false],
    ["cargo", /^\s*Finished `/gm, () => true],
    ["gradle", /^BUILD (SUCCESSFUL|SUCCESS|FAILED|FAILURE)\b/gm, (m) => m[1].startsWith("SUCCESS")],
  ],
  lint: [
    ["eslint", /✖ \d+ problems?\b/g, () => false],
    ["ruff", /^Found \d+ errors?\b/gm, () => false],
    ["ruff", /^All checks passed!/gm, () => true],
  ],
};

/**
 * What runs several runs and says one of them failed, whatever ran in each: npm over its workspaces (`npm error
 * Lifecycle script`; older, `npm ERR!`), pnpm (`ELIFECYCLE`, `ERR_PNPM_RECURSIVE_…`), yarn (`error Command failed`),
 * make (and with -i, its ignored error), cargo over its test binaries (`error: test failed`, or with --no-fail-fast
 * `error: 2 targets failed:`) and tox over its environments. Each is printed as or after the run it's about fails, and
 * a passing run can come after it.
 */
const FAILED_SOMEWHERE = [
  /^npm (?:error|ERR!) (?:Lifecycle script `[^`]+` failed|Test failed|code ELIFECYCLE|command failed)/m,
  /\bELIFECYCLE\b\]?\s+(?:Test|Command) failed/,
  /\bERR_PNPM_RECURSIVE_(?:RUN_FIRST_)?FAIL\b/,
  /^error Command failed with exit code \d+/m,
  /^g?make(?:\[\d+\])?: (?:\*\*\* .*Error \d+|\[.*\] Error \d+ \(ignored\))/m,
  /^error: (?:test failed, to rerun|\d+ targets? failed:)/m,
  /^\s*\S+: FAIL code \d+ \(|^\s*evaluation failed :\(/m,
];

/** How much of an output is read: its end. */
const READ_MAX = 500_000;

/**
 * A check's result from its output, read here and never kept: false with a failure anywhere in what was read (any
 * failure of the runner whose summary comes last: one per package, per test binary, per environment or per workspace,
 * each carrying on after a failure, so a passing one can come last; with `several` runs, any runner's), or anything
 * that ran several runs saying one failed (`FAILED_SOMEWHERE`); true with the last summary passing; else null (cut off,
 * filtered out, or a runner that prints none). Only false decides anything (`stepsOf`): a pass is its runner's own exit.
 * Another runner's failing summary before the last one's, in a single run, is something its tests printed ("** TEST
 * FAILED **" in a fixture, measured on this machine's Codex runs).
 */
export function verdictOf(output: string, kind: CheckKind, several = false): boolean | null {
  const text = output.slice(-READ_MAX).replace(ANSI, "");
  if (FAILED_SOMEWHERE.some((re) => re.test(text))) return false;
  const seen: { at: number; ok: boolean; runner: string }[] = [];
  for (const [runner, re, ok] of SUMMARIES[kind]) {
    for (const m of text.matchAll(re)) {
      const v = ok(m as RegExpExecArray);
      if (v !== null) seen.push({ at: m.index!, ok: v, runner });
    }
  }
  if (!seen.length) return null;
  const last = seen.reduce((a, b) => (b.at >= a.at ? b : a));
  return seen.some((s) => !s.ok && (several || s.runner === last.runner)) ? false : true;
}

/**
 * A runner saying it ran no test: go's `[no tests to run]` (a `-run` pattern that matched nothing) and `[no test
 * files]`, node's `tests 0`, jest's and vitest's every test skipped or none found, pytest's only skipped or deselected,
 * cargo's `0 passed; 0 failed`, mocha's `0 passing`, bun's, XCTest's and swift-testing's 0 tests, and Maven's `Tests
 * run: 0`. `RAN_SOME`: the same runners saying one did.
 */
const RAN_NONE = [
  /^ok\s+\S+\s+\S+\s+\[no tests to run\]/m, /^\?\s+\S+\s+\[no test files\]/m,
  /^\s*[ℹ#]\s*tests 0\s*$/m,
  /^\s*Tests:?\s+(?:\d+ (?:skipped|todo)[,|\s]*)*(?:\d+ total|\(\d+\)|no tests)\s*$/m, /^No test(?:s| files) found\b/m,
  /^(?:=+ )?(?:no tests ran|(?:\d+ (?:skipped|deselected|xfailed|warnings?)(?:, )?)+) in [\d.]+s\b/m,
  /^test result: ok\. 0 passed; 0 failed;/m, /^\s*0 passing\b/m, /^Ran 0 tests\b/m, /Executed 0 tests\b|Test run with 0 tests\b/, /Tests run: 0, Failures: 0\b/,
];
const RAN_SOME = [
  /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))(?!\s+\[no tests to run\])/m, /^(?:--- )?FAIL\b/m,
  /^\s*[ℹ#]\s*tests [1-9]/m,
  /^\s*Tests:?\s+.*\b[1-9]\d* (?:passed|failed)\b/m,
  /\b[1-9]\d* (?:passed|failed|errors?|xpassed)\b.* in [\d.]+s\b/,
  /^test result: \w+\. (?:[1-9]\d* passed|\d+ passed; [1-9]\d* failed)/m, /^\s*[1-9]\d* (?:passing|failing)\b/m, /^Ran [1-9]\d* tests?\b/m,
  /Executed [1-9]\d* tests?\b|Test run with [1-9]\d* tests?\b/, /Tests run: [1-9]/,
];
/** A test run whose output says no test ran, and none did: never "the tests pass". */
export function noneRan(output: string): boolean {
  const text = output.slice(-READ_MAX).replace(ANSI, "");
  return RAN_NONE.some((re) => re.test(text)) && !RAN_SOME.some((re) => re.test(text));
}

/**
 * One step of a run, in order: a check that exited (`ok`; null when it ran but its result can't be told; `scope`, kept
 * on the machine, where it ran; `whole`, a whole run, `Ran`'s; `again`, a plain test run that isn't whole exiting 0
 * with nothing failing in its output, which settles its own earlier failure and is never a pass), or a change to the
 * run's files.
 */
export type Step = { kind: CheckKind; label: string; ok: boolean | null; scope?: string; whole?: true; again?: true } | "edit";

/** A check's scope (`scopeOf`) under the folder its work system ran it in (`cwd`), when the work system says. */
function placed(f: { label: string; scope?: string }, cwd?: string | null): string | undefined {
  if (!cwd) return f.scope;
  const { suite, dir, args } = scopeParts(f);
  const norm = (p: string) => p.replaceAll("\\", "/");
  const joined = /^[/~?]/.test(dir) || /^[A-Za-z]:[/\\]/.test(dir) ? norm(dir) : posix.join(norm(cwd), norm(dir));
  const clean = joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  return `${suite}\t${clean}\t${args}`;
}

/**
 * The steps a finished command adds: its checks, as far as its exit and output tell them, nothing when no exit is
 * known (refused, cut short or left in the background). `output` is the command's output, read here (`verdictOf`), or
 * for one check, that verdict, already read. `cwd`: the folder its work system ran it in, when it says (Codex's
 * `commandExecution.cwd`, Claude Code's shell, OpenCode's `workdir`). A failure from any evidence: a failure in the
 * output, or a non-zero exit that is the check's own (`exit`; with a command before it that could have stopped it,
 * `gated`, only when its runner's summary says how it went, `verdictOf`, or its output shows it ran, `gateFailed`: else
 * the check may never have run; a verdict already read is `gateFailed`'s too). A pass
 * only of a check whose pass can be told (`told`: a test run's only of a whole run), by its own exit 0 (`exit`,
 * `cleanPasses`), with nothing in its output failing or saying no test ran (`noneRan`). Anything else is unknown (`ok`
 * null), never a pass.
 */
export function stepsOf(ran: Ran | null, ok: boolean | null, output: string | boolean | null = "", cwd?: string | null): Step[] {
  if (!ran || ok === null) return [];
  const none = typeof output === "string" && noneRan(output);
  return ran.found.map((f) => {
    const said = typeof output === "string" ? verdictOf(output, f.kind, ran.several) : ran.found.length === 1 ? output : null;
    const clean = ok && said !== false && !(none && f.kind === "test");
    const own = !ran.gated || said !== null || (typeof output === "string" && gateFailed(ran, output));
    const v = said === false || (ran.exit && !ok && own) ? false : clean && f.told && (ran.exit || ran.cleanPasses) ? true : null;
    const scope = placed(f, cwd);
    return { kind: f.kind, label: f.label, ok: v, ...(scope ? { scope } : {}), ...(v !== null && f.whole ? { whole: true as const } : {}), ...(v === null && clean && f.plain ? { again: true as const } : {}) };
  });
}

const KEY = { test: "tests", build: "build", lint: "lint" } as const;

/** A step's scope, read back: what ran it, where, and with what else (empty for nothing but its runner). */
function scopeParts(s: { label: string; scope?: string }): { suite: string; dir: string; args: string } {
  const [suite, dir, args] = (s.scope ?? `${s.label}\t\t`).split("\t");
  return { suite, dir, args };
}

/**
 * Where a thread's checks stand between its runs (`fold`): per place, its last result, and whether a file changed after
 * it. A place is a whole run's runner and folder (`suite\tdir`), or any other run's runner, folder and words
 * (`suite\tdir\targs`).
 */
export type Places = Record<string, { ok: boolean; changed: boolean }>;
const placeOf = (s: Exclude<Step, "edit">) => {
  const { suite, dir, args } = scopeParts(s);
  return s.whole ? `${suite}\t${dir}` : `${suite}\t${dir}\t${args}`;
};

/**
 * A run's receipts from its steps in order, and where its thread's test runs stand after it (`after`, from `before`:
 * where they stood after its runs before this one). Per kind: how many ran in this run and failed, the last one's
 * label, whether the run changed a file before it (`edited`: a pass of the agent's change, not a first run before it
 * changed anything), and what every place it (and for tests, the thread) ran checks in says (`ok`, and `stale` for a
 * file changed since):
 * - a whole run's pass settles its place and every earlier run of its runner in its folder (a failure of `pytest
 *   tests/test_x.py` too); a failure, anywhere, stands until then;
 * - a plain test run that isn't whole exiting 0 (`again`) settles only its own earlier failure, the same words in the
 *   same folder: never a pass;
 * - a run whose result can't be told leaves no pass of its kind standing before it (it may have failed);
 * - a file changed makes every place stale until a whole run there again;
 * - a pass that leaves any place failing or stale isn't counted (nor its label): what was before it stands.
 * It passes only with every place passing; it failed with any failing. Between runs only the tests' places that a
 * whole run can settle are kept: whole runs', and failures of the same runners in a folder that can be read.
 *
 * `from`: the steps before it are the run's own before the user's latest words in it (a message steered into a Codex
 * turn; the review of 45ec9eccdf6f, F1): they move every place as any step does, so a failure or a change before the steer
 * stands after it, but the receipt (its counts, label and `edited`) is of the steps from there on.
 */
export function fold(steps: readonly Step[], before: Places = {}, from = 0): { checks: Checks | undefined; after: Places } {
  const places: Partial<Record<CheckKind, Places>> = { test: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, { ...v }])) };
  const ran: Partial<Record<CheckKind, { runs: number; failed: number; label: string; edited: boolean }>> = {};
  let edited = false;
  for (const [n, s] of steps.entries()) {
    if (s === "edit") {
      if (n >= from) edited = true;
      for (const p of Object.values(places)) for (const v of Object.values(p!)) v.changed = true;
      continue;
    }
    const p = (places[s.kind] ??= {});
    const key = placeOf(s);
    if (s.ok === null) {
      if (s.again) { if (p[key]?.ok === false) delete p[key]; }
      else for (const k of Object.keys(p)) if (p[k].ok) delete p[k];
      continue;
    }
    if (s.ok && s.whole && !key.includes("?")) for (const k of Object.keys(p)) if (k === key || k.startsWith(`${key}\t`)) delete p[k];
    p[key] = { ok: s.ok, changed: false };
    // A pass that leaves its kind failing or stale anywhere is left out, as a run that can't be told: what was before stands.
    if (s.ok && Object.values(p).some((v) => !v.ok || v.changed)) continue;
    if (n < from) continue;
    const r = ran[s.kind];
    ran[s.kind] = { runs: (r?.runs ?? 0) + 1, failed: (r?.failed ?? 0) + (s.ok ? 0 : 1), label: s.label, edited };
  }
  const checks: Checks = {};
  for (const kind of ["test", "build", "lint"] as const) {
    const r = ran[kind], all = Object.values(places[kind] ?? {});
    if (!r || !all.length) continue;
    const failing = all.filter((v) => !v.ok);
    const stale = (failing.length ? failing : all).some((v) => v.changed);
    checks[KEY[kind]] = { ok: !failing.length, runs: r.runs, failed: r.failed, label: r.label, ...(stale ? { stale: true as const } : {}), ...(r.edited ? { edited: true as const } : {}) } satisfies CheckRun;
  }
  const after = Object.fromEntries(Object.entries(places.test ?? {}).filter(([k]) => {
    const [suite, dir, args] = k.split("\t");
    return !dir.includes("?") && (args === undefined || WHOLE_RUNNERS.has(suite));
  }));
  return { checks: Object.keys(checks).length ? checks : undefined, after };
}

/**
 * A run's receipts when only part of it could be read (the review of 45ec9eccdf6f, F2: T3 Code's history refused, or a run
 * longer than the pages read): what failed in what was read, which stands whatever came before it, and never a pass;
 * none unless its test runs failed, so the run is told as unread, never "no test ran" or a pass.
 */
export function partOnly(c: Checks | undefined): Checks | undefined {
  if (c?.tests?.ok !== false) return undefined;
  return Object.fromEntries(Object.entries(c).filter(([, r]) => r?.ok === false));
}

/** A run's receipts (`fold`), with where its thread's test runs stood before it. */
export const receipts = (steps: readonly Step[], before?: Places): Checks | undefined => fold(steps, before).checks;

/** How many of a thread's runs `Tested` keeps apart, the older ones folded into where they started. */
const RUNS_KEPT = 8;
/** How long a thread's test runs are kept after it was last looked at, when it never ends. */
const TESTED_KEPT_MS = 30 * 86_400_000;
type Memo = { base: Places; runs: { id: string; after: Places }[] };

/**
 * Each thread's test runs across its runs (its turns), so a later run's receipts start where the earlier ones left
 * them (`fold`): in the adapter's store when it has one (`db`), else in memory, until the thread ends (`forget`) or
 * isn't looked at for 30 days. Runs are folded in the order they're first seen; one seen again (a run still going, read
 * again) is folded again from where it started. A run whose checks are never read (no report asked for it) isn't
 * remembered.
 */
export class Tested {
  private readonly memos = new Map<string, Memo>();
  private readonly db: DatabaseSync | undefined;
  constructor(db?: DatabaseSync) {
    this.db = db;
    db?.exec("CREATE TABLE IF NOT EXISTS tested (thread TEXT PRIMARY KEY, memo TEXT NOT NULL, at INTEGER NOT NULL)");
  }
  /**
   * Run `run`'s receipts in thread `thread`, from its steps so far, remembering where it leaves the thread; `from`, the
   * receipt only of the steps from there (`fold`: a message steered into the run), every step still where it starts.
   */
  receipts(thread: string, run: string, steps: readonly Step[], from = 0): Checks | undefined {
    const m = this.read(thread) ?? { base: {}, runs: [] };
    let i = m.runs.findIndex((r) => r.id === run);
    if (i < 0) i = m.runs.push({ id: run, after: {} }) - 1;
    const { checks, after } = fold(steps, i ? m.runs[i - 1].after : m.base, from);
    m.runs[i].after = after;
    while (m.runs.length > RUNS_KEPT) m.base = m.runs.shift()!.after;
    this.write(thread, m);
    return checks;
  }
  forget(thread: string): void {
    this.memos.delete(thread);
    this.db?.prepare("DELETE FROM tested WHERE thread = ?").run(thread);
  }
  private read(thread: string): Memo | undefined {
    if (!this.db) return this.memos.get(thread);
    const row = this.db.prepare("SELECT memo FROM tested WHERE thread = ?").get(thread) as { memo: string } | undefined;
    try { return row ? JSON.parse(row.memo) as Memo : undefined; } catch { return undefined; }
  }
  private write(thread: string, m: Memo): void {
    if (!this.db) { this.memos.set(thread, m); return; }
    const now = Date.now();
    this.db.prepare("DELETE FROM tested WHERE at < ?").run(now - TESTED_KEPT_MS);
    this.db.prepare("INSERT OR REPLACE INTO tested (thread, memo, at) VALUES (?, ?, ?)").run(thread, JSON.stringify(m), now);
  }
}
