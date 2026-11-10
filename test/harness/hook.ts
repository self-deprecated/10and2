// The connector's `10and2 hook`, for the harness tests: relays a Claude Code hook event to the adapter's socket, named in
// HARNESS_HOOK_SOCKET (the terminal sessions the tests start carry it).
import { relayHook } from "../../src/claude/hooks.ts";
await relayHook(process.stdin, process.env.HARNESS_HOOK_SOCKET ?? "");
