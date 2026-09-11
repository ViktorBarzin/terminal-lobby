import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKeybindingEngine, type KeybindingEngine } from "../src/keybindings/engine";
import { keyContext, type KeyContextInput } from "../src/keybindings/bindings.logic";
import { Terminal } from "@xterm/xterm";
import { isEditingTarget } from "../src/keybindings/editing";
import { EMPTY_HELD } from "../src/terminal/held";
import { reduce, type KeyWorld } from "../src/terminal/keys";

/**
 * Cmd+Z / Ctrl+Z from the key down to the two things that must NOT happen: the
 * lobby acting while a text field has the caret, and the byte reaching the pty.
 *
 * test/bindings.logic.test.ts already pins the table rows and their
 * when-clauses. This file drives the DOM layer under them — the real engine's
 * capture-phase window listener, the real focus reading, and the terminal's own
 * decision — because all three are where the chord could still be wrong with a
 * correct table.
 */

const ctxInput = (over: Partial<KeyContextInput> = {}): KeyContextInput => ({
  paletteOpen: false,
  helpOpen: false,
  settingsOpen: false,
  galleryOpen: false,
  previewOpen: false,
  previewDirty: false,
  editing: false,
  ...over,
});

function key(over: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...over });
}

const CTRL_Z = { key: "z", code: "KeyZ", ctrlKey: true };
const META_Z = { key: "z", code: "KeyZ", metaKey: true };
const CTRL_SHIFT_Z = { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true };
const META_SHIFT_Z = { key: "Z", code: "KeyZ", metaKey: true, shiftKey: true };

describe("isEditingTarget — who owns Cmd+Z right now", () => {
  const el = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild as Element;
  };

  // A field that takes typed text has its own undo, and the browser's is better
  // at it than we could be: it knows the caret, the selection and the words.
  const OWNS: [string, string][] = [
    ["a bare input", "<input>"],
    ["a text input", '<input type="text">'],
    ["a search box", '<input type="search">'],
    ["a password box", '<input type="password">'],
    ["an email box", '<input type="email">'],
    ["a url box", '<input type="url">'],
    ["a tel box", '<input type="tel">'],
    ["a number box", '<input type="number">'],
    ["a textarea", "<textarea></textarea>"],
    ["a contenteditable div", '<div contenteditable="true"></div>'],
    // CodeMirror's contentDOM is a contenteditable div carrying this class
    // (components/codemirror-view.ts styles `.cm-content`), and its own Mod-z is
    // the one the flag exists to protect.
    ["the CodeMirror content", '<div class="cm-content" contenteditable="true"></div>'],
  ];

  // ...and one that does not: pressing Cmd+Z on a checkbox means the lobby's
  // undo, because a checkbox has no edit history of its own to walk back.
  const DOES_NOT: [string, string][] = [
    ["nothing focused", ""],
    ["a checkbox", '<input type="checkbox">'],
    ["a radio", '<input type="radio">'],
    ["a file picker", '<input type="file">'],
    ["a range slider", '<input type="range">'],
    ["a submit button", '<input type="submit">'],
    ["a button", "<button></button>"],
    ["a select", "<select></select>"],
    ["a plain div", "<div></div>"],
    ["a card in the sidebar", '<li class="tl-card"></li>'],
  ];

  it.each(OWNS)("yields to %s", (_label, html) => {
    expect(isEditingTarget(el(html))).toBe(true);
  });

  it.each(DOES_NOT)("does not yield to %s", (_label, html) => {
    expect(isEditingTarget(html ? el(html) : null)).toBe(false);
  });

  it("yields to anything INSIDE the CodeMirror editor", () => {
    // A click can land focus on a line rather than on `.cm-content` itself, and
    // CodeMirror's keymap still runs from there.
    const editor = el('<div class="cm-editor"><div class="cm-line"></div></div>');
    const line = editor.querySelector(".cm-line") as Element;
    expect(isEditingTarget(line)).toBe(true);
  });

  /**
   * The one case the flag exists to get right, and the one a fixture cannot
   * check: the terminal.
   *
   * xterm types through a hidden `<textarea class="xterm-helper-textarea">`
   * inside its `.xterm` element, and `term.focus()` focuses exactly that
   * (@xterm/xterm 6.0.0). It is a plain non-readonly TEXTAREA, so reading the
   * tag alone says "a field is being typed into" for every attached session —
   * and then Cmd+Z does nothing in a session and Ctrl+Z goes on suspending the
   * foreground job, which is the pair ADR-0025 turned down.
   *
   * Focused for real rather than passed in, because App reads
   * `document.activeElement` (components/App.tsx keyContext) and the bug was
   * invisible to every test that hands the flag over as a fixture.
   */
  it("does not yield to the terminal, whose input proxy is a textarea", () => {
    // The REAL xterm, opened and focused, rather than markup written from
    // memory: what this has to be right about is upstream's DOM, and a fixture
    // of it would go on passing after an xterm bump moved the class.
    (window as unknown as Record<string, unknown>).matchMedia = () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 800 });
    Object.defineProperty(host, "clientHeight", { value: 600 });
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    term.focus();

    const active = document.activeElement as HTMLTextAreaElement;
    expect(active.tagName, "xterm focuses its helper textarea").toBe("TEXTAREA");
    expect(active.readOnly, "xterm only sets readOnly under disableStdin").toBe(false);
    expect(isEditingTarget(active)).toBe(false);

    term.dispose();
    host.remove();
  });

  it("does not yield to xterm's accessibility tree either", () => {
    // Anything xterm mounts inside its own element is the terminal, which is
    // why the test is by ancestry rather than on the helper textarea's class.
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="xterm"><div class="xterm-accessibility">' +
      '<div contenteditable="true"></div></div></div>';
    const live = host.querySelector("[contenteditable]") as Element;
    expect(isEditingTarget(live)).toBe(false);
  });

  it("does not yield to a readonly field", () => {
    // Nothing types into it, so it has no history and the lobby's undo is what
    // the press means.
    expect(isEditingTarget(el("<input readonly>"))).toBe(false);
    expect(isEditingTarget(el("<textarea readonly></textarea>"))).toBe(false);
  });
});

