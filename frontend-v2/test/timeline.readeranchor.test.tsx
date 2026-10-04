/**
 * The row the reader is looking at stays put while history arrives above it.
 *
 * History comes in byte-sized windows that can cut a turn in two (sessionio
 * backfill.go), so a window can grow a row that is already on screen: the turn's
 * work group becomes a fold, its picture strip gains lines. Compensating by the
 * OLDEST row's move missed every such change, since the growth sits between
 * that row and the reader. Measured on a picture-heavy session at a phone width
 * (2026-10-04): what sat at the centre of the screen jumped 252px while the
 * oldest row stayed where it was.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const TURNS: Event[] = [
  ev({ id: 1, kind: "user", body: "first", turnId: "t1" }),
  ev({ id: 2, kind: "text", body: "answer one", turnId: "t1" }),
  ev({ id: 3, kind: "turn_end", turnId: "t1" }),
  ev({ id: 4, kind: "user", body: "second", turnId: "t2" }),
  ev({ id: 5, kind: "text", body: "answer two", turnId: "t2" }),
  ev({ id: 6, kind: "turn_end", turnId: "t2" }),
];

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

const place = (row: Element, top: () => number) =>
  Object.defineProperty(row, "offsetTop", { configurable: true, get: top });

afterEach(() => vi.unstubAllGlobals());

describe("keeping the reader's row still", () => {
  /** Mount with events in a signal, place every content row, and scroll the
   *  reader up so the first row at or below 300 is the one they look at. */
  function mount(onLoadEarlier?: () => Promise<void>) {
    const [events, setEvents] = createSignal<Event[]>(TURNS);
    const view = render(() => (
      <MessagesTimeline
        events={events()}
        hasEarlier={!!onLoadEarlier}
        {...(onLoadEarlier ? { onLoadEarlier } : {})}
      />
    ));
    const el = view.container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    // Positions follow the DOM, as a browser's do: the reader's row moves down
    // by `grow` only once the row that grows above it is actually rendered.
    const state = { oldest: 30, reader: 500, grow: 0, marker: "" };
    const grown = () => (state.marker && el.textContent?.includes(state.marker) ? state.grow : 0);
    const placeAll = () => {
      const rows = [...el.children].filter((c) =>
        c.matches(".tl-row:not(.tl-row-filling):not(.tl-row-earlier)"),
      );
      rows.forEach((r, i) => place(r, () => (i === 0 ? state.oldest : state.reader + i + grown())));
    };
    placeAll();
    fireEvent.wheel(el, { deltaY: -120 });
    geom.top = 300;
    fireEvent.scroll(el);
    return { el, geom, state, setEvents, placeAll };
  }

  it("follows the row on screen when an earlier window grows a row above it", async () => {
    let v!: ReturnType<typeof mount>;
    const onLoadEarlier = vi.fn(async () => {
      await Promise.resolve(); // the fetch: the reader's scroll returns first
      // The window lands: the turn the reader sits in gains its middle, which
      // pushes the reader's row down 300px while the oldest row stays put.
      v.state.grow = 300;
      v.state.marker = "more of answer two";
      v.setEvents([
        ...TURNS,
        ev({ id: 7, kind: "text", body: "more of answer two", turnId: "t2" }),
      ]);
    });
    v = mount(onLoadEarlier);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(v.geom.top).toBe(600);
  });

  it("follows the row on screen when history arrives with no load asked for", () => {
    const v = mount();
    // The opening stream's history keeps arriving after the reader scrolled up.
    v.state.grow = 84;
    v.state.marker = "more of answer two";
    v.setEvents([...TURNS, ev({ id: 7, kind: "text", body: "more of answer two", turnId: "t2" })]);
    expect(v.geom.top).toBe(384);
  });

  it("leaves a reader at the live end to the pin", () => {
    const v = mount();
    v.geom.top = 3600;
    fireEvent.scroll(v.el); // back at the bottom: pinned
    v.state.grow = 300;
    v.state.marker = "a new reply";
    v.setEvents([...TURNS, ev({ id: 7, kind: "text", body: "a new reply", turnId: "t3" })]);
    expect(v.geom.top).toBe(3600);
  });
});
