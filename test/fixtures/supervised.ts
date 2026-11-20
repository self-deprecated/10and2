// Stands in for the connector under the Windows supervisor (service.test.ts): notes each start, with its PATH, in a
// file, prints a line for the log, then exits with the code a second file holds, or runs until it's asked to stop,
// which it takes as the connector does (stopLikeSigterm). `stubborn` never stops; `win32` takes Windows' console signals.
import { appendFileSync, readFileSync } from "node:fs";
import { stopLikeSigterm } from "../../src/supervisor.ts";

const [notes, how = "", platform] = process.argv.slice(2);
stopLikeSigterm(platform as NodeJS.Platform | undefined);
process.on("SIGTERM", () => {
  if (how === "stubborn") return;
  appendFileSync(notes!, `stopped ${process.pid}\n`);
  process.exit(0);
});
// Noted once it's ready to be asked to stop.
appendFileSync(notes!, `start ${process.pid} ${process.env.PATH}\n`);
console.log(`supervised: started ${process.pid}`);
const code = how.startsWith("code=") ? readFileSync(how.slice(5), "utf8").trim() : "";
if (code) setTimeout(() => process.exit(Number(code)), 20);
else setInterval(() => {}, 1000);
