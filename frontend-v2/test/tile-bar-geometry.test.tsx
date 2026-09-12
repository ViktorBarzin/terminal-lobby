/**
 * CLICKING A TILE IS NOT A RESIZE.
 *
 * A tile IS the size of its tmux window: every visible tile fits its terminal
 * to its box and posts the grid it arrived at (`SessionView`'s `claimGrid` →
 * `POST /sessions/{name}/grid`), and that window is the size the session is for
 * EVERY device attached to it. So anything that changes a tile's box changes a
 * real tmux window, and a person elsewhere watches Claude re-wrap its output.
 *
 * THE DEFECT THIS FILE PINS. The session bar is gated on focus, which is right
 * — one bar per workspace, showing the focused tile's session. It was still
 * drawn INSIDE the focused slot, and it is `flex: 0 0 auto` at about 41px
 * (sidebar.css: 28px of controls, 6px of padding each side, a 1px border). So
 * moving focus from tile A to tile B grew A's terminal host by 41px and shrank
 * B's by 41px — about two rows at a 17px line — and both hosts' ResizeObservers
 * fired, both debounced fits landed, and both reached `claimGrid`. One click,
 * two real windows resized, for everyone attached to either.
 *
 * The fix is the design's own sentence: "session bar | one bar, showing the
 * focused tile's session" — one bar, in the SHELL. `App.tsx` renders a
 * `.tl-bar-host` between the shell bar and the shell body and hands it to every
 * mounted view; the focused `SessionView` portals its bar into it. A tile then
 * has no bar at all, and its box does not move when focus does.
 *
 * WHAT IS REAL HERE, and it is nearly everything: `<App/>`, `SessionView`,
 * `TerminalNative`, the fit guard, the grid claim, the workspace tree and the
 * rect arithmetic. Mocked: xterm and its fit addon (jsdom has no canvas), the
 * ttyd socket, `lib/lobby-api` (the documents the shell boots from, and the
 * grid claims this file counts), and `WorkspaceCanvas`, whose corvu half throws
 * on disposal under the dev build and whose rects here are the real `toRects`.
 *
 * jsdom RUNS NO LAYOUT, so the boxes are modelled — see `boxOf`. The model is
 * three facts, each of which the shipped CSS states and the first `describe`
 * below asserts against the real stylesheet: a tile is the size its rect says,
 * a `.tl-tile-header` and a `.tl-session-bar` inside that tile are `flex: 0 0
 * auto` boxes above the views, and what is left is the terminal's. The model
 * reads the DOM the real components produced; it decides nothing about whether
 * the bar is in the tile, which is the whole question.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, waitFor } from "@solidjs/testing-library";
import { createEffect, untrack } from "solid-js";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";
import { toRects, type Rect, type TreeNode } from "../src/store/workspace-tree";

/* ------------------------------------------------------------------ *
 * The modelled layout. jsdom answers 0 for every box, so these are the
 * numbers a browser would produce from the shipped CSS.
 * ------------------------------------------------------------------ */

/** 1440x900, less the 260px sidebar and the 37px shell bar. */
const SHELL = { width: 1180, height: 776 };
/** `.tl-tile-header` — "roughly 24px" (TileHeader's docblock, src/tiles.css). */
const TILE_HEADER_H = 24;
/**
 * `.tl-session-bar` — 28px of controls + 6px of padding each side + a 1px
 * border, the arithmetic the design, `TileHeader` and `SessionView` all quote.
 *
 * A real browser at 1440x900 measured 49px on 2026-09-12, with the labels
 * showing beside the icons. The smaller figure is kept because what these tests
 * assert is "unchanged", not "this many" — and because it is the number the
 * rest of the codebase reads.
 */
const SESSION_BAR_H = 41;
/** One character cell of the default terminal font: what a fit divides by, so
 *  a box that loses the bar's height loses the terminal two or three rows.
 *  Measured in Chrome on the same run: the bar cost tmux 3 rows, 49 → 46. */
const CELL = { width: 9, height: 17 };