describe("the engine dispatches the undo chords", () => {
  let engine: KeybindingEngine;
  let ran: string[];
  let editing: boolean;

  beforeEach(() => {
    localStorage.clear();
    ran = [];
    editing = false;
    engine = createKeybindingEngine();
    engine.init({
      getContext: () => keyContext(ctxInput({ editing })),
      runCommand: (c) => ran.push(c),
    });
  });
  afterEach(() => engine.dispose());

  it.each([
    ["Ctrl+Z", CTRL_Z, "edit.undo"],
    ["Cmd+Z", META_Z, "edit.undo"],
    ["Ctrl+Shift+Z", CTRL_SHIFT_Z, "edit.redo"],
    ["Cmd+Shift+Z", META_SHIFT_Z, "edit.redo"],
  ] as const)("runs %s as %s", (_label, init, command) => {
    const e = key(init);
    window.dispatchEvent(e);
    expect(ran).toEqual([command]);
    // The preventDefault is what keeps the key off the pty as well; see the
    // terminal chain below.
    expect(e.defaultPrevented).toBe(true);
  });

  it.each([
    ["Ctrl+Z", CTRL_Z],
    ["Cmd+Z", META_Z],
    ["Ctrl+Shift+Z", CTRL_SHIFT_Z],
    ["Cmd+Shift+Z", META_SHIFT_Z],
  ] as const)("leaves %s to a focused field", (_label, init) => {
    editing = true;
    const e = key(init);
    window.dispatchEvent(e);
    expect(ran).toEqual([]);
    // ...and does NOT preventDefault, which is the whole point: CodeMirror's
    // Mod-z is a bubble-phase handler on its contentDOM and this listener is
    // capture-phase on window, so the only way the editor's own undo ever runs
    // is for this one to decline the key outright.
    expect(e.defaultPrevented).toBe(false);
  });

  it("hands the chord back to the terminal when App shortcuts are off", () => {
    engine.setEnabled(false);
    const e = key(CTRL_Z);
    window.dispatchEvent(e);
    expect(ran).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("stays out of the way behind an open dialog", () => {
    engine.dispose();
    engine = createKeybindingEngine();
    engine.init({
      getContext: () => keyContext(ctxInput({ settingsOpen: true })),
      runCommand: (c) => ran.push(c),
    });
    window.dispatchEvent(key(CTRL_Z));
    expect(ran).toEqual([]);
  });
});

/**
 * The SIGTSTP half, end to end.
 *
 * Ctrl+Z is the shell's suspend key, and claiming it globally means the pty
 * stops seeing it. That cost is signed off, but it has to actually work: a
 * chord that ran the lobby's undo AND suspended the foreground job would be the
 * worst of both. Nothing terminal-side was written for this — the chain is
 * engine.ts preventDefault on a match, TerminalNative's `appChord:
 * e.defaultPrevented`, then terminal/keys.ts declining the key — so this walks
 * all three rather than trusting them.
 */
describe("Ctrl+Z stops reaching the pty", () => {
  const world = (over: Partial<KeyWorld> = {}): KeyWorld => ({
    now: 10_000,
    macLike: false,
    appChord: false,
    selection: { hasSelection: false, selection: "", stash: null },
    held: EMPTY_HELD,
    heldDim: false,
    ...over,
  });

  let engine: KeybindingEngine;
  afterEach(() => engine.dispose());

  const press = (
    init: Partial<KeyboardEventInit> & { key: string },
    opts: { ctx?: Partial<KeyContextInput>; appShortcuts?: boolean } = {},
  ) => {
    localStorage.clear();
    const ran: string[] = [];
    engine = createKeybindingEngine();
    if (opts.appShortcuts === false) engine.setEnabled(false);
    engine.init({
      getContext: () => keyContext(ctxInput(opts.ctx)),
      runCommand: (c) => ran.push(c),
    });
    const e = key(init);
    window.dispatchEvent(e);
    // What TerminalNative.tsx hands `reduce` on every keydown: the engine has
    // already run in the capture phase by the time xterm asks.
    const decision = reduce(world({ appChord: e.defaultPrevented }), e);
    return { ran, decision };
  };

  it("runs the undo and declines the key", () => {
    const { ran, decision } = press(CTRL_Z);
    expect(ran).toEqual(["edit.undo"]);
    expect(decision.passToTerminal).toBe(false);
    expect(decision.leg).toBe("app-chord");
  });

  it("gives it straight back inside the file editor", () => {
    // Not the pty's key in this case either, but for the other reason: the
    // editor is not the terminal. What matters is that the lobby did nothing.
    const { ran } = press(CTRL_Z, { ctx: { editing: true } });
    expect(ran).toEqual([]);
  });

  it("gives it back to the pty when App shortcuts are off", () => {
    // The ⚙ switch is the whole reason these rows are in KB_DEFAULT_BINDINGS:
    // somebody who wants Ctrl+Z to suspend a job again has a way to say so.
    const { ran, decision } = press(CTRL_Z, { appShortcuts: false });
    expect(ran).toEqual([]);
    expect(decision.passToTerminal).toBe(true);
    expect(decision.leg).toBe("pty");
  });
});
