// A version's template hash on this checkout's code (docs/launch/ops-app.md §5), as the cloud makes it:
//   node src/settings-hash.ts <job.json>        ({"overrides": {…}} or the overrides themselves)
// scripts/eval-config posts it with the eval's result; a brain at the same revision makes the same hash.
import { readFileSync } from "node:fs";
import { gitSettings, versionHash } from "./settings.ts";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(await versionHash(gitSettings(), job.overrides ?? job));
