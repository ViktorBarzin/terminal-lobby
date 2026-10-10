/**
 * "Latest" pressed while the transcript is still gliding.
 *
 * Reported by Viktor 2026-10-10 on an iPhone: after a flick, tapping Latest
 * while the scroll was still moving did nothing. Two things combined. The tap's
 * own touchend counted as the reader scrolling for GESTURE_MS, so the glide's
 * next scroll event read as the reader's and let go of the pin the button had
 * just set. And iOS keeps a momentum scroll going through a scrollTop write, so
 * the glide carried the view off the bottom again.
 *
 * jsdom has no layout and no momentum, so the scroller's geometry is stubbed
 * and the glide is played as scroll events that move scrollTop.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
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

function stubScroller(el: HTMLElement) {
  const state = { top: 700 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
  return state;
}

function withFrames() {
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  return () => frames.splice(0).forEach((f) => f());
}

/** Flick up on the transcript and let go: the glide is still running after. */
function flickUp(el: HTMLElement, geom: { top: number }) {
  fireEvent.touchStart(el);
  geom.top = 400;
  fireEvent.scroll(el);
  fireEvent.touchEnd(window);
  geom.top = 300; // gliding on after the finger lifted
  fireEvent.scroll(el);
}

/** A tap on the Latest button, which sits outside the scroller. */
function tapLatest(toEnd: () => void) {
  fireEvent.touchStart(document.body);
  fireEvent.touchEnd(window);
  toEnd();
}

function mount() {
  const atEnd: boolean[] = [];
  let toEnd: (() => void) | undefined;
  const { container } = render(() => (
    <MessagesTimeline
      events={TRANSCRIPT}
      onAtEnd={(a) => atEnd.push(a)}
      registerToEnd={(fn) => {
        toEnd = fn;
      }}
    />
  ));
  const el = container.querySelector<HTMLElement>(".tl-timeline");
  if (!el || !toEnd) throw new Error("no timeline");
  return { el, atEnd, toEnd, geom: stubScroller(el) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Latest pressed while the transcript is still gliding", () => {
  it("keeps the pin when the glide's next scroll event arrives", () => {
    withFrames();
    const { el, atEnd, toEnd, geom } = mount();
    flickUp(el, geom);
    expect(atEnd.at(-1), "the flick let go of the live end").toBe(false);

    tapLatest(toEnd);
    expect(geom.top).toBe(700);

    geom.top = 640; // the glide carries on past the write, as iOS does
    fireEvent.scroll(el);
    expect(atEnd.at(-1), "still at the live end").toBe(true);
    expect(geom.top, "brought back to the bottom").toBe(700);
  });

  it("stops a finger's glide by taking the scroller's overflow for two frames", () => {
    const runFrames = withFrames();
    const { el, toEnd, geom } = mount();
    flickUp(el, geom);

    tapLatest(toEnd);
    expect(el.style.overflowY, "overflow taken while the jump lands").toBe("hidden");
    runFrames();
    expect(el.style.overflowY, "still held through the first frame").toBe("hidden");
    runFrames();
    expect(el.style.overflowY, "given back").toBe("");
    expect(geom.top).toBe(700);
  });

  it("leaves the overflow alone after a wheel, where there is no glide to stop", () => {
    withFrames();
    const { el, toEnd, geom } = mount();
    fireEvent.wheel(el, { deltaY: -120 });
    geom.top = 300;
    fireEvent.scroll(el);

    toEnd();
    expect(el.style.overflowY).toBe("");
    expect(geom.top).toBe(700);
  });

  it("still lets a new flick right after take the reader off the bottom", () => {
    withFrames();
    const { el, atEnd, toEnd, geom } = mount();
    flickUp(el, geom);
    tapLatest(toEnd);

    fireEvent.touchStart(el);
    geom.top = 500;
    fireEvent.scroll(el);
    expect(atEnd.at(-1)).toBe(false);
  });
});
