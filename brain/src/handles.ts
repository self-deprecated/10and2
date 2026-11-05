// Spoken handles: the names the voice agent uses instead of IDs. A handle is the thread's own title, said aloud,
// because that's what the user sees in T3; titles can repeat, so uniqueness and resolution are done in code.

/** A title as it's said: "Driver iOS → TestFlight (Quartz)" becomes "Driver iOS to TestFlight, Quartz". */
export function spokenTitle(title: string): string {
  return title
    .replace(/\s*(→|->|=>)\s*/g, " to ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s*\(([^)]*)\)/g, ", $1")
    .replace(/[*_`#[\]\uE000]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const norm = (s: string) => s.toLowerCase().replace(/([ap])\.m\.(?=\W|$)/g, "$1m").replace(/(\d)(am|pm)\b/g, "$1 $2").replace(/\b(\d{1,2}):00(?=\s*(?:am|pm)\b)/g, "$1").replace(/[^a-z0-9]+/g, " ").trim();

const STOP = new Set(
  "a an and the to of in on for with then that this these those it its is be by at from one ones thread threads please just".split(" "),
);
/** Crude stem so "settle"/"settles"/"settled"/"settling" and "rollouts"/"rollout" meet. */
export const stem = (w: string) => {
  const s = w.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");
  return s.length >= 2 ? s : w;
};

const UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * Numbers said as words become digits: "thirteen" → 13, "twenty one" → 21. A lone "one" stays a word unless `one` is
 * set: people say "the noctalia one", so naming a thread keeps it, while checking a readback (where every word is the
 * readback's) reads it as 1.
 */
function digits(words: string[], one: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const u0 = UNITS.indexOf(w);
    if (u0 >= 1 && u0 <= 9 && words[i + 1] === "hundred") {
      // "one hundred and twenty three" → 123
      let n = u0 * 100;
      i++;
      if (words[i + 1] === "and") i++;
      const t = TENS[words[i + 1]];
      if (t) {
        n += t;
        i++;
        const u = UNITS.indexOf(words[i + 1]);
        if (u >= 1 && u <= 9) (n += u), i++;
      } else {
        const u = UNITS.indexOf(words[i + 1]);
        if (u >= 1) (n += u), i++;
      }
      out.push(String(n));
    } else if (w in TENS) {
      const u = UNITS.indexOf(words[i + 1]);
      if (u >= 1 && u <= 9) i++;
      out.push(String(TENS[w] + (u >= 1 && u <= 9 ? u : 0)));
    } else if (UNITS.includes(w) && (one || w !== "one")) out.push(String(UNITS.indexOf(w)));
    else out.push(/^0\d$/.test(w) ? String(Number(w)) : w);
  }
  return out;
}

/** The words of a name or of a request, with spoken numbers as digits: "Fix login in proj thirteen" → […, "proj", "13"]. */
export const tokens = (s: string) => digits(norm(s).split(" ").filter(Boolean), false);

/** Clause marks in speechTokens. Words are lowercase letters and digits only, so no word can equal a mark. */
const BREAK = ".";
const COMMA = ",";
/**
 * Where the voice model began a new utterance (after a hand-off or a tool result). The brain writes it into its own copy
 * of what was said (`UTTERANCE` in Conversations), never into the transcript, so it can start a sentence the live
 * transcript glued on ("Let me check.Settle Agent Reel."), but it never ends one: "ASP.NET" split by a hand-off is
 * still one word.
 */
export const UTTERANCE = "\uE000";
const START = ">";
/**
 * What was said, word for word, with every number as digits, and clause marks where punctuation ends a word: a sentence
 * or clause end (. ? ! : ;), a dash between words, or a comma. Punctuation inside a word ("v1.2", "1,000", "ASP.NET",
 * "README.md", "To-dos") is not a mark, but a sentence end glued to a capitalised word is ("Okay.Snooze Agent Reel"): the
 * live transcript doesn't space two utterances, and the brain's own mark (`UTTERANCE`) lands only before the first words
 * after a tool result, which may be a filler said late. So is a word the voice model cut off ("Ok- Start a new thread…",
 * 2 November: the readback that followed wasn't heard, and the user's "Do it" was refused).
 */
export function speechTokens(s: string): string[] {
  const out: string[] = [];
  // Utterances the voice model starts afresh are also separated where the transcript is recorded (VoiceSession).
  for (const part of s.split(/([.?!:;]+(?=\s|$|["'”’)])|[.?!]+(?=[A-Z][a-z])|,(?=\s|$)|[–—]+|(?<=[\p{L}\p{N}])-+(?=\s|$)|(?<=\s)-+(?=\s)|\uE000)/u)) {
    if (!part) continue;
    if (part === UTTERANCE) out.push(START);
    else if (/^(?:[.?!:;]+|[-–—]+)$/.test(part)) out.push(BREAK);
    else if (part === ",") out.push(COMMA);
    else out.push(...digits(norm(part).split(" ").filter(Boolean), true));
  }
  return out;
}

/**
 * A name as heard: its words, numbers as digits, no marks. The one key for "do these names sound the same": handles are
 * made unique under it, and the heard gate compares with it. Symbols and emoji aren't heard, so "Fix C++ compiler" and
 * "Fix C compiler" share a key, and get told apart in their handles instead.
 */
export const sayKey = (s: string) => speechTokens(s).filter((w) => !mark(w)).join(" ");

const mark = (w: string | undefined) => w === BREAK || w === COMMA || w === START;
/** Whether a speechTokens token is a clause mark rather than a word. */
export const isMark = (w: string) => mark(w);

/**
 * Whether `spoken` (speechTokens) says `head` word for word as the start of a clause, ignoring marks between its words
 * (titles have commas: "TestFlight, Quartz"), followed by `next` or, when `next` is null, by the end of a sentence:
 * "Okay. Archive Agent Reel. Shall I…" and "Archive Agent Reel, shall I go ahead?" say "archive agent reel";
 * "Archive Agent Reel's dashboard", "Archive Agent Reel, the dashboard", "Archive Agent Reel Dashboard" and "Archive
 * Archive Agent Reel" don't. `where` may follow the head, word for word: the thread's project, "in sd", which a
 * readback says but which the name alone already identifies, or only its first clauses ("in sd" of "in sd, on
 * Quartz"), when `where` keeps its clause marks.
 */
export function saysHead(spoken: string[], head: string[], next: string | null, where: string[] = []): boolean {
  start: for (let i = 0; i < spoken.length; i++) {
    // A clause starts after any mark, including where a new utterance began.
    if (i > 0 && !mark(spoken[i - 1])) continue;
    let j = i;
    for (const w of head) {
      if (j > i) while (mark(spoken[j])) j++;
      if (spoken[j++] !== w) continue start;
    }
    if (where.length) {
      // The place may also stop at one of its own clause ends: "in sd" of "in sd, on Quartz" (the voice model often
      // leaves the machine out). The name alone already identifies the thread, so each clause of the place is optional.
      let k = j;
      let clause = -1;
      for (const w of where) {
        if (mark(w)) {
          clause = k;
          continue;
        }
        while (mark(spoken[k])) k++;
        if (spoken[k++] !== w) {
          k = -1;
          break;
        }
      }
      if (k >= 0) j = k;
      else if (clause >= 0) j = clause;
    }
    if (next === null) {
      // Only a real sentence end finishes the name; never the end of what's been said so far (the name may go on:
      // "Agent Reel" → "… Dashboard"), nor an utterance start. A comma does only before the readback's own question.
      if (spoken[j] === BREAK || (spoken[j] === COMMA && spoken[j + 1] === "shall")) return true;
      continue;
    }
    while (mark(spoken[j])) j++;
    if (spoken[j] === next) return true;
  }
  return false;
}

/** The words that identify a name, as said (not stemmed). Numbers count, even one digit: "proj 2" is not "proj". */
export function wordsOf(s: string, one = false): string[] {
  return [...new Set(digits(norm(s).split(" ").filter(Boolean), one).filter((w) => (w.length > 1 || /^\d$/.test(w)) && !STOP.has(w)))];
}

/** `wordsOf`, stemmed for comparing. Stem once only: stemming is not idempotent ("release" → "releas" → "rele"). */
export function keyWords(s: string, one = false): string[] {
  return [...new Set(wordsOf(s, one).map(stem))];
}


/**
 * Whether `said` names this thread rather than another whose name contains it: "Agent Reel Dashboard says…" mentions
 * "Agent Reel Dashboard", not "Agent Reel". When in doubt it says no, which only keeps a reply as news.
 */
export function mentionsThread(said: string, name: string, others: string[]): boolean {
  if (!mentions(said, name)) return false;
  const mine = new Set(keyWords(name, true));
  return !others.some((o) => {
    const theirs = keyWords(o, true);
    return theirs.length > mine.size && [...mine].every((w) => theirs.includes(w)) && mentions(said, o);
  });
}

/** Whether `said` names `name` the way the briefing's names are heard: most of its words (all, for up to three). */
export function mentions(said: string, name: string): boolean {
  const words = keyWords(name, true);
  const heard = new Set(keyWords(said, true));
  const need = words.length <= 3 ? words.length : Math.ceil((words.length * 2) / 3);
  return words.filter((w) => heard.has(w)).length >= need;
}

export type Named = { id: string; handle: string; group: string; title: string };

/** Makes every handle sound distinct (`sayKey`): a duplicate gets "in <group>", then a number if still clashing. */
export function uniqueHandles(items: Named[]): Map<string, string> {
  const out = new Map<string, string>();
  const byHandle = new Map<string, Named[]>();
  for (const it of items) {
    const k = sayKey(it.handle);
    byHandle.set(k, [...(byHandle.get(k) ?? []), it]);
  }
  const taken = new Set<string>();
  for (const group of byHandle.values()) {
    for (const it of group) {
      let h = it.handle.trim() || it.title;
      if (group.length > 1) h = `${h} in ${it.group}`;
      let n = 2;
      const base = h;
      while (taken.has(sayKey(h))) h = `${base} ${n++}`;
      taken.add(sayKey(h));
      out.set(it.id, h);
    }
  }
  return out;
}

/** Where a thread is, as said after its name: "in driver", "in expo, on Quartz", "with no project". */
export const inGroup = (group: string) => (/^(no|unknown) project$/i.test(group.trim()) ? `with ${group.trim().toLowerCase()}` : `in ${group}`);

/**
 * A thread as Driver says it: its name and its project, "Agent Reel, in sd". A name made unique by its project
 * ("Fix login in driver") already says it. `mid`: a sentence goes on after it ("Agent Reel, in sd, is settled").
 */
export function withGroup(handle: string, group: string, mid = false): string {
  const where = inGroup(group);
  return ` ${sayKey(handle)} `.includes(` ${sayKey(where)} `) ? handle : `${handle}, ${where}${mid ? "," : ""}`;
}

export type Resolution = { kind: "match"; item: Named } | { kind: "ambiguous"; options: Named[] } | { kind: "none" };

/** A spoken name as compared exactly, numbers as digits: "the Fix login in proj two thread" → "fix login in proj 2". */
export const nameKey = (spoken: string) => tokens(spoken).join(" ").replace(/^(the|a) /, "").replace(/ (thread|one)$/, "");

const exactly = (spoken: string, items: Named[]) => {
  const key = nameKey(spoken);
  return items.filter((it) => nameKey(it.handle) === key || nameKey(it.title) === key);
};

/**
 * Which thread the user means, in this order: the thread a name already meant earlier in the conversation (`aliasId`),
 * an open thread with exactly that name, a settled one with exactly that name, then the closest open name, then the
 * closest settled one. Settled threads are only ever reported, never picked. A remembered name that now also exactly
 * names another thread is ambiguous: ask, don't guess.
 */
export function pick(spoken: string, open: Named[], settled: Named[], aliasId: string | null): Resolution | { kind: "settled"; item: Named } {
  const exactOpen = exactly(spoken, open);
  const remembered = aliasId ? open.find((it) => it.id === aliasId) : undefined;
  // A name that meant a thread now settled still means that thread: say so rather than drift to a similar open one.
  const rememberedSettled = aliasId && !remembered ? settled.find((it) => it.id === aliasId) : undefined;
  if (rememberedSettled) return { kind: "settled", item: rememberedSettled };
  if (remembered) {
    const others = exactOpen.filter((it) => it.id !== remembered.id);
    return others.length ? { kind: "ambiguous", options: [remembered, ...others].slice(0, 3) } : { kind: "match", item: remembered };
  }
  if (!exactOpen.length) {
    const exactSettled = exactly(spoken, settled);
    if (exactSettled.length) return { kind: "settled", item: exactSettled[0] };
  }
  const r = resolve(spoken, open);
  if (r.kind !== "none") return r;
  const s = resolve(spoken, settled);
  return s.kind === "match" ? { kind: "settled", item: s.item } : { kind: "none" };
}

/**
 * A project's name as compared with a spoken one: "agent-hearth" and "expo, on Quartz" are said "agent hearth" and
 * "expo on quartz", or just "expo".
 */
const projectKeys = (group: string) => [nameKey(group), nameKey(group.replace(/, on [\w-]+$/, ""))];

/**
 * Matches what the user (or the model) called something against the known items. An exact handle or
 * title wins. Then a project's name alone ("the agent hearth thread") names that project's thread when it has
 * just one; with several (or a thread elsewhere whose own name says it all), it's for the user to say which.
 * Otherwise a candidate must cover most of the spoken words with words from its handle or title, and ties go
 * to the tighter name.
 */
export function resolve(spoken: string, items: Named[]): Resolution {
  const q = keyWords(spoken);
  if (q.length === 0) return { kind: "none" };
  const key = nameKey(spoken);
  for (const field of ["handle", "title"] as const) {
    const exact = items.filter((it) => norm(it[field]) === key);
    if (exact.length === 1) return { kind: "match", item: exact[0] };
    if (exact.length > 1) return { kind: "ambiguous", options: exact.slice(0, 3) };
  }
  const scored = items
    .map((it) => {
      const h = new Set(keyWords(it.handle));
      const t = new Set(keyWords(it.title));
      const g = new Set(keyWords(it.group));
      const named = q.filter((w) => h.has(w) || t.has(w)).length;
      const covered = q.filter((w) => h.has(w) || t.has(w) || g.has(w)).length;
      const score = q.reduce((s, w) => s + (h.has(w) ? 2 : t.has(w) ? 1 : 0), 0);
      // Words in the candidate's handle the user didn't say: fewer means a tighter match.
      const extra = [...h].filter((w) => !q.includes(w)).length;
      return { it, named, covered, score, extra };
    })
    .filter((x) => x.named > 0 && x.covered >= Math.ceil((q.length * 2) / 3))
    .sort((a, b) => b.score - a.score || a.extra - b.extra);
  const project = key.replace(/ project$/, "");
  const inProject = items.filter((it) => projectKeys(it.group).includes(project));
  if (inProject.length) {
    const named = scored.filter((x) => x.named === q.length && !inProject.includes(x.it)).map((x) => x.it);
    const all = [...inProject, ...named];
    return all.length === 1 ? { kind: "match", item: all[0] } : { kind: "ambiguous", options: all.slice(0, 3) };
  }
  if (scored.length === 0) return { kind: "none" };
  // Two names that each contain everything the user said: ask rather than guess.
  const full = scored.filter((x) => x.covered === q.length);
  if (full.length > 1) return { kind: "ambiguous", options: full.slice(0, 3).map((x) => x.it) };
  if (full.length === 1) return { kind: "match", item: full[0].it };
  const best = scored[0];
  const tied = scored.filter((x) => x.score === best.score && x.extra === best.extra);
  if (tied.length > 1) return { kind: "ambiguous", options: tied.slice(0, 3).map((x) => x.it) };
  return { kind: "match", item: best.it };
}
