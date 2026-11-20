// The device credential (contracts §2), kept in the OS secret store: the macOS Keychain, or libsecret on Linux, with a
// 0600 file where neither works (a headless server). On Windows it's in that file encrypted for the Windows account
// (DPAPI, through Windows PowerShell), or plain where PowerShell can't (Constrained Language Mode), as the profile's own
// permissions keep it to the user. The secret goes to those tools on stdin, never on a command line another user could
// read, and it's never printed or logged.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { envVar, spawnCommand, which } from "./command.ts";
import { configDirectory } from "./paths.ts";
import { replaceFile } from "./util.ts";

export type Store = "keychain" | "libsecret" | "dpapi" | "file";
const SERVICE = "10and2-connector";

/** Runs a command with input on stdin; resolves with stdout, or null when it fails or isn't installed. */
export type Runner = (command: string, args: string[], input?: string) => Promise<string | null>;
export const run: Runner = (command, args, input) => new Promise((resolve) => {
  // One that isn't installed is null, and never a program of that name in the current folder, where Windows looks first.
  if (process.platform === "win32" && !which(command)) { resolve(null); return; }
  let child;
  try { child = spawnCommand(command, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { resolve(null); return; }
  let out = "";
  child.stdout?.on("data", (d) => { out += d; });
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code === 0 ? out : null));
  child.stdin?.on("error", () => {});
  child.stdin?.end(input ?? "");
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

/** How an encrypted value is kept in credentials.json; a credential or token never has a ":" in it. */
const DPAPI = "dpapi:";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * The PowerShell that encrypts (Protect) or decrypts (Unprotect) for this Windows account. Both read base64 on stdin and
 * write base64, so neither the secret's bytes nor the console's code page can be mangled on the way, and fail with
 * exit 1 (as they do where .NET calls aren't allowed: Constrained Language Mode).
 */
const script = (fn: "Protect" | "Unprotect") => [
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
  "try { Add-Type -AssemblyName System.Security",
  "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}($data, $null, 'CurrentUser')))`,
  "exit 0 } catch { exit 1 }",
].join("; ");
/** Windows PowerShell (5.1, on every Windows) by its own path: never another `powershell` on PATH or in the current folder. */
export const powershellPath = (env: NodeJS.ProcessEnv) => win32.join(envVar(env, "SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** Its arguments: a fixed script, encoded as PowerShell takes one (base64 of UTF-16LE), with nothing of the secret in it. */
export const powershellArgs = (fn: "Protect" | "Unprotect") => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script(fn), "utf16le").toString("base64")];

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
    return this.platform === "darwin" ? "keychain" : this.platform === "linux" ? "libsecret" : this.platform === "win32" ? "dpapi" : null;
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
    // Encrypted only once it's known to decrypt again: otherwise the plain file, rather than a key that can't be read.
    const blob = store === "dpapi" ? await this.dpapi("Protect", Buffer.from(secret, "utf8").toString("base64")) : null;
    const kept = blob && await this.unprotect(blob) === secret ? `${DPAPI}${blob}` : null;
    const all = this.readFile();
    all[origin] = kept ?? secret;
    this.writeFile(all);
    return kept ? "dpapi" : "file";
  }

  /** The credential for a brain origin; null when there's none, or one this Windows account can't decrypt. */
  async load(origin: string): Promise<{ secret: string; store: Store } | null> {
    const os = await this.loadOs(origin);
    if (os) return { secret: os, store: this.osStore! };
    const file = this.readFile()[origin];
    if (!file) return null;
    if (!file.startsWith(DPAPI)) return { secret: file, store: "file" };
    const secret = this.platform === "win32" ? await this.unprotect(file.slice(DPAPI.length)) : null;
    return secret ? { secret, store: "dpapi" } : null;
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
  /** DPAPI through Windows PowerShell: base64 in, base64 out, or null when it couldn't. */
  private async dpapi(fn: "Protect" | "Unprotect", base64: string): Promise<string | null> {
    if (!BASE64.test(base64)) return null;
    const out = (await this.runner(powershellPath(this.env), powershellArgs(fn), base64))?.trim();
    return out && BASE64.test(out) ? out : null;
  }
  private async unprotect(blob: string): Promise<string | null> {
    const out = await this.dpapi("Unprotect", blob);
    return out ? Buffer.from(out, "base64").toString("utf8") || null : null;
  }
  private readFile(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const st = statSync(this.file);
    // Windows has no such modes (Node reports 0666 for every file): the profile's own permissions keep it private there.
    // It's the file system's, so it's this computer's system, whichever store is in use.
    if (!st.isFile() || (process.platform !== "win32" && (st.mode & 0o077) !== 0)) throw new Error(`${this.file} must be a regular file only you can read (mode 0600).`);
    try { const v = JSON.parse(readFileSync(this.file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }
  private writeFile(all: Record<string, string>) {
    mkdirSync(configDirectory(this.env), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    replaceFile(tmp, this.file);
  }
}
