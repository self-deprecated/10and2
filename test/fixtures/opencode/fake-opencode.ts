// A fake `opencode` executable for the adapter's own server: `fake-opencode.ts serve --hostname H --port P` serves the
// fake (server.ts) with OpenCode's Basic auth from OPENCODE_SERVER_PASSWORD, and prints OpenCode's "listening" line.
// $FAKE_OPENCODE names a JSON file it rereads as it runs ({db, log, accept, status, questions, permissions}); each request
// and its start (with OPENCODE_PERMISSION) are appended to `log`, with only whether the password was given and right.
import { appendFileSync, readFileSync } from "node:fs";
import { fakeOpenCode } from "./server.ts";

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.19.5"); process.exit(0); }
if (args[0] !== "serve") { console.error("fake opencode: only serve"); process.exit(2); }
const port = Number(args[args.indexOf("--port") + 1]);
const configPath = process.env.FAKE_OPENCODE!;
const config = () => JSON.parse(readFileSync(configPath, "utf8"));
const c = config();
const password = process.env.OPENCODE_SERVER_PASSWORD;
const fake = fakeOpenCode(c.db, { auth: password ? "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64") : null });
const sync = () => { try { const { accept, status, questions, permissions } = config(); Object.assign(fake.state, { accept: accept ?? true, status: status ?? {}, questions: questions ?? [], permissions: permissions ?? [] }); } catch { /* being written */ } };
sync(); setInterval(sync, 25);
fake.seen.push = (...items) => { for (const i of items) appendFileSync(c.log, JSON.stringify({ ...i, auth: i.auth !== null && i.auth === fake.state.auth }) + "\n"); return Array.prototype.push.apply(fake.seen, items); };
appendFileSync(c.log, JSON.stringify({ start: true, pid: process.pid, permission: process.env.OPENCODE_PERMISSION ?? null, password: !!password, user: process.env.OPENCODE_SERVER_USERNAME ?? null }) + "\n");
await fake.listen(port);
console.log(`opencode server listening on http://127.0.0.1:${port}`);
