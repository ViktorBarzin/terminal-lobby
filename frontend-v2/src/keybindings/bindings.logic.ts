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
 * The when-clause every LOBBY chord carries. `overlayOpen` is the shell's single
 * reading of "an overlay owns the keyboard" (keyContext below): while the
 * palette, the shortcuts help, the Settings modal or the image gallery is up,
 * the lobby must not act BEHIND it. The table used to name the gallery alone, so
 * with the Settings dialog open — aria-modal, Tab trapped, focus inside it —
 * Alt+Shift+N still focused the new-session box behind the dialog and
 * Ctrl+Shift+K still opened the palette over it.
 */
const LOBBY_WHEN = "lobbyOpen && !overlayOpen";

/**
 * ...with ONE exemption: an overlay's own toggle chord must survive that overlay
 * being the open one, or it stops being a toggle and Escape becomes the only way
 * out. `evalWhen` has no parentheses, so `a && (b || c)` is spelled as the
 * OR-of-ANDs `a && b || a && c`.
 */
const lobbyOrSelf = (self: string): string => `${LOBBY_WHEN} || lobbyOpen && ${self}`;

/**
 * The when-clause every chord that SWITCHES SESSION carries. Switching unmounts
 * the whole session surface, and with it the per-session file-preview store —
 * so an unsaved editor draft dies with it. The mouse route is already guarded
 * (clicking another session goes through the preview backdrop's "Discard unsaved
 * changes?" confirm); these chords bypassed every overlay and destroyed the
 * draft in silence. While one is dirty they are inert, and the visible,
 * confirmable routes (the backdrop, Esc, Ctrl/Cmd+S) stay the way out.
 */
const SWITCH_WHEN = "!overlayOpen && !previewDirty";

/**
 * Opt-in-toggleable, user-overridable bindings. Chord choices follow the vanilla
 * plan: Ctrl+Shift+K avoids TUI-owned Ctrl+K/Ctrl+F; Alt+Shift+[ ] avoids the
 * browser tab chords; the dev-flow letters/Enter carry `e.code` aliases so they
 * survive Mac Option+Shift rendering a symbol and non-US layouts.
 */
export const KB_DEFAULT_BINDINGS: Binding[] = [
  // Overlay-scoped on its own overlay (the lobbyOrSelf idea, minus the
  // lobbyOpen leg this row never carried): Ctrl+Shift+K still closes the
  // palette it opened, while every OTHER overlay refuses it — a palette over
  // the Settings modal is exactly the leak `overlayOpen` exists to stop.
  { key: "ctrl+shift+k", command: "palette.toggle", when: "!overlayOpen || paletteOpen" },
  { key: "alt+1", command: "session.attach.1", when: SWITCH_WHEN },
  { key: "alt+2", command: "session.attach.2", when: SWITCH_WHEN },
  { key: "alt+3", command: "session.attach.3", when: SWITCH_WHEN },
  { key: "alt+4", command: "session.attach.4", when: SWITCH_WHEN },
  { key: "alt+5", command: "session.attach.5", when: SWITCH_WHEN },
  { key: "alt+6", command: "session.attach.6", when: SWITCH_WHEN },
  { key: "alt+7", command: "session.attach.7", when: SWITCH_WHEN },
  { key: "alt+8", command: "session.attach.8", when: SWITCH_WHEN },
  { key: "alt+9", command: "session.attach.9", when: SWITCH_WHEN },
  { key: "alt+0", command: "session.attach.10", when: SWITCH_WHEN },
  { key: "alt+shift+[", command: "session.prev", when: SWITCH_WHEN },
  { key: "alt+shift+]", command: "session.next", when: SWITCH_WHEN },
  // Dev-flow chords (Alt+Shift namespace).
  { key: "alt+shift+enter", command: "session.next.awaiting", when: `lobbyOpen && ${SWITCH_WHEN}` },
  { key: "alt+shift+u", command: "session.next.unseen", when: `lobbyOpen && ${SWITCH_WHEN}` },
  { key: "alt+shift+s", command: "sidebar.toggle", when: LOBBY_WHEN },
  { key: "alt+shift+n", command: "session.new", when: LOBBY_WHEN },
  { key: "alt+shift+w", command: "session.kill.current", when: LOBBY_WHEN },
  { key: "alt+shift+r", command: "session.rename.current", when: LOBBY_WHEN },
  // Find in the open session's transcript. Alt+Shift rather than Ctrl/Cmd+F for
  // the reason the whole namespace exists: Ctrl+F belongs to the TUI, and this
  // chord has to be safe to press with a session open. Refused behind an
  // overlay, which already owns the keyboard.
  { key: "alt+shift+f", command: "find.open", when: "!overlayOpen" },
  // Alt+/ (Option+/) opens the shortcuts help from anywhere, incl. inside a
  // session — bare "/" is lobby-only (it must reach the pty inside the terminal).
  // Overlay-scoped on its own overlay: the help dialog's Escape/"/" exits read
  // `e.key`, which Option+/ renders as "÷" on a Mac, so this chord is what
  // closes it there.
  { key: "alt+/", command: "shortcuts.help", when: lobbyOrSelf("helpOpen") },
];

