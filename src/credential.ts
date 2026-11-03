// The device credential (contracts §2), kept in the OS secret store: the macOS Keychain, or libsecret on Linux, with a
// 0600 file where neither works (a headless server). The secret goes to those tools on stdin, never on a command line
// another user could read, and it's never printed or logged.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDirectory } from "./paths.ts";

export type Store = "keychain" | "libsecret" | "file";
const SERVICE = "10and2-connector";

/** Runs a command with input on stdin; resolves with stdout, or null when it fails or isn't installed. */
export type Runner = (command: string, args: string[], input?: string) => Promise<string | null>;
export const run: Runner = (command, args, input) => new Promise((resolve) => {
  let child;
  try { child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { resolve(null); return; }
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code === 0 ? out : null));
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
});

/** A paired device's credential names its user and device: `dc1.<base64url(user id)>.<deviceId>.<secret>`. */
export function parseCredential(credential: string): { userId: string; deviceId: string } | null {
  const parts = credential.split(".");
  if (parts.length !== 4 || parts[0] !== "dc1") return null;
  try {
    const userId = Buffer.from(parts[1], "base64url").toString("utf8");
    return /^user_[A-Za-z0-9]{1,64}$/.test(userId) && /^[A-Za-z0-9_-]{16,}$/.test(parts[2]) ? { userId, deviceId: parts[2] } : null;
  } catch { return null; }
}

export class Credentials {
  private readonly runner: Runner;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  constructor(opts: { runner?: Runner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}) {
    this.runner = opts.runner ?? run;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
  }
  private get file() { return join(configDirectory(this.env), "credentials.json"); }
  /** `TENANDTWO_CREDENTIAL_STORE=file` skips the OS store (tests, or a machine whose keyring can't be unlocked). */
  private get osStore(): Store | null {
    if (this.env.TENANDTWO_CREDENTIAL_STORE === "file") return null;
    return this.platform === "darwin" ? "keychain" : this.platform === "linux" ? "libsecret" : null;
  }

  /** Saves the credential for a brain origin, in the OS store if it takes it, else the private file. */
  async save(origin: string, secret: string): Promise<Store> {
    const store = this.osStore;
    if (store === "keychain") {
      // `security -i` reads its command from stdin, so the secret never appears in the process list.
      if (await this.runner("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${origin} -w ${secret}\n`) !== null && await this.loadOs(origin) === secret) return "keychain";
    } else if (store === "libsecret") {
      if (await this.runner("secret-tool", ["store", `--label=10and2 connector (${origin})`, "service", SERVICE, "account", origin], secret) !== null && await this.loadOs(origin) === secret) return "libsecret";
    }
    const all = this.readFile();
    all[origin] = secret;
    this.writeFile(all);
    return "file";
  }

  async load(origin: string): Promise<{ secret: string; store: Store } | null> {
    const os = await this.loadOs(origin);
    if (os) return { secret: os, store: this.osStore! };
    const file = this.readFile()[origin];
    return file ? { secret: file, store: "file" } : null;
  }

  async delete(origin: string): Promise<void> {
    if (this.osStore === "keychain") await this.runner("security", ["delete-generic-password", "-s", SERVICE, "-a", origin]);
    if (this.osStore === "libsecret") await this.runner("secret-tool", ["clear", "service", SERVICE, "account", origin]);
    const all = this.readFile();
    if (origin in all) { delete all[origin]; this.writeFile(all); }
  }

  private async loadOs(origin: string): Promise<string | null> {
    const out = this.osStore === "keychain" ? await this.runner("security", ["find-generic-password", "-s", SERVICE, "-a", origin, "-w"])
      : this.osStore === "libsecret" ? await this.runner("secret-tool", ["lookup", "service", SERVICE, "account", origin]) : null;
    const secret = out?.trim();
    return secret ? secret : null;
  }
  private readFile(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const st = statSync(this.file);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`${this.file} must be a regular file only you can read (mode 0600).`);
    try { const v = JSON.parse(readFileSync(this.file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }
  private writeFile(all: Record<string, string>) {
    mkdirSync(configDirectory(this.env), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

/** Whether a command is installed, for detecting T3 Code and Claude Code. */
export const installed = (command: string) => new Promise<boolean>((resolve) => {
  execFile(command, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
});
