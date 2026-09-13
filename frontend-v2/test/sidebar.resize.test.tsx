/**
 * THE SESSION LIST IS AS WIDE AS YOU DRAG IT.
 *
 * A title is up to 64 characters and the column was a fixed 260px, so the
 * sidebar ellipsized titles at a width nobody chose. This file pins the three
 * halves of the fix that can actually break:
 *
 *  1. The drag. It follows the pointer, it stops at the ends, and it STOPS
 *     LISTENING when the drag ends — including the `pointercancel` ending that
 *     Dock.tsx leaked window listeners on for months.
 *  2. The keyboard. A 7px handle that only a pointer can move is not a control.
 *  3. The stylesheet, where the width is actually spent. jsdom runs no layout,
 *     so the CSS text IS the observable behaviour here (the same reasoning as
 *     card.longpress.css.test.ts and dock.panel.test.tsx) — and the thing worth
 *     asserting is that a width dragged on a wide window cannot leak into the
 *     two stacked layouts, where the list is a full-width row.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup } from "@solidjs/testing-library";
import { SidebarGrip } from "../src/components/SidebarGrip";
import { createSidebarWidthStore, type SidebarWidthStore } from "../src/store/sidebar-width";
import {
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
  SIDEBAR_W_STEP,
} from "../src/store/sidebar-width.logic";

afterEach(cleanup);

// ---- a grip with a shell around it ---------------------------------------

/** The shell's left edge, which every drag is measured from. */
const SHELL_LEFT = 24;

function mount(opts: { viewport?: number; stored?: number } = {}) {
  const written: number[] = [];
  let store!: SidebarWidthStore;
  const { container } = render(() => {
    store = createSidebarWidthStore({
      read: () => opts.stored ?? SIDEBAR_W_DEFAULT,
      write: (px) => written.push(px),
      viewport: () => opts.viewport ?? 1920,
    });
    return (
      <div class="tl-shell">
        <SidebarGrip sidebar={store} />
      </div>
    );
  });
  const shell = container.querySelector<HTMLElement>(".tl-shell")!;
  // jsdom lays nothing out, so the one measurement the drag takes is stubbed.
  shell.getBoundingClientRect = () =>
    ({ left: SHELL_LEFT, top: 0, right: 1920, bottom: 900, width: 1920, height: 900 }) as DOMRect;
  const grip = container.querySelector<HTMLElement>(".tl-sidebar-grip")!;
  return { grip, store, written };
}

const point = (el: EventTarget, type: string, clientX: number): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX }));

const key = (el: Element, k: string): boolean =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

// ---- the drag -------------------------------------------------------------

describe("dragging the seam", () => {
  it("takes the width from the pointer, measured off the shell's left edge", () => {
    const { grip, store } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 420);
    expect(store.width()).toBe(420);
    point(window, "pointerup", SHELL_LEFT + 420);
    expect(store.width()).toBe(420);
  });

  it("marks the shell for the length of the drag and no longer", () => {
    const { grip, store } = mount();
    expect(store.dragging()).toBe(false);
    point(grip, "pointerdown", SHELL_LEFT + 260);
    expect(store.dragging()).toBe(true);
    point(window, "pointerup", SHELL_LEFT + 300);
    expect(store.dragging()).toBe(false);
  });

  it("stops listening when the drag ends — a later move changes nothing", () => {
    const { grip, store } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 400);
    point(window, "pointerup", SHELL_LEFT + 400);
    point(window, "pointermove", SHELL_LEFT + 520);
    expect(store.width()).toBe(400);
  });

  it("ends on pointercancel too — the ending a cancelled touch gives you", () => {
    const { grip, store } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 400);
    point(window, "pointercancel", SHELL_LEFT + 400);
    expect(store.dragging()).toBe(false);
    point(window, "pointermove", SHELL_LEFT + 520);
    expect(store.width()).toBe(400);
  });

  it("leaves nothing behind when the grip is unmounted mid-drag", () => {
    const { grip, store } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 400);
    cleanup();
    point(window, "pointermove", SHELL_LEFT + 520);
    expect(store.width()).toBe(400);
  });

  it("holds the ends, and keeps the session pane its minimum", () => {
    const { grip, store } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 40);
    expect(store.width()).toBe(SIDEBAR_W_MIN);
    point(window, "pointermove", SHELL_LEFT + 4000);
    expect(store.width()).toBe(SIDEBAR_W_MAX);
    point(window, "pointerup", SHELL_LEFT + 4000);

    // The same drag on a 900px window: 540 left for the list, not 560.
    const narrow = mount({ viewport: 900 });
    point(narrow.grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 4000);
    expect(narrow.store.width()).toBe(540);
  });

  it("persists each width it settles on", () => {
    const { grip, written } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 300);
    point(window, "pointermove", SHELL_LEFT + 340);
    point(window, "pointerup", SHELL_LEFT + 340);
    expect(written).toEqual([300, 340]);
  });

  it("writes nothing while the pointer moves within the same pixel", () => {
    const { grip, written } = mount();
    point(grip, "pointerdown", SHELL_LEFT + 260);
    point(window, "pointermove", SHELL_LEFT + 300);
    point(window, "pointermove", SHELL_LEFT + 300.2);
    expect(written).toEqual([300]);
  });
});

