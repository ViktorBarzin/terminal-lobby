/**
 * Dragging a session and dragging a project, end to end.
 *
 * jsdom has no layout and no hit-testing, so both are supplied here: the rects
 * say where the rows are and `elementFromPoint` says which one the pointer is
 * over. Everything above that is real — the drag library is registered on the
 * live sidebar, the gesture is a real sequence of pointer events, and what is
 * asserted is what the store was left holding.
 *
 * The touch path is the one driven here, deliberately. A mouse reorders through
 * native drag events, which jsdom raises but never produces from a pointer, so
 * a mouse drag can only be exercised in a real browser (docs/development.md).
 * A finger's drag is synthetic, which means it IS reachable from pointer events
 * — and it is the path that broke twice while this was being written: the
 * library raises `onDragstart` for a native drag only, so a touch drag once
 * reached its end having never been seen to begin, and the whole drop was
 * thrown away.
 */
import { describe, it, expect, onTestFinished } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const sess = (name: string): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  // Somebody's own session. An unstamped one is a SYSTEM session and files
  // itself under System instead (components/lobby.logic.ts isSystemSession).
  origin: "user",
});

class FakeApi implements LobbyApi {
  /** The rescue's stamp (POST /sessions/{name}/origin). Nothing here drags a
   *  card out of System, so it only has to exist. */
  async setSessionOrigin() {}
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
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
}

async function mountSidebar(layout: Layout, names: string[]) {
  const api = new FakeApi();
  api.sessionsVal = names.map(sess);
  api.layoutVal = layout;
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} />;
  });
  onTestFinished(() => store.dispose());
  await store.refresh();
  await waitFor(() =>
    expect(utils.container.querySelectorAll(".tl-card").length).toBe(names.length),
  );
  return { ...utils, store: store!, api };
}

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON() {},
  }) as DOMRect;

/**
 * Rows 40px tall, stacked in the order they are rendered RIGHT NOW.
 *
 * Measured live rather than assigned once, because a drag reorders the list as
 * it goes: a row that has already been carried past its neighbour has to report
 * the seat it is in, or the hit-test keeps answering with the arrangement the
 * drag started from and a row can never be brought back.
 */
function layOut(container: HTMLElement): HTMLElement[] {
  const live = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".tl-card")).filter(
      (c) => c.id !== "dnd-dragged-node-clone",
    );
  const seat = (el: HTMLElement): number => Math.max(0, live().indexOf(el));
  for (const card of live()) {
    card.getBoundingClientRect = () => rect(100 + seat(card) * 40, 40);
  }
  for (const body of container.querySelectorAll<HTMLElement>(".tl-group-body")) {
    body.getBoundingClientRect = () => {
      const own = Array.from(body.querySelectorAll<HTMLElement>(".tl-card"));
      const first = own[0] ? seat(own[0]) : 0;
      return rect(100 + first * 40, Math.max(own.length, 1) * 40);
    };
  }
  document.elementFromPoint = (_x: number, y: number) =>
    live().find((c) => {
      const r = c.getBoundingClientRect();
      return y >= r.top && y < r.bottom;
    }) ?? null;
  return live();
}

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

/** The hold is 450ms; wait past it with real time, since fake timers and
 *  Solid's scheduling do not mix well enough to be worth it. */
const held = () => new Promise((r) => setTimeout(r, 600));
const settled = () => new Promise((r) => setTimeout(r, 60));

/**
 * Press, hold, move through each y in turn, and let go at the last one.
 *
 * Only the press is aimed at the row itself. Everything after it goes to
 * whatever is under the pointer, because that is where a browser sends it — and
 * it matters: a row carried into another group is REMOVED and rebuilt there by
 * Solid, so the element the press started on is detached by the time the finger
 * lifts, and a `pointerup` sent to it reaches nothing at all.
 */
async function drag(el: Element, from: number, through: number[]): Promise<void> {
  point(el, "pointerdown", from);
  await held();
  const at = (y: number): Element => document.elementFromPoint(150, y) ?? document.body;
  // A frame between moves, as a real finger has: each one re-renders the list,
  // and the next has to be aimed at the arrangement the last one left.
  for (const y of through) {
    point(at(y), "pointermove", y);
    await settled();
  }
  const last = through[through.length - 1] ?? from;
  point(at(last), "pointerup", last);
  await settled();
}

const order = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".tl-card"))
    // The library clones the dragged row to follow the finger, and the clone is
    // a .tl-card too. It carries an id of its own, so it can be told apart.
    .filter((c) => c.id !== "dnd-dragged-node-clone")
    .map((c) => c.dataset.name!);

