import { describe, it, expect, beforeEach } from "vitest";
import { createSignal, For } from "solid-js";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { ProjectGroup } from "../src/components/ProjectGroup";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

/**
 * The header drag is the one transient interaction in <ProjectGroup> that took
 * no poll hold. A poll that sees a session appear or disappear rebuilds the
 * whole group set (see the negative control below), so a drag in flight either
 * lost its source node — no `drop`, no `dragend`, the move silently swallowed —
 * or had a different group reflow under the cursor and persisted into the wrong
 * slot, with no toast either way (saveLayout only speaks up in its catch).
 *
 * These tests pin the hold, its release, and the fact that a `dragend` that
 * never arrives cannot strand the poll forever.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  /** Directories a speculative slot was asked for / handed back, in order. */
  prewarmed: string[] = [];
  released: string[] = [];
  async prewarm(dir: string) {
    this.prewarmed.push(dir);
  }
  async releasePrewarm(dir: string) {
    this.released.push(dir);
  }
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
    this.puts.push(l);
    this.layoutVal = l;
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
}

/**
 * Mount the group list the way <Sidebar> does — a keyed <For> over
 * `store.model().groups` — without importing the sidebar itself. The keying is
 * the point: deriveSidebar builds fresh RenderGroup objects on every recompute,
 * so any poll that recomputes the model re-creates every header node.
 */
function mount(api: LobbyApi, onNewSession?: (group: string) => void) {
  let store!: LobbyStore;
  const [tick] = createSignal(0);
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    const groups = () =>
      store.model().groups.filter((g) => g.kind === "project" || g.sessions.length > 0);
    return (
      <For each={groups()}>
        {(g) => (
          <ProjectGroup store={store} group={g} tick={tick} onNewSession={onNewSession} />
        )}
      </For>
    );
  });
  return { ...utils, store: store! };
}

/**
 * One poll's worth of the churn the live repro injects (`tmux new-session -d -s
 * qa-churn…`): a session the sidebar has not seen before. That is what makes
 * the payload genuinely change — the layout signal compares structurally and
 * the session store reconciles by name, so a re-parsed identical payload writes
 * nothing at all.
 */
let churnSeq = 0;
async function pollWithChurn(api: FakeApi, store: LobbyStore): Promise<void> {
  api.sessionsVal = [...api.sessionsVal, sess(`qa-churn-${++churnSeq}`)];
  await store.refresh();
}

/** Two projects, one session each, in a known order. */
function twoProjects(api: FakeApi): void {
  api.sessionsVal = [sess("a1"), sess("b1")];
  api.layoutVal = {
    ...emptyLayout(),
    projects: [
      { name: "alpha", sessions: ["a1"] },
      { name: "bravo", sessions: ["b1"] },
    ],
  };
}

const headers = (root: Element): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(".tl-group-header")];

const titles = (root: Element): string[] =>
  [...root.querySelectorAll(".tl-group-title")].map((n) => n.textContent ?? "");



const point = (el: Element, type: string, y: number, x = 150) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );

beforeEach(() => {
  churnSeq = 0;
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("<ProjectGroup> header", () => {
  it("negative control: with no drag in flight, a churning poll replaces every header", async () => {
    // The pair to the poll-hold test in dnd.drag.test.tsx, which would be
    // vacuous on its own: this is the proof that the churn it holds back does
    // rebuild the list when nothing is holding it.
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));

    const before = headers(container);
    await pollWithChurn(api, store);

    const after = headers(container);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    store.dispose();
  });

  /**
   * A collapsed group has no card list on screen to aim at, so hovering its
   * header with a session in hand opens it and hands the drop to the ordinary
   * sortable underneath. It replaced "drop on the header to append", which
   * landed the card at the end rather than where the pointer was.
   */
  it("springs a collapsed group open when a dragged session hovers its header", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));
    store.collapse.toggle("bravo");
    await waitFor(() => expect(store.collapse.isCollapsed("bravo")).toBe(true));

    const card = container.querySelector<HTMLElement>(".tl-card")!;
    card.getBoundingClientRect = () =>
      ({ top: 100, bottom: 140, height: 40, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON() {} }) as DOMRect;
    document.elementFromPoint = () => card;
    point(card, "pointerdown", 120);
    await new Promise((r) => setTimeout(r, 600)); // past the 450ms hold
    point(card, "pointermove", 125);

    const bravo = headers(container)[1]!;
    point(bravo, "pointermove", 200);
    await waitFor(() => expect(store.collapse.isCollapsed("bravo")).toBe(false), {
      timeout: 2000,
    });
    point(bravo, "pointerup", 200);
    store.dispose();
  });

  it("keeps the ⋯ Move up / Move down path working on the same header", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, getAllByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toEqual(["alpha", "bravo"]));

    fireEvent.click(getAllByLabelText("Group actions")[1]!); // bravo's menu
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    const up = [...container.querySelectorAll(".tl-menu-item")].find((b) => b.textContent === "Move up")!;
    fireEvent.click(up);

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.puts[0]!.projects.map((p) => p.name)).toEqual(["bravo", "alpha"]);
    store.dispose();
  });
});

