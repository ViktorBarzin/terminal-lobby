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
import { render } from "@solidjs/testing-library";
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
