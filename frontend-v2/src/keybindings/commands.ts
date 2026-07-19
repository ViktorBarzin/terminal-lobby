import type { LobbyStore, NotifyKind } from "../store/lobby";
import type { PaletteController } from "./palette-controller";
import type { HelpController } from "../components/ShortcutsHelp";
import {
  attachIndex,
  cycleTarget,
  flatSessionOrder,
  nextAwaitingTarget,
} from "./navigation.logic";

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
  /** open the SPA session image gallery (🖼) for the selected session. */
  openGallery: () => void;
  /** post a terminal-document command DOWN to the active iframe; false if none. */
  forwardToTerminal: (cmd: string) => boolean;
  /** confirm/prompt seams (window.* by default; injectable for tests). */
  confirm?: (message: string) => boolean;
  prompt?: (message: string, def?: string) => string | null;
}

export function createRunAppCommand(deps: CommandDeps): (cmd: string) => void {
  const { store, palette, help } = deps;
  const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
  const promptFn = deps.prompt ?? ((m: string, d?: string) => window.prompt(m, d));

  const current = (): string | null => store.selected()?.name ?? null;
  const order = () => flatSessionOrder(store.model());
  const stateOf = (name: string): string | undefined =>
    store.sessions.find((s) => s.name === name)?.state || undefined;

  return function runAppCommand(cmd: string): void {
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
      if (sel && confirmFn(`Kill session "${sel.name}"?`)) void store.kill(sel.name);
      return;
    }

    if (cmd === "session.rename.current") {
      const sel = store.selected();
      if (!sel) return;
      const next = promptFn("Rename session", sel.name);
      if (next && next.trim() && next.trim() !== sel.name) {
        void store.rename(sel.name, next.trim());
      }
      return;
    }

    if (cmd === "gallery.open") {
      // The gallery is an SPA overlay (opens over any view); the store toasts
      // "Open a session first" when nothing is selected.
      deps.openGallery();
      return;
    }

    if (cmd === "terminal.paste") {
      // Paste-into-terminal still lives in the terminal document (its clipboard
      // read + image-aware routine) — forward down to the active iframe.
      if (!deps.forwardToTerminal(cmd)) deps.notify("Open a session first", "error");
      return;
    }
  };
}
