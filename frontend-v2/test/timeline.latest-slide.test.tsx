/**
 * "Latest" slides the transcript down to the live end instead of jumping there
 * (Viktor, 2026-10-11: "a nicer animation would be a better UX"), from where
 * the reader is and all the way ("it seems we're not scrolling smoothly from
 * the current position until the end but rather jumping").
 *
 * jsdom has no layout and no animation clock, so the scroller's geometry is
 * stubbed and animation frames are played by hand with the timestamps a browser
 * would hand them.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { slideMs, slideTop } from "../src/components/timeline.logic";
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
  const published: boolean[] = [];
  let toEnd: (() => void) | undefined;
  const { container } = render(() => (
    <MessagesTimeline
      events={opts.events?.() ?? TRANSCRIPT}
      follow={opts.follow?.()}
      onAtEnd={(a) => atEnd.push(a)}
      onPinned={(p) => published.push(p)}
      registerToEnd={(fn) => {
        toEnd = fn;
      }}
    />
  ));
  const el = container.querySelector<HTMLElement>(".tl-timeline");
  if (!el || !toEnd) throw new Error("no timeline");
  const geom = stubScroller(el);
  return { el, atEnd, published, toEnd, geom };
}

/** The reader wheels up to `top`, which lets go of the live end. */
function scrollUpTo(el: HTMLElement, geom: { top: number }, top: number) {
  fireEvent.wheel(el, { deltaY: -120 });
  geom.top = top;
  fireEvent.scroll(el);
}

afterEach(() => vi.unstubAllGlobals());

const SLIDE_MS = slideMs(400);

describe("the slide's arithmetic", () => {
  it("takes longer the further it goes, within bounds", () => {
    expect(slideMs(200)).toBeGreaterThanOrEqual(300);
    expect(slideMs(5000)).toBeGreaterThan(slideMs(1000));
    expect(slideMs(1_000_000)).toBeLessThanOrEqual(1000);
  });

  it.each([0.1, 0.25, 0.5, 0.75, 0.9])("moves forward and stays between its ends at %f", (f) => {
    const ms = slideMs(400) * f;
    const top = slideTop(100, 500, ms, slideMs(400));
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(500);
    expect(slideTop(100, 500, ms + 16, slideMs(400))).toBeGreaterThan(top);
  });

  it("leaves from where the reader is: the first frame covers a sliver of a long way", () => {
    const ms = slideMs(20_000);
    expect(slideTop(0, 20_000, 16, ms)).toBeLessThan(200);
  });

  it("lands exactly on the end once the time is up", () => {
    expect(slideTop(100, 500, 400, 400)).toBe(500);
    expect(slideTop(100, 500, 1200, 400)).toBe(500);
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

  it("goes all the way from where the reader is, with no jump first", () => {
    const { frame } = withFrames();
    const { el, toEnd, geom } = mount();
    geom.height = 10_000;
    scrollUpTo(el, geom, 0);

    toEnd();
    expect(geom.top, "nothing moves on the press").toBe(0);
    frame(0);
    frame(16);
    expect(geom.top).toBeGreaterThan(0);
    expect(geom.top).toBeLessThan(200);
    frame(slideMs(9700));
    expect(geom.top).toBe(9700);
  });

  /**
   * The store trims the transcript back to its last turns the moment it hears
   * the reader is at the end. Told at the press, it took the turns the reader
   * had paged in out from under the slide before its first frame, and the view
   * jumped to whatever now sat at that scrollTop.
   */
  it("tells the store the reader is at the end only when the slide lands", () => {
    const { frame } = withFrames();
    const { el, published, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);
    expect(published.at(-1)).toBe(false);

    toEnd();
    frame(0);
    frame(SLIDE_MS / 2);
    expect(published.at(-1), "not while sliding").toBe(false);
    frame(SLIDE_MS);
    expect(published.at(-1), "on landing").toBe(true);
  });

  it("does not tell the store anything when the reader takes over mid-slide", () => {
    const { frame } = withFrames();
    const { el, published, toEnd, geom } = mount();
    scrollUpTo(el, geom, 300);
    const before = published.length;

    toEnd();
    frame(0);
    frame(SLIDE_MS / 3);
    fireEvent.touchStart(el);
    expect(published.length).toBe(before);
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
