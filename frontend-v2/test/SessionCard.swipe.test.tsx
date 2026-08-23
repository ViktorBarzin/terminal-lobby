/**
 * Swipe a session row: left opens it (Viktor, 2026-08-20), right kills it
 * behind a confirm (Viktor, 2026-08-21).
 *
 * On a phone the list IS the screen, so opening a session is a tap on a 40px
 * row; a leftward swipe is the second way in.
 *
 * THE AXIS IS CLAIMED ONCE, on the first few pixels of movement, and everything
 * else follows from that (Viktor, 2026-08-22: "we still have scrolling on
 * mobile and this causes the swipe movements to not work"). Measured on the
 * deployed build at 390x844, three of four thumb-shaped drags did nothing: a
 * 900 ms deliberate drag (over the old 700 ms cap), a drag that drifted 90px
 * down while travelling 140px across (under the old 1.8 ratio), and one that
 * hesitated downward first — that last one came back as `pointercancel`,
 * because the browser had already taken the gesture for a scroll.
 *
 * So: whichever axis wins the first 10px owns the finger. Sideways means the
 * row trails it and the page is held still (a non-passive touchmove listener,
 * since the browser only accepts a refusal before it commits to scrolling), and
 * the release is decided on distance alone — the row follows the finger, so the
 * finger sets the pace. Downwards means the list scrolls and this gesture is
 * over.
 */
import { describe, it, expect, afterEach, onTestFinished } from "vitest";
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
  kills: string[] = [];
  async killSession(name: string) {
    this.kills.push(name);
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== name);
  }
  async renameSession() {
    throw new ApiError(404, "no");
  }
  async retitleSession() {
    throw new ApiError(404, "no");
  }
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
  async listDirs() {
    return [];
  }
}

function mount(api: LobbyApi, confirm?: (message: string) => boolean) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} confirm={confirm} />;
  });
  onTestFinished(() => store.dispose());
  return { ...utils, store: store! };
}

/** One finger down at (x, y), moved through `via`, lifted at the last point. */
function finger(
  el: Element,
  via: [number, number][],
  { x = 300, y = 200, ms = 0 }: { x?: number; y?: number; ms?: number } = {},
): void {
  const point = (type: string, cx: number, cy: number) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        pointerType: "touch",
      }),
    );
  // A fake clock, so a deliberate drag can be told from a flick without the
  // test taking a second to run.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    point("pointerdown", x, y);
    for (const [dx, dy] of via) {
      clock += ms / via.length;
      point("pointermove", x + dx, y + dy);
    }
    const last = via[via.length - 1] ?? [0, 0];
    point("pointerup", x + last[0]!, y + last[1]!);
  } finally {
    Date.now = realNow;
  }
}

/** One finger, straight from the start to (dx, dy), in two moves. */
function swipe(
  el: Element,
  {
    dx,
    dy = 0,
    x = 300,
    y = 200,
    ms = 0,
  }: { dx: number; dy?: number; x?: number; y?: number; ms?: number },
): void {
  finger(el, [[dx / 2, dy / 2], [dx, dy]], { x, y, ms });
}

