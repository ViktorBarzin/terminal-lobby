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
 * is in neither table here. It was dropped while v2 had no dock, on the note
 * that Ctrl/Cmd+J was the text/terminal view toggle instead and that the dock
 * chord would come back with the dock pillar.
 *
 * The dock landed and took the chord back, as `onDockKey` in App.tsx rather
 * than as a table row. ShortcutsHelp and settings/pages/KeyboardPage promised
 * the view toggle on that chord until 2026-09-06, and both now name the dock.
 * Neither table changed.
 *
 * THE VIEW TOGGLE HAS NO CHORD, AND THAT IS SETTLED, not an omission waiting
 * to be tidied up. `view.toggle` is in neither table below, and `onDockKey` is
 * the only handler in this tree that matches a J chord at all. Viktor was
 * asked directly on 2026-09-06 and chose to leave it that way: the
 * [Text | Terminal] control is the way in, and the command palette is the
 * other one he named. So DO NOT add a `view.toggle` row below to close the
 * gap. Reversing the decision means picking a chord that is actually free (J
 * is the dock's) and changing the two help surfaces back in the same commit.
 *
 * One thing to know before reversing it: the palette half of that answer is
 * not wired. `App.tsx`'s palette action list has no view-toggle entry, so on
 * 2026-09-06 the segmented control is the only way a person reaches the
 * toggle, and `runAppCommand`'s `view.toggle` arm runs from tests alone. That
 * is a gap in the palette, not a reason for a chord.
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
 * The when-clause the four undo rows carry, and its two halves are two
 * different arguments.
 *
 * `!editing` because a focused text input, textarea, contenteditable or the
 * CodeMirror editor owns Cmd+Z outright — it has an undo history of the words
 * being typed, and ours is about sessions and projects. That leg cannot be
 * moved downstream: the engine's listener is capture-phase on `window` while
 * the editor's own Mod-z is bubble-phase on its contentDOM, so a match here
 * fires first and nothing afterwards can give the key back (keybindings/
 * editing.ts carries the full note).
 *
 * `!overlayOpen` for the same reason every other lobby chord carries it: the
 * lobby must not act BEHIND a dialog. Cmd+Z with Settings open would resurrect
 * a session nobody can see from there.
 *
 * `!previewDirty` for the reason SWITCH_WHEN above carries it, and it is the
 * same loss: undoing a kill re-selects the session the kill took
 * (store/undo.kill.ts), and a switch unmounts the file-preview store with an
 * unsaved draft inside it. The preview is deliberately not part of
 * `overlayOpen`, and focus sitting on its Save or mode button rather than in
 * CodeMirror clears `editing` too, so without this leg the one chord that can
 * switch sessions with no confirm in front of it would be the one that
 * destroys the draft. Undo waits until the draft is saved or discarded, the
 * same as Alt+1..9 and Alt+Shift+[ ].
 */
const UNDO_WHEN = "!editing && !overlayOpen && !previewDirty";

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
  // Undo / redo for the lobby's structural actions (store/undo.ts). Both
  // spellings of the modifier are rows of their own because `parseChord` keeps
  // ctrl and meta as separate flags and `eventMatchesChord` compares all four
  // exactly — one row cannot cover both platforms.
  //
  // THESE ROWS TAKE Ctrl+Z AWAY FROM THE PTY, deliberately and with the cost
  // signed off. The chord is claimed globally, the terminal included, so Ctrl+Z
  // no longer suspends the foreground job in a session. Nothing terminal-side
  // was written for that: the engine preventDefaults on a match, TerminalNative
  // passes `appChord: e.defaultPrevented`, and terminal/keys.ts's `app-chord`
  // leg answers `passToTerminal: false`.
  //
  // Which is exactly why they are HERE and not in KB_ALWAYS_BINDINGS. A default
  // row honours the ⚙ Settings "App shortcuts" switch, so anybody who wants
  // Ctrl+Z back as SIGTSTP has a way to say so; an always-on row would take it
  // with no way back.
  { key: "ctrl+z", command: "edit.undo", when: UNDO_WHEN },
  { key: "meta+z", command: "edit.undo", when: UNDO_WHEN },
  { key: "ctrl+shift+z", command: "edit.redo", when: UNDO_WHEN },
  { key: "meta+shift+z", command: "edit.redo", when: UNDO_WHEN },
];

