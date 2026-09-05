/**
 * THE DOCK IS A BOTTOM PANEL, AND IT DOES NOT EXIST ON A PHONE.
 *
 * Two things this file pins, both of them things the dock CLAIMED and did not
 * do:
 *
 *  1. It renders UNDER the session, not beside it. Every rule the dock carries
 *     describes a bottom panel (a column direction, a border-TOP, a row-resize
 *     gutter) and Dock.tsx's docblock says "a persistent panel under the
 *     session you are working in", but `.tl-shell-body` was a flex ROW and the
 *     dock is its second child, so it landed as a right-hand strip. Measured at
 *     1440x900 before the fix: 300x129 at x=1140, a column of terminal down the
 *     right edge.
 *  2. A coarse pointer builds NO terminal. CSS hid the panel
 *     (`.tl-dock { display: none }` under `(pointer: coarse)`) while the mount
 *     went ahead, so a phone opening a roamed layout that carries `layout.dock`
 *     attached a second pty inside a hidden box. tmux sizes a window to its
 *     SMALLEST attached client, so that invisible attach could shrink the
 *     session the person was reading.
 *
 * The layout half is asserted against the stylesheet: jsdom runs no layout, so
 * `flex-direction` IS the observable behaviour here (the same reasoning as
 * card.longpress.css.test.ts). The mount half is asserted against a real
 * render, which is where the bug actually lived.
 *
 * `TerminalNative` is stubbed: this file asks whether a terminal is built at
 * all, and a real one would boot xterm, a socket and a ResizeObserver to answer
 * that.
 */
import { describe, it, expect, afterEach, vi, onTestFinished } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@solidjs/testing-library";
import { Dock } from "../src/components/Dock";
import { createDockStore, type DockStore } from "../src/store/dock";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { DOCK_RATIO_DEFAULT, DOCK_RATIO_KEY } from "../src/store/dock.logic";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

/** How many terminals the dock built, and what it handed the last one. */
const native = vi.hoisted(() => ({ mounted: 0, args: null as null | (() => string | undefined) }));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: { args?: string }) => {
    native.mounted++;
    native.args = () => props.args;
    return <div data-testid="terminal" />;
  },
}));

// ---- the stylesheet -------------------------------------------------------

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The body of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

// ---- a viewport that can answer `(pointer: coarse)` -----------------------

const listeners = new Set<{ q: string; fn: (e: MediaQueryListEvent) => void }>();
const original = window.matchMedia;

/** Only the pointer question matters here; everything else answers no. */
const evaluate = (q: string, coarse: boolean): boolean =>
  q.includes("pointer: coarse") ? coarse : false;

function stubPointer(coarse: boolean): void {
  window.matchMedia = ((q: string) =>
    ({
      media: q,
      get matches() {
        return evaluate(q, coarse);
      },
      addEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.add({ q, fn });
      },
      removeEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => {
        for (const l of listeners) if (l.fn === fn) listeners.delete(l);
      },
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

/** Attach a mouse to a tablet (or take it away), as a UA would report it. */
function repoint(coarse: boolean): void {
  stubPointer(coarse);
  for (const l of [...listeners]) l.fn({ matches: evaluate(l.q, coarse) } as MediaQueryListEvent);
}

afterEach(() => {
  listeners.clear();
  window.matchMedia = original;
  native.mounted = 0;
  native.args = null;
  // The split ratio is per-browser and a drag writes it. jsdom's storage
  // survives between tests in a file, so a dragged ratio would otherwise be the
  // next test's starting point.
  localStorage.removeItem(DOCK_RATIO_KEY);
});

// ---- a lobby with a dock already in its layout ----------------------------

const sess = (name: string): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [sess("work"), sess("shell")];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  async whoami() {
    return this.whoamiVal;
  }
  async listSessions() {
    return this.sessionsVal;
  }
  async getLayout() {
    return this.layoutVal;
  }
  async putLayout(l: Layout) {
    this.layoutVal = l;
    this.puts.push(l);
  }
  async killSession() {}
  async setSessionTitle() {
    throw new ApiError(404, "no");
  }
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
  async prewarm() {}
  async releasePrewarm() {}
}

/**
 * Mount the dock inside a stand-in for `.tl-shell-body`, with `layout.dock`
 * already set, which is how a phone meets one: the dock rides the ROAMED
 * layout, so it arrives from the laptop already `visible: true` and no chord
 * was ever pressed on this device.
 */
function mountDock(coarse: boolean, opts: { docked?: boolean } = {}) {
  stubPointer(coarse);
  const api = new FakeApi();
  if (opts.docked !== false) {
    api.layoutVal = { ...emptyLayout(), dock: { session: "shell", visible: true } };
  }
  let store!: LobbyStore;
  let dock!: DockStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    dock = createDockStore({ store });
    return (
      <div class="tl-shell-body">
        <div class="tl-session-view" />
        <Dock dock={dock} />
      </div>
    );
  });
  onTestFinished(() => store.dispose());
  return { ...utils, api, store: store!, dock: dock! };
}

/** The refresh the store would have done on its own with `autoStart` on. */
async function loaded(store: LobbyStore): Promise<void> {
  await store.refresh();
}

