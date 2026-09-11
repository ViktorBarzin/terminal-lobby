/**
 * SEAM ONE: the pointer resting on a session card is what starts a preload.
 *
 * The card already carries a gesture on the same pointer events — swipe left to
 * open, right to kill, a 450ms hold for the actions menu (SessionCard.swipe /
 * .hold) — and `onPointerLeave` already cancels that gesture. So the hover has
 * to be ADDED to those handlers rather than put in their place, which is what
 * half of this file pins.
 *
 * The other half is that a hover is a MOUSE fact. A finger touching a card
 * fires `pointerenter` too, and a phone that preloaded on every tap would pay
 * for a second tmux attach the user never asked for. `store/preload.ts` refuses
 * a coarse pointer on its own, and the event says `pointerType: "touch"` before
 * the store is ever asked, so the card declines first (ADR-0026: desktop only).
 *
 * What is deliberately NOT here: the dwell, the slot and the TTL. Those are
 * `store/preload.ts`'s and are pinned in test/preload.store.test.ts — this file
 * only asserts that the card asks.
 */
import { describe, it, expect, afterEach, onTestFinished } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { Sidebar } from "../src/components/Sidebar";
import { PreloadHoverContext, type PreloadHover } from "../src/components/SessionCard";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";
import type { Selected } from "../src/store/keepalive";

const sess = (name: string, owner = "wizard"): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner,
  // A session with no origin stamp files itself under System instead.
  origin: "user",
});

class FakeApi implements LobbyApi {
  async setSessionOrigin() {}
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

/** What the card asked the preload store for, in order. */
function recorder(): { calls: string[]; hover: PreloadHover } {
  const calls: string[] = [];
  const say = (verb: string, sel: Selected) => calls.push(`${verb} ${sel.owner ?? ""}/${sel.name}`);
  return {
    calls,
    hover: {
      hoverEnter: (sel) => say("enter", sel),
      hoverLeave: (sel) => say("leave", sel),
    },
  };
}

function mount(api: LobbyApi, hover: PreloadHover) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return (
      <PreloadHoverContext.Provider value={hover}>
        <Sidebar store={store} prefs={prefs} />
      </PreloadHoverContext.Provider>
    );
  });
  onTestFinished(() => store.dispose());
  return { ...utils, store: store! };
}

/** `pointerenter`/`pointerleave` do not bubble, so they are dispatched on the
 *  row itself — which is also where the card listens. */
const point = (el: Element, type: string, pointerType = "mouse"): void => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: false, cancelable: true, pointerType }));
};

/** One finger/mouse down at (x, y), through `via`, lifted at the last point. */
function drag(
  el: Element,
  via: [number, number][],
  { x = 300, y = 200, pointerType = "touch" } = {},
): void {
  const at = (type: string, cx: number, cy: number) =>
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        pointerType,
      }),
    );
  at("pointerdown", x, y);
  for (const [dx, dy] of via) at("pointermove", x + dx, y + dy);
  const last = via[via.length - 1] ?? [0, 0];
  at("pointerup", x + last[0]!, y + last[1]!);
}

async function firstCard(container: HTMLElement, store: LobbyStore): Promise<Element> {
  await store.refresh();
  await waitFor(() => expect(container.querySelector(".tl-card")).not.toBeNull());
  return container.querySelector(".tl-card")!;
}

