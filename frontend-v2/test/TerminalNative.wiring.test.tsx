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
 *     attributes below are only the mechanism term.html uses to make it. The
 *     compose mirror is the same claim from the other side: its whole point is
 *     that a real soft keyboard's autocorrect, dictation and swipe typing DO
 *     reach it, and jsdom has no keyboard at all, so section 16 asserts the
 *     attribute set and the forwarding and says nothing about either.
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
 *   - whether a real two-finger pinch changes real glyph sizes. Section 19
 *     drives both front ends and reads back the size xterm was ASKED for; the
 *     cell metrics that would prove the screen changed need layout, and the
 *     WebKit half has no instrument in this homelab at all.
 *   - links and the held-key overlay, neither of which is wired into the
 *     component yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FONT_SIZE_KEY, PREFS_DIRTY_KEY, PREFS_KEY } from "../src/store/prefs";
import { FONT_READOUT_HIDE_MS } from "../src/terminal/font";
import { toasts, type PushToast } from "../src/store/toast";
import type { TerminalReport } from "../src/diagnostics/status";
import { HELD_ENTER_MESSAGE, MIRROR_FIELD_ATTRIBUTES } from "../src/terminal/mirror";

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
    /**
     * `term.element`, xterm's own root, which is what BOTH scrollers dispatch
     * their synthetic wheels on (term.html:6107) and what their `mounted` field
     * reads. A real xterm builds it inside `open()` and puts `.xterm-screen`
     * under it, so the fake nests them the same way: a component that
     * dispatched on the host or on the screen instead would still look right
     * against a flat stub.
     */
    element: HTMLElement | null = null;

    constructor(opts: Record<string, unknown>) {
      this.ctor = { ...opts };
      this.options = { ...opts };
      made.terminals.push(this);
    }
    loadAddon(): void {}
    open(host: HTMLElement): void {
      this.host = host;
      const element = document.createElement("div");
      element.className = "xterm";
      host.appendChild(element);
      this.element = element;
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      element.appendChild(screen);
      this.screen = screen;
      if (!made.lateTextarea) this.createHelperTextarea();
    }
    /**
     * The ONE custom wheel handler xterm stores, as the component installed it.
     * xterm consults it from two listeners of its own, both on `element`, and
     * diverts only on an exact `false`.
     */
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    attachCustomWheelEventHandler(h: ((e: WheelEvent) => boolean) | null): void {
      this.wheelHandler = h;
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
    /**
     * Every `term.input()` the component made, which is the compose mirror's
     * entire route to the pty: xterm's own onData, then the soft-modifier
     * wrapper, then the send choke point.
     *
     * It calls onData SYNCHRONOUSLY, as the real one does
     * (`coreService.triggerDataEvent`), because that is the whole reason the
     * mirror brackets the call in `mirrorEmitting`: the reset hook fires
     * inside it and has to see the flag.
     */
    readonly typedIn: { data: string; user: boolean }[] = [];
    input(data: string, wasUserInput?: boolean): void {
      this.typedIn.push({ data, user: wasUserInput === true });
      for (const cb of this.onDataCbs) cb(data);
    }
    /** xterm's parser seeing BEL. One event per ring, ungated. */
    readonly bellCbs: (() => void)[] = [];
    onBell(cb: () => void): Disposable {
      this.bellCbs.push(cb);
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

/**
 * THE INCIDENTS THE COMPONENT FILES, which are otherwise unobservable: `diag()`
 * hands back a module singleton that stays `inert` until `startDiagnostics()`
 * finds a `tlDiag` core on the page, and inert's `incident` is a no-op.
 *
 * Whether one is filed is part of a claim here rather than a detail, because
 * `sel-cleared` feeds the deliberate-dismissal bucket ADR-0003 telemetry
 * measures, and diagnostics are ON by default (`diagnosticsWanted`). Only
 * `incident` is replaced; everything else in that module is the real thing.
 */
const tel = vi.hoisted(() => ({
  incidents: [] as { kind: string; attrs?: Record<string, unknown> }[],
}));
vi.mock("../src/telemetry/diag", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/telemetry/diag")>();
  return {
    ...real,
    diag: () => ({
      ...real.diag(),
      incident: (kind: string, attrs?: Record<string, unknown>) =>
        void tel.incidents.push({ kind, attrs }),
    }),
  };
});

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
let raised: { message: string; kind: string; timeoutMs?: number }[] = [];
let realPush: (t: PushToast) => number;

/** term.html's refit() debounce (term.html:8471-8481), plus a frame of slack. */
const PAST_DEBOUNCE_MS = 150;

/**
 * `heldSay`'s throttle (term.html:8191-8195), shared by every held-input
 * message and the compose mirror's own. Advancing past it is how a second
 * sentence can be seen at all.
 */
const HELD_SAY_WINDOW_MS = 5000;

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
  tel.incidents.length = 0;
  toasts.clear();
  raised = [];
  realPush = toasts.push;
  toasts.push = (t: PushToast): number => {
    // The duration is recorded because two of the key handler's toasts carry
    // one deliberately: `showToast` defaults its kind to "info" and its length
    // to 3000, so a wiring that passed only the message would ship an info
    // toast of the wrong length where term.html shows a short success.
    raised.push({ message: t.message, kind: t.kind, timeoutMs: t.timeoutMs });
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
  /** The terminal view coming on or off screen (SessionView's `active`). */
  setActive(v: boolean): void;
  /** Everything `onConn` was told about the socket, in order (ADR-0016). */
  reports: TerminalReport[];
  /** Every attention signal handed up, in order (terminal/attention.ts). */
  attention: ("bell" | "output")[];
  /** The levers `onReady` handed up, which is what SessionView holds. */
  control(): { reconnect: () => void; ask: () => void };
  /**
   * The compose mirror's field, scoped to THIS render: a document query would
   * find another mounted terminal's, which is the bug the host-scoped queries
   * in the component exist to avoid. Throws where the posture mounted none.
   */
  mirror(): HTMLTextAreaElement;
  /** The bar the field sits in, whose live height is term.html's `cbH`. */
  bar(): HTMLElement;
  /** Nothing mounted, which is what a fine pointer and `input.bar: off` give. */
  noMirror(): boolean;
  /**
   * The "Aa NNpx" readout a pinch draws, or null while none is on screen.
   * Scoped to THIS render for the same reason `mirror()` is: a document query
   * would find another mounted terminal's pill.
   */
  pill(): HTMLElement | null;
  unmount(): void;
}

async function mount(
  opts: { watch?: boolean; onScreen?: boolean; active?: boolean } = {},
): Promise<Mounted> {
  const [onScreen, setOnScreen] = createSignal(opts.onScreen ?? true);
  const [active, setActive] = createSignal(opts.active ?? true);
  const reports: TerminalReport[] = [];
  const attention: ("bell" | "output")[] = [];
  // A list rather than a nullable local, so TypeScript does not have to be
  // argued out of narrowing an assignment made inside a callback.
  const controls: { reconnect: () => void; ask: () => void }[] = [];
  const r = render(() => (
    <TerminalNative
      args="arg=qa-native"
      watch={() => opts.watch === true}
      ownsBridges={onScreen()}
      // A DIFFERENT question from ownsBridges, and the one attention.ts's
      // `view` event is the negation of: false while the TEXT view shows over a
      // terminal that stays mounted and stays attached.
      active={active()}
      onAttention={(kind) => void attention.push(kind)}
      onConn={(report) => void reports.push(report)}
      onReady={(c) => void controls.push(c)}
    />
  ));
  await settle();
  const term = one(xt.made.terminals, "terminal");
  const fit = one(xt.made.fitAddons, "fit addon");
  const field = (): HTMLTextAreaElement | null =>
    r.container.querySelector<HTMLTextAreaElement>(".tl-compose-mirror textarea");
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
    setActive,
    reports,
    attention,
    control: () => one(controls, "onReady control"),
    mirror: () => {
      const el = field();
      if (!el) throw new Error("no compose mirror was mounted");
      return el;
    },
    bar: () => {
      const el = r.container.querySelector<HTMLElement>(".tl-compose-mirror");
      if (!el) throw new Error("no compose bar was mounted");
      return el;
    },
    noMirror: () => field() === null,
    pill: () => r.container.querySelector<HTMLElement>(".tl-size-pill"),
    unmount: () => r.unmount(),
  };
}

