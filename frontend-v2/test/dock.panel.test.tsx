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
  /** The rescue's stamp (POST /sessions/{name}/origin). Nothing here drags a
   *  card out of System, so it only has to exist. */
  async setSessionOrigin() {}
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

// ---- the gutter drag -----------------------------------------------------

/**
 * Give the content column a real box; jsdom measures everything as zero.
 *
 * The returned counter is how the leak tests below tell a live `pointermove`
 * handler from a dead one: every move that is still listening measures this
 * box, and that measurement is a forced layout in a real browser.
 */
function boxed(el: Element, top: number, height: number): { measured: number } {
  const seen = { measured: 0 };
  el.getBoundingClientRect = () => {
    seen.measured++;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 1000,
      width: 1000,
      x: 0,
      y: top,
    } as DOMRect;
  };
  return seen;
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

/**
 * The drag's window listeners that are still live, by type.
 *
 * Counted rather than spied on, because there are two doors a listener can
 * leave by and only one of them is a call: `removeEventListener`, and an
 * `AbortSignal` firing, which the DOM acts on without telling anyone. A test
 * that watched `removeEventListener` alone would read an aborted listener as
 * still attached, and would once have read a listener that was never added as
 * removed. This answers the question the leak is actually about: after the
 * drag, is anything still on `window`?
 */
function liveDragListeners(): () => string[] {
  const watched = ["pointermove", "pointerup", "pointercancel"];
  const live: { type: string; fn: unknown }[] = [];
  const realAdd = window.addEventListener;
  const realRemove = window.removeEventListener;

  window.addEventListener = ((
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    if (watched.includes(type)) {
      const entry = { type, fn };
      live.push(entry);
      const signal = typeof opts === "object" && opts !== null ? opts.signal : undefined;
      signal?.addEventListener("abort", () => {
        const i = live.indexOf(entry);
        if (i >= 0) live.splice(i, 1);
      });
    }
    return realAdd.call(window, type, fn, opts);
  }) as typeof window.addEventListener;

  window.removeEventListener = ((
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: boolean | EventListenerOptions,
  ) => {
    const i = live.findIndex((e) => e.type === type && e.fn === fn);
    if (i >= 0) live.splice(i, 1);
    return realRemove.call(window, type, fn, opts);
  }) as typeof window.removeEventListener;

  onTestFinished(() => {
    window.addEventListener = realAdd;
    window.removeEventListener = realRemove;
  });
  return () => live.map((e) => e.type).sort();
}

describe("the gutter resizes the panel up and down", () => {
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
    const live = liveDragListeners();
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 300 }),
    );
    expect(live()).not.toEqual([]);
    unmount();
    expect(live()).toEqual([]);
  });
});

/**
 * A DRAG THAT ENDS ANY OTHER WAY THAN `pointerup` USED TO LEAVE ITS LISTENERS
 * ON THE WINDOW FOREVER.
 *
 * `pointerup` was the only remover, so a cancelled touch or pen drag (a scroll
 * takeover, palm rejection, the tab losing the pointer) stranded a
 * `pointermove` handler for the life of the page. Every pointer movement
 * anywhere in the lobby then paid a `getBoundingClientRect` on the content
 * column (a forced layout) and a signal write, for a drag nobody is doing. The
 * stranded pair was also unreachable: the component's cleanup holds one
 * `endDrag`, and the next pointerdown overwrote it.
 *
 * The assertions below are about what is still attached to `window`, not about
 * which call detached it, so they hold whichever way the fix removes them.
 */
describe("a drag never strands a listener on the window", () => {
  /** The drag has started and the window is listening. */
  function press(gutter: Element, clientY: number, pointerId = 1): void {
    gutter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientY, pointerId }),
    );
  }

  it("lets go when the pointer is cancelled, not only when it is released", async () => {
    const { store, dock, container } = mountDock(false);
    await loaded(store);
    const body = container.querySelector(".tl-shell-body")!;
    const box = boxed(body, 100, 400); // the column runs y=100..500
    const gutter = container.querySelector(".tl-dock-gutter")!;
    const live = liveDragListeners();

    press(gutter, 300);
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 300 }));
    expect(dock.ratio()).toBe(50);

    // What a finger does when the browser decides the gesture was a scroll.
    window.dispatchEvent(new PointerEvent("pointercancel", {}));
    expect(live()).toEqual([]);

    // And the proof that it costs nothing afterwards: a later pointermove
    // neither measures the column nor moves the split.
    const measured = box.measured;
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 150 }));
    expect(box.measured).toBe(measured);
    expect(dock.ratio()).toBe(50);
  });

  it("stops showing the drag state when the pointer is cancelled", async () => {
    // Not cosmetic: `.tl-dock-dragging .tl-dock-body` is `pointer-events: none`
    // (sidebar.css), so a drag state left set by a cancelled drag leaves the
    // docked terminal unclickable until the panel is rebuilt.
    const { store, container } = mountDock(false);
    await loaded(store);
    boxed(container.querySelector(".tl-shell-body")!, 100, 400);
    const gutter = container.querySelector(".tl-dock-gutter")!;

    press(gutter, 300);
    expect(container.querySelector(".tl-dock")!.className).toContain("tl-dock-dragging");
    window.dispatchEvent(new PointerEvent("pointercancel", {}));
    expect(container.querySelector(".tl-dock")!.className).not.toContain("tl-dock-dragging");
  });

  it("does not accumulate a pair per drag", async () => {
    const { store, dock, container } = mountDock(false);
    await loaded(store);
    const body = container.querySelector(".tl-shell-body")!;
    const box = boxed(body, 100, 400);
    const gutter = container.querySelector(".tl-dock-gutter")!;
    const live = liveDragListeners();

    drag(gutter, [300, 300]);
    expect(live()).toEqual([]);
    const afterFirst = box.measured;

    // One move, one measurement. Two live handlers would measure twice.
    drag(gutter, [300, 200]);
    expect(box.measured - afterFirst).toBe(1);
    expect(live()).toEqual([]);
    expect(dock.ratio()).toBe(75);
  });

  it("does not strand the first drag when a second pointer lands on the gutter", async () => {
    // Two fingers on the gutter. A window `pointerup` reaches every drag's
    // handler at once, so the ordinary ending covers both; what the second
    // pointerdown used to break is the ONE reference the panel's cleanup
    // holds. It overwrote that, and the first drag's pair then outlived the
    // panel.
    const { store, container, unmount } = mountDock(false);
    await loaded(store);
    boxed(container.querySelector(".tl-shell-body")!, 100, 400);
    const gutter = container.querySelector(".tl-dock-gutter")!;
    const live = liveDragListeners();

    press(gutter, 300, 1);
    press(gutter, 250, 2);
    unmount();
    expect(live()).toEqual([]);
  });
});
