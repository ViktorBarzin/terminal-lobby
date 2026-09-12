/**
 * THE SHELL, RUNNING. Everything here mounts the real `<App/>`.
 *
 * Every defect this file covers sat in a JOINT: two parts that each had a green
 * unit test, wired together wrongly. `workspaceTilesFor` was right and was
 * handed the wrong `live` set; `removeAt` was right and was never called;
 * `askConn` was right and was registered by four tiles into one `let`; the
 * tiled slot's CSS was right and left the dock with nothing to lay out. A suite
 * of 5,621 tests over the parts said nothing about any of them, so these
 * assertions are made against the assembled shell rather than against the
 * pieces — the first file in this suite to render `<App/>` itself.
 *
 * What that costs is five mocks, and each one is scenery rather than subject:
 * `SessionView` (a real one boots xterm, a socket and an SSE stream; the mock
 * keeps its `status` props, which is what two of these tests drive),
 * `Sidebar`/`SettingsPanel` (chrome this file never presses; the panel's mock
 * keeps the `connection` object the Right now panel is handed), `lib/lobby-api`
 * (the documents the shell boots from), and `WorkspaceCanvas`, whose own
 * contract the stand-in below keeps and whose corvu half it leaves out for a
 * reason recorded there. The Dock, the tree, the rect arithmetic, the stores
 * and every wire between them are real.
 *
 * jsdom runs no layout, so the shell is given a box the way
 * `workspace-canvas.test.tsx` gives corvu one: `clientWidth`/`clientHeight` on
 * the prototype, which is what `mountShellBody` measures, plus the
 * `offsetWidth`/`offsetHeight` corvu reads and a no-op `ResizeObserver`. The
 * numbers are a 1440x900 desktop minus the sidebar and the shell bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, waitFor } from "@solidjs/testing-library";
import { createEffect, untrack, type ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { ConnectionControl } from "../src/diagnostics/status-store";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { keyOf } from "../src/store/keepalive";
import { DOCK_RATIO_DEFAULT } from "../src/store/dock.logic";
import { WORKSPACES_KEY } from "../src/store/workspaces";
import {
  autoArrange,
  leaf,
  split,
  toRects,
  type Rect,
  type TreeNode,
} from "../src/store/workspace-tree";

type ViewProps = ComponentProps<typeof RealSessionView>;

// ---- the world the shell boots into ---------------------------------------

/** Everything the mocked api answers with, and everything it recorded. */
const world = vi.hoisted(() => ({
  /** `owner` is present only for a session somebody else runs and shared with
   *  you — the same convention `Session.owner` and `WorkspaceMember.owner`
   *  carry, so a session of your own is one without it. */
  sessions: [] as { name: string; attached: number; created: number; owner?: string }[],
  /** Reject `listSessions` — a tmux-api restarting under a page reload. */
  sessionsFail: false,
  /**
   * The membership document tmux-api serves. A member is `{name, owner?}`
   * (types/lobby.ts, `WorkspaceMember`) with the owner ABSENT for a session of
   * your own, which is the shape on the wire and the shape `App.tsx` compares
   * by key — `ms(...)` below writes the ordinary all-mine case.
   */
  doc: {
    version: 1,
    workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
  },
  puts: [] as unknown[],
  /** The mounted SessionViews, by session name. */
  views: new Map<string, ViewProps>(),
  /** What the Right now panel was handed. */
  connection: null as ConnectionControl | null,
  /** Is a sidebar card in the air (dnd/sidebar's own signal, stubbed). */
  dragging: false,
}));

