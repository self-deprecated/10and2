// Opening the approval page in the browser, where there's a desktop to open it on. The address is printed anyway.
import { spawnCommand, which } from "./command.ts";

/**
 * What opens `url` here, or null. On Windows its own handler for a link (rundll32), run without a shell, so the `&` in
 * a URL is never read as a command; but not over SSH, which has no desktop: there each try opens nothing and leaves an
 * invisible "How do you want to open this?" (OpenWith.exe) running until it's ended.
 */
export function opener(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "linux") return ["xdg-open", url];
  if (platform === "win32" && !env.SSH_CONNECTION && !env.SSH_CLIENT) return ["rundll32", "url.dll,FileProtocolHandler", url];
  return null;
}

export function openBrowser(url: string) {
  // Each is found on PATH first, so one of that name in the current folder never runs.
  const [command, ...args] = opener(url) ?? [];
  if (!command || !which(command)) return;
  // Not hidden: rundll32 passes its window's state on to a browser it starts, which would then open with no window.
  try { spawnCommand(command, args, { stdio: "ignore", detached: true, windowsHide: false }).on("error", () => {}).unref(); } catch { /* the URL is printed anyway */ }
}