/** The box `el` would be laid out in, from the DOM the components produced. */
function boxOf(el: HTMLElement): { width: number; height: number } {
  const slot = el.closest<HTMLElement>(".tl-session-slot");
  // Outside a slot: the shell body, which is what `shellBox` measures.
  if (!slot) return SHELL;
  const rect = {
    width: Number.parseFloat(slot.style.width || "") || SHELL.width,
    height: Number.parseFloat(slot.style.height || "") || SHELL.height,
  };
  // Everything above the views in the slot's column, each `flex: 0 0 auto`.
  let chrome = 0;
  if (slot.querySelector(".tl-tile-header")) chrome += TILE_HEADER_H;
  if (slot.querySelector(".tl-session-bar")) chrome += SESSION_BAR_H;
  return { width: rect.width, height: Math.max(0, rect.height - chrome) };
}

/* ------------------------------------------------------------------ *
 * xterm and its fit addon, faked — but the fit really measures.
 * ------------------------------------------------------------------ */

const xt = vi.hoisted(() => {
  interface Disposable {
    dispose(): void;
  }
  const nothing: Disposable = { dispose() {} };
  interface Addon {
    activate(t: unknown): void;
  }

  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    host: HTMLElement | null = null;
    element: HTMLElement | null = null;
    readonly onDataCbs: ((data: string) => void)[] = [];
    modes = { mouseTrackingMode: "any" as const };
    focused = 0;

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      made.terminals.push(this);
    }
    loadAddon(addon: Addon): void {
      addon.activate(this);
    }
    open(host: HTMLElement): void {
      this.host = host;
      const element = document.createElement("div");
      element.className = "xterm";
      host.appendChild(element);
      this.element = element;
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      element.appendChild(screen);
      const ta = document.createElement("textarea");
      ta.className = "xterm-helper-textarea";
      host.appendChild(ta);
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      return false;
    }
    getSelection(): string {
      return "";
    }
    clearSelection(): void {}
    onData(cb: (data: string) => void): Disposable {
      this.onDataCbs.push(cb);
      return nothing;
    }
    onBinary(): Disposable {
      return nothing;
    }
    onBell(): Disposable {
      return nothing;
    }
    paste(): void {}
    write(): void {}
    focus(): void {
      this.focused++;
    }
    refresh(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  }

  /**
   * The fit, doing the one thing a real one does: divide the host's box by a
   * character cell. That is what makes 41px of chrome two rows of tmux window,
   * which is the defect measured rather than asserted.
   */
  class FakeFitAddon {
    term: FakeTerminal | null = null;
    fits = 0;
    constructor() {
      made.fitAddons.push(this);
    }
    activate(t: unknown): void {
      this.term = t as FakeTerminal;
    }
    dispose(): void {}
    fit(): void {
      this.fits++;
      const t = this.term;
      if (!t?.host) return;
      const box = made.boxOf(t.host);
      t.cols = Math.max(2, Math.floor(box.width / made.cell.width));
      t.rows = Math.max(1, Math.floor(box.height / made.cell.height));
    }
  }

  const made = {
    terminals: [] as FakeTerminal[],
    fitAddons: [] as FakeFitAddon[],
    /** Filled in below, once `boxOf` exists in module scope. */
    boxOf: (_el: HTMLElement) => ({ width: 0, height: 0 }),
    cell: { width: 9, height: 17 },
  };
  return { FakeTerminal, FakeFitAddon, made };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xt.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xt.FakeFitAddon }));

/* ------------------------------------------------------------------ *
 * The world the shell boots into, and every grid it claimed.
 * ------------------------------------------------------------------ */

const world = vi.hoisted(() => ({
  sessions: [] as { name: string; attached: number; created: number }[],
  doc: {
    version: 1,
    workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
  },
  /** Every `POST /sessions/{name}/grid` the page made. */
  grids: [] as { session: string; cols: number; rows: number }[],
  store: null as LobbyStore | null,
}));

vi.mock("../src/lib/lobby-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/lobby-api")>();
  return {
    ...real,
    lobbyApi: {
      ...real.lobbyApi,
      whoami: async (): Promise<Whoami> => ({ authentik: "wizard", osUser: "wizard" }),
      listSessions: async (): Promise<Session[]> => world.sessions as Session[],
      getLayout: async (): Promise<Layout> => emptyLayout(),
      putLayout: async (): Promise<void> => {},
    },
    getWorkspaces: async () => ({ ...emptyWorkspaces(), ...world.doc }),
    putWorkspaces: async (): Promise<void> => {},
    availableCommands: async () => ({}),
    listUsers: async (): Promise<string[]> => [],
    setSessionGrid: async (session: string, cols: number, rows: number) => {
      world.grids.push({ session, cols, rows });
    },
  };
});