vi.mock("../src/lib/lobby-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/lobby-api")>();
  return {
    ...real,
    lobbyApi: {
      ...real.lobbyApi,
      whoami: async (): Promise<Whoami> => ({ authentik: "wizard", osUser: "wizard" }),
      listSessions: async (): Promise<Session[]> => {
        if (world.sessionsFail) throw new real.ApiError(503, "tmux-api restarting");
        return world.sessions as Session[];
      },
      getLayout: async (): Promise<Layout> => emptyLayout(),
      putLayout: async (): Promise<void> => {},
    },
    getWorkspaces: async () => ({ ...emptyWorkspaces(), ...world.doc }),
    putWorkspaces: async (doc: unknown): Promise<void> => {
      world.puts.push(doc);
    },
    availableCommands: async () => ({}),
    listUsers: async (): Promise<string[]> => [],
  };
});

vi.mock("../src/components/SessionView", () => ({
  SessionView: (props: ViewProps) => {
    world.views.set(props.session, props);
    return <div class="tl-session-view" data-session={props.session} />;
  },
}));

vi.mock("../src/components/Sidebar", () => ({
  Sidebar: () => <aside class="tl-sidebar" />,
}));

/**
 * The canvas, as its own contract describes it and nothing more: one rect per
 * tile from the tree it is given, in the box it is given, emitted when either
 * moves. `toRects` is the real function — the arithmetic under test in
 * `workspace-tree.test.ts` — so the rects the shell reads here are the rects it
 * reads in a browser.
 *
 * corvu is what is left out, and the reason is a disposal-time throw that is
 * not this file's subject: a controlled `@corvu/resizable` root reports its
 * sizes while it is being torn down, `WorkspaceCanvas.onSizes` reads
 * `props.tree` there, and that prop is an unmounted `<Show>` accessor — which
 * under the dev build throws and takes the rest of Solid's update flush with
 * it, leaving the tiles of the workspace that just collapsed on screen. Every
 * test below that leaves or collapses a workspace hits it.
 */
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

vi.mock("../src/components/SettingsPanel", () => ({
  SettingsPanel: (props: { connection: ConnectionControl }) => {
    world.connection = props.connection;
    return <div class="tl-settings" />;
  },
}));

// Only the one accessor: `DRAG_START_EVENT` stays the real constant, so the
// event this file dispatches is the event `dnd/tiles.ts` listens for.
vi.mock("../src/dnd/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dnd/sidebar")>()),
  sessionDragActive: () => world.dragging,
}));

import { App, reconcileTree } from "../src/components/App";
import { DRAG_START_EVENT } from "../src/dnd/sidebar";

// ---- a shell with a box ----------------------------------------------------

/** 1440x900, less the 260px sidebar and the 37px shell bar. */
const SHELL = { width: 1180, height: 776 };

function installLayout(): void {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver as unknown as typeof ResizeObserver);
  const proto = HTMLElement.prototype;
  for (const [prop, value] of [
    ["clientWidth", SHELL.width],
    ["clientHeight", SHELL.height],
    ["offsetWidth", SHELL.width],
    ["offsetHeight", SHELL.height],
  ] as const) {
    Object.defineProperty(proto, prop, { configurable: true, get: () => value });
  }
  // The composer focuses its field on mount and jsdom has no scrollIntoView.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
  }
}

const session = (name: string) => ({ name, attached: 1, created: 1_700_000_000 });

/** Members of your own, which is an ABSENT owner rather than your own name
 *  (types/lobby.ts, `WorkspaceMember.owner`). Every workspace in this file is
 *  all-mine, so the owner never appears. */
const ms = (...names: string[]) => names.map((name) => ({ name }));

