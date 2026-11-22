#!/usr/bin/env node
// What `npm i -g 10and2` puts on PATH. It checks Node before loading the bundle, whose `node:sqlite` import would
// otherwise fail on an older Node with "No such built-in module", and keeps SQLite's experimental-feature notice out
// of the user's terminal (other warnings still print). Written for any Node, so an old one gets to say so.
var parts = process.versions.node.split(".").map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 13)) {
  var env = process.env, node = process.execPath;
  // How to get a newer Node, by how this one was installed. Never with sudo: npm's global folder is then root's, and
  // every later install needs sudo too.
  var how = env.NVM_DIR || /[\\/]\.nvm[\\/]/.test(node) ? "nvm install 24 && nvm alias default 24"
    : env.FNM_DIR || /fnm/.test(node) ? "fnm install 24 && fnm default 24"
    : env.VOLTA_HOME || /[\\/]\.volta[\\/]/.test(node) ? "volta install node@24"
    : /^\/(opt\/homebrew|usr\/local\/(Cellar|opt))\//.test(node) ? "brew upgrade node"
    : process.platform === "win32" ? "winget install OpenJS.NodeJS.LTS"
    : null;
  console.error("10and2 needs Node 22.13 or newer, and this is Node " + process.versions.node + " (" + node + ").\n" +
    (how ? "Update it: " + how + "\nThen install 10and2 again with that Node: npm i -g 10and2\n"
      : "This looks like your system's own Node, which is often older. Install a current one for yourself with nvm\n" +
        "(https://github.com/nvm-sh/nvm), which needs no sudo: nvm install 24, then npm i -g 10and2\n"));
  process.exit(1);
}
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.error(`${w.name}: ${w.message}`); });
// A Claude Code hook loads only its own small bundle: with commands that wait it runs on every Bash call.
await import(process.argv[2] === "hook" ? "../dist/hook.js" : "../dist/10and2.js");
