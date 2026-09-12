/**
 * A KILLED MEMBER, AS THE TILE DRAWS IT — through the real shell.
 *
 * The design's "Death and restore": a member being killed "dims its tile and
 * strikes it through with the `↺` arrow and the seconds counting down, exactly
 * as a sidebar card does". `TileHeader` implements every word of that and has
 * its own passing tests for all of it (test/tile-header.test.tsx). It was still
 * dead on arrival, because `App.tsx` passed four of its props and none of the
 * four kill ones: `killing`, `killingUntil`, `tick` and `onUndoKill` are all
 * optional, so `tsc` was green, `props.killing` was `undefined` at runtime, and
 * a killed tile drew an ordinary header until it vanished. The sidebar row
 * struck itself through and counted down beside it, which is the version of
 * this bug a person actually sees: two drawings of one session disagreeing
 * about whether it is dying.
 *
 * SO THE ASSERTIONS ARE MADE THROUGH `<App/>`, never against `TileHeader`
 * directly. A prop that is never passed is invisible to a test that passes it.
 * The kill is started through `store.kill`, which is the same call the sidebar
 * card's ⋯ menu and the swipe both make, reached here through the `store` the
 * shell hands its Sidebar.
 *
 * WHAT IS MOCKED, and it is the same scenery `test/workspace-shell.test.tsx`
 * stands up: `SessionView` (a real one boots xterm, a socket and an SSE
 * stream), `Sidebar` (which this file replaces with a probe for the store it is
 * given), `lib/lobby-api` (the documents the shell boots from) and
 * `WorkspaceCanvas`, whose rect arithmetic is the real `toRects`. `TileHeader`,
 * the lobby store, the kill window and every wire between them are real.
 *
 * REAL TIMERS, deliberately. The countdown's whole claim is that it re-reads
 * the clock once a second, and the only honest way to watch that happen is to
 * let a second pass: `waitFor` polls until the number moves, and a tile with no
 * `tick` sits on its first number until the assertion times out. Fake timers
 * would have to be driven by this file, which is the one thing that cannot
 * prove a clock the shell is supposed to be running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { createEffect, untrack, type ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { LobbyStore } from "../src/store/lobby";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { GRACE_MS } from "../src/store/lobby";
import { toRects, type Rect, type TreeNode } from "../src/store/workspace-tree";

type ViewProps = ComponentProps<typeof RealSessionView>;

const world = vi.hoisted(() => ({
  sessions: [] as { name: string; attached: number; created: number }[],
  doc: {
    version: 1,
    workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
  },
  /** The store the shell hands its Sidebar — this file's way in to a kill. */
  store: null as LobbyStore | null,
  /** Every DELETE the grace window let through. Nothing here should produce
   *  one: a kill taken back inside its window never reaches tmux-api. */
  deleted: [] as string[],
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
      killSession: async (name: string): Promise<void> => {
        world.deleted.push(name);
      },
    },
    getWorkspaces: async () => ({ ...emptyWorkspaces(), ...world.doc }),
    putWorkspaces: async (): Promise<void> => {},
    availableCommands: async () => ({}),
    listUsers: async (): Promise<string[]> => [],
  };
});

vi.mock("../src/components/SessionView", () => ({
  SessionView: (props: ViewProps) => <div class="tl-session-view" data-session={props.session} />,
}));

/** The sidebar, as a probe for the one thing this file needs from it: the
 *  store, which is where a kill starts however it was pressed. */
vi.mock("../src/components/Sidebar", () => ({
  Sidebar: (props: { store: LobbyStore }) => {
    world.store = props.store;
    return <aside class="tl-sidebar" />;
  },
}));

/** The canvas's own contract and nothing more, the way workspace-shell.test.tsx
 *  stands it up: one rect per tile from the real `toRects`, minus the corvu
 *  half, which throws on disposal under the dev build. */
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
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
  }
}

const session = (name: string) => ({ name, attached: 1, created: 1_700_000_000 });