beforeEach(() => {
  installLayout();
  world.sessions = [];
  world.sessionsFail = false;
  world.doc = { version: 1, workspaces: [] };
  world.puts = [];
  world.views.clear();
  world.connection = null;
  world.dragging = false;
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const prop of ["clientWidth", "clientHeight", "offsetWidth", "offsetHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  window.location.hash = "";
});

interface Shell {
  root: HTMLElement;
  /** One mounted SessionView's props, by session name. */
  view: (name: string) => ViewProps;
  /** The slots a tree gave a rectangle to, by session name. */
  tiles: () => Map<string, HTMLElement>;
  body: () => HTMLElement;
}

/**
 * Boot the shell with `selected` on screen, and wait for the first poll.
 *
 * The URL is how a session is selected here: the sidebar is scenery and
 * `readInitialSelection` reads the hash, which is also how a shared link opens
 * a member's workspace.
 */
async function openShell(selected: string): Promise<Shell> {
  window.location.hash = `#${selected}`;
  const { container } = render(() => <App />);
  const root = container as HTMLElement;
  const tiles = () => {
    const out = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(".tl-session-slot.tl-tiled")) {
      const name = el.querySelector<HTMLElement>("[data-session]")?.dataset.session;
      if (name) out.set(name, el);
    }
    return out;
  };
  const body = () => {
    const el = root.querySelector<HTMLElement>(".tl-shell-body");
    if (!el) throw new Error("no shell body");
    return el;
  };
  const view = (name: string): ViewProps => {
    const props = world.views.get(name);
    if (!props) throw new Error(`no SessionView for ${name}`);
    return props;
  };
  await waitFor(() => expect(world.views.get(selected)).toBeTruthy());
  return { root, tiles, body, view };
}

/**
 * How long a change to the session list takes to reach the shell: the lobby's
 * own poll interval (store/lobby.ts, `pollMs` — 5s), plus room for the answer.
 *
 * Waited out with real timers rather than jumped with fake ones. The poll
 * schedules its next turn from its own ANSWER, so a fake clock advanced past a
 * timer that does not exist yet lands nowhere; and the store's `online` wake,
 * which would have made this instant, is refused here for a reason this file
 * could not pin down (the wake runs, the request does not follow).
 */
const POLL_WAIT_MS = 8_000;

/** A tile's rect, as the shell wrote it onto the slot. */
function rectOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const px = (v: string) => Math.round(Number.parseFloat(v || "0"));
  return {
    x: px(el.style.left),
    y: px(el.style.top),
    width: px(el.style.width),
    height: px(el.style.height),
  };
}

// ---- the dock is the foot of the shell body -------------------------------

/**
 * `.tl-shell-body` is a flex column, and a workspace takes every one of its
 * visible children OUT of flow: the tiled slots are absolute, the hidden ones
 * are `display: none`, the canvas and the drop shadow are absolute, and the
 * composer is not rendered. That leaves `<Dock>` as the only in-flow child of a
 * `justify-content: flex-start` column, so it lays out at the TOP.
 *
 * Measured in real Chrome at 1440x900 with the dock at its 30% default, before
 * the fix: the shell body was 1180x776 at y=37, and the dock was 1180x233 at
 * y=37 — over the first row of tiles, headers included, while `tileArea()` had
 * already taken those same 233px off the BOTTOM of the tree and left a 233px
 * empty strip there. After: the dock is 1180x233 at y=580, which is exactly
 * where the tiles end.
 *
 * The fix is a rule rather than a wrapper element, and that was measured too: a
 * positioned in-flow container around the slots re-homes `.tl-tiles` (tiles.css)
 * and `.tl-offstage` (app.css), both pinned with `bottom: var(--tl-dock-h)`, so
 * the dock comes off twice — the divider skeleton came out 1180x380 inside a
 * 1180x543 tile area, up to 163px of drift between a divider and its tile.
 *
 * jsdom has no layout, so what is asserted is the flow itself: which children
 * take part in it, in what order, and where that puts the dock's top edge.
 */
const CSS = {
  app: readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"),
  sidebar: readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8"),
};

/** The declaration block of the rule whose selector is exactly `selector`, or
 *  null when no rule carries it. */
function ruleFor(css: string, selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]?.trim().split("\n").pop()?.trim();
    if (sel === selector) return m[2] ?? "";
  }
  return null;
}

/** One declaration out of a rule. "" for a rule that does not set it, and for
 *  a selector no rule carries — both mean the same thing to a browser. */
