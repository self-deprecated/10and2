// What the person at the terminal sees: marks, colour, a spinner and prompts. Colour and motion only on a terminal
// (and never with NO_COLOR); piped or under a service manager, it's plain lines.
import { createInterface } from "node:readline";
import { styleText } from "node:util";

const tty = () => Boolean(process.stdout.isTTY);
type Style = Parameters<typeof styleText>[0];
const paint = (style: Style, s: string) => styleText(style, s, { stream: process.stdout });

export const bold = (s: string) => paint("bold", s);
export const dim = (s: string) => paint("dim", s);
export const accent = (s: string) => paint("magenta", s);
/** A command to type, like `10and2 status`. */
export const cmd = (s: string) => paint("cyan", s);

export const say = (s = "") => console.log(s);
export const ok = (s: string) => say(`  ${paint("green", "✓")} ${s}`);
export const warn = (s: string) => say(`  ${paint("yellow", "!")} ${s}`);
export const bad = (s: string) => say(`  ${paint("red", "✗")} ${s}`);
export const note = (s: string) => say(`    ${s}`);

/** "3 minutes", "2 hours": how long ago an ISO time was. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const [n, unit] = s < 60 ? [s, "second"] : s < 3600 ? [Math.floor(s / 60), "minute"] : s < 86400 ? [Math.floor(s / 3600), "hour"] : [Math.floor(s / 86400), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A line that spins while something runs, then becomes ✓, ! or ✗ with its outcome. Plain text off a terminal. */
export function spinner(text: string) {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  let current = text;
  const draw = () => process.stdout.write(`\r\x1b[2K  ${accent(frames[i++ % frames.length])} ${current}`);
  const timer = tty() ? setInterval(draw, 80) : null;
  if (timer) draw(); else say(`  … ${text}`);
  const end = (mark: (s: string) => void) => (s: string) => {
    if (timer) { clearInterval(timer); process.stdout.write("\r\x1b[2K"); }
    mark(s);
  };
  return {
    set: (s: string) => { current = s; if (timer) draw(); },
    ok: end(ok), warn: end(warn), bad: end(bad),
    /** Clears the line without a mark (a prompt or message takes over). */
    clear: () => { if (timer) { clearInterval(timer); process.stdout.write("\r\x1b[2K"); } },
  };
}

/** Thrown when the person presses Ctrl-C at a prompt; the command says "Cancelled." and exits 130. */
export class Cancelled extends Error { constructor() { super("Cancelled."); } }

