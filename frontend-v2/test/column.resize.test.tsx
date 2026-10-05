/**
 * THE TEXT VIEW'S COLUMN IS AS WIDE AS YOU DRAG IT.
 *
 * The transcript, the composer and the docked cards shared a fixed 760px
 * column, and on a wide monitor most of the view sat empty (Emil, 2026-10-05).
 * Either edge of the composer now drags the column; Settings > Appearance
 * offers presets. This file pins the drag, the keys, the reset, and that the
 * stylesheet spends the width in every place the column is drawn.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup } from "@solidjs/testing-library";
import { ColumnGrip } from "../src/components/ColumnGrip";
import { AppearancePage } from "../src/components/settings/pages/AppearancePage";
import {
  resetTextColumn,
  setTextColumn,
  textColumn,
  textColumnDragging,
} from "../src/store/text-column";
import {
  TEXT_COL_DEFAULT,
  TEXT_COL_KEY,
  TEXT_COL_MIN,
  TEXT_COL_STEP,
} from "../src/store/text-column.logic";

beforeEach(() => {
  resetTextColumn();
  localStorage.clear();
});
afterEach(cleanup);

/** The composer's content box: 1600px of room, the pill centred at x = 800. */
const ROOM = 1600;
const CENTRE = 800;

function mount() {
  const { container } = render(() => (
    <div class="tl-composer">
      <div class="tl-pillwrap">
        <ColumnGrip side="left" />
        <ColumnGrip side="right" />
      </div>
    </div>
  ));
  const composer = container.querySelector<HTMLElement>(".tl-composer")!;
  const wrap = container.querySelector<HTMLElement>(".tl-pillwrap")!;
  // jsdom lays nothing out, so the two measurements a drag takes are stubbed.
  Object.defineProperty(composer, "clientWidth", { value: ROOM, configurable: true });
  wrap.getBoundingClientRect = () =>
    ({
      left: CENTRE - 380,
      right: CENTRE + 380,
      width: 760,
      top: 0,
      bottom: 60,
      height: 60,
    }) as DOMRect;
  const [left, right] = [...container.querySelectorAll<HTMLElement>(".tl-col-grip")];
  return { left: left!, right: right! };
}

const point = (el: EventTarget, type: string, clientX: number): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX }));

const key = (el: Element, k: string): boolean =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("dragging an edge of the composer", () => {
  it("widens the column by twice the distance, since it stays centred", () => {
    const { right } = mount();
    point(right, "pointerdown", CENTRE + 380);
    point(window, "pointermove", CENTRE + 500);
    expect(textColumn()).toBe(1000);
    point(window, "pointerup", CENTRE + 500);
    expect(localStorage.getItem(TEXT_COL_KEY)).toBe("1000");
  });

  it("works the same from the left edge", () => {
    const { left } = mount();
    point(left, "pointerdown", CENTRE - 380);
    point(window, "pointermove", CENTRE - 450);
    expect(textColumn()).toBe(900);
  });

  it("goes full when dragged to the room's edge", () => {
    const { right } = mount();
    point(right, "pointerdown", CENTRE + 380);
    point(window, "pointermove", CENTRE + ROOM / 2);
    expect(textColumn()).toBe("full");
  });

  it("marks the drag while it lasts, and stops listening after pointercancel", () => {
    const { right } = mount();
    point(right, "pointerdown", CENTRE + 380);
    expect(textColumnDragging()).toBe(true);
    point(window, "pointercancel", CENTRE + 380);
    expect(textColumnDragging()).toBe(false);
    point(window, "pointermove", CENTRE + 600);
    expect(textColumn()).toBe(TEXT_COL_DEFAULT);
  });

  it("goes back to 760px on a double-click, leaving no key behind", () => {
    const { right } = mount();
    setTextColumn(1280);
    right.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(textColumn()).toBe(TEXT_COL_DEFAULT);
    expect(localStorage.getItem(TEXT_COL_KEY)).toBeNull();
  });
});

describe("the keyboard", () => {
  it("moves each edge outward with the arrow pointing away from the centre", () => {
    const { left, right } = mount();
    key(right, "ArrowRight");
    expect(textColumn()).toBe(TEXT_COL_DEFAULT + TEXT_COL_STEP);
    key(left, "ArrowLeft");
    expect(textColumn()).toBe(TEXT_COL_DEFAULT + 2 * TEXT_COL_STEP);
    key(left, "ArrowRight");
    expect(textColumn()).toBe(TEXT_COL_DEFAULT + TEXT_COL_STEP);
  });

  it("goes full on End and to the narrowest on Home, as the sidebar's seam does", () => {
    const { right } = mount();
    key(right, "End");
    expect(textColumn()).toBe("full");
    key(right, "Home");
    expect(textColumn()).toBe(TEXT_COL_MIN);
  });
});

describe("Settings > Appearance", () => {
  const strip = (c: HTMLElement) =>
    c.querySelector<HTMLElement>('[role="group"][aria-label="Text view width"]')!;
  const button = (c: HTMLElement, label: string) =>
    [...strip(c).querySelectorAll("button")].find((b) => b.textContent === label)!;

  it("offers the presets with Normal lit, and a press sets the width", () => {
    const { container } = render(() => <AppearancePage />);
    expect([...strip(container).querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Normal",
      "Wide",
      "Wider",
      "Full",
    ]);
    expect(button(container, "Normal").getAttribute("aria-pressed")).toBe("true");
    button(container, "Wide").click();
    expect(textColumn()).toBe(1000);
    expect(button(container, "Wide").getAttribute("aria-pressed")).toBe("true");
  });

  it("lights nothing and says the width when a drag landed between presets", () => {
    setTextColumn(913);
    const { container } = render(() => <AppearancePage />);
    expect(strip(container).querySelector('[aria-pressed="true"]')).toBeNull();
    expect(container.textContent).toContain("Now 913px, set by dragging.");
  });
});

describe("the stylesheet", () => {
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const appCss = strip(readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"));

  it("draws every column at the variable, never at a literal 760px", () => {
    expect(appCss).not.toMatch(/max-width:\s*760px/);
    expect(appCss.replaceAll("var(--tl-col-w, 760px)", "")).not.toMatch(/\b760px/);
  });

  it("keeps the grips off a touch screen, where the column is the screen", () => {
    expect(appCss).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.tl-col-grip\s*\{\s*display:\s*none;/,
    );
  });
});
