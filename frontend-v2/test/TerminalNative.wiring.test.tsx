/**
 * What `TerminalNative` WIRES, as opposed to what the terminal/ modules decide.
 *
 * The pure modules each have their own suite, and every one of them is already
 * green while the component ignores it: `fit.ts` can refuse a zero-size fit and
 * the component can still call `fitAddon.fit()` unconditionally, `attach.ts` can
 * fire `onHeld` at three sites and the component can pass no handler at all.
 * A hub that never calls its own modules is the gap a module test cannot see,
 * so this file drives the component and asserts on what came out the other
 * side: the options xterm was constructed with, the bytes the socket received,
 * the attributes on xterm's helper textarea, and the toasts a person would get.
 *
 * WHY xterm IS MOCKED HERE. jsdom can open a real xterm (test/xterm.baseline
 * .test.ts does, deliberately), but it has no layout, so nothing downstream of
 * a real `paste()` or a real mouse event is observable: the cell geometry that
 * turns a click into a mouse report does not exist. The fake records the calls
 * the component makes, which is exactly the claim under test here. What xterm
 * itself does with them is upstream's business and is covered by that baseline
 * test.
 *
 * WHAT THIS FILE CANNOT REACH, and where it is checked instead:
 *   - whether a fit produces the right GRID. No layout in jsdom; the guard's
 *     arithmetic is terminal.fit.test.ts and the real geometry needs a browser.
 *   - whether Gboard's predictive text actually stops committing into the
 *     terminal. That is a device claim (the shared Android emulator), and the
 *     attributes below are only the mechanism term.html uses to make it.
 *   - whether a dispatched clone actually makes xterm SELECT. The fake records
 *     the clone; what `SelectionService` does with it is upstream's, needs
 *     layout, and is a browser claim. Same for the real cell geometry behind a
 *     status-row report: the box here is a stub, so what is under test is the
 *     arithmetic being fed the box term.html measures, not the pixels.
 *   - what a soft keyboard really does to the viewport. The gates below are
 *     driven by a faked `visualViewport` and a faked `matchMedia`; the WebKit
 *     and Gboard halves are device claims.
 *   - whether a real browser then FIRES its paste event once the key handler
 *     answers false, and whether a real xterm would have sent the ^V byte if
 *     it had not. Both are the browser's and xterm's own behaviour, and xterm
 *     is mocked here, so the paste chord is pinned by the value the handler
 *     returns plus a pty capture on the deployed site.
 *   - links, the compose mirror, the REST of the key-handler contract (the
 *     paste leg is wired below; copy, Escape, the app chords, F12 and the
 *     Option-arrow jumps are not) and the held-key overlay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FONT_SIZE_KEY, PREFS_KEY } from "../src/store/prefs";
import { toasts, type PushToast } from "../src/store/toast";
import type { TerminalReport } from "../src/diagnostics/status";

/* ------------------------------------------------------------------ *
 * The xterm stand-ins. Hoisted because vi.mock is.
 * ------------------------------------------------------------------ */

const xt = vi.hoisted(() => {
  interface Disposable {
    dispose(): void;
  }
  const nothing: Disposable = { dispose() {} };

  class FakeTerminal {
    /** The constructor argument, kept as passed. Item 1's whole subject. */
    readonly ctor: Record<string, unknown>;
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    host: HTMLElement | null = null;
    readonly onDataCbs: ((data: string) => void)[] = [];
    readonly onBinaryCbs: ((data: string) => void)[] = [];
    atlasCleared = 0;
    /** Every `term.paste()` the component made, in order. */
    readonly pasted: string[] = [];
    readonly written: Uint8Array[] = [];
    focused = 0;
    refreshed = 0;
    disposed = 0;
    /** Every `term.clearSelection()` the component made. */
    cleared = 0;
    /** What `hasSelection()` answers. The drag interceptor branches on it. */
    selected = false;
    /** `term.modes`, of which the interceptor reads exactly one field. */
    modes: { mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" } = {
      mouseTrackingMode: "any",
    };
    /**
     * The node real xterm hangs its own mouse handlers on, and the node the
     * drag interceptor tests every press against. Created in `open()` because
     * that is when xterm creates it.
     */
    screen: HTMLDivElement | null = null;

    constructor(opts: Record<string, unknown>) {
      this.ctor = { ...opts };
      this.options = { ...opts };
      made.terminals.push(this);
    }
    loadAddon(): void {}
    open(host: HTMLElement): void {
      this.host = host;
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      host.appendChild(screen);
      this.screen = screen;
      if (!made.lateTextarea) this.createHelperTextarea();
    }
    /** What `getSelection()` answers, i.e. xterm's right-trimmed text. */
    selectionText = "";
    /** How many times the component asked for the selection TEXT. */
    selectionReads = 0;
    /**
     * The ONE handler xterm stores, as the component installed it. A second
     * `attachCustomKeyEventHandler` call would replace it, which is why the
     * component has to fit everything it wants into this one function.
     */
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    hasSelection(): boolean {
      return this.selected;
    }
    getSelection(): string {
      this.selectionReads++;
      return this.selectionText;
    }
    clearSelection(): void {
      this.cleared++;
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = h;
    }
    /** xterm 6 makes this inside open(); `lateTextarea` defers it so the
     *  component's not-there-yet arm can be driven. */
    createHelperTextarea(): void {
      const ta = document.createElement("textarea");
      ta.className = "xterm-helper-textarea";
      this.host?.appendChild(ta);
    }
    onData(cb: (data: string) => void): Disposable {
      this.onDataCbs.push(cb);
      return nothing;
    }
    onBinary(cb: (data: string) => void): Disposable {
      this.onBinaryCbs.push(cb);
      return nothing;
    }
    paste(text: string): void {
      this.pasted.push(text);
    }
    write(bytes: Uint8Array): void {
      this.written.push(bytes);
    }
    focus(): void {
      this.focused++;
    }
    refresh(): void {
      this.refreshed++;
    }
    clearTextureAtlas(): void {
      this.atlasCleared++;
    }
    dispose(): void {
      this.disposed++;
    }
  }

  class FakeFitAddon {
    fits = 0;
    constructor() {
      made.fitAddons.push(this);
    }
    activate(): void {}
    dispose(): void {}
    fit(): void {
      this.fits++;
    }
  }

  const made = {
    terminals: [] as FakeTerminal[],
    fitAddons: [] as FakeFitAddon[],
    lateTextarea: false,
  };
  return { FakeTerminal, FakeFitAddon, made };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xt.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xt.FakeFitAddon }));

// Imported after the mocks so the component's dynamic imports resolve to them.
import { TerminalNative } from "../src/components/TerminalNative";
import { THEME_LIVE_GLOBAL } from "../src/terminal/theme";

/* ------------------------------------------------------------------ *
 * The environment the component expects and jsdom does not have.
 * ------------------------------------------------------------------ */

/** ttyd's websocket, driven by hand: nothing opens or closes on its own. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState: number = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly url: string, readonly protocol: string) {
    sockets.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  /** The handshake completing. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  /** One server frame, as a view over bytes (wire.ts takes either). */
  deliver(bytes: readonly number[]): void {
    this.onmessage?.({ data: new Uint8Array(bytes) });
  }
}

let sockets: FakeSocket[] = [];
/**
 * The ResizeObserver callbacks the component installed. The real observer
 * delivers one entry the moment it observes; this one fires only when a test
 * says so, which keeps the boot fit and the observer's first notification
 * distinguishable.
 */
let observers: (() => void)[] = [];
class FakeResizeObserver {
  constructor(cb: () => void) {
    observers.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The host's measurement, which every fit decision is taken from. */
let boxW = 800;
let boxH = 600;

/**
 * Every toast the component RAISED, which is not the same list as the toasts
 * currently on screen: the watch nudge asks for 2500ms and the throttle it is
 * gated by is 4000, so the live stack has dropped it before the window ends.
 * Counting the stack would count dismissals.
 */
let raised: { message: string; kind: string }[] = [];
let realPush: (t: PushToast) => number;

/** term.html's refit() debounce (term.html:8471-8481), plus a frame of slack. */
const PAST_DEBOUNCE_MS = 150;

const TERM_HTML = readFileSync(
  resolve(__dirname, "../..", "frontend/term.html"),
  "utf8",
);
/** Curly apostrophes to straight, so a quoted string can be compared. */
const plain = (s: string): string => s.replace(/[‘’]/g, "'");

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  observers = [];
  boxW = 800;
  boxH = 600;
  xt.made.terminals.length = 0;
  xt.made.fitAddons.length = 0;
  xt.made.lateTextarea = false;
  toasts.clear();
  raised = [];
  realPush = toasts.push;
  toasts.push = (t: PushToast): number => {
    raised.push({ message: t.message, kind: t.kind });
    return realPush(t);
  };
  // The component installs its window bridges from inside its async body, so
  // Solid's owner is already gone and the unmount never hands them back (the
  // "cleanups created outside a createRoot" warning the suite prints). Clear
  // them here rather than letting one test's terminal answer the next one's.
  for (const key of [
    "__tlSendToTerminal",
    "__tlPasteToTerminal",
    "__tlFocusTerminal",
    "__tlRefitTerminal",
    "__tlKeyboardOffset",
  ]) {
    Reflect.deleteProperty(window, key);
  }
  localStorage.clear();
  document.body.style.removeProperty("--font-mono");
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    FakeResizeObserver;
  // /token, answered the way ttyd answers it.
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    json: async () => ({ token: "qa-token" }),
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => boxW,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => boxH,
  });
});