/** A live socket: mounted, /token answered, handshake accepted. */
async function mountOpen(
  opts: { watch?: boolean; onScreen?: boolean; active?: boolean } = {},
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
function forceTrusted<E extends Event>(e: E): E {
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

function trusted(type: string, init: MouseEventInit): MouseEvent {
  return forceTrusted(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/**
 * A REAL wheel, which both scrollers gate on.
 *
 * The same unforgeable flag as `trusted`, and needed for the same reason twice
 * over: the trackpad pacer passes an untrusted wheel straight through
 * (term.html:6229-6231, its re-entrancy guard) and only a trusted one cancels a
 * touch coast (:6281). A test that could not fake the flag would only ever
 * reach the arm that does nothing.
 */
function trustedWheel(init: WheelEventInit): WheelEvent {
  return forceTrusted(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
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

/**
 * Every wheel that reached a node, in dispatch order.
 *
 * Pointed at `term.element` in the scroll sections, because WHICH node the
 * synthetic wheels land on is part of the claim (term.html:6107): xterm's own
 * wheel listeners sit on that root, so a component dispatching on the host or
 * on `.xterm-screen` would emit events nothing forwards to the pty, and a
 * recorder inside the fake would count those as a pass.
 */
function watchWheels(el: HTMLElement): WheelEvent[] {
  const seen: WheelEvent[] = [];
  el.addEventListener("wheel", (e) => void seen.push(e as WheelEvent));
  return seen;
}

/**
 * MOUSE REPORTING ON, which is the state every synthetic wheel exists to reach
 * and the only state in which a wheel is also pty-bound INPUT.
 *
 * The fake terminal does nothing with a dispatched wheel, so this adds the one
 * thing the real library does with one. Measured against the installed
 * @xterm/xterm 6.0.0 (jsdom, `\x1b[?1000h\x1b[?1006h` written first, one
 * untrusted `deltaMode: 1` wheel dispatched on `term.element`): `bindMouse`
 * consults the custom wheel handler, takes its `true`, and
 * `coreMouseService.triggerMouseEvent` routes the SGR report through
 * `_coreService.triggerDataEvent`, so `term.onData` fires SYNCHRONOUSLY inside
 * `dispatchEvent` and `term.onBinary` fires not at all. Only DEFAULT encoding
 * takes the binary route, and DECSET 1006 is not it.
 *
 * The report's coordinates are the ones a laid-out browser produces; the real
 * library answers `NaN` for them in jsdom, which is a layout gap and not part of
 * any claim here. What matters is that a string reaches `onData` while the
 * dispatch is still on the stack.
 */
function reportMouse(term: InstanceType<typeof xt.FakeTerminal>): string[] {
  const el = term.element;
  if (!el) throw new Error("the terminal has no element");
  const reports: string[] = [];
  el.addEventListener("wheel", () => {
    const report = "\x1b[<64;1;1M";
    reports.push(report);
    for (const cb of term.onDataCbs) cb(report);
  });
  return reports;
}

/**
 * One touch event, with BOTH of the recognizer's clocks under the test's
 * control.
 *
 * jsdom ships a `TouchEvent` constructor and no `Touch`, so the touch list is
 * plain objects carrying the one field the component reads. `timeStamp` is an
 * accessor on `Event.prototype`, so an own property shadows it, which is what
 * makes the velocity ring's clock (`e.timeStamp`) drivable at all. The other
 * clock is `performance.now()`, read by the component, and vitest's fake timers
 * do not fake it (measured), so a test that needs a LONG gap on both clocks
 * has to stub that one as well (`fakeNow` below).
 */
function touchEvent(type: string, ys: readonly number[], t: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: ys.map((y) => ({ clientY: y })) });
  Object.defineProperty(e, "timeStamp", { value: t });
  return e;
}

/**
 * `performance.now()`, pinned so the lift's stationary-gap test can be driven.
 *
 * The gap is `min(e.timeStamp - last.t, performance.now() - last.th)`
 * (term.html:6545-6547), so a long gap on one clock alone proves nothing: the
 * MIN is what the module reads, which is exactly why both are supplied.
 */
function fakeNow(read: () => number): () => void {
  const real = performance.now;
  performance.now = read;
  return () => {
    performance.now = real;
  };
}

/**
 * `matchMedia` answering `(pointer: coarse)` however the test asks.
 *
 * The gate the touch listeners go on, read ONCE at mount (term.html:6350, and
 * the `if (isCoarsePointer)` at :6478). jsdom's own matchMedia answers false to
 * everything, so the DEFAULT in this file is a fine pointer and the touch half
 * has to be asked for.
 */
function fakePointer(coarse: boolean): () => void {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) =>
    ({
      matches: coarse && q.includes("pointer: coarse"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = real;
  };
}

/**
 * The rAF queue, recorded rather than run.
 *
 * Not vitest's fake timers, which DO fake requestAnimationFrame but hand the
 * callback a timestamp from their own clock while leaving `performance.now()`
 * real: measured 219 against 1561 in the same test. The coast subtracts one
 * from the other (`dt = now - coast.at`), so under those two clocks a frame
 * arrives BEFORE the lift that scheduled it and the decay runs backwards. A
 * real browser has no such split: rAF timestamps and `performance.now()` share
 * the time origin. Recording the queue keeps that true here and makes the
 * "exactly one frame outstanding" invariant checkable.
 */
interface Frames {
  /** How many callbacks are waiting. The modules promise at most one each. */
  outstanding(): number;
  /** Run the single outstanding frame with this timestamp. */
  run(now: number): void;
  /** Every id handed to cancelAnimationFrame, in order. */
  readonly cancelled: number[];
  restore(): void;
}
function fakeFrames(): Frames {
  const realRequest = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  const queued = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++;
    queued.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    cancelled.push(id);
    queued.delete(id);
  }) as typeof cancelAnimationFrame;
  return {
    outstanding: () => queued.size,
    run(now: number): void {
      const entries = [...queued.entries()];
      expect(entries, "exactly one frame outstanding").toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error("no frame was requested");
      queued.delete(entry[0]);
      entry[1](now);
    },
    cancelled,
    restore(): void {
      globalThis.requestAnimationFrame = realRequest;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
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
 * deliberately leaves the keyboard out of that reservation (app.css:2437-2448)
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

  /**
   * `window.visualViewport`, which jsdom does not implement (term.html:8428).
   *
   * MOVABLE, where it used to be a frozen `height: 480`. viewport.ts now takes
   * an `own` reading off this object on every event, so a fake that stayed at
   * 480 while the shell forwarded 0 would be a browser claiming the keyboard is
   * both up and down: `keyboardOffset` is `innerHeight - vv.height - offsetTop`
   * in the shell too (mobile/viewport.ts), so a real keyboard closing returns
   * this height to `innerHeight` in the same frame the shell forwards 0. The
   * tests that close the keyboard move both.
   */
  const vv = { height: 480, offsetTop: 0, addEventListener() {}, removeEventListener() {} };
  const withVisualViewport = (): void => {
    vv.height = 480;
    vv.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  };
  /** The keyboard, in pixels of the layout viewport it covers. */
  const keyboardCovers = (px: number): void => {
    vv.height = window.innerHeight - px;
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
    keyboardCovers(312);
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(312)).toBe(true);
    expect(height(m)).toBe("calc(100% - 312px)");
  });

  /**
   * THE SEED, which is what viewport.ts adds that the inline arithmetic could
   * not: the terminal reads the viewport FOR ITSELF at mount.
   *
   * The shell forwards on CHANGE only (`kb !== lastKb`, mobile/viewport.ts), so
   * a terminal that mounts while the keyboard is already up is never told. A
   * session opened from the composer, a switch back to the terminal view, a tab
   * that started on the list: all three keep their bottom rows, the prompt
   * among them, behind the keyboard until the keyboard next moves. The shipped
   * iframe has the same hole: framed, term.html's own reading is 0 (:8402-8404)
   * and `framedKb` starts at 0 (:8425), so its boot `syncViewport()` (:8490)
   * reserves nothing either.
   */
  it("reserves what it can see for itself, with nothing forwarded", async () => {
    asTouchDevice();
    keyboardCovers(336);
    const m = await mountOpen();
    expect(height(m)).toBe("calc(100% - 336px)");
    expect(window.__tlKeyboardOffset).toBeTypeOf("function");
  });

  /**
   * `max(own, forwarded)`, NEVER the sum, and this is the case that separates
   * it from pass 1's arithmetic. Natively there is no iframe: the terminal sits
   * in the top window and the shell measures that same window, so both readings
   * describe the SAME keyboard and both are non-zero. Subtracting both leaves a
   * 60px terminal on an iPhone. term.html says it in its own words at
   * :8413-8414, and reserves `offset` for exactly that reason.
   */
  it("does not subtract the same keyboard twice", async () => {
    asTouchDevice();
    keyboardCovers(300);
    const m = await mountOpen();
    // A shell reading a fraction of a pixel apart from ours, which iOS does.
    expect(window.__tlKeyboardOffset?.(302)).toBe(true);
    expect(height(m)).toBe("calc(100% - 302px)");
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

  /**
   * The keyboard closing hands the space back rather than keeping 0px of it.
   *
   * BOTH readings move, because both are readings of the one keyboard: the
   * shell's forward goes to 0 in the same frame the visual viewport comes back
   * to the layout height. A forwarded 0 alone must NOT give the rows back while
   * this terminal can still see the keyboard, which is the other half of
   * `max(own, forwarded)` and the case a remembered `framedKb` would get wrong
   * in the opposite direction.
   */
  it("gives the height back when the keyboard closes", async () => {
    asTouchDevice();
    keyboardCovers(312);
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    expect(height(m)).toBe("calc(100% - 312px)");
    keyboardCovers(0);
    expect(window.__tlKeyboardOffset?.(0)).toBe(true);
    expect(height(m)).toBe("");
  });

  /** A forwarded 0 over a keyboard this terminal can still see keeps the rows. */
  it("keeps the reserve when only the forward says the keyboard is gone", async () => {
    asTouchDevice();
    keyboardCovers(312);
    const m = await mountOpen();
    expect(window.__tlKeyboardOffset?.(0)).toBe(true);
    expect(height(m)).toBe("calc(100% - 312px)");
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

  /**
   * `Math.max(0, px)`, as the page clamps it (:9419 and again in its own
   * helper at :8418): a negative forward contributes nothing at all, rather
   * than a negative reserve or a NaN. The visual viewport comes back with it,
   * because a negative is what a closing keyboard's rounding produces.
   */
  it("reads a negative offset as no keyboard", async () => {
    asTouchDevice();
    keyboardCovers(312);
    const m = await mountOpen();
    window.__tlKeyboardOffset?.(312);
    keyboardCovers(0);
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
    expect(tel.incidents).toEqual([
      { kind: "sel-cleared", attrs: { "tl.reason": "double-click replace" } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toBe(2); // xterm reads it off the clone to pick a word
  });

  /**
   * A DOUBLE CLICK WITH NOTHING HIGHLIGHTED files nothing and clears nothing,
   * which is term.html's early return at :5893 sitting above all three of the
   * things `clearSelectionBecause` does.
   *
   * The path is reachable and only looks like a corner: dragselect.ts emits
   * `clear-selection` on `e.detail > 1` ALONE (:409) and says on itself that
   * the guard is `clearSelectionBecause`'s, while term.html's
   * `if (!term.hasSelection() || e.detail > 1)` (:6010-6011) is the source
   * arriving here with no selection. Filing it anyway double-counts the
   * deliberate-dismissal bucket ADR-0003 telemetry measures, and there is
   * nothing to clear.
   *
   * The stash half is delegated: `reduceStash` is still called with
   * `hasSelection: false`, which is what leaves a pending copy alive for the
   * rest of its 15 s (selection.ts says why at `reduceStash`).
   */
  it("files nothing when a double click finds nothing highlighted", async () => {
    const m = await mountOpen();
    m.term.selected = false;
    const screen = boxScreen(m.term, GRID);
    const seen = watchPresses(screen);

    screen.dispatchEvent(press({ clientX: 100, clientY: 100, detail: 2 }));

    expect(tel.incidents).toEqual([]);
    expect(m.term.cleared).toBe(0);
    // The press still went through, so the double click still selects a word.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.detail).toBe(2);
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

/* ------------------------------------------------------------------ *
 * 13. Touch scroll (term.html:6056-6171 and the recognizer at :6478-6556)
 * ------------------------------------------------------------------ */

/**
 * The only way to scroll a terminal with a finger, and until this landed the
 * native path had none: `terminal/touchscroll.ts` has been green and unwired
 * since the port, so 144 passing cases proved arithmetic that nothing ran.
 *
 * WHAT THESE CANNOT REACH. jsdom lays nothing out, so a real finger producing a
 * real scroll is a browser claim and belongs on the shared Android emulator.
 * What is checked here is every step the component owns: that the gate exists
 * at all, which events are listened for and on which node, which node the
 * synthetic wheels land on and how many of them there are, where their
 * coordinates come from, when the prefs and the screen box are read, and that
 * exactly one rAF is outstanding for as long as a coast is in flight. The
 * screen box is a stub, so what is under test is the arithmetic being fed the
 * box term.html measures, not the pixels.
 */
describe("touch scroll (term.html:6478-6556)", () => {
  /** 24 rows over 384px, so one row is 16px and the numbers below are exact. */
  const BOX = { left: 0, top: 0, width: 800, height: 384 };
  /** `performance.now()`, pinned so every `th` in one gesture agrees. */
  const NOW = 1000;

  let restorePointer: (() => void) | null = null;
  let restoreNow: (() => void) | null = null;
  let frames: Frames | null = null;

  afterEach(() => {
    restorePointer?.();
    restoreNow?.();
    frames?.restore();
    restorePointer = restoreNow = null;
    frames = null;
  });

  const hostOf = (m: Mounted): HTMLElement => {
    const el = m.term.host;
    if (!el) throw new Error("the terminal was never opened");
    return el;
  };

  const elementOf = (m: Mounted): HTMLElement => {
    const el = m.term.element;
    if (!el) throw new Error("the terminal has no element");
    return el;
  };

  /** A phone: the coarse-pointer gate open, both clocks pinned, rAF recorded. */
  async function onTouch(): Promise<{
    m: Mounted;
    wheels: WheelEvent[];
    screen: HTMLDivElement;
  }> {
    restorePointer = fakePointer(true);
    restoreNow = fakeNow(() => NOW);
    frames = fakeFrames();
    const m = await mountOpen();
    const screen = boxScreen(m.term, BOX);
    return { m, wheels: watchWheels(elementOf(m)), screen };
  }

  /** One finger landing at `start` and moving through `moves`. */
  const finger = (
    m: Mounted,
    start: readonly [y: number, t: number],
    moves: readonly (readonly [y: number, t: number])[],
  ): void => {
    const target = hostOf(m);
    target.dispatchEvent(touchEvent("touchstart", [start[0]], start[1]));
    for (const [y, t] of moves) target.dispatchEvent(touchEvent("touchmove", [y], t));
  };

  /** A flick: two moves fast enough to leave a coast behind, then the lift. */
  const flick = (m: Mounted): void => {
    finger(m, [300, 0], [
      [260, 10],
      [220, 20],
    ]);
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 25));
  };

  /**
   * THE GATE, which is the most consequential line of this wiring and the one a
   * reading of the owes list alone would have missed.
   *
   * term.html's whole recognizer sits inside `if (isCoarsePointer)` (:6478), so
   * on a machine that answers `(pointer: coarse)` false it attaches no touch
   * listener and a finger gets the browser's native scroll. A touchscreen
   * laptop is a real machine people own, and without the gate that finger would
   * ALSO feed one LINE wheel per row to the pty and drop tmux into copy-mode
   * under it. The page is deliberate about it at :6399-6400.
   */
  it("attaches nothing where the primary pointer is not a finger", async () => {
    restorePointer = fakePointer(false);
    restoreNow = fakeNow(() => NOW);
    frames = fakeFrames();
    const m = await mountOpen();
    boxScreen(m.term, BOX);
    const wheels = watchWheels(elementOf(m));
    const booted = m.term.focused;
    flick(m);
    expect(wheels).toHaveLength(0);
    expect(frames.outstanding()).toBe(0);
    // Not even the tap focus, which is the other half of the gated block.
    expect(m.term.focused).toBe(booted);
  });

  /**
   * The whole mechanism in one case: 52px of travel on 16px rows is three
   * discrete one-row LINE wheels, dispatched SEPARATELY on xterm's own root.
   *
   * Every field is part of what the pty receives. `deltaMode: 1` is the only
   * shape xterm neither damps nor collapses; separate dispatches are what beat
   * its one-report-per-event cap in mouse-tracking mode; and the coordinates
   * are what the SGR report's cell is derived from, `clientY` being the
   * finger's last y.
   */
  it("turns a drag into one discrete line wheel per row", async () => {
    const { m, wheels } = await onTouch();
    finger(m, [300, 0], [[248, 20]]);
    expect(wheels).toHaveLength(3);
    for (const w of wheels) {
      expect(w.deltaMode).toBe(1);
      expect(w.deltaY).toBe(1);
      expect(w.clientX).toBe(0);
      expect(w.clientY).toBe(248);
      expect(w.isTrusted).toBe(false);
    }
  });

  /**
   * The sign, as the page verified it (:6074-6075): a finger moving DOWN the
   * screen scrolls UP into scrollback and copy-mode, so content follows the
   * finger the way it does everywhere else on a phone.
   */
  it("scrolls into scrollback when the finger goes down the screen", async () => {
    const { m, wheels } = await onTouch();
    finger(m, [100, 0], [[152, 20]]);
    expect(wheels.map((w) => w.deltaY)).toEqual([-1, -1, -1]);
    expect(wheels[0]?.clientY).toBe(152);
  });

  /**
   * A tap is what raises the soft keyboard, and it is deferred to the LIFT and
   * gated on the gesture never having become a swipe (:6527). Both mistakes
   * cost something: a scroll read as a tap puts the keyboard over the
   * scrollback it just revealed.
   *
   * WHERE THE TAP LANDS is the compose mirror's field, not xterm, and that is
   * the whole of term.html's `tapFocus` reassignment (:7459-7462), which the
   * case below this one covers. A finger on a phone reaches autocorrect,
   * dictation and swipe typing; xterm's own helper textarea is deliberately
   * hardened against all three.
   */
  it("focuses on a tap and not on a swipe", async () => {
    const { m } = await onTouch();
    const field = m.mirror();
    field.blur();
    finger(m, [300, 0], [[298, 10]]); // 2px: still a tap
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 20));
    expect(document.activeElement).toBe(field);

    field.blur();
    finger(m, [300, 30], [[248, 40]]);
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 50));
    expect(document.activeElement).not.toBe(field);
  });

  /**
   * `input.tapFocus: 'terminal'` is the deliberate raw keyboard (settings
   * 'Terminal tap' -> Keyboard), and it puts the tap back in xterm's hardened
   * helper textarea. Read per tap, where the page reads `getPrefs()` per tap,
   * so it is written AFTER the mount: a wiring that had taken it from
   * `bootPrefs` would answer 'field' here.
   */
  it("puts the tap in the terminal when the pref says so", async () => {
    const { m } = await onTouch();
    const field = m.mirror();
    field.blur();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { tapFocus: "terminal" } }));
    const booted = m.term.focused;
    finger(m, [300, 0], [[298, 10]]);
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 20));
    expect(m.term.focused).toBe(booted + 1);
    expect(document.activeElement).not.toBe(field);
  });

  /**
   * The screen box is measured ON DEMAND, which is what emit.ts's lazy geometry
   * is for: a touchmove that has not proven itself a swipe reads nothing, where
   * an eagerly-built world would force a layout against a grid xterm is writing
   * into on every move of every gesture.
   */
  it("measures no box for a move that is still a tap", async () => {
    const { m, screen } = await onTouch();
    const real = screen.getBoundingClientRect.bind(screen);
    let measured = 0;
    screen.getBoundingClientRect = (): DOMRect => {
      measured++;
      return real();
    };
    finger(m, [300, 0], [[296, 10]]); // 4px, under the 6px threshold
    expect(measured).toBe(0);
    finger(m, [300, 30], [[248, 40]]);
    expect(measured).toBeGreaterThan(0);
  });

  /**
   * Its OWN host's screen, never a document query. term.html can afford
   * `document.querySelector('.xterm-screen')` (:6095) because a framed page
   * holds one terminal; the lobby keeps every visited session mounted and
   * CSS-hides the rest, and a hidden one measures 0, which makes `rowPx` 0, so
   * the visible terminal's finger would bank its pixels and emit not one wheel.
   */
  it("ignores another terminal's screen node", async () => {
    const decoy = document.createElement("div");
    decoy.className = "xterm-screen";
    document.body.insertBefore(decoy, document.body.firstChild);
    const { m, wheels } = await onTouch();
    finger(m, [300, 0], [[248, 20]]);
    expect(wheels).toHaveLength(3);
    decoy.remove();
  });

  /**
   * The speed pref is read FRESH per feed, where term.html re-reads it inside
   * `feedScroll` (:6119).
   *
   * Written AFTER the mount on purpose: the component's own `bootPrefs` reads
   * the document once at construction, so a wiring that had taken the speed
   * from there would still answer 1 here, and this case is what tells the two
   * apart.
   */
  it("reads the scroll speed fresh, not the one it booted with", async () => {
    const { m, wheels } = await onTouch();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { scrollSpeedV2: 2 } }));
    finger(m, [300, 0], [[280, 20]]); // 20px: one row at speed 1, two at speed 2
    expect(wheels).toHaveLength(2);
  });

  /**
   * A flick coasts, and the coast is the one thing the module cannot do for
   * itself: it hands back `coasting` and the component owes it exactly one
   * outstanding rAF for as long as that is true.
   *
   * The frame's timestamp has to come from the same clock as the `th` the lift
   * froze into `Coast.at` (`performance.now()`), which is why the coast reads
   * rAF's own argument rather than `Date.now()`.
   */
  it("keeps one frame outstanding while a flick is still coasting", async () => {
    const { m, wheels } = await onTouch();
    flick(m);
    expect(wheels).toHaveLength(5);
    if (!frames) throw new Error("no frame recorder");
    expect(frames.outstanding()).toBe(1);

    frames.run(NOW + 16);
    // The coast carries the drag's last y, which is what makes the hand-off
    // seamless: same coordinate, same pane, more wheels.
    const afterOne = wheels.length;
    expect(afterOne).toBeGreaterThan(5);
    for (const w of wheels.slice(5)) expect(w.clientY).toBe(220);
    expect(frames.outstanding()).toBe(1);

    // A SECOND frame, because one proves less than it looks like it does. The
    // re-arm is computed from the reduction the actions were taken FROM, so a
    // coast whose state was cleared while those actions ran still leaves one
    // frame outstanding; that frame is the one that finds nothing to do. The
    // decay is the claim, so it takes two frames to see it.
    frames.run(NOW + 32);
    expect(wheels.length).toBeGreaterThan(afterOne);
    expect(frames.outstanding()).toBe(1);
  });

  /**
   * `gestures.scrollMomentum` is read at the LIFT and only there (:6543), which
   * is why turning momentum off does not stop a coast already in flight, and
   * again, written after the mount, so a boot-time read would fail this.
   */
  it("does not coast when momentum is off in the document", async () => {
    const { m } = await onTouch();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { scrollMomentum: false } }));
    flick(m);
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * A finger held still before the lift leaves no flick to continue
   * (`GAP_STILL_MS`, :6549-6550). It cannot be read off the samples, because
   * browsers dedupe identical-coordinate touchmoves and the buffer still ends
   * at the last MOVING one, so the gap is measured to the touchend, on BOTH
   * clocks, and the smaller of the two is what counts. Here both are long: the
   * event stamps say 400ms and `performance.now()` moves with them.
   */
  it("does not coast when the finger was held still", async () => {
    const { m } = await onTouch();
    restoreNow?.();
    let now = NOW;
    restoreNow = fakeNow(() => now);
    finger(m, [300, 0], [
      [260, 10],
      [220, 20],
    ]);
    now = NOW + 400;
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 420));
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * FOUR THINGS INTERRUPT A COAST in term.html, and each reaches this component
   * through one route. A trusted wheel is the first (:6281), through a listener
   * on the HOST rather than the document, so it sees only wheels over this
   * terminal.
   *
   * Our own coast ticks are untrusted, which is the whole reason that listener
   * tests the flag: without it the coast would cancel itself on the first wheel
   * it emitted.
   */
  const coasting = async (): Promise<{ m: Mounted; wheels: WheelEvent[] }> => {
    const started = await onTouch();
    flick(started.m);
    expect(frames?.outstanding()).toBe(1);
    return started;
  };

  it("ends the coast on a real wheel over the terminal", async () => {
    const { m } = await coasting();
    hostOf(m).dispatchEvent(trustedWheel({ deltaY: -3 }));
    expect(frames?.outstanding()).toBe(0);
    expect(frames?.cancelled).toHaveLength(1);
  });

  it("does not let its own synthetic wheels end the coast", async () => {
    const { m } = await coasting();
    hostOf(m).dispatchEvent(
      new WheelEvent("wheel", { deltaY: -1, deltaMode: 1, bubbles: true }),
    );
    expect(frames?.outstanding()).toBe(1);
  });

  /**
   * THE COAST SURVIVES ITS OWN MOUSE REPORTS, which is the case the `isTrusted`
   * test above cannot reach and the state a phone is actually in: tmux with
   * `mouse on`, or any TUI that asked for reports.
   *
   * With reporting on, each emitted wheel comes back as pty-bound INPUT inside
   * the dispatch (`reportMouse` has the measurement), and two interrupt sites
   * are downstream of that `onData`: the `cancel-momentum` action, then `send`.
   * Left alone they cancel the coast that produced the wheel, and a flick
   * scrolls one frame instead of decaying.
   *
   * term.html does not diverge, and its reason is the fix: `cancelScrollMomentum`
   * clears `momentumRAF` alone (:6129-6130) while the velocity, distance and
   * anchor are `let`s inside `startScrollMomentum`, and `step` re-arms the frame
   * on the line after `feedScroll` (:6167). Re-entered from inside `step`, the
   * cancel is a no-op. This port keeps the motion in `TouchScrollState.coast`,
   * so the component owes the exclusion.
   *
   * TWO frames, for the reason the case above spells out: the first re-arms off
   * a reduction taken before the cancel could land, so a broken coast still
   * looks alive after one.
   */
  it("keeps coasting while its own wheels come back as mouse reports", async () => {
    const { m, wheels } = await onTouch();
    const reports = reportMouse(m.term);
    flick(m);
    const drag = wheels.length;
    expect(drag).toBe(5);
    expect(reports).toHaveLength(drag); // every wheel reported, drag included
    if (!frames) throw new Error("no frame recorder");
    expect(frames.outstanding()).toBe(1);

    frames.run(NOW + 16);
    const afterOne = wheels.length;
    expect(afterOne).toBeGreaterThan(drag);
    frames.run(NOW + 32);
    expect(wheels.length).toBeGreaterThan(afterOne);
    expect(frames.outstanding()).toBe(1);
    // And the reports still went to the pty: only the cancel is excluded.
    expect(reports).toHaveLength(wheels.length);
    expect(inputs(m.socket())).toHaveLength(wheels.length);
  });

  /**
   * A REAL keystroke still ends it while reporting is on, which is what keeps
   * the exclusion above from being a blanket. `emittingWheel` is true only for
   * the length of our own dispatch, so a key pressed between frames is the
   * pty-bound byte term.html cancels for at :8269 and :8341.
   */
  it("still ends the coast on a keystroke with mouse reporting on", async () => {
    const { m } = await onTouch();
    reportMouse(m.term);
    flick(m);
    expect(frames?.outstanding()).toBe(1);
    m.type("x");
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * AN ASK IS NOT A REATTACH. term.html cancels a coast inside `ws.onopen`
   * (:10294) and nowhere on its ask path (:9822-9824), so the ADR-0016 Run
   * check and a session view returning to the screen must leave a flick alone.
   * Hanging the cancel off `onPhase("open")` did not, because `reportNow` fires
   * that phase again for the same socket.
   */
  it("does not end the coast when the badge asks what is going on", async () => {
    const { m } = await coasting();
    m.control().ask();
    expect(m.reports.at(-1)).toEqual({ state: "open", attempt: 0 });
    expect(frames?.outstanding()).toBe(1);
  });

  /**
   * Every pty-bound byte cancels a coast, at the one choke point term.html
   * cancels at (`sendInput`, :8269), and the onData hook cancels a second time
   * on its own (:8341), which the page calls belt-and-braces and this port
   * keeps.
   */
  it("ends the coast on a keystroke", async () => {
    const { m } = await coasting();
    m.type("x");
    expect(frames?.outstanding()).toBe(0);
    expect(inputs(m.socket())).toEqual([[0x78]]);
  });

  /**
   * The soft keys, the composer's send-to-terminal and a dropped file's path
   * all arrive at `__tlSendToTerminal`, which is why touchscroll's fourth
   * interrupt site (term.html's toolbar cancelling for itself at :6823) needs
   * nothing of its own here: the bridge goes through the choke point.
   */
  it("ends the coast on a soft key coming through the bridge", async () => {
    const { m } = await coasting();
    expect(window.__tlSendToTerminal?.("\x1b")).toBe(true);
    expect(frames?.outstanding()).toBe(0);
    // And the bytes still arrive: the cancel is added to the path, not in place
    // of it.
    expect(inputs(m.socket())).toEqual([[0x1b]]);
  });

  /** A (re)attach ends a coast (:10294), which is `onPhase("open")` here. */
  it("ends the coast when the socket comes up", async () => {
    restorePointer = fakePointer(true);
    restoreNow = fakeNow(() => NOW);
    frames = fakeFrames();
    const m = await mount(); // NOT accepted yet, so no `open` has been reported
    boxScreen(m.term, BOX);
    flick(m);
    expect(frames.outstanding()).toBe(1);
    m.socket().accept();
    await settle();
    expect(frames.outstanding()).toBe(0);
  });

  /**
   * A cancelled touch cannot be followed by a coast. term.html registers no
   * touchcancel at all and leaves the stale gesture for the next touchstart to
   * clear, which is invisible there because no further move can arrive for a
   * dead touch; folding it in means the module never sits holding half a
   * gesture.
   */
  it("drops the gesture on touchcancel", async () => {
    const { m } = await onTouch();
    finger(m, [300, 0], [
      [260, 10],
      [220, 20],
    ]);
    hostOf(m).dispatchEvent(touchEvent("touchcancel", [], 22));
    hostOf(m).dispatchEvent(touchEvent("touchend", [], 25));
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * A second finger disarms the drag, which is what keeps multi-finger shapes
   * out of this module's way by construction (:6498, :6503). The pinch to font
   * size is the module that owns two fingers, and it is not this one.
   */
  it("stops scrolling the moment a second finger lands", async () => {
    const { m, wheels } = await onTouch();
    const target = hostOf(m);
    target.dispatchEvent(touchEvent("touchstart", [300, 320], 0));
    target.dispatchEvent(touchEvent("touchmove", [248, 260], 20));
    expect(wheels).toHaveLength(0);
  });

  /**
   * An unmount takes the pending frame with it, through the module's own
   * `interrupt` rather than a cancel behind its back.
   */
  it("cancels a pending coast frame on unmount", async () => {
    const { m } = await coasting();
    m.unmount();
    await settle();
    expect(frames?.outstanding()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 14. The desktop smooth-wheel interceptor (term.html:6172-6274)
 * ------------------------------------------------------------------ */

/**
 * A trackpad's pixel stream, de-damped into paced one-row line wheels.
 *
 * xterm damps a sub-50px pixel wheel to 0.3x and, in mouse-tracking mode,
 * forwards at most one report per DOM event whatever its magnitude, so tmux
 * copy-mode jumps five whole lines per surviving report. The fix is to capture
 * the full pixel travel and re-emit it as a proportional number of LINE wheels,
 * a frame at a time, through the same primitive the finger uses.
 *
 * What jsdom cannot say is whether a real trackpad feels right. What it can say
 * is which events are intercepted, what the handler answers xterm, how many
 * wheels come out, and where their coordinates come from.
 */
describe("the desktop smooth wheel (term.html:6172-6274)", () => {
  const BOX = { left: 0, top: 0, width: 800, height: 384 };
  let frames: Frames | null = null;
  let restorePointer: (() => void) | null = null;

  afterEach(() => {
    frames?.restore();
    restorePointer?.();
    frames = null;
    restorePointer = null;
  });

  async function onTrackpad(): Promise<{
    m: Mounted;
    wheels: WheelEvent[];
    wheel: (init: WheelEventInit) => boolean;
  }> {
    frames = fakeFrames();
    const m = await mountOpen();
    boxScreen(m.term, BOX);
    const element = m.term.element;
    const handler = m.term.wheelHandler;
    if (!element) throw new Error("the terminal has no element");
    if (!handler) throw new Error("no custom wheel event handler was installed");
    return { m, wheels: watchWheels(element), wheel: (init) => handler(trustedWheel(init)) };
  }

  it("installs a custom wheel handler at all", async () => {
    const m = await mountOpen();
    expect(m.term.wheelHandler).toBeTypeOf("function");
  });

  /**
   * 100px of travel on 16px rows, paced into one frame: six one-row wheels and
   * a 4px remainder that waits rather than being dropped. The handler answers
   * FALSE, which is what takes the event off xterm's own damp-and-cap path, and
   * the wheels go out on the NEXT frame rather than inside the event being
   * handled, so nothing re-enters.
   */
  it("re-emits a pixel wheel as discrete one-row wheels, a frame later", async () => {
    const { wheels, wheel } = await onTrackpad();
    expect(wheel({ deltaY: 100, deltaMode: 0 })).toBe(false);
    expect(wheels).toHaveLength(0);
    if (!frames) throw new Error("no frame recorder");
    expect(frames.outstanding()).toBe(1);
    frames.run(0);
    expect(wheels).toHaveLength(6);
    for (const w of wheels) {
      expect(w.deltaMode).toBe(1);
      expect(w.deltaY).toBe(1);
    }
  });

  /**
   * ONE frame per burst (:6257 arms only when nothing is outstanding), and the
   * recorder is what makes that checkable: two wheels arriving before the frame
   * runs must not queue two frames.
   */
  it("asks for one frame however many wheels arrive first", async () => {
    const { wheel } = await onTrackpad();
    wheel({ deltaY: 40, deltaMode: 0 });
    wheel({ deltaY: 40, deltaMode: 0 });
    expect(frames?.outstanding()).toBe(1);
  });

  /**
   * Our own emissions are untrusted and pass straight through, which is both
   * halves of the `isTrusted` gate: it keeps the touch scroller's wheels out of
   * this accumulator AND stops this one converting its own output back into px
   * for ever.
   */
  it("passes an untrusted wheel through untouched", async () => {
    const { m, wheels } = await onTrackpad();
    const handler = m.term.wheelHandler;
    if (!handler) throw new Error("no handler");
    expect(handler(new WheelEvent("wheel", { deltaY: -1, deltaMode: 1 }))).toBe(true);
    expect(frames?.outstanding()).toBe(0);
    expect(wheels).toHaveLength(0);
  });

  /**
   * The modifier and horizontal red line, unchanged from before the interceptor
   * existed (:6233-6237): Shift is horizontal scrolling, Ctrl and Cmd are zoom,
   * Alt is nothing this may claim, and a horizontal-dominant delta is a native
   * two-finger swipe.
   */
  it.each([
    ["shift", { shiftKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["alt", { altKey: true }],
  ])("leaves a %s-modified wheel to xterm", async (_name, mods) => {
    const { wheel } = await onTrackpad();
    expect(wheel({ deltaY: 100, deltaMode: 0, ...mods })).toBe(true);
    expect(frames?.outstanding()).toBe(0);
  });

  it("leaves a horizontal-dominant wheel to xterm", async () => {
    const { wheel } = await onTrackpad();
    expect(wheel({ deltaX: 120, deltaY: 20, deltaMode: 0 })).toBe(true);
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * The `tl-gestures` master kill, read FRESH on every wheel because term.html
   * reads it fresh on every wheel (`wheelSmoothOn`, :6203-6205, called at
   * :6238). It is a plain per-browser key someone sets by hand to rescue a
   * device, so a value cached at mount would need a reload to obey.
   */
  it("obeys the gestures kill switch flipped after the mount", async () => {
    const { wheel } = await onTrackpad();
    expect(wheel({ deltaY: 100, deltaMode: 0 })).toBe(false);
    localStorage.setItem("tl-gestures", "off");
    expect(wheel({ deltaY: 100, deltaMode: 0 })).toBe(true);
  });

  /** The per-feature half of the same reading: `gestures.wheelSmooth` off and
   *  xterm's exact raw wheel path comes back. */
  it("obeys gestures.wheelSmooth in the roamed document", async () => {
    const { wheel } = await onTrackpad();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { wheelSmooth: false } }));
    expect(wheel({ deltaY: 100, deltaMode: 0 })).toBe(true);
    expect(frames?.outstanding()).toBe(0);
  });

  /**
   * `gestures.wheelSpeed` is read fresh at both of its sites: the accumulator's
   * cap on the wheel (:6254) and the row size in the frame (:6214). At speed 2
   * a row is 8px, so the same 100px is capped at ten rows and drains as ten.
   */
  it("reads the wheel speed fresh, and the cap follows it", async () => {
    const { wheels, wheel } = await onTrackpad();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { wheelSpeed: 2 } }));
    wheel({ deltaY: 100, deltaMode: 0 });
    frames?.run(0);
    expect(wheels).toHaveLength(10);
  });

  /**
   * CONFLICT 1, AND THE WHOLE REASON `emit.ts` EXISTS. Every synthetic wheel
   * takes its `clientY` from `scrollLastEmitY` (:6087, read at :6111), which
   * starts at 100 and which ONLY the touch path writes (:6522). xterm derives
   * the mouse report's ROW from that coordinate against the screen box, so a
   * trackpad wheel lands in the tmux pane the finger last touched, and on a
   * machine where no finger ever did, in whatever pane y=100 falls in.
   *
   * Two ports each held half of this and neither could have tested it alone.
   */
  it("emits at y 100 with no finger, and at the finger's y after one", async () => {
    restorePointer = fakePointer(true);
    frames = fakeFrames();
    const m = await mountOpen();
    boxScreen(m.term, BOX);
    const element = m.term.element;
    const handler = m.term.wheelHandler;
    const target = m.term.host;
    if (!element || !handler || !target) throw new Error("the terminal is not open");
    const wheels = watchWheels(element);

    handler(trustedWheel({ deltaY: 100, deltaMode: 0 }));
    frames.run(0);
    expect(wheels).not.toHaveLength(0);
    for (const w of wheels) expect(w.clientY).toBe(100);

    const before = wheels.length;
    target.dispatchEvent(touchEvent("touchstart", [300], 0));
    target.dispatchEvent(touchEvent("touchmove", [248], 20));
    handler(trustedWheel({ deltaY: 100, deltaMode: 0 }));
    frames.run(0);
    expect(wheels.length).toBeGreaterThan(before);
    for (const w of wheels.slice(before)) expect(w.clientY).toBe(248);
  });

  /**
   * The pacer's own teardown, which is term.html's detach path (:6269-6271):
   * the accumulator is forgotten and the pending frame is cancelled, so nothing
   * drains into a terminal that is being disposed.
   */
  it("cancels a pending frame on unmount", async () => {
    const { m, wheel } = await onTrackpad();
    wheel({ deltaY: 100, deltaMode: 0 });
    expect(frames?.outstanding()).toBe(1);
    m.unmount();
    await settle();
    expect(frames?.outstanding()).toBe(0);
    expect(frames?.cancelled).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 15. The rest of the key-handler contract (term.html:8516-8589)
 * ------------------------------------------------------------------ */

/**
 * xterm stores exactly ONE key handler, so every rule that wants a look at a
 * keydown shares this function and the order the legs are tested in is the
 * order term.html tests them in (`terminal/keys.ts` owns that order). The paste
 * leg is section 2b; this is the rest of it.
 *
 * WHAT AN ANSWER MEANS HERE. Returning false stops xterm dead, BEFORE its own
 * `cancel(ev)`, so false alone means no pty byte AND no `preventDefault`, which
 * is what makes the F12 leg work and why the two legs that do want a browser
 * default suppressed ask for it explicitly. xterm is mocked, so what these
 * assert is the answer that governs the byte plus the bytes the component sends
 * itself; what xterm does with the answer is upstream's and is covered against
 * the real library in test/xterm.baseline.test.ts.
 */
describe("the key handler contract (term.html:8516-8589)", () => {
  /** xterm consulting the one handler it stores, keeping the event to inspect. */
  const press = (
    m: Mounted,
    init: KeyboardEventInit,
  ): { answer: boolean; event: KeyboardEvent } => {
    const handler = m.term.keyHandler;
    if (!handler) throw new Error("no custom key event handler was installed");
    // `cancelable`, or jsdom refuses to record a preventDefault and the two legs
    // that ask for one could not be told from the seven that do not.
    const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
    return { answer: handler(event), event };
  };

  /** `navigator.platform`, which is the ONLY Mac test that matters here. */
  const asPlatform = (platform: string): (() => void) => {
    const had = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    return () => {
      if (had) Object.defineProperty(navigator, "platform", had);
      else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "platform");
    };
  };

  /** A clipboard, which jsdom has none of: the API is secure-context only. */
  const withClipboard = (write: (text: string) => Promise<void>): (() => void) => {
    const had = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: write },
    });
    return () => {
      if (had) Object.defineProperty(navigator, "clipboard", had);
      else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
    };
  };

  let restore: (() => void)[] = [];
  afterEach(() => {
    for (const r of restore.reverse()) r();
    restore = [];
  });

  const CTRL_C: KeyboardEventInit = { key: "c", code: "KeyC", ctrlKey: true };

  /**
   * F12 opens devtools like on any normal web page. Without this leg xterm's
   * function-key handling sends ESC [ 24~ to the pty AND cancels the event, so
   * devtools never opens over a focused terminal. Answering false hands the key
   * wholly to the browser, which is why this is the ONE leg that must not
   * preventDefault: the browser default is the entire point.
   */
  it("hands F12 to the browser whole, default and all", async () => {
    const m = await mountOpen();
    const { answer, event } = press(m, { key: "F12", code: "F12" });
    expect(answer).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(inputs(m.socket())).toEqual([]);
  });

  /** Modified F12 stays with xterm (Viktor, 2026-07-17). */
  it("leaves a modified F12 to xterm", async () => {
    const m = await mountOpen();
    expect(press(m, { key: "F12", code: "F12", ctrlKey: true }).answer).toBe(true);
  });

  /**
   * Option+Arrow moves by word, and the sequence matters: xterm's own answer is
   * the modifier-3 cursor form `ESC [ 1;3D`, which zsh leaves as `undefined-key`
   * (bash binds it, zsh does not), so word navigation silently no-ops for Mac
   * users in zsh. That is the reported bug this leg exists for; iTerm2 sends
   * ESC b / ESC f, which zsh, bash, readline and Claude Code's editor all bind.
   *
   * The `preventDefault` is not optional and `false` is not a substitute for it:
   * the focused element is xterm's helper textarea, where Option+Arrow is the
   * system's own word-motion binding for a text field, so without it the caret
   * moves inside that hidden field.
   */
  it("sends ESC b for Option+Left on a Mac, and suppresses the field's own motion", async () => {
    restore.push(asPlatform("MacIntel"));
    const m = await mountOpen();
    const { answer, event } = press(m, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(answer).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(inputs(m.socket())).toEqual([[0x1b, 0x62]]);
  });

  it("sends ESC f for Option+Right on a Mac", async () => {
    restore.push(asPlatform("MacIntel"));
    const m = await mountOpen();
    expect(press(m, { key: "ArrowRight", code: "ArrowRight", altKey: true }).answer).toBe(false);
    expect(inputs(m.socket())).toEqual([[0x1b, 0x66]]);
  });

  /**
   * Off a Mac the word-motion modifier is Ctrl, which zsh already binds
   * (`ESC [ 1;5C/D`), and Alt+Left is Back on Windows and Linux. So the leg is
   * gated on the platform rather than on the modifier alone.
   */
  it("leaves Option+Left alone off a Mac", async () => {
    restore.push(asPlatform("Linux x86_64"));
    const m = await mountOpen();
    expect(press(m, { key: "ArrowLeft", code: "ArrowLeft", altKey: true }).answer).toBe(true);
    expect(inputs(m.socket())).toEqual([]);
  });

  /**
   * A LOBBY CHORD MUST NOT ALSO TYPE. The keybinding engine runs its command
   * from a capture-phase window listener and calls `preventDefault()` on the
   * match, and capture descends, so by the time xterm's listener on the helper
   * textarea consults this handler the command has already run. All that is
   * left is to keep the key off the pty: without this leg Alt+Shift+W kills the
   * session AND puts ESC W on the prompt of the next one.
   *
   * The signal is `e.defaultPrevented`, which is a declared divergence from
   * keys.ts's `matchesAppChord` and is argued at the call site.
   */
  it("swallows a key the lobby has already claimed", async () => {
    const m = await mountOpen();
    const handler = m.term.keyHandler;
    if (!handler) throw new Error("no handler");
    const claimed = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      altKey: true,
      shiftKey: true,
      cancelable: true,
    });
    claimed.preventDefault(); // what the engine's own listener did first
    expect(handler(claimed)).toBe(false);
    expect(inputs(m.socket())).toEqual([]);
  });

  it("types the same key when nothing claimed it", async () => {
    const m = await mountOpen();
    expect(press(m, { key: "w", code: "KeyW", altKey: true, shiftKey: true }).answer).toBe(true);
  });

  /**
   * ADR-0003's contract, finally honoured on this path: Ctrl+C with a highlight
   * on screen is a COPY, and it is SIGINT the moment there is not one. Both
   * halves are the test: a chord that always copied would cost the interrupt.
   */
  it("copies the highlight instead of interrupting", async () => {
    const written: string[] = [];
    restore.push(
      withClipboard((text) => {
        written.push(text);
        return Promise.resolve();
      }),
    );
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    expect(press(m, CTRL_C).answer).toBe(false);
    expect(written).toEqual(["highlighted"]);
    await settle();
    expect(raised).toEqual([{ message: "Copied", kind: "success", timeoutMs: 1500 }]);
  });

  it("leaves Ctrl+C as SIGINT with nothing highlighted", async () => {
    const written: string[] = [];
    restore.push(
      withClipboard((text) => {
        written.push(text);
        return Promise.resolve();
      }),
    );
    const m = await mountOpen();
    expect(press(m, CTRL_C).answer).toBe(true);
    expect(written).toEqual([]);
    m.type("\x03");
    expect(inputs(m.socket())).toEqual([[0x03]]);
  });

  /**
   * The RANGE decides, not the text. xterm right-trims every row it hands back,
   * so a drag ending in a row's trailing blanks leaves a visible highlight whose
   * text is "": term.html swallows the chord, writes "" and toasts anyway
   * (:8569-8570). Gating on the text instead would let ^C through and fire
   * SIGINT with a highlight on screen.
   */
  it("spends the chord on a highlight whose text is empty", async () => {
    const written: string[] = [];
    restore.push(
      withClipboard((text) => {
        written.push(text);
        return Promise.resolve();
      }),
    );
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "";
    expect(press(m, CTRL_C).answer).toBe(false);
    expect(written).toEqual([""]);
  });

  /**
   * A refused write says so. term.html reaches `navigator.clipboard.writeText`
   * unguarded (:8570), which throws where the API is absent, meaning any
   * non-secure context, and a throw inside xterm's key handler takes the
   * keystroke with
   * it. jsdom is that browser, so this is the arm the guard exists for.
   */
  it("says the browser blocked the copy when there is no clipboard", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    expect(press(m, CTRL_C).answer).toBe(false);
    expect(raised).toEqual([
      { message: "Copy blocked by browser", kind: "error", timeoutMs: 2500 },
    ]);
  });

  /** And a rejected write, which is the same news by the other route. */
  it("says the same when the write is rejected", async () => {
    restore.push(withClipboard(() => Promise.reject(new Error("denied"))));
    const m = await mountOpen();
    m.term.selected = true;
    m.term.selectionText = "highlighted";
    press(m, CTRL_C);
    await settle();
    expect(messages()).toEqual(["Copy blocked by browser"]);
  });

  /**
   * Escape clears the highlight AND still reaches the app, which is the whole
   * of :8565-8567: swallowing it would break vim, where Escape is the
   * most-pressed key in the editor.
   */
  it("clears a highlight on Escape and still hands the key over", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    const { answer } = press(m, { key: "Escape", code: "Escape" });
    expect(answer).toBe(true);
    expect(m.term.cleared).toBe(1);
  });

  /**
   * With nothing highlighted there is nothing to dismiss, and the guard is
   * term.html's own early return (:5893). The fake records the call rather than
   * modelling xterm's state, so the flag is dropped by hand here the way xterm
   * would drop it.
   */
  it("clears nothing on Escape with no highlight", async () => {
    const m = await mountOpen();
    m.term.selected = true;
    press(m, { key: "Escape", code: "Escape" });
    m.term.selected = false;
    press(m, { key: "Escape", code: "Escape" });
    expect(m.term.cleared).toBe(1);
  });

  /**
   * THE ONE LEG THAT IS PORTED AND UNREACHABLE, pinned so it cannot be believed
   * by accident. term.html's Escape discards what was typed offline
   * (:8554-8564) and toasts "Discarded what you typed while offline"; keys.ts
   * ports it and this component performs it, but the WORLD it reads carries no
   * hold, because attach.ts keeps the queue and exposes no discard. So an
   * Escape with a real hold on the wire falls through to the selection branch,
   * which is what it did before any of this was wired.
   *
   * Wiring the leg without the discard would be worse than leaving it: the key
   * would be swallowed, the toast would promise the line was thrown away, and
   * the hold would replay on the next reconnect anyway. When the discard lands,
   * this case is the one that has to change.
   */
  it("leaves Escape alone while a hold it cannot reach is on the wire", async () => {
    const m = await mountOpen();
    m.socket().drop();
    await settle();
    m.type("qw");
    expect(messages()).toEqual(["Held — it goes in when the session is back"]);
    raised = [];
    expect(press(m, { key: "Escape", code: "Escape" }).answer).toBe(true);
    expect(messages()).toEqual([]);
  });

  /**
   * The onData hook's head runs on EVERY chunk, and its send goes through the
   * one choke point, so watch mode and the offline hold see a word-jump byte and
   * a keystroke through the same door.
   */
  it("routes a refused keystroke through the same choke point as a word jump", async () => {
    restore.push(asPlatform("MacIntel"));
    const m = await mountOpen({ watch: true });
    press(m, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(inputs(m.socket())).toEqual([]);
    expect(messages()).toEqual(["Watching — this device can’t type into the session"]);
  });
});

/* ------------------------------------------------------------------ *
 * 16. The compose mirror (term.html:7077-7509)
 * ------------------------------------------------------------------ */

/**
 * A textarea kept as a transparent mirror of the pty's input line, because
 * xterm's own helper textarea is deliberately hardened against predictive text
 * (section 5) and that leaves a phone with no route to autocorrect, dictation
 * or swipe typing at all.
 *
 * `mirror.ts` decides; this asserts that the component mounts the field the
 * module describes and performs what the module returns. WHAT IT CANNOT REACH
 * is the whole reason the field exists: whether Gboard's suggestion bar or iOS
 * QuickType actually appears over it, and whether a swipe-typed word arrives as
 * one `input` event. Those are DEVICE claims, answered by the shared Android
 * emulator for Chrome and by nothing in this homelab for iOS, and the
 * attributes below are only the mechanism term.html uses to make them. What is checkable here is
 * that mechanism: the attribute set including its deliberate OMISSION, and
 * every edit shape reaching the pty as the right bytes.
 */
describe("the compose mirror (term.html:7077-7509)", () => {
  let restorePointer: (() => void) | null = null;

  afterEach(() => {
    restorePointer?.();
    restorePointer = null;
  });

  /** A phone, which is the only device the field is mounted on. */
  async function onPhone(opts: { open?: boolean } = {}): Promise<Mounted> {
    restorePointer = fakePointer(true);
    return opts.open === false ? await mount() : await mountOpen();
  }

  /**
   * A phone whose socket has been open and is now down, which is the offline
   * state the mirror's submit branch is about: attach.ts holds a keystroke for
   * replay only once there has been a pty to hold it for, so a socket that
   * never connected is REFUSED rather than held and says something else.
   */
  async function onDroppedPhone(): Promise<Mounted> {
    const m = await onPhone();
    m.socket().drop();
    await settle();
    return m;
  }

  /** One field edit, as the DOM delivers it: after the mutation, always. */
  const edit = (field: HTMLTextAreaElement, value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** A paste aimed at the field, which arrives as `beforeinput` first. */
  const pasteInto = (field: HTMLTextAreaElement, data: string): InputEvent => {
    const e = new InputEvent("beforeinput", {
      inputType: "insertFromPaste",
      data,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(e);
    return e;
  };

  const backspace = (
    field: HTMLTextAreaElement,
    opts: { composing?: boolean } = {},
  ): void => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        isComposing: opts.composing === true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  /** Every `term.input()` the mirror made, in order: its whole route out. */
  const emitted = (m: Mounted): string[] => m.term.typedIn.map((t) => t.data);
  /** What reached the pty, which is the other end of that route. */
  const onWire = (m: Mounted): string[] => sgr(m.socket());

  /* ---- the field itself ------------------------------------------- */

  /**
   * OUTSIDE the terminal host, which mirror.ts's `paste-intent` names as the
   * thing that breaks if it lives in the wrong place: the host carries a
   * capture-phase paste listener that preventDefaults and stopPropagations
   * every paste carrying text (section 2c), so a field mounted inside it would
   * have its paste swallowed before `beforeinput` fired: no native insertion
   * for a single-line paste, and no interception for a multiline one.
   */
  it("mounts the field outside the terminal host", async () => {
    const m = await onPhone();
    const host = m.term.host;
    if (!host) throw new Error("the terminal was never opened");
    expect(host.contains(m.mirror())).toBe(false);
    // And in this component's own tree, so it is unmounted with it rather than
    // left on the body by one of the sessions the lobby keeps mounted.
    expect(m.bar().contains(m.mirror())).toBe(true);
  });

  /** Every attribute mirror.ts carries, from the constant rather than by hand. */
  it.each(Object.entries(MIRROR_FIELD_ATTRIBUTES))(
    "sets %s to %s",
    async (name, value) => {
      const m = await onPhone();
      expect(m.mirror().getAttribute(name)).toBe(value);
    },
  );

  /**
   * THE OMISSION, which is the one that removes the feature without breaking
   * anything. term.html records the measurement (:7103-7110, 2026-07-12): on
   * iOS, pronounced in the installed PWA's WKWebView, `autocomplete='off'` also
   * suppresses the QuickType predictive and autocorrect bar. `type` is absent
   * for a related reason: a textarea has none, and the helper field's
   * `type=password` trick would kill the composition UI this field is for.
   */
  it.each([["autocomplete"], ["type"]])("carries no %s attribute at all", async (name) => {
    const m = await onPhone();
    expect(m.mirror().hasAttribute(name)).toBe(false);
  });

  /**
   * The contrast, in one case: the two attributes that must be ABSENT here are
   * set on xterm's own helper textarea, correctly, because that field is being
   * HARDENED. Copying that block onto this one is the mistake
   * MIRROR_FIELD_ATTRIBUTES exists to stop, and nothing would fail.
   */
  it("leaves xterm's helper textarea hardened the opposite way", async () => {
    const m = await onPhone();
    const helper = m.term.host?.querySelector(".xterm-helper-textarea");
    expect(helper?.getAttribute("autocomplete")).toBe("off");
    expect(helper?.getAttribute("type")).toBe("password");
    expect(helper?.getAttribute("autocorrect")).toBe("off");
    expect(m.mirror().getAttribute("autocorrect")).toBe("on");
  });

  /**
   * 16px INLINE, which is the whole of the iOS no-focus-auto-zoom guarantee and
   * must not depend on a stylesheet rule surviving (term.html:1852-1853).
   */
  it("sets a 16px font size inline", async () => {
    const m = await onPhone();
    expect(m.mirror().style.fontSize).toBe("16px");
  });

  /** `rows = 1` is the height the autogrow measures from (:7098). */
  it("starts at one row, with a placeholder", async () => {
    const m = await onPhone();
    expect(m.mirror().rows).toBe(1);
    expect(m.mirror().placeholder).not.toBe("");
  });

  /* ---- who gets one ----------------------------------------------- */

  /**
   * A FINE POINTER GETS NO FIELD, which is where term.html keeps the inert
   * `applyInputPrefs` stub (:7363-7364) so 'auto' never ghosts on a desktop.
   * The default in this file is a fine pointer, so this is the plain case.
   */
  it("mounts nothing where the primary pointer is not a finger", async () => {
    const m = await mountOpen();
    expect(m.noMirror()).toBe(true);
  });

  /** `input.bar: 'off'`, which is an explicit settings act (:7484). */
  it("mounts nothing under an off posture", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "off" } }));
    const m = await onPhone();
    expect(m.noMirror()).toBe(true);
  });

  /**
   * The DEVICE-LOCAL dismissal, `tl:input.barHidden:v1` (term.html:3208-3211).
   * Same origin as this app, so a person who hid the bar with the iframe's ⌨
   * soft key must not have it handed back by the native terminal, and this
   * app's own ⌨ key is a keyboard-dismiss, so there would be nothing to
   * dismiss it with a second time.
   */
  it("mounts nothing where this device dismissed the bar", async () => {
    localStorage.setItem("tl:input.barHidden:v1", "1");
    const m = await onPhone();
    expect(m.noMirror()).toBe(true);
  });

  /**
   * THE DEFAULT POSTURE IS THE GHOST, `input.bar: 'auto'` (term.html:2810), and
   * that is what keeps the terminal the only visible input surface: the field
   * is in the DOM, focusable and keyboard-summoning, but painted away and
   * reserving no rows. `opacity: 0` and NEVER `display: none` or
   * `visibility: hidden`, which kill focus and the soft keyboard on iOS (a
   * WebKit trait confirmed 2026-07-13, term.html:1877-1886), so the field keeps
   * a real size and still answers `.focus()`.
   */
  it("paints the default posture away without taking it out of the layout", async () => {
    const m = await onPhone();
    const field = m.mirror();
    expect(field.style.opacity).toBe("0");
    expect(field.style.display).not.toBe("none");
    expect(field.style.visibility).not.toBe("hidden");
    expect(m.bar().style.pointerEvents).toBe("none");
    field.focus();
    expect(document.activeElement).toBe(field);
  });

  /** `input.bar: 'on'` is the painted bar, which only the settings row writes. */
  it("paints the bar under an on posture", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    const m = await onPhone();
    expect(m.mirror().style.opacity).toBe("1");
    expect(m.bar().style.pointerEvents).toBe("auto");
  });

  /**
   * The bar rides the shell's own published stack, so there is no second source
   * of truth for where the keyboard's top edge is: mobile/viewport.ts writes
   * all three of these, and `#soft-keys` sits on the first two.
   */
  it("parks the bar above the keyboard, the safe area and the soft keys", async () => {
    const m = await onPhone();
    expect(m.bar().style.position).toBe("fixed");
    expect(m.bar().style.bottom).toContain("--kb-offset");
    expect(m.bar().style.bottom).toContain("--safe-b");
    expect(m.bar().style.bottom).toContain("--sk-h");
  });

  /* ---- the engine, through the component -------------------------- */

  /**
   * The whole mechanism in one case: what the field holds streams to the pty
   * through `term.input()`, which is xterm's own onData and therefore the
   * soft-modifier remap and the send choke point. NO new socket path
   * (term.html:7232-7236), which is what keeps watch mode and the offline hold
   * covering the mirror for free.
   */
  it("streams an insertion to the pty through term.input", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    expect(emitted(m)).toEqual(["ls"]);
    expect(m.term.typedIn[0]?.user).toBe(true);
    expect(onWire(m)).toEqual(["ls"]);
  });

  /** An append is a delta, not a resend: the baseline is what it already sent. */
  it("sends only what was added", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    edit(m.mirror(), "ls -");
    expect(emitted(m)).toEqual(["ls", " -"]);
  });

  /**
   * A correction is one DEL per code point and the retype, in ONE frame, which
   * is term.html building one string and handing it to one `emit()` (:7254).
   */
  it("corrects with backspaces and a retype in one frame", async () => {
    const m = await onPhone();
    edit(m.mirror(), "lz");
    edit(m.mirror(), "ls");
    expect(emitted(m)).toEqual(["lz", "\x7fs"]);
  });

  /** An unchanged value diffs to nothing, which is what makes a double-send impossible. */
  it("says nothing when the value did not move", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    edit(m.mirror(), "ls");
    expect(emitted(m)).toEqual(["ls"]);
  });

  /**
   * ENTER IS A NEWLINE IN THE VALUE, because the soft keyboard's send key
   * inserts one and there is no key event to read for it (`enterkeyhint` is
   * fixed at 'send' for that reason). The delta and the carriage return are
   * SEPARATE frames, as the page sends them (:7300-7301), and then the field
   * and the baseline both drop because the pty's input line restarts empty.
   */
  it("submits the line as its own frame and clears the field", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls\n");
    expect(emitted(m)).toEqual(["ls", "\r"]);
    expect(m.mirror().value).toBe("");
    // The baseline dropped with it: the next keystroke is a fresh line, not a
    // re-send of the one that just ran.
    edit(m.mirror(), "x");
    expect(emitted(m)).toEqual(["ls", "\r", "x"]);
  });

  /** Every newline, and the whole value: a mid-string Enter must not split the line. */
  it("submits the whole value wherever the newline was", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls\n-la");
    expect(emitted(m)).toEqual(["ls-la", "\r"]);
  });

  /**
   * ENTER WITH NO SOCKET keeps the text where the person can see it: the pty
   * never saw any of it, the text is sitting in attach.ts's hold, and clearing
   * the field would take the line away from under the hold and leave an empty
   * box with no way back (term.html:7286-7299).
   */
  it("keeps the line in the field when the socket is down", async () => {
    const m = await onDroppedPhone();
    edit(m.mirror(), "ls\n");
    expect(m.mirror().value).toBe("ls");
    // The `\r` never went out, so nothing can have run.
    expect(emitted(m)).toEqual(["ls"]);
  });

  /**
   * And it says why, on the SAME clock as the held-input messages, which is
   * `heldSay`'s one message every 5000ms (term.html:8191-8195).
   *
   * That shared clock is visible here rather than hidden: the send that was
   * held has already spent it on "your keystroke is held", so the mirror's own
   * sentence lands on the next Enter once the window is over. term.html
   * collides the same way for the same reason, and the alternative, a second
   * clock, is two toasts stacked on one drop.
   */
  it("names the way out of a held line, on the held-input clock", async () => {
    const m = await onDroppedPhone();
    edit(m.mirror(), "ls\n");
    expect(messages()).toEqual(["Held — it goes in when the session is back"]);
    vi.advanceTimersByTime(HELD_SAY_WINDOW_MS);
    raised = [];
    edit(m.mirror(), "ls\n");
    expect(messages()).toEqual([HELD_ENTER_MESSAGE]);
  });

  /**
   * A MULTILINE PASTE keeps the proven bracketed-paste path: the block never
   * enters the one-line field, the armed modifiers are disarmed first (they
   * would remap the paste's first character, which under bracketed paste is the
   * ESC of `ESC [200~`), and `term.paste` brackets it (:7306-7320).
   */
  it("intercepts a multiline paste and brackets it instead", async () => {
    const m = await onPhone();
    const e = pasteInto(m.mirror(), "one\ntwo");
    expect(e.defaultPrevented).toBe(true);
    expect(m.term.pasted).toEqual(["one\ntwo"]);
    // Not through the mirror's own route: this paste's onData traffic is what
    // resets the baseline, and marking it as ours would swallow that.
    expect(emitted(m)).toEqual([]);
  });

  /**
   * A SINGLE-LINE PASTE falls through, inserts natively and streams like
   * typing, which is what keeps the field showing the line.
   */
  it("lets a single-line paste insert itself and stream", async () => {
    const m = await onPhone();
    const e = pasteInto(m.mirror(), "one");
    expect(e.defaultPrevented).toBe(false);
    expect(m.term.pasted).toEqual([]);
    // The browser's own insertion, and then the `input` event it fires.
    edit(m.mirror(), "one");
    expect(emitted(m)).toEqual(["one"]);
  });

  /**
   * BACKSPACE AGAINST AN EMPTY FIELD erases pty-side text the mirror does not
   * hold, which is what an out-of-band reset leaves behind: transparent erase
   * (:7321-7327). With text in the field the differ owns the deletion, and
   * emitting here as well would delete twice; an IME owns its own backspaces
   * mid-composition.
   */
  it("erases pty-side text on a backspace against an empty field", async () => {
    const m = await onPhone();
    backspace(m.mirror());
    expect(emitted(m)).toEqual(["\x7f"]);
  });

  it("leaves the backspace alone where the field has text", async () => {
    const m = await onPhone();
    m.mirror().value = "ls";
    backspace(m.mirror());
    expect(emitted(m)).toEqual([]);
  });

  it("leaves an IME's own backspace alone", async () => {
    const m = await onPhone();
    backspace(m.mirror(), { composing: true });
    expect(emitted(m)).toEqual([]);
  });

  /* ---- the baseline, and what invalidates it ---------------------- */

  /**
   * RAW TYPING IN xterm's OWN FIELD is out of band: the bytes reached the pty
   * by a route the mirror did not emit, so its baseline is a lie and the field
   * drops with it (term.html:8342, through keys.ts's `mirror-out-of-band`).
   */
  it("drops the field when bytes reach the pty through xterm", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    m.type("q");
    expect(m.mirror().value).toBe("");
  });

  /**
   * THE MIRROR'S OWN ECHO IS NOT OUT OF BAND, and one flag decides it:
   * `term.input()` fires onData synchronously, so the reset hook runs INSIDE
   * the mirror's own emission. Answering that gate wrong clears the field
   * mid-word on every keystroke the person types.
   */
  it("does not read its own emission as somebody else's bytes", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    expect(m.mirror().value).toBe("ls");
    edit(m.mirror(), "ls -la");
    expect(m.mirror().value).toBe("ls -la");
  });

  /**
   * A SOFT KEY IS OUT OF BAND, and it is the site the onData hook cannot cover:
   * `__tlSendToTerminal` calls the attachment's `send` directly, so xterm's
   * onData never sees those bytes. term.html resets the baseline at both of
   * those call sites, BEFORE the send (`sendKey` :6828, the `tl-input` arm
   * :9388), and without it a soft arrow or Esc tap silently desyncs the field
   * from the pty line it claims to mirror.
   */
  it("drops the field when the soft keys send through the bridge", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    expect(window.__tlSendToTerminal?.("\x1b[A")).toBe(true);
    expect(m.mirror().value).toBe("");
    // And the reset came first, so the key still reached the pty.
    expect(onWire(m)).toEqual(["ls", "\x1b[A"]);
  });

  /**
   * A FRESH ATTACH IS OUT OF BAND (term.html:10293, in the socket's own
   * `onopen`, one line ahead of the coast cancel). A (re)attach starts a fresh
   * pty input line, and the order matters for the offline-Enter flow: the reset
   * lands before the hold is replayed (:10342), so the pty comes back holding a
   * line whose baseline says empty, which is the state `backspace-at-empty`
   * exists for.
   */
  it("drops the field when a socket attaches", async () => {
    const m = await onPhone({ open: false });
    edit(m.mirror(), "ls");
    m.socket().accept();
    await settle();
    expect(m.mirror().value).toBe("");
  });

  /**
   * AN ASK IS NOT AN ATTACH, and this is the one field write in the component
   * that a person can be standing in the middle of.
   *
   * `mirrorLineReset` appears at ten sites in term.html and `reportConnNow`
   * (:9822-9824) is none of them, so the ADR-0016 Run check and a session view
   * coming back on screen leave the field alone there. Hanging the reset off
   * `onPhase("open")` did not: `reportNow` re-fires that phase for the SAME
   * socket, and SessionView asks on every return to the screen
   * (SessionView.tsx:292, inside an effect gated on `onScreen()`), so the field
   * was blanked mid-word by ordinary navigation. mirror.ts:56-63 says what
   * goes with such a write: a live QuickType or Gboard suggestion.
   *
   * The baseline has to survive too, not just the text, or the next keystroke
   * re-sends the whole line.
   */
  it("keeps the field through a connection ask, which is not a new socket", async () => {
    const m = await onPhone();
    edit(m.mirror(), "ls");
    m.control().ask();
    expect(m.reports.at(-1)).toEqual({ state: "open", attempt: 0 });
    expect(m.mirror().value).toBe("ls");
    edit(m.mirror(), "ls -la");
    expect(emitted(m)).toEqual(["ls", " -la"]);
  });

  /**
   * A word jump is NOT a reset site: term.html sends it through `sendInput`
   * bare (:8550), and none of its ten `mirrorLineReset` call sites is it
   * (:6828, :7301, :8342, :8922, :8963, :9004, :9126, :9388, :9689, :10293).
   */
  it("keeps the field through a word jump, which the page does not reset for", async () => {
    const had = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      const m = await onPhone();
      edit(m.mirror(), "ls");
      const handler = m.term.keyHandler;
      if (!handler) throw new Error("no custom key event handler was installed");
      handler(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          code: "ArrowLeft",
          altKey: true,
          cancelable: true,
        }),
      );
      expect(m.mirror().value).toBe("ls");
      expect(onWire(m)).toEqual(["ls", "\x1bb"]);
    } finally {
      if (had) Object.defineProperty(navigator, "platform", had);
    }
  });

  /** The field's listeners come off with the terminal. */
  it("stops mirroring once the terminal is unmounted", async () => {
    const m = await onPhone();
    const field = m.mirror();
    m.unmount();
    await settle();
    edit(field, "ls");
    expect(emitted(m)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 17. The compose bar's height comes out of the terminal (term.html:8461-8467)
 * ------------------------------------------------------------------ */

/**
 * THE CONFLICT BETWEEN TWO MODULES' OWES LISTS, settled here.
 *
 * viewport.ts says "nothing sits over the terminal's box, so there is nothing
 * to subtract", which was true of this tree until section 16 mounted a bar over
 * it. term.html measures the bar's own live `offsetHeight` (`cbH`, :8461), takes
 * it off the terminal (:8467) and re-runs the whole calculation when the bar's
 * height changes (`growAndRefit` :7156-7165, which reaches `syncViewport`
 * through `refit`'s rAF at :8472-8476). Wire the two lists as written and the
 * bar covers rows nothing reserved for.
 *
 * WHAT jsdom CANNOT DO is lay any of this out, so the two heights are modelled
 * as functions of what the component itself writes. That makes the
 * before/after comparison inside the autogrow mean something; whether the rows
 * really clear the bar on a phone is a device claim.
 */
describe("the compose bar's height comes out of the terminal (term.html:8461-8467)", () => {
  const height = (m: Mounted): string => m.term.host?.style.height ?? "(no host)";

  let restorePointer: (() => void) | null = null;

  /** A phone with the keyboard up, which is where the height write is gated. */
  const asPhone = (covers: number): void => {
    restorePointer = fakePointer(true);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: window.innerHeight - covers,
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    });
  };

  afterEach(() => {
    restorePointer?.();
    restorePointer = null;
    Reflect.deleteProperty(window, "visualViewport");
  });

  /** One line of the field, and the padding the bar keeps around it. */
  const LINE_PX = 22;
  const BAR_PAD_PX = 12;
  /**
   * Where the field wraps, in characters. WRAPPING is the only way the bar can
   * grow: a newline in the value is Enter (`enterkeyhint` is fixed at 'send'),
   * so the mirror submits and clears rather than ever holding two lines. That
   * is what term.html's autogrow-to-five-lines is for.
   */
  const WRAP_AT = 10;
  const lines = (value: string): number => Math.max(1, Math.ceil(value.length / WRAP_AT));

  /**
   * `scrollHeight` off the value's line count, which is what a real textarea
   * reports once its inline height is `auto`; and the bar's `offsetHeight` off
   * the height the autogrow then writes, plus its own padding.
   *
   * The field's own line-height, padding and border are flattened first, and
   * that is jsdom's fault rather than a shortcut: `getComputedStyle` there
   * returns the SPECIFIED `line-height: 1.3` instead of a browser's resolved
   * "20.8px", so `parseFloat` reads 1.3 and the five-line clamp comes out at 24
   * pixels, under one line, which makes every height identical and every
   * assertion below meaningless. So the clamp arithmetic is not exercised here
   * at all (it is term.html's own, :7143-7155); what these cases pin is the
   * CHAIN, that a change in the bar's height reaches the terminal's reserve.
   */
  const layOut = (m: Mounted): HTMLTextAreaElement => {
    const field = m.mirror();
    field.style.lineHeight = `${LINE_PX}px`;
    field.style.padding = "0";
    field.style.border = "0";
    Object.defineProperty(field, "scrollHeight", {
      configurable: true,
      get: () => LINE_PX * lines(field.value),
    });
    Object.defineProperty(m.bar(), "offsetHeight", {
      configurable: true,
      get: () => (parseFloat(field.style.height) || 0) + BAR_PAD_PX,
    });
    return field;
  };

  const type = (field: HTMLTextAreaElement, value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /**
   * The painted bar takes its own height off the terminal, on top of the
   * keyboard's. Both terms in one string, because they are one box.
   */
  it("reserves the bar's height as well as the keyboard's", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    asPhone(300);
    const m = await mountOpen();
    const field = layOut(m);
    expect(height(m)).toBe("calc(100% - 300px)"); // the keyboard alone, so far
    type(field, "ls");
    expect(height(m)).toBe(`calc(100% - ${300 + LINE_PX + BAR_PAD_PX}px)`);
  });

  /**
   * A LINE ADDED TO THE FIELD gives the terminal one fewer row, with the
   * keyboard's own reserve unmoved. This is the case viewport.ts's dedupe
   * cannot answer on its own: the reserve it tracks did not change, so it says
   * `nothing`, and a wiring that took that literally would leave the taller bar
   * over rows the terminal still thinks it has.
   */
  it("rewrites the height when only the bar grew", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    asPhone(300);
    const m = await mountOpen();
    const field = layOut(m);
    type(field, "ls");
    const one = height(m);
    type(field, "ls -la /var/log"); // 15 chars: two wrapped lines
    expect(height(m)).not.toBe(one);
    expect(height(m)).toBe(`calc(100% - ${300 + 2 * LINE_PX + BAR_PAD_PX}px)`);
  });

  /** And gives them back when the line goes away again. */
  it("gives the row back when the bar shrinks", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    asPhone(300);
    const m = await mountOpen();
    const field = layOut(m);
    type(field, "ls -la /var/log");
    type(field, "ls");
    expect(height(m)).toBe(`calc(100% - ${300 + LINE_PX + BAR_PAD_PX}px)`);
  });

  /**
   * ONE FIT FOR A TYPING BURST, never one per keystroke: the height write is
   * immediate but the tmux resize behind it is the same debounce every other
   * trigger goes through (term.html:8390-8393, and the page's own
   * "a typing burst costs ONE fit" at :7156-7159).
   */
  it("costs one fit for a burst, not one per keystroke", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    asPhone(300);
    const m = await mountOpen();
    const field = layOut(m);
    const before = m.fit.fits;
    type(field, "l");
    type(field, "ls");
    type(field, "ls -la /va");
    type(field, "ls -la /var/log");
    expect(m.fit.fits).toBe(before);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await settle();
    expect(m.fit.fits).toBe(before + 1);
  });

  /**
   * A GHOST BAR IS HEIGHT 0, which is term.html's own exception at :8461
   * (`!cb.classList.contains('ghost')`) and the whole point of that render: the
   * terminal RECLAIMS the bar's space. Its field still has a real
   * `offsetHeight`, because a zero-size field can fail to summon the iOS
   * keyboard, so the read has to be about the posture rather than the pixels.
   */
  it("reserves nothing for the default ghost posture", async () => {
    asPhone(300);
    const m = await mountOpen();
    const field = layOut(m);
    type(field, "ls -la /var/log");
    expect(height(m)).toBe("calc(100% - 300px)");
    // The field really did grow; it is the BAR that reserves nothing.
    expect(field.style.height).toBe(`${2 * LINE_PX}px`);
  });

  /**
   * AND IT RIDES THE SAME TWO GATES AS THE KEYBOARD'S OWN RESERVE, because
   * term.html's height write is one expression with `cbH` inside it: the
   * `if (isCoarsePointer)` at :8441, and the `if (!window.visualViewport)
   * return` at :8428 above it. A machine behind either gate gets no inline
   * height at all, which is what the page writes there: nothing.
   */
  it("writes no height where the page writes none", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ input: { bar: "on" } }));
    restorePointer = fakePointer(true); // coarse, but no visualViewport
    const m = await mountOpen();
    const field = layOut(m);
    type(field, "ls -la /var/log");
    expect(height(m)).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * 18. Attention (term.html:5676-5781, the output site at :10384-10392)
 * ------------------------------------------------------------------ */

