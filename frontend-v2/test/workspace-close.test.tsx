/**
 * CLOSING THE TILE THAT ENDS A WORKSPACE, with the real corvu skeleton mounted.
 *
 * This is `workspace-shell.test.tsx` minus its one stand-in. That file mocks
 * `WorkspaceCanvas` and says why in its own words: a controlled
 * `@corvu/resizable` root reports its sizes while it is being torn down, and
 * the callback that hears it re-derives from `props.tree` — an accessor handed
 * out by a `<Show>` whose condition has just gone false. Solid's dev build
 * answers that read by throwing "Attempting to access a stale value from
 * <Show>". The mock kept the throw out of that suite. It also kept the defect
 * out of every test in it, so 5,725 green tests said nothing about a close
 * control that closed nothing on the server.
 *
 * MEASURED IN CHROME on 2026-09-12, against the branch stack on :5199 with two
 * real tmux sessions split into one workspace:
 *
 *   before  pressing ✕ emptied the tiles locally (2 tiled slots to 0, 2 tile
 *           headers to 0, `tl:workspaces:v1` to nothing) and sent NO request at
 *           all — not a PUT, not anything. `GET /sessions/workspaces` still
 *           listed both members afterwards, so a reload brought the closed tile
 *           back. One page error per close. One `[data-corvu-resizable-root]`
 *           and one `[data-corvu-resizable-handle]` stayed in the DOM, drawing
 *           a divider down the middle of the single session left on screen.
 *   after   `PUT /sessions/workspaces` 204, the GET lists nothing, the reload
 *           keeps one session, zero page errors, zero corvu nodes left.
 *
 * WHY THE THROW TOOK THE REQUEST WITH IT. The write runs inside a `batch`, and
 * the tile teardown happens in the flush that batch ends with. The stale read
 * lands mid-flush, so the exception unwinds out through `batch()` before
 * `writeWorkspace` ever reaches `putWorkspaces` — and unwinding out of
 * `updateComputation` leaves Solid's update queue half-drained, which is why
 * the skeleton's DOM survived the workspace that owned it. One read, both
 * defects.
 *
 * The two assertions below are therefore the SAME gesture seen twice: the
 * server heard about the close, and the page has nothing of the workspace left
 * on it. Scenery matches `workspace-shell.test.tsx` exactly — the same api,
 * `SessionView`, `Sidebar` and `SettingsPanel` mocks, the same jsdom layout —
 * because the only difference worth having between the two files is the canvas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal, Show, type ComponentProps } from "solid-js";
import type { SessionView as RealSessionView } from "../src/components/SessionView";
import type { Layout, Session, Whoami } from "../src/types/lobby";
import { emptyLayout, emptyWorkspaces } from "../src/types/lobby";
import { WorkspaceCanvas } from "../src/components/WorkspaceCanvas";
import {
  leaf,
  split,
  type NodePath,
  type Rect,
  type SessionKey,
  type TreeNode,
} from "../src/store/workspace-tree";

type ViewProps = ComponentProps<typeof RealSessionView>;

/** Everything the mocked api answers with, and everything it recorded. */
const world = vi.hoisted(() => ({
  sessions: [] as { name: string; attached: number; created: number; owner?: string }[],
  doc: {
    version: 1,
    workspaces: [] as { id: string; members: { name: string; owner?: string }[] }[],
  },
  puts: [] as unknown[],
  views: new Map<string, ViewProps>(),
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

import { App } from "../src/components/App";

/** 1440x900, less the 260px sidebar and the 37px shell bar. */
const SHELL = { width: 1180, height: 776 };

/**
 * Everything corvu and the shell need from a layout engine jsdom does not have.
 *
 * `clientWidth`/`clientHeight` are what `mountShellBody` measures the tile area
 * with; `offsetWidth`/`offsetHeight` are what corvu measures its own root with,
 * and against a zero-width root its 240px floor resolves to Infinity and every
 * panel clamps to nothing. The observer never fires — `createSize` reads the
 * element once when it attaches, and that first read is the whole measurement.
 */
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

/**
 * Every exception that reached the page while a test ran.
 *
 * jsdom reports a throw out of a DOM event listener as an `error` event on the
 * window rather than failing the dispatch, which is exactly how Chrome reported
 * this one — the close LOOKED like it worked and the console was the only place
 * that said otherwise. Asserting on the list is what makes "zero page errors"
 * a test result rather than something a reader has to notice.
 */
let pageErrors: string[] = [];
function onPageError(event: ErrorEvent): void {
  pageErrors.push(event.error instanceof Error ? event.error.message : String(event.message));
}

beforeEach(() => {
  installLayout();
  world.sessions = [];
  world.doc = { version: 1, workspaces: [] };
  world.puts = [];
  world.views.clear();
  pageErrors = [];
  window.addEventListener("error", onPageError);
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  window.removeEventListener("error", onPageError);
  vi.unstubAllGlobals();
  for (const prop of ["clientWidth", "clientHeight", "offsetWidth", "offsetHeight"]) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  window.location.hash = "";
});

interface Shell {
  root: HTMLElement;
  /** The slots a tree gave a rectangle to, by session name. */
  tiles: () => Map<string, HTMLElement>;
}

/** Boot the shell with `selected` on screen, and wait for the first poll. The
 *  URL is the selection here: the sidebar is scenery, and `readInitialSelection`
 *  reads the hash. */
async function openShell(selected: string): Promise<Shell> {
  window.location.hash = `#${selected}`;
  const { container } = render(() => <App />);
  const root = container as HTMLElement;
  const tiles = (): Map<string, HTMLElement> => {
    const out = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(".tl-session-slot.tl-tiled")) {
      const name = el.querySelector<HTMLElement>("[data-session]")?.dataset.session;
      if (name) out.set(name, el);
    }
    return out;
  };
  await waitFor(() => expect(world.views.get(selected)).toBeTruthy());
  return { root, tiles };
}

/** A workspace of exactly two, which is the one a single close ends. */
async function openPair(): Promise<Shell> {
  world.sessions = [session("auth"), session("deploy")];
  world.doc = {
    version: 1,
    workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
  };
  const shell = await openShell("auth");
  await waitFor(() => expect(shell.tiles().size).toBe(2));
  // The skeleton is what the rest of this file is about, so nothing below means
  // anything unless corvu actually drew one here.
  expect(shell.root.querySelectorAll("[data-corvu-resizable-root]").length).toBe(1);
  expect(shell.root.querySelectorAll("[data-corvu-resizable-handle]").length).toBe(1);
  return shell;
}

/** Press ✕ on one tile, through the control a person presses. */
function closeTile(shell: Shell, name: string): void {
  const button = shell.root.querySelector<HTMLButtonElement>(`button[aria-label="Close ${name}"]`);
  expect(button, `the ${name} tile has a close control`).toBeTruthy();
  button?.click();
}

describe("closing the tile that ends a workspace", () => {
  /**
   * THE MEMBERSHIP WRITE IS THE POINT OF THE GESTURE. The tiles coming off
   * screen is this device agreeing with itself; the workspace is only closed
   * once tmux-api has heard, because that document is what the next reload and
   * the next device read.
   *
   * `{version: 1, workspaces: []}` rather than a workspace of one: two members
   * is the floor (`MIN_WORKSPACE_MEMBERS`), and tmux-api drops a group below it
   * on read anyway, so the write says the group is gone rather than leaving one
   * the server would have to repair.
   */
  it("tells the server the workspace is over", async () => {
    const shell = await openPair();

    closeTile(shell, "deploy");

    await waitFor(() => expect(world.puts).toHaveLength(1));
    expect(world.puts[0]).toEqual({ version: 1, workspaces: [] });
    expect(pageErrors).toEqual([]);
  });

  /**
   * THE SKELETON GOES WITH THE WORKSPACE. corvu's roots and handles are the
   * only DOM `WorkspaceCanvas` owns, and they are mounted inside the same
   * `<Show when={workspaceTree()}>` the tiles are gated on — so a root still in
   * the page after the last tile went is not a stray node, it is a flush that
   * never finished. In Chrome that left a divider line drawn down the middle of
   * the one session on screen.
   */
  it("leaves no divider behind", async () => {
    const shell = await openPair();

    closeTile(shell, "deploy");

    await waitFor(() => expect(shell.tiles().size).toBe(0));
    expect(shell.root.querySelectorAll("[data-corvu-resizable-root]").length).toBe(0);
    expect(shell.root.querySelectorAll("[data-corvu-resizable-handle]").length).toBe(0);
    expect(shell.root.querySelectorAll(".tl-tile-header").length).toBe(0);
    // The session that was not closed is still mounted and still on screen.
    expect(world.views.get("auth")).toBeTruthy();
    expect(pageErrors).toEqual([]);
  });
});

/**
 * THE CANVAS ON ITS OWN, at the one moment it is asked a question it has no
 * answer to.
 *
 * corvu reports a row of sizes as each `Resizable.Panel` unregisters, and that
 * happens inside the disposal that takes the whole skeleton away. It splices an
 * entry out of its own array each time, so the rows it reports on the way out
 * are SHORTER than the split they name — and `sameFractions` cannot swallow
 * them, because two lengths are two different arrangements rather than one
 * arrangement twice.
 *
 * Measured on 2026-09-12, closing a two-tile workspace: the canvas called
 * `onFractions([], [0])` twice while it came apart. One entry, of zero, for a
 * split with two children. The shell drops both — `tiles()` is already null by
 * then — so this is the shell defending itself against the canvas, and the only
 * thing standing between a teardown and a tile written to zero width.
 *
 * Rendered under a real `<Show>` rather than by disposing a root, because that
 * is the shape the shell mounts it in and the shape whose accessor goes away.
 */
describe("the canvas coming apart", () => {
  it("reports no fractions while the workspace ends", () => {
    const a = " auth" as SessionKey;
    const b = " deploy" as SessionKey;
    const [tree, setTree] = createSignal<TreeNode | null>(
      split("row", [leaf(a), leaf(b)], [0.5, 0.5]),
    );
    const heard: { path: NodePath; fractions: number[] }[] = [];
    const { container } = render(() => (
      <Show when={tree()}>
        {(t) => (
          <WorkspaceCanvas
            tree={t()}
            container={SHELL}
            focused={a}
            onRects={(_rects: Rect[]) => {}}
            onFractions={(path, fractions) => heard.push({ path, fractions })}
          />
        )}
      </Show>
    ));
    expect(container.querySelectorAll("[data-corvu-resizable-root]").length).toBe(1);

    heard.length = 0;
    setTree(null);

    expect(heard).toEqual([]);
    expect(container.querySelectorAll("[data-corvu-resizable-root]").length).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
