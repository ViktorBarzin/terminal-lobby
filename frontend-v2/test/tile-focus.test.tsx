/**
 * THE FOCUSED TILE, AND EVERYTHING THAT HAS TO FOLLOW IT.
 *
 * A Workspace puts four live sessions on screen at once (ADR-0027), and the
 * keyboard goes to exactly one of them. Every question this file asks used to
 * have one answer because there was one visible `SessionView`, and `onScreen()`
 * was a perfectly good stand-in for "the session in front of the user". Four
 * visible tiles make that stand-in answer FOUR times, and four is the wrong
 * number for all of it: who takes DOM focus at boot, who holds each
 * `window.__tl*` handle, who handles one paste, how many session bars are on
 * screen, how many toolbars publish `--sk-h`.
 *
 * WHY THIS FILE MOUNTS THE REAL COMPONENTS. Every one of those defects shipped
 * past a green suite because the suite tested the parts: `lib/ownwhile.ts`'s
 * focus gate has its own test and passes, `clipboard/attach.ts`'s `active` gate
 * has its own test and passes, and both were then wired to a boolean that says
 * "visible". The gap is in the wiring, so this file renders four `SessionView`s
 * inside the `TileFocusContext` providers `App.tsx` wraps each slot in, boots
 * their terminals, and asks the questions from outside — through the window
 * handles a person's paste really takes, and by counting nodes in the DOM.
 *
 * WHAT THIS FILE CANNOT REACH, and where the claim is settled instead:
 *   - which terminal a REAL browser leaves focused when four boot at once.
 *     `typingElsewhere()` counts a focused terminal as somebody typing (xterm's
 *     input proxy is a textarea), so in a browser the FIRST terminal to resolve
 *     its two dynamic imports wins and the rest decline; the fake xterm here
 *     moves no DOM focus, so all four ask. Either way the winner is decided by
 *     module-load timing rather than by which tile the user is looking at,
 *     which is the defect. The gate, not the race, is what is pinned here.
 *   - the pixels. jsdom has no layout, so "one bar instead of four" is counted
 *     as nodes; what those nodes cost in terminal rows is a browser claim.
 *   - `MessagesTimeline`'s handle, the twelfth of the twelve: it is claimed
 *     from a component body inside the TEXT view and is gated by the same
 *     `useContext(TileFocusContext)` read as `SessionView`'s five, which
 *     test/workspace-visible-set.test.tsx pins directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSignal, For } from "solid-js";
import { render } from "@solidjs/testing-library";

/* ------------------------------------------------------------------ *
 * The xterm stand-ins. Hoisted because vi.mock is.
 *
 * The same shape TerminalNative.wiring.test.tsx uses and for the same reason:
 * jsdom can open a real xterm but has no layout, so nothing downstream of a
 * real `paste()` or a real `focus()` is observable. What this file needs from
 * the fake is WHICH terminal was asked, so every recorder is per-instance.
 * ------------------------------------------------------------------ */

const xt = vi.hoisted(() => {
  interface Disposable {
    dispose(): void;
  }
  const nothing: Disposable = { dispose() {} };

  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    host: HTMLElement | null = null;
    element: HTMLElement | null = null;
    screen: HTMLDivElement | null = null;
    readonly onDataCbs: ((data: string) => void)[] = [];
    readonly onBinaryCbs: ((data: string) => void)[] = [];
    readonly pasted: string[] = [];
    readonly written: Uint8Array[] = [];
    /** Every `term.focus()` this terminal was asked for. The subject of the
     *  first describe: four cold tiles must produce exactly one asker. */
    focused = 0;
    selected = false;
    modes: { mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" } = {
      mouseTrackingMode: "any",
    };
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    selectionText = "";

    constructor(opts: Record<string, unknown>) {
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
      const ta = document.createElement("textarea");
      ta.className = "xterm-helper-textarea";
      host.appendChild(ta);
    }
    attachCustomWheelEventHandler(h: ((e: WheelEvent) => boolean) | null): void {
      this.wheelHandler = h;
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = h;
    }
    hasSelection(): boolean {
      return this.selected;
    }
    getSelection(): string {
      return this.selectionText;
    }
    clearSelection(): void {}
    onData(cb: (data: string) => void): Disposable {
      this.onDataCbs.push(cb);
      return nothing;
    }
    onBinary(cb: (data: string) => void): Disposable {
      this.onBinaryCbs.push(cb);
      return nothing;
    }
    onBell(): Disposable {
      return nothing;
    }
    input(data: string): void {
      for (const cb of this.onDataCbs) cb(data);
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
    refresh(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  }

  class FakeFitAddon {
    /** Every fit this terminal ran, which is what `__tlRefitTerminal` moves. */
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
  };
  return { FakeTerminal, FakeFitAddon, made };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xt.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xt.FakeFitAddon }));

