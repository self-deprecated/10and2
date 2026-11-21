// Starting the connector at login, as the user (never root): a LaunchAgent on macOS, a systemd user unit on Linux, and
// on Windows an entry in the programs it starts at login, which runs 10and2's own supervisor (supervisor.ts).
// A revoked or replaced connector exits so that none of them restarts it, and a crash is restarted.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, sep, win32 } from "node:path";
import { pidState, type ImageOf } from "./claude/registry.ts";
import { envVar, spawnCommand, which } from "./command.ts";
import { run, type Runner } from "./credential.ts";
import { stateDirectory } from "./paths.ts";
import { ask, controlPipe, HIDDEN, logFile, loginFile, readLogin, saveLogin, withPath } from "./supervisor.ts";

export const LABEL = "com.selfdeprecated.10and2";
/**
 * What the service runs (before the job's own arguments), the PATH setup saw, so `t3` and `claude` are found, and the
 * rest of setup's environment it needs (CARRIED).
 */
export type Launch = { program: string[]; path: string; env?: Record<string, string>; left?: string[] };

/**
 * What a login service is given of setup's environment besides PATH: where the agents and 10and2 keep their files, the
 * Node version manager's home, and how Node reaches the internet (a company's certificates and proxy). A login service
 * starts with almost none of the user's own, so without these it would read other folders than setup did (Volta's shim
 * needs its home when it isn't ~/.volta). Never a key or a token: a proxy address with a password in it is left out
 * (`left`), and said.
 */
export const CARRIED = [
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "T3CODE_HOME", "T3_CLI", "OPENCODE_DB", "TENANDTWO_OPENCODE_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TENANDTWO_COMMAND", "TENANDTWO_CREDENTIAL_STORE",
  "VOLTA_HOME",
  "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
] as const;
const PROXY = /^(https?|no)_proxy$/i;

/** The CARRIED variables `env` has, and the names of those left out because they hold a password. */
export function carried(env: NodeJS.ProcessEnv): { env: Record<string, string>; left: string[] } {
  const out: Record<string, string> = {}, left: string[] = [];
  for (const name of CARRIED) {
    const value = env[name];
    if (!value || /[\0\r\n]/.test(value)) continue;
    if (PROXY.test(name) && /^[a-z][\w+.-]*:\/\/[^/@]*@/i.test(value)) { left.push(name); continue; }
    out[name] = value;
  }
  return { env: out, left };
}

const realPath = (p: string) => { try { return realpathSync(p); } catch { return null; } };
// Folders a command is on PATH from only for now: npx's, a package's own scripts', fnm's per-terminal one.
const TEMPORARY = /[\\/](_npx|fnm_multishells)[\\/]|[\\/]node_modules[\\/]\.bin[\\/]/i;
/**
 * A folder on PATH only for now, as the folder it stands for when that one lasts. fnm's per-terminal folder
 * (/run/user/…/fnm_multishells/…, gone at logout) is a link to one Node's: fnm's default alias when that's the same
 * Node, since it follows `fnm default` through upgrades, else that Node's own folder. Null for npx's, which doesn't last.
 */
function lastingDir(dir: string, env: NodeJS.ProcessEnv): string | null {
  if (!TEMPORARY.test(`${dir}${sep}`)) return dir;
  const real = realPath(dir);
  if (!real || TEMPORARY.test(`${real}${sep}`)) return null;
  const alias = env.FNM_DIR && join(env.FNM_DIR, "aliases", "default", "bin");
  return alias && realPath(alias) === real ? alias : real;
}
/** Volta's shim for a package Volta installed (~/.volta/bin/10and2 links to volta-shim), which finds this install. */
const voltaShim = (found: string, target: string, self: string) =>
  basename(target).startsWith("volta-shim") && /[\\/]tools[\\/]image[\\/]packages[\\/]10and2[\\/]/.test(self) && dirname(found) === dirname(target);

/**
 * How a login service starts this install: the `10and2` on PATH, as PATH names it, when it's this same install. That
 * path outlives upgrades (Nix's ~/.nix-profile/bin/10and2, Homebrew's /opt/homebrew/bin/10and2, Volta's and pnpm's
 * shims), and it finds its own Node. Otherwise (a checkout run with node) this Node and this script. Resolved paths name
 * one version's files: on 20 November Quartz's LaunchAgent had restarted 57,443 times against a Nix store path
 * garbage-collected away. Folders on PATH only for this terminal (fnm's) are written as the folders they stand for.
 */
