// `10and2 hook`, on its own (bin/10and2.js loads this bundle for it, not the connector's): Claude Code starts it for
// each hook event, and with a list of commands that wait for every Bash call, so it loads only what relaying an event
// and reading the list need. claude/hooks.ts `relayHook` says what it does; it must stay silent but for a decision.
import { runHook } from "./claude/hooks.ts";

await runHook(process.argv);
