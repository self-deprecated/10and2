// Where new threads can start, as the user says them. Every machine's work systems list their projects ("places"), and
// two of them can say the same: T3 Code's "nix" and Claude Code's (or Codex's, Pi's, OpenCode's) "nix" for the same checkout both arrive as "nix, on
// Lattice" (8 November: "nix, on Lattice" could mean "nix, on Lattice and nix, on Lattice", for 100 s). A name no voice
// can tell apart is never offered: each place here is said its own way, or, failing that, only one of them is offered.
import type { Place } from "./adapter.ts";
import { sayKey } from "./handles.ts";

/** A place's name without its machine ("nix" of "nix, on Lattice"), and the machine part. */
const parts = (name: string) => {
  const m = /^(.*?)(, on [\w-]+)?$/.exec(name)!;
  return { base: m[1], on: m[2] ?? "" };
};
const renamed = (p: Place, extra: string) => ({ ...p, name: `${parts(p.name).base} (${extra})${parts(p.name).on}` });

/** The coding agents a connector names by a prefix (after the machine's own); T3 Code's places have none. */
const AGENTS: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };
/** The agent a place belongs to, said ("Claude Code"), or null for T3 Code's. */
const agentOf = (p: Place) => AGENTS[/(?:^|\|)(claude|codex|pi|opencode):/.exec(p.id)?.[1] ?? ""] ?? null;

/** A folder as said: "mono/nix" is "mono nix". */
const folderWords = (folder: string) => folder.replace(/[/\\]+/g, " ").trim();

const byKey = (places: Place[]) => {
  const groups = new Map<string, Place[]>();
  for (const p of places) groups.set(sayKey(p.name), [...(groups.get(sayKey(p.name)) ?? []), p]);
  return groups;
};

/**
 * Places with names no two of which sound the same: where two do, each coding agent's but T3 Code's says its agent,
 * "nix (Claude Code), on Lattice", "nix (Codex), on Lattice";
 * still alike (two projects with one name), each says its folder when the connector gives one ("nix (mono nix)"); and
 * with no folder to tell them apart, only the one active most recently is offered. Order kept. Pure, for tests.
 */
export function spokenPlaces(places: Place[]): Place[] {
  const tagged = places.map((p) => { const agent = agentOf(p); return agent && (byKey(places).get(sayKey(p.name))?.length ?? 0) > 1 ? renamed(p, agent) : p; });
  const keep = new Map<string, Place>();
  for (const group of byKey(tagged).values()) {
    const folders = new Set(group.map((p) => p.folder ?? ""));
    if (group.length > 1 && !folders.has("") && folders.size === group.length) {
      for (const p of group) keep.set(p.id, renamed(p, folderWords(p.folder!)));
      continue;
    }
    const newest = [...group].sort((a, b) => Number(agentOf(a) !== null) - Number(agentOf(b) !== null) || (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))[0];
    keep.set(newest.id, newest);
  }
  return tagged.flatMap((p) => (keep.has(p.id) ? [keep.get(p.id)!] : []));
}

/**
 * Other names the user may say for a place: its repository's ("mono-nix"), its folder ("mono nix", "nix"). Matched when
 * the name itself doesn't.
 */
export function otherNames(p: Place): string[] {
  const folder = p.folder ? [folderWords(p.folder), folderWords(p.folder).split(" ").at(-1)!] : [];
  return [...new Set([...(p.repo ? [p.repo] : []), ...folder])].filter(Boolean);
}
