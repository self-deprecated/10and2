// What `10and2 pi-turn` runs, for tests that don't go through the connector's own command line.
import { runPiTurn } from "../../../src/pi/turn.ts";
if (process.argv[2] !== "pi-turn") process.exit(64);
process.exit(await runPiTurn());