function declared(css: string, selector: string, prop: string): string {
  const rule = ruleFor(css, selector);
  if (rule === null) return "";
  const found = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule);
  return found?.[1]?.trim() ?? "";
}

/** Does an element with these classes take part in its parent's flow? */
function inFlow(el: HTMLElement): boolean {
  if (el.classList.contains("tl-hidden")) return false; // display: none
  if (el.classList.contains("tl-offstage")) return false; // absolute
  if (el.classList.contains("tl-tiled")) return false; // absolute
  if (el.classList.contains("tl-tiles")) return false; // absolute (tiles.css)
  if (el.classList.contains("tl-tile-shadow")) return false; // absolute, inline
  return true;
}

/**
 * Where the dock's top edge lands in the shell body, given what is still in
 * that column's flow and what the stylesheet says about the panel itself.
 *
 * A column flex container, `justify-content: flex-start`, one child with a
 * height of its own (the dock's `<ratio>%`) and siblings that grow: the dock
 * starts after whatever is in flow above it, and `margin-top: auto` takes the
 * free space instead. That is the whole model, and it is enough — the numbers
 * it produces were checked against Chrome before and after the fix.
 */
function dockTop(body: HTMLElement, height: number, dockPx: number): number {
  const children = [...body.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  const dock = children.find((c) => c.classList.contains("tl-dock"));
  if (!dock) throw new Error("the dock is not on screen");
  const above = children.slice(0, children.indexOf(dock)).filter(inFlow);
  if (declared(CSS.app, ".tl-shell-body > .tl-dock", "margin-top") === "auto") {
    return height - dockPx;
  }
  // Everything still in flow above it grows into the free space, so the panel
  // begins where they end; with none, it begins at the top of the column.
  return above.length > 0 ? height - dockPx : 0;
}

describe("the dock is the foot of the shell body", () => {
  it("lays out below the tiles rather than over them", async () => {
    world.sessions = [session("auth"), session("deploy")];
    world.doc = { version: 1, workspaces: [{ id: "w1", members: ms("auth", "deploy") }] };
    const shell = await openShell("auth");
    await waitFor(() => expect(shell.tiles().size).toBe(2));

    // Ctrl+J, the chord itself: the shell's own window listener, the real dock
    // store, and the panel it mounts at its default ratio.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true }));
    await waitFor(() => expect(shell.body().querySelector(".tl-dock")).toBeTruthy());

    const dockPx = Math.round((SHELL.height * DOCK_RATIO_DEFAULT) / 100);
    const top = dockTop(shell.body(), SHELL.height, dockPx);

    // The tiles own everything above the panel, and the panel starts where they
    // end. Before the fix this was 0: the dock was the first in-flow box, so it
    // drew over the top of the tree while the tree left the bottom empty.
    expect(top).toBe(SHELL.height - dockPx);
    for (const [name, tile] of shell.tiles()) {
      const r = rectOf(tile);
      expect(`${name} ends at ${r.y + r.height}`).toBe(`${name} ends at ${top}`);
    }
  });

  it("keeps the tiled slot out of flow, which is why the rule is needed", () => {
    expect(declared(CSS.app, ".tl-session-slot.tl-tiled", "position")).toBe("absolute");
    expect(declared(CSS.sidebar, ".tl-shell-body", "flex-direction")).toBe("column");
  });
});

// ---- a failed first poll keeps the workspace ------------------------------

describe("the workspace survives a poll that failed", () => {
  it("does not read an empty session list as every member being dead", async () => {
    // Reload the tab while tmux-api is restarting. `setLoading(false)` runs on
    // the failure path too (lobby.ts), so `loading()` is a lie here and
    // `polls()` is the honest question — which is what `liveNames()` twelve
    // lines above the tiles memo already asked.
    world.sessionsFail = true;
    world.sessions = [];
    world.doc = { version: 1, workspaces: [{ id: "w1", members: ms("auth", "deploy") }] };
    const shell = await openShell("auth");
    // Wait for the shell to have HEARD the failure. `creating` is
    // `!store.loading() && the list does not name it`, so it going true is the
    // shell saying "the session list has answered, and it is empty" — which is
    // the exact moment the workspace used to collapse.
    await waitFor(() => expect(shell.view("auth").creating).toBe(true));
    await waitFor(() => expect([...shell.tiles().keys()].sort()).toEqual(["auth", "deploy"]));
    // And nothing was written: a workspace that looks empty must not be
    // rewritten out from under the other tabs.
    expect(world.puts).toEqual([]);
  });
});

// ---- a dead member's tile closes, its siblings reflow ---------------------

describe("a member that dies", () => {
  it("closes its tile and leaves the arrangement alone", {
    timeout: POLL_WAIT_MS + 8_000,
  }, async () => {
    // A hand-dragged 2x2: a row of two columns, the left one dragged to 35/65.
    const A = keyOf({ name: "auth" });
    const B = keyOf({ name: "deploy" });
    const C = keyOf({ name: "docs" });
    const D = keyOf({ name: "logs" });
    const tree: TreeNode = split(
      "row",
      [split("column", [leaf(A), leaf(B)], [0.35, 0.65]), split("column", [leaf(C), leaf(D)])],
      [0.5, 0.5],
    );
    // The store's own document shape: id → arrangement, nothing else.
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ w1: tree }));
    world.sessions = ["auth", "deploy", "docs", "logs"].map(session);
    world.doc = {
      version: 1,
      workspaces: [{ id: "w1", members: ms("auth", "deploy", "docs", "logs") }],
    };
    const shell = await openShell("auth");
    await waitFor(() => expect(shell.tiles().size).toBe(4));
    const before = rectOf(shell.tiles().get("auth")!);
    expect(before.height).toBe(Math.round(SHELL.height * 0.35));

    // `docs` is killed. Its seat stays in the membership document (a kill keeps
    // membership) and its tile goes.
    world.sessions = ["auth", "deploy", "logs"].map(session);
    await waitFor(() => expect(shell.tiles().size).toBe(3), { timeout: POLL_WAIT_MS });

    // The left column is untouched: 35/65 is this device's arrangement and a
    // death in the other column is not a reason to re-derive it. A rebuild
    // through `autoArrange` would make every tile the same size.
    expect(rectOf(shell.tiles().get("auth")!)).toEqual(before);
    // And the dead tile's space went to its own sibling, which now has the
    // whole right-hand column.
    const logs = rectOf(shell.tiles().get("logs")!);
    expect(logs.height).toBe(SHELL.height);
    expect(world.puts).toEqual([]);
  });
});

