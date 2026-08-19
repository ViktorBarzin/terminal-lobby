import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createKeybindingEngine, type KeybindingEngine } from "../src/keybindings/engine";
import { KB_KEY, keyContext } from "../src/keybindings/bindings.logic";

/**
 * Integration test for the capture-phase dispatcher (the "ONE window keydown"
 * red-line): it must preventDefault + run ONLY on an exact enabled chord match,
 * honor the enabled gate + always-on bypass, and drive the Alt-hold tracker.
 */

const LOBBY_CTX = () => ({ terminalFocus: false, lobbyOpen: true, galleryOpen: false });

function key(over: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...over });
}

describe("createKeybindingEngine — capture-phase dispatcher", () => {
  let engine: KeybindingEngine;
  let ran: string[];

  beforeEach(() => {
    localStorage.clear();
    ran = [];
    engine = createKeybindingEngine();
    engine.init({ getContext: LOBBY_CTX, runCommand: (c) => ran.push(c) });
  });
  afterEach(() => engine.dispose());

  it("runs the command AND preventDefaults on an exact chord match", () => {
    const e = key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    window.dispatchEvent(e);
    expect(ran).toEqual(["palette.toggle"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does NOT touch a non-chord key (a letter still reaches the pty)", () => {
    const e = key({ key: "a", code: "KeyA" });
    window.dispatchEvent(e);
    expect(ran).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("maps Alt+1 to session.attach.1 and Alt+0 to session.attach.10", () => {
    window.dispatchEvent(key({ key: "1", code: "Digit1", altKey: true }));
    window.dispatchEvent(key({ key: "0", code: "Digit0", altKey: true }));
    expect(ran).toEqual(["session.attach.1", "session.attach.10"]);
  });

  it("respects the enabled gate for default chords but not always-on ones", () => {
    engine.setEnabled(false);
    // default chord: no-op while disabled
    const pal = key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    window.dispatchEvent(pal);
    expect(ran).toEqual([]);
    expect(pal.defaultPrevented).toBe(false);
    // always-on chord: still fires
    const kill = key({ key: "Backspace", code: "Backspace", altKey: true, shiftKey: true });
    window.dispatchEvent(kill);
    expect(ran).toEqual(["session.kill.current"]);
    expect(kill.defaultPrevented).toBe(true);
  });

  it("applies a stored override chord", () => {
    engine.dispose();
    localStorage.setItem(
      KB_KEY,
      JSON.stringify({ enabled: true, overrides: { "palette.toggle": "ctrl+shift+p" } }),
    );
    engine = createKeybindingEngine();
    engine.init({ getContext: LOBBY_CTX, runCommand: (c) => ran.push(c) });
    window.dispatchEvent(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }));
    // the default Ctrl+Shift+K no longer fires palette.toggle
    window.dispatchEvent(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }));
    expect(ran).toEqual(["palette.toggle"]);
  });

  it("stops dispatching after dispose()", () => {
    engine.dispose();
    window.dispatchEvent(key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }));
    expect(ran).toEqual([]);
  });
});

/**
 * The SECOND way a command reaches the lobby: focus is inside the terminal
 * iframe, so the keydown never touches this window at all — term.html matches
 * the chord itself and posts the command NAME up (tl-command). App hands it to
 * the same dispatcher the keydown listener uses, so it has to consult the same
 * live when-context first, or an overlay's guard applies to exactly one of the
 * two paths (QA #3).
 */
describe("createKeybindingEngine — the forwarded-command guard", () => {
  let engine: KeybindingEngine;
  let overlay: boolean;

  beforeEach(() => {
    localStorage.clear();
    overlay = false;
    engine = createKeybindingEngine();
    engine.init({
      getContext: () =>
        keyContext({
          paletteOpen: false,
          helpOpen: false,
          settingsOpen: false,
          skillsOpen: false,
          galleryOpen: overlay,
          previewOpen: false,
          previewDirty: false,
        }),
      runCommand: () => {},
    });
  });
  afterEach(() => engine.dispose());

  it("allows a lobby command while nothing owns the keyboard", () => {
    expect(engine.allows("session.next")).toBe(true);
    expect(engine.allows("view.toggle")).toBe(true);
  });

  it("refuses it once an overlay is open", () => {
    overlay = true;
    expect(engine.allows("session.next")).toBe(false);
    expect(engine.allows("view.toggle")).toBe(false);
  });

  it("reads the LIVE context rather than the one it was initialised with", () => {
    overlay = true;
    expect(engine.allows("sidebar.toggle")).toBe(false);
    overlay = false;
    expect(engine.allows("sidebar.toggle")).toBe(true);
  });

  it("does not gate on the enabled flag — an always-on chord still arrives", () => {
    engine.setEnabled(false);
    expect(engine.allows("session.kill.current")).toBe(true);
  });
});

describe("createKeybindingEngine — Alt-hold tracker", () => {
  let engine: KeybindingEngine;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    engine = createKeybindingEngine();
    engine.init({ getContext: LOBBY_CTX, runCommand: () => {} });
  });
  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it("activates ~100ms after Alt goes down and clears on keyup", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    expect(engine.altActive()).toBe(false); // not yet — the 100ms delay
    vi.advanceTimersByTime(100);
    expect(engine.altActive()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", altKey: false }));
    expect(engine.altActive()).toBe(false);
  });

  it("clears immediately on window blur (Alt+Tab can't wedge the badges on)", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    vi.advanceTimersByTime(100);
    expect(engine.altActive()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(engine.altActive()).toBe(false);
  });

  it("also activates from the terminal iframe's forwarded Alt state (tl-kb-alt)", () => {
    engine.setFrameAlt(true);
    vi.advanceTimersByTime(100);
    expect(engine.altActive()).toBe(true);
    engine.setFrameAlt(false);
    expect(engine.altActive()).toBe(false);
  });

  it("never activates while the layer is disabled", () => {
    engine.setEnabled(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true }));
    vi.advanceTimersByTime(100);
    expect(engine.altActive()).toBe(false);
  });
});
