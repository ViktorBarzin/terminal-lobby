/**
 * THE DOCUMENT LISTENERS A MOUNTED TERMINAL LEAVES BEHIND, and what they cost
 * when nobody is looking at it.
 *
 * `TerminalNative` registers `mousedown`, `mousemove` and `mouseup` on the
 * document at capture, permanently, for the reason it gives at the site: xterm's
 * own handler sits on a descendant, so the drag interceptor has to be above it
 * in the tree to swallow a press. That is right for the terminal on screen. The
 * lobby keeps every visited session mounted, so it is also right fifteen times
 * over for terminals nobody can see, and `mousemove` is the one that hurts:
 * every move runs `worldAt`, which is a `querySelector` for `.xterm-screen`, a
 * `contains` against the event target and a `hasSelection()` on the terminal.
 * At roughly 100 moves a second, that is 1,500 of those per second across a
 * lobby of fifteen, for gestures that can only ever land in one of them.
 *
 * The gate is a read, not a listener swap: the handler stays registered and
 * returns early, which is the design's call
 * (docs/plans/2026-09-11-client-cpu-parking-design.md) because there is less
 * lifecycle to get wrong than in detaching and re-attaching three capture
 * listeners on every session switch.
 *
 * `hasSelection()` is what the cases below count, because it is the one call
 * `worldAt` makes eagerly on every event. The screen box behind it is a getter
 * the reducer only reads on a press. Counting it counts the work the gate was
 * added to remove.
 *
 * WHY xterm IS MOCKED, as in TerminalNative.wiring.test.tsx: jsdom has no
 * layout, so a real xterm's cell geometry does not exist and nothing downstream
 * of a real mouse event is observable. What is under test here is which of the
 * component's own handlers ran, which the fake records exactly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

const xt = vi.hoisted(() => {
  interface Disposable {
    dispose(): void;
  }
  const nothing: Disposable = { dispose() {} };

  class FakeTerminal {
    cols = 80;
    rows = 24;
    /** How many times `worldAt` asked, which is once per event it ran for. */
    selectionChecks = 0;
    options: Record<string, unknown> = {};
    buffer = { active: { cursorY: 0, viewportY: 0 } };
    modes: { mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" } = {
      mouseTrackingMode: "none",
    };
    element: HTMLElement | null = null;
    screen: HTMLDivElement | null = null;
    readonly onDataCbs: ((d: string) => void)[] = [];

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      made.terminals.push(this);
    }
    loadAddon(): void {}
    open(host: HTMLElement): void {
      const element = document.createElement("div");
      element.className = "xterm";
      host.appendChild(element);
      this.element = element;
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      element.appendChild(screen);
      this.screen = screen;
      const ta = document.createElement("textarea");
      ta.className = "xterm-helper-textarea";
      host.appendChild(ta);
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      this.selectionChecks++;
      return false;
    }
    getSelection(): string {
      return "";
    }
    clearSelection(): void {}
    onData(cb: (d: string) => void): Disposable {
      this.onDataCbs.push(cb);
      return nothing;
    }
    onBinary(): Disposable {
      return nothing;
    }
    onBell(): Disposable {
      return nothing;
    }
    onResize(): Disposable {
      return nothing;
    }
    onTitleChange(): Disposable {
      return nothing;
    }
    onScroll(): Disposable {
      return nothing;
    }
    onRender(): Disposable {
      return nothing;
    }
    onLineFeed(): Disposable {
      return nothing;
    }
    onCursorMove(): Disposable {
      return nothing;
    }
    onSelectionChange(): Disposable {
      return nothing;
    }
    registerLinkProvider(): Disposable {
      return nothing;
    }
    registerMarker(): Disposable {
      return nothing;
    }
    write(): void {}
    input(): void {}
    paste(): void {}
    focus(): void {}
    blur(): void {}
    refresh(): void {}
    resize(): void {}
    scrollLines(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  }

  class FakeFitAddon {
    constructor() {
      made.fitAddons.push(this);
    }
    activate(): void {}
    dispose(): void {}
    fit(): void {}
  }

  const made = { terminals: [] as FakeTerminal[], fitAddons: [] as FakeFitAddon[] };
  return { FakeTerminal, FakeFitAddon, made };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xt.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xt.FakeFitAddon }));

// Imported after the mocks so the component's dynamic imports resolve to them.
import { TerminalNative } from "../src/components/TerminalNative";