/**
 * The two things this terminal knows that could be news: the pty rang, and
 * output arrived while nobody could see it. `attention.ts` decides; the lobby
 * paints. What this file adds is that the three events reach the module at all
 * and that the signal reaches the prop, because a hub that never dispatches
 * leaves a green module suite over a terminal that never reports anything.
 *
 * The tab's visibility is an INPUT on every event rather than state, and two of
 * the cases below are here because a stored flag passes the module's own tests
 * and fails these: the browser flips `document.hidden` and QUEUES the event, so
 * a frame processed inside that window is judged on the old value.
 */
describe("attention (term.html:5676-5781)", () => {
  /** `document.hidden`, which jsdom answers from its own visibility state. */
  const fakeHidden = (hidden: () => boolean): (() => void) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: hidden });
    return () => void Reflect.deleteProperty(document, "hidden");
  };

  let restoreHidden: (() => void) | null = null;
  let hidden = false;

  beforeEach(() => {
    hidden = false;
    restoreHidden = fakeHidden(() => hidden);
  });

  afterEach(() => {
    restoreHidden?.();
    restoreHidden = null;
  });

  /** xterm's parser seeing BEL. */
  const ring = (m: Mounted): void => {
    if (m.term.bellCbs.length === 0) throw new Error("no onBell handler was installed");
    for (const cb of m.term.bellCbs) cb();
  };

  /** One frame of pty output, which is the only frame type that is news. */
  const output = (m: Mounted): void => m.socket().deliver([0x30, 0x68, 0x69]);

  /** The tab flipping, as the browser delivers it: a queued event after the flag. */
  const flipTab = (to: boolean): void => {
    hidden = to;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  /**
   * THE BELL IS UNGATED. `term.onBell(() => signalAttention('bell'))`
   * (term.html:5772), with no visibility test on that path anywhere in the
   * page. The "you are already looking at it" rule belongs to the lobby, whose
   * version is WIDER, latching while `document.hidden || !document.hasFocus()`
   * (`notify/attention.ts`), so gating it here would silence a ring in a
   * visible but unfocused tab, which is exactly what that latch is for.
   */
  it("reports a bell with the terminal on screen in a visible tab", async () => {
    const m = await mountOpen({ active: true });
    ring(m);
    expect(m.attention).toEqual(["bell"]);
  });

  /** And it is not a one-shot: three rings are three pieces of news. */
  it("reports every ring", async () => {
    const m = await mountOpen({ active: false });
    ring(m);
    ring(m);
    ring(m);
    expect(m.attention).toEqual(["bell", "bell", "bell"]);
  });

  /** Output nobody missed is not news: the terminal is right there. */
  it("says nothing about output while the terminal is on screen", async () => {
    const m = await mountOpen({ active: true });
    output(m);
    expect(m.attention).toEqual([]);
    // And the bytes still reached xterm.
    expect(m.term.written).toHaveLength(1);
  });

  /**
   * "NOBODY IS LOOKING" IS BIGGER THAN THE TAB: the lobby keeps every visited
   * session mounted and CSS-hides the ones you are not looking at, and does the
   * same to the terminal while its text view shows. `active` is the negation of
   * attention.ts's `view`, and this is the case that needs it, because the tab
   * is wide open.
   */
  it("reports output arriving behind a hidden view", async () => {
    const m = await mountOpen({ active: false });
    output(m);
    expect(m.attention).toEqual(["output"]);
  });

  /** Ten frames behind a hidden view are ONE piece of news (the one-shot). */
  it("reports the first output of a hidden period and no more", async () => {
    const m = await mountOpen({ active: false });
    output(m);
    output(m);
    output(m);
    expect(m.attention).toEqual(["output"]);
  });

  /**
   * A SOLID EFFECT ON `active` FIRES ON MOUNT, and that first event is the
   * native counterpart of the lobby re-posting `tl-view` on every attach: it is
   * what tells a session mounted OFF screen that nobody is looking. Without it
   * this terminal would start from "the view is showing" and stay silent until
   * the view moved.
   */
  it("knows nobody is looking at a session that mounted off screen", async () => {
    const m = await mountOpen({ active: false });
    expect(m.attention).toEqual([]); // nothing has happened yet
    output(m);
    expect(m.attention).toEqual(["output"]);
  });

  /** The view coming back and going away again opens a new period. */
  it("reports again after the view came back", async () => {
    const m = await mountOpen({ active: false });
    output(m);
    m.setActive(true);
    m.setActive(false);
    output(m);
    expect(m.attention).toEqual(["output", "output"]);
  });

  /**
   * THE TAB'S VISIBILITY IS READ LIVE, and this case is the reason. The flag is
   * flipped WITHOUT the event, which is the window the browser really leaves: a
   * socket message task queued before the visibilitychange task runs first. A
   * component that stored the flag from the listener would answer "visible"
   * here, signal nothing, and then stay silent for the whole hidden period,
   * because the `tab` event arriving next would find nothing latched to re-arm.
   */
  it("judges an output frame on the flag as it stands, not on the last event", async () => {
    const m = await mountOpen({ active: true });
    hidden = true; // no visibilitychange yet: the event is still queued
    output(m);
    expect(m.attention).toEqual(["output"]);
  });

  /**
   * THE RE-ARM, which is the visibilitychange listener's only job, in BOTH
   * directions (:5773-5781). The tab coming back closes the period; going away
   * again opens a new one.
   */
  it("opens a new period when the tab comes back and leaves again", async () => {
    const m = await mountOpen({ active: true });
    flipTab(true);
    output(m);
    output(m);
    expect(m.attention).toEqual(["output"]);
    flipTab(false);
    flipTab(true);
    output(m);
    expect(m.attention).toEqual(["output", "output"]);
  });

  /**
   * THE ONE-SHOT REMEMBERS WHICH REASONS SPENT IT, which is the rule nobody
   * guesses and the one that needs the listener to be wired at all. A shot
   * burned while only the VIEW was hidden was dropped on arrival by the lobby
   * (whose latch needs the tab to be away), so it must not silence the first
   * output of the away period that follows.
   */
  it("does not let a view-hidden signal silence the away period after it", async () => {
    const m = await mountOpen({ active: false });
    output(m); // spent with the view hidden and the tab wide open
    expect(m.attention).toEqual(["output"]);
    flipTab(true); // a reason that was NOT true when the shot was spent
    output(m);
    expect(m.attention).toEqual(["output", "output"]);
  });

  /**
   * THE OUTPUT SIGNAL COMES FIRST WITHIN ONE FRAME, which is why the dispatch
   * sits ahead of `term.write`: the page calls `noteHiddenOutput()` at :10388
   * and writes at :10391-10392, so a BEL inside that same frame reaches
   * `onBell` after the output signal. The fake rings from inside `write`, which
   * is where a real parser would.
   */
  it("signals output before the bell a frame carries", async () => {
    const m = await mountOpen({ active: false });
    m.term.write = (): void => {
      for (const cb of m.term.bellCbs) cb();
    };
    output(m);
    expect(m.attention).toEqual(["output", "bell"]);
  });
});

