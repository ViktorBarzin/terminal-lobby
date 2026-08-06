/**
 * Timeline rows must not flex-shrink.
 *
 * `.tl-timeline` is a scrolling flex column. A flex column that overflows
 * shrinks its children toward their min-content floor before it hands the
 * overflow to the scrollbar. Message rows survive that because wrapped text
 * gives them a floor; `.tl-row-tool` sets `overflow: hidden`, which removes its
 * floor entirely, so a COLLAPSED tool row shrank to its 2px border the moment a
 * transcript grew past the viewport — the expand toggle was still in the DOM but
 * `elementFromPoint` at its centre returned the timeline, so expand-to-raw was
 * unreachable on any real transcript and on every phone viewport.
 *
 * jsdom has no layout engine, so this cannot measure pixels. What it CAN do is
 * resolve the real cascade over the real `src/app.css` against the real rendered
 * DOM, which is where the defect actually lives: no rule set `flex-shrink` on any
 * timeline child, so every one of them inherited the flex-item default of 1.
 * Pixel geometry is verified in a browser (see the lane report).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

/** The shipped stylesheet, cascaded by jsdom exactly as the browser would. */
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(__dirname, "../src/app.css"), "utf8");
  document.head.appendChild(style);
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

/** A live turn, so the tool row is rendered unfolded — the collapsing element. */
const LIVE_TURN: Event[] = [
  ev({ id: 1, kind: "user", body: "read the notes" }),
  ev({ id: 2, kind: "text", body: "on it" }),
  ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: '{"file_path":"notes.txt"}' }),
  ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hello" }),
];

describe("timeline rows hold their height when the transcript overflows", () => {
  it("gives every direct child of .tl-timeline flex-shrink: 0", () => {
    const { container } = render(() => <MessagesTimeline events={LIVE_TURN} />);
    const timeline = container.querySelector(".tl-timeline");
    expect(timeline, ".tl-timeline should render").not.toBeNull();

    const children = [...timeline!.children];
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      expect(
        getComputedStyle(child).flexShrink,
        `${child.className || child.tagName} must not shrink inside the scrolling timeline`,
      ).toBe("0");
    }
  });

  it("keeps a collapsed tool row unshrinkable even though it clips its overflow", () => {
    const { container } = render(() => <MessagesTimeline events={LIVE_TURN} />);
    const tool = container.querySelector(".tl-row-tool");
    expect(tool, "a tool row should render").not.toBeNull();

    const css = getComputedStyle(tool!);
    // `overflow: hidden` is what removes this row's min-content floor. It is
    // wanted (it clips the card's rounded corners), so the floor has to come
    // from flex-shrink instead.
    expect(css.overflow).toBe("hidden");
    expect(css.flexShrink).toBe("0");
  });

  it("keeps the empty-state child unshrinkable too", () => {
    const { container } = render(() => <MessagesTimeline events={[]} />);
    const empty = container.querySelector(".tl-empty-state");
    expect(empty, "the empty state should render").not.toBeNull();
    expect(getComputedStyle(empty!).flexShrink).toBe("0");
  });
});

/**
 * An expanded tool result is bounded.
 *
 * Expanding the Read row of a 300-line file rendered `pre.tl-code` 5,666px tall
 * inside a 552px timeline — the container's scrollHeight went 930 → 6,880 and
 * the rest of the transcript went out of reach. `.tl-code` declares
 * `overflow-x: auto` and no max-height; the `overflow-y: auto` a browser
 * reports there is the USED value the spec forces from overflow-x, not an
 * author rule, so the clamp needs both.
 */
describe("expanded tool output is height-clamped", () => {
  it("clamps and scrolls the raw output pane", () => {
    const { container } = render(() => <MessagesTimeline events={LIVE_TURN} />);
    fireEvent.click(container.querySelector(".tl-tool-toggle")!);

    const pre = container.querySelector(".tl-tool-raw .tl-code");
    expect(pre, "expanding a tool row should render its raw output").not.toBeNull();

    const css = getComputedStyle(pre!);
    expect(css.maxHeight, "expanded tool output must be bounded").not.toBe("none");
    expect(css.maxHeight).not.toBe("");
    expect(css.overflowY, "…and scroll inside that bound").toBe("auto");
  });
});

