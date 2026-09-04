import { sessionConfirmLabel, sessionTitleDraft } from "../types/lobby";
import type { LobbyStore, NotifyKind } from "../store/lobby";
import type { PaletteController } from "./palette-controller";
import type { HelpController } from "../components/ShortcutsHelp";
import {
  attachIndex,
  cycleTarget,
  flatSessionOrder,
  nextAwaitingTarget,
  nextMatchingTarget,
} from "./navigation.logic";
import { track } from "../telemetry/track";

/**
 * The lobby command dispatcher (feature-inventory Cat.2 "tl-command channel +
 * runAppCommand dispatcher"). Ported from the vanilla frontend/index.html
 * `runAppCommand` lobby half (index.html:9037-9111). The lobby owns the sidebar,
 * so it EXECUTES every session command — whether it came from the engine's own
 * capture-phase keydown (focus in the lobby chrome) or was forwarded up from the
 * terminal iframe over the tl-command postMessage channel (focus in the
 * terminal). Terminal-document commands (gallery/paste) are forwarded back DOWN.
 */
export interface CommandDeps {
  store: LobbyStore;
  palette: PaletteController;
  help: HelpController;
  toggleSidebar: () => void;
  /** open + focus the new-session name box in the sidebar. */
  focusNewSession: () => void;
  notify: (message: string, kind: NotifyKind) => void;
  /** finished since the user last looked (the visit store, via notifications). */
  isUnseen?: (s: { name: string; state?: string }) => boolean;
  /** open the SPA session image gallery (🖼) for the selected session. */
  openGallery: () => void;
  /** post a terminal-document command DOWN to the active iframe; false if none. */
  forwardToTerminal: (cmd: string) => boolean;
  /** Paste into the terminal, performed in THIS document (clipboard/paste.ts):
   *  the frame cannot read the clipboard while the lobby holds focus. */
  pasteToTerminal: () => boolean;
  /** Ctrl/Cmd+J — open, hide or show the scratch-shell dock. */
  toggleDock: () => void;
  /** flip the mounted session between its text and terminal view; false if no
   *  SessionView is mounted. Defaults to the `window.__tlToggleView` bridge the
   *  mounted SessionView installs (same pattern as __tlForwardToTerminal) — the
   *  lobby shell does not own the per-session view mode. */
  toggleView?: () => boolean;
  /** open the find-in-session overlay on the mounted text view; false if
   *  there is none. Same `window.__tlOpenFind` bridge shape as toggleView —
   *  the lobby shell does not own the session's transcript. */
  openFind?: () => boolean;
  /** confirm/prompt seams (window.* by default; injectable for tests). */
  confirm?: (message: string) => boolean;
  prompt?: (message: string, def?: string) => string | null;
}