/* ------------------------------------------------------------------ *
 * 19. Two fingers set the font size (term.html:7758-7965)
 * ------------------------------------------------------------------ */

/**
 * `terminal/font.ts` has held this gesture's whole arithmetic since pass 1 and
 * had never been called: the classification, the 7%-per-step ladder, the
 * page-scale gate and both front-end contracts were green against nothing. So
 * what is checked here is the wiring — which listeners exist, on which node,
 * with which options, what a decision is turned into, and which of the two
 * front ends answered.
 *
 * WHAT THESE CANNOT REACH, and where it is settled instead. jsdom has no
 * layout, no touch hardware, no GestureEvent and no vibration motor, so a real
 * two-finger pinch changing real glyph sizes is a device claim and belongs on
 * the shared Android emulator (Chromium) and a real iPad (WebKit, for which
 * this homelab has no instrument at all). `navigator.vibrate` is faked here, so
 * what is under test is that the call is made under the same rule term.html
 * makes it under, not that anything buzzed. And `term.options.fontSize` is
 * recorded by the fake rather than measured off a canvas: the cell metrics that
 * would prove a size change are exactly what jsdom does not have.
 */
describe("pinch to font size (term.html:7758-7965)", () => {
  /** Two fingers this far apart, along x, centred on the same y. */
  const SPAN0 = 100;
  /** The default size every case starts from (`PREF_DEFAULTS.fontSize`). */
  const BASE = 15;

  interface Finger {
    id: number;
    x: number;
    y: number;
    /** Overridden only by the off-surface case. */
    target?: EventTarget;
  }

  /**
   * One touch event for the PINCH recognizer, which reads three fields the
   * touch scroller's `touchEvent` above does not: both coordinates, the
   * `identifier` that ties a gesture to its two fingers, and the per-touch
   * `target` the hit test reads.
   *
   * `cancelable` is the event's own flag and it carries the claim: font.ts
   * refuses to consume a non-cancelable move, so the "native already owns this
   * stream" arm can only be reached with one built `cancelable: false`.
   */
  function pinchEvent(
    type: string,
    fingers: readonly Finger[],
    target: EventTarget,
    cancelable = true,
  ): Event {
    const e = new Event(type, { bubbles: true, cancelable });
    Object.defineProperty(e, "touches", {
      value: fingers.map((f) => ({
        identifier: f.id,
        clientX: f.x,
        clientY: f.y,
        target: f.target ?? target,
      })),
    });
    return e;
  }

  /** Two fingers `span` apart. */
  const twoAt = (span: number, target?: EventTarget): Finger[] => [
    { id: 1, x: 100, y: 200, target },
    { id: 2, x: 100 + span, y: 200, target },
  ];

  const hostOf = (m: Mounted): HTMLElement => {
    const el = m.term.host;
    if (!el) throw new Error("the terminal was never opened");
    return el;
  };

  /**
   * A pinch: one finger down, a second landing `SPAN0` away — which is the
   * event that arms the gesture — then one two-finger move per span given.
   *
   * The move events come back so a case can read `defaultPrevented` off them,
   * because on the Chromium front end that consumption IS the claim.
   */
  function pinch(
    m: Mounted,
    spans: readonly number[],
    opts: { cancelable?: boolean; span0?: number; onSurface?: boolean } = {},
  ): Event[] {
    const host = hostOf(m);
    const target = opts.onSurface === false ? document.body : host;
    const first = twoAt(0, target)[0];
    if (!first) throw new Error("unreachable");
    host.dispatchEvent(pinchEvent("touchstart", [first], target));
    host.dispatchEvent(
      pinchEvent("touchstart", twoAt(opts.span0 ?? SPAN0, target), target),
    );
    const moves: Event[] = [];
    for (const span of spans) {
      const e = pinchEvent("touchmove", twoAt(span, target), target, opts.cancelable);
      host.dispatchEvent(e);
      moves.push(e);
    }
    return moves;
  }

  /** Both fingers up, which is what ends a gesture and fades the readout. */
  const lift = (m: Mounted): void => {
    hostOf(m).dispatchEvent(pinchEvent("touchend", [], hostOf(m)));
  };

  /** The spans that put a claimed gesture at `ratio`, given SPAN0. */
  const at = (ratio: number): number => SPAN0 * ratio;

  /**
   * The three moves a Chromium claim costs: two below the classify threshold at
   * a constant span, then the one that both classifies and steps. Every span is
   * the same ratio, so the classification is decided by the MOVE COUNT and the
   * step by the ratio, which is the shape font.ts describes.
   */
  const claimAt = (ratio: number): number[] => [at(ratio), at(ratio), at(ratio)];

  /**
   * A WebKit GestureEvent, whose `scale` is already the cumulative span ratio.
   * `GestureEvent` does not exist in jsdom (or in Chromium), which is the whole
   * reason the component reads `scale` off a plain Event.
   */
  function gestureEvent(type: string, scale: number, cancelable = true): Event {
    const e = new Event(type, { bubbles: true, cancelable });
    Object.defineProperty(e, "scale", { value: scale });
    return e;
  }

  /** A whole WebKit pinch: start, one change per scale, then the end. */
  function gesture(m: Mounted, scales: readonly number[]): Event[] {
    const host = hostOf(m);
    const events = [gestureEvent("gesturestart", 1)];
    for (const s of scales) events.push(gestureEvent("gesturechange", s));
    for (const e of events) host.dispatchEvent(e);
    return events;
  }

  /** Every document listener registered while this is installed. */
  interface Registered {
    type: string;
    capture: boolean;
    passive: boolean;
  }
  function watchDocListeners(): { seen: Registered[]; restore: () => void } {
    const real = document.addEventListener.bind(document);
    const seen: Registered[] = [];
    const spy = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      const bag = typeof options === "object" && options !== null ? options : {};
      seen.push({
        type,
        capture: options === true || bag.capture === true,
        passive: bag.passive === true,
      });
      real(type, listener, options);
    };
    document.addEventListener = spy as typeof document.addEventListener;
    return {
      seen,
      restore: () => {
        document.addEventListener = real as typeof document.addEventListener;
      },
    };
  }

  /** The pinch's own listener types, in the order they went on. */
  const pinchTypes = (seen: readonly Registered[]): string[] =>
    seen
      .filter((r) =>
        ["touchstart", "touchmove", "touchend", "touchcancel", "gesturestart", "gesturechange", "gestureend"].includes(
          r.type,
        ),
      )
      .map((r) => r.type);

  let restorePointer: (() => void) | null = null;
  let listeners: { seen: Registered[]; restore: () => void } | null = null;
  /** Every `navigator.vibrate` pattern the component asked for, in order. */
  let buzzes: (number | number[])[] = [];

  beforeEach(() => {
    buzzes = [];
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: number | number[]): boolean => {
        buzzes.push(pattern);
        return true;
      },
    });
  });

  afterEach(() => {
    restorePointer?.();
    restorePointer = null;
    listeners?.restore();
    listeners = null;
    Reflect.deleteProperty(navigator, "vibrate");
    Reflect.deleteProperty(window, "visualViewport");
  });

  /** A phone: the coarse-pointer gate open, which is where the pinch exists. */
  async function onTouch(): Promise<Mounted> {
    restorePointer = fakePointer(true);
    return mountOpen();
  }

  /** `visualViewport.scale`, which is the page's own pinch-zoom level. */
  const withPageScale = (scale: number): void => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        scale,
        // The layout height exactly, so this fake says nothing about a soft
        // keyboard — that reserve is section 8's claim, not this one's.
        height: window.innerHeight,
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    });
  };

  /**
   * THE GATE, which is the coarse-pointer one: term.html's whole pinch block
   * sits inside `if (isCoarsePointer)` (:6478 to :7966), so a mouse gets no
   * recognizer at all and a touchscreen laptop keeps native two-finger zoom.
   */
  it("registers nothing where the primary pointer is not a finger", async () => {
    restorePointer = fakePointer(false);
    listeners = watchDocListeners();
    const m = await mountOpen();
    expect(pinchTypes(listeners.seen)).toEqual([]);
    pinch(m, claimAt(1.3));
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * BOTH FRONT ENDS ARE REGISTERED, which is the one deliberate divergence from
   * term.html: that page picks by user-agent sniff (:3256-3258) and registers
   * one set. Neither sniff matches jsdom, so under one nothing here would be
   * reachable by a test at all — and a UA string is a guess about an engine,
   * where the arriving event is the engine answering for itself.
   *
   * The OPTIONS are part of the claim. The standing three are capture+passive
   * because a standing non-passive touch listener taxes every one-finger
   * scroll's latency (term.html:6381-6400); the GestureEvent three are
   * non-passive because `preventDefault` at `gesturestart` IS the claim there.
   */
  it("registers the standing touch trio and the GestureEvent trio", async () => {
    restorePointer = fakePointer(true);
    listeners = watchDocListeners();
    await mountOpen();
    const pinchOnes = listeners.seen.filter((r) =>
      ["touchstart", "touchend", "touchcancel", "gesturestart", "gesturechange", "gestureend"].includes(r.type),
    );
    expect(pinchOnes).toEqual([
      { type: "touchstart", capture: true, passive: true },
      { type: "touchend", capture: true, passive: true },
      { type: "touchcancel", capture: true, passive: true },
      { type: "gesturestart", capture: false, passive: false },
      { type: "gesturechange", capture: false, passive: false },
      { type: "gestureend", capture: false, passive: false },
    ]);
  });

  /**
   * THE BLOCKING LISTENER IS LAZY, which the page's registry calls
   * probe-validated and not negotiable (:6381-6400): the non-passive touchmove
   * goes on when the second finger lands (:6426) and comes off at the last lift
   * (:6434), so a one-finger sequence traverses zero blocking listeners.
   */
  it("attaches the non-passive touchmove only while two fingers are down", async () => {
    restorePointer = fakePointer(true);
    listeners = watchDocListeners();
    const m = await mountOpen();
    const host = hostOf(m);
    expect(pinchTypes(listeners.seen)).not.toContain("touchmove");

    const one = twoAt(0)[0];
    if (!one) throw new Error("unreachable");
    host.dispatchEvent(pinchEvent("touchstart", [one], host));
    expect(pinchTypes(listeners.seen)).not.toContain("touchmove");

    host.dispatchEvent(pinchEvent("touchstart", twoAt(SPAN0), host));
    expect(listeners.seen.filter((r) => r.type === "touchmove")).toEqual([
      { type: "touchmove", capture: true, passive: false },
    ]);

    // The last lift takes it off, and a later two-finger start puts one back —
    // one registration, not two, because the attach is idempotent.
    host.dispatchEvent(pinchEvent("touchend", [], host));
    host.dispatchEvent(pinchEvent("touchstart", twoAt(SPAN0), host));
    host.dispatchEvent(pinchEvent("touchstart", twoAt(SPAN0), host));
    expect(listeners.seen.filter((r) => r.type === "touchmove")).toHaveLength(2);
  });

  /**
   * THE CLAIM IS THE CONSUMPTION, from move 1, with the pinch-or-pan question
   * deferred to move 3. Chrome's cancelable-touchmove window is only ~1-3
   * moves, so a recognizer that waited to be sure before claiming would find
   * the stream already committed to native scrolling — the 2026-07-11
   * measurement font.ts refuses to let anyone simplify away.
   */
  it("consumes every two-finger move from the first, before it has classified", async () => {
    const m = await onTouch();
    const moves = pinch(m, [at(1), at(1)]);
    expect(moves.map((e) => e.defaultPrevented)).toEqual([true, true]);
    // Nothing has been claimed yet, so nothing has been applied either.
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * A SPAN HELD CONSTANT IS A TWO-FINGER PAN, released at the classify move so
   * native scrolling resumes. The release costs the ~7.5px of centroid travel
   * the classification consumed, which the page declares rather than hides.
   */
  it("releases a two-finger pan at the classify move and never claims again", async () => {
    const m = await onTouch();
    const moves = pinch(m, [at(1), at(1), at(1), at(1.3), at(1.3)]);
    // Moves 1-3 were consumed (3 is the release itself); 4 and 5 are native's.
    expect(moves.map((e) => e.defaultPrevented)).toEqual([true, true, true, false, false]);
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * THE LADDER: one step per 7% of span, truncated toward zero so the size
   * changes only once the fingers have travelled a whole step.
   *
   * The 0.93 row is font.ts's documented asymmetry rather than an oddity worth
   * fixing: `(0.93 − 1) / 0.07` is −0.9999999999999992 in binary floating
   * point, so a pinch IN by the same fraction that steps OUT does not step.
   * term.html carries the identical expression and the identical edge, and
   * matching it is the point.
   */
  it.each([
    [1.07, 16],
    [1.15, 17],
    [1.3, 19],
    [0.93, 15],
    [0.86, 13],
  ])("a claimed pinch to ratio %s puts the size at %i", async (ratio, size) => {
    const m = await onTouch();
    pinch(m, claimAt(ratio));
    expect(m.term.options.fontSize).toBe(size);
  });

  /**
   * A STEP FITS AT ONCE, and this is the one place the debounce would be wrong:
   * fit.ts's owes list names `applyTermPrefs` (:9186-9189) among the four
   * triggers that fit immediately, because the page masks the burst rather than
   * thinning it. The pty hears the new geometry in the same tick.
   */
  it("fits and resizes the pty on the step rather than 120ms later", async () => {
    const m = await onTouch();
    const before = m.fit.fits;
    const sent = resizes(m.socket()).length;
    pinch(m, claimAt(1.3));
    expect(m.fit.fits).toBe(before + 1);
    expect(resizes(m.socket()).length).toBe(sent + 1);
  });

  /**
   * THE READOUT, which is term.html's `#font-pill` (:7825-7843) drawn with this
   * app's own `.tl-size-pill` — the same pill the text view's pinch uses, so
   * the two gestures read identically. It appears with the claim and goes 220ms
   * after the fingers lift, not on the lift itself.
   */
  it("shows the size it reached and takes it away 220ms after the lift", async () => {
    const m = await onTouch();
    expect(m.pill()).toBeNull();
    pinch(m, claimAt(1.15));
    expect(m.pill()?.textContent).toBe("Aa 17px");
    lift(m);
    // Still there: the fade is delayed, so a lift between two pinches does not
    // flash the pill off and on.
    expect(m.pill()?.textContent).toBe("Aa 17px");
    vi.advanceTimersByTime(FONT_READOUT_HIDE_MS);
    expect(m.pill()).toBeNull();
  });

  /**
   * A STEP INSIDE THE HIDE WINDOW CANCELS IT, which is `showFontPill` clearing
   * the timer (:7832-7833). Without it a second pinch would draw a pill that
   * the first one's timer takes away underneath it.
   */
  it("keeps the readout when a second pinch starts inside the hide window", async () => {
    const m = await onTouch();
    pinch(m, claimAt(1.15));
    lift(m);
    vi.advanceTimersByTime(FONT_READOUT_HIDE_MS - 20);
    pinch(m, claimAt(1.15));
    vi.advanceTimersByTime(FONT_READOUT_HIDE_MS - 20);
    expect(m.pill()).not.toBeNull();
  });

  /**
   * THE HAPTIC IS PER COMMITTED STEP (term.html:9225, the `selection` grade at
   * :3278-3282). Two applies inside one gesture buzz twice; a target the size
   * is already at buzzes not at all, which is what keeps a pinch held against
   * the 22px ceiling from ticking against the wall.
   */
  it("buzzes once per committed step and goes quiet at the ceiling", async () => {
    const m = await onTouch();
    // 1.15 -> 17, then 1.3 -> 19: two committed steps inside one gesture.
    pinch(m, [...claimAt(1.15), at(1.3)]);
    expect(buzzes).toEqual([5, 5]);
    lift(m);
    // Far past the ceiling, then further still: one step to 22 and silence.
    pinch(m, [...claimAt(3), at(4)]);
    expect(m.term.options.fontSize).toBe(22);
    expect(buzzes).toEqual([5, 5, 5]);
  });

  /**
   * The roamed `gestures.haptics` flag, which term.html reads live inside
   * `haptic()` (:3283-3287) rather than at boot. It is not in `coercePrefs`'
   * typed view — prefs.ts carries the seven touch flags through untouched — so
   * the component reads it off the raw document, and this is what says so.
   */
  it("makes no vibration call when the roamed haptics flag is off", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { haptics: false } }));
    const m = await onTouch();
    pinch(m, claimAt(1.15));
    expect(m.term.options.fontSize).toBe(17);
    expect(buzzes).toEqual([]);
  });

  /**
   * THE SIZE PERSISTS, the way `setPrefs` persists one (:2997-3018): the roamed
   * document, the legacy device key the A−/A+ stepper has always written
   * (`setFontSize`, :2682-2684), and the dirty marker that makes the next boot
   * push this doc up instead of adopting the server's.
   */
  it("writes the roamed doc, the legacy key and the dirty marker", async () => {
    const m = await onTouch();
    pinch(m, claimAt(1.15));
    const doc: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    expect(doc).toMatchObject({ fontSize: 17 });
    expect(localStorage.getItem(FONT_SIZE_KEY)).toBe("17");
    expect(localStorage.getItem(PREFS_DIRTY_KEY)).not.toBeNull();
  });

  /**
   * A WRITE KEEPS WHAT THIS SIDE DOES NOT TYPE, because it goes through the
   * store's own `composeDoc`: the six other touch flags, `input.bar`, and
   * anything a newer build put in the document. Losing them here would turn
   * off long-press and the input bar on every device that pinched.
   */
  it("leaves the subkeys this side does not type alone", async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ gestures: { keyRepeat: false, haptics: true }, input: { bar: "on" } }),
    );
    const m = await onTouch();
    pinch(m, claimAt(1.15));
    const doc: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    expect(doc).toMatchObject({
      fontSize: 17,
      gestures: { keyRepeat: false, haptics: true },
      input: { bar: "on" },
    });
  });

  /**
   * THE BASE IS THE SIZE ON SCREEN, so a second gesture steps from where the
   * first one left off rather than from the size the terminal booted at.
   */
  it("steps the second gesture from the size the first one reached", async () => {
    const m = await onTouch();
    pinch(m, claimAt(1.07));
    lift(m);
    pinch(m, claimAt(1.07));
    expect(m.term.options.fontSize).toBe(BASE + 2);
  });

  /**
   * A PINCH ON AN ALREADY-ZOOMED PAGE BELONGS TO THE BROWSER. Claiming it there
   * takes away the only gesture that zooms back out, which is why font.ts calls
   * this its standing regression guard. Nothing is consumed, so native pinch
   * survives.
   */
  it("stands down while the page itself is zoomed", async () => {
    withPageScale(1.5);
    const m = await onTouch();
    const moves = pinch(m, claimAt(1.3));
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /** A viewport reporting 1 with float noise is not a zoomed page. */
  it("claims at a page scale of 1 reported with float noise", async () => {
    withPageScale(1.0009);
    const m = await onTouch();
    pinch(m, claimAt(1.3));
    expect(m.term.options.fontSize).toBe(19);
  });

  /**
   * FINGERS OFF THE TERMINAL ARE NOT THIS TERMINAL'S GESTURE. The listeners are
   * on the document, where the page puts them (:6445-6450), so the hit test is
   * the whole of what scopes them — and the lobby keeps every visited session
   * mounted, so a hidden terminal's recognizer is listening too.
   */
  it("ignores a pinch whose fingers did not land on the terminal", async () => {
    const m = await onTouch();
    const moves = pinch(m, claimAt(1.3), { onSurface: false });
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * THE DEVICE FLAG (`tl:gesture-pinch-font:v1`, :3181-3184), default ON and
   * read per gesture: `"off"` stands the recognizer down while leaving native
   * pinch-zoom intact.
   */
  it("stands down when the device flag is off, and comes back when it is not", async () => {
    localStorage.setItem("tl:gesture-pinch-font:v1", "off");
    const m = await onTouch();
    pinch(m, claimAt(1.3));
    expect(m.term.options.fontSize).toBe(BASE);
    lift(m);
    // Read per gesture, so a flip needs no reload.
    localStorage.setItem("tl:gesture-pinch-font:v1", "on");
    pinch(m, claimAt(1.3));
    expect(m.term.options.fontSize).toBe(19);
  });

  /**
   * THE MASTER KILL also stops the blocking listener from being attached at
   * all, which is where the registry enforces it (:6425-6426). A device whose
   * gestures are killed pays nothing for this recognizer.
   */
  it("attaches no blocking listener while the gestures master kill is set", async () => {
    localStorage.setItem("tl-gestures", "off");
    restorePointer = fakePointer(true);
    listeners = watchDocListeners();
    const m = await mountOpen();
    pinch(m, claimAt(1.3));
    expect(pinchTypes(listeners.seen)).not.toContain("touchmove");
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * A THIRD FINGER ABORTS AND NEVER RESUMES, so a pinch cannot be finished with
   * a different pair than it started with. The lift of the third finger leaves
   * the gesture aborted rather than reviving it.
   */
  it("abandons a pinch a third finger joined", async () => {
    const m = await onTouch();
    const host = hostOf(m);
    const one = twoAt(0)[0];
    if (!one) throw new Error("unreachable");
    host.dispatchEvent(pinchEvent("touchstart", [one], host));
    host.dispatchEvent(pinchEvent("touchstart", twoAt(SPAN0), host));
    host.dispatchEvent(
      pinchEvent("touchstart", [...twoAt(SPAN0), { id: 3, x: 400, y: 200 }], host),
    );
    // Back to two fingers, then a real pinch: the gesture stays dead.
    host.dispatchEvent(pinchEvent("touchend", twoAt(SPAN0), host));
    for (const span of claimAt(1.3)) {
      host.dispatchEvent(pinchEvent("touchmove", twoAt(span), host));
    }
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * A NON-CANCELABLE MOVE MEANS NATIVE ALREADY OWNS THE STREAM — a finger
   * joining a scroll already in flight. term.html declares that leak rather
   * than fighting it: panic-zooming mid-scroll stays native, and nothing
   * preventDefaults an event where it would be a no-op plus a console warning.
   */
  it("hands a stream native already owns straight back", async () => {
    const m = await onTouch();
    const moves = pinch(m, claimAt(1.3), { cancelable: false });
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * WEBKIT'S FRONT END, where the GestureEvent IS the pinch signal: nothing to
   * classify, `scale` already the cumulative ratio, and the `preventDefault` at
   * `gesturestart` is what suppresses native pinch-zoom for the whole gesture.
   */
  it("steps the size from a GestureEvent scale and holds the claim", async () => {
    const m = await onTouch();
    const events = gesture(m, [1.15]);
    expect(events.map((e) => e.defaultPrevented)).toEqual([true, true]);
    expect(m.term.options.fontSize).toBe(17);
    expect(m.pill()?.textContent).toBe("Aa 17px");
    hostOf(m).dispatchEvent(gestureEvent("gestureend", 1.15));
    vi.advanceTimersByTime(FONT_READOUT_HIDE_MS);
    expect(m.pill()).toBeNull();
  });

  /**
   * THE 5% DEADZONE APPLIES ONLY UNTIL THE FIRST STEP LANDS. After that the
   * size follows the scale back through it, so a pinch out and back returns to
   * where it started instead of sticking at the far end.
   */
  it("follows the scale back through the deadzone once a step has landed", async () => {
    const m = await onTouch();
    gesture(m, [1.03]); // inside the deadzone: no step
    expect(m.term.options.fontSize).toBe(BASE);
    hostOf(m).dispatchEvent(gestureEvent("gesturechange", 1.15));
    expect(m.term.options.fontSize).toBe(17);
    hostOf(m).dispatchEvent(gestureEvent("gesturechange", 1.0));
    expect(m.term.options.fontSize).toBe(BASE);
  });

  /**
   * A THIRD FINGER FREEZES A WEBKIT GESTURE rather than releasing it, and that
   * difference from Chromium is not an inconsistency: a claimed WebKit gesture
   * cannot be released mid-flight without the page popping into native zoom, so
   * stepping stops and the claim is held to `gestureend`.
   */
  it("freezes a claimed WebKit gesture on a third finger, holding the claim", async () => {
    const m = await onTouch();
    const host = hostOf(m);
    gesture(m, [1.15]);
    expect(m.term.options.fontSize).toBe(17);
    // The finger count comes off the passive touch listeners, which is the only
    // way a GestureEvent can know about it.
    host.dispatchEvent(
      pinchEvent("touchstart", [...twoAt(SPAN0), { id: 3, x: 400, y: 200 }], host),
    );
    const change = gestureEvent("gesturechange", 1.5);
    host.dispatchEvent(change);
    expect(change.defaultPrevented).toBe(true);
    expect(m.term.options.fontSize).toBe(17);
  });

  /**
   * ONE ENGINE, ONE FRONT END. WebKit fires both a GestureEvent and the touch
   * events, so without this the two recognizers would step one pinch twice. The
   * arriving `gesturestart` is what decides, and it decides for good: the
   * blocking touchmove is not attached again either, so the platform that
   * cannot use it stops paying for it.
   */
  it("stands the touch front end down once a GestureEvent has arrived", async () => {
    restorePointer = fakePointer(true);
    listeners = watchDocListeners();
    const m = await mountOpen();
    const host = hostOf(m);
    gesture(m, [1.15]);
    host.dispatchEvent(gestureEvent("gestureend", 1.15));
    expect(m.term.options.fontSize).toBe(17);
    const attached = listeners.seen.filter((r) => r.type === "touchmove").length;

    const moves = pinch(m, claimAt(1.3));
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(m.term.options.fontSize).toBe(17);
    expect(listeners.seen.filter((r) => r.type === "touchmove")).toHaveLength(attached);
  });

  /**
   * THE REAL iOS ORDER, which is the sequence that would double-step the size
   * if the arbitration were missing: WebKit fires both streams, with
   * `gesturestart` landing after the second finger's `touchstart` and before
   * the first two-finger `touchmove`.
   *
   * So the gesture front end has to stand the touch one down when it arrives,
   * not only on the gestures after it: the touch recognizer is already armed by
   * then, from the same two fingers, and its own base and ratio would step the
   * size a second time from the same pinch.
   */
  it("lets only the gesture front end step a pinch WebKit reports twice", async () => {
    const m = await onTouch();
    const host = hostOf(m);
    const one = twoAt(0)[0];
    if (!one) throw new Error("unreachable");
    host.dispatchEvent(pinchEvent("touchstart", [one], host));
    host.dispatchEvent(pinchEvent("touchstart", twoAt(SPAN0), host));
    host.dispatchEvent(gestureEvent("gesturestart", 1));
    host.dispatchEvent(gestureEvent("gesturechange", 1.15));
    expect(m.term.options.fontSize).toBe(17);

    // The same fingers, spread far enough that the touch front end would
    // claim on its third move and step to 19 from its own base of 15.
    const moves = [at(1.3), at(1.3), at(1.3)].map((span) => {
      const e = pinchEvent("touchmove", twoAt(span), host);
      host.dispatchEvent(e);
      return e;
    });
    expect(moves.some((e) => e.defaultPrevented)).toBe(false);
    expect(m.term.options.fontSize).toBe(17);
  });

  /**
   * PAGEHIDE IS THE RESET, which is the registry's `resetAll` (:6439-6444) and
   * the one thing font.ts routes to `pinchReset` rather than to the end
   * handler: it drops the state and takes the readout away even mid-gesture.
   */
  it("drops a gesture in flight on pagehide", async () => {
    const m = await onTouch();
    pinch(m, claimAt(1.15));
    expect(m.pill()).not.toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(FONT_READOUT_HIDE_MS);
    expect(m.pill()).toBeNull();
    // The dropped gesture cannot go on stepping.
    for (const span of [at(1.3), at(1.3), at(1.3)]) {
      hostOf(m).dispatchEvent(pinchEvent("touchmove", twoAt(span), hostOf(m)));
    }
    expect(m.term.options.fontSize).toBe(17);
  });

  /**
   * THE LISTENERS COME OFF WITH THE COMPONENT. They are on the document, so
   * they outlive this terminal's own DOM: left behind, they would go on
   * hit-testing against a host nobody can see, and on a lobby that mounts and
   * unmounts sessions they would accumulate one recognizer per visit.
   */
  it("removes its document listeners on unmount", async () => {
    const m = await onTouch();
    const host = hostOf(m);
    m.unmount();
    // The host is detached now, so the hit test would refuse anyway; what is
    // under test is that nothing throws and nothing is applied.
    document.body.appendChild(host);
    pinch(m, claimAt(1.3));
    host.dispatchEvent(gestureEvent("gesturestart", 1));
    host.dispatchEvent(gestureEvent("gesturechange", 1.3));
    expect(m.term.options.fontSize).toBe(BASE);
    host.remove();
  });
});
