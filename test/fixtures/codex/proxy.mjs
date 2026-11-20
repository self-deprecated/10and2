// Stands in for `codex app-server proxy` (and `daemon start`) in the Codex adapter's tests: relays stdin and stdout to
// the fake daemon (fake-daemon.ts) at $CODEX_HOME/app-server-control/app-server-control.sock, or on Windows, where the
// fake can't make a socket file Node opens, at the pipe that file names.
import { connect } from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `codex app-server daemon start`: says the daemon runs (the test brings the fake back), and notes that it was asked.
if (process.argv.includes("daemon")) {
  appendFileSync(join(process.env.CODEX_HOME, "daemon-starts"), "start\n");
  process.stdout.write(JSON.stringify({ status: "alreadyRunning" }) + "\n");
  process.exit(0);
}

const sock = join(process.env.CODEX_HOME, "app-server-control", "app-server-control.sock");
const c = connect(process.platform === "win32" ? readFileSync(sock, "utf8").trim() : sock);
let connected = false;
c.on("connect", () => { connected = true; });
c.on("error", (e) => { process.stderr.write(`proxy: ${e.message}\n`); if (!connected) process.exit(1); });
// Like Codex's own, it keeps running, and its output open, when the daemon goes away; it stops when it's stopped.
process.stdin.pipe(c);
c.pipe(process.stdout, { end: false });
