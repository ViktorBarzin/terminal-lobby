/**
 * A lifted row must stay under the finger while the list scrolls beneath it.
 *
 * Reported 2026-08-29: "when dragging and dropping sessions in the list, once
 * the window scrolls up, the dragged object no longer matches where we drag."
 *
 * The row is positioned with `transform: translateY(liftDy)`, and `liftDy` was
 * the finger's travel in CLIENT space alone. `translateY` is relative to the
 * row's own LAYOUT box, which lives inside `.tl-sidebar-scroll` — so every pixel
 * the list scrolls moves the box out from under a delta that never heard about
 * it. Measured on the deployed build at 390x844: drift equalled the change in
 * scrollTop at a ratio of 1.000 in every sample, both directions, and it never
 * recovered — pulling back out of the edge zone froze the error for the rest of
 * the drag.
 *
 * Two ways in, and the second is the one a person actually hits:
 *   - the list scrolls while the finger MOVES (test 1);
 *   - the list AUTO-scrolls while the finger rests at an edge (test 2), where no
 *     pointermove arrives at all, so nothing recomputed the transform. That is
 *     why the fix cannot be "make the transform a pure function of current
 *     inputs" — `liftDy` is a signal and `scrollTop` is a plain DOM property
 *     with nothing reactive behind it, so the rAF loop has to place the row
 *     itself.
 *
 * jsdom has neither scrolling nor layout, so both are supplied: scrollTop is a
 * real backing value (jsdom otherwise drops writes and reads 0, which is what
 * made the auto-scroll a silent no-op in the existing tests), and the rects
 * subtract it, so rows appear to move exactly as they would on a device.
 */
import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";

const PAST_THE_HOLD = 600;
const held = () => new Promise((r) => setTimeout(r, PAST_THE_HOLD));

const sess = (name: string): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
});

class FakeApi implements LobbyApi {
  async prewarm() {}
  async releasePrewarm() {}
  layoutVal: Layout = emptyLayout();
  sessionsVal: Session[] = [];
  async whoami(): Promise<Whoami> {
    return { authentik: "wiz", osUser: "wizard" };
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
  async retitleSession(): Promise<never> {
    throw new ApiError(404, "no");
  }
  async setSessionTitle(): Promise<never> {
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

async function mountList(names: string[]) {
  const api = new FakeApi();
  api.sessionsVal = names.map(sess);
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
  return { ...utils, store: store! };
}

/**
 * Rows 40px tall from y=100, inside a 0..800 scroller — and a scrollTop that is
 * REAL. jsdom drops scrollTop writes and reads back 0, which is exactly why the
 * auto-scroll has always been a no-op under test and this bug went unseen. The
 * rects subtract it, so scrolling moves the rows the way it does on a device.
 */
function layOut(container: HTMLElement): {
  cards: HTMLElement[];
  scroller: HTMLElement;
  scrollTo: (px: number) => void;
} {
  const cards = Array.from(container.querySelectorAll<HTMLElement>(".tl-card"));
  let top = 0;
  const scroller = container.querySelector<HTMLElement>(".tl-sidebar-scroll")!;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, 400)); // clamps like a real scroller
    },
  });
  // jsdom reports both as 0, which would make the drag read "nothing to
  // scroll". 1200 of content in an 800 box is the 400 the setter clamps to.
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1200 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 800 });
  cards.forEach((card, i) => {
    card.getBoundingClientRect = () =>
      ({
        top: 100 + i * 40 - top,
        bottom: 140 + i * 40 - top,
        height: 40,
        left: 0,
        right: 300,
        width: 300,
      }) as DOMRect;
  });
  scroller.getBoundingClientRect = () =>
    ({ top: 0, bottom: 800, height: 800, left: 0, right: 300, width: 300 }) as DOMRect;
  return { cards, scroller, scrollTo: (px) => (scroller.scrollTop = px) };
}

