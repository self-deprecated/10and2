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

/** The coding apps a new thread can start in, as said. A connector names each by a prefix (after the machine's own); T3 Code's places have none. */
export const APPS = { t3: "T3 Code", claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" } as const;
export type App = keyof typeof APPS;
const appOf = (p: Place): App => (/(?:^|\|)(claude|codex|pi|opencode):/.exec(p.id)?.[1] as App | undefined) ?? "t3";
/** The agent a place belongs to, said ("Claude Code"), or null for T3 Code's. */
const agentOf = (p: Place) => (appOf(p) === "t3" ? null : APPS[appOf(p)]);

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

/**
 * A place as the phone's Settings → New threads lists it: its project (its name without its machine or its coding app,
 * a folder that tells two apart kept: "nix (mono nix)"), its machine as said ("Lattice"; null on a brain with one) and
 * its coding app. Takes a name as given or as `spokenPlaces` says it.
 */
export function placeParts(p: Place): { project: string; machine: string | null; app: App } {
  const { base, on } = parts(p.name);
  const app = appOf(p);
  const tag = ` (${APPS[app]})`;
  return { project: base.endsWith(tag) ? base.slice(0, -tag.length) : base, machine: on ? on.slice(", on ".length) : null, app };
}

/**
 * What a new thread uses when the user doesn't say (Settings → New threads on the phone, sent with each call): a project
 * as `placeParts` gives it, a machine, a coding app. Null: not set, so Driver asks, as before.
 */
export type NewThreadDefaults = { project: string | null; machine: string | null; app: App | null };
export const NO_DEFAULTS: NewThreadDefaults = { project: null, machine: null, app: null };
export const hasDefaults = (d: NewThreadDefaults) => d.project !== null || d.machine !== null || d.app !== null;

/** The phone's `newThreadDefaults`, each part a short string (an app one of `APPS`) or not set. An older phone sends none. */
export function newThreadDefaultsOf(v: unknown): NewThreadDefaults {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const text = (s: unknown) => (typeof s === "string" && s.trim() && s.trim().length <= 100 ? s.trim() : null);
  return { project: text(o.project), machine: text(o.machine), app: Object.hasOwn(APPS, String(o.app)) ? (o.app as App) : null };
}

/** Whether `said` names one of `names`, as whole words. */
const names = (said: string, names: string[]) => names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(said));

/**
 * `places` with the user's defaults applied, for picking where a new thread starts: a project on several machines keeps
 * only those on the default machine, then only those in the default coding app, when it has any there. The user's own
 * words win: what they said (`said`) naming a machine ("… on Quartz") or a coding app ("… in Claude Code") leaves that
 * choice to them, and a project the prompt was dictated for (`placeId`) keeps all of its places. Order kept. Pure.
 */
export function preferred(places: Place[], d: NewThreadDefaults, said = "", placeId: string | null = null): Place[] {
  if (d.machine === null && d.app === null) return places;
  const machines = [...new Set(places.map((p) => placeParts(p).machine).filter((m): m is string => m !== null))];
  const machineSaid = names(said, machines.map((m) => `on ${m}`));
  const appSaid = names(said, [...Object.values(APPS), "open code"]);
  const groups = new Map<string, Place[]>();
  for (const p of places) groups.set(sayKey(placeParts(p).project), [...(groups.get(sayKey(placeParts(p).project)) ?? []), p]);
  const keep = new Set<string>();
  for (const group of groups.values()) {
    let left = group;
    if (!group.some((p) => p.id === placeId)) {
      const on = d.machine && !machineSaid ? left.filter((p) => placeParts(p).machine?.toLowerCase() === d.machine!.toLowerCase()) : [];
      if (on.length) left = on;
      // The app chooses among one machine's places only: never a machine of its own.
      if (d.app && !appSaid) {
        const machine = (p: Place) => placeParts(p).machine ?? "";
        left = left.filter((p) => placeParts(p).app === d.app || !left.some((o) => machine(o) === machine(p) && placeParts(o).app === d.app));
      }
    }
    for (const p of left) keep.add(p.id);
  }
  return places.filter((p) => keep.has(p.id));
}