afterEach(() => {
  toasts.push = realPush;
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  vi.useRealTimers();
});

/** Let every pending microtask run: the two dynamic imports and /token. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function one<T>(list: readonly T[], what: string): T {
  const first = list[0];
  if (first === undefined) throw new Error(`no ${what} was created`);
  expect(list, `exactly one ${what}`).toHaveLength(1);
  return first;
}

interface Mounted {
  term: InstanceType<typeof xt.FakeTerminal>;
  fit: InstanceType<typeof xt.FakeFitAddon>;
  /** The newest socket the ladder opened. */
  socket(): FakeSocket;
  /** A keystroke, as xterm's onData delivers it. */
  type(data: string): void;
  /** A mouse report, as xterm's onBinary delivers it. */
  mouse(data: string): void;
  /** The ResizeObserver firing. */
  observed(): void;
  /** The session going off screen and coming back (SessionView's onScreen). */
  setOnScreen(v: boolean): void;
  /** Everything `onConn` was told about the socket, in order (ADR-0016). */
  reports: TerminalReport[];
  /** The levers `onReady` handed up, which is what SessionView holds. */
  control(): { reconnect: () => void; ask: () => void };
  unmount(): void;
}

async function mount(
  opts: { watch?: boolean; onScreen?: boolean } = {},
): Promise<Mounted> {
  const [onScreen, setOnScreen] = createSignal(opts.onScreen ?? true);
  const reports: TerminalReport[] = [];
  // A list rather than a nullable local, so TypeScript does not have to be
  // argued out of narrowing an assignment made inside a callback.
  const controls: { reconnect: () => void; ask: () => void }[] = [];
  const r = render(() => (
    <TerminalNative
      args="arg=qa-native"
      watch={() => opts.watch === true}
      ownsBridges={onScreen()}
      onConn={(report) => void reports.push(report)}
      onReady={(c) => void controls.push(c)}
    />
  ));
  await settle();
  const term = one(xt.made.terminals, "terminal");
  const fit = one(xt.made.fitAddons, "fit addon");
  return {
    term,
    fit,
    socket: () => {
      const s = sockets[sockets.length - 1];
      if (!s) throw new Error("no socket was opened");
      return s;
    },
    type: (data) => {
      for (const cb of term.onDataCbs) cb(data);
    },
    mouse: (data) => {
      for (const cb of term.onBinaryCbs) cb(data);
    },
    observed: () => {
      for (const cb of observers) cb();
    },
    setOnScreen,
    reports,
    control: () => one(controls, "onReady control"),
    unmount: () => r.unmount(),
  };
}