/** ttyd's socket, which never opens on its own here. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A MouseEvent constructor that drops `view`.
 *
 * The component builds its selection clone with `view: window`, which is what a
 * real browser wants; under vitest's jsdom that same value fails the Window
 * conversion and the clone throws. TerminalNative.wiring.test.tsx carries the
 * same shim and the same reasoning: the production init is unchanged and only
 * the test's constructor differs, and nothing on the selection path reads
 * `view`: `SelectionService.shouldForceSelection` reads the modifiers, and
 * `handleMouseDown` reads `button`, `timeStamp`, `shiftKey` and `detail`.
 */
class ViewlessMouseEvent extends MouseEvent {
  constructor(type: string, init: MouseEventInit = {}) {
    const rest: MouseEventInit = { ...init };
    delete rest.view;
    super(type, rest);
  }
}

const realHasFocus = document.hasFocus.bind(document);
const realMouseEvent = globalThis.MouseEvent;

beforeEach(() => {
  globalThis.MouseEvent = ViewlessMouseEvent as unknown as typeof MouseEvent;
  xt.made.terminals.length = 0;
  xt.made.fitAddons.length = 0;
  // jsdom answers false, which the battery saver now reads as "nobody is
  // reading this" and would park every terminal these cases mount.
  document.hasFocus = () => true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    json: async () => ({ token: "tok" }),
  });
});

afterEach(() => {
  document.hasFocus = realHasFocus;
  globalThis.MouseEvent = realMouseEvent;
});

/** Let the two dynamic imports and the /token fetch settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * A press the drag interceptor will look at, which means a TRUSTED one: its
 * first test is `e.isTrusted`, because the clone it asks for re-enters the same
 * listener as an untrusted press and that is the recursion guard.
 *
 * jsdom makes the flag awkward twice over, and TerminalNative.wiring.test.tsx
 * says so at more length: the wrapper's `isTrusted` is a non-configurable
 * accessor reading jsdom's own impl object, and `dispatchEvent` writes
 * `isTrusted = false` on that impl just before dispatching. The impl is an
 * ordinary object, so redefining the property there as a constant-true accessor
 * with a no-op setter satisfies the write and every read after it.
 */
function forceTrusted<E extends Event>(e: E): E {
  const impl = Object.getOwnPropertySymbols(e).find((s) => s.description === "impl");
  if (!impl) throw new Error("jsdom's event impl symbol is gone; see `forceTrusted`");
  const inner = (e as unknown as Record<symbol, object>)[impl];
  Object.defineProperty(inner, "isTrusted", { configurable: true, get: () => true, set: () => {} });
  return e;
}

/**
 * Give `.xterm-screen` a box. jsdom lays nothing out, so every rect it reports
 * is 0x0, and a zero-height box makes every press look like a click on tmux's
 * status row, which is a different branch of the reducer from the drag this
 * case is about.
 */
