/**
 * Command-palette pure logic (feature-inventory Cat.2 "Command palette"). A port
 * of T3's CommandPalette.logic.ts as reduced in the vanilla frontend/index.html
 * (index.html:3556-3650): normalizeSearchText, the exact=3/prefix=2/substring=1
 * field ranker, the first-term-wins item ranker, recents-first session ordering,
 * and the ">"-prefix action filter + rank/index sort. No DOM, no Solid.
 */

/** An item the palette can list: a session or an action. */
export interface PaletteItem {
  title: string;
  /** searchable terms; earlier terms outrank later ones. */
  terms: string[];
  /** right-aligned hint text (session state / "current" / action hint). */
  meta?: string;
  danger?: boolean;
  /** keep keyboard focus on the item's own target (e.g. a name box) after run. */
  keepFocus?: boolean;
  run?: () => void;
}

/** A titled group of palette items with an optional inline note. */
export interface PaletteGroup {
  label: string;
  note: string | null;
  items: PaletteItem[];
}

/** Lowercase + trim (the shared normalizer). */
export function normalizeSearchText(s: unknown): string {
  return String(s).toLowerCase().trim();
}

/**
 * rankSearchFieldMatch port: exact=3, prefix=2, substring=1, no-match=-Infinity.
 * `q` is assumed already normalized.
 */
export function rankField(field: string, q: string): number {
  const f = normalizeSearchText(field);
  if (!f.length || !f.includes(q)) return -Infinity;
  if (f === q) return 3;
  if (f.startsWith(q)) return 2;
  return 1;
}

/**
 * rankCommandPaletteItemMatch port: the first matching term wins, and earlier
 * terms outrank later ones (1000 - i*100 + fieldRank). No term matches -> 0.
 */
export function rankItem(item: { terms: string[] }, q: string): number {
  const terms = item.terms.filter((t) => t.length > 0);
  if (!terms.length) return 0;
  for (let i = 0; i < terms.length; i++) {
    const r = rankField(terms[i]!, q);
    if (r !== -Infinity) return 1000 - i * 100 + r;
  }
  return 0;
}

/**
 * Recents-first: last-attach epoch desc (from `tl:session-visits:v1`);
 * never-visited keep the input order (the sort is stable). Non-mutating.
 *
 * Records are filed under tmux's session id where there is one, so that a
 * rename does not lose them; a session without an id, and a record written
 * before the switch, are still under the name. Look for both.
 */
export function recentsFirst<T extends { name: string; id?: string }>(
  sessions: T[],
  visitTimes: Record<string, number>,
): T[] {
  const at = (s: T): number => (s.id ? visitTimes[s.id] : undefined) ?? visitTimes[s.name] ?? 0;
  return sessions.slice().sort((a, b) => at(b) - at(a));
}

/**
 * filterCommandPaletteGroups port: a ">" prefix restricts to actions; an empty
 * query keeps natural order (with any "Loading sessions…" note); otherwise each
 * group is filtered on the joined terms and sorted rank-desc / index-asc, and
 * empty note-less groups drop out.
 */
export function buildGroups(
  query: string,
  opts: {
    sessionItems: PaletteItem[];
    actionItems: PaletteItem[];
    /** false while the session list is still loading (shows the note). */
    sessionsLoaded: boolean;
  },
): PaletteGroup[] {
  const isActions = query.startsWith(">");
  const q = normalizeSearchText(isActions ? query.slice(1) : query);
  const groups: PaletteGroup[] = [];
  if (!isActions) {
    groups.push({
      label: "Sessions",
      note: opts.sessionsLoaded ? null : "Loading sessions…",
      items: opts.sessionItems,
    });
  }
  groups.push({ label: "Actions", note: null, items: opts.actionItems });
  if (!q.length) return groups;
  return groups
    .map((g) => ({
      label: g.label,
      note: null,
      items: g.items
        .map((item, index) => ({ item, index, rank: rankItem(item, q) }))
        .filter((en) => normalizeSearchText(en.item.terms.join(" ")).includes(q))
        .sort((a, b) => b.rank - a.rank || a.index - b.index)
        .map((en) => en.item),
    }))
    .filter((g) => g.items.length > 0 || g.note);
}