export function createRunAppCommand(deps: CommandDeps): (cmd: string) => void {
  const { store, palette, help } = deps;
  const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
  const promptFn = deps.prompt ?? ((m: string, d?: string) => window.prompt(m, d));
  const toggleViewFn = deps.toggleView ?? (() => window.__tlToggleView?.() ?? false);
  const openFindFn = deps.openFind ?? (() => window.__tlOpenFind?.() ?? false);

  const current = (): string | null => store.selected()?.name ?? null;
  /** What an irreversible confirmation calls it: the id stands in for no title. */
  const confirmLabelOf = (name: string): string => {
    const s = store.sessions.find((x) => x.name === name);
    return s ? sessionConfirmLabel(s) : name;
  };
  /** What a rename box opens on: the real title, "" when there is none. */
  const titleOf = (name: string): string =>
    sessionTitleDraft(store.sessions.find((x) => x.name === name));
  const order = () => flatSessionOrder(store.model());
  const stateOf = (name: string): string | undefined =>
    store.sessions.find((s) => s.name === name)?.state || undefined;

  return function runAppCommand(cmd: string): void {
    // Every command dispatch — palette pick, chord, forwarded shortcut — funnels
    // through here, so this one line counts them all.
    track("palette.action", { "tl.key": cmd });
    if (cmd === "palette.toggle") {
      palette.toggle();
      return;
    }
    // Any other command closes an open palette first (chords fired while it is up).
    if (palette.isOpen()) palette.close(false);

    const idx = attachIndex(cmd);
    if (idx !== null) {
      const target = order()[idx];
      if (!target) return; // fewer cards than N
      if (current() === target.name) return; // already attached
      store.select(target.name, target.owner);
      return;
    }

    if (cmd === "session.next" || cmd === "session.prev") {
      const target = cycleTarget(order(), current(), cmd === "session.next" ? 1 : -1);
      if (target) store.select(target.name, target.owner);
      return;
    }

    if (cmd === "session.next.awaiting") {
      const target = nextAwaitingTarget(order(), stateOf, current());
      if (target) store.select(target.name, target.owner);
      else deps.notify("No session awaiting input", "info");
      return;
    }

    // The app icon counts awaiting AND unread-finished, and only the first half
    // was reachable from the keyboard.
    if (cmd === "session.next.unseen") {
      const target = nextMatchingTarget(order(), (s: { name: string; state?: string }) => deps.isUnseen?.(s) ?? false, current());
      if (target) store.select(target.name, target.owner);
      else deps.notify("No unread sessions", "info");
      return;
    }

    if (cmd === "sidebar.toggle") {
      deps.toggleSidebar();
      return;
    }

    if (cmd === "shortcuts.help") {
      help.toggle();
      return;
    }

    if (cmd === "session.new") {
      deps.focusNewSession();
      return;
    }

    if (cmd === "session.kill.current") {
      const sel = store.selected();
      // Named by its id when it has no title: killing is irreversible, and
      // `Kill session "New session"?` names every untitled session equally.
      if (sel && confirmFn(`Kill session "${confirmLabelOf(sel.name)}"?`)) void store.kill(sel.name);
      return;
    }

    if (cmd === "session.rename.current") {
      const sel = store.selected();
      if (!sel) return;
      // The prompt edits the TITLE and only the title — the name is an opaque
      // id fixed at creation (ADR-0019). It opens on the title the session
      // actually has, which is empty for one nobody and nothing has titled yet.
      // An empty answer clears the title, which is a real instruction here —
      // only a cancelled prompt (null) does nothing.
      const current = titleOf(sel.name);
      const next = promptFn("Rename session", current);
      if (next !== null && next !== current) void store.rename(sel.name, next);
      return;
    }

    if (cmd === "view.toggle") {
      // Ctrl/Cmd-J. The lobby only ever sees this command when it was pressed
      // INSIDE the terminal iframe (a keydown never crosses a frame boundary,
      // so term.html forwards it up as a tl-command); with focus in the lobby
      // chrome SessionView's own listener handles the chord directly. Both ends
      // land on the same toggle, which is what makes the chord two-way.
      if (!toggleViewFn()) deps.notify("Open a session first", "error");
      return;
    }

    if (cmd === "find.open") {
      // Only the text view has a transcript to search, and the bridge says so
      // by returning false — the same shape as view.toggle above.
      if (!openFindFn()) deps.notify("Open a session in Text view first", "error");
      return;
    }

    if (cmd === "gallery.open") {
      // The gallery is an SPA overlay (opens over any view); the store toasts
      // "Open a session first" when nothing is selected.
      deps.openGallery();
      return;
    }

    if (cmd === "session.new.shell") {
      // The chord fired INSIDE the terminal iframe and was forwarded up: a
      // keydown in the frame never reaches the lobby's own listener, so this is
      // the path Ctrl+J takes whenever the terminal has focus — which is most
      // of the time.
      deps.toggleDock();
      return;
    }

    if (cmd === "terminal.paste") {
      // The READ happens in the lobby: the async clipboard is gated on document
      // focus, and a frame whose parent was just clicked does not have it — the
      // old forward-and-read-there path threw "Document is not focused" and
      // reported it as denied access for a permission never requested.
      if (!deps.pasteToTerminal()) deps.notify("Open a session first", "error");
      return;
    }
  };
}
