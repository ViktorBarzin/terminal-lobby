/**
 * Layout-proof chord parsing + matching — the pure core of the keybinding engine
 * (feature-inventory Cat.2 "Keybinding engine"). A faithful port of the vanilla
 * frontend/index.html `parseChord` / `eventChordKeys` / `eventMatchesChord` /
 * `evalWhen` (index.html:3371-3487), lifted out of the DOM so it is unit-testable
 * across keyboard layouts. No DOM, no Solid, no storage.
 *
 * The layout-proofing (why `e.code` aliases exist): a modifier can remap
 * `e.key` (Mac Option+/ = ÷, AZERTY Alt+1 = &, Shift+/ = ?), so a chord keyed
 * purely on `e.key` would silently stop matching. We therefore accept BOTH the
 * lowercased `e.key` AND the physical `e.code` alias (KeyN→n, Digit1→1,
 * BracketLeft→[, Slash→/), so Alt+1 fires on AZERTY, Alt+Shift+[ fires when the
 * layout shifts `[`, and Alt+/ matches even when Option renders a symbol.
 */

/** A parsed chord: the four modifier expectations + the single non-modifier key. */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** lowercased key identity (e.g. "n", "1", "[", "/", "enter", "backspace"). */
  key: string;
}

/** The subset of a KeyboardEvent the matcher reads (so tests can pass plain objects). */
export interface ChordEventLike {
  key?: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** only "keydown" events can match (keyup/keypress are ignored). */
  type?: string;
}

/** Modifier tokens that are never a chord's terminal key. */
export const MOD_WORDS = [
  "ctrl",
  "control",
  "shift",
  "alt",
  "option",
  "meta",
  "cmd",
  "super",
] as const;

/**
 * Parse a chord string ("alt+shift+[" -> {alt,shift,key:"["}), or null when it is
 * not a usable chord. Rules (verbatim from the vanilla port):
 *  - "+"-separated; case/space-insensitive; modifier synonyms folded
 *    (control->ctrl, option->alt, cmd/super->meta).
 *  - the LAST segment is the key; a non-modifier appearing before the last
 *    segment is invalid (null).
 *  - the key may not itself be a modifier word, and must be non-empty.
 *  - a bare key with no ctrl/alt/meta is rejected — those must keep reaching the
 *    pty (Shift-alone is not enough to claim a key).
 */
export function parseChord(s: unknown): Chord | null {
  if (typeof s !== "string") return null;
  const parts = s
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const c: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "ctrl" || p === "control") c.ctrl = true;
    else if (p === "shift") c.shift = true;
    else if (p === "alt" || p === "option") c.alt = true;
    else if (p === "meta" || p === "cmd" || p === "super") c.meta = true;
    else if (i === parts.length - 1) c.key = p;
    else return null;
  }
  if (!c.key || (MOD_WORDS as readonly string[]).includes(c.key)) return null;
  // bare keys (Shift-only included) must keep reaching the pty.
  if (!c.ctrl && !c.alt && !c.meta) return null;
  return c;
}

/**
 * The layout-proof key-identity set for an event: the lowercased `e.key` plus the
 * physical `e.code` aliases for letters, digits and the two brackets, plus a
 * Slash alias (which has no letter/digit alias). "esc" is normalized to "escape".
 */
export function eventChordKeys(e: { key?: string; code?: string }): Set<string> {
  const keys = new Set<string>();
  if (typeof e.key === "string" && e.key) {
    const k = e.key.toLowerCase();
    keys.add(k === "esc" ? "escape" : k);
  }
  const code = e.code || "";
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (m) keys.add((m[1] || m[2])!.toLowerCase());
  if (code === "BracketLeft") keys.add("[");
  if (code === "BracketRight") keys.add("]");
  // Slash has no letter/digit alias; add it so Alt+/ matches even when a
  // modifier remaps e.key (Mac Option+/ = divide, Shift+/ = ?).
  if (code === "Slash") keys.add("/");
  return keys;
}

/**
 * Exact modifier match + key membership. Every one of ctrl/shift/alt/meta must
 * equal the chord's expectation — so AltGr typing (Ctrl+Alt) can never trip an
 * alt-only binding — and the chord's key must be one of the event's layout-proof
 * identities.
 */
export function eventMatchesChord(e: ChordEventLike, c: Chord | null): boolean {
  return (
    !!c &&
    e.ctrlKey === c.ctrl &&
    e.metaKey === c.meta &&
    e.shiftKey === c.shift &&
    e.altKey === c.alt &&
    eventChordKeys(e).has(c.key)
  );
}

/**
 * Tiny when-clause evaluator: identifiers, "!", "&&", "||" (no parens — the
 * binding table needs no more). Unknown identifiers read as false. An empty
 * clause is always true.
 */
export function evalWhen(
  expr: string | undefined,
  ctx: Record<string, boolean>,
): boolean {
  if (!expr) return true;
  return expr.split("||").some((disj) =>
    disj.split("&&").every((frag) => {
      let f = frag.trim();
      let neg = false;
      while (f.startsWith("!")) {
        neg = !neg;
        f = f.slice(1).trim();
      }
      const v = !!ctx[f];
      return neg ? !v : v;
    }),
  );
}
