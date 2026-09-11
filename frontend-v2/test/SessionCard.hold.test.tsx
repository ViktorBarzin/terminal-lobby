/**
 * Press and hold a session row (Viktor, 2026-08-22).
 *
 * One press does two things on a touchscreen: holding opens the row's actions
 * menu, and moving afterwards hands the row to the drag library, which runs a
 * press timer of its own on the same 450ms (dnd/sidebar.ts). Viktor picked that
 * order. What is under test here is the seam between them — that the hold still
 * opens the menu, that letting go leaves it open, and that moving closes it,
 * because a `position: fixed` popup on a row that is about to be cloned and
 * moved would otherwise be left hanging over the list.
 *
 * The drag itself is not tested here. It has no observable behaviour in jsdom,
 * which has neither layout nor hit-testing, so what it decides is tested as
 * arithmetic in dnd.plan.test.ts and the gesture is exercised in a real browser.
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
    return <Sidebar store={store} prefs={prefs} />;
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
      ({
        top: 100 + i * 40,
        bottom: 140 + i * 40,
        height: 40,
        left: 0,
        right: 300,
        width: 300,
      }) as DOMRect;
  });
  const scroller = container.querySelector<HTMLElement>(".tl-sidebar-scroll");
  if (scroller) {
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, height: 800, left: 0, right: 300, width: 300 }) as DOMRect;
  }
  return cards;
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

describe("press and hold a session row", () => {
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

  it("closes the menu when the finger moves, whichever way it goes", async () => {
    for (const [dx, dy] of [
      [0, 30],
      [0, -30],
      [30, 0],
    ]) {
      const { container, unmount } = await mountList(["alpha", "beta"]);
      const [alpha] = layOut(container);

      touch(alpha!, "pointerdown", 120);
      await held();
      expect(container.querySelector(".tl-menu")).not.toBeNull();
      touch(alpha!, "pointermove", 120 + dy!, 150 + dx!);

      expect(container.querySelector(".tl-menu")).toBeNull();
      unmount();
    }
  });

  /**
   * Every menu on the page closes, not only the row's own.
   *
   * A row cannot close its menu from its own pointer handlers: a touchscreen
   * sends it `pointercancel` the moment the browser hands the gesture to the
   * drag, which is exactly when the menu would need to go (measured on the
   * Android emulator — it stayed open for the whole drag). The drag announces
   * itself on the document instead, and this is what that buys.
   */
  it("closes a group's menu too when a row is picked up", async () => {
    const { container, getByLabelText } = await mountList(["alpha", "beta"]);
    const [alpha] = layOut(container);

    getByLabelText("Group actions").click();
    await waitFor(() => expect(container.querySelector(".tl-menu")).not.toBeNull());

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 150);
    await new Promise((r) => setTimeout(r, 60));

    expect(container.querySelector(".tl-menu")).toBeNull();
    touch(alpha!, "pointerup", 150);
  });

  it("does not hold on someone else's session, which has no actions", async () => {
    const { container } = await mountList(
      ["shared"],
      [sess("shared", { owner: "bob", access: "ro" })],
    );
    const [shared] = layOut(container);

    touch(shared!, "pointerdown", 120);
    await held();

    expect(container.querySelector(".tl-menu")).toBeNull();
  });

  /**
   * The row's drag surface belongs to the library now, and the proof is that
   * the library put it there: `draggable` is set on a registered node by its
   * own setup, so a row that carries it is one the sortable knows about.
   *
   * The card carried its own HTML5 drag until then, and the file-drop overlay
   * had quietly been refusing every one of those drops for a day (dnd/sidebar.ts
   * has the mechanism).
   */
  it("hands its rows to the library, and keeps a shared one out of it", async () => {
    const { container } = await mountList(
      ["alpha", "shared"],
      [sess("alpha"), sess("shared", { owner: "bob", access: "ro" })],
    );
    const own = container.querySelector<HTMLElement>('.tl-card[data-name="alpha"]')!;
    const shared = container.querySelector<HTMLElement>('.tl-card[data-name="shared"]')!;

    await waitFor(() => expect(own.getAttribute("draggable")).toBe("true"));
    // Someone else's session is read-only here, and reordering it would ask the
    // layout to hold a name this account does not own.
    expect(shared.getAttribute("draggable")).not.toBe("true");

    // The group's list says which group a drop landed in, and each row says
    // which session it is. Both are read back when the pointer comes up.
    const body = container.querySelector<HTMLElement>(".tl-group-body")!;
    expect(body.getAttribute("data-group")).toBe("");
  });
});
