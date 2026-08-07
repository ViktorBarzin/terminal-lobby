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
  async renameSession() {
    throw new ApiError(404, "no");
  }
  async restoreSessions() {}
  async listDirs() {
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