vi.mock("../src/components/Sidebar", () => ({
  Sidebar: (props: { store: LobbyStore }) => {
    world.store = props.store;
    return <aside class="tl-sidebar" />;
  },
}));

vi.mock("../src/components/WorkspaceCanvas", () => ({
  WorkspaceCanvas: (props: {
    tree: TreeNode;
    container: { width: number; height: number };
    onRects: (rects: Rect[]) => void;
  }) => {
    createEffect(() => {
      const rects = toRects(props.tree, props.container);
      untrack(() => props.onRects(rects));
    });
    return <div class="tl-tiles" />;
  },
}));

import { App } from "../src/components/App";

// The fit addon measures through the same model everything else does.
xt.made.boxOf = boxOf;
xt.made.cell = CELL;

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

/**
 * The ResizeObserver, as a registry that re-measures through the model.
 *
 * It is what makes this file's claim a real one rather than a structural
 * assertion: a tile whose box changed reports it the way a browser would, the
 * terminal refits on that report, and the refit claims the grid it lands on.
 * `settleLayout()` below is the reflow — it fires for an observed element whose
 * MODELLED box moved, and for no other.
 */
interface Watched {
  el: HTMLElement;
  fire: () => void;
  box: { width: number; height: number };
}
let watched: Watched[] = [];
class ModelResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe(el: Element): void {
    const target = el as HTMLElement;
    watched.push({ el: target, fire: () => this.cb(), box: boxOf(target) });
  }
  unobserve(el: Element): void {
    watched = watched.filter((w) => w.el !== el);
  }
  disconnect(): void {
    watched = watched.filter((w) => w.fire !== this.cb);
  }
}

/** Re-measure every observed element and report the ones that moved. */
function settleLayout(): void {
  for (const w of watched) {
    const box = boxOf(w.el);
    if (box.width === w.box.width && box.height === w.box.height) continue;
    w.box = box;
    w.fire();
  }
}

const realMatchMedia = window.matchMedia;

/** A 1440x900 desktop: a FINE pointer, so no tile opens in Watch mode (a
 *  watching tile never claims a grid, which would make every count here zero). */
function stubDesktop(): void {
  window.matchMedia = ((q: string) =>
    ({
      media: q,
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const session = (name: string) => ({ name, attached: 1, created: 1_700_000_000 });

beforeEach(() => {
  stubDesktop();
  sockets = [];
  watched = [];
  xt.made.terminals.length = 0;
  xt.made.fitAddons.length = 0;
  world.sessions = [];
  world.doc = { version: 1, workspaces: [] };
  world.grids = [];
  world.store = null;
  localStorage.clear();
  window.location.hash = "";
  // Assigned rather than stubbed, and never taken away: a terminal's mount is
  // async, so one still resolving its two dynamic imports when a test ends
  // reaches for `ResizeObserver` after the teardown would have removed it —
  // which vitest reports as an unhandled rejection and fails the whole FILE
  // while every assertion in it passes. The same shape test/tile-focus.test.tsx
  // uses, for the same reason.
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver = ModelResizeObserver;
  g.WebSocket = FakeSocket;
  g.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: "qa-token" }),
    text: async () => "",
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return boxOf(this).width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return boxOf(this).height;
    },
  });
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
  }
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  for (const prop of ["clientWidth", "clientHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  window.location.hash = "";
});

/* ------------------------------------------------------------------ *
 * A two-tile workspace, booted the way a person reaches one.
 * ------------------------------------------------------------------ */

/** Let every pending microtask run: the two dynamic imports and /token. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Past the terminal's 120ms refit debounce and the view's 250ms reclaim. */
const QUIET_MS = 400;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Workspace {
  root: HTMLElement;
  /** This tile's slot, by session name. */
  slot: (name: string) => HTMLElement;
  /** This tile's terminal host — the element the fit measures. */
  host: (name: string) => HTMLElement;
  /** Click into this tile's terminal, which is what moves focus. */
  click: (name: string) => void;
  /** Everything that happened since: reflow, refit, claim. */
  settle: () => Promise<void>;
}

/**
 * Boot into a two-tile workspace with `auth` focused.
 *
 * THE MEMBERS ARRIVE ONE AT A TIME, which is a harness accommodation and not a
 * claim about the app: vitest 2.1.9 hands the REAL module to concurrent dynamic
 * imports of a mocked id (measured in test/tile-focus.test.tsx on 2026-09-12),
 * so two terminals booting in one tick would leave one of them running a real
 * xterm against jsdom's missing canvas. `deploy` therefore joins the live list
 * on a later poll — which is also an ordinary thing to happen, since a kill
 * keeps membership and a restored session comes back to its workspace.
 */