// ---- a shared session is a tile like any other ----------------------------

/**
 * A WORKSPACE MAY HOLD A SESSION SOMEBODY SHARED WITH YOU, and the write that
 * follows a gesture has to hand its OWNER back.
 *
 * A member is `{name, owner?}` all the way down — `types/lobby.ts`, tmux-api's
 * `WorkspaceMember`, and the `SessionRef` the project store already keys a
 * session by — because a tmux name is unique only inside one user's server.
 * The tile layer keys by `keyOf`, which carries the owner, so the one place it
 * can be dropped is the conversion back: a write that sent `sessionOf(key).name`
 * turned emo's shared session into a session of your own, and tmux-api then
 * resolved it to a name you may not even have.
 *
 * Driven through the real close control rather than through `writeMembership`,
 * because the unit was never the half that was wrong.
 */
describe("a session emo shared with you", () => {
  it("keeps its owner in the document when a sibling tile is closed", async () => {
    world.sessions = [session("auth"), session("deploy"), { ...session("shared"), owner: "emo" }];
    world.doc = {
      version: 1,
      workspaces: [
        {
          id: "w1",
          members: [{ name: "auth" }, { name: "deploy" }, { name: "shared", owner: "emo" }],
        },
      ],
    };
    const shell = await openShell("auth");
    await waitFor(() => expect(shell.tiles().size).toBe(3));

    // Close `deploy` from its own tile header. A close acts on a live session,
    // so its seat goes — and the other two stay, emo's with its owner.
    const close = shell.root.querySelector<HTMLButtonElement>('button[aria-label="Close deploy"]');
    expect(close, "the deploy tile has a close control").toBeTruthy();
    close?.click();

    await waitFor(() => expect(world.puts).toHaveLength(1));
    expect(world.puts[0]).toEqual({
      version: 1,
      workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "shared", owner: "emo" }] }],
    });
  });
});

