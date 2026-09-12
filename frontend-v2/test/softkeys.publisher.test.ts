/**
 * Two soft-key rows overlapping for one tick, and which of them owns `--sk-h`.
 *
 * A coarse pointer wider than 720px — a landscape tablet at 1024x768 — is
 * inside `coarse()` and outside `flip()`, so it gets the split view AND the
 * soft-key row. `SessionView` mounts the row for the FOCUSED tile only, so
 * moving focus from tile A to tile B unmounts A's row and mounts B's in the
 * same update, and which of those two runs first is the order of `App.tsx`'s
 * append-only `<For each={mounted()}>` slot list — not the order focus moved.
 * Focus a tile whose slot was created EARLIER and the mount runs first, so the
 * unmount's write lands last.
 *
 * That write used to be an unconditional `--sk-h: 0px`, which left the page
 * reserving no room for a toolbar that is on screen: `app.css`'s
 * `body.has-soft-keys .tl-views` gives the space back and the bottom row of
 * every view slides under the row. Gating the row on focus (2026-09-12) is what
 * put the two instances into one update; before it, three visible tiles meant
 * three rows and closing any one of them zeroed the property for the other two.
 *
 * These tests drive the real component, mounted twice, in both orders. The
 * height is stubbed per element because jsdom lays nothing out and both rows
 * carry the same `id="soft-keys"` — so a single shared stub could not tell the
 * survivor's height from the loser's, which is the whole assertion.
 *
 * A `.ts` file rather than `.tsx`: the component is called directly, which is
 * all JSX compiles to anyway, and it keeps the two mounts and their two
 * lifetimes visible as plain statements instead of nested markup.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { SoftKeys } from "../src/components/SoftKeys";

/** One observer a test can fire on demand, per observed element. */
interface Stub {
  target: Element;
  fire: () => void;
}
let observers: Stub[] = [];
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

function installResizeObserver(): void {
  class FakeRO {
    private cb: () => void;
    private seen: Element[] = [];
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(target: Element): void {
      this.seen.push(target);
      observers.push({ target, fire: () => this.cb() });
    }
    disconnect(): void {
      observers = observers.filter((o) => !this.seen.includes(o.target));
    }
    unobserve(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeRO as unknown as typeof ResizeObserver;
}

/**
 * Per-element heights, because the two rows are the same element type with the
 * same id and only their heights tell them apart.
 *
 * The mapping is filled on an element's FIRST `offsetHeight` read, which is the
 * `write()` inside the component's own ref callback — so `mountRow(50)` reads
 * 50 and nothing else does. Later reads come back cached, and a test that wants
 * to resize a row writes the map directly.
 */
const heights = new WeakMap<Element, number>();
let nextHeight = 0;

function stubHeights(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.id !== "soft-keys") return 0;
      const cached = heights.get(this);
      if (cached !== undefined) return cached;
      heights.set(this, nextHeight);
      return nextHeight;
    },
  });
}

const skH = (): string => document.documentElement.style.getPropertyValue("--sk-h");

/** One mounted soft-key row of a known height, with its own root and lifetime. */
function mountRow(px: number): { el: HTMLElement; unmount: () => void } {
  nextHeight = px;
  const { container, unmount } = render(() => SoftKeys({ send: () => {} }));
  const el = container.querySelector<HTMLElement>("#soft-keys");
  if (!el) throw new Error("the row did not render");
  return { el, unmount };
}

beforeEach(() => {
  observers = [];
  nextHeight = 0;
  document.documentElement.style.removeProperty("--sk-h");
  stubHeights();
});

afterEach(() => {
  if (realRO) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  // A structural cast rather than a suppression comment: `offsetHeight` is a
  // required readonly number on HTMLElement, so `delete` needs a view of the
  // prototype on which it is optional. Same shape as the ResizeObserver line
  // above, and it keeps this file free of `@ts-expect-error`.
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
});

describe("--sk-h has one publisher, and only it may clear the value", () => {
  it("keeps the arriving row's height when the leaving row runs LAST", () => {
    // Focus moved A → B, and B's slot was created earlier, so B mounts before A
    // disposes. This is the order that was broken: A's cleanup was the last
    // write and it said there is no toolbar, with B's on screen.
    installResizeObserver();
    const a = mountRow(50);
    expect(skH(), "A publishes its own height").toBe("50px");

    const b = mountRow(44);
    expect(skH(), "B takes the property when it mounts").toBe("44px");

    a.unmount();
    expect(skH(), "B is still on screen, so its height stands").toBe("44px");

    b.unmount();
    expect(skH(), "the last row out gives the space back").toBe("0px");
  });

  it("keeps the arriving row's height when the leaving row runs FIRST", () => {
    // The other slot order, which happened to work already. Both orders have to
    // end at the same number or the reservation depends on when a tile was
    // opened, which nobody can see.
    installResizeObserver();
    const a = mountRow(50);
    expect(skH()).toBe("50px");

    a.unmount();
    const b = mountRow(44);
    expect(skH(), "B's own height, whichever way round the update ran").toBe("44px");

    b.unmount();
    expect(skH()).toBe("0px");
  });

  it("ignores a superseded row's resize rather than letting it push its height back", () => {
    // A's ResizeObserver lives until the disposal it is racing reaches it. A
    // re-wrap in that window — the text-scale setting moves the row, so this is
    // a real event and not a contrivance — must not republish a dead row's box
    // over the live one's.
    installResizeObserver();
    const a = mountRow(50);
    const b = mountRow(44);
    expect(skH()).toBe("44px");

    heights.set(a.el, 80);
    const aObserver = observers.find((o) => o.target === a.el);
    expect(aObserver, "A's observer").toBeDefined();
    aObserver?.fire();
    expect(skH(), "B still owns the property").toBe("44px");

    a.unmount();
    b.unmount();
  });

  it("still republishes the LIVE row's height after the other one has left", () => {
    // The guard must not freeze the value: the survivor keeps its observer and
    // keeps reporting, which is what a text-scale change on the focused tile
    // depends on.
    installResizeObserver();
    const a = mountRow(50);
    const b = mountRow(44);
    a.unmount();

    heights.set(b.el, 96);
    const bObserver = observers.find((o) => o.target === b.el);
    expect(bObserver, "B's observer").toBeDefined();
    bObserver?.fire();
    expect(skH()).toBe("96px");

    b.unmount();
    expect(skH()).toBe("0px");
  });

  it("gives the space back on a browser with no ResizeObserver", () => {
    // Pre-2020 Safari takes the seed-only path. The cleanup used to sit inside
    // the branch the early return skips, so the row's height stayed reserved
    // with nothing on screen holding it.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const a = mountRow(44);
    expect(skH()).toBe("44px");
    a.unmount();
    expect(skH()).toBe("0px");
  });
});