describe("the dock is a bottom panel, not a right-hand strip", () => {
  it("stacks the content column, so the dock lands under the session", () => {
    // Without this the dock is the second child of a flex ROW and renders
    // beside the session view instead of below it.
    expect(ruleBody(".tl-shell-body")).toMatch(/flex-direction:\s*column/);
  });

  it("keeps the rules that make it read as a bottom panel", () => {
    const dock = ruleBody(".tl-dock");
    expect(dock).toMatch(/flex-direction:\s*column/);
    expect(dock).toMatch(/border-top:/);
    expect(dock).toMatch(/min-height:\s*80px/);
    expect(ruleBody(".tl-dock-gutter")).toMatch(/cursor:\s*row-resize/);
  });

  it("pins no minimum WIDTH on a panel that runs the full width", () => {
    // The 300px floor stood in for an iframe's intrinsic width while the dock
    // was a strip. A full-width panel has no width of its own to defend, and a
    // floor left here would only misdescribe the layout.
    expect(ruleBody(".tl-dock")).not.toMatch(/min-width/);
  });
});

describe("no second terminal on a coarse pointer", () => {
  it("builds one for a mouse", async () => {
    const { store, getByTestId } = mountDock(false);
    await loaded(store);
    expect(native.mounted).toBe(1);
    expect(getByTestId("terminal")).toBeInTheDocument();
    expect(native.args?.()).toContain("shell");
  });

  it("builds NOTHING on a phone, layout.dock and all", async () => {
    const { store, queryByTestId, container } = mountDock(true);
    await loaded(store);
    // The state that used to be enough to mount one is all present.
    expect(store.layout().dock).toEqual({ session: "shell", visible: true });
    expect(native.mounted).toBe(0);
    expect(queryByTestId("terminal")).toBeNull();
    // Not merely hidden: there is no panel in the document to hide.
    expect(container.querySelector(".tl-dock")).toBeNull();
  });

  it("refuses the chord's toggle too, so no path creates one", async () => {
    // `session.new.shell` reaches `toggle` through the command table without
    // passing App's key handler, so the store has to answer for itself.
    const { store, dock, api } = mountDock(true, { docked: false });
    await loaded(store);
    await dock.toggle();
    expect(api.puts).toEqual([]);
    expect(store.layout().dock).toBeUndefined();
    expect(native.mounted).toBe(0);
  });

  it("hands the dock back when a tablet gains a mouse, and takes it away again", async () => {
    const { store, dock, queryByTestId } = mountDock(true);
    await loaded(store);
    expect(dock.allowed()).toBe(false);
    expect(native.mounted).toBe(0);

    // A keyboard folio goes on: the primary pointer stops being coarse.
    repoint(false);
    expect(dock.allowed()).toBe(true);
    expect(native.mounted).toBe(1);
    expect(queryByTestId("terminal")).not.toBeNull();

    // And comes off again. The shell keeps running in tmux; only the attach goes.
    repoint(true);
    expect(dock.allowed()).toBe(false);
    expect(queryByTestId("terminal")).toBeNull();
  });
});

describe("how tall the panel opens", () => {
  it("takes the documented default in a browser that never dragged the gutter", async () => {
    const { store, dock } = mountDock(false);
    await loaded(store);
    // `Number(null)` is 0, not NaN, so clamping the read before asking whether
    // there WAS a stored value pinned every first dock to RATIO_MIN: 15% of the
    // content column rather than 30%.
    expect(dock.ratio()).toBe(DOCK_RATIO_DEFAULT);
  });

  it("takes the stored one when there is one", async () => {
    localStorage.setItem(DOCK_RATIO_KEY, "70");
    const { store, dock } = mountDock(false);
    await loaded(store);
    expect(dock.ratio()).toBe(70);
  });
});

describe("the gutter resizes the panel up and down", () => {
  /** Give the content column a real box; jsdom measures everything as zero. */
  function boxed(el: Element, top: number, height: number): void {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 1000,
        width: 1000,
        x: 0,
        y: top,
      }) as DOMRect;
  }

  const drag = (gutter: Element, ys: number[]): void => {
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: ys[0] }),
    );
    for (const y of ys.slice(1)) {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: y }));
    }
    window.dispatchEvent(new PointerEvent("pointerup", {}));
  };

  it("measures the DOCK's share of the content column, growing upward", async () => {
    const { store, dock, container } = mountDock(false);
    await loaded(store);
    expect(dock.ratio()).toBe(DOCK_RATIO_DEFAULT);

    const body = container.querySelector(".tl-shell-body")!;
    boxed(body, 100, 400); // the column runs y=100..500
    const gutter = container.querySelector(".tl-dock-gutter")!;

    // Halfway up the column is half the column.
    drag(gutter, [300, 300]);
    expect(dock.ratio()).toBe(50);

    // Dragging further UP grows the panel: that is the direction a bottom
    // panel resizes in, and the assertion a right-hand strip would fail.
    drag(gutter, [300, 200]);
    expect(dock.ratio()).toBe(75);

    // Down past the floor clamps rather than collapsing.
    drag(gutter, [300, 480]);
    expect(dock.ratio()).toBe(15);
  });

  it("lets go of the window if the panel disappears mid-drag", async () => {
    // Ctrl+J while the gutter is held. The drag's listeners live on `window`,
    // so nothing unhooks them when the panel unmounts unless the component's
    // own cleanup does it.
    const { store, container, unmount } = mountDock(false);
    await loaded(store);
    const gutter = container.querySelector(".tl-dock-gutter")!;
    const off = vi.spyOn(window, "removeEventListener");
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 300 }),
    );
    unmount();
    const dropped = off.mock.calls.map((c) => c[0]);
    expect(dropped).toContain("pointermove");
    expect(dropped).toContain("pointerup");
    off.mockRestore();
  });
});
