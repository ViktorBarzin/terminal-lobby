/**
 * The declarative keybinding table + the pure resolve/normalize/match layer
 * (feature-inventory Cat.2 "Keybinding engine"). Ported from the vanilla
 * frontend/index.html `KB_DEFAULT_BINDINGS` / `KB_ALWAYS_BINDINGS` /
 * `normalizeKeybindings` / `resolveBindings` / `matchesAppChord`
 * (index.html:3311-3516). No DOM, no Solid, no storage — the engine (engine.ts)
 * wires these to `localStorage` + the window listeners.
 *
 * Two binding sets:
 *  - DEFAULT bindings are opt-in-toggleable (the `enabled` gate) and
 *    user-overridable via `tl:keybindings:v1.overrides`.
 *  - ALWAYS bindings fire regardless of the `enabled` gate (they bypass it),
 *    are never overridable, and still honor their `when` clause.
 *
 * v2 deviation from the vanilla table (documented, deliberate): the vanilla
 * always-on `Ctrl+J`/`Cmd+J -> session.new.shell` (open the scratch-shell dock)
 * is DROPPED here — v2 has no dock yet, and Ctrl/Cmd+J is instead the text<->
 * terminal view toggle owned by SessionView. The dock chord returns when the
 * dock pillar lands.
 */
import {
  eventMatchesChord,
  evalWhen,
  parseChord,
  type Chord,
  type ChordEventLike,
} from "./chords.logic";

/** One row of the declarative table. */
export interface Binding {
  key: string;
  command: string;
  when?: string;
}

/** A binding with its chord parsed (or null when the chord string was garbage). */
export interface ResolvedBinding {
  command: string;
  when?: string;
  chord: Chord | null;
}

/** The persisted `tl:keybindings:v1` document (validated shape). */
export interface KbDoc {
  enabled: boolean;
  overrides: Record<string, string>;
}

/**
 * Opt-in-toggleable, user-overridable bindings. Chord choices follow the vanilla
 * plan: Ctrl+Shift+K avoids TUI-owned Ctrl+K/Ctrl+F; Alt+Shift+[ ] avoids the
 * browser tab chords; the dev-flow letters/Enter carry `e.code` aliases so they
 * survive Mac Option+Shift rendering a symbol and non-US layouts.
 */
export const KB_DEFAULT_BINDINGS: Binding[] = [
  { key: "ctrl+shift+k", command: "palette.toggle", when: "!galleryOpen" },
  { key: "alt+1", command: "session.attach.1", when: "!galleryOpen" },
  { key: "alt+2", command: "session.attach.2", when: "!galleryOpen" },
  { key: "alt+3", command: "session.attach.3", when: "!galleryOpen" },
  { key: "alt+4", command: "session.attach.4", when: "!galleryOpen" },
  { key: "alt+5", command: "session.attach.5", when: "!galleryOpen" },
  { key: "alt+6", command: "session.attach.6", when: "!galleryOpen" },
  { key: "alt+7", command: "session.attach.7", when: "!galleryOpen" },
  { key: "alt+8", command: "session.attach.8", when: "!galleryOpen" },
  { key: "alt+9", command: "session.attach.9", when: "!galleryOpen" },
  { key: "alt+0", command: "session.attach.10", when: "!galleryOpen" },
  { key: "alt+shift+[", command: "session.prev", when: "!galleryOpen" },
  { key: "alt+shift+]", command: "session.next", when: "!galleryOpen" },
  // Dev-flow chords (Alt+Shift namespace).
  { key: "alt+shift+enter", command: "session.next.awaiting", when: "lobbyOpen && !galleryOpen" },
  { key: "alt+shift+s", command: "sidebar.toggle", when: "lobbyOpen && !galleryOpen" },
  { key: "alt+shift+n", command: "session.new", when: "lobbyOpen && !galleryOpen" },
  { key: "alt+shift+w", command: "session.kill.current", when: "lobbyOpen && !galleryOpen" },
  { key: "alt+shift+r", command: "session.rename.current", when: "lobbyOpen && !galleryOpen" },
  // Alt+/ (Option+/) opens the shortcuts help from anywhere, incl. inside a
  // session — bare "/" is lobby-only (it must reach the pty inside the terminal).
  { key: "alt+/", command: "shortcuts.help", when: "lobbyOpen && !galleryOpen" },
];

