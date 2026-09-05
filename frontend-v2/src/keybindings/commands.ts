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
 * so it EXECUTES every session command, whichever route reached it: the
 * engine's own capture-phase window keydown, the command palette, or a button.
 *
 * There used to be a fourth route. A chord pressed inside the terminal could
 * not reach this document at all, because the terminal was a cross-document
 * iframe and a keydown does not cross that boundary — so it was matched over
 * there and forwarded up by NAME over a postMessage channel. The terminal is
 * drawn in this document now, so its keydowns reach the engine's own listener
 * and every route below is a local one.
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
      // Ctrl/Cmd-J from the palette or the Shortcuts sheet. The chord itself is
      // handled by SessionView's own listener; this is the same toggle under
      // another name, reached through the bridge because the shell does not own
      // the per-session view mode.
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
      // Ctrl+J. The engine's capture-phase window listener sees the keydown
      // wherever focus is, the terminal included, so this is the one path.
      deps.toggleDock();
      return;
    }

    if (cmd === "terminal.paste") {
      // The READ happens out here, in the lobby's own routine, rather than at
      // the terminal: that is where the clipboard permission and the focused
      // document are, and it is one routine shared with the soft-key button.
      if (!deps.pasteToTerminal()) deps.notify("Open a session first", "error");
      return;
    }
  };
}
