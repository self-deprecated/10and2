// The connector's `10and2 hook`, for the harness tests: relays a Claude Code hook event to the adapter's socket, the one
// its gate entry names (`--socket`, as `10and2 hook` reads its own), else HARNESS_HOOK_SOCKET (the terminal sessions the
// tests start carry it), with the list of commands that wait from the settings its gate entry names (`--policy`), else
// from HARNESS_POLICY. With HARNESS_HOOK_LOG, each event Claude Code sent, what the hook printed and how long it took
// are appended there (JSON lines), for the tests to read.
import { appendFileSync } from "node:fs";
import { hookGuard, hookProtects, hookSocketOf, relayHook } from "../../src/claude/hooks.ts";
import { readGuard } from "../../src/policy.ts";
const started = performance.now();
let input = "";
for await (const chunk of process.stdin) input += chunk;
let printed = "";
await relayHook(input, process.argv.includes("--socket") ? hookSocketOf(process.argv) : process.env.HARNESS_HOOK_SOCKET || null, (s) => { printed += s; process.stdout.write(s); }, process.argv.includes("--policy") ? hookGuard(process.argv) : () => (process.env.HARNESS_POLICY ? readGuard(process.env.HARNESS_POLICY) : []), process.argv.includes("--policy") ? hookProtects(process.argv) : []);
if (process.env.HARNESS_HOOK_LOG) appendFileSync(process.env.HARNESS_HOOK_LOG, JSON.stringify({ input: JSON.parse(input || "null"), printed, ms: Math.round(performance.now() - started) }) + "\n");