/** A live socket: mounted, /token answered, handshake accepted. */
async function mountOpen(
  opts: { watch?: boolean; onScreen?: boolean } = {},
): Promise<Mounted> {
  const m = await mount(opts);
  m.socket().accept();
  await settle();
  return m;
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** MSG_INPUT frames with a payload. The empty ones are liveness probes. */
function inputs(s: FakeSocket): number[][] {
  return s.sent
    .filter(isBytes)
    .filter((b) => b[0] === 0x30 && b.length > 1)
    .map((b) => Array.from(b.slice(1)));
}

/** Every MSG_INPUT frame, empty payload included. Nothing probes this early. */
function anyInput(s: FakeSocket): Uint8Array[] {
  return s.sent.filter(isBytes).filter((b) => b[0] === 0x30);
}

/** MSG_RESIZE frames, decoded. */
function resizes(s: FakeSocket): string[] {
  return s.sent
    .filter(isBytes)
    .filter((b) => b[0] === 0x31)
    .map((b) => new TextDecoder().decode(b.slice(1)));
}

const messages = (): string[] => raised.map((r) => r.message);

/**
 * A mouse event marked TRUSTED.
 *
 * Faking it is not optional: `isTrusted` is the drag interceptor's recursion
 * guard (dragselect.ts, the pass-through set), so a test that could not fake it
 * would only ever reach the arm that does nothing.
 *
 * Two things make it awkward, and both are jsdom's. The wrapper's `isTrusted`
 * is an unforgeable, NON-configurable accessor, so it cannot be redefined on
 * the event; it reads the flag off jsdom's own impl object
 * (living/generated/Event.js:48-67). And `dispatchEvent` writes
 * `eventImpl.isTrusted = false` itself, right before dispatching
 * (living/events/EventTarget-impl.js:102), so setting the flag beforehand is
 * overwritten. The impl object IS ordinary, so redefining the property there as
 * a constant-true accessor with a no-op setter satisfies jsdom's write and
 * every read that follows it.
 */
function trusted(type: string, init: MouseEventInit): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const impl = Object.getOwnPropertySymbols(e).find((s) => s.description === "impl");
  if (!impl) throw new Error("jsdom's event impl symbol is gone; see `trusted`");
  const inner = (e as unknown as Record<symbol, object>)[impl];
  Object.defineProperty(inner, "isTrusted", {
    configurable: true,
    get: () => true,
    set: () => {},
  });
  return e;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Give the `.xterm-screen` node a box. jsdom lays nothing out, so every rect it
 * reports is 0x0, and a 0-height box makes `clientY - top >= height * (rows-1)
 * / rows` true for every press, so without this every press would look like a
 * tmux status-row click.
 */
function boxScreen(term: InstanceType<typeof xt.FakeTerminal>, box: Box): HTMLDivElement {
  const el = term.screen;
  if (!el) throw new Error("the terminal has no .xterm-screen");
  el.getBoundingClientRect = (): DOMRect =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/** Every mousedown that reached xterm's own node, which is only ever a clone. */
function watchPresses(el: HTMLElement): MouseEvent[] {
  const seen: MouseEvent[] = [];
  el.addEventListener("mousedown", (e) => void seen.push(e as MouseEvent));
  return seen;
}

/** The MSG_INPUT payloads, as text: what a replayed status-row click sends. */
function sgr(s: FakeSocket): string[] {
  const decoder = new TextDecoder();
  return inputs(s).map((b) => decoder.decode(new Uint8Array(b)));
}

/* ------------------------------------------------------------------ *
 * 1. Constructor options (term.html:5006-5074)
 * ------------------------------------------------------------------ */

describe("constructor options (term.html:5006-5074)", () => {
  /**
   * Each of these only exists as a constructor argument for a reason the page
   * argues at the site; `scrollback` is the one with a visible cost, because
   * xterm's own default is 1000 and the page asks for ten times that.
   */
  it.each([
    ["allowProposedApi", true],
    ["cursorBlink", true],
    ["cursorStyle", "block"],
    ["cursorInactiveStyle", "outline"],
    ["fontSize", 15],
    ["lineHeight", 1],
    ["letterSpacing", 0],
    ["fontWeightBold", "700"],
    ["minimumContrastRatio", 4.5],
    ["macOptionClickForcesSelection", true],
    ["altClickMovesCursor", false],
    ["scrollback", 10000],
  ])("passes %s = %o", async (key, value) => {
    const m = await mount();
    expect(m.term.ctor[key]).toEqual(value);
  });

  it("takes the mono stack from the app's own --font-mono", async () => {
    document.body.style.setProperty("--font-mono", "Probe Mono, monospace");
    const m = await mount();
    expect(m.term.ctor.fontFamily).toBe("Probe Mono, monospace");
  });

  it("falls back to the JetBrains stack when the var reads empty", async () => {
    const m = await mount();
    expect(String(m.term.ctor.fontFamily)).toContain("JetBrains Mono");
  });

  it("still passes the theme it always did", async () => {
    const m = await mount();
    const theme = m.term.ctor.theme as Record<string, string> | undefined;
    expect(theme).toBeTruthy();
    expect(theme).toHaveProperty("background");
  });

  /** The roamed doc, which is where every font and cursor value comes from. */
  it("reads the roamed prefs out of tl:prefs:v1", async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        fontSize: 11,
        lineHeight: 1.2,
        letterSpacing: 0.5,
        cursorStyle: "bar",
        cursorBlink: false,
        fontWeightBold: "600",
      }),
    );
    const m = await mount();
    expect(m.term.ctor).toMatchObject({
      fontSize: 11,
      lineHeight: 1.2,
      letterSpacing: 0.5,
      cursorStyle: "bar",
      cursorBlink: false,
      fontWeightBold: "600",
    });
  });

  /**
   * A value the vanilla page's PREF_VALID would reject must not reach xterm
   * either: `coercePrefs` is the shared validator, and the point of using it
   * rather than reading the doc directly is that a hand-edited or older doc
   * cannot put "wobble" into `cursorStyle`.
   */
  it.each([
    ["cursorStyle", "wobble", "block"],
    ["fontSize", 99, 15],
    ["lineHeight", 9, 1],
    ["letterSpacing", -4, 0],
    ["fontWeightBold", "900", "700"],
    ["cursorBlink", "yes", true],
  ])("defaults %s when the doc says %o", async (key, stored, expected) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ [key]: stored }));
    const m = await mount();
    expect(m.term.ctor[key]).toEqual(expected);
  });

  /**
   * The A-/A+ stepper wrote `tl-font-size` long before the roamed doc existed,
   * and both readers still honour it when the doc carries no usable size
   * (term.html:2956, store/prefs.ts seedFontSize).
   */
  it("seeds fontSize from the legacy device key when the doc has none", async () => {
    localStorage.setItem(FONT_SIZE_KEY, "12");
    const m = await mount();
    expect(m.term.ctor.fontSize).toBe(12);
  });

  it("ignores a legacy device key outside the valid range", async () => {
    localStorage.setItem(FONT_SIZE_KEY, "400");
    const m = await mount();
    expect(m.term.ctor.fontSize).toBe(15);
  });

  it("survives a corrupt prefs doc", async () => {
    localStorage.setItem(PREFS_KEY, "{not json");
    const m = await mount();
    expect(m.term.ctor.fontSize).toBe(15);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Paste route (term.html:9404-9409)
 * ------------------------------------------------------------------ */

describe("the paste bridge goes through term.paste (term.html:9404-9409)", () => {
  it("hands the text to term.paste and sends nothing raw", async () => {
    const m = await mountOpen();
    const took = window.__tlPasteToTerminal?.("one\ntwo\nthree");
    expect(took).toBe(true);
    expect(m.term.pasted).toEqual(["one\ntwo\nthree"]);
    // Raw input is the bug: it skips the bracketing and the \r\n
    // normalization, so a shell runs the paste line by line.
    expect(inputs(m.socket())).toEqual([]);
  });

  it("takes an empty paste without troubling the pty", async () => {
    const m = await mountOpen();
    expect(window.__tlPasteToTerminal?.("")).toBe(true);
    expect(m.term.pasted).toEqual([]);
    // Not even an empty INPUT frame, which is what a raw send produces for it.
    expect(anyInput(m.socket())).toEqual([]);
  });

  /**
   * The bridge is a named global, so the terminal that is on screen owns it. A
   * hidden session must not answer a paste aimed at the visible one.
   */
  it("is not owned while the session is off screen", async () => {
    const m = await mount({ onScreen: false });
    expect(window.__tlPasteToTerminal).toBeUndefined();
    m.setOnScreen(true);
    expect(window.__tlPasteToTerminal).toBeTypeOf("function");
  });

  /**
   * Watch mode is not weakened by the new route: `term.paste` reaches the pty
   * through xterm's own onData, which is the same choke point a keystroke
   * takes (wire.ts `decideInput`), so a watcher's paste is still dropped.
   */
  it("leaves the watch-mode drop where it was", async () => {
    const m = await mountOpen({ watch: true });
    window.__tlPasteToTerminal?.("rm -rf /");
    // The fake does not re-emit onData, so drive the choke point directly with
    // what xterm would have produced.
    m.type("rm -rf /");
    expect(inputs(m.socket())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. The paste chord, and the browser paste it lets through
 *     (term.html:8585-8587 and :8932-8944)
 * ------------------------------------------------------------------ */

/**
 * The defect this section pins, measured on the deployed site with a raw pty
 * capture: with terminal focus in both cases, Ctrl+V on the iframe path put the
 * 53 bytes of clipboard text on the pty, and on `?native=1` it put a single
 * 0x16. In zsh ^V is quoted-insert, so it also swallowed the first byte of the
 * next paste, whose leading ESC was then self-inserted, the bracketed-paste
 * widget never fired, and the CRs ran the lines one by one.
 *
 * Both halves needed wiring. xterm's default handling of Ctrl+V sends ^V and
 * preventDefaults the keydown, so on that chord no paste event was ever fired;
 * and the only receiver a fired one had was xterm's own listener on its helper
 * textarea, since this app's document paste listener (`clipboard/attach.ts`)
 * takes IMAGE items and passes text through to the focused field. The
 * component now takes the event first and routes it through the same
 * `term.paste` call the toolbar bridge uses, which is the route already
 * measured against the iframe byte for byte.
 */
describe("the paste chord (term.html:8585-8587)", () => {
  /** xterm consulting the one handler it stores. */
  const consult = (
    m: Mounted,
    type: "keydown" | "keyup",
    init: KeyboardEventInit,
  ): boolean => {
    const handler = m.term.keyHandler;
    if (!handler) throw new Error("no custom key event handler was installed");
    return handler(new KeyboardEvent(type, init));
  };
  const CTRL_V: KeyboardEventInit = { key: "v", code: "KeyV", ctrlKey: true };
  const CTRL_C: KeyboardEventInit = { key: "c", code: "KeyC", ctrlKey: true };

  it("installs a handler at all", async () => {
    const m = await mountOpen();
    expect(m.term.keyHandler).toBeTypeOf("function");
  });

  /**
   * FALSE is the whole fix: it is what stops xterm both sending ^V and
   * preventDefaulting the keydown, and the preventDefault is what suppressed
   * the browser's paste event. term.html answers the same thing for the same
   * reason (:8585-8586, "let the browser paste event fire").
   *
   * With xterm mocked, the 0x16 byte cannot be produced here at all, so what
   * is asserted is the answer that governs it. The byte was measured twice
   * elsewhere: on the deployed site off the pty, and against the real xterm 6
   * in jsdom, where the same keydown yields `onData: "\x16"` with
   * `defaultPrevented: true` unhandled, and nothing at all with this answer.
   */
  it("keeps Ctrl+V out of xterm's hands, so no ^V reaches the pty", async () => {
    const m = await mountOpen();
    expect(consult(m, "keydown", CTRL_V)).toBe(false);
    expect(inputs(m.socket())).toEqual([]);
  });

  /**
   * xterm yields no key and no preventDefault for Cmd+V, so a Mac was already
   * getting its paste event. Answering the same thing for both is what keeps
   * the chord from meaning one thing per platform.
   */
  it("answers the same for Cmd+V, which is the chord on a Mac", async () => {
    const m = await mountOpen();
    expect(consult(m, "keydown", { key: "v", code: "KeyV", metaKey: true })).toBe(false);
  });

  /**
   * The decision comes from `selection.ts` rather than from a chord test
   * written in the component, and this is the case that tells the two apart: on
   * a Cyrillic layout Ctrl+V reports `key: "м"`, so an `e.key === "v"` test
   * misses it and the chord falls through as ^V (ADR-0003's layout rule).
   */
  it("catches the chord on a layout where the key is not 'v'", async () => {
    const m = await mountOpen();
    expect(consult(m, "keydown", { key: "м", code: "KeyV", ctrlKey: true })).toBe(false);
  });

  /**
   * xterm consults the handler on keyup too, where a false would cost it the
   * focus and cursor-style work `_keyUp` does. selection.ts answers `pty` for
   * anything that is not a keydown (term.html:8517).
   */
  it("passes the chord's keyup through", async () => {
    const m = await mountOpen();
    expect(consult(m, "keyup", CTRL_V)).toBe(true);
  });

  it("leaves an ordinary keystroke on its way to the pty", async () => {
    const m = await mountOpen();
    expect(consult(m, "keydown", { key: "a", code: "KeyA" })).toBe(true);
    m.type("a");
    expect(inputs(m.socket())).toEqual([[0x61]]);
  });

  /**
   * THIS PHASE WIRES THE PASTE LEG AND NOTHING ELSE, and these two pin that
   * rather than leaving it to a comment. The same decision also carries the
   * copy chord and the Escape-clears-a-selection leg (term.html:8565-8584),
   * and both must answer exactly what xterm answers today with no handler
   * installed: Ctrl+C stays SIGINT even with a highlight on screen, which is
   * ADR-0003's contract still unhonoured on this path, and Escape reaches the
   * app without clearing the highlight. Half-wiring either one is the silent
   * failure, so `cleared` and the socket are checked as well.
   */
  it("still hands the copy chord to the pty, selection or not", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    expect(consult(m, "keydown", CTRL_C)).toBe(true);
    m.type("\x03");
    expect(inputs(m.socket())).toEqual([[0x03]]);
    expect(m.term.pasted).toEqual([]);
  });

  it("still hands Escape to the pty and clears no selection", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    expect(consult(m, "keydown", { key: "Escape", code: "Escape" })).toBe(true);
    expect(m.term.cleared).toBe(0);
    m.type("\x1b");
    expect(inputs(m.socket())).toEqual([[0x1b]]);
  });

  /**
   * term.html reads `term.getSelection()` only inside its copy branch (:8570),
   * never on an ordinary keystroke, and the component keeps that by passing the
   * text as a getter: xterm builds the string by translating every selected row.
   */
  it("does not build the selection text on every keystroke", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    m.term.selectionReads = 0;
    consult(m, "keydown", { key: "a", code: "KeyA" });
    consult(m, "keydown", CTRL_V);
    expect(m.term.selectionReads).toBe(0);
    // And the getter is really xterm's, not a hardcoded "": the copy arm asks
    // for the text, which is the one arm term.html reads it in.
    consult(m, "keydown", CTRL_C);
    expect(m.term.selectionReads).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 2c. The paste EVENT the chord now allows (term.html:8932-8944)
 * ------------------------------------------------------------------ */

describe("the browser paste event reaches the pty", () => {
  /** A paste event carrying text, the way jsdom will let one be built. */
  const pasteEvent = (text: string): Event => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { getData: (type: string) => (type === "text" ? text : "") },
    });
    return e;
  };

  /** xterm's own input proxy, which is where a paste is really dispatched. */
  const textareaOf = (m: Mounted): HTMLTextAreaElement => {
    const ta = m.term.host?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (!ta) throw new Error("the terminal has no helper textarea");
    return ta;
  };

  it("hands the text to term.paste, not to a raw send", async () => {
    const m = await mountOpen();
    const e = pasteEvent("echo hello");
    textareaOf(m).dispatchEvent(e);
    expect(m.term.pasted).toEqual(["echo hello"]);
    expect(inputs(m.socket())).toEqual([]);
  });

  /**
   * The paste that was wrecked. `term.paste` brackets the text and turns the
   * newlines into CRs (measured against the real xterm 6 with DECSET 2004 on:
   * `\x1b[200~one\rtwo\x1b[201~`), and the ^V is what broke that bracketing:
   * the leading ESC was self-inserted by zsh's quoted-insert, the
   * bracketed-paste widget never fired, and the CRs ran the lines one by one.
   */
  it("takes a multiline paste through the same route as the bridge", async () => {
    const m = await mountOpen();
    textareaOf(m).dispatchEvent(pasteEvent("one\ntwo\nthree"));
    window.__tlPasteToTerminal?.("one\ntwo\nthree");
    // The same argument to term.paste either way, which is the claim: the
    // toolbar's route was already measured against the iframe byte for byte.
    expect(m.term.pasted).toEqual(["one\ntwo\nthree", "one\ntwo\nthree"]);
    expect(inputs(m.socket())).toEqual([]);
  });

  /**
   * preventDefault keeps the text out of xterm's offscreen helper textarea, the
   * field xterm empties itself on the paste path being bypassed here
   * (term.html:8934 does the same). stopPropagation is what keeps the text from
   * being pasted TWICE: xterm registers its own `handlePasteEvent` on that
   * textarea and on `.xterm` in `_initGlobal`, which `open()` calls, and it
   * calls the same routine `term.paste` calls.
   */
  it("stops the event it took", async () => {
    const m = await mountOpen();
    const ta = textareaOf(m);
    // Registered where xterm registers its own, so this stands in for it.
    let reachedXterm = false;
    ta.addEventListener("paste", () => void (reachedXterm = true));
    const e = pasteEvent("echo hello");
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(reachedXterm).toBe(false);
  });

  /**
   * An image paste belongs to `clipboard/attach.ts`, which uploads it and types
   * the path at the prompt. Its document listener runs first, being higher in
   * the capture path, but one that got this far must be left alone rather than
   * swallowed with nothing pasted (term.html takes its image branch first for
   * the same reason, :8905-8930).
   */
  it("leaves a paste carrying no text alone", async () => {
    const m = await mountOpen();
    const e = pasteEvent("");
    textareaOf(m).dispatchEvent(e);
    expect(m.term.pasted).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * Scoped to the terminal's own host, where term.html could use the document
   * because that page held one terminal and excluded its own compose field by
   * id (:8900-8903). The lobby's inputs live in THIS document: a document-level
   * swallow would send the composer's and the rename box's text to the pty.
   */
  it("does not touch a paste aimed at a lobby text field", async () => {
    const m = await mountOpen();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const e = pasteEvent("a message for the composer");
    field.dispatchEvent(e);
    expect(m.term.pasted).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    field.remove();
  });

  /**
   * The other half of that scoping. Every mounted session's document listener
   * sees one paste (the duplication `clipboard/attach.ts` needed an `active`
   * gate for, four byte-identical uploads from one gesture), while only the
   * focused terminal's host is on the event's path.
   */
  it("is taken by the terminal the paste landed in, not by every one mounted", async () => {
    // One at a time, for the module-mock race the drag section documents.
    const r = render(() => <TerminalNative args="arg=first" ownsBridges={true} />);
    await settle();
    const r2 = render(() => <TerminalNative args="arg=second" ownsBridges={false} />);
    await settle();
    const [first, second] = xt.made.terminals;
    if (!first || !second) throw new Error("two terminals were expected");
    const ta = second.host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!ta) throw new Error("the second terminal has no helper textarea");

    ta.dispatchEvent(pasteEvent("only mine"));

    expect(second.pasted).toEqual(["only mine"]);
    expect(first.pasted).toEqual([]);
    r.unmount();
    r2.unmount();
  });

  /** Watch mode is not weakened: the route is the bridge's, so is the drop. */
  it("still lets watch mode drop it at the choke point", async () => {
    const m = await mountOpen({ watch: true });
    textareaOf(m).dispatchEvent(pasteEvent("rm -rf /"));
    expect(m.term.pasted).toEqual(["rm -rf /"]);
    // The fake does not re-emit onData, so drive the choke point with what
    // xterm's own paste would have produced.
    m.type("rm -rf /");
    expect(inputs(m.socket())).toEqual([]);
  });

  it("stops taking pastes once the terminal is unmounted", async () => {
    const m = await mountOpen();
    const ta = textareaOf(m);
    m.unmount();
    await settle();
    const e = pasteEvent("after the unmount");
    ta.dispatchEvent(e);
    expect(m.term.pasted).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Mouse reporting (term.html:8359-8370)
 * ------------------------------------------------------------------ */

describe("mouse reporting (term.html:8359-8370)", () => {
  it("installs an onBinary handler at all", async () => {
    const m = await mount();
    expect(m.term.onBinaryCbs).toHaveLength(1);
  });

  it("sends one byte per char, never UTF-8", async () => {
    const m = await mountOpen();
    // An SGR-mode report with a coordinate byte above 0x7f: UTF-8 would make
    // that two bytes and desync the sequence the server is parsing.
    m.mouse("\x1b[M \xc8!");
    expect(inputs(m.socket())).toEqual([[0x1b, 0x5b, 0x4d, 0x20, 0xc8, 0x21]]);
  });

  it("reports while watching, because onBinary has no watch guard", async () => {
    const m = await mountOpen({ watch: true });
    m.mouse("\x1b[M !!");
    expect(inputs(m.socket())).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Fit guard (term.html:5579-5613, replay at :9441)
 * ------------------------------------------------------------------ */

describe("the fit guard (term.html:5579-5613)", () => {
  it("fits once at boot when the host has a box", async () => {
    const m = await mount();
    expect(m.fit.fits).toBe(1);
  });

  it("does not fit at boot into a zero-size host", async () => {
    boxW = 0;
    boxH = 0;
    const m = await mount();
    expect(m.fit.fits).toBe(0);
  });

  /**
   * The whole point of the guard. A hidden session's host measures 0x0, and a
   * fit there computes a ~13x7 grid that ttyd's tmux client then imposes on
   * every other client attached to the session.
   */
  it("skips a zero-size resize and sends no size either", async () => {
    const m = await mountOpen();
    boxW = 0;
    boxH = 0;
    m.observed();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1); // the boot fit, and nothing since
    // A resize sent from a hidden session is the second half of the damage:
    // tmux sizes a window to its LATEST active client (store/keepalive.ts).
    expect(resizes(m.socket())).toEqual([]);
  });

  it("replays the owed fit when the view comes back", async () => {
    const m = await mountOpen({ onScreen: true });
    boxW = 0;
    boxH = 0;
    m.setOnScreen(false);
    m.observed();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);

    boxW = 800;
    boxH = 600;
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
    expect(resizes(m.socket())).toEqual(['{"columns":80,"rows":24}']);
  });

  it("owes ONE fit however many were skipped", async () => {
    const m = await mountOpen();
    boxW = 0;
    boxH = 0;
    for (let i = 0; i < 5; i++) {
      m.observed();
      vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    }
    await settle();
    boxW = 800;
    boxH = 600;
    m.setOnScreen(false);
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
  });

  /**
   * A view switch with nothing outstanding must not emit a tmux resize for a
   * geometry that was already right (`if (!hidden && owed()) refit()`).
   */
  it("does nothing when the view returns with no debt", async () => {
    const m = await mountOpen();
    m.setOnScreen(false);
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);
    expect(resizes(m.socket())).toEqual([]);
  });

  /**
   * The race between the visibility signal and the class flip: `onScreen`
   * turning true does not mean the host has a box yet, and a fit taken then
   * would be the zero-size one. The debt has to survive it.
   */
  it("keeps the debt when the view returns still measuring 0x0", async () => {
    const m = await mountOpen();
    boxW = 0;
    boxH = 0;
    m.observed(); // the debt
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    m.setOnScreen(false);
    m.setOnScreen(true); // on screen, still no box
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);

    boxW = 800;
    boxH = 600;
    m.setOnScreen(false);
    m.setOnScreen(true); // now there is one, and the debt is still owed
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
  });

  /**
   * DEBOUNCE THE TRIGGER, NOT THE FIT. Each fit emits a tmux resize, and a
   * rotate or the soft keyboard animating fires a burst of notifications.
   */
  it("coalesces a burst of notifications into one fit", async () => {
    const m = await mountOpen();
    m.observed();
    m.observed();
    m.observed();
    expect(m.fit.fits).toBe(1); // nothing yet: the boot fit only
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
    expect(resizes(m.socket())).toEqual(['{"columns":80,"rows":24}']);
  });

  /**
   * A view switch arriving inside the debounce window must not downgrade the
   * fit that was already wanted: only a `fit-wanted` records the debt when the
   * box is zero, and a `shown` that replaces it records nothing, so the fit is
   * never replayed and the geometry stays wrong until something else resizes.
   */
  it("does not let a view switch swallow a fit that was owed", async () => {
    const m = await mountOpen();
    boxW = 0;
    boxH = 0;
    m.observed();
    m.setOnScreen(false);
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);

    boxW = 800;
    boxH = 600;
    m.setOnScreen(false);
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
  });

  /** The debounce outlives an unmount, and a disposed xterm has no geometry. */
  it("does not fit a terminal that has gone away", async () => {
    const m = await mountOpen();
    m.observed();
    m.unmount();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);
  });

  it("routes the __tlRefitTerminal bridge through the guard too", async () => {
    const m = await mountOpen();
    boxW = 0;
    boxH = 0;
    expect(window.__tlRefitTerminal?.()).toBe(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);
    expect(resizes(m.socket())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4b. The boot focus (term.html:5614-5617)
 * ------------------------------------------------------------------ */

/**
 * A terminal that boots unfocused is dead to the keyboard until someone clicks
 * it, and with `cursorInactiveStyle: 'outline'` it also draws a hollow cursor
 * while it waits. term.html takes the focus immediately after its boot fit.
 *
 * The component gates that on the fit having actually run, which is the same
 * question as "is this terminal on screen" measured rather than guessed: a
 * hidden session slot and a session showing its TEXT view both leave the host
 * at `display: none`, so it measures 0x0 and the guard refuses the fit.
 */
describe("the boot focus (term.html:5614-5617)", () => {
  it("is still what term.html does, and still for that reason", () => {
    expect(TERM_HTML).toContain("Nothing else focuses the terminal on load");
  });

  it("focuses a terminal that booted onto the screen", async () => {
    const m = await mount();
    expect(m.fit.fits).toBe(1);
    expect(m.term.focused).toBe(1);
  });

  /** The gated arm: a host with no box is a terminal nobody is looking at. */
  it("takes no focus while the host has no box", async () => {
    boxW = 0;
    boxH = 0;
    const m = await mount();
    expect(m.fit.fits).toBe(0);
    expect(m.term.focused).toBe(0);
  });

  /**
   * The owed fit is replayed when the view returns, and it must not carry a
   * focus with it: by then the person may be typing into the composer, a rename
   * box or the palette.
   */
  it("does not focus when the owed fit is replayed later", async () => {
    boxW = 0;
    boxH = 0;
    const m = await mount({ onScreen: false });
    expect(m.term.focused).toBe(0);
    boxW = 800;
    boxH = 600;
    m.setOnScreen(true);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(1);
    expect(m.term.focused).toBe(0);
  });

  /**
   * The second gate, and the shipped terminal's own rule: `TerminalView`
   * declines its auto-focus while a lobby text field has the keyboard
   * (TerminalView.tsx:280-305), after that steal tore down the inline rename
   * box. Both branches now steal focus in the same cases.
   */
  it("declines to a lobby text field that already has the keyboard", async () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    const m = await mount();
    expect(m.fit.fits).toBe(1);
    expect(m.term.focused).toBe(0);
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  /** The other way in, for a terminal that booted hidden. */
  it("still answers __tlFocusTerminal", async () => {
    boxW = 0;
    boxH = 0;
    const m = await mount();
    expect(m.term.focused).toBe(0);
    expect(window.__tlFocusTerminal?.()).toBe(true);
    expect(m.term.focused).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Helper textarea (term.html:6339-6347)
 * ------------------------------------------------------------------ */

describe("xterm's helper textarea (term.html:6339-6347)", () => {
  const textarea = (): HTMLTextAreaElement => {
    const el = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (!el) throw new Error("xterm made no helper textarea");
    return el;
  };

  /**
   * `type=password` is the load-bearing one: it is what stops Gboard's
   * predictive text committing suggestions into terminal input (xterm #2403,
   * #3600). The rest turn off the same machinery by other names.
   */
  it.each([
    ["type", "password"],
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["autocomplete", "off"],
    ["spellcheck", "false"],
  ])("sets %s=%s", async (attr, value) => {
    await mount();
    expect(textarea().getAttribute(attr)).toBe(value);
  });

  /** Under 16px, iOS Safari zooms the page when the field takes focus. */
  it("sets a 16px font size", async () => {
    await mount();
    expect(textarea().style.fontSize).toBe("16px");
  });

  /**
   * term.html can use a document-wide query because it is the only terminal in
   * its document. The lobby mounts a second one in the dock, so a document
   * query would harden whichever textarea comes first and leave this
   * terminal's own field open to predictive text. The decoy stands in for that
   * other terminal.
   */
  it("hardens its own textarea, not the first one in the document", async () => {
    const decoy = document.createElement("textarea");
    decoy.className = "xterm-helper-textarea";
    document.body.insertBefore(decoy, document.body.firstChild);
    const m = await mount();
    const own = m.term.host?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    expect(own?.getAttribute("type")).toBe("password");
    expect(decoy.getAttribute("type")).toBeNull();
    decoy.remove();
  });

  it("hardens one that only appears after open() returns", async () => {
    xt.made.lateTextarea = true;
    const m = await mount();
    expect(document.querySelector(".xterm-helper-textarea")).toBeNull();
    m.term.createHelperTextarea();
    await vi.advanceTimersToNextTimerAsync();
    await settle();
    expect(textarea().getAttribute("type")).toBe("password");
  });
});

/* ------------------------------------------------------------------ *
 * 6. onHeld (attach.ts, its four `deps.onHeld?.(...)` sites)
 * ------------------------------------------------------------------ */

describe("refused and held input become something a person can see", () => {
  /**
   * A read-only watcher's keystroke is dropped at the choke point. Without a
   * nudge it is dropped in silence, into a terminal that looks alive.
   */
  it("explains the silence when a watcher types", async () => {
    const m = await mountOpen({ watch: true });
    m.type("l");
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("Watching");
    expect(plain(TERM_HTML)).toContain(plain(messages()[0] ?? ""));
  });

  /**
   * The apostrophe is term.html's own curly one (:8310), asserted with NO
   * normalisation: `plain()` above would hide the difference, and the point of
   * quoting the page is that the two builds put the SAME sentence on screen.
   */
  it("says the watch nudge byte for byte", async () => {
    const m = await mountOpen({ watch: true });
    m.type("l");
    expect(messages()[0]).toContain("can’t");
    expect(TERM_HTML).toContain(messages()[0] ?? "");
  });

  /** term.html:8303, one nudge per WATCH_NUDGE_MS however many keys. */
  it("nudges at most once every 4 seconds", async () => {
    const m = await mountOpen({ watch: true });
    m.type("l");
    m.type("s");
    vi.advanceTimersByTime(3000);
    m.type("\r");
    expect(messages()).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    m.type("x");
    expect(messages()).toHaveLength(2);
  });

  /**
   * A keystroke into a dead socket is HELD rather than lost, and the overlay
   * that would draw it at the cursor is pass 2, so until then the toast is the
   * only thing that says the input still exists.
   */
  it("says a keystroke was held when the socket is down", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type("q");
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("Held");
    expect(plain(TERM_HTML)).toContain(plain(messages()[0] ?? ""));
  });

  /**
   * The verdicts are distinct because the news is different for each, and the
   * wording is term.html's rather than this component's invention.
   */
  it.each([
    ["\t", "control keys"],
    ["\x7f", "reconnect"],
  ])("has term.html's own wording for %j", async (key, fragment) => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type(key);
    const said = messages()[0] ?? "";
    expect(said).toContain(fragment);
    expect(plain(TERM_HTML)).toContain(plain(said));
  });

  /**
   * The one verdict whose wording is deliberately SHORTER than term.html's.
   *
   * The page says "Backspace to edit it, Esc to discard" (:8221) and means it:
   * Escape reaches `discardHeldInput()` from inside its
   * `attachCustomKeyEventHandler` (:8554-8564). That handler is not ported, so
   * the Esc half would be a promise nothing here can keep. The Backspace half
   * is real (held.ts answers `\x7f` on a committed line with `reopened`), and
   * the substring check holds what is left to being term.html's words.
   */
  it("promises only the half of the held-line message it can keep", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type("deploy");
    vi.advanceTimersByTime(5100); // past heldSay's shared 5s gate
    m.type("\r"); // the line is committed; typing into it is now refused
    vi.advanceTimersByTime(5100);
    raised = [];
    m.type("x");
    const said = messages()[0] ?? "";
    expect(said).toBe("Your line is held — Backspace to edit it");
    expect(said).not.toContain("Esc");
    // Everything it DOES say, term.html says.
    expect(plain(TERM_HTML)).toContain(plain(said));
    // And the promise it dropped is still there to be restored.
    expect(TERM_HTML).toContain("Backspace to edit it, Esc to discard");
    expect(TERM_HTML).toContain("discardHeldInput()");
  });

  /** heldSay's shared gate: term.html:8191-8195, 5000ms across all of them. */
  it("says it at most once every 5 seconds", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type("q");
    m.type("\t");
    expect(messages()).toHaveLength(1);
    vi.advanceTimersByTime(5100);
    m.type("\t");
    expect(messages()).toHaveLength(2);
  });

  /**
   * attach.ts fires `onHeld(state, "held")` a second time when the hold is
   * REPLAYED, from the first-output-frame arm of its `onmessage` right after
   * `flushHeld`, where the state comes back empty. Narrating that as "held"
   * would tell someone their input is waiting at the very moment it went out,
   * so the accepted verdicts are gated on `isHolding`. Cited by symbol: that
   * file is being worked on alongside this one.
   */
  it("says nothing when the hold is replayed", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type("q");
    expect(messages()).toHaveLength(1);

    // Past both throttles, so silence here is a decision rather than a gate.
    vi.advanceTimersByTime(6000);
    await settle();
    raised = [];
    const next = m.socket();
    next.accept();
    await settle();
    // ttyd drops what arrives before the process exists, so the replay waits
    // for the first OUTPUT frame rather than for `open`.
    next.deliver([0x30, 0x68, 0x69]);
    await settle();
    expect(inputs(next)).toEqual([[0x71]]);
    expect(messages()).toEqual([]);
  });

  it("stays quiet while nothing is refused", async () => {
    const m = await mountOpen();
    m.type("l");
    m.type("s");
    m.type("\r");
    expect(inputs(m.socket())).toHaveLength(3);
    expect(messages()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 7. The connection ask (term.html:9822-9873)
 * ------------------------------------------------------------------ */

/**
 * The badge reports what the terminal volunteers, and the terminal volunteers
 * a phase only when it CHANGES (attach.ts `dispatch`). So a session view
 * coming back on screen, and Run check in the ADR-0016 panel, both have to be
 * able to ask, and on the iframe branch they can, because `askConn` is passed
 * there. This is the native branch's half of the same lever.
 */
describe("the connection ask (term.html:9822-9873)", () => {
  it("hands up BOTH levers, as the iframe branch does", async () => {
    const m = await mountOpen();
    expect(m.control().reconnect).toBeTypeOf("function");
    expect(m.control().ask).toBeTypeOf("function");
  });

  /**
   * The whole point: a state that has not changed is still reported. The
   * attempt comes back 0 rather than 1 because an open socket is not retrying,
   * which is the component's own mapping (`report`) and not the ladder's count.
   */
  it("re-reports an open terminal that has said nothing for a while", async () => {
    const m = await mountOpen();
    expect(m.reports).toEqual([
      { state: "connecting", attempt: 1 },
      { state: "open", attempt: 0 },
    ]);
    m.control().ask();
    expect(m.reports).toHaveLength(3);
    expect(m.reports[2]).toEqual({ state: "open", attempt: 0 });
  });

  /**
   * The badge carries the attempt, so a climbing ladder reads differently, and
   * the number is the attempt the pending retry WILL run, not the count already
   * started. term.html paints `connAttempts + 1` in `scheduleReconnect`
   * (:9877) and in `reconnectAfterDrop` (:10155), so one drop from a first
   * connection shows 2 while the rung runs down.
   */
  it("answers with the attempt the pending retry will run", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.reports.length = 0;
    m.control().ask();
    expect(m.reports).toEqual([{ state: "connecting", attempt: 2 }]);
  });

  /**
   * "No probe touches a live connection, so the broken state a person came to
   * look at is still there afterwards" (ADR-0016). A reading that reconnected
   * would erase the thing being measured.
   */
  it("reads the socket without touching it", async () => {
    const m = await mountOpen();
    const s = m.socket();
    const sent = s.sent.length;
    m.control().ask();
    await settle();
    expect(sockets).toHaveLength(1);
    expect(s.sent).toHaveLength(sent);
    expect(s.readyState).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 8. The soft-keyboard offset (term.html:9407-9422)
 * ------------------------------------------------------------------ */

/**
 * The shell measures the keyboard and forwards it; the terminal takes it off
 * its own height, on the devices term.html takes it off.
 *
 * Only the RECEIVING half is here. `App.tsx:194` already calls
 * `__tlKeyboardOffset` from `mobile/viewport.ts`, and until the component
 * claimed the global the optional call found nothing in native mode, so a
 * keyboard covered the prompt. term.html's own `syncViewport` (:8427-8469),
 * which pairs the forwarded height with its visualViewport reading and its
 * toolbar and compose-bar heights, is pass 2.
 *
 * The shrink cannot come from the container: `.tl-views.tl-kb-inline`
 * deliberately leaves the keyboard out of that reservation (app.css:2309-2318)
 * because shrinking it moved the terminal out from under the tap that had just
 * opened the keyboard.
 *
 * TWO GATES stand in front of the height write, and both are term.html's, so
 * most of this block runs on a faked touch device. The gates have to be here
 * because the shell forwards this height whatever the machine is:
 * `installViewportSync` takes `visualViewport ?? null`, falls back to
 * `window.innerHeight`, and still seeds and publishes (viewport.ts:242, :261,
 * :332).
 */
describe("the soft-keyboard offset (term.html:9407-9422)", () => {
  const height = (m: Mounted): string => m.term.host?.style.height ?? "(no host)";

  const realMatchMedia = window.matchMedia;

  /** `window.visualViewport`, which jsdom does not implement (term.html:8428). */
  const withVisualViewport = (): void => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { height: 480, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    });
  };

  /** `matchMedia('(pointer: coarse)')` answering yes (term.html:6350, :8441). */
  const withCoarsePointer = (): void => {
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes("pointer: coarse"),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  };

  /** Both, which is the phone the shrink exists for. */
  const asTouchDevice = (): void => {
    withVisualViewport();
    withCoarsePointer();
  };

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("takes the forwarded height off the terminal", async () => {
    asTouchDevice();
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("calc(100% - 312px)");
  });

  /**
   * GATE 1, term.html:8441: `terminalEl.style.height` is written only inside
   * `if (isCoarsePointer)`. A desktop has no soft keyboard, and taking rows off
   * its terminal because the browser moved its visual viewport is a regression
   * rather than a reservation.
   */
  it("leaves a fine pointer's terminal at full height", async () => {
    withVisualViewport();
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("");
  });

  /**
   * GATE 2, term.html:8428: `syncViewport` returns before writing anything at
   * all when there is no `window.visualViewport`.
   */
  it("leaves the height alone when there is no visualViewport", async () => {
    withCoarsePointer();
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("");
  });

  /** Neither gate, which is jsdom's own shape and the plain desktop case. */
  it("leaves the height alone on a plain desktop", async () => {
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("");
  });

  /**
   * The REFIT is not gated. term.html calls `refit()` after `syncViewport()`
   * and outside it, so the grid still follows a viewport change on a machine
   * whose height was left alone (:9420-9421).
   */
  it("still refits on a desktop, where the height write is skipped", async () => {
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    expect(m.fit.fits).toBe(1); // the boot fit only, so far
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
  });

  /** The pointer is read ONCE, as term.html's `const isCoarsePointer` is. */
  it("holds the pointer answer it booted with", async () => {
    asTouchDevice();
    const m = await mountOpen();
    window.matchMedia = realMatchMedia; // the 2-in-1 switching to its trackpad
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("calc(100% - 312px)");
  });

  /** The keyboard closing hands the space back rather than keeping 0px of it. */
  it("gives the height back when the keyboard closes", async () => {
    asTouchDevice();
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    expect(window.__tlKeyboardOffset?.(0)).toBe(true);
    expect(height(m)).toBe("");
  });

  /**
   * "A non-finite value is ignored rather than trusted into the layout"
   * (term.html:9416-9417), refused at :9418. A NaN height is a terminal with no
   * rows at all.
   */
  it.each([[NaN], [Infinity]])("refuses %o and leaves the layout alone", async (px) => {
    asTouchDevice();
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    expect(window.__tlKeyboardOffset?.(px)).toBe(false);
    expect(height(m)).toBe("calc(100% - 312px)");
  });

  /** `Math.max(0, px)`, as the page clamps it: a negative is no keyboard. */
  it("reads a negative offset as no keyboard", async () => {
    asTouchDevice();
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    expect(window.__tlKeyboardOffset?.(-40)).toBe(true);
    expect(height(m)).toBe("");
  });

  /**
   * The grid has to follow the height, and it goes through the same debounce
   * as every other trigger: the keyboard animates over ~250ms and fires a
   * burst, and each fit emits a tmux resize (term.html:8390-8393, :9421).
   */
  it("refits once, after the debounce", async () => {
    asTouchDevice();
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    window.__tlKeyboardOffset?.(280);
    window.__tlKeyboardOffset?.(276);
    expect(m.fit.fits).toBe(1); // the boot fit only, so far
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(2);
    expect(resizes(m.socket())).toEqual(['{"columns":80,"rows":24}']);
  });

  /**
   * A named global, so the terminal on screen owns it: the dock's second
   * terminal must not be the one that shrinks for the keyboard.
   */
  it("is not owned while the session is off screen", async () => {
    const m = await mount({ onScreen: false });
    expect(window.__tlKeyboardOffset).toBeUndefined();
    m.setOnScreen(true);
    expect(window.__tlKeyboardOffset).toBeTypeOf("function");
  });
});

/* ------------------------------------------------------------------ *
 * 9. Plain-drag selection reclaimed (term.html:5921-6055)
 * ------------------------------------------------------------------ */

/**
 * Wiring `term.onBinary` above is what turns mouse reporting on, and xterm then
 * treats a plain left drag as something to report rather than something to
 * select with: `SelectionService.shouldForceSelection` is
 * `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`. So the
 * moment mouse reports work, mouse text-selection stops working in every
 * tracking pane, which is what term.html:5921-6055 exists to prevent.
 *
 * dragselect.ts decides; this asserts that the component performs. What it
 * CANNOT assert is that xterm then selects: that needs `SelectionService`,
 * layout and a real cell grid, none of which jsdom has. The clone reaching
 * xterm's own node carrying the modifier that predicate reads is the claim.
 */
describe("plain-drag selection (term.html:5921-6055)", () => {
  /** 24 rows over 480px: the last row starts at 460. 80 cols over 800px: 10px each. */
  const GRID: Box = { left: 0, top: 0, width: 800, height: 480 };

  /**
   * A `MouseEvent` that drops `view`, because jsdom cannot accept one here.
   *
   * Its check is `wrapper === wrapper._globalProxy`
   * (living/events/UIEvent-impl.js:8-21), and vitest's jsdom environment copies
   * the jsdom globals onto Node's own global object, so `window === globalThis`
   * and that identity never holds: `new MouseEvent("x", { view: window })`
   * throws for every candidate, `document.defaultView` included.
   *
   * The environment gives way here rather than the code. term.html passes
   * `view: window` in its clone (:5946) and the component matches it, so the
   * production init is unchanged and only the test's constructor differs.
   * Nothing on xterm's selection path reads `view` anyway:
   * `SelectionService.shouldForceSelection` reads the modifiers,
   * `handleMouseDown` reads `button`, `timeStamp`, `shiftKey` and `detail`, and
   * `MouseService.getCoords` takes a `{clientX, clientY}` and nothing else.
   */
  class ViewlessMouseEvent extends MouseEvent {
    constructor(type: string, init: MouseEventInit = {}) {
      const rest: MouseEventInit = { ...init };
      delete rest.view;
      super(type, rest);
    }
  }
  const realMouseEvent = globalThis.MouseEvent;
  beforeEach(() => {
    globalThis.MouseEvent = ViewlessMouseEvent as unknown as typeof MouseEvent;
  });
  afterEach(() => {
    globalThis.MouseEvent = realMouseEvent;
  });

  const press = (init: MouseEventInit): MouseEvent =>
    trusted("mousedown", { button: 0, buttons: 1, detail: 1, ...init });

  it("swallows a trusted plain left press and answers it with a clone", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);
    const focusedBefore = m.term.focused;

    const e = press({ clientX: 100, clientY: 100 });
    screen.dispatchEvent(e);

    // Swallowed: stopImmediatePropagation kept the real press off xterm's own
    // node, and preventDefault kept the browser off it (term.html:5966-5967).
    expect(e.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    const clone = seen[0];
    expect(clone?.isTrusted).toBe(false);
    expect(clone?.clientX).toBe(100);
    expect(clone?.clientY).toBe(100);
    expect(clone?.buttons).toBe(1);
    // Off a Mac the predicate is `e.shiftKey` alone (term.html:5950).
    expect(clone?.shiftKey).toBe(true);
    expect(clone?.altKey).toBe(false);
    // term.html takes the focus the swallowed press would have taken (:6035).
    expect(m.term.focused).toBe(focusedBefore + 1);
  });

  /**
   * The clone is an untrusted mousedown on the same node, so passing untrusted
   * presses through is the recursion guard rather than a nicety: intercept one
   * and it clones itself forever.
   */
  it("passes an untrusted press through, so a clone cannot clone itself", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);

    const e = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
    });
    screen.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    expect(seen).toEqual([e]);
  });

  /** "wheel / right-click / modifier chords still reach the app" (:5824-5825). */
  it.each([
    ["the middle button", { button: 1 }],
    ["the right button", { button: 2 }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
  ])("leaves %s to the app", async (_what, init) => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);

    const e = press({ clientX: 100, clientY: 100, ...init });
    screen.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    expect(seen).toEqual([e]);
  });

  it("ignores a press that landed outside its own screen", async () => {
    const m = await mountOpen();
    boxScreen(m.term, GRID);
    const e = press({ clientX: 100, clientY: 100 });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * A real press lands on a row inside the screen, not on the screen itself,
   * which is why the test is `scr.contains(e.target)` (term.html:5962) rather
   * than an equality.
   */
  it("acts on a press that landed on a row inside the screen", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const row = document.createElement("div");
    screen.appendChild(row);
    const seen = watchPresses(screen);

    const e = press({ clientX: 100, clientY: 100 });
    row.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    // Cloned onto the node the press landed on, as term.html clones onto
    // `e.target` (:5952).
    expect(seen[0]?.target).toBe(row);
  });

  /**
   * The node a travel clones from is the node of the press the module is
   * HOLDING, so a press it waved through in between must not move it.
   */
  it("clones a travelling press onto its own node, not a later press's", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const screen = boxScreen(m.term, GRID);
    const held = document.createElement("div");
    const other = document.createElement("div");
    screen.append(held, other);
    const seen = watchPresses(screen);

    held.dispatchEvent(press({ clientX: 100, clientY: 100 }));
    // Waved through: the right button reaches the app untouched (:5959).
    other.dispatchEvent(press({ clientX: 400, clientY: 200, button: 2 }));
    screen.dispatchEvent(trusted("mousemove", { buttons: 1, clientX: 130, clientY: 100 }));

    const clone = seen.find((e) => !e.isTrusted);
    expect(clone?.target).toBe(held);
    expect(clone?.clientX).toBe(100);
  });

  /**
   * The reason `insideScreen` is scoped to the component's own host rather than
   * being a `document.querySelector` the way term.html can afford (:5961). The
   * lobby keeps every visited session mounted (App.tsx:835-842) and the dock
   * can hold a second terminal, so one press reaches every instance's document
   * listener; a document query would have all of them swallow it and clone it.
   */
  it("only the terminal the press landed in acts on it", async () => {
    // One at a time, and `settle()` between: two components importing xterm in
    // the SAME tick race vitest's module mock, and one of them gets the real
    // xterm (measured: one fake terminal instead of two, plus jsdom's
    // "HTMLCanvasElement.prototype.getContext" notice from xterm's DOM
    // renderer). Sequential is also how the lobby gets here, since sessions are
    // visited one after another.
    const r = render(() => <TerminalNative args="arg=first" ownsBridges={true} />);
    await settle();
    const r2 = render(() => <TerminalNative args="arg=second" ownsBridges={false} />);
    await settle();
    const [first, second] = xt.made.terminals;
    if (!first || !second) throw new Error("two terminals were expected");
    const one = boxScreen(first, GRID);
    const two = boxScreen(second, GRID);
    const onOne = watchPresses(one);
    const onTwo = watchPresses(two);

    two.dispatchEvent(press({ clientX: 100, clientY: 100 }));

    expect(onOne).toHaveLength(0);
    expect(onTwo).toHaveLength(1);
    expect(onTwo[0]?.isTrusted).toBe(false);
    r.unmount();
    r2.unmount();
  });

  /**
   * The bottom row is the tmux status line, where a real click (window
   * switching) matters more than a selection. It is held back, replayed as raw
   * SGR on a release that did not travel, and takes no focus because tmux moves
   * focus itself (term.html:5968-5995).
   */
  it("replays a tmux status-row click as two SGR reports", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);
    const focusedBefore = m.term.focused;

    // clientY 470 is inside the 24th of 24 rows; clientX 100 is column 11.
    screen.dispatchEvent(press({ clientX: 100, clientY: 470 }));
    expect(seen).toHaveLength(0); // held back, not cloned
    expect(m.term.focused).toBe(focusedBefore);

    screen.dispatchEvent(
      trusted("mouseup", { button: 0, buttons: 0, clientX: 100, clientY: 470 }),
    );
    expect(sgr(m.socket())).toEqual(["\x1b[<0;11;24M", "\x1b[<0;11;24m"]);
  });

  /**
   * "only when the app actually has mouse tracking on (otherwise the bytes
   * would land as typed garbage)" (term.html:5986-5988).
   */
  it("sends nothing for a status-row click into a plain shell", async () => {
    const m = await mountOpen();
    m.term.modes.mouseTrackingMode = "none";
    const screen = boxScreen(m.term, GRID);

    screen.dispatchEvent(press({ clientX: 100, clientY: 470 }));
    screen.dispatchEvent(
      trusted("mouseup", { button: 0, buttons: 0, clientX: 100, clientY: 470 }),
    );

    expect(sgr(m.socket())).toEqual([]);
  });

  /**
   * The replay goes through the STRING path, which carries the read-only guard,
   * because term.html replays with `sendInput` (:5994-5995). A watcher's status
   * click is refused and explained rather than written into a session they
   * cannot type into.
   */
  it("refuses a watcher's status-row click and says why", async () => {
    const m = await mountOpen({ watch: true });
    const screen = boxScreen(m.term, GRID);

    screen.dispatchEvent(press({ clientX: 100, clientY: 470 }));
    screen.dispatchEvent(
      trusted("mouseup", { button: 0, buttons: 0, clientX: 100, clientY: 470 }),
    );

    expect(sgr(m.socket())).toEqual([]);
    expect(messages()[0]).toContain("Watching");
  });

  /**
   * A drag whose mouseup never reached the document (released past the window
   * edge) leaves xterm mid-selection, and every later pointer move keeps
   * re-extending it. Motion with the button up finalizes at the last dragged
   * point (term.html:5931-5937).
   */
  it("finalizes a drag whose mouseup never arrived", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const ups: MouseEvent[] = [];
    screen.addEventListener("mouseup", (e) => void ups.push(e as MouseEvent));

    screen.dispatchEvent(press({ clientX: 100, clientY: 100 }));
    screen.dispatchEvent(trusted("mousemove", { buttons: 0, clientX: 300, clientY: 300 }));

    expect(ups).toHaveLength(1);
    // At the point the drag REACHED, not where the pointer wandered to (:5935).
    expect(ups[0]?.clientX).toBe(100);
    expect(ups[0]?.clientY).toBe(100);
    expect(ups[0]?.buttons).toBe(0);
  });

  /**
   * Mode-1003 panes (Claude Code among them) are reported every pointer motion,
   * the TUI hover-repaints, and that output clears the highlight. While a
   * selection exists and no button is down, idle motion over the screen is
   * swallowed at document capture (term.html:6048-6053), stopping propagation
   * only, with no preventDefault.
   */
  it("swallows idle motion while a selection is up", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const screen = boxScreen(m.term, GRID);
    const moves: MouseEvent[] = [];
    screen.addEventListener("mousemove", (e) => void moves.push(e as MouseEvent));

    const e = trusted("mousemove", { buttons: 0, clientX: 100, clientY: 100 });
    screen.dispatchEvent(e);

    expect(moves).toHaveLength(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("lets motion through once nothing is selected", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const moves: MouseEvent[] = [];
    screen.addEventListener("mousemove", (e) => void moves.push(e as MouseEvent));

    screen.dispatchEvent(trusted("mousemove", { buttons: 0, clientX: 100, clientY: 100 }));

    expect(moves).toHaveLength(1);
  });

  /**
   * A double click with a selection up is an explicit new-selection gesture, so
   * it clears the old one on the way through (term.html:6010-6013). The clear
   * runs through selection.ts's `reduceStash`, which owns the rule that a
   * dismissal with nothing highlighted must leave a pending copy alive.
   */
  it("clears the old selection for a double click", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);

    screen.dispatchEvent(press({ clientX: 100, clientY: 100, detail: 2 }));

    expect(m.term.cleared).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toBe(2); // xterm reads it off the clone to pick a word
  });

  /**
   * A single press while a selection is up is held back, so a plain click keeps
   * the selection rather than replacing it (term.html:6016-6017). It still
   * takes the focus the swallowed press would have taken (:6035).
   */
  it("holds a single press back while a selection is up", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);
    const focusedBefore = m.term.focused;

    screen.dispatchEvent(press({ clientX: 100, clientY: 100 }));

    expect(seen).toHaveLength(0);
    expect(m.term.cleared).toBe(0);
    expect(m.term.focused).toBe(focusedBefore + 1);
  });

  /**
   * The held-back press becomes a replacing drag once it travels past
   * REPLACE_PX, cloned from the ORIGINAL press rather than from the motion that
   * committed it (term.html:6019-6026).
   */
  it("turns a held-back press into a clone once it travels", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);

    screen.dispatchEvent(press({ clientX: 100, clientY: 100 }));
    screen.dispatchEvent(trusted("mousemove", { buttons: 1, clientX: 104, clientY: 100 }));
    expect(seen).toHaveLength(0); // 4px is trackpad jitter, not a drag
    screen.dispatchEvent(trusted("mousemove", { buttons: 1, clientX: 130, clientY: 100 }));

    expect(m.term.cleared).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.clientX).toBe(100); // the press, not the travel
  });

  /**
   * On a Mac the predicate is `e.altKey && macOptionClickForcesSelection`, so
   * the clone has to carry Option there and Shift everywhere else. The platform
   * is read through the same include list xterm reads (its own `isMac` is
   * `["Macintosh","MacIntel","MacPPC","Mac68K"].includes(navigator.platform)`),
   * which is also term.html's (:5817): a detector that disagreed with xterm's
   * would swallow presses and force nothing.
   */
  it("clones with Option on a Mac", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      const m = await mountOpen();
      const screen = boxScreen(m.term, GRID);
      const seen = watchPresses(screen);

      screen.dispatchEvent(press({ clientX: 100, clientY: 100 }));

      expect(seen[0]?.altKey).toBe(true);
      expect(seen[0]?.shiftKey).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "platform");
    }
  });

  /**
   * The three listeners are on `document`, so an unmount has to take them off
   * or a disposed terminal goes on swallowing presses for a node nobody can
   * see. Driven by putting the detached host back in the document, which is the
   * only way an event from it can reach `document` again.
   */
  it("stops intercepting once the terminal is unmounted", async () => {
    const m = await mountOpen();
    const screen = boxScreen(m.term, GRID);
    const host = m.term.host;
    m.unmount();
    if (host) document.body.appendChild(host);

    const e = press({ clientX: 100, clientY: 100 });
    screen.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    host?.remove();
  });
});

/* ------------------------------------------------------------------ *
 * 11. The live-theme global, and who is allowed to hand it back
 * ------------------------------------------------------------------ */

/**
 * `theme.ts` calls `window.__tlThemeLive` on an explicit theme pick and on an
 * OS light/dark flip while the stored theme is "system", and a terminal claims
 * that global on mount. Every visited session stays mounted
 * (src/store/keepalive.ts), so two terminals claim it in succession and an
 * unmount is not necessarily the newest claim.
 *
 * The failure this pins is silent and lasts until a remount: hand `previous`
 * back unconditionally and unmounting an OLDER terminal wipes the callback of
 * the one on screen, which then keeps its old palette through every theme
 * change. Reachable on the shipped path, since App.tsx re-prunes on each lobby
 * list change, so a session killed from another device unmounts while the
 * selected session's terminal is live.
 */
describe("the live-theme global survives an out-of-order unmount", () => {
  const themeLive = (): unknown =>
    (window as unknown as Record<string, unknown>)[THEME_LIVE_GLOBAL];

  it("is claimed by a mounted terminal", async () => {
    await mount();
    expect(typeof themeLive()).toBe("function");
  });

  it("keeps the newer terminal's callback when an older one unmounts", async () => {
    const first = render(() => (
      <TerminalNative args="arg=qa-native-1" watch={() => false} ownsBridges={true} />
    ));
    await settle();
    const afterFirst = themeLive();

    const second = render(() => (
      <TerminalNative args="arg=qa-native-2" watch={() => false} ownsBridges={true} />
    ));
    await settle();
    const afterSecond = themeLive();
    expect(afterSecond).not.toBe(afterFirst);

    first.unmount();
    await settle();
    expect(themeLive()).toBe(afterSecond);

    second.unmount();
  });

  it("hands the global back when the newest claim is the one unmounting", async () => {
    const before = themeLive();
    const only = render(() => (
      <TerminalNative args="arg=qa-native-3" watch={() => false} ownsBridges={true} />
    ));
    await settle();
    expect(themeLive()).not.toBe(before);

    only.unmount();
    await settle();
    expect(themeLive()).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * 12. Symbol glyphs, and re-rasterizing once the fonts arrive
 * ------------------------------------------------------------------ */

/**
 * JetBrains Mono ships no braille and none of Claude Code's spinner and status
 * glyphs, so the mono stack carries a "TL Symbols" fallback face declared in
 * theme/theme.css. Two halves have to hold for a running agent's spinner to be
 * a picture rather than a box: the face has to be IN the stack the terminal is
 * constructed with, and xterm has to re-rasterize once the webfont actually
 * arrives, because the atlas it builds at open() is built from whatever font
 * was resolved at that instant.
 */
describe("symbol glyphs survive the webfont arriving late", () => {
  // jsdom implements no FontFaceSet at all: document.fonts is undefined here,
  // which is why the component reaches it optionally. Faked for the same reason
  // matchMedia and visualViewport are faked above, so the re-rasterize is a
  // measured claim rather than a silently skipped one. A test that leaves it
  // undefined passes whether the component reads it or not.
  let restore: (() => void) | null = null;
  const fontsSettleAs = (ready: Promise<unknown>): void => {
    const target = document as unknown as { fonts?: unknown };
    const had = Object.prototype.hasOwnProperty.call(target, "fonts");
    const previous = target.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready },
    });
    restore = () => {
      if (had) {
        Object.defineProperty(document, "fonts", { configurable: true, value: previous });
      } else {
        delete (document as unknown as { fonts?: unknown }).fonts;
      }
    };
  };

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("names the symbol face in the constructed stack, after JetBrains Mono", async () => {
    const m = await mount();
    const stack = String(m.term.ctor.fontFamily);
    expect(stack).toContain("TL Symbols");
    expect(stack.indexOf("JetBrains Mono")).toBeLessThan(stack.indexOf("TL Symbols"));
  });

  it("clears the texture atlas once the fonts are ready", async () => {
    fontsSettleAs(Promise.resolve());
    const m = await mount();
    await settle();
    expect(m.term.atlasCleared).toBeGreaterThanOrEqual(1);
  });

  it("does not clear the atlas of a terminal that is already gone", async () => {
    let settleFonts: () => void = () => {};
    fontsSettleAs(new Promise<void>((res) => (settleFonts = res)));
    const m = await mount();
    const before = m.term.atlasCleared;
    m.unmount();
    settleFonts();
    await settle();
    expect(m.term.atlasCleared).toBe(before);
  });

  it("survives a browser with no FontFaceSet, which is what jsdom is", async () => {
    const m = await mount();
    await settle();
    expect(m.term.atlasCleared).toBe(0);
  });
});