/**
 * Always-on bindings: fire regardless of the opt-in `enabled` flag, for every
 * user. Alt+Shift+Backspace kills the attached session from anywhere the lobby
 * owns keys (Alt+SHIFT, not plain Option+Backspace — the shell/editor use
 * Option+Backspace for delete-word).
 *
 * It asks nothing first, and does not need to: `session.kill.current` holds the
 * kill for eight seconds with the card dimmed (store/lobby.ts GRACE_MS), and
 * Cmd+Z takes it back. The undo chords themselves are deliberately NOT in here
 * — they sit in KB_DEFAULT_BINDINGS, so the ⚙ "App shortcuts" switch can hand
 * Ctrl+Z back to the terminal.
 */
export const KB_ALWAYS_BINDINGS: Binding[] = [
  { key: "alt+shift+backspace", command: "session.kill.current", when: LOBBY_WHEN },
];

/** Commands that a user override may target (default bindings only). */
export const KB_COMMANDS: ReadonlySet<string> = new Set(KB_DEFAULT_BINDINGS.map((b) => b.command));

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
  /** a text input, textarea, contenteditable or the CodeMirror editor holds the
   *  keyboard. Read fresh at every keydown (App.tsx), because focus is a DOM
   *  fact rather than a signal. */
  editing: boolean;
}

/** The when-context every clause in the table is evaluated against. */
export interface KeyContext {
  [flag: string]: boolean;
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
  /** a field owns the keyboard, and with it Cmd+Z. Deliberately NOT part of
   *  `overlayOpen`: a caret in the new-session name box must not cost you every
   *  other lobby chord, only the one the field has its own meaning for. */
  editing: boolean;
}

/**
 * Build the when-context from the shell's overlay state — the ONE place that
 * decides what "an overlay owns the keyboard" means, shared by the window
 * keydown listener and App's bare "/" help opener. Keeping it here rather than
 * inline in the shell is what makes that definition testable and single.
 * SessionView's always-on Ctrl/Cmd+J was a third reader until the dock
 * reclaimed the chord.
 *
 * A third reader lived here until 2026-09-05: a chord pressed inside the
 * terminal could not produce a keydown in this document, so it was matched
 * against the TERMINAL page's own context and forwarded up by NAME, and
 * `commandAllowed` re-checked it against this context because the page knew
 * nothing about the lobby's overlays. One document means one keydown path, so
 * the by-name lookup, its `KB_FORWARDED_WHEN` table and `commandWhen` went with
 * the page.
 *
 * The file preview is deliberately NOT part of `overlayOpen`. It is a session
 * surface rather than a lobby modal, and the palette has to stay reachable over
 * it: the palette's attach route carries the "Unsaved changes in the file
 * editor" refusal, which is unreachable if the chord that opens it is refused
 * first. Only the chords that would UNMOUNT the draft are gated, on
 * `previewDirty`.
 *
 * `editing` is the odd one out among these inputs: the others are signals the
 * shell already holds, and this one is a reading of `document.activeElement` at
 * the moment of the press (App.tsx, via keybindings/editing.ts). It is not
 * cached for that reason — focus moves without any signal changing — and it
 * gates exactly the four undo rows, which are the only chords a text field has
 * its own meaning for.
 */
export function keyContext(s: KeyContextInput): KeyContext {
  return {
    lobbyOpen: true,
    overlayOpen: s.paletteOpen || s.helpOpen || s.settingsOpen || s.galleryOpen,
    paletteOpen: s.paletteOpen,
    helpOpen: s.helpOpen,
    galleryOpen: s.galleryOpen,
    previewOpen: s.previewOpen,
    previewDirty: s.previewDirty,
    editing: s.editing,
  };
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
