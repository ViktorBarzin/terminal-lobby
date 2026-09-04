/**
 * Press, hold, then drag a session row to reorder it (Viktor, 2026-08-22).
 *
 * The mouse has HTML5 drag-and-drop, which a touch screen never fires, so
 * before this a phone could only reorder sessions by not being a phone. The
 * press-and-hold already opened the actions menu; Viktor asked for both from
 * the one gesture, and picked the order: the menu opens as it always has, and
 * moving the finger afterwards closes it and takes the row along.
 *
 * jsdom has no layout and no `elementFromPoint`, so both are supplied here: the
 * rects say where the two rows are, and the hit-test says which one the finger
 * is over. What is under test is the wiring between them — that a hold arms a
 * drag, that the row under the finger shows where the drop will land, and that
 * letting go writes the new order.
 */
import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

/** The hold is 450ms in SessionCard; wait past it with real time, since fake
 *  timers and Solid's scheduling do not mix well enough to be worth it. */
const PAST_THE_HOLD = 600;
const held = () => new Promise((r) => setTimeout(r, PAST_THE_HOLD));

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
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

async function mountList(names: string[], sessions?: Session[]) {
  const api = new FakeApi();
  api.sessionsVal = sessions ?? names.map((n) => sess(n));
  api.layoutVal = { ...emptyLayout(), ungrouped: [...names] };
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} confirm={() => true} />;
  });
  onTestFinished(() => store.dispose());
  await store.refresh();
  await waitFor(() =>
    expect(utils.container.querySelectorAll(".tl-card").length).toBe(names.length),
  );
  return { ...utils, store: store!, api };
}

/** Rows 40px tall stacked from y=100, and a list box around them, since jsdom
 *  measures everything as zero. */
function layOut(container: HTMLElement): HTMLElement[] {
  const cards = Array.from(container.querySelectorAll<HTMLElement>(".tl-card"));
  cards.forEach((card, i) => {
    card.getBoundingClientRect = () =>
      ({ top: 100 + i * 40, bottom: 140 + i * 40, height: 40, left: 0, right: 300, width: 300 }) as DOMRect;
  });
  const scroller = container.querySelector<HTMLElement>(".tl-sidebar-scroll");
  if (scroller) {
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800, left: 0, right: 300, width: 300 }) as DOMRect;
  }
  return cards;
}

/** Whatever row covers `y`, as `elementFromPoint` would answer. */
function hitTestBy(cards: HTMLElement[]): (x: number, y: number) => Element | null {
  return (_x, y) => {
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (y >= r.top && y < r.bottom) return card.querySelector(".tl-card-name") ?? card;
    }
    return null;
  };
}

const touch = (el: Element, type: string, y: number, x = 150) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("press, hold and drag a session row", () => {
  it("opens the menu on the hold, exactly as it did before", async () => {
    const { container } = await mountList(["alpha", "beta"]);
    const [alpha] = layOut(container);

    touch(alpha!, "pointerdown", 120);
    await held();

    expect(container.querySelector(".tl-menu")).not.toBeNull();
    touch(alpha!, "pointerup", 120);
    // Let go without moving and the menu is still there to use.
    expect(container.querySelector(".tl-menu")).not.toBeNull();
  });

  it("closes the menu and lifts the row when the finger moves", async () => {
    const { container } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha, beta] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 150); // into beta's TOP half (140..180)

    expect(container.querySelector(".tl-menu"), "menu still open").toBeNull();
    expect(alpha!.classList.contains("tl-card-lifted")).toBe(true);
    expect(alpha!.style.transform).toContain("translateY");
    expect(beta!.classList.contains("tl-drop-above")).toBe(true);
  });

  it("marks the far side of the row the finger has crossed", async () => {
    const { container } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha, beta] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 175); // past beta's middle (140..180, mid 160)

    expect(beta!.classList.contains("tl-drop-below")).toBe(true);
    expect(beta!.classList.contains("tl-drop-above")).toBe(false);
  });

  it("writes the new order when the finger comes up", async () => {
    const { container, store, api } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 175);
    touch(alpha!, "pointerup", 175);

    await waitFor(() => expect(store.layout().ungrouped).toEqual(["beta", "alpha"]));
    expect((api as FakeApi).layoutVal.ungrouped).toEqual(["beta", "alpha"]);
    // And nothing is left lifted or marked once the drag is over.
    expect(container.querySelector(".tl-card-lifted")).toBeNull();
    expect(container.querySelector(".tl-drop-above,.tl-drop-below")).toBeNull();
  });

  it("holds the page still while the row is being dragged", async () => {
    const { container } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 150);

    const e = new Event("touchmove", { bubbles: true, cancelable: true });
    alpha!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  /**
   * The list scrolls itself as the finger nears the bottom, so the last row
   * climbs away from the finger and the drag ends in the empty space below it.
   * Measured on the deployed build: a drag aimed at the last row finished 2px
   * past its bottom edge and dropped nowhere at all. The indicator is the
   * promise — where it was last shown is where the row lands.
   */
  it("keeps the last place it showed when the finger runs off the end", async () => {
    const { container, store } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 175); // over beta's bottom half
    document.elementFromPoint = () => null; // and then past the end of the list
    touch(alpha!, "pointermove", 600);
    touch(alpha!, "pointerup", 600);

    await waitFor(() => expect(store.layout().ungrouped).toEqual(["beta", "alpha"]));
  });

  it("leaves the order alone when the drag ends over nothing", async () => {
    const { container, store } = await mountList(["alpha", "beta"]);
    const cards = layOut(container);
    document.elementFromPoint = () => null; // dragged off the list
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 600);
    touch(alpha!, "pointerup", 600);

    await new Promise((r) => setTimeout(r, 50));
    expect(store.layout().ungrouped).toEqual(["alpha", "beta"]);
  });

  it("does not drag someone else's session, which it cannot reorder", async () => {
    const { container, store } = await mountList(
      ["shared"],
      [sess("shared", { owner: "bob", access: "ro" })],
    );
    const cards = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [shared] = cards;

    touch(shared!, "pointerdown", 120);
    await held();
    touch(shared!, "pointermove", 165);

    expect(shared!.classList.contains("tl-card-lifted")).toBe(false);
    expect(store.dragName()).toBeNull();
  });
});
