/**
 * The soft-key row publishes its own height as `--sk-h`, which is the space the
 * views above it reserve. The row changes height with no window resize behind
 * it (the overflow tier toggles, the key rows re-wrap), so a ResizeObserver on
 * the element is what keeps the reservation honest.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { SoftKeys } from "../src/components/SoftKeys";

/** Observers created during a test, so one can be fired on demand. */
type Stub = { target: Element; fire: () => void; disconnected: boolean };
let observers: Stub[] = [];
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

function installResizeObserver(): void {
  class FakeRO {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      observers.push({ target, fire: () => this.cb(), disconnected: false });
    }
    disconnect() {
      for (const o of observers) if (o.target) o.disconnected = true;
    }
    unobserve() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeRO as unknown as typeof ResizeObserver;
}

/** jsdom lays nothing out, so offsetHeight is the one thing we must fake. */
function stubHeight(px: number): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.id === "soft-keys" ? px : 0;
    },
  });
}

const skH = (): string =>
  document.documentElement.style.getPropertyValue("--sk-h");

beforeEach(() => {
  observers = [];
  document.documentElement.style.removeProperty("--sk-h");
});

afterEach(() => {
  if (realRO) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  // @ts-expect-error — restoring jsdom's own zero-height getter
  delete HTMLElement.prototype.offsetHeight;
  vi.restoreAllMocks();
});

describe("<SoftKeys> — --sk-h", () => {
  it("publishes its height on mount", () => {
    installResizeObserver();
    stubHeight(50);
    render(() => <SoftKeys send={() => {}} />);
    expect(skH()).toBe("50px");
  });

  it("republishes when the row changes height with no window resize", () => {
    // The ⋯ overflow tier expanding is exactly this case: the row grows, no
    // resize event fires, and without the observer the views above keep
    // reserving the old height and the toolbar covers them.
    installResizeObserver();
    stubHeight(50);
    render(() => <SoftKeys send={() => {}} />);
    expect(skH()).toBe("50px");

    stubHeight(96);
    const ro = observers[0];
    expect(ro, "the row's ResizeObserver").toBeDefined();
    ro!.fire();
    expect(skH()).toBe("96px");
  });

  it("gives the space back when the row unmounts", () => {
    installResizeObserver();
    stubHeight(50);
    const { unmount } = render(() => <SoftKeys send={() => {}} />);
    expect(skH()).toBe("50px");
    unmount();
    // A stale non-zero --sk-h leaves the views reserving room for a toolbar
    // that is no longer there.
    expect(skH()).toBe("0px");
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });

  it("still seeds the height where ResizeObserver does not exist", () => {
    // Older Safari. One write at mount is worse than live updates and much
    // better than nothing.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    stubHeight(44);
    expect(() => render(() => <SoftKeys send={() => {}} />)).not.toThrow();
    expect(skH()).toBe("44px");
  });
});