export function launchFor(script: string, node: string, env: NodeJS.ProcessEnv, which = onPath): Launch {
  const path = (env.PATH ?? "/usr/bin:/bin").split(delimiter).map((d) => d && lastingDir(d, env)).filter((d): d is string => !!d).join(delimiter);
  const { env: vars, left } = carried(env);
  // Node before 24.14 uses a proxy for fetch only when told to at start (net.ts).
  if (Object.keys(vars).some((k) => /^https?_proxy$/i.test(k))) vars.NODE_USE_ENV_PROXY ??= "1";
  const self = realPath(script);
  const onPathNow = which("10and2", env.PATH ?? "");
  const found = onPathNow && (TEMPORARY.test(onPathNow) ? (() => { const dir = lastingDir(dirname(onPathNow), env); return dir && join(dir, "10and2"); })() : onPathNow);
  const target = found && realPath(found);
  // npm: <prefix>/bin/10and2 -> …/node_modules/10and2/bin/10and2.js; Nix: …/bin/10and2 -> <out>/bin/10and2, beside
  // <out>/lib/10and2/dist/10and2.js; pnpm: $PNPM_HOME/10and2, a script running $PNPM_HOME/global/…/10and2. Each time
  // the package's root is two folders up from what PATH's resolves to.
  if (found && self && target && (self.startsWith(dirname(dirname(target)) + sep) || voltaShim(found, target, self))) return { program: [found], path, env: vars, left };
  return { program: [node, self ?? script], path, env: vars, left };
}

/**
 * Whether a launch runs a copy that's only here for now (npx's cache), which a login service can't rely on: npm
 * replaces or clears it.
 */
export const temporary = (l: Launch) => l.program.some((p) => TEMPORARY.test(p));
/** Whether a launch is a checkout run with node (not an installed package), whose service is never rewritten for it. */
export const checkout = (l: Launch) => l.program.length > 1 && !/[\\/]node_modules[\\/]10and2[\\/]/.test(l.program[1]!);

/** The first executable `name` in `path`, as named there (not resolved). */
export function onPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}
/** A job at login: the connector, or a brain of your own (`10and2 brain`). */
export type Job = { name: "connector" | "brain"; label: string; unit: string; logName: string; description: string; args: string[]; launchdArgs: string[] };
export const CONNECTOR: Job = {
  name: "connector", label: LABEL, unit: "10and2.service", logName: "10and2.log",
  description: "10and2 connector: lets your 10 & 2 brain read and act on this machine's coding sessions",
  // Started at boot (lingering) or with the session, it can come before the login keyring opens: wait for the credential.
  args: ["run", "--wait-for-credential"],
  // launchd can't skip one exit status, so a stop that mustn't be restarted exits 0 there.
  launchdArgs: ["run", "--fatal-exit=0"],
};
export const BRAIN: Job = {
  name: "brain", label: `${LABEL}.brain`, unit: "10and2-brain.service", logName: "10and2-brain.log",
  description: "10and2 brain: your own 10 & 2 brain, for your phone and your computers' connectors",
  args: ["brain", "run"], launchdArgs: ["brain", "run"],
};

/** Linux without systemd (a container, WSL without it, Alpine, Devuan): nothing to start it at login. */
export const NO_SYSTEMD = "This computer doesn't run systemd, so 10and2 can't start at login by itself. Keep 10and2 run going another way: a tmux or screen session, your init system's service, or cron's @reboot (10and2's README, under Starting at login).";
const NO_USER_SYSTEMD = "systemd has no user session for this login, so 10and2 can't start at login (systemctl --user failed).";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const systemdQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(l: Launch, job = CONNECTOR): string {
  return `[Unit]
Description=${job.description}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[...l.program, ...job.args].map(systemdQuote).join(" ")}
${[["PATH", l.path], ...Object.entries(l.env ?? {})].map(([k, v]) => `Environment=${systemdQuote(`${k}=${v.replace(/%/g, "%%")}`)}`).join("\n")}
Restart=on-failure
RestartSec=5
# 78: revoked, replaced by another copy, or a brain this version can't talk to. Restarting wouldn't help.
RestartPreventExitStatus=78
# Only the connector itself stops with the service: Claude Code runs it started (a background session, Claude's
# supervisor) carry on through a restart or an update.
KillMode=process
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function launchAgent(l: Launch, logs: string, job = CONNECTOR): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key>
  <array>
${[...l.program, ...job.launchdArgs].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${[["PATH", l.path], ...Object.entries(l.env ?? {})].map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(logs)}</string>
  <key>StandardErrorPath</key><string>${xml(logs)}</string>
</dict>
</plist>
`;
}

