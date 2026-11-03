#!/usr/bin/env node
// What `npm i -g 10and2` puts on PATH. It checks Node before loading the bundle, whose `node:sqlite` import would
// otherwise fail on an older Node with "No such built-in module", and keeps SQLite's experimental-feature notice out
// of the user's terminal (other warnings still print).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`10and2 needs Node 22.13 or newer, and this is Node ${process.versions.node}.\nUpdate Node (https://nodejs.org), then run the same command again.`);
  process.exit(1);
}
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.error(`${w.name}: ${w.message}`); });
await import("../dist/10and2.js");
