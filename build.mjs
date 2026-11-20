// Builds what npm publishes, into dist/: the connector (10and2.js) and, loaded only by `10and2 brain run`, the brain
// (brain/main.js) with the files it reads beside its code (its desk page, web/index.html, and the AAC encoder,
// brain/voice/aac/aac.wasm) and which build it is (revision). No TypeScript or node_modules at runtime. The brain's
// sources are ../brain here, and ./brain in the public repository the release exports.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brain = [join(here, "brain"), join(here, "..", "brain")].find((d) => existsSync(join(d, "src", "main.ts")));
if (!brain) throw new Error("build: the brain's sources (brain/src) aren't here or beside connector/");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const dist = join(here, "dist");

const common = {
  bundle: true, platform: "node", target: "node22.13", format: "esm", legalComments: "none", logLevel: "warning",
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS (ws, the AI client) calls require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // The brain's sources import its dependencies, which are the connector's dev dependencies.
  nodePaths: [join(here, "node_modules")],
};
rmSync(dist, { recursive: true, force: true });
await build({ ...common, entryPoints: [join(here, "src", "main.ts")], outfile: join(dist, "10and2.js") });
// A bundled module is never the program Node started (and flags.ts's command line isn't wanted here).
await build({ ...common, entryPoints: [join(brain, "src", "main.ts")], outfile: join(dist, "brain", "main.js"), define: { "import.meta.main": "false" } });
// Each file the brain reads beside its code (`new URL("…", import.meta.url)`), put where the bundle looks for it: the
// brain's src/ is dist/brain/ here. That holds for a read written in src/ itself (brain/test/bundle.test.ts keeps them
// there). One that isn't in the brain's sources stops the build: the brain would stop when it read it (18 November: the
// AAC encoder wasn't copied, and `10and2 brain run` stopped at once).
const bundle = join(dist, "brain", "main.js");
for (const [, path] of readFileSync(bundle, "utf8").matchAll(/new URL\("([^"]+)", import\.meta\.url\)/g)) {
  const from = fileURLToPath(new URL(path, pathToFileURL(join(brain, "src", "main.ts"))));
  if (!existsSync(from)) throw new Error(`build: the brain reads ${path} beside its code, and its sources have no ${from}`);
  // Its root (brainRev), where its build is written below.
  if (!statSync(from).isFile()) continue;
  const to = fileURLToPath(new URL(path, pathToFileURL(bundle)));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
// Which build it is, read from its root (../revision).
writeFileSync(join(dist, "revision"), `10and2-${version}`);
console.log(`build: dist/10and2.js and dist/brain/main.js (10and2 ${version})`);