/** Where Windows keeps the programs it starts at login for this user (writing it needs no administrator). */
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** Where Task Manager's and Settings' Startup apps switch keeps an entry turned off; Windows then skips it at login. */
export const STARTUP_APPROVED = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const commandName = (env: NodeJS.ProcessEnv) => env.TENANDTWO_COMMAND || "10and2";
const systemRoot = (env: NodeJS.ProcessEnv) => envVar(env, "SystemRoot") || "C:\\Windows";
// A word cmd.exe passes on as it is.
const PLAIN = /^[\w@+=:,./\\-]+$/;
/** A Windows PATH without the folders that are on it only for now, which a login won't have. */
const lasting = (path: string) => path.split(";").filter((dir) => !TEMPORARY.test(`${dir}\\`)).join(";");

/**
 * What Windows runs at login: `cmd.exe /d /c 10and2 login-service connector`. cmd.exe finds `10and2` on the PATH at
 * each login (npm's 10and2.cmd), so no path to Node or 10and2 is written that an upgrade could leave behind. cmd.exe's
 * own path is written out, since %SystemRoot% in a plain string value (REG_SZ) may not be expanded.
 */
export function runEntry(job: Job, env: NodeJS.ProcessEnv): string {
  const cmd = `"${systemRoot(env)}\\System32\\cmd.exe"`;
  const command = commandName(env);
  if (PLAIN.test(command)) return `${cmd} /d /c ${command} login-service ${job.name}`;
  // A path with spaces (TENANDTWO_COMMAND): with /s, cmd.exe takes off only the outer quotes.
  return `${cmd} /d /s /c ""${command}" login-service ${job.name}"`;
}

/**
 * `elevated`: set up on Windows from a terminal run as administrator, so it wasn't started now (everything it started
 * would run as administrator until sign-out, beyond an ordinary terminal's reach); it starts at the next sign-in.
 */
export type ServiceState = { installed: boolean; running: boolean; where: string; logs: string; elevated?: true; note?: string };

/**
 * Whether the connector status.json names (with its `startedAt`) is still running. On Windows a pid is soon another
 * process's, so there it counts only while tasklist shows it as the Node this runs on, and not when it was recorded
 * before the computer last started. A pid that answers EPERM counts as not running, a connector run as administrator
 * included, since another account's process answers the same.
 */
