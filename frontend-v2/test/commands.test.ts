import { describe, it, expect, vi, afterEach } from "vitest";
import { createRunAppCommand, type CommandDeps } from "../src/keybindings/commands";
import type { LobbyStore } from "../src/store/lobby";
import type { PaletteController } from "../src/keybindings/palette-controller";
import type { HelpController } from "../src/components/ShortcutsHelp";

/**
 * The lobby command dispatcher's VIEW-TOGGLE branch.
 *
 * A chord pressed with focus inside the terminal iframe cannot reach the SPA's
 * own listeners (a keydown never crosses a frame boundary), so frontend/term.html
 * forwards it up as a `tl-command` and App hands it to this dispatcher. Ctrl/Cmd+J
 * used to dead-end here: the chord arrived, no branch claimed it, and the view
 * never toggled — while the key was still swallowed on the terminal side.
 */

const noop = (): void => {};

function stubStore(): LobbyStore {
  return {
    selected: () => null,
    model: () => [],
    sessions: [],
    select: noop,
    kill: noop,
    rename: noop,
  } as unknown as LobbyStore;
}

function stubPalette(): PaletteController {
  return {
    isOpen: () => false,
    open: noop,
    close: noop,
    toggle: noop,
  } as unknown as PaletteController;
}

function stubHelp(): HelpController {
  return { isOpen: () => false, open: noop, close: noop, toggle: noop };
}

function makeRun(over: Partial<CommandDeps> = {}): {
  run: (cmd: string) => void;
  notify: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn();
  const run = createRunAppCommand({
    store: stubStore(),
    palette: stubPalette(),
    help: stubHelp(),
    toggleSidebar: noop,
    focusNewSession: noop,
    notify,
    openGallery: noop,
    pasteToTerminal: () => true,
    toggleDock: () => {},
    ...over,
  });
  return { run, notify };
}

const w = window as Window & { __tlToggleView?: () => boolean };

describe("runAppCommand — view.toggle", () => {
  afterEach(() => {
    delete w.__tlToggleView;
  });

  it("toggles the mounted session view", () => {
    const toggleView = vi.fn(() => true);
    const { run, notify } = makeRun({ toggleView });
    run("view.toggle");
    expect(toggleView).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("toasts when no session view is mounted to toggle", () => {
    const { run, notify } = makeRun({ toggleView: () => false });
    run("view.toggle");
    expect(notify).toHaveBeenCalledWith("Open a session first", "error");
  });

  it("defaults to the window.__tlToggleView bridge SessionView installs", () => {
    const bridge = vi.fn(() => true);
    w.__tlToggleView = bridge;
    const { run } = makeRun();
    run("view.toggle");
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ctrl/Cmd+J with focus in the terminal. A keydown inside the frame never
 * reaches the lobby's own listener, so term.html matches the chord and forwards
 * `session.new.shell` up — which is the path the chord takes most of the time,
 * since the terminal usually has focus. It reached nothing before the dock
 * existed, so the chord did nothing at all from inside a session.
 */
describe("session.new.shell — the forwarded Ctrl+J", () => {
  it("opens the scratch-shell dock", () => {
    let toggled = 0;
    const { run } = makeRun({ toggleDock: () => void toggled++ });
    run("session.new.shell");
    expect(toggled).toBe(1);
  });
});