// ---- the keyboard ---------------------------------------------------------

describe("the grip answers the window-splitter keys", () => {
  it("nudges with the arrows and takes the stops with Home and End", () => {
    const { grip, store } = mount();
    key(grip, "ArrowRight");
    expect(store.width()).toBe(SIDEBAR_W_DEFAULT + SIDEBAR_W_STEP);
    key(grip, "ArrowLeft");
    expect(store.width()).toBe(SIDEBAR_W_DEFAULT);
    key(grip, "End");
    expect(store.width()).toBe(SIDEBAR_W_MAX);
    key(grip, "Home");
    expect(store.width()).toBe(SIDEBAR_W_MIN);
  });

  it("leaves every other key to whoever wants it", () => {
    const { grip, store } = mount();
    const taken = !key(grip, "a");
    expect(taken).toBe(false);
    expect(store.width()).toBe(SIDEBAR_W_DEFAULT);
  });

  it("says how wide it is, for a screen reader and for the next press", () => {
    const { grip } = mount({ stored: 420 });
    expect(grip.getAttribute("role")).toBe("separator");
    expect(grip.getAttribute("aria-orientation")).toBe("vertical");
    expect(grip.getAttribute("aria-valuenow")).toBe("420");
    expect(grip.getAttribute("tabindex")).toBe("0");
  });

  it("resets to the width the column has always had on a double-click", () => {
    const { grip, store } = mount({ stored: 480 });
    expect(store.width()).toBe(480);
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(store.width()).toBe(SIDEBAR_W_DEFAULT);
  });
});

// ---- the store's own reading ----------------------------------------------

describe("a stored width against the window it is shown in", () => {
  it("gives width back to the session pane on a narrow window, and returns it", () => {
    const viewport = vi.fn(() => 800);
    const store = createSidebarWidthStore({
      read: () => 520,
      write: () => {},
      viewport,
    });
    // 800 - 360 = 440 for the list, though 520 is what is stored.
    expect(store.width()).toBe(440);
    viewport.mockReturnValue(1920);
    expect(store.width()).toBe(520);
  });
});

// ---- the stylesheet -------------------------------------------------------

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The body of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

/**
 * The bodies of every `@media` block whose QUERY contains `needle`.
 *
 * Every, not the first: this file carries two `(pointer: coarse)` blocks and a
 * third that ands it with the phone sizes, so a test that took the first would
 * be asserting about whichever one happens to be nearest the top.
 *
 * The query and not the body, because the same strings appear in the prose
 * above these blocks and a comment is not a rule.
 */
function mediaBlocks(needle: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@media[^{]*\{/g)) {
    if (!m[0].includes(needle)) continue;
    const open = m.index! + m[0].length - 1;
    let depth = 1;
    for (let i = open + 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        out.push(css.slice(open + 1, i));
        break;
      }
    }
  }
  if (out.length === 0) throw new Error(`no @media block for ${needle}`);
  return out;
}

describe("where the width is spent", () => {
  it("drives the grid track, the sidebar and the grip from one property", () => {
    expect(ruleBody(".tl-shell")).toContain(
      "grid-template-columns: var(--tl-sidebar-w, 260px) 1fr",
    );
    expect(ruleBody(".tl-sidebar")).toContain("width: var(--tl-sidebar-w, 260px)");
    expect(ruleBody(".tl-sidebar-grip")).toContain("left: var(--tl-sidebar-w, 260px)");
  });

  it("positions the shell, or an absolute grip lands against the page", () => {
    expect(ruleBody(".tl-shell")).toContain("position: relative");
  });

  it("drops the collapse animation while a drag is live", () => {
    expect(ruleBody(".tl-shell-resizing")).toContain("transition: none");
  });

  it("hides the grip wherever there is no vertical seam to drag", () => {
    const hidden = /\.tl-sidebar-grip\s*\{\s*display:\s*none/;
    // Collapsed: there is no list to resize.
    expect(ruleBody(".tl-shell-collapsed .tl-sidebar-grip")).toContain("display: none");
    // A narrow desktop window: the two panes are stacked.
    expect(mediaBlocks("max-width: 720px").some((b) => hidden.test(b))).toBe(true);
    // Any touch device, tablets included: 7px is a mouse target.
    expect(mediaBlocks("pointer: coarse").some((b) => hidden.test(b))).toBe(true);
  });

  it("keeps a dragged width out of the stacked narrow layout", () => {
    // The list is a full-width ROW there; 260px is the width its cards keep.
    const pinned = /\.tl-sidebar\s*\{\s*width:\s*260px/;
    expect(mediaBlocks("max-width: 720px").some((b) => pinned.test(b))).toBe(true);
  });
});