/**
 * The grid claim, silenced. Four visible tiles each claim their session's tmux
 * window (SessionView's `claimGrid`), which is the design's intent and not this
 * file's subject; what it must not do here is reach `fetch`.
 */
vi.mock("../src/lib/lobby-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/lobby-api")>()),
  setSessionGrid: async () => {},
}));

/**
 * Every clipboard upload the mounted views performed, by session.
 *
 * `installImageClipboard` takes its uploader as a dep and `SessionView` passes
 * none, so the real `uploadBlob` is what a paste reaches. Replacing that export
 * is how the multi-upload defect is counted here rather than in the module's
 * own test, which injects the uploader and so cannot see the wiring.
 */
const uploads = vi.hoisted(() => [] as string[]);
vi.mock("../src/clipboard/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/clipboard/upload")>()),
  uploadBlob: async (_blob: Blob, opts: { session: string }) => {
    uploads.push(opts.session);
    return { path: `/store/${opts.session}/shot.png`, stored: true };
  },
}));

// Imported after the mocks so the components' dynamic imports resolve to them.
import { SessionView } from "../src/components/SessionView";
import { TileFocusContext } from "../src/lib/ownwhile";

/* ------------------------------------------------------------------ *
 * The environment the terminal expects and jsdom does not have.
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

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    sockets.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

let sockets: FakeSocket[] = [];

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The box every boot fit measures. A real one is what makes `bootFitted` true
 *  — which in a workspace is true for all four tiles at once, since all four
 *  are on screen. That is the whole of the first describe's setup. */
const BOX = { w: 800, h: 600 };

/** One animation frame, which is what the focus effects wait out. */
const FRAME_MS = 20;

/** Let every pending microtask run: the two dynamic imports and /token. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const realMatchMedia = window.matchMedia;

/** Answer media queries from a viewport, not from a substring of the query
 *  (the shape test/SessionView.mobile.test.tsx uses). */