describe("dragging a session", () => {
  it("writes the new order when the finger comes up", async () => {
    const names = ["alpha", "beta", "gamma"];
    const { container, store, api } = await mountSidebar(
      { ...emptyLayout(), ungrouped: [...names] },
      names,
    );
    const cards = layOut(container);

    await drag(cards[0]!, 120, [125, 165]);

    expect(store.layout().ungrouped).toEqual(["beta", "alpha", "gamma"]);
    expect(api.puts.length).toBe(1);
    expect(order(container)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("shuffles the rows as the finger passes them, before it lets go", async () => {
    const names = ["alpha", "beta", "gamma"];
    const { container } = await mountSidebar({ ...emptyLayout(), ungrouped: [...names] }, names);
    const cards = layOut(container);

    point(cards[0]!, "pointerdown", 120);
    await held();
    point(cards[0]!, "pointermove", 125);
    point(cards[0]!, "pointermove", 165);
    await settled();

    // The seat is shown the whole way, rather than appearing at the end.
    expect(order(container)).toEqual(["beta", "alpha", "gamma"]);
    point(cards[0]!, "pointerup", 165);
    await settled();
  });

  it("writes nothing when the row is put back where it started", async () => {
    const names = ["alpha", "beta"];
    const { container, api, store } = await mountSidebar(
      { ...emptyLayout(), ungrouped: [...names] },
      names,
    );
    const cards = layOut(container);

    // Out over the row below and back again: the layout PUT is what hands
    // ordering over to "manual", so a wobble must not change how the list sorts.
    // Down past the row below and back over it: the layout PUT is what hands
    // ordering over to "manual", so a press that wandered and came home must
    // not change how the whole list sorts.
    await drag(cards[0]!, 120, [125, 165, 145, 102]);

    expect(api.puts.length).toBe(0);
    expect(store.layout().ungrouped).toEqual(["alpha", "beta"]);
  });

  it("carries a session into another project", async () => {
    const names = ["a1", "b1"];
    const { container, store } = await mountSidebar(
      {
        ...emptyLayout(),
        projects: [
          { name: "alpha", sessions: ["a1"] },
          { name: "bravo", sessions: ["b1"] },
        ],
      },
      names,
    );
    const cards = layOut(container);

    await drag(cards[0]!, 120, [125, 165]);

    await waitFor(() => {
      const projects = store.layout().projects;
      expect(projects.find((p) => p.name === "bravo")!.sessions).toContain("a1");
      expect(projects.find((p) => p.name === "alpha")!.sessions).not.toContain("a1");
    });
  });

  /**
   * A poll that rebuilt the list mid-drag would move the rows out from under
   * the pointer and take the dragged element with them, and the browser then
   * has nothing left to finish the drag against.
   */
  it("holds the poll while a drag is in the air, and gives it back after", async () => {
    const names = ["alpha", "beta"];
    const { container, store, api } = await mountSidebar(
      { ...emptyLayout(), ungrouped: [...names] },
      names,
    );
    const cards = layOut(container);

    point(cards[0]!, "pointerdown", 120);
    await held();
    point(cards[0]!, "pointermove", 125);
    await settled();

    api.sessionsVal = [...names, "qa-churn-1"].map(sess);
    await store.refresh();
    expect(order(container)).not.toContain("qa-churn-1");

    point(cards[0]!, "pointerup", 125);
    await settled();
    await store.refresh();
    await waitFor(() => expect(order(container)).toContain("qa-churn-1"));
  });
});

describe("dragging a project", () => {
  it("reorders the groups, and only from the header", async () => {
    const names = ["a1", "b1"];
    const { container, store } = await mountSidebar(
      {
        ...emptyLayout(),
        projects: [
          { name: "alpha", sessions: ["a1"] },
          { name: "bravo", sessions: ["b1"] },
        ],
      },
      names,
    );
    const groups = Array.from(container.querySelectorAll<HTMLElement>(".tl-group[data-token]"));
    const headers = Array.from(container.querySelectorAll<HTMLElement>(".tl-group-header"));
    groups.forEach((g, i) => {
      g.getBoundingClientRect = () => rect(100 + i * 80, 80);
    });
    document.elementFromPoint = (_x: number, y: number) =>
      groups.find((g) => {
        const r = g.getBoundingClientRect();
        return y >= r.top && y < r.bottom;
      }) ?? null;

    // A card press is not a group press: the header is the handle, and the
    // card's own list claims that press first either way.
    const card = container.querySelector<HTMLElement>(".tl-card")!;
    point(card, "pointerdown", 120);
    await held();
    expect(groups[0]!.getAttribute("draggable")).not.toBe("true");
    point(card, "pointerup", 120);

    await drag(headers[0]!, 110, [115, 190]);

    await waitFor(() =>
      expect(store.layout().projects.map((p) => p.name)).toEqual(["bravo", "alpha"]),
    );
  });
});
