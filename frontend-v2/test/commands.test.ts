import { describe, it, expect, vi, afterEach } from "vitest";
import { createRunAppCommand, type CommandDeps } from "../src/keybindings/commands";
import type { LobbyStore } from "../src/store/lobby";
import type { PaletteController } from "../src/keybindings/palette-controller";
import type { HelpController } from "../src/components/ShortcutsHelp";
import type { UndoResult, UndoStore } from "../src/store/undo";

/**
 * The lobby command dispatcher's VIEW-TOGGLE branch.
 *
 * A chord pressed with focus inside the terminal iframe could not reach the
 * SPA's own listeners (a keydown never crosses a frame boundary), so
 * frontend/term.html forwarded it up as a `tl-command` and App handed it to this
 * dispatcher. Ctrl/Cmd+J used to dead-end here: the chord arrived, no branch
 * claimed it, and the view never toggled — while the key was still swallowed on
 * the terminal side. The terminal is drawn in this document now, so the chord
 * reaches the engine's own listener and arrives at this dispatcher locally; the
 * branch it needed is the same one either way.
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

/**
 * edit.undo / edit.redo — the Cmd+Z arms.
 *
 * The store never toasts (store/undo.ts says why: it would need a DOM to be
 * tested at all, and undo is deliberately silent when it works). It answers
 * {ok:false, reason} and the CALLER speaks, which for the chord and the palette
 * rows is this dispatcher. Three outcomes, and only one of them says anything:
 * a refusal with a sentence toasts it, a refusal with a null reason is the
 * silent no-op a browser gives you for Cmd+Z on an empty history, and success
 * says nothing at all.
 */
describe("runAppCommand — edit.undo / edit.redo", () => {
  const stack = (over: Partial<UndoStore> = {}): UndoStore =>
    ({
      push: noop,
      undo: () => Promise.resolve<UndoResult>({ ok: true }),
      redo: () => Promise.resolve<UndoResult>({ ok: true }),
      canUndo: () => true,
      canRedo: () => true,
      clear: noop,
      carry: noop,
      ...over,
    }) as UndoStore;

  it.each(["edit.undo", "edit.redo"] as const)("%s says nothing when it works", async (cmd) => {
    const undo = vi.fn(() => Promise.resolve<UndoResult>({ ok: true }));
    const redo = vi.fn(() => Promise.resolve<UndoResult>({ ok: true }));
    const { run, notify } = makeRun({ undo: stack({ undo, redo }) });
    run(cmd);
    await vi.waitFor(() => expect(cmd === "edit.undo" ? undo : redo).toHaveBeenCalledTimes(1));
    expect(notify).not.toHaveBeenCalled();
    // ...and only its own direction ran.
    expect(cmd === "edit.undo" ? redo : undo).not.toHaveBeenCalled();
  });

  it.each([
    ["edit.undo", "Can't undo: that session is gone"],
    ["edit.redo", "Can't redo: that session is gone"],
  ] as const)("%s toasts a refusal's reason under its own lead-in", async (cmd, message) => {
    // A reason is a sentence written to follow one (store/undo.ts
    // UndoHandler.check), so it starts lower case and reads as a fragment on
    // its own. The lead-in is added here rather than in the store, which does
    // not know which direction the press was going.
    const refuse = () => Promise.resolve<UndoResult>({ ok: false, reason: "that session is gone" });
    const { run, notify } = makeRun({ undo: stack({ undo: refuse, redo: refuse }) });
    run(cmd);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(message, "warning");
  });

  it.each(["edit.undo", "edit.redo"] as const)("%s stays silent on an empty stack", async (cmd) => {
    // reason === null is the store's "nothing to say": an empty stack, or a
    // lens tab where undo is off entirely. A toast here would fire on every
    // stray Cmd+Z in a fresh tab.
    const nothing = () => Promise.resolve<UndoResult>({ ok: false, reason: null });
    const seen: string[] = [];
    const { run, notify } = makeRun({
      undo: stack({
        undo: () => {
          seen.push("undo");
          return nothing();
        },
        redo: () => {
          seen.push("redo");
          return nothing();
        },
      }),
    });
    run(cmd);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(notify).not.toHaveBeenCalled();
  });

  it("falls back to the stack the lobby store carries", () => {
    // App hands the one instance to createLobbyStore, which hands it back out
    // as LobbyStore.undo. A dispatcher built without its own `undo` dep reads
    // it from there rather than being inert.
    const undo = vi.fn(() => Promise.resolve<UndoResult>({ ok: true }));
    const store = stubStore();
    (store as { undo?: UndoStore }).undo = stack({ undo });
    const { run } = makeRun({ store });
    run("edit.undo");
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all on a page with no stack", () => {
    // A lens tab builds no store (store/undo.ts UndoStoreOptions.enabled), so
    // the chord has to be a no-op rather than a crash.
    const { run, notify } = makeRun();
    expect(() => run("edit.undo")).not.toThrow();
    expect(() => run("edit.redo")).not.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });
});