/**
 * An empty Ungrouped renders nothing (Sidebar drops it) but deliberately keeps
 * its slot in the layout, so the token sequence the ⋯ menu measured was one
 * longer than the list on screen. The edge project's Move item was enabled on
 * the strength of a neighbour nobody can see, and the click was spent shuffling
 * the sentinel: the list did not move, the item then greyed out, and the user
 * had to click twice to move once.
 *
 * Bounds and steps belong in VISIBLE space. The sentinel stays in the layout —
 * the capture/reorder contract in lobby.logic.ts depends on it.
 */
describe("<ProjectGroup> ⋯ move with an empty Ungrouped", () => {
  /** twoProjects, with the (empty) Ungrouped sentinel parked at `at`. */
  function sentinelAt(api: FakeApi, at: number): void {
    twoProjects(api);
    api.layoutVal = { ...api.layoutVal, ungroupedIndex: at };
  }

  type Mounted = ReturnType<typeof mount>;

  /**
   * Open the ⋯ menu of the i-th VISIBLE group; the returned getter reads its
   * items by label. One open per call — the ⋯ button toggles, so re-opening to
   * read a second item would shut the menu instead.
   */
  async function openMenu(m: Mounted, i: number): Promise<(label: string) => HTMLButtonElement> {
    fireEvent.click(m.getAllByLabelText("Group actions")[i]!);
    await waitFor(() => expect(m.container.querySelector(".tl-menu")).not.toBeNull());
    return (label) =>
      [...m.container.querySelectorAll<HTMLButtonElement>(".tl-menu-item")].find(
        (b) => b.textContent === label,
      )!;
  }

  /** Open group i's menu and hand back one item. */
  const menuItem = async (m: Mounted, i: number, label: string): Promise<HTMLButtonElement> =>
    (await openMenu(m, i))(label);

  it("does not enable the top project's Move up (the sentinel above it is invisible)", async () => {
    const api = new FakeApi();
    sentinelAt(api, 0); // tokens [u, alpha, bravo] — but "u" renders nothing
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(titles(m.container)).toEqual(["alpha", "bravo"]));

    expect((await menuItem(m, 0, "Move up")).disabled).toBe(true);
    m.store.dispose();
  });

  it("does not enable the bottom project's Move down (the sentinel below it is invisible)", async () => {
    const api = new FakeApi();
    sentinelAt(api, 2); // tokens [alpha, bravo, u]
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(titles(m.container)).toEqual(["alpha", "bravo"]));

    expect((await menuItem(m, 1, "Move down")).disabled).toBe(true);
    m.store.dispose();
  });

  it.each([0, 1])(
    "disables both ends for a lone project with the hidden sentinel at %i",
    async (at) => {
      const api = new FakeApi();
      api.sessionsVal = [sess("a1")];
      api.layoutVal = {
        ...emptyLayout(),
        projects: [{ name: "alpha", sessions: ["a1"] }],
        ungroupedIndex: at,
      };
      const m = mount(api);
      await m.store.refresh();
      await waitFor(() => expect(titles(m.container)).toEqual(["alpha"]));

      const item = await openMenu(m, 0);
      expect(item("Move up").disabled).toBe(true);
      expect(item("Move down").disabled).toBe(true);
      m.store.dispose();
    },
  );

  it("spends one click on one VISIBLE slot when the hidden sentinel sits between", async () => {
    const api = new FakeApi();
    sentinelAt(api, 1); // tokens [alpha, u, bravo] — alpha's Move down met "u" first
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(titles(m.container)).toEqual(["alpha", "bravo"]));

    fireEvent.click(await menuItem(m, 0, "Move down"));

    await waitFor(() => expect(titles(m.container)).toEqual(["bravo", "alpha"]));
    expect(api.puts.length).toBe(1); // one click, one write, one visible slot
    m.store.dispose();
  });

  it("spends one click on one VISIBLE slot moving up past the hidden sentinel", async () => {
    const api = new FakeApi();
    sentinelAt(api, 1); // tokens [alpha, u, bravo]
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(titles(m.container)).toEqual(["alpha", "bravo"]));

    fireEvent.click(await menuItem(m, 1, "Move up"));

    await waitFor(() => expect(titles(m.container)).toEqual(["bravo", "alpha"]));
    expect(api.puts.length).toBe(1);
    m.store.dispose();
  });

  it("control: a NON-empty Ungrouped is visible, so it keeps taking its own slot", async () => {
    // The sentinel is not being removed — when it renders it reorders exactly as
    // it does today, and a project moving past it costs the click it always did.
    const api = new FakeApi();
    twoProjects(api);
    api.sessionsVal = [...api.sessionsVal, sess("loose")];
    api.layoutVal = { ...api.layoutVal, ungrouped: ["loose"], ungroupedIndex: 0 };
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(titles(m.container)).toEqual(["Ungrouped", "alpha", "bravo"]));

    fireEvent.click(await menuItem(m, 1, "Move up")); // alpha, above Ungrouped

    await waitFor(() => expect(titles(m.container)).toEqual(["alpha", "Ungrouped", "bravo"]));
    expect(api.puts[0]!.ungroupedIndex).toBe(1);
    m.store.dispose();
  });
});

