/**
 * A reader at the live end stays there when the timeline's own box changes
 * size under them.
 *
 * Nothing about the transcript has to change for its bottom to leave the
 * screen. The agent panel takes 260px of the column's width when it appears
 * beside it, and the same rows wrap taller in what is left; its strip's list
 * takes height from above the transcript on a phone. scrollTop holds through
 * both and no scroll event fires, so the pin stayed set with the view short of
 * the bottom and no "Latest" button to say so. Measured live on 2026-09-24 at
 * 1440x900: the panel arriving narrowed the rows from 860 to 760px and left the
 * view 420px above the bottom until the next row came in.
 *
 * Only the timeline's own box is watched. A fold the reader opens grows the
 * content and not the box, and it must not move the viewport: they clicked to
 * read what was hidden (MessagesTimeline's pin effect says the same).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "first prompt" }),
  ev({ id: 2, kind: "text", body: "first answer" }),
  ev({ id: 3, kind: "turn_end" }),
  ev({ id: 4, kind: "user", body: "second prompt" }),
  ev({ id: 5, kind: "text", body: "second answer" }),
];

/** Observers created during a render, so a test can report a size change. */
interface Watch {
  target: Element;
  fire: () => void;
  disconnected: () => boolean;
}
let watches: Watch[] = [];

function installResizeObserver(): void {
  class FakeRO {
    private cb: () => void;
    private off = false;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      watches.push({ target, fire: () => this.cb(), disconnected: () => this.off });
    }
    unobserve() {}
    disconnect() {
      this.off = true;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeRO);
}

/**
 * The scroll geometry a browser would report, which the test then moves: the
 * content's height and the box's own. jsdom lays nothing out, so without this
 * every measurement is 0 and the view reads as pinned whatever happens.
 */
function geometry(el: HTMLElement, g: { content: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.client });
  return g;
}

function mount(hidden?: () => boolean) {
  installResizeObserver();
  const { container, unmount } = render(() => (
    <MessagesTimeline events={TRANSCRIPT} hidden={hidden?.()} />
  ));
  const tl = container.querySelector<HTMLElement>(".tl-timeline");
  if (!tl) throw new Error("no timeline");
  /** Report a size change of the timeline's own box, as the browser would. */
  const resized = () => {
    for (const w of watches) if (w.target === tl && !w.disconnected()) w.fire();
  };
  const latest = () => tl.querySelector(".tl-scroll-end");
  return { tl, resized, latest, unmount };
}

afterEach(() => {
  watches = [];
  vi.unstubAllGlobals();
});

describe("<MessagesTimeline> when its own box changes size", () => {
  it("keeps a reader at the live end there when the column narrows and its rows wrap taller", () => {
    const { tl, resized, latest } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700; // at the bottom: 1000 - 700 - 300 = 0
    fireEvent.scroll(tl);

    // The panel takes its margin: the same rows, narrower, 420px taller.
    g.content = 1420;
    resized();

    expect(tl.scrollTop).toBe(1120);
    expect(latest(), "the reader is at the live end, so nothing offers to take them there").toBe(
      null,
    );
  });

  it("keeps the live end in view when the box loses height from above", () => {
    const { tl, resized } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700;
    fireEvent.scroll(tl);

    // The strip's list opens above the transcript and takes 256px of it.
    g.client = 44;
    resized();

    expect(tl.scrollTop).toBe(956);
  });

  it("leaves a reader who scrolled up where they were", () => {
    const { tl, resized, latest } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 100;
    fireEvent.scroll(tl);
    expect(latest()).not.toBe(null);

    g.content = 1420;
    resized();

    expect(tl.scrollTop).toBe(100);
    expect(latest()).not.toBe(null);
  });

  it("writes nothing while it is hidden behind the drill-in", () => {
    const [hidden, setHidden] = createSignal(false);
    const { tl, resized } = mount(hidden);
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700;
    fireEvent.scroll(tl);

    setHidden(true);
    g.content = 1420;
    resized();

    // Showing it again is the pin effect's to handle, from the geometry it has
    // then; a write now would land on a box that has none.
    expect(tl.scrollTop).toBe(700);
  });

  it("watches its own box and nothing inside it, so an opened fold stays where it was clicked", () => {
    const { tl } = mount();
    const inside = watches.filter((w) => tl.contains(w.target)).map((w) => w.target);
    expect(inside).toEqual([tl]);
  });

  it("stops watching when it goes", () => {
    const { tl, unmount } = mount();
    const mine = watches.filter((w) => w.target === tl);
    expect(mine).toHaveLength(1);
    unmount();
    expect(mine.every((w) => w.disconnected())).toBe(true);
  });
});
