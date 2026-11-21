// What `10and2 acp-turn` runs, for tests that don't go through the connector's own command line.
import { runAcpTurn } from "../../../src/acp/turn.ts";
if (process.argv[2] !== "acp-turn") process.exit(64);
process.exit(await runAcpTurn());