function boxScreen(el: HTMLElement): HTMLElement {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

interface Mounted {
  term: InstanceType<typeof xt.FakeTerminal>;
  /** SessionView's `onScreen()`, which is what `ownsBridges` is at that call site. */
  setOnScreen(v: boolean): void;
  /** One mouse event of the given type, at capture on the document. */
  fire(type: "mousedown" | "mousemove" | "mouseup", init?: MouseEventInit): void;
  /** The terminal's own screen node, which a real gesture would start on. */
  screen(): HTMLElement;
  unmount(): void;
}

async function mount(opts: { onScreen?: boolean } = {}): Promise<Mounted> {
  const [onScreen, setOnScreen] = createSignal(opts.onScreen ?? true);
  const r = render(() => (
    <TerminalNative args="arg=gate" ownsBridges={onScreen()} active={onScreen()} />
  ));
  await settle();
  const term = xt.made.terminals[0];
  if (!term) throw new Error("no terminal was created");
  const screen = (): HTMLElement => {
    if (!term.screen) throw new Error("xterm was never opened");
    return term.screen;
  };
  return {
    term,
    setOnScreen,
    fire: (type, init = {}) => {
      const target = type === "mousemove" ? document.body : screen();
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(type === "mousedown" ? forceTrusted(e) : e);
    },
    screen,
    unmount: () => r.unmount(),
  };
}

describe("the mouse handlers of a terminal nobody is reading", () => {
  it("does the drag interceptor's work while the session is on screen", async () => {
    const m = await mount();
    const before = m.term.selectionChecks;
    m.fire("mousemove", { clientX: 10, clientY: 10 });
    m.fire("mousemove", { clientX: 20, clientY: 10 });
    expect(m.term.selectionChecks - before, "one world per move").toBe(2);
    m.unmount();
  });

  /**
   * The whole point. Fifteen mounted sessions and one on screen means fourteen
   * of these handlers have nothing to decide, and the cheapest way to prove
   * that is that the terminal is never asked anything.
   */
  it("reads nothing at all on a move while the session is off screen", async () => {
    const m = await mount({ onScreen: false });
    const before = m.term.selectionChecks;
    for (let i = 0; i < 20; i++) m.fire("mousemove", { clientX: i, clientY: 5 });
    expect(m.term.selectionChecks).toBe(before);
    m.unmount();
  });

  it("starts again the moment the session comes back on screen", async () => {
    const m = await mount({ onScreen: true });
    m.setOnScreen(false);
    const parked = m.term.selectionChecks;
    m.fire("mousemove", { clientX: 1, clientY: 1 });
    expect(m.term.selectionChecks).toBe(parked);

    m.setOnScreen(true);
    m.fire("mousemove", { clientX: 2, clientY: 1 });
    expect(m.term.selectionChecks).toBe(parked + 1);
    m.unmount();
  });

  /**
   * A session showing its TEXT view is still being read: its composer sends to
   * this pty and switching back has to be instant. `ownsBridges` stays true
   * there and `active` does not, which is why the gate reads the wider of the
   * two. The narrower one would park the gestures of a session the person is
   * looking straight at.
   */
  it("keeps working for a session on screen in text view", async () => {
    const [onScreen] = createSignal(true);
    const r = render(() => (
      <TerminalNative args="arg=gate-text" ownsBridges={onScreen()} active={false} />
    ));
    await settle();
    const term = xt.made.terminals[0];
    if (!term) throw new Error("no terminal was created");
    const before = term.selectionChecks;
    document.body.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 3, clientY: 3 }),
    );
    expect(term.selectionChecks).toBe(before + 1);
    r.unmount();
  });

  /**
   * PRESS AND RELEASE ARE NOT GATED, and that is a decision rather than an
   * oversight. Neither fires at anything like the rate of a move, one per
   * click against roughly a hundred a second, so the cost the gate exists to
   * remove is not in them, and each has something to lose. A press carries the
   * keyboard-hold check that runs against the whole document, and a release is
   * how the gesture reducer learns a drag ended: gating it would let a session
   * that went off screen mid-drag keep `drag` set forever and misread the next
   * press it ever sees.
   */
  it("still hears a press while the session is off screen", async () => {
    const m = await mount({ onScreen: false });
    const before = m.term.selectionChecks;
    m.fire("mousedown", { button: 0, buttons: 1, detail: 1, clientX: 5, clientY: 5 });
    expect(m.term.selectionChecks, "the press still asks for a world").toBe(before + 1);
    m.fire("mouseup", { button: 0, buttons: 0, clientX: 5, clientY: 5 });
    expect(m.term.selectionChecks, "and so does the release").toBe(before + 2);
    m.unmount();
  });

  /**
   * The one motion the gate must let through: a gesture already in flight. A
   * press held back or a drag under way is state the reducer has to be allowed
   * to finish, and a session that goes off screen under a held button would
   * otherwise leave it mid-gesture with only the release to sort it out.
   *
   * Reaching it needs a keyboard: with a mouse you cannot switch sessions
   * without letting go first. It is cheap to be right about anyway, because the
   * two fields it reads are both null on the idle terminal this gate is for.
   */
  it("lets a gesture that is already in flight finish", async () => {
    const m = await mount({ onScreen: true });
    boxScreen(m.screen());
    m.fire("mousedown", { button: 0, buttons: 1, detail: 1, clientX: 100, clientY: 100 });
    // Counted after the press, because the press answers itself with a clone
    // that re-enters the same listener and asks for a world of its own.
    const held = m.term.selectionChecks;

    m.setOnScreen(false);
    m.fire("mousemove", { buttons: 1, clientX: 140, clientY: 100 });
    expect(m.term.selectionChecks, "the travel still reaches the reducer").toBeGreaterThan(held);

    m.fire("mouseup", { button: 0, buttons: 0, clientX: 140, clientY: 100 });
    // The gesture is over, so the gate closes again.
    const settled = m.term.selectionChecks;
    m.fire("mousemove", { clientX: 150, clientY: 100 });
    expect(m.term.selectionChecks).toBe(settled);
    m.unmount();
  });
});