const hitTestBy = (cards: HTMLElement[]) => (_x: number, y: number) => {
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (y >= r.top && y < r.bottom) return card.querySelector(".tl-card-name") ?? card;
  }
  return null;
};

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

/** The px in `translateY(<n>px)`, or NaN if the row is not lifted. */
const translateY = (el: HTMLElement): number => {
  const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? Number(m[1]) : NaN;
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("a lifted row tracks the finger while the list scrolls", () => {
  it("follows the list when it scrolls under a finger that has not moved", async () => {
    const { container } = await mountList(["alpha", "beta", "gamma"]);
    const { cards, scrollTo } = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 150);
    const before = translateY(alpha!);
    expect(before, "the row is lifted and positioned").not.toBeNaN();

    // The list moves 40px under a finger that stayed at 150.
    scrollTo(40);
    touch(alpha!, "pointermove", 150);

    // The row's layout box just moved UP 40px, so the transform has to grow by
    // 40 for the row to stay where the finger is.
    expect(translateY(alpha!) - before).toBe(40);
  });

  it("follows an AUTO-scroll, which fires no pointermove at all", async () => {
    // The finger rests in the edge zone; edgeScroll drives the rAF loop and no
    // further pointer event ever arrives. This is the case a person hits.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const { container } = await mountList(["alpha", "beta", "gamma"]);
    const { cards, scroller } = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 790); // inside the bottom edge zone of 0..800
    const before = translateY(alpha!);
    const scrolledFrom = scroller.scrollTop;

    // One frame of auto-scroll.
    const step = frames.pop();
    expect(step, "the edge started the scroll loop").toBeTypeOf("function");
    step!(0);

    const moved = scroller.scrollTop - scrolledFrom;
    expect(moved, "the list actually scrolled").toBeGreaterThan(0);
    expect(translateY(alpha!) - before, "the row moved with it").toBe(moved);
  });

  it("stops the auto-scroll at the list's real end", async () => {
    // The lifted row's own transform counts toward the scroller's scrollable
    // overflow. Once the row follows the finger correctly it reaches past the
    // list's bottom, extending the scroll area — which lets the auto-scroll
    // extend it again, and so on. Measured in a browser before this clamp:
    // scrollHeight-clientHeight climbed 255 -> 1356 and the list ran 952px past
    // its end with the thumb resting still. The end is where the list ended
    // when the row was picked up; store.hold() freezes the rows, so nothing
    // else can move it.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const { container } = await mountList(["alpha", "beta", "gamma"]);
    const { cards, scroller } = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    // The ghost grows the content as it travels, exactly as a browser reports.
    // Defined BEFORE the lift, so the end recorded at lift is 1000-800 = 200.
    let extra = 0;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 1000 + extra,
    });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 800 });

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 790); // rest in the bottom edge zone

    for (let i = 0; i < 40; i++) {
      const step = frames.pop();
      if (!step) break;
      extra += 50; // every frame the row reaches further past the end
      step(0);
    }

    // 1000 - 800 = 200 was the end when the row was lifted.
    expect(scroller.scrollTop).toBeLessThanOrEqual(200);
  });

  it("keeps the row under the finger when the list scrolls back", async () => {
    // Drift never recovered on the device: pulling out of the edge zone froze
    // the error. A signed delta against the live scrollTop unwinds instead.
    const { container } = await mountList(["alpha", "beta", "gamma"]);
    const { cards, scrollTo } = layOut(container);
    document.elementFromPoint = hitTestBy(cards);
    const [alpha] = cards;

    touch(alpha!, "pointerdown", 120);
    await held();
    touch(alpha!, "pointermove", 150);
    const before = translateY(alpha!);

    scrollTo(120);
    touch(alpha!, "pointermove", 150);
    scrollTo(0);
    touch(alpha!, "pointermove", 150);

    expect(translateY(alpha!)).toBe(before);
  });
});