async function openWorkspace(): Promise<Workspace> {
  world.sessions = [session("auth")];
  world.doc = {
    version: 1,
    workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
  };
  window.location.hash = "#auth";
  const { container } = render(() => <App />);
  const root = container as HTMLElement;

  /**
   * A tile's slot, found through the DOM by the name its header shows.
   *
   * By the header rather than by mount order, because mount order is
   * keepalive's and this file has no business depending on it. Untitled
   * sessions read as their own name (`sessionLabel`), which is what these two
   * are.
   */
  const slot = (name: string): HTMLElement => {
    const found = [...root.querySelectorAll<HTMLElement>(".tl-session-slot")].find(
      (el) => el.querySelector(".tl-tile-title")?.textContent?.trim() === name,
    );
    if (!found) throw new Error(`no tile for ${name}`);
    return found;
  };
  /** The element TerminalNative hangs its xterm off, and the box a fit reads. */
  const host = (name: string): HTMLElement => {
    const el = slot(name).querySelector<HTMLElement>(".tl-terminal-native");
    if (!el) throw new Error(`no terminal host for ${name}`);
    return el;
  };

  // One session on screen, its terminal up and its socket accepted.
  await waitFor(() => expect(xt.made.terminals).toHaveLength(1));
  await settle();
  sockets.forEach((s) => s.accept());

  // The second member joins the live list: the workspace is now two tiles.
  world.sessions = [session("auth"), session("deploy")];
  await world.store?.refresh();
  await waitFor(() => expect(root.querySelectorAll(".tl-session-slot.tl-tiled")).toHaveLength(2));
  await waitFor(() => expect(xt.made.terminals).toHaveLength(2));
  await settle();
  sockets.forEach((s) => s.readyState === FakeSocket.CONNECTING && s.accept());

  const ws: Workspace = {
    root,
    slot,
    host,
    click: (name) => {
      // The real path: a capture-phase pointerdown on the slot, landing
      // anywhere that is not the header, moves focus to that tile (App.tsx).
      host(name).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    },
    settle: async () => {
      settleLayout();
      await wait(QUIET_MS);
      await settle();
      settleLayout();
      await wait(QUIET_MS);
      await settle();
    },
  };
  await ws.settle();
  return ws;
}

/* ------------------------------------------------------------------ *
 * 1. The CSS the model rests on
 * ------------------------------------------------------------------ */

const CSS = {
  app: readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"),
  sidebar: readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8"),
};

/** The declaration block of the rule whose selector is exactly `selector`. */
function ruleFor(css: string, selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]?.trim().split("\n").pop()?.trim();
    if (sel === selector) return m[2] ?? "";
  }
  return null;
}

describe("the bar takes height from whatever column it is in", () => {
  /** Why 41px inside a tile is 41px off a terminal: the bar is an in-flow box
   *  at its natural height, first in a column that the views then share. */
  it("is a fixed-height flex item", () => {
    expect(ruleFor(CSS.sidebar, ".tl-session-bar")).toMatch(/flex:\s*0 0 auto/);
    expect(ruleFor(CSS.sidebar, ".tl-session-view")).toMatch(/flex-direction:\s*column/);
    expect(ruleFor(CSS.app, ".tl-session-slot")).toMatch(/flex-direction:\s*column/);
  });

  /** And why it costs a TILE nothing now: the shell's strip is not a box, so
   *  the bar lands as a direct flex child of the shell column instead. */
  it("is hosted by something with no box of its own", () => {
    // The rule carries both selectors; `ruleFor` reads the last line of the
    // group, which is the portal container Solid appends inside the strip.
    const host = ruleFor(CSS.sidebar, ".tl-bar-host > div");
    expect(host, "no .tl-bar-host rule").not.toBeNull();
    expect(host).toMatch(/display:\s*contents/);
    expect(CSS.sidebar).toContain(".tl-bar-host,");
  });
});

/* ------------------------------------------------------------------ *
 * 2. The geometry, through the running shell
 * ------------------------------------------------------------------ */

