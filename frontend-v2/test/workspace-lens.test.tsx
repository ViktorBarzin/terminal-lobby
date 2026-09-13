/**
 * A LENS READS A WORKSPACE AND DOES NOT WRITE ITS MEMBERSHIP.
 *
 * `?as=bob` is a navigation, not a mode (lib/act-as.ts): every request the tab
 * makes from then on carries the parameter, so `PUT /workspaces` under one
 * lands in BOB's document — on every device bob owns, from a tab bob cannot
 * see. The design's `?as=` row draws the line where the two halves of a
 * workspace already divide: membership is the target's and roams with them, the
 * split tree is this device's own (ADR-0027), so a lens may lay the tiles out
 * however it likes and may not decide which sessions are in the group.
 *
 * The refusal sits in `writeWorkspace`, which is the single write both gestures
 * reach — the drop and the tile's ✕ — and it asks whether MEMBERSHIP moved
 * rather than whether this is a lens, so a divider drag still persists.
 *
 * Everything here mounts the real `<App/>`, with the scenery
 * `workspace-shell.test.tsx` mocks and for the same reasons: a real
 * `SessionView` boots xterm, a socket and an SSE stream, and jsdom runs no
 * layout, so the shell is given a box on the prototype.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createEffect, untrack, type ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { toasts } from "../src/store/toast";
import { toRects, type Rect, type TreeNode } from "../src/store/workspace-tree";

type ViewProps = ComponentProps<typeof RealSessionView>;

const world = vi.hoisted(() => ({
  /** Who this tab is acting as, read live so one file can drive both answers. */
  actAs: "",
  sessions: [] as { name: string; attached: number; created: number }[],
  doc: {
    version: 1,
    workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
  },
  puts: [] as unknown[],
  views: new Map<string, ViewProps>(),
  dragging: false,
}));

/* ACT_AS is a module constant, read once per page life — which is exactly what
   it describes, a tab that navigated to `?as=`. A getter keeps that contract
   for the code under test while letting this file answer for two tabs. */
vi.mock("../src/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return {
    ...actual,
    get ACT_AS(): string {
      return world.actAs;
    },
  };
});

vi.mock("../src/lib/lobby-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/lobby-api")>();
  return {
    ...real,
    lobbyApi: {
      ...real.lobbyApi,
      // What the server answers a switched tab: `osUser` is the target, and
      // `realUser` is present only because the identity actually changed.
      whoami: async (): Promise<Whoami> =>
        world.actAs
          ? { authentik: "wizard", osUser: world.actAs, realUser: "wizard" }
          : { authentik: "wizard", osUser: "wizard" },
      listSessions: async (): Promise<Session[]> => world.sessions as Session[],
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

vi.mock("../src/components/SettingsPanel", () => ({
  SettingsPanel: () => <div class="tl-settings" />,
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

vi.mock("../src/dnd/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dnd/sidebar")>()),
  sessionDragActive: () => world.dragging,
}));

import { App } from "../src/components/App";
import { DRAG_START_EVENT } from "../src/dnd/sidebar";

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
  world.actAs = "";
  world.sessions = [];
  world.doc = { version: 1, workspaces: [] };
  world.puts = [];
  world.views.clear();
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

async function openShell(selected: string): Promise<HTMLElement> {
  window.location.hash = `#${selected}`;
  const { container } = render(() => <App />);
  await waitFor(() => expect(world.views.get(selected)).toBeTruthy());
  return container as HTMLElement;
}

const tiles = (root: HTMLElement): number =>
  root.querySelectorAll(".tl-session-slot.tl-tiled").length;

/** Drag a sidebar card and let it go at `(x, y)` in the shell body's own
 *  coordinates — the gesture `workspace-shell.test.tsx` describes. */
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

describe("a tab acting as somebody else", () => {
  it("refuses the split that would put a session in their workspace", async () => {
    world.actAs = "bob";
    world.sessions = [session("auth"), session("deploy")];
    const root = await openShell("auth");
    await waitFor(() => expect(world.views.get("auth")?.visible).toBe(true));

    // The right third, which is the split the design's gesture table describes.
    dragCardTo("deploy", SHELL.width - 40, SHELL.height / 2);

    // A gesture that does nothing has to say so, so the refusal is asserted as
    // a warning the person can read rather than as a silent return.
    await waitFor(() =>
      expect(toasts.toasts().map((t) => `${t.kind}: ${t.message}`)).toEqual([
        "warning: Acting as someone else: you can rearrange these tiles, not change whose sessions they are.",
      ]),
    );
    expect(document.body.textContent).toContain("rearrange these tiles");
    // Nothing reached bob's document, and nothing moved on screen either: a
    // tile added here and absent there is one the next reconcile takes away.
    expect(world.puts).toEqual([]);
    expect(tiles(root)).toBe(0);
    expect(world.views.get("auth")?.visible).toBe(true);
  });

  it("still leaves the workspace readable, since membership is what is refused", async () => {
    // Bob's own grouping, served to the lens: it draws, both members attach,
    // and the refusal above has nothing to say about any of it.
    world.actAs = "bob";
    world.sessions = [session("auth"), session("deploy")];
    world.doc = {
      version: 1,
      workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
    };
    const root = await openShell("auth");

    await waitFor(() => expect(tiles(root)).toBe(2));
    expect(world.puts).toEqual([]);
  });

  it("lands the same drop for an ordinary tab, which is what makes this the lens", async () => {
    world.sessions = [session("auth"), session("deploy")];
    const root = await openShell("auth");
    await waitFor(() => expect(world.views.get("auth")?.visible).toBe(true));

    dragCardTo("deploy", SHELL.width - 40, SHELL.height / 2);

    await waitFor(() => expect(tiles(root)).toBe(2));
    expect(world.puts).toHaveLength(1);
  });
});
