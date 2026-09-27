/**
 * Only the reader lets go of the live end.
 *
 * A scroll event is dispatched on the frame after the scroll that caused it,
 * and what the timeline reads at that moment is the geometry of THAT frame.
 * While a session opens, rows mount, pictures arrive and markdown settles, so
 * the pin's own write to scrollTop is routinely followed by content that grew
 * before its scroll event came in. Read as the reader's scroll, that event
 * unpinned the view, and nothing re-pins an unpinned view.
 *
 * Measured on 2026-09-27 on the installed 0.77.1: on phone Chrome with the
 * cache cleared, 4 to 7 of 8 opens of a session with pictures stopped 1,161 to
 * 4,303px above the latest message with "Latest" showing, and desktop Chromium
 * did it in 1 of 20 to 2 of 50 reloads. An event log on a failing run showed
 * the scroll event arriving at scrollTop 4620 of 5523 after the pin had set it
 * to the bottom of a shorter transcript.
 *
 * So a scroll event lets go of the pin only when the reader is scrolling: a
 * wheel, a touch, a scroll key or a press on the scroller. Any other scroll
 * that leaves a pinned view short of the bottom is followed back down.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "first prompt" }),
  ev({ id: 2, kind: "text", body: "first answer" }),
  ev({ id: 3, kind: "turn_end" }),
  ev({ id: 4, kind: "user", body: "second prompt" }),
  ev({ id: 5, kind: "text", body: "second answer" }),
];

/** The scroll geometry a browser would report, which the test then moves. */
function geometry(el: HTMLElement, g: { content: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.client });
  return g;
}

function mount() {
  const log: boolean[] = [];
  const { container } = render(() => (
    <MessagesTimeline events={TRANSCRIPT} me="wizard" session="s" onPinned={(p) => log.push(p)} />
  ));
  const tl = container.querySelector<HTMLElement>(".tl-timeline");
  if (!tl) throw new Error("no timeline");
  const g = geometry(tl, { content: 1000, client: 300 });
  tl.scrollTop = 700; // at the bottom: 1000 - 700 - 300 = 0
  fireEvent.scroll(tl);
  const latest = () => tl.querySelector(".tl-scroll-end");
  return { tl, g, log, latest };
}

describe("<MessagesTimeline> keeps the live end through scrolls the reader did not make", () => {
  it("follows the bottom when the content grew before the pin's scroll event came in", () => {
    const { tl, g, log, latest } = mount();
    g.content = 1900; // rows and pictures landed between the write and its event
    fireEvent.scroll(tl); // still at 700, now 900px short of the bottom

    expect(tl.scrollTop).toBe(1600);
    expect(latest(), "nobody scrolled away, so nothing offers the way back").toBe(null);
    expect(log, "the store is not told the reader left").toEqual([]);
  });

  it("follows the bottom when the browser clamps the position while the box changes", () => {
    const { tl, g, latest } = mount();
    // The composer grew by a line: the box is 24px shorter, and the browser's
    // clamp left scrollTop where the shorter maximum had been a moment before.
    g.client = 276;
    tl.scrollTop = 676;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(724);
    expect(latest()).toBe(null);
  });

  it("lets go when the reader scrolls up with a wheel", () => {
    const { tl, log, latest } = mount();
    fireEvent.wheel(tl, { deltaY: -120 });
    tl.scrollTop = 200;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(200);
    expect(latest()).not.toBe(null);
    expect(log).toEqual([false]);
  });

  it("lets go when the reader drags the transcript with a finger", () => {
    const { tl, latest } = mount();
    fireEvent.touchStart(tl);
    tl.scrollTop = 200;
    fireEvent.scroll(tl);
    fireEvent.touchEnd(tl);

    expect(tl.scrollTop).toBe(200);
    expect(latest()).not.toBe(null);
  });

  it("lets go when the reader drags the scrollbar", () => {
    const { tl, latest } = mount();
    fireEvent.pointerDown(tl);
    tl.scrollTop = 200;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(200);
    expect(latest()).not.toBe(null);
  });

  it("lets go when the reader pages up from the keyboard", () => {
    const { tl, latest } = mount();
    fireEvent.keyDown(tl, { key: "PageUp" });
    tl.scrollTop = 200;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(200);
    expect(latest()).not.toBe(null);
  });

  it("does not count typing in a field as the reader scrolling", () => {
    const { tl, g, latest } = mount();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    g.content = 1300;
    fireEvent.scroll(tl);
    field.remove();

    expect(tl.scrollTop).toBe(1000);
    expect(latest()).toBe(null);
  });

  it("stops counting a gesture once it is over", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const { tl, g, latest } = mount();
    fireEvent.wheel(tl, { deltaY: 120 });
    fireEvent.touchStart(tl);
    fireEvent.touchEnd(tl);
    now.mockReturnValue(15_000); // five seconds later, a picture lands
    g.content = 1400;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(1100);
    expect(latest()).toBe(null);
  });

  it("leaves a reader who already let go where they are", () => {
    const { tl, g, latest } = mount();
    fireEvent.wheel(tl, { deltaY: -120 });
    tl.scrollTop = 200;
    fireEvent.scroll(tl);

    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_000);
    g.content = 1400;
    fireEvent.scroll(tl);

    expect(tl.scrollTop).toBe(200);
    expect(latest()).not.toBe(null);
  });
});