describe("moving focus between two tiles moves nothing", () => {
  it("draws no session bar inside any tile", async () => {
    const ws = await openWorkspace();
    for (const name of ["auth", "deploy"]) {
      expect(ws.slot(name).querySelector(".tl-session-bar"), `${name} carries a bar`).toBeNull();
    }
    ws.click("deploy");
    await ws.settle();
    for (const name of ["auth", "deploy"]) {
      expect(
        ws.slot(name).querySelector(".tl-session-bar"),
        `${name} carries a bar after the click`,
      ).toBeNull();
    }
  });

  /** One bar for the tab, and it is in the shell where the design put it. */
  it("draws exactly one, in the shell's strip", async () => {
    const ws = await openWorkspace();
    const bars = ws.root.querySelectorAll(".tl-session-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest(".tl-bar-host"), "the bar is not in the shell strip").not.toBeNull();
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR. Both terminal hosts have the same box
   * after the click that they had before it. With the bar inside the focused
   * slot, `auth` grew by 41px and `deploy` shrank by 41px.
   */
  it("leaves both terminal boxes exactly as they were", async () => {
    const ws = await openWorkspace();
    const before = { auth: boxOf(ws.host("auth")), deploy: boxOf(ws.host("deploy")) };
    ws.click("deploy");
    await ws.settle();
    expect(boxOf(ws.host("auth"))).toEqual(before.auth);
    expect(boxOf(ws.host("deploy"))).toEqual(before.deploy);
  });

  /**
   * AND THE CONSEQUENCE, which is the part a person elsewhere feels: no tmux
   * window is resized by a click. The claim goes out on the same path it
   * always does — reflow, ResizeObserver, debounced fit, `claimGrid` — so a box
   * that moved would show up here as a POST, and two boxes moving as two.
   */
  it("claims no grid", async () => {
    const ws = await openWorkspace();
    world.grids = [];
    ws.click("deploy");
    await ws.settle();
    expect(world.grids).toEqual([]);
  });

  /**
   * THE HARNESS IS LIVE, which the test above cannot show on its own: an empty
   * list is also what a dead ResizeObserver, an unaccepted socket or a tile
   * opened in Watch mode would produce. A tile that really does change size —
   * a divider dragged, a window resized — still claims, and says the new grid.
   */
  it("but still claims when a tile really does change size", async () => {
    const ws = await openWorkspace();
    world.grids = [];
    const tile = ws.slot("deploy");
    const was = boxOf(ws.host("deploy"));
    tile.style.height = `${Math.round(was.height / 2)}px`;
    await ws.settle();
    expect(world.grids.map((g) => g.session)).toContain("deploy");
    const claimed = world.grids.find((g) => g.session === "deploy");
    expect(claimed?.rows, "the claim carried the old grid").toBeLessThan(
      Math.floor(was.height / CELL.height),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. A lone session is unchanged
 * ------------------------------------------------------------------ */

describe("a lone session keeps the bar where it has always been", () => {
  it("puts it at the top of the shell column, directly above the body", async () => {
    world.sessions = [session("solo")];
    world.doc = { version: 1, workspaces: [] };
    window.location.hash = "#solo";
    const { container } = render(() => <App />);
    const root = container as HTMLElement;
    await waitFor(() => expect(root.querySelector(".tl-session-bar")).not.toBeNull());

    const content = root.querySelector<HTMLElement>(".tl-shell-content");
    if (!content) throw new Error("no shell content");
    // `.tl-bar-host` and the portal container inside it are both
    // `display: contents`, so what a browser lays out in this column is:
    // the shell bar, the session bar, then the body. Which is the order the
    // bar sat in when it was the first child of `.tl-session-view`.
    const laid = [...content.children].flatMap((el) =>
      el.classList.contains("tl-bar-host")
        ? [...el.children].flatMap((c) => [...c.children].map((g) => g.className))
        : [el.className],
    );
    expect(laid).toEqual(["tl-shellbar", "tl-session-bar", "tl-shell-body"]);
  });

  it("keeps it out of the session's own slot", async () => {
    world.sessions = [session("solo")];
    world.doc = { version: 1, workspaces: [] };
    window.location.hash = "#solo";
    const { container } = render(() => <App />);
    const root = container as HTMLElement;
    await waitFor(() => expect(root.querySelector(".tl-session-bar")).not.toBeNull());
    expect(root.querySelector(".tl-session-slot .tl-session-bar")).toBeNull();
  });
});