function stubViewport(vp: { width: number; height: number; coarse: boolean }): void {
  window.matchMedia = ((q: string) => {
    const ok = () => {
      if (q.includes("pointer: coarse") && !vp.coarse) return false;
      if (q === "(pointer: coarse)") return vp.coarse;
      const w = q.match(/max-width:\s*(\d+)px/);
      const h = q.match(/max-height:\s*(\d+)px/);
      return (w ? vp.width <= Number(w[1]) : false) || (h ? vp.height <= Number(h[1]) : false);
    };
    return {
      media: q,
      get matches() {
        return ok();
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** A landscape tablet: coarse, and WIDER than FLIP_QUERY's 720px, so it gets
 *  the full split view and its workspaces (mobile/pointer.ts). */
const TABLET = { width: 1024, height: 768, coarse: true };

/** The twelve `window.__tl*` names, minus MessagesTimeline's — six claimed by
 *  `SessionView`'s body and six by `TerminalNative`'s async mount. */
const SESSION_HANDLES = [
  "__tlToggleView",
  "__tlFocusSession",
  "__tlOpenFind",
  "__tlDoPaste",
  "__tlAttachToComposer",
] as const;
const TERMINAL_HANDLES = [
  "__tlSendToTerminal",
  "__tlPasteToTerminal",
  "__tlFocusTerminal",
  "__tlRefitTerminal",
  "__tlPrefsLive",
  "__tlKeyboardOffset",
] as const;
const ALL_HANDLES = [...SESSION_HANDLES, ...TERMINAL_HANDLES];

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  uploads.length = 0;
  xt.made.terminals.length = 0;
  xt.made.fitAddons.length = 0;
  localStorage.clear();
  // The bridges are installed from inside an async mount, where Solid's owner
  // is already gone, so an unmount hands none of them back. Clear them here
  // rather than letting one test's terminal answer the next one's.
  for (const key of ALL_HANDLES) Reflect.deleteProperty(window, key);
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    json: async () => ({ token: "qa-token" }),
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => BOX.w,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => BOX.h,
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * A workspace: N session views, one of them focused.
 * ------------------------------------------------------------------ */

interface Workspace {
  /** Click a tile, in the one sense that matters here: focus moves to it. */
  focus(name: string): void;
  /** This tile's xterm, found through the DOM rather than by mount order. */
  term(name: string): InstanceType<typeof xt.FakeTerminal>;
  /** This tile's fit addon, paired with its terminal by creation order — one
   *  each, made in the same statement (TerminalNative's mount body). */
  fit(name: string): InstanceType<typeof xt.FakeFitAddon>;
  /** This tile's ttyd socket, found by the `arg=<session>` its URL carries. */
  socket(name: string): FakeSocket;
  /** The slot `App.tsx` would position, one per session. */
  slot(name: string): HTMLElement;
  /** Which sessions' terminals have been asked for DOM focus, in order. */
  focusedTerminals(): string[];
  container: HTMLElement;
}

/**
 * Mount a workspace the way `App.tsx` mounts one: one slot per member, every
 * slot visible, each wrapped in the `TileFocusContext` provider whose value is
 * `() => k.key === selectedKey()`. The slot carries `data-session` so a
 * terminal can be traced back to its tile through the DOM — mount order would
 * be a second, weaker answer to the same question.
 *
 * THE SLOTS ARE APPENDED ONE AT A TIME, which is a harness accommodation and
 * not a claim about the app: vitest 2.1.9 hands the REAL module to concurrent
 * dynamic imports of a mocked id. Measured here on 2026-09-12 — four
 * `import("@xterm/xterm")` calls started in one tick answered
 * `[fake, real, real, real]`, so three of four terminals booted a real xterm
 * against jsdom's missing canvas and never reached their socket. Appending is
 * also what `App.tsx`'s `<For each={mounted()}>` does when sessions open one
 * by one, and nothing under test here reads mount order: each terminal decides
 * whether to take the keyboard when ITS own boot fit lands, whoever else is up.
 */
async function workspace(names: string[], focusedName: string): Promise<Workspace> {
  const [focused, setFocused] = createSignal(focusedName);
  const [mounted, setMounted] = createSignal<string[]>([]);
  const r = render(() => (
    <For each={mounted()}>
      {(name) => (
        <div class="tl-session-slot tl-tiled" data-session={name}>
          <TileFocusContext.Provider value={() => focused() === name}>
            <SessionView session={name} visible={true} />
          </TileFocusContext.Provider>
        </div>
      )}
    </For>
  ));
  for (const name of names) {
    setMounted((prev) => [...prev, name]);
    await settle();
  }
  vi.advanceTimersByTime(FRAME_MS);

  const sessionOf = (t: InstanceType<typeof xt.FakeTerminal>): string =>
    t.host?.closest("[data-session]")?.getAttribute("data-session") ?? "";
  const term = (name: string): InstanceType<typeof xt.FakeTerminal> => {
    const found = xt.made.terminals.find((t) => sessionOf(t) === name);
    if (!found) throw new Error(`no terminal mounted for ${name}`);
    return found;
  };
  return {
    container: r.container,
    focus: (name) => {
      setFocused(name);
      vi.advanceTimersByTime(FRAME_MS);
    },
    term,
    fit: (name) => {
      const at = xt.made.terminals.indexOf(term(name));
      const fit = xt.made.fitAddons[at];
      if (!fit) throw new Error(`no fit addon for ${name}`);
      return fit;
    },
    socket: (name) => {
      const found = sockets.find((s) => s.url.includes(`arg=${name}`));
      if (!found) throw new Error(`no socket opened for ${name}`);
      return found;
    },
    slot: (name) => {
      const el = r.container.querySelector<HTMLElement>(`[data-session="${name}"]`);
      if (!el) throw new Error(`no slot for ${name}`);
      return el;
    },
    focusedTerminals: () => xt.made.terminals.filter((t) => t.focused > 0).map((t) => sessionOf(t)),
  };
}

/** The four members of the workspace every test below arranges. */
const FOUR = ["auth", "deploy", "docs", "logs"];

/* ------------------------------------------------------------------ *
 * 1. The keyboard
 * ------------------------------------------------------------------ */

describe("a cold workspace gives the keyboard to the focused tile and to nobody else", () => {
  /**
   * THE SAFETY CASE, and the reason click-to-focus exists at all: a keystroke
   * that lands in the wrong terminal RUNS there. The tile header says `auth`,
   * the accent wash says `auth`, and the bytes reach `logs` — where they are a
   * command.
   */
  it("focuses exactly one terminal when four boot at once", async () => {
    const ws = await workspace(FOUR, "docs");
    expect(ws.focusedTerminals()).toEqual(["docs"]);
  });

  it("leaves the other three terminals untouched", async () => {
    const ws = await workspace(FOUR, "docs");
    for (const name of ["auth", "deploy", "logs"]) {
      expect(ws.term(name).focused, `${name} took the keyboard`).toBe(0);
    }
  });

  /**
   * FOCUS FOLLOWS THE TILE, because the press that moves focus is not always a
   * press into a terminal: the tile header is a drag handle and a close, and a
   * press on it focuses the tile without xterm ever seeing a pointer event. A
   * tile whose header says it is focused while the keyboard is still in a
   * neighbour is the same misdirected keystroke by another route.
   */
  it("moves the keyboard when focus moves", async () => {
    const ws = await workspace(FOUR, "docs");
    const before = ws.term("logs").focused;
    ws.focus("logs");
    expect(ws.term("logs").focused, "the newly focused tile takes it").toBeGreaterThan(before);
  });

  it("does not take the keyboard back for a tile that lost focus", async () => {
    const ws = await workspace(FOUR, "docs");
    const held = ws.term("docs").focused;
    ws.focus("logs");
    expect(ws.term("docs").focused, "docs focused itself again").toBe(held);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The window handles
 * ------------------------------------------------------------------ */

describe("every window handle answers for the focused tile", () => {
  it("pastes into the focused tile's terminal, not the last one mounted", async () => {
    const ws = await workspace(FOUR, "auth");
    window.__tlPasteToTerminal?.("echo hello\n");
    expect(ws.term("auth").pasted).toEqual(["echo hello\n"]);
    for (const name of ["deploy", "docs", "logs"]) {
      expect(ws.term(name).pasted, `${name} was pasted into`).toEqual([]);
    }
  });

  /** The handover, from the other side: the handle has to keep WORKING after
   *  focus moves, not merely stop being the old tile's. `ownWhile` restores the
   *  previous value on cleanup only when the handle is still its own, so an
   *  install and a cleanup landing in either order both leave the new tile's. */
  it("pastes into the new tile once focus has moved", async () => {
    const ws = await workspace(FOUR, "auth");
    ws.focus("docs");
    window.__tlPasteToTerminal?.("echo moved\n");
    expect(ws.term("docs").pasted).toEqual(["echo moved\n"]);
    for (const name of ["auth", "deploy", "logs"]) {
      expect(ws.term(name).pasted, `${name} was pasted into`).toEqual([]);
    }
  });

  it("sends bytes to the focused tile's pty", async () => {
    const ws = await workspace(FOUR, "auth");
    for (const name of FOUR) ws.socket(name).accept();
    // Counted as a DELTA: an accepted socket has already sent its own opening
    // frames (ttyd's resize among them), so "this one has written something" is
    // true of all four before anybody types.
    const before = FOUR.map((n) => ws.socket(n).sent.length);
    window.__tlSendToTerminal?.("ls\r");
    const after = FOUR.map((n) => ws.socket(n).sent.length);
    expect(after[0], "the focused pty got the bytes").toBeGreaterThan(before[0]!);
    expect(after.slice(1), "another pty got bytes").toEqual(before.slice(1));
  });

  it("refits the focused tile's terminal", async () => {
    const ws = await workspace(FOUR, "auth");
    const before = FOUR.map((n) => ws.fit(n).fits);
    window.__tlRefitTerminal?.();
    vi.advanceTimersByTime(200); // past refit's 120ms coalesce
    const after = FOUR.map((n) => ws.fit(n).fits);
    expect(after[0], "the focused tile fitted").toBeGreaterThan(before[0]!);
    expect(after.slice(1), "the other three fitted").toEqual(before.slice(1));
  });

  it("steps the font on the focused tile's terminal", async () => {
    const ws = await workspace(FOUR, "auth");
    window.__tlPrefsLive?.({ fontSize: 19 });
    expect(ws.term("auth").options.fontSize).toBe(19);
    for (const name of ["deploy", "docs", "logs"]) {
      expect(ws.term(name).options.fontSize, `${name} resized`).not.toBe(19);
    }
  });

  it("hands the keyboard back to the focused tile after an overlay closes", async () => {
    const ws = await workspace(FOUR, "auth");
    const before = FOUR.map((n) => ws.term(n).focused);
    window.__tlFocusTerminal?.();
    expect(ws.term("auth").focused, "the focused tile took it").toBeGreaterThan(before[0]!);
    expect(
      ["deploy", "docs", "logs"].map((n) => ws.term(n).focused),
      "another tile took it",
    ).toEqual(before.slice(1));
  });

  /**
   * ALL ELEVEN AT ONCE. The five `SessionView` claims are gated by
   * `useContext(TileFocusContext)` inside `ownWhile`; the six `TerminalNative`
   * claims are installed after an `await`, where there is no owner and
   * `useContext` can only hand back the context default — so they follow the
   * prop `SessionView` passes instead. Two gates, one answer required: every
   * handle is a different function once focus has moved.
   */
  it("moves all eleven reachable handles when focus moves", async () => {
    const ws = await workspace(FOUR, "auth");
    const held = Object.fromEntries(ALL_HANDLES.map((k) => [k, window[k]]));
    for (const k of ALL_HANDLES) expect(held[k], `${k} was never claimed`).toBeTypeOf("function");

    ws.focus("logs");
    for (const k of ALL_HANDLES) {
      expect(window[k], `${k} stayed with the tile that lost focus`).not.toBe(held[k]);
      // A handback that ran in the wrong order would leave the name undefined,
      // which is also "not the old function" — so the type is asserted too.
      expect(window[k], `${k} was handed back to nobody`).toBeTypeOf("function");
    }
  });

  /**
   * THE WHOLE CHAIN, which is where the two halves used to disagree: ⌘/Ctrl-V
   * runs the focused tile's `__tlDoPaste` (gated correctly), and that routine
   * calls `window.__tlPasteToTerminal` (held by whichever tile mounted last).
   * The clipboard text left one tile and arrived in another.
   */
  it("puts a ⌘V paste in the tile the reader is typing into", async () => {
    const ws = await workspace(FOUR, "auth");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: undefined, readText: async () => "sudo rm -rf /tmp/x" },
    });
    window.__tlDoPaste?.();
    await settle();
    expect(ws.term("auth").pasted).toEqual(["sudo rm -rf /tmp/x"]);
    for (const name of ["deploy", "docs", "logs"]) {
      expect(ws.term(name).pasted, `${name} received the paste`).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. One paste, one upload
 * ------------------------------------------------------------------ */

describe("one paste uploads once, whatever a workspace has on screen", () => {
  /** A paste event carrying one image, as a browser delivers it. */
  function pasteEvent(): Event {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", {
      type: "image/png",
    });
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
    });
    return e;
  }

  /**
   * The 2026-08-29 report — "pasting. image sometimes pastes in multiple
   * times" — with its gate re-widened. One paste on that day left four
   * byte-identical PNGs in four session directories within 307ms, because four
   * kept sessions each had a document listener that answered for itself. The
   * guard that closed it asks `onScreen`, and a workspace makes four sessions
   * answer yes to that again.
   */
  it("uploads one file into the focused tile's session", async () => {
    const ws = await workspace(FOUR, "docs");
    document.dispatchEvent(pasteEvent());
    await settle();
    expect(uploads).toEqual(["docs"]);
    expect(ws.term("docs").pasted.length, "an image paste is not xterm's").toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. One session bar
 * ------------------------------------------------------------------ */

describe("a workspace shows one session bar", () => {
  const bars = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(".tl-session-bar"));

  /**
   * The design's table: "session bar | one bar, showing the focused tile's
   * session. Its contents change as focus moves". Four bars is four Watch
   * toggles, four status dots reporting four sessions into one channel, and
   * ~41px of chrome taken out of every tile — and because a tile IS the size of
   * its tmux window, out of every device attached to those sessions.
   */
  it("renders one bar for four tiles", async () => {
    const ws = await workspace(FOUR, "docs");
    expect(bars(ws.container)).toHaveLength(1);
  });

  it("renders it in the focused tile", async () => {
    const ws = await workspace(FOUR, "docs");
    expect(ws.slot("docs").querySelector(".tl-session-bar")).not.toBeNull();
  });

  it("moves it when focus moves", async () => {
    const ws = await workspace(FOUR, "docs");
    ws.focus("logs");
    expect(bars(ws.container)).toHaveLength(1);
    expect(ws.slot("logs").querySelector(".tl-session-bar")).not.toBeNull();
    expect(ws.slot("docs").querySelector(".tl-session-bar")).toBeNull();
  });

  /** A lone session is not a tile and keeps the bar it has always had. */
  it("keeps the bar for a session outside a workspace", async () => {
    const ws = await workspace(["solo"], "solo");
    expect(bars(ws.container)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 5. One soft-key row
 * ------------------------------------------------------------------ */

describe("a workspace on a tablet shows one soft-key row", () => {
  /**
   * `id="soft-keys"` is one id, and `SoftKeys` publishes `--sk-h` from its own
   * height on the document element. Three toolbars are three writers of one
   * variable, and the cleanup of any one of them sets it to "0px" while the
   * others are still on screen — the remaining views un-reserve their keyboard
   * room and their bottom rows slide under the toolbar.
   *
   * A landscape tablet is the device this reaches: `coarse()` is true and
   * `flip()` is false at 1024x768, so it gets both the workspace and the row.
   */
  it("mounts the toolbar once, in the focused tile", async () => {
    stubViewport(TABLET);
    const ws = await workspace(["auth", "deploy", "docs"], "deploy");
    expect(ws.container.querySelectorAll("#soft-keys")).toHaveLength(1);
    expect(ws.slot("deploy").querySelector("#soft-keys")).not.toBeNull();
  });

  it("moves it with focus rather than adding a second", async () => {
    stubViewport(TABLET);
    const ws = await workspace(["auth", "deploy", "docs"], "deploy");
    ws.focus("docs");
    expect(ws.container.querySelectorAll("#soft-keys")).toHaveLength(1);
    expect(ws.slot("docs").querySelector("#soft-keys")).not.toBeNull();
  });
});