function question(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.on("SIGINT", () => { rl.close(); say(); reject(new Cancelled()); });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

/** A yes/no question; Enter takes the default. Off a terminal, the default. */
export async function confirm(q: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const a = (await question(`  ${accent("?")} ${q} ${dim(fallback ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
  return a === "" ? fallback : a.startsWith("y");
}

/** A line of text; Enter keeps the default. Off a terminal, the default. */
export async function ask(q: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  return (await question(`  ${accent("?")} ${q} ${dim(`(${fallback})`)} `)).trim() || fallback;
}

/** A secret, typed or pasted without being shown. Off a terminal, empty. */
export function secret(q: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.resolve("");
  process.stdout.write(`  ${accent("?")} ${q} `);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let s = "";
    const done = (f: () => void) => { input.off("data", onData); input.setRawMode(false); input.pause(); say(); f(); };
    const onData = (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\u0003") return done(() => reject(new Cancelled()));
        if (ch === "\r" || ch === "\n") return done(() => resolve(s.trim()));
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else if (ch >= " ") s += ch;
      }
    };
    input.on("data", onData);
  });
}

/**
 * While waiting on something else: Enter calls `onEnter`, Ctrl-C calls `onCancel`. Returns a function that stops
 * listening. Does nothing off a terminal (Ctrl-C is then the usual SIGINT).
 */
export function keys(onEnter: () => void, onCancel: () => void): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => {};
  input.setRawMode(true);
  input.resume();
  const onData = (b: Buffer) => {
    if (b[0] === 3) onCancel(); // Ctrl-C, as raw mode delivers it
    else if (b[0] === 13 || b[0] === 10) onEnter();
  };
  input.on("data", onData);
  return () => { input.off("data", onData); input.setRawMode(false); input.pause(); };
}

/** A row of a checklist: a box to switch, or a choice cycled with ← and →. Disabled rows can't change. */
export type Row =
  | { kind: "box"; label: string; detail?: string; on: boolean; disabled?: boolean; open?: boolean }
  | { kind: "choice"; label: string; options: string[]; index: number; detail?: string };
/** `back`: ← on a box finishes, as on a screen opened from another. */
export type ListState = { rows: Row[]; at: number; back?: boolean };
export type ListKey = "up" | "down" | "space" | "left" | "right" | "enter" | "cancel" | "other";
export type ListOutcome = { done: boolean; cancelled?: boolean; open?: number };

/**
 * One key on a checklist, as a pure step so it can be tested: ↑↓ move (skipping nothing), space switches a box, → on a
 * box that opens (an agent's own permissions) asks to open it, ← → cycle a choice, Enter finishes.
 */
export function listStep(s: ListState, key: ListKey): ListOutcome {
  const row = s.rows[s.at]!;
  switch (key) {
    case "up": s.at = (s.at + s.rows.length - 1) % s.rows.length; break;
    case "down": s.at = (s.at + 1) % s.rows.length; break;
    case "space": if (row.kind === "box" && !row.disabled) row.on = !row.on; break;
    case "right":
      if (row.kind === "choice") row.index = (row.index + 1) % row.options.length;
      else if (row.open && !row.disabled && row.on) return { done: true, open: s.at };
      break;
    case "left":
      if (row.kind === "choice") row.index = (row.index + row.options.length - 1) % row.options.length;
      else if (s.back) return { done: true };
      break;
    case "enter": return { done: true };
    case "cancel": return { done: true, cancelled: true };
  }
  return { done: false };
}

function drawList(title: string, s: ListState, hint: string): string[] {
  const lines = [`  ${title}`];
  s.rows.forEach((r, i) => {
    const cursor = i === s.at ? accent("❯") : " ";
    if (r.kind === "box") {
      const mark = r.disabled ? dim("○") : r.on ? paint("green", "◉") : dim("○");
      const label = r.disabled ? dim(r.label) : r.label;
      lines.push(`  ${cursor} ${mark} ${label.padEnd(14)}${r.detail ? ` ${dim(r.detail)}` : ""}`);
    } else {
      lines.push(`  ${cursor}   ${r.label}  ${accent(`◂ ${r.options[r.index]} ▸`)}${r.detail ? `  ${dim(r.detail)}` : ""}`);
    }
  });
  lines.push("", `  ${dim(hint)}`);
  return lines;
}

/**
 * A checklist at the terminal, redrawn in place, until Enter (or → on a row that opens). Off a terminal it returns at
 * once with the rows as given: the defaults apply.
 */
export async function checklist(title: string, rows: Row[], hint: string, opts: { back?: boolean } = {}): Promise<{ rows: Row[]; open?: number }> {
  const s: ListState = { rows, at: Math.max(0, rows.findIndex((r) => r.kind === "choice" || !r.disabled)), back: opts.back };
  if (!process.stdin.isTTY || !tty()) return { rows };
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let drawn = 0;
  const render = () => {
    const lines = drawList(title, s, hint);
    if (drawn) process.stdout.write(`\x1b[${drawn}A`);
    for (const l of lines) process.stdout.write(`\r\x1b[2K${l}\n`);
    drawn = lines.length;
  };
  render();
  try {
    return await new Promise((resolve, reject) => {
      const onKey = (_: string, k: { name?: string; ctrl?: boolean } | undefined) => {
        const name = k?.name;
        const key: ListKey = (k?.ctrl && name === "c") || (!k?.ctrl && name === "q") ? "cancel" : name === "up" || name === "k" ? "up" : name === "down" || name === "j" ? "down"
          : name === "space" ? "space" : name === "left" || name === "h" ? "left" : name === "right" || name === "l" ? "right"
          : name === "return" || name === "enter" ? "enter" : name === "escape" ? "enter" : "other";
        const out = listStep(s, key);
        render();
        if (!out.done) return;
        process.stdin.removeListener("keypress", onKey);
        if (out.cancelled) reject(new Cancelled()); else resolve({ rows: s.rows, ...(out.open !== undefined ? { open: out.open } : {}) });
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
