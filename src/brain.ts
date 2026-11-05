// A brain of your own (`10and2 brain`): its settings, kept in one private file of environment variables that
// `10and2 brain run` reads before it loads the brain. The AI key and the access code live only there.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { configDirectory, stateDirectory } from "./paths.ts";

export const DEFAULT_PORT = 8790;
export const brainEnvPath = (env: NodeJS.ProcessEnv = process.env) => join(configDirectory(env), "brain.env");
/** The brain's database, and its recordings and read-aloud audio beside it. */
export const brainDb = (env: NodeJS.ProcessEnv = process.env) => join(stateDirectory(env), "brain", "driver.db");

export type Machine = { name: string; tokenSha256: string; local?: boolean };

export function readBrainEnv(path = brainEnvPath()): Record<string, string> | null {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}

/** Writes the settings only you can read. A value is single-quoted, so JSON keeps its double quotes. */
export function writeBrainEnv(vars: Record<string, string>, path = brainEnvPath()) {
  const lines = Object.entries(vars).map(([k, v]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /['\n\r]/.test(v)) throw new Error(`${k} can't be written to ${path}`);
    return `${k}='${v}'`;
  });
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `# Your 10 & 2 brain's settings (10and2 brain setup). Only you can read this file.\n${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The port the brain listens on, from its settings. */
export const brainPort = (vars: Record<string, string>) => Number(vars.DRIVER_PORT || DEFAULT_PORT);
/** Where this computer reaches its own brain. */
export const brainOrigin = (vars: Record<string, string>) => `http://127.0.0.1:${brainPort(vars)}`;

export function machines(vars: Record<string, string>): Machine[] {
  try {
    const list = JSON.parse(vars.DRIVER_CONNECTORS || "[]");
    return Array.isArray(list) ? list : [];
  } catch { throw new Error("DRIVER_CONNECTORS in your brain's settings isn't JSON."); }
}

/** As the brain checks them (brain/src/connectors.ts): a name it can say, and a SHA-256 in hex. */
export const validName = (name: string) => /^[a-zA-Z0-9][\w.-]{0,63}$/.test(name);
export const validHash = (hash: string) => /^[a-fA-F0-9]{64}$/.test(hash);

/** The settings with one more computer the brain accepts; refuses a name or token it already has. */
export function addMachine(vars: Record<string, string>, m: Machine): Record<string, string> {
  if (!validName(m.name)) throw new Error(`"${m.name}" can't be a computer's name: one word of letters, digits, - or _.`);
  if (!validHash(m.tokenSha256)) throw new Error("That isn't a token's hash: it's 64 hex digits, from `10and2 setup --brain=… --token` on the other computer.");
  const list = machines(vars);
  const hash = m.tokenSha256.toLowerCase();
  if (list.some((x) => x.name === m.name)) throw new Error(`Your brain already has a computer called ${m.name}. Pick another name, or remove it first (10and2 brain remove ${m.name}).`);
  if (list.some((x) => x.tokenSha256.toLowerCase() === hash)) throw new Error("Your brain already has a computer with that token.");
  return { ...vars, DRIVER_CONNECTORS: JSON.stringify([...list, { name: m.name, tokenSha256: hash, ...(m.local ? { local: true } : {}) }]) };
}

export function removeMachine(vars: Record<string, string>, name: string): Record<string, string> {
  const list = machines(vars);
  if (!list.some((x) => x.name === name)) throw new Error(`Your brain has no computer called ${name}.`);
  return { ...vars, DRIVER_CONNECTORS: JSON.stringify(list.filter((x) => x.name !== name)) };
}
