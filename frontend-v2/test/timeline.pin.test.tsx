/**
 * Expanding something must not hand the view back to the transcript.
 *
 * Reported by Viktor 2026-08-18: clicking to expand a command scrolled the view
 * away, disruptively and only some of the time. Measured in a browser on a live
 * session: sitting at the bottom, opening a command left the view 101px above
 * it — correctly — but the pin still read "at the bottom", because it is only
 * recomputed on a SCROLL event and expanding fires none. The next event to
 * arrive then scrolled to the bottom and took the row that had just been opened
 * 140px off with it. It only bites while Claude is working, which is why it
 * came and went.
 *
 * jsdom has no layout, so the scroller's geometry is stubbed. What is being
 * pinned here is the DECISION, which is where the defect lived.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const TURN: Event[] = [
  ev({ id: 1, kind: "user", body: "read the notes" }),
  ev({ id: 2, kind: "text", body: "on it" }),
  ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls -la"}' }),
  ev({ id: 4, kind: "tool_result", toolId: "t1", body: "a\nb\nc" }),
];

/**
 * Give the scroller a geometry jsdom will not, and let a test move it.
 * `scrollTop` is a real read/write here; the browser's is a no-op without
 * layout.
 */
function stubScroller(el: HTMLElement, content: number, view: number) {
  const state = { top: 0, content, view };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.view });
  return state;
}

/** Run the frame the pin recompute is queued on. */
function withFrames() {
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  return () => frames.splice(0).forEach((f) => f());
}

afterEach(() => vi.unstubAllGlobals());

describe("the scroll pin after an expansion", () => {
  it("follows the transcript while the reader is at the bottom", async () => {
    const runFrames = withFrames();
    const [events, setEvents] = createSignal<Event[]>(TURN);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 1000, 300);
    geom.top = 700; // at the bottom
    fireEvent.scroll(el);

    geom.content = 1400; // the transcript grew
    setEvents([...TURN, ev({ id: 5, kind: "text", body: "more" })]);
    await Promise.resolve();
    expect(geom.top, "still following").toBe(1100);
    runFrames();
  });

  it("lets go once an expansion has moved the reader off the bottom", async () => {
    const runFrames = withFrames();
    const [events, setEvents] = createSignal<Event[]>(TURN);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 1000, 300);
    geom.top = 700; // at the bottom
    fireEvent.scroll(el);

    // Expanding grows the content under the reader without moving scrollTop —
    // no scroll event fires, which is exactly how the pin went stale.
    geom.content = 1500;
    fireEvent.click(el);
    runFrames();

    // Now a transcript event arrives. It must NOT drag the view to the bottom.
    geom.content = 1600;
    setEvents([...TURN, ev({ id: 5, kind: "text", body: "more" })]);
    await Promise.resolve();
    expect(geom.top, "the reader stays where they were reading").toBe(700);
  });

  it("takes the pin back when the reader scrolls to the bottom again", async () => {
    const runFrames = withFrames();
    const [events, setEvents] = createSignal<Event[]>(TURN);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 1000, 300);
    geom.top = 700;
    fireEvent.scroll(el);
    geom.content = 1500;
    fireEvent.click(el);
    runFrames();

    geom.top = 1200; // the reader scrolls back down to the bottom
    fireEvent.scroll(el);
    geom.content = 1600;
    setEvents([...TURN, ev({ id: 5, kind: "text", body: "more" })]);
    await Promise.resolve();
    expect(geom.top, "following again").toBe(1300);
  });

  it("keeps the pin when a click changed nothing", async () => {
    // Clicking a row that does not expand must not cost the reader the follow.
    const runFrames = withFrames();
    const [events, setEvents] = createSignal<Event[]>(TURN);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 1000, 300);
    geom.top = 700;
    fireEvent.scroll(el);

    fireEvent.click(el); // nothing grew
    runFrames();

    geom.content = 1400;
    setEvents([...TURN, ev({ id: 5, kind: "text", body: "more" })]);
    await Promise.resolve();
    expect(geom.top, "still following").toBe(1100);
  });
});

/**
 * A reader who scrolled up stays where they are while the live end changes.
 *
 * The rows mount as a window over the newest end. It used to be a suffix BY
 * COUNT, so a row landing at the end slid the window forward: the oldest row
 * unmounted and the "loading earlier rows" line took its place, both above the
 * reader, and the fill that put the row back only compensated for its own half.
 * Measured live on 2026-09-28: every row that changed at the end moved a
 * scrolled-up reader down by 42 to 165px while nothing above them changed.
 */
describe("the mounted window while the reader reads back", () => {
  const turns = (n: number): Event[] =>
    Array.from({ length: n }, (_, i) => [
      ev({ id: i * 2 + 1, kind: "user", body: `question ${i}` }),
      ev({ id: i * 2 + 2, kind: "text", body: `answer ${i}` }),
    ]).flat();
  const firstRow = (el: HTMLElement) =>
    el.querySelector<HTMLElement>(".tl-row:not(.tl-row-filling):not(.tl-row-earlier)");

  it("keeps every mounted row when one lands at the end", async () => {
    const [events, setEvents] = createSignal<Event[]>(turns(6));
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 3000, 400);
    geom.top = 2600;
    fireEvent.scroll(el);
    const oldest = firstRow(el)!;
    expect(oldest.textContent).toContain("question 0");

    fireEvent.wheel(el, { deltaY: -120 }); // the reader scrolls up
    geom.top = 900;
    fireEvent.scroll(el);

    setEvents([...turns(6), ev({ id: 13, kind: "user", body: "one more" })]);
    await Promise.resolve();
    expect(firstRow(el), "the oldest row stayed mounted").toBe(oldest);
    expect(el.querySelector(".tl-row-filling"), "no line appeared above the reader").toBeNull();
    expect(geom.top, "the reader did not move").toBe(900);
  });
});