/**
 * The timeline opens at the newest exchange.
 *
 * Measured at 1100x700 on a session with a taller-than-the-window transcript:
 * `.tl-timeline` = {scrollTop: 0, scrollHeight: 875, clientHeight: 552}, first
 * visible row = the session's OLDEST prompt. There was no scroll code to be
 * broken — the entry position was simply never set (a repo-wide grep for
 * scrollTo/scrollTop/scrollIntoView/scrollHeight matched one unrelated line in
 * Composer.tsx). Events arrive over SSE well after mount, so the pin has to
 * follow the stream, and let go the moment the operator scrolls up to read.
 *
 * jsdom has no layout, so the three numbers the pin reads are stubbed and the
 * scrollTop writes recorded; pixel geometry is verified in a browser.
 */
function stubScrollGeometry(clientHeight: number) {
  const proto = window.HTMLElement.prototype;
  const tops = new WeakMap<object, number>();
  let contentHeight = 0;
  const saved = (["scrollHeight", "clientHeight", "scrollTop"] as const).map(
    (p) => [p, Object.getOwnPropertyDescriptor(proto, p)] as const,
  );
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: object) {
      return tops.get(this) ?? 0;
    },
    set(this: object, v: number) {
      tops.set(this, v);
    },
  });
  return {
    grow(h: number) {
      contentHeight = h;
    },
    restore() {
      for (const [p, d] of saved) {
        if (d) Object.defineProperty(proto, p, d);
        else delete (proto as unknown as Record<string, unknown>)[p];
      }
    },
  };
}

describe("the timeline opens at the newest exchange", () => {
  const CLIENT_H = 552;
  const CONTENT_H = 875;
  const BOTTOM = CONTENT_H - CLIENT_H;

  const turn = (n: number): Event[] => [
    ev({ id: n * 10, kind: "user", body: `prompt ${n}` }),
    ev({ id: n * 10 + 1, kind: "text", body: `answer ${n}` }),
    ev({ id: n * 10 + 2, kind: "turn_end" }),
  ];
  const LONG: Event[] = [1, 2, 3, 4, 5].flatMap(turn);

  it("lands at the bottom on first render of an overflowing transcript", () => {
    const geom = stubScrollGeometry(CLIENT_H);
    try {
      geom.grow(CONTENT_H);
      const { container } = render(() => <MessagesTimeline events={LONG} />);
      const tl = container.querySelector(".tl-timeline") as HTMLElement;
      expect(tl.scrollTop).toBe(BOTTOM);
    } finally {
      geom.restore();
    }
  });

  it("follows the stream: events that arrive after mount keep it pinned", () => {
    const geom = stubScrollGeometry(CLIENT_H);
    try {
      const [events, setEvents] = createSignal<Event[]>([]);
      const { container } = render(() => <MessagesTimeline events={events()} />);
      const tl = container.querySelector(".tl-timeline") as HTMLElement;

      geom.grow(CONTENT_H);
      setEvents(LONG);
      expect(tl.scrollTop).toBe(BOTTOM);
    } finally {
      geom.restore();
    }
  });

  // Expanding a turn fold grows the content, but you clicked it to READ the
  // hidden work — being thrown to the newest end instead would defeat it.
  it("does not move the viewport when a turn fold is expanded", () => {
    const geom = stubScrollGeometry(CLIENT_H);
    try {
      const FOLDED: Event[] = [
        ev({ id: 1, kind: "user", body: "do it" }),
        ev({ id: 2, kind: "text", body: "thinking" }),
        ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
        ev({ id: 4, kind: "text", body: "all done" }),
        ev({ id: 5, kind: "turn_end" }),
      ];
      geom.grow(CONTENT_H);
      const { container } = render(() => <MessagesTimeline events={FOLDED} />);
      const tl = container.querySelector(".tl-timeline") as HTMLElement;
      expect(tl.scrollTop).toBe(BOTTOM);

      tl.scrollTop = 100;
      geom.grow(1400);
      fireEvent.click(container.querySelector(".tl-fold-btn")!);
      expect(container.querySelector(".tl-row-tool")).not.toBeNull();
      expect(tl.scrollTop).toBe(100);
    } finally {
      geom.restore();
    }
  });

  it("lets go once the operator scrolls up to read", () => {
    const geom = stubScrollGeometry(CLIENT_H);
    try {
      const [events, setEvents] = createSignal<Event[]>(LONG);
      geom.grow(CONTENT_H);
      const { container } = render(() => <MessagesTimeline events={events()} />);
      const tl = container.querySelector(".tl-timeline") as HTMLElement;
      expect(tl.scrollTop).toBe(BOTTOM);

      tl.scrollTop = 0;
      fireEvent.scroll(tl);

      geom.grow(1200);
      setEvents([...LONG, ...turn(6)]);
      expect(tl.scrollTop, "a reader scrolled up must not be yanked down").toBe(0);
    } finally {
      geom.restore();
    }
  });
});
