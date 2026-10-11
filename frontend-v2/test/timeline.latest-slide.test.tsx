/**
 * "Latest" slides the transcript down to the live end instead of jumping there
 * (Viktor, 2026-10-11: "a nicer animation would be a better UX").
 *
 * jsdom has no layout and no animation clock, so the scroller's geometry is
 * stubbed and animation frames are played by hand with the timestamps a browser
 * would hand them.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { SLIDE_MS, slideFrom, slideTop } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "first prompt" }),
  ev({ id: 2, kind: "text", body: "first answer" }),
  ev({ id: 3, kind: "turn_end" }),
  ev({ id: 4, kind: "user", body: "second prompt" }),
  ev({ id: 5, kind: "text", body: "second answer" }),
];

/** A 300px box over 1000px of transcript: the live end is at 700. */
function stubScroller(el: HTMLElement) {
  const state = { top: 700, height: 1000 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
  return state;
}

/** Frames queue up and run when `frame(ms)` says the clock reached `ms`. */
function withFrames() {
  let queue: Array<FrameRequestCallback> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
  return {
    frame: (ms: number) => queue.splice(0).forEach((f) => f(ms)),
    pending: () => queue.length,
  };
}

function mount(opts: { follow?: () => number; events?: () => Event[] } = {}) {
  const atEnd: boolean[] = [];
  let toEnd: (() => void) | undefined;
  const { container } = render(() => (
    <MessagesTimeline
      events={opts.events?.() ?? TRANSCRIPT}
      follow={opts.follow?.()}
      onAtEnd={(a) => atEnd.push(a)}
      registerToEnd={(fn) => {
        toEnd = fn;
      }}
    />
  ));
  const el = container.querySelector<HTMLElement>(".tl-timeline");
  if (!el || !toEnd) throw new Error("no timeline");
  const geom = stubScroller(el);
  return { el, atEnd, toEnd, geom };
}

/** The reader wheels up to `top`, which lets go of the live end. */
function scrollUpTo(el: HTMLElement, geom: { top: number }, top: number) {
  fireEvent.wheel(el, { deltaY: -120 });
  geom.top = top;
  fireEvent.scroll(el);
}

afterEach(() => vi.unstubAllGlobals());

describe("the slide's arithmetic", () => {
  it("starts where the reader is when the end is close", () => {
    expect(slideFrom(400, 700, 300)).toBe(400);
  });

  it("starts a screen and a half short of the end when the end is far", () => {
    expect(slideFrom(0, 7000, 300)).toBe(6550);
  });

  it("never starts below where the reader already is", () => {
    expect(slideFrom(690, 700, 300)).toBe(690);
  });

  it.each([0, 0.1, 0.25, 0.5, 0.75, 0.9].map((f) => f * SLIDE_MS))(
    "moves forward and stays between its ends at %ims",
    (ms) => {
      const top = slideTop(100, 500, ms);
      expect(top).toBeGreaterThanOrEqual(100);
      expect(top).toBeLessThan(500);
      expect(slideTop(100, 500, ms + 16)).toBeGreaterThan(top);
    },
  );

  it("eases out: the first half covers more than half the way", () => {
    expect(slideTop(0, 400, SLIDE_MS / 2)).toBeGreaterThan(200);
  });

  it("lands exactly on the end once the time is up", () => {
    expect(slideTop(100, 500, SLIDE_MS)).toBe(500);
    expect(slideTop(100, 500, SLIDE_MS * 3)).toBe(500);
  });
});

describe("Latest slides to the live end", () => {
  it("moves the view over several frames and lands at the end", () => {
    const { frame, pending } = withFrames();
    const { el, atEnd, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);

    toEnd();
    expect(geom.top, "no jump on the press").toBe(300);
    expect(atEnd.at(-1), "pinned from the press").toBe(true);
    frame(1000);
    frame(1000 + SLIDE_MS / 3);
    expect(geom.top).toBeGreaterThan(300);
    expect(geom.top).toBeLessThan(700);
    frame(1000 + SLIDE_MS);
    expect(geom.top).toBe(700);
    expect(pending(), "the slide stops scheduling frames").toBe(0);
  });

  it("jumps most of a long way and slides the last screen and a half", () => {
    const { frame } = withFrames();
    const { el, toEnd, geom } = mount();
    geom.height = 10_000;
    scrollUpTo(el, geom, 0);

    toEnd();
    expect(geom.top).toBe(9700 - 450);
    frame(0);
    frame(SLIDE_MS);
    expect(geom.top).toBe(9700);
  });

  it("ignores its own scroll events instead of snapping to the end", () => {
    const { frame } = withFrames();
    const { el, atEnd, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);

    toEnd();
    frame(0);
    frame(SLIDE_MS / 3);
    const mid = geom.top;
    fireEvent.scroll(el);
    expect(geom.top, "the slide keeps the view").toBe(mid);
    expect(atEnd.at(-1)).toBe(true);
  });

  it("chases an end that moves while it slides", () => {
    const { frame } = withFrames();
    const { el, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);

    toEnd();
    frame(0);
    frame(SLIDE_MS / 3);
    geom.height = 1200; // a reply streaming in
    frame(SLIDE_MS);
    expect(geom.top).toBe(900);
  });

  it("a message arriving mid-slide does not cut it short", () => {
    const { frame } = withFrames();
    const [events, setEvents] = createSignal(TRANSCRIPT);
    const { el, toEnd, geom } = mount({ events });
    scrollUpTo(el, geom, 300);

    toEnd();
    frame(0);
    frame(SLIDE_MS / 3);
    const mid = geom.top;
    setEvents([...TRANSCRIPT, ev({ id: 6, kind: "text", body: "more" })]);
    expect(geom.top).toBe(mid);
  });

  it("stops where the reader takes over, and lets go of the live end", () => {
    const { frame, pending } = withFrames();
    const { el, atEnd, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);

    toEnd();
    frame(0);
    frame(SLIDE_MS / 3);
    const mid = geom.top;
    fireEvent.touchStart(el);
    frame(SLIDE_MS);
    expect(geom.top).toBe(mid);
    expect(pending()).toBe(0);
    expect(atEnd.at(-1), "Latest comes back").toBe(false);
  });

  it("jumps straight there when the reader asked for less motion", () => {
    withFrames();
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const { el, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);

    toEnd();
    expect(geom.top).toBe(700);
  });

  it("a send still jumps to the end at once", () => {
    withFrames();
    const [follow, setFollow] = createSignal(0);
    const { el, geom } = mount({ follow });
    scrollUpTo(el, geom, 300);

    setFollow(1);
    expect(geom.top).toBe(700);
  });
});