beforeEach(() => {
  installLayout();
  world.sessions = [session("auth"), session("deploy")];
  world.doc = {
    version: 1,
    workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
  };
  world.store = null;
  world.deleted = [];
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
  /** One tile's header, by session name. */
  header: (name: string) => HTMLElement;
  /** The lobby store, which is where a kill is pressed. */
  store: () => LobbyStore;
}

/**
 * Boot the shell into the two-tile workspace, with `selected` focused.
 *
 * The URL is the selection here, the way a shared link opens a member's
 * workspace: membership is server-side, so opening `#auth` restores w1 with
 * `auth` focused and `deploy` beside it.
 */
async function openWorkspace(selected: string): Promise<Shell> {
  window.location.hash = `#${selected}`;
  const { container } = render(() => <App />);
  const root = container as HTMLElement;
  const header = (name: string): HTMLElement => {
    for (const slot of root.querySelectorAll<HTMLElement>(".tl-session-slot.tl-tiled")) {
      if (slot.querySelector<HTMLElement>("[data-session]")?.dataset.session !== name) continue;
      const el = slot.querySelector<HTMLElement>(".tl-tile-header");
      if (!el) throw new Error(`no tile header for ${name}`);
      return el;
    }
    throw new Error(`no tile for ${name}`);
  };
  // Both tiles laid out is the shape every test below starts from.
  await waitFor(() => expect(root.querySelectorAll(".tl-session-slot.tl-tiled")).toHaveLength(2));
  return {
    root,
    header,
    store: () => {
      if (!world.store) throw new Error("the shell never handed its store to a Sidebar");
      return world.store;
    },
  };
}

/** What the header shows where the seconds go, or "" when it draws none. */
const countdown = (header: HTMLElement): string =>
  header.querySelector<HTMLElement>(".tl-tile-countdown")?.textContent?.trim() ?? "";

describe("a killed member's tile says so while the window is open", () => {
  /**
   * The attribute is the whole message — `.tl-tile-header[data-killing]` in
   * src/tiles.css hangs the fade and the strike-through off its presence, the
   * same contract `.tl-card[data-killing]` has in the sidebar. Without the
   * shell passing `killing`, `props.killing` is `undefined` and the attribute
   * is never written, so the fade and the strike never happen.
   */
  it("marks the dying tile and leaves its neighbour alone", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    await waitFor(() => expect(ws.header("deploy").hasAttribute("data-killing")).toBe(true));
    expect(ws.header("auth").hasAttribute("data-killing"), "auth was marked too").toBe(false);
  });

  /**
   * THE SECONDS, and the deadline they come from. `killingUntil` is the store's
   * epoch-ms deadline (GRACE_MS past the press); the header subtracts `now`
   * from it and rounds UP, so the first number a person sees is the full
   * window. A tile handed no deadline reads 0, and 0 draws nothing at all —
   * which is exactly what a workspace showed before this was wired.
   */
  it("counts the window down from its full length", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    await waitFor(() => expect(countdown(ws.header("deploy"))).toBe(String(GRACE_MS / 1000)));
  });

  /**
   * THE CLOCK IS RUNNING, which is the half a screenshot cannot tell from a
   * frozen number. The header takes a `tick` and reads it for its dependency
   * alone; with no tick passed, `secondsLeft()` has nothing to re-run it and
   * the first number stands until the tile disappears.
   *
   * Watched in real time rather than driven from here: a clock this file
   * advanced would be this file's clock, not the shell's.
   */
  it("takes a second off, once a second, without a timer of its own", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    const full = String(GRACE_MS / 1000);
    await waitFor(() => expect(countdown(ws.header("deploy"))).toBe(full));
    await waitFor(() => expect(countdown(ws.header("deploy"))).toBe(String(GRACE_MS / 1000 - 1)), {
      timeout: 4_000,
    });
  });

  /**
   * ONE CONTROL, SWAPPED IN PLACE. The strip stays at four items and 24px, so
   * no tile's rect moves and no terminal refits for a colour — and the two
   * presses never sit side by side, which a control that removes a tile and a
   * control that rescues a session should never do.
   */
  it("gives the close control's slot to the undo arrow", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    await waitFor(() => expect(ws.header("deploy").querySelector(".tl-tile-undo")).not.toBeNull());
    expect(
      ws.header("deploy").querySelector(".tl-tile-close"),
      "close survived the kill",
    ).toBeNull();
    expect(ws.header("auth").querySelector(".tl-tile-close"), "auth lost its close").not.toBeNull();
  });
});

describe("the arrow on a tile takes that tile's kill back", () => {
  /**
   * On a phone this is the ONLY way back — there is no Cmd+Z on a touch screen
   * — so a rendered arrow that reports its press nowhere is the whole feature
   * missing. `onUndoKill` is the fourth optional prop, and the one whose
   * absence is silent: the button draws, the pointer changes, the press does
   * nothing.
   */
  it("un-dims the tile and hands the close control back", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    await waitFor(() => expect(ws.header("deploy").hasAttribute("data-killing")).toBe(true));

    const arrow = ws.header("deploy").querySelector<HTMLButtonElement>(".tl-tile-undo");
    if (!arrow) throw new Error("no undo arrow on the dying tile");
    fireEvent.click(arrow);

    await waitFor(() => expect(ws.header("deploy").hasAttribute("data-killing")).toBe(false));
    expect(ws.header("deploy").querySelector(".tl-tile-close")).not.toBeNull();
    expect(countdown(ws.header("deploy")), "a countdown outlived its kill").toBe("");
  });

  /** A kill taken back inside its window never reached tmux-api, so there is
   *  nothing to undo on the server and the session never stopped running. */
  it("sends no DELETE", async () => {
    const ws = await openWorkspace("auth");
    void ws.store().kill("deploy");
    await waitFor(() => expect(ws.header("deploy").hasAttribute("data-killing")).toBe(true));
    const arrow = ws.header("deploy").querySelector<HTMLButtonElement>(".tl-tile-undo");
    if (!arrow) throw new Error("no undo arrow on the dying tile");
    fireEvent.click(arrow);
    await waitFor(() => expect(ws.header("deploy").hasAttribute("data-killing")).toBe(false));
    expect(world.deleted).toEqual([]);
  });
});