/** Was the page allowed to scroll while the finger was moving? */
function touchMoveWasBlocked(el: Element): boolean {
  const e = new Event("touchmove", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

async function firstCard(container: HTMLElement, store: LobbyStore): Promise<Element> {
  await store.refresh();
  await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
  return container.querySelector(".tl-card")!;
}

async function listOf(names: string[]) {
  const api = new FakeApi();
  api.sessionsVal = names.map(sess);
  api.layoutVal = { ...emptyLayout(), ungrouped: [...names] };
  return api;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("swiping a session row", () => {
  it("opens the session when the swipe goes left", async () => {
    const api = await listOf(["alpha", "beta"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);
    expect(store.selected()).toBeNull();

    swipe(card, { dx: -120 });

    await waitFor(() => expect(store.selected()?.name).toBe("alpha"));
  });

  it("leaves the list alone when the drag is vertical", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    swipe(card, { dx: -30, dy: 160 });

    expect(store.selected()).toBeNull();
  });

  // Measured on the deployed build: a thumb that travels 140px across while
  // drifting 90px down did nothing, because the release compared the two
  // distances. The first 10px had already said sideways.
  it("keeps a sideways swipe that drifts down as it travels", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    swipe(card, { dx: -140, dy: 90 });

    await waitFor(() => expect(store.selected()?.name).toBe("alpha"));
  });

  // The row trails the finger the whole way, so a slow drag is a deliberate
  // one, not a failed flick. 900ms of it used to be discarded in silence.
  it("acts on a slow, deliberate drag", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    swipe(card, { dx: -140, ms: 1200 });

    await waitFor(() => expect(store.selected()?.name).toBe("alpha"));
  });

  it("does nothing when the finger comes back to where it started", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    finger(card, [[-140, 0], [-70, 0], [-8, 0]]);

    expect(store.selected()).toBeNull();
  });

  /**
   * The browser only accepts a refusal to scroll while it is still deciding, so
   * the answer has to be given on the first movement rather than once the drag
   * is long enough to count. A vertical drag is never refused: that one IS the
   * list scrolling.
   */
  it("holds the page still once the finger has claimed the row sideways", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);
    const point = (type: string, cx: number, cy: number) =>
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          pointerType: "touch",
        }),
      );

    point("pointerdown", 300, 200);
    expect(touchMoveWasBlocked(card), "nothing claimed yet").toBe(false);
    point("pointermove", 286, 204); // 14px across, 4 down: sideways
    expect(touchMoveWasBlocked(card)).toBe(true);
    point("pointerup", 286, 204);
  });

  it("lets the list scroll when the finger went down it", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);
    const point = (type: string, cx: number, cy: number) =>
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          pointerType: "touch",
        }),
      );

    point("pointerdown", 300, 200);
    point("pointermove", 296, 218); // 4px across, 18 down: the list
    expect(touchMoveWasBlocked(card)).toBe(false);
    // And the row does not trail a scroll.
    expect(card.getAttribute("data-swipe")).toBeNull();
    point("pointerup", 296, 300);
  });

  it("does not OPEN a session on a rightward swipe", async () => {
    const api = await listOf(["alpha"]);
    const asked: string[] = [];
    const { container, store } = mount(api, (m) => {
      asked.push(m);
      return false;
    });
    const card = await firstCard(container, store);

    swipe(card, { dx: 140 });

    expect(store.selected()).toBeNull();
  });

  it("does not leave the actions menu open behind the gesture", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    swipe(card, { dx: -120 });

    await waitFor(() => expect(store.selected()?.name).toBe("alpha"));
    expect(container.querySelector(".tl-menu")).toBeNull();
  });

  it("ignores a mouse drag, which is a selection, not a swipe", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api);
    const card = await firstCard(container, store);

    const point = (type: string, cx: number) =>
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: 200,
          pointerType: "mouse",
        }),
      );
    point("pointerdown", 300);
    point("pointermove", 180);
    point("pointerup", 180);

    expect(store.selected()).toBeNull();
  });
});

describe("swiping a session row right", () => {
  it("asks before killing, and kills when the answer is yes", async () => {
    const api = await listOf(["alpha", "beta"]);
    const asked: string[] = [];
    const { container, store } = mount(api, (m) => {
      asked.push(m);
      return true;
    });
    const card = await firstCard(container, store);

    swipe(card, { dx: 150 });

    await waitFor(() => expect((api as FakeApi).kills).toEqual(["alpha"]));
    // The same question the ⋯ menu's Kill asks, so the two paths read alike.
    expect(asked).toEqual(['Kill session "alpha"?']);
    expect(store.selected()).toBeNull();
  });

  it("kills nothing when the answer is no", async () => {
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api, () => false);
    const card = await firstCard(container, store);

    swipe(card, { dx: 150 });

    await waitFor(() => expect(store.sessions.length).toBe(1));
    expect((api as FakeApi).kills).toEqual([]);
  });

  it("does not offer to kill a session belonging to someone else", async () => {
    const api = await listOf(["shared"]);
    api.sessionsVal = [{ ...sess("shared"), owner: "bob", access: "ro" }];
    const asked: string[] = [];
    const { container, store } = mount(api, (m) => {
      asked.push(m);
      return true;
    });
    const card = await firstCard(container, store);

    swipe(card, { dx: 150 });

    expect(asked).toEqual([]);
    expect((api as FakeApi).kills).toEqual([]);
  });

  it("does not kill on a drag too short to be deliberate", async () => {
    const api = await listOf(["alpha"]);
    const asked: string[] = [];
    const { container, store } = mount(api, (m) => {
      asked.push(m);
      return true;
    });
    const card = await firstCard(container, store);

    swipe(card, { dx: 40 });

    expect(asked).toEqual([]);
    expect((api as FakeApi).kills).toEqual([]);
  });
});
