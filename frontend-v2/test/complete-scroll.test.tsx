/**
 * Arrowing through the `/` menu has to bring the selection with it.
 *
 * The menu is a 220px scroller and the catalogue is 148 commands, so about four
 * are visible at a time. Moving the selection without moving the scroller left
 * it picking rows nobody could see after the fourth press — reported by Viktor
 * on 2026-08-18.
 *
 * The arithmetic is separated from the DOM because jsdom does no layout: every
 * height and rect it reports is zero, so a test that drove the real element
 * could not tell a correct scroll from no scroll at all.
 */
import { describe, it, expect } from "vitest";
import { scrollTopFor } from "../src/components/compose.logic";

// A menu showing four 40px rows.
const VIEW = 160;
const ROW = 40;
const at = (i: number) => i * ROW;

describe("keeping the picked row in view", () => {
  it("leaves the scroller alone when the row is already visible", () => {
    // Rows 0..3 are on screen with the scroller at the top.
    for (const i of [0, 1, 2, 3]) {
      expect(scrollTopFor(at(i), ROW, 0, VIEW)).toBe(0);
    }
  });

  it("scrolls down by just enough when the row is below the fold", () => {
    // Row 4 sits at 160..200; the view ends at 160, so it goes to 40..200.
    expect(scrollTopFor(at(4), ROW, 0, VIEW)).toBe(40);
    expect(scrollTopFor(at(5), ROW, 0, VIEW)).toBe(80);
  });

  it("scrolls up by just enough when the row is above the fold", () => {
    // Scrolled to row 4; arrowing back to row 2 shows it flush at the top.
    expect(scrollTopFor(at(2), ROW, 160, VIEW)).toBe(80);
    expect(scrollTopFor(at(0), ROW, 160, VIEW)).toBe(0);
  });

  it("moves the least it can — the row is brought to the NEAR edge", () => {
    // Not centred: a one-row step must not jump the list half a screen.
    expect(scrollTopFor(at(4), ROW, 0, VIEW)).toBe(40); // one row down
    expect(scrollTopFor(at(3), ROW, 160, VIEW)).toBe(120); // one row up
  });

  it("wraps to the end of the list, and back to the start", () => {
    // ArrowUp from the first row lands on the last: the whole list has to move.
    const last = 147;
    expect(scrollTopFor(at(last), ROW, 0, VIEW)).toBe(at(last) + ROW - VIEW);
    expect(scrollTopFor(at(0), ROW, at(last), VIEW)).toBe(0);
  });

  it("never asks for a negative offset", () => {
    // A row taller than the view (a long description that wrapped) would
    // otherwise compute a scrollTop past it and bounce.
    expect(scrollTopFor(0, 400, 0, VIEW)).toBe(0);
    expect(scrollTopFor(at(2), 400, 0, VIEW)).toBe(at(2));
  });

  it("copes with a view that has not been measured yet", () => {
    // First paint, or a menu that is still display:none: everything reads 0.
    expect(scrollTopFor(0, 0, 0, 0)).toBe(0);
  });
});

/**
 * The wiring, as far as jsdom can show it.
 *
 * jsdom has no layout: every rect is zero, and `scrollTop` on a box it never
 * laid out is a no-op setter. So the geometry is stubbed — the point of this
 * test is not the arithmetic (that is above) but that the effect is connected
 * to the arrow keys at all, and writes to the menu the selection lives in.
 */
import { render, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  name: `/cmd-${String(i).padStart(2, "0")}`,
  description: `command number ${i}`,
  source: "skill",
}));

/**
 * Give the menu and its rows a layout jsdom will not.
 *
 * `restub` because re-filtering replaces every row: the elements a test stubbed
 * are gone, and the fresh ones report jsdom's zeros. A real browser lays the
 * new ones out for itself.
 */
function stubLayout(
  menu: HTMLElement,
  rowHeight: number,
  viewHeight: number,
): { scrollTop: () => number; restub: () => void } {
  let top = 0;
  Object.defineProperty(menu, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  Object.defineProperty(menu, "clientHeight", { configurable: true, get: () => viewHeight });
  // The scroller's own box does not move when it scrolls — only its children
  // do. Modelling it otherwise made the two cancel out and hid the scroll.
  menu.getBoundingClientRect = () => ({ top: 0, bottom: viewHeight, height: viewHeight }) as DOMRect;
  const restub = (): void => {
    Array.from(menu.children).forEach((child, i) => {
      const el = child as HTMLElement;
      Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => rowHeight });
      el.getBoundingClientRect = () => ({ top: i * rowHeight - top, height: rowHeight }) as DOMRect;
    });
  };
  restub();
  return { scrollTop: () => top, restub };
}

describe("the menu scrolls with the arrow keys", () => {
  const open = () => {
    const r = render(() => (
      <Composer
        working={false}
        pending={[]}
        commands={ROWS}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    const ta = r.container.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;
    fireEvent.input(ta, { target: { value: "/cmd-" } });
    const menu = r.container.querySelector<HTMLElement>(".tl-complete")!;
    expect(menu, "the menu is open").toBeTruthy();
    expect(menu.children.length).toBe(ROWS.length);
    return { ...r, ta, menu };
  };

  it("brings a row below the fold into view", () => {
    const { ta, menu } = open();
    const { scrollTop } = stubLayout(menu, 40, 160); // four rows visible
    for (let i = 0; i < 4; i++) fireEvent.keyDown(ta, { key: "ArrowDown" });
    // Row 4 is the fifth: the list has moved down exactly one row.
    expect(scrollTop()).toBe(40);
  });

  it("stays put while the selection is still visible", () => {
    const { ta, menu } = open();
    const { scrollTop } = stubLayout(menu, 40, 160);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(scrollTop()).toBe(0);
  });

  it("follows the wrap from the first row to the last", () => {
    const { ta, menu } = open();
    const { scrollTop } = stubLayout(menu, 40, 160);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(scrollTop()).toBe(ROWS.length * 40 - 160);
  });

  it("comes back to the top when typing re-filters the list", () => {
    const { ta, menu } = open();
    const { scrollTop, restub } = stubLayout(menu, 40, 160);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(scrollTop()).toBeGreaterThan(0);
    // Typing resets the selection to the first row; the scroller follows.
    fireEvent.input(ta, { target: { value: "/cmd-1" } });
    restub();
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(scrollTop()).toBe(0);
  });
});