/**
 * Always-on bindings: fire regardless of the opt-in `enabled` flag, for every
 * user. Alt+Shift+Backspace kills the attached session from anywhere the lobby
 * owns keys (Alt+SHIFT, not plain Option+Backspace — the shell/editor use
 * Option+Backspace for delete-word). `session.kill.current` keeps its confirm.
 */
export const KB_ALWAYS_BINDINGS: Binding[] = [
  { key: "alt+shift+backspace", command: "session.kill.current", when: "lobbyOpen && !galleryOpen" },
];

/** Commands that a user override may target (default bindings only). */
export const KB_COMMANDS: ReadonlySet<string> = new Set(
  KB_DEFAULT_BINDINGS.map((b) => b.command),
);

/** localStorage key for the persisted keybinding doc (per-browser, not roamed). */
export const KB_KEY = "tl:keybindings:v1";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * validate-or-default a raw persisted doc into a typed KbDoc. Garbage degrades to
 * the DEFAULT ({enabled:true, no overrides}) — on-by-default, matching the
 * vanilla posture. Only an explicit stored `{enabled:false}` disables the layer.
 * Overrides are dropped unless they name a known command AND parse to a chord.
 */
export function normalizeKeybindings(raw: unknown): KbDoc {
  const out: KbDoc = { enabled: true, overrides: {} };
  if (isPlainObject(raw)) {
    if (raw.enabled === false) out.enabled = false;
    const ov = raw.overrides;
    if (isPlainObject(ov)) {
      for (const k of Object.keys(ov)) {
        const val = ov[k];
        if (KB_COMMANDS.has(k) && typeof val === "string" && parseChord(val)) {
          out.overrides[k] = val;
        }
      }
    }
  }
  return out;
}

/** Resolve the default bindings, applying any per-command override chord string. */
export function resolveBindings(overrides: Record<string, string>): ResolvedBinding[] {
  return KB_DEFAULT_BINDINGS.map((b) => ({
    command: b.command,
    when: b.when,
    chord: parseChord(overrides[b.command] || b.key),
  }));
}

/** Resolve the always-on bindings (never overridable). */
export function resolveAlways(): ResolvedBinding[] {
  return KB_ALWAYS_BINDINGS.map((b) => ({
    command: b.command,
    when: b.when,
    chord: parseChord(b.key),
  }));
}

/** Inputs to the single chord-match decision point. */
export interface MatchInput {
  /** the opt-in gate (default bindings only; always-on bindings bypass it). */
  enabled: boolean;
  resolvedDefaults: ResolvedBinding[];
  resolvedAlways: ResolvedBinding[];
  /** the when-context: {terminalFocus, lobbyOpen, galleryOpen, ...}. */
  ctx: Record<string, boolean>;
}

/**
 * The single decision point shared by the window keydown listener AND (in the
 * vanilla app) the merged xterm handler: returns the matched binding, or null
 * when the event is not a keydown, the layer is disabled, or no exact
 * enabled-and-in-context chord matched. Always-on bindings are checked BEFORE
 * the `enabled` gate.
 */
export function matchesAppChord(e: ChordEventLike, m: MatchInput): ResolvedBinding | null {
  if (e.type && e.type !== "keydown") return null;
  for (const b of m.resolvedAlways) {
    if (!b.chord) continue;
    if (b.when && !evalWhen(b.when, m.ctx)) continue;
    if (eventMatchesChord(e, b.chord)) return b;
  }
  if (!m.enabled) return null;
  for (const b of m.resolvedDefaults) {
    if (!b.chord) continue;
    if (b.when && !evalWhen(b.when, m.ctx)) continue;
    if (eventMatchesChord(e, b.chord)) return b;
  }
  return null;
}

/** Platform label for the Alt/Option modifier (Mac keyboards call it Option). */
export function altLabel(isMac: boolean): string {
  return isMac ? "Option" : "Alt";
}
