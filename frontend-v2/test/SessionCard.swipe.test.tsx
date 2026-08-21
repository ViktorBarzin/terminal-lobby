/**
 * Swipe a session row: left opens it (Viktor, 2026-08-20), right kills it
 * behind a confirm (Viktor, 2026-08-21).
 *
 * On a phone the list IS the screen, so opening a session is a tap on a 40px
 * row; a leftward swipe is the second way in, and it is the gesture the session
 * view already uses to move forward through sessions (mobile/swipe.ts).
 *
 * The three ways it must not misfire are all in here: a vertical drag is the
 * list scrolling, a rightward drag is not this gesture, and a drag of any kind
 * must not leave the long-press actions menu open behind it.
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

/** One finger, down at (x, y), up `dx`/`dy` away after `ms`. */
function swipe(
  el: Element,
  { dx, dy = 0, x = 300, y = 200 }: { dx: number; dy?: number; x?: number; y?: number },
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
  point("pointerdown", x, y);
  point("pointermove", x + dx / 2, y + dy / 2);
  point("pointermove", x + dx, y + dy);
  point("pointerup", x + dx, y + dy);
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
    api.sessionsVal = [{ ...sess("shared"), owner: "emo", access: "ro" }];
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