export function connectorRunning(pid: number, startedAt?: unknown, platform = process.platform, imageOf?: ImageOf, node = process.execPath): boolean {
  if (platform === "win32") return pidState(pid, `win32:${win32.basename(node).toLowerCase()}`, "win32", startedAt, imageOf) !== "dead";
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Sends the Windows supervisor one line on its pipe; its answer, or null when none proves itself with `secret` within `ms`. */
type Control = (pipe: string, line: string, secret: string, ms?: number) => Promise<string | null>;

export class Service {
  private readonly runner: Runner;
  private platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly job: Job;
  private readonly control: Control;
  private readonly start: (command: string[], env: NodeJS.ProcessEnv) => void;
  constructor(opts: {
    runner?: Runner; platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; job?: Job;
    control?: Control; start?: (command: string[], env: NodeJS.ProcessEnv) => void;
  } = {}) {
    this.runner = opts.runner ?? run;
    this.control = opts.control ?? ask;
    // The supervisor, started now on Windows as it will be at login: on its own, with no window.
    this.start = opts.start ?? ((command, env) => {
      spawnCommand(command[0]!, command.slice(1), { detached: true, stdio: "ignore", cwd: this.home, env }).on("error", () => {}).unref();
    });
    this.job = opts.job ?? CONNECTOR;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.platform = opts.platform ?? process.platform;
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
    // Tests (and machines whose login services are managed some other way, such as Nix) never touch the service manager.
    if (this.env.TENANDTWO_NO_SERVICE === "1") this.platform = "none" as NodeJS.Platform;
  }
  get supported() { return this.platform === "darwin" || this.platform === "linux" || this.platform === "win32"; }
  private get plist() { return join(this.home, "Library", "LaunchAgents", `${this.job.label}.plist`); }
  private get logs() { return join(this.home, "Library", "Logs", this.job.logName); }
  private get unit() { return join(this.env.XDG_CONFIG_HOME || join(this.home, ".config"), "systemd", "user", this.job.unit); }
  private get domain() { return `gui/${userInfo().uid}`; }
  private get target() { return `${this.domain}/${this.job.label}`; }
  private get reg() { return `${systemRoot(this.env)}\\System32\\reg.exe`; }
  /** The Run entry's name: what Task Manager's Startup apps and the registry show. */
  private get value() { return this.job.name === "connector" ? "10and2" : `10and2-${this.job.name}`; }

  /**
   * Asks the Windows supervisor, at the pipe named from its token; null when there's none, it doesn't answer, or what
   * answers can't prove it's the supervisor (with the secret beside the token).
   */
  private async supervisor(line: string, ms?: number): Promise<string | null> {
    const { token, secret } = readLogin(loginFile(this.job, this.env));
    return token && secret ? this.control(controlPipe(this.job, token, this.env, this.platform), line, secret, ms) : null;
  }
  /** The Windows supervisor's child, when it has one running. */
  private async child(): Promise<number | null> {
    try { return JSON.parse(await this.supervisor("status") ?? "null")?.child ?? null; } catch { return null; }
  }
  /** Stops the Windows supervisor (its child first, as on a stop) and waits for it to go. */
  private async stopSupervisor() {
    // The child gets 5 s to stop before it's ended.
    if (await this.supervisor("stop", 15_000) === null) return;
    await this.until(async () => await this.supervisor("status") === null);
  }

  /**
   * Why it can't start at login here, or null. On Windows the entry runs `10and2` from the PATH, so it has to be
   * installed there for good (npm i -g), not just for now (npx).
   */
  unavailable(l: Launch): string | null {
    if (this.platform === "linux") {
      if (temporary(l)) return "To start at login, 10and2 needs to be installed: npm i -g 10and2";
      if (!this.systemd()) return NO_SYSTEMD;
      return null;
    }
    if (this.platform !== "win32") return null;
    const found = which(commandName(this.env), withPath(this.env, lasting(l.path)), "win32");
    return found && !TEMPORARY.test(found) ? null : "To start at login, 10and2 needs to be installed: npm i -g 10and2";
  }

  /** Whether this Linux was started by systemd, with its `systemctl` on PATH. */
  private systemd(): boolean {
    return (this.env.TENANDTWO_SYSTEMD_DIR ? existsSync(this.env.TENANDTWO_SYSTEMD_DIR) : existsSync("/run/systemd/system")) && which("systemctl", this.env) !== null;
  }
  /** No desktop session: logged in over SSH, or on a console. A user service there stops at logout unless it lingers. */
  private get headless() { return !!(this.env.SSH_CONNECTION || this.env.SSH_TTY) || !(this.env.DISPLAY || this.env.WAYLAND_DISPLAY); }
  /** Where it's noted that 10and2 turned on lingering, so turning its services off turns it off again. */
  private get lingerMark() { return join(stateDirectory(this.env), "linger"); }

  /**
   * With no desktop session, systemd stops a user's services when they log out, and starts them only when they log in
   * again: lingering keeps them running, and starts them at boot. Turned on when it's off (the user may turn it on for
   * their own account on most systems); what to run when that's refused. Null when there's nothing to say.
   */
  private async linger(): Promise<string | null> {
    if (!this.headless) return null;
    const user = userInfo().username;
    if ((await this.runner("loginctl", ["show-user", user, "--property=Linger", "--value"]))?.trim() === "yes") return null;
    if (await this.runner("loginctl", ["enable-linger", user]) !== null) {
      try { mkdirSync(dirname(this.lingerMark), { recursive: true, mode: 0o700 }); writeFileSync(this.lingerMark, `${user}\n`, { mode: 0o600 }); } catch { /* it's only for turning it off */ }
      return "Keeps running after you log out, and starts when the computer does (systemd lingering is on for your account)";
    }
    return `It stops when you log out, and starts when you next log in. To keep it running, run once: sudo loginctl enable-linger ${user}`;
  }
  /** Lingering off again when 10and2 turned it on and none of its services is left. */
  private async unlinger() {
    if (!existsSync(this.lingerMark) || [CONNECTOR, BRAIN].some((j) => existsSync(join(dirname(this.unit), j.unit)))) return;
    await this.runner("loginctl", ["disable-linger", userInfo().username]);
    rmSync(this.lingerMark, { force: true });
  }

  /** Whether this runs as administrator on Windows: a High or System mandatory label among its groups. */
  private async elevated(): Promise<boolean> {
    const groups = await this.runner(`${systemRoot(this.env)}\\System32\\whoami.exe`, ["/groups"]);
    return /\bS-1-16-(12288|16384)\b/.test(groups ?? "");
  }

  /** Polls until `done`, every 250 ms for up to `ms`; whether it got there. */
  private async until(done: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
    for (let waited = 0; ; waited += 250) {
      if (await done()) return true;
      if (waited >= ms) return false;
      await this.sleep(250);
    }
  }
  /** launchd unloads asynchronously: `bootout` returns before the job is gone, and a `bootstrap` then fails. */
  private async bootout() {
    await this.runner("launchctl", ["bootout", this.target]);
    await this.until(async () => await this.runner("launchctl", ["print", this.target]) === null);
  }

  /** Writes the service and starts it now (on Windows, unless this runs as administrator). Throws with what went wrong. */
  async install(l: Launch): Promise<ServiceState> {
    let elevated = false, note: string | null = null;
    if (this.platform === "darwin") {
      mkdirSync(join(this.home, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(join(this.home, "Library", "Logs"), { recursive: true });
      await this.bootout();
      writeFileSync(this.plist, launchAgent(l, this.logs, this.job), { mode: 0o644 });
      const loaded = await this.until(async () => await this.runner("launchctl", ["bootstrap", this.domain, this.plist]) !== null, 5000);
      if (!loaded) throw new Error("launchctl couldn't load the LaunchAgent");
    } else if (this.platform === "linux") {
      const why = this.unavailable(l);
      if (why) throw new Error(why);
      mkdirSync(join(this.unit, ".."), { recursive: true });
      writeFileSync(this.unit, systemdUnit(l, this.job), { mode: 0o644 });
      if (await this.runner("systemctl", ["--user", "daemon-reload"]) === null) {
        rmSync(this.unit, { force: true });
        throw new Error(this.env.XDG_RUNTIME_DIR ? NO_USER_SYSTEMD : `${NO_USER_SYSTEMD} This login has no XDG_RUNTIME_DIR: log in as yourself (ssh or the desktop) rather than through su or sudo.`);
      }
      if (await this.runner("systemctl", ["--user", "enable", "--now", this.job.unit]) === null) throw new Error(`systemctl --user couldn't start ${this.job.unit}`);
      await this.runner("systemctl", ["--user", "restart", this.job.unit]);
      note = await this.linger();
    } else if (this.platform === "win32") {
      const why = this.unavailable(l);
      if (why) throw new Error(why);
      // The PATH setup saw, for the supervisor to put first, as the other systems' services are given it.
      saveLogin(loginFile(this.job, this.env), lasting(l.path));
      // Started from a terminal run as administrator, the supervisor would be its child and run as administrator until
      // sign-out, where an ordinary terminal can't stop it. So then it starts at the next sign-in, and one already
      // running keeps running.
      elevated = await this.elevated();
      // One already running goes first, so the one started now runs this version with this PATH.
      if (!elevated) await this.stopSupervisor();
      if (await this.runner(this.reg, ["add", RUN_KEY, "/v", this.value, "/t", "REG_SZ", "/d", runEntry(this.job, this.env), "/f"]) === null) {
        throw new Error("Windows wouldn't add it to the programs it starts at login (reg add failed)");
      }
      // Turned off in Startup apps, Windows would still skip it at login. Asked to start it at login, it's turned back on.
      await this.runner(this.reg, ["delete", STARTUP_APPROVED, "/v", this.value, "/f"]);
      if (!elevated) this.start([...l.program, "login-service", this.job.name], { ...this.env, [HIDDEN]: "1" });
    } else throw new Error(`Starting at login isn't supported on ${this.platform}.`);
    // Both start the job asynchronously: give it a moment to be running before saying whether it is.
    let state = await this.state();
    if (elevated) return { ...state, elevated };
    await this.until(async () => (state = await this.state()).running);
    if (l.left?.length && this.platform !== "win32") note = [note, `${l.left.join(" and ")} ${l.left.length > 1 ? "have" : "has"} a password in it, which isn't written where it starts at login, so it connects without that proxy.`].filter(Boolean).join("\n");
    return note ? { ...state, note } : state;
  }

  async uninstall(): Promise<void> {
    if (this.platform === "darwin") {
      await this.bootout();
      rmSync(this.plist, { force: true });
    } else if (this.platform === "linux") {
      await this.runner("systemctl", ["--user", "disable", "--now", this.job.unit]);
      rmSync(this.unit, { force: true });
      await this.runner("systemctl", ["--user", "daemon-reload"]);
      await this.unlinger();
    } else if (this.platform === "win32") {
      await this.stopSupervisor();
      await this.runner(this.reg, ["delete", RUN_KEY, "/v", this.value, "/f"]);
    }
  }

  async state(): Promise<ServiceState> {
    if (this.platform === "darwin") {
      const out = existsSync(this.plist) ? await this.runner("launchctl", ["print", `${this.domain}/${this.job.label}`]) : null;
      return { installed: existsSync(this.plist), running: /\bstate = running\b/.test(out ?? ""), where: this.plist, logs: this.logs };
    }
    if (this.platform === "linux") {
      const out = existsSync(this.unit) ? await this.runner("systemctl", ["--user", "is-active", this.job.unit]) : null;
      return { installed: existsSync(this.unit), running: out?.trim() === "active", where: this.unit, logs: `journalctl --user -u ${this.job.unit}` };
    }
    if (this.platform === "win32") {
      // `reg query` fails when there's no such value. Startup apps' switch keeps a value whose first byte is odd for an
      // entry it has turned off, which Windows then skips at login; with no value there, it's on.
      const entry = await this.runner(this.reg, ["query", RUN_KEY, "/v", this.value]) !== null;
      const approved = entry ? await this.runner(this.reg, ["query", STARTUP_APPROVED, "/v", this.value]) : null;
      const off = parseInt(/REG_BINARY\s+([0-9A-F]{2})/i.exec(approved ?? "")?.[1] ?? "00", 16) % 2 === 1;
      return { installed: entry && !off, running: typeof await this.child() === "number", where: `${RUN_KEY}\\${this.value}`, logs: logFile(this.job, this.env) };
    }
    return { installed: false, running: false, where: "", logs: "" };
  }

  /** What the installed service runs, every argument, read back from its file; null when there's none. */
  program(): string[] | null {
    try {
      if (this.platform === "darwin") {
        const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(this.plist, "utf8"))?.[1];
        return array === undefined ? null : [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      }
      if (this.platform === "linux") {
        const exec = /^ExecStart=(.*)$/m.exec(readFileSync(this.unit, "utf8"))?.[1];
        return exec === undefined ? null : [...exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
      }
    } catch { /* not installed */ }
    return null;
  }

  /**
   * A file the installed service runs that's gone: its install was removed or upgraded away, so it can never start.
   * Every path counts, not only the first: an older service ran a Node that was still there and a script that wasn't.
   */
  missing(): string | null {
    return this.program()?.find((a) => a.startsWith("/") && !existsSync(a)) ?? null;
  }

  async restart(): Promise<void> {
    if (this.platform === "darwin") await this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.job.label}`]);
    if (this.platform === "linux") await this.runner("systemctl", ["--user", "restart", this.job.unit]);
    if (this.platform === "win32") await this.supervisor("restart", 15_000);
  }
}