// ---- the connection channels follow focus ---------------------------------

/**
 * Open Settings the way a person does, and hand back the connection object the
 * Right now panel is driven by — the same one behind the session bar's badge.
 */
async function openRightNow(shell: Shell): Promise<ConnectionControl> {
  const button = shell.root.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
  if (!button) throw new Error("no Settings button");
  button.click();
  await waitFor(() => expect(world.connection).toBeTruthy());
  const conn = world.connection;
  if (!conn) throw new Error("the panel was handed no connection");
  return conn;
}

/** Click a tile, which is what moves focus between them (no focus-follows-mouse:
 *  a stray mouse movement would send the next keystrokes to another agent). */
function focusTile(shell: Shell, name: string): void {
  const tile = shell.tiles().get(name);
  const inside = tile?.querySelector<HTMLElement>(".tl-session-view");
  if (!inside) throw new Error(`no tile for ${name}`);
  inside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
}

const terminalRow = (conn: ConnectionControl) => conn.channels().find((c) => c.id === "terminal");

describe("the connection channels", () => {
  it("report and repair the FOCUSED tile, not the last one to mount", async () => {
    world.sessions = [session("auth"), session("deploy")];
    world.doc = { version: 1, workspaces: [{ id: "w1", members: ms("auth", "deploy") }] };
    const shell = await openShell("auth");
    await waitFor(() => expect(shell.tiles().size).toBe(2));

    // Both tiles are on screen, so both register and both report — which is
    // what every visible mount does. `deploy` mounts second, so before the fix
    // it owned all four channels for the whole tab.
    const reconnected: string[] = [];
    for (const name of ["auth", "deploy"]) {
      const view = shell.view(name);
      view.status?.retryConn(() => reconnected.push(name));
    }
    shell.view("auth").status?.onTerminalConn({ state: "open", attempt: 1 });
    shell.view("deploy").status?.onTerminalConn({ state: "closed", attempt: 0 });

    const conn = await openRightNow(shell);
    // The badge shows the session being READ, not whichever neighbour spoke
    // last: `deploy` mounted second and reported second, and `auth` is the
    // focused tile. Before the fix this row said "not connected" about a
    // terminal nobody had asked about.
    expect(terminalRow(conn)?.detail).toBe("connected");

    // And Reconnect drops the focused tile's socket, for the same reason.
    await conn.repair("terminal");
    expect(reconnected).toEqual(["auth"]);

    // FOCUS MOVES, AND THE ANSWER MOVES WITH IT, out of reports both tiles have
    // already made. Nothing re-reports here, and nothing can: `SessionView`
    // publishes on a change of VISIBILITY and both tiles stayed visible — which
    // is why a `focused()` guard on the write would not have been enough. The
    // row would have gone on showing `auth`'s socket over the session now being
    // typed into, until `deploy`'s happened to change state.
    focusTile(shell, "deploy");
    await waitFor(() => expect(shell.view("deploy").visible).toBe(true));
    expect(terminalRow(conn)?.detail).toBe("not connected");
    expect(conn.repairLabel("terminal")).toBe("Reconnect");
    await conn.repair("terminal");
    expect(reconnected).toEqual(["auth", "deploy"]);
  });
});

// ---- a drop in the middle of a lone session --------------------------------