/**
 * Always-on bindings: fire regardless of the opt-in `enabled` flag, for every
 * user. Alt+Shift+Backspace kills the attached session from anywhere the lobby
 * owns keys (Alt+SHIFT, not plain Option+Backspace — the shell/editor use
 * Option+Backspace for delete-word). `session.kill.current` keeps its confirm.
 */
export const KB_ALWAYS_BINDINGS: Binding[] = [
  { key: "alt+shift+backspace", command: "session.kill.current", when: LOBBY_WHEN },
];

/**
 * When-clauses for commands that reach the lobby WITHOUT a chord of their own in
 * this table. A chord pressed inside the terminal iframe is matched by
 * frontend/term.html's own copy of the table and forwarded up by NAME over
 * `tl-command` (commands.ts), so the lobby has to be able to look a clause up by
 * command — and some of those commands (Ctrl/Cmd+J's `view.toggle`, which
 * SessionView owns on the lobby side) have no row here to look up.
 */
const KB_FORWARDED_WHEN: Readonly<Record<string, string>> = {
  // The view toggle behind an overlay is invisible and leaves the overlay up.
  "view.toggle": "!overlayOpen",
};

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

/** What the shell knows about its overlays, before it is turned into a context. */
export interface KeyContextInput {
  /** the command palette (its own chord may still close it). */
  paletteOpen: boolean;
  /** the keyboard-shortcuts help overlay. */
  helpOpen: boolean;
  /** the ⚙ Settings dialog (aria-modal, traps Tab). Skills is a page inside
   *  it, so it needs no flag of its own. */
  settingsOpen: boolean;
  /** the session image gallery. */
  galleryOpen: boolean;
  /** the per-session file-preview overlay. */
  previewOpen: boolean;
  /** ...with an unsaved editor draft in it. */
  previewDirty: boolean;
}

/** The when-context every clause in the table is evaluated against. */
export interface KeyContext {
  [flag: string]: boolean;
  /** false in the lobby SPA — the terminal is a cross-document iframe. */
  terminalFocus: boolean;
  /** true: this document IS the lobby (sidebar, palette, session switching). */
  lobbyOpen: boolean;
  /** an overlay owns the keyboard; nothing lobby-scoped may fire behind it. */
  overlayOpen: boolean;
  /** which overlay it is, for the two chords that toggle their own overlay. */
  paletteOpen: boolean;
  helpOpen: boolean;
  galleryOpen: boolean;
  previewOpen: boolean;
  previewDirty: boolean;
}

/**
 * Build the when-context from the shell's overlay state — the ONE place that
 * decides what "an overlay owns the keyboard" means, shared by the window
 * keydown listener, the iframe-forwarded command path (commandAllowed) and the
 * Ctrl/Cmd+J view toggle. Keeping it here rather than inline in the shell is
 * what makes that definition testable and single.
 *
 * The file preview is deliberately NOT part of `overlayOpen`. It is a session
 * surface rather than a lobby modal, and the palette has to stay reachable over
 * it: the palette's attach route carries the "Unsaved changes in the file
 * editor" refusal, which is unreachable if the chord that opens it is refused
 * first. Only the chords that would UNMOUNT the draft are gated, on
 * `previewDirty`.
 */
export function keyContext(s: KeyContextInput): KeyContext {
  return {
    terminalFocus: false,
    lobbyOpen: true,
    overlayOpen: s.paletteOpen || s.helpOpen || s.settingsOpen || s.galleryOpen,
    paletteOpen: s.paletteOpen,
    helpOpen: s.helpOpen,
    galleryOpen: s.galleryOpen,
    previewOpen: s.previewOpen,
    previewDirty: s.previewDirty,
  };
}

/**
 * The when-clause guarding a COMMAND rather than a chord — the always-on table
 * first, then the default table, then the forwarded-only clauses. Undefined
 * means "no clause": the command is not context-gated at all.
 */
export function commandWhen(command: string): string | undefined {
  for (const b of KB_ALWAYS_BINDINGS) if (b.command === command) return b.when;
  for (const b of KB_DEFAULT_BINDINGS) if (b.command === command) return b.when;
  return KB_FORWARDED_WHEN[command];
}

/**
 * May this command run in this context? The chord path gets its guard from the
 * table row that matched the event; a command forwarded up from the terminal
 * iframe arrives as a NAME with no event, and term.html matched it against the
 * TERMINAL page's context — which knows nothing about the lobby's overlays. So
 * that path skipped every when-clause the lobby owns: with the gallery open and
 * focus in the terminal, Alt+Shift+] switched session and took the gallery with
 * it. Re-checking by command name is the same guard, applied to the same
 * context, on both paths.
 */
export function commandAllowed(command: string, ctx: Record<string, boolean>): boolean {
  return evalWhen(commandWhen(command), ctx);
}

/** Inputs to the single chord-match decision point. */
export interface MatchInput {
  /** the opt-in gate (default bindings only; always-on bindings bypass it). */
  enabled: boolean;
  resolvedDefaults: ResolvedBinding[];
  resolvedAlways: ResolvedBinding[];
  /** the when-context (keyContext): {lobbyOpen, overlayOpen, previewDirty, ...}. */
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