async function listOf(names: string[]): Promise<FakeApi> {
  const api = new FakeApi();
  api.sessionsVal = names.map((n) => sess(n));
  api.layoutVal = { ...emptyLayout(), ungrouped: [...names] };
  return api;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hovering a session card", () => {
  it("asks the preload store when a mouse arrives on the row", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha", "beta"]), rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter");

    expect(rec.calls).toEqual(["enter /alpha"]);
  });

  it("asks it again when the pointer leaves, so an in-flight preload aborts", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter");
    point(card, "pointerleave");

    expect(rec.calls).toEqual(["enter /alpha", "leave /alpha"]);
  });

  // A finger on a card fires pointerenter before pointerdown. Preloading there
  // would attach a second tmux client per tap on a device that has no hover at
  // all, so the card declines on the pointer TYPE rather than leaning on the
  // store's coarse-pointer refusal alone.
  it("ignores a touch, which is not a hover", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter", "touch");

    expect(rec.calls).toEqual([]);
  });

  it("preloads under a pen, which hovers like a mouse", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter", "pen");

    expect(rec.calls).toEqual(["enter /alpha"]);
  });

  // The row is already dimmed and its terminal already off screen; the only
  // live thing left on it is the undo arrow.
  it("does not preload a session on its way out", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    void store.kill("alpha");
    await waitFor(() => expect(store.killing("alpha")).toBe(true));
    point(card, "pointerenter");

    expect(rec.calls).toEqual([]);
  });

  it("leaves the swipe gesture working", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);
    expect(store.selected()).toBeNull();

    // Enter and leave around the gesture, exactly as a trackpad would.
    point(card, "pointerenter");
    drag(card, [
      [-60, 0],
      [-120, 0],
    ]);

    await waitFor(() => expect(store.selected()?.name).toBe("alpha"));
    expect(rec.calls).toContain("enter /alpha");
  });

  // `onPointerLeave` cancelled the swipe before the hover was wired into it,
  // and it still has to: a finger that leaves the row mid-gesture has not
  // decided anything.
  it("still cancels a swipe when the pointer leaves mid-gesture", async () => {
    const rec = recorder();
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    card.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 300,
        clientY: 200,
        pointerType: "touch",
      }),
    );
    card.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 260,
        clientY: 200,
        pointerType: "touch",
      }),
    );
    point(card, "pointerleave", "touch");
    card.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 160,
        clientY: 200,
        pointerType: "touch",
      }),
    );

    expect(store.selected()).toBeNull();
    expect(rec.calls).toEqual(["leave /alpha"]);
  });

  // A read-only attach calls PinGrid, and tmux-api/grid.go never reverts a pin
  // — so preloading a session this device would join as a viewer would fix its
  // window size for the life of the session, which is the outcome ADR-0026
  // exists to avoid. The card is the first of the two refusals; SessionView's
  // is the second (test/preload.attach.test.tsx).
  it("does not preload a session it would open watching", async () => {
    const rec = recorder();
    localStorage.setItem("tl:watch:v1:alpha", "ro");
    onTestFinished(() => localStorage.clear());
    const { container, store } = mount(await listOf(["alpha"]), rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter");

    expect(rec.calls).toEqual([]);
  });

  // The gate above is read when the pointer ARRIVES, and the dwell is 250 ms
  // long: the lobby poll lands inside it. `store/preload.ts` re-checks only
  // what it can see from where it sits — pointer type, ownership, already open
  // — so the card has to take the hover back itself, or the dwell fires on a
  // session that is now somebody else's to drive.
  it("takes the hover back when the session becomes driven during the dwell", async () => {
    const rec = recorder();
    const api = await listOf(["alpha"]);
    const { container, store } = mount(api, rec.hover);
    const card = await firstCard(container, store);

    point(card, "pointerenter");
    expect(rec.calls).toEqual(["enter /alpha"]);

    // The desktop attaches, and the next poll says so.
    api.sessionsVal = api.sessionsVal.map((x) => ({ ...x, driven: true }));
    await store.refresh();

    await waitFor(() => expect(rec.calls).toEqual(["enter /alpha", "leave /alpha"]));
  });

  it("works with no preload store wired at all", async () => {
    // The provider is the shell's. A sidebar mounted without one — every other
    // suite that mounts a card, and any future call site — must not throw on a
    // hover; it simply preloads nothing.
    let store!: LobbyStore;
    let prefs!: PrefsStore;
    const api = await listOf(["alpha"]);
    const { container } = render(() => {
      store = createLobbyStore({ api, autoStart: false, syncHash: false });
      prefs = createPrefsStore({
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        putDebounceMs: 10_000,
      });
      onCleanup(() => prefs.dispose());
      return <Sidebar store={store} prefs={prefs} />;
    });
    onTestFinished(() => store.dispose());
    const card = await firstCard(container, store);

    expect(() => {
      point(card, "pointerenter");
      point(card, "pointerleave");
    }).not.toThrow();
  });
});