/**
 * Drag a sidebar card and let it go at `(x, y)` in the shell body's own
 * coordinates.
 *
 * The library announces a drag on the document with no payload
 * (`DRAG_START_EVENT`), so `App` reads the session off the last `.tl-card` a
 * pointer went down on — which is why the card is a real element here. From the
 * announcement on, `dnd/tiles.ts` tracks the pointer itself.
 */
function dragCardTo(name: string, x: number, y: number): void {
  const card = document.createElement("div");
  card.className = "tl-card";
  card.dataset.name = name;
  document.body.append(card);
  try {
    world.dragging = true;
    card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new CustomEvent(DRAG_START_EVENT));
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
    document.dispatchEvent(new PointerEvent("pointerup"));
  } finally {
    world.dragging = false;
    card.remove();
  }
}

describe("a drop in the middle of a lone session", () => {
  it("shows the dropped session, which is what replacing that tile means", async () => {
    // No workspace: one session on screen, which is a workspace of one — "splits
    // are the view rather than a mode" — and the whole pane is its tile.
    world.sessions = [session("auth"), session("deploy")];
    const shell = await openShell("auth");
    await waitFor(() => expect(shell.view("auth").visible).toBe(true));

    // The middle third on both axes, which the hit test answers `replace` for.
    dragCardTo("deploy", SHELL.width / 2, SHELL.height / 2);

    // The design's gesture table: a middle drop "replaces what is in that tile".
    // The tile is the whole pane, so replacing it is showing that session. The
    // selection is the whole of that, URL included — before the fix the write
    // was discarded one level up and the gesture did nothing at all: no switch,
    // no workspace, no toast.
    await waitFor(() => expect(window.location.hash).toBe("#deploy"));
    expect(shell.view("deploy").visible).toBe(true);
    expect(shell.view("auth").visible).toBe(false);
    // And one tile is not a workspace, so nothing was grouped and nothing was
    // written: a replace on a lone session leaves the document alone.
    expect(world.puts).toEqual([]);
  });
});

// ---- the arrangement a changed member set leaves behind --------------------

/**
 * The shell test above drives this through a kill, which is the case that
 * matters and the one that was broken. These are the other four answers, and
 * the arriving-member rule in particular has no gesture to drive it: another
 * device puts a session in the workspace and this one has never seen it.
 */
describe("reconcileTree", () => {
  const A = keyOf({ name: "auth" });
  const B = keyOf({ name: "deploy" });
  const C = keyOf({ name: "docs" });

  it("hands the stored tree back by reference when the members match", () => {
    // Every poll takes this path, and a new object would re-emit rects and move
    // nothing.
    const stored = split("row", [leaf(A), leaf(B)], [0.7, 0.3]);
    expect(reconcileTree(stored, [A, B])).toBe(stored);
    expect(reconcileTree(stored, [B, A])).toBe(stored); // order is the server's, not ours
  });

  it("closes a departed member's tile and leaves the rest alone", () => {
    const stored = split("row", [leaf(A), split("column", [leaf(B), leaf(C)], [0.25, 0.75])]);
    const next = reconcileTree(stored, [A, C]);
    expect(next).toEqual(split("row", [leaf(A), leaf(C)]));
  });

  it("splits the last tile's bottom for a member that has arrived", () => {
    // Bottom rather than a side: halving a tile's height leaves every session
    // in the workspace at the column count it already had, and a terminal's
    // width is what re-wraps its output.
    const stored = split("row", [leaf(A), leaf(B)], [0.7, 0.3]);
    const next = reconcileTree(stored, [A, B, C]);
    expect(next).toEqual(split("row", [leaf(A), split("column", [leaf(B), leaf(C)])], [0.7, 0.3]));
  });

  it("arranges from scratch when there is nothing to reconcile against", () => {
    // A device that has never seen this workspace, and one whose stored tree
    // holds none of its members any more.
    expect(reconcileTree(null, [A, B])).toEqual(autoArrange([A, B]));
    expect(reconcileTree(leaf(C), [A, B])).toEqual(autoArrange([A, B]));
  });
});