/**
 * The `+` on a group header.
 *
 * It used to open a name box inside the group and own the speculative pre-warm
 * that went with it. Both moved to the new-session composer, which needs the
 * room a prompt takes and warms the directory its own project selector is
 * showing (test/NewSessionComposer.test.tsx). What is left here is the route:
 * the composer opens preset to THIS project, and the group opens with it so the
 * card that arrives is on screen rather than inside something still collapsed.
 */
describe("<ProjectGroup> — the + routes to the composer", () => {
  const withProject = (api: FakeApi): void => {
    api.sessionsVal = [];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" }],
    };
  };

  const addButton = (root: Element): HTMLElement =>
    root.querySelector<HTMLElement>('button[aria-label="New session in project"]')!;

  it("asks for the composer, preset to this project", async () => {
    const api = new FakeApi();
    withProject(api);
    const opened: (string | undefined)[] = [];
    const { container, store } = mount(api, (g) => opened.push(g));
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    expect(opened).toEqual(["alpha"]);
    // The group opens, so the new card is not created into something collapsed.
    expect(store.collapse.isCollapsed("alpha")).toBe(false);
    store.dispose();
  });

  it("warms nothing itself — the composer owns the slot now", async () => {
    const api = new FakeApi();
    withProject(api);
    const { container, store } = mount(api, () => {});
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    await Promise.resolve();
    expect(api.prewarmed).toEqual([]);
    expect(api.released).toEqual([]);
    store.dispose();
  });
});

/**
 * The ⋯ menu is rendered inside the header, and the header is a `role="button"`
 * with an Enter/Space handler of its own. That handler calls preventDefault(),
 * which cancels the menu button's synthesised click — so before the menu held
 * the key back, Enter on "Rename project" collapsed the group and never ran the
 * item at all. The mouse path was fine; there simply was no keyboard one.
 */
describe("<ProjectGroup> ⋯ menu — a key inside it stays inside it", () => {
  it("does not collapse the group when Enter is pressed on a menu item", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, getAllByLabelText, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toEqual(["alpha", "bravo"]));

    fireEvent.click(getAllByLabelText("Group actions")[1]!); // bravo's menu
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());
    const open = container.querySelectorAll(".tl-group-body").length;

    const rename = [...container.querySelectorAll(".tl-menu-item")].find(
      (b) => b.textContent === "Rename project",
    )!;
    fireEvent.keyDown(rename, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelectorAll(".tl-group-body").length).toBe(open);
    store.dispose();
  });
});
