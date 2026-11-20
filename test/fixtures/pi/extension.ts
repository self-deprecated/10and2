// 10 & 2's Pi extension outside Pi: loaded beside a stand-in for what it imports from Pi's package, and driven through
// a stand-in for Pi's extension API, so its socket (a pipe on Windows) and registry are tried on every system.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionSource } from "../../../src/pi/extension.ts";

type Handler = (event: any, ctx?: any) => unknown;

/** The extension's factory, from a copy under `root` that imports a stand-in Pi (its agent folder: $PI_CODING_AGENT_DIR). */
export async function loadExtension(root: string): Promise<(pi: any) => void> {
  const dir = join(root, "extension"), pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }));
  writeFileSync(join(pkg, "index.js"), 'export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;\nexport const VERSION = "1.5.1";\n');
  copyFileSync(extensionSource(), join(dir, "10and2.ts"));
  return (await import(pathToFileURL(join(dir, "10and2.ts")).href)).default;
}

/** One Pi as the extension sees it: the events it raises, and the words the extension hands it. */
export function openPi(session: { id: string; cwd: string; file: string | null }, ui = false) {
  const handlers = new Map<string, Handler[]>(), sent: [string, unknown][] = [], notes: string[] = [];
  const api = {
    on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: () => {},
    appendEntry: () => {},
    sendUserMessage: (text: string, options: unknown) => { sent.push([text, options]); },
  };
  const ctx = {
    mode: "rpc", hasUI: ui, cwd: session.cwd, isIdle: () => true,
    ui: { notify: (message: string) => notes.push(message) },
    sessionManager: { getSessionId: () => session.id, getSessionFile: () => session.file, getCwd: () => session.cwd, getSessionName: () => undefined, getBranch: () => [] },
  };
  const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  return { api, emit, sent, notes };
}
