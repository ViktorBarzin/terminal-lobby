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
function mount(api: LobbyApi) {
  let store!: LobbyStore;
  const [tick] = createSignal(0);
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    const groups = () =>
      store.model().groups.filter((g) => g.kind === "project" || g.sessions.length > 0);
    return <For each={groups()}>{(g) => <ProjectGroup store={store} group={g} tick={tick} />}</For>;
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

const cardNames = (root: Element): string[] =>
  [...root.querySelectorAll(".tl-card-name")].map((n) => n.textContent ?? "");

/** Rendered order of the PROJECT groups — a churn session makes Ungrouped
 *  appear, which is noise here, not ordering. */
const projectOrder = (root: Element): string[] =>
  titles(root).filter((t) => t !== "Ungrouped");

beforeEach(() => {
  churnSeq = 0;
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("<ProjectGroup> header drag-reorder", () => {
  it("negative control: with no drag in flight, that same churn does replace every header", async () => {
    // Without this the hold tests below would be vacuous — they would pass on a
    // poll that never rebuilt anything in the first place.
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

  it("holds the poll while a header drag is in flight, so the source node survives", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));

    const [alpha, bravo] = headers(container);
    fireEvent.dragStart(alpha!);

    await pollWithChurn(api, store);
    await pollWithChurn(api, store);

    // Same DOM nodes: the drag source is still attached (so the browser still
    // has something to fire `drop`/`dragend` at) and no reflow has slid a
    // different group under the cursor.
    expect(headers(container)[0]).toBe(alpha);
    expect(headers(container)[1]).toBe(bravo);
    store.dispose();
  });

  it("lands the group where it was dropped even when the poll churns mid-drag", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toEqual(["alpha", "bravo"]));

    const [alpha, bravo] = headers(container);
    fireEvent.dragStart(alpha!);
    await pollWithChurn(api, store);
    fireEvent.drop(bravo!);

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.puts[0]!.projects.map((p) => p.name)).toEqual(["bravo", "alpha"]);
    await waitFor(() => expect(projectOrder(container)).toEqual(["bravo", "alpha"]));
    store.dispose();
  });

  it("releases the hold on dragend, so the next poll rebuilds again", async () => {
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));

    const alpha = headers(container)[0]!;
    fireEvent.dragStart(alpha);
    fireEvent.dragEnd(alpha);

    await pollWithChurn(api, store);

    await waitFor(() => expect(cardNames(container)).toContain("qa-churn-1"));
    store.dispose();
  });

  it("does not strand the poll when dragend never fires (the source was detached)", async () => {
    // A drop that reorders re-creates every header, so a real browser has no
    // attached source left to fire `dragend` at. The hold must still come off,
    // or the sidebar stops polling for the rest of the session.
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(titles(container)).toEqual(["alpha", "bravo"]));

    const [alpha, bravo] = headers(container);
    fireEvent.dragStart(alpha!);
    fireEvent.drop(bravo!); // deliberately no dragEnd — the source node is gone
    await waitFor(() => expect(projectOrder(container)).toEqual(["bravo", "alpha"]));

    await pollWithChurn(api, store);

    await waitFor(() => expect(cardNames(container)).toContain("qa-churn-1"));
    store.dispose();
  });

  it("releases the hold when the drop lands back on the dragged header itself", async () => {
    // from === to: no reorder, so nothing re-creates the header and nothing
    // disposes the component — the release has to come off the drop itself.
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));

    const alpha = headers(container)[0]!;
    fireEvent.dragStart(alpha);
    fireEvent.drop(alpha); // no dragEnd
    expect(api.puts.length).toBe(0);

    await pollWithChurn(api, store);

    await waitFor(() => expect(cardNames(container)).toContain("qa-churn-1"));
    store.dispose();
  });

  it("still moves a dragged session card into the group whose header took the drop", async () => {
    // The header is also a drop target for a session drag; that path holds
    // nothing of its own (SessionCard already holds) and must keep working.
    const api = new FakeApi();
    twoProjects(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(2));

    store.setDragName("a1");
    fireEvent.drop(headers(container)[1]!); // onto "bravo"

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.puts[0]!.projects.find((p) => p.name === "bravo")!.sessions).toContain("a1");
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
 * Speculative pre-warming. Opening the create box is the earliest moment a
 * session's directory is known, and it is seconds ahead of the name being
 * typed — long enough to cover most of Claude's ~2.4s boot, which is 89% of
 * what creating a session used to cost.
 *
 * The behaviour worth pinning is not "does it call the endpoint" but WHEN it
 * hands the slot back, because both mistakes are silent: releasing after a
 * successful create races the attach and loses the benefit exactly when it
 * matters, and never releasing leaves ~530MB per abandoned box.
 */
describe("<ProjectGroup> speculative pre-warm", () => {
  const withDir = (api: FakeApi): void => {
    api.sessionsVal = [];
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" }],
    };
  };

  const addButton = (root: Element): HTMLElement =>
    root.querySelector<HTMLElement>('button[aria-label="New session in project"]')!;

  const addInputEl = (root: Element): HTMLInputElement =>
    root.querySelector<HTMLInputElement>(".tl-group-add-input, .tl-new-input, input")!;

  it("warms the project's dir as soon as the create box opens", async () => {
    const api = new FakeApi();
    withDir(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    expect(api.prewarmed).toEqual([]);
    addButton(container).click();
    await waitFor(() => expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]));
    store.dispose();
  });

  it("asks once, however many times the box is opened", async () => {
    // beginAdd also fires on re-click while already adding; a second slot for
    // the same dir would be refused server-side, but the request is pointless.
    const api = new FakeApi();
    withDir(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    addButton(container).click();
    addButton(container).click();
    await waitFor(() => expect(api.prewarmed.length).toBe(1));
    store.dispose();
  });

  it("does not warm a project with no dir, since that would warm $HOME", async () => {
    const api = new FakeApi();
    api.sessionsVal = [];
    api.layoutVal = { ...emptyLayout(), projects: [{ name: "alpha", sessions: [] }] };
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    await Promise.resolve();
    expect(api.prewarmed).toEqual([]);
    store.dispose();
  });

  it("hands the slot back when the box closes with nothing typed", async () => {
    const api = new FakeApi();
    withDir(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    await waitFor(() => expect(api.prewarmed.length).toBe(1));

    // Committing an empty box is the cancel path.
    const input = addInputEl(container);
    input.value = "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => expect(api.released).toEqual(["/home/wizard/code/alpha"]));
    store.dispose();
  });

  it("KEEPS the slot after a successful create, for the attach to claim", async () => {
    // The regression this guards: create() only STARTS the attach — the iframe
    // still has to connect and reach ttyd — so releasing here reliably wins the
    // race and the create falls back to a cold start.
    const api = new FakeApi();
    withDir(api);
    const { container, store } = mount(api);
    await store.refresh();
    await waitFor(() => expect(headers(container).length).toBe(1));

    addButton(container).click();
    await waitFor(() => expect(api.prewarmed.length).toBe(1));

    const input = addInputEl(container);
    input.value = "newsession";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() => expect(api.puts.length).toBeGreaterThan(0));
    expect(api.released).toEqual([]);
    store.dispose();
  });
});
