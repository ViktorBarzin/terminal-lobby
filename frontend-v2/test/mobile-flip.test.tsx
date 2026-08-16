/**
 * The phone layout's flip: which viewports it claims, and the two places the
 * decision has to stay consistent (the TS query and the CSS block, the sidebar
 * gear and the folded shell bar).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot } from "solid-js";
import { render } from "@solidjs/testing-library";
import {
  FLIP_QUERY,
  isMobileFlip,
  createMobileFlip,
  isCoarsePointer,
} from "../src/mobile/pointer";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore } from "../src/store/lobby";
import { createPrefsStore } from "../src/store/prefs";

// jsdom serves import.meta.url over http, so resolve from the project root
// (vitest runs with cwd = frontend-v2) rather than from the module URL.
const CSS_PATH = resolve(process.cwd(), "src/sidebar.css");
const readCss = (): string => readFileSync(CSS_PATH, "utf8");
const flipBlock = (): string => {
  const css = readCss();
  const at = css.indexOf(`@media ${FLIP_QUERY}`);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at);
};

/**
 * A matchMedia that answers from a real viewport rather than from a substring
 * guess: the flip query is a compound of three clauses, and a stub that only
 * looked for "coarse" would pass a test the browser would fail.
 */
type Viewport = { width: number; height: number; coarse: boolean };

const listeners = new Set<{ q: string; fn: (e: MediaQueryListEvent) => void }>();

function evaluate(q: string, vp: Viewport): boolean {
  if (q.includes("pointer: coarse") && !vp.coarse) return false;
  if (q === "(pointer: coarse)") return vp.coarse;
  // FLIP_QUERY's disjunction.
  const w = q.match(/max-width:\s*(\d+)px/);
  const h = q.match(/max-height:\s*(\d+)px/);
  const okW = w ? vp.width <= Number(w[1]) : false;
  const okH = h ? vp.height <= Number(h[1]) : false;
  return okW || okH;
}

function stubViewport(vp: Viewport): void {
  window.matchMedia = ((q: string) => {
    const mql = {
      media: q,
      get matches() {
        return evaluate(q, vp);
      },
      addEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.add({ q, fn });
      },
      removeEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => {
        for (const l of listeners) if (l.fn === fn) listeners.delete(l);
      },
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
    return mql as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** Rotate/resize: re-point the viewport and fire the listeners, as a UA would. */
function moveTo(vp: Viewport): void {
  stubViewport(vp);
  for (const l of [...listeners]) {
    l.fn({ matches: evaluate(l.q, vp) } as MediaQueryListEvent);
  }
}

const original = window.matchMedia;
afterEach(() => {
  listeners.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});

describe("phone flip — which viewports it claims", () => {
  const cases: Array<[string, Viewport, boolean]> = [
    ["a phone in portrait", { width: 390, height: 844, coarse: true }, true],
    // The case a width-only query misses: 844px is far past 720, but 390px of
    // height is even less room for two panes than portrait had.
    ["a phone in landscape", { width: 844, height: 390, coarse: true }, true],
    // Measured healthy with both panes: a 260px list with every card visible
    // and a terminal filling 87% of the height.
    ["a tablet in portrait", { width: 768, height: 1024, coarse: true }, false],
    ["a tablet in landscape", { width: 1024, height: 768, coarse: true }, false],
    // Someone shrank a desktop window on purpose to watch a session beside the
    // list. A mouse is fine with the stacked layout; hiding half is a downgrade.
    ["a narrow desktop window", { width: 600, height: 800, coarse: false }, false],
    ["a short desktop window", { width: 1400, height: 420, coarse: false }, false],
    ["a full desktop", { width: 1920, height: 1080, coarse: false }, false],
  ];

  for (const [name, vp, want] of cases) {
    it(`${want ? "flips" : "does not flip"} for ${name}`, () => {
      stubViewport(vp);
      expect(isMobileFlip()).toBe(want);
    });
  }

  it("keeps touch ergonomics on a tablet even though the layout does not flip", () => {
    // A finger is a finger at 768px: the 40px targets ride the plain coarse
    // query, not the flip.
    stubViewport({ width: 768, height: 1024, coarse: true });
    expect(isMobileFlip()).toBe(false);
    expect(isCoarsePointer()).toBe(true);
  });

  it("is reactive: rotating a phone crosses the query", () => {
    stubViewport({ width: 390, height: 844, coarse: true });
    createRoot((dispose) => {
      const flip = createMobileFlip();
      expect(flip()).toBe(true);
      // Rotate to landscape — still a phone, still flipped (max-height clause).
      moveTo({ width: 844, height: 390, coarse: true });
      expect(flip()).toBe(true);
      // Cast to a tablet-sized touch screen: both clauses fail, layout returns.
      moveTo({ width: 1024, height: 768, coarse: true });
      expect(flip()).toBe(false);
      dispose();
    });
  });

  it("is SSR-safe and survives a matchMedia that throws", () => {
    window.matchMedia = (() => {
      throw new Error("no media queries here");
    }) as typeof window.matchMedia;
    expect(isMobileFlip()).toBe(false);
    // @ts-expect-error — deleting the API is exactly the case under test
    delete window.matchMedia;
    expect(isMobileFlip()).toBe(false);
  });
});

describe("phone flip — the TS query and the CSS block agree", () => {
  it("uses the identical media query in sidebar.css", () => {
    // Drift here is not cosmetic: CSS that hides the session pane while the TS
    // still believes it is on screen leaves the terminal iframe fitting itself
    // against a 0x0 box, and tmux sizes a window to its SMALLEST attached
    // client — every other device on that session gets dragged down with it.
    expect(readCss()).toContain(`@media ${FLIP_QUERY}`);
  });

  it("hides the shell bar and folds it into the session bar", () => {
    const block = flipBlock();
    expect(block).toMatch(/\.tl-shellbar\s*\{\s*display:\s*none/);
    // ...which is why the sidebar's own screen needs a gear of its own.
    expect(block).toContain(".tl-foot-settings");
  });

  it("gives the session pane no box at all while browsing", () => {
    const block = flipBlock();
    // display:none, never a zero height — a zero-height box is still a box, and
    // the terminal inside it would fit to it.
    expect(block).toMatch(
      /\.tl-shell:not\(\.tl-shell-collapsed\)\s+\.tl-shell-content\s*\{\s*display:\s*none/,
    );
    expect(block).toMatch(
      /\.tl-shell-collapsed\s+\.tl-shell-sidebar\s*\{\s*display:\s*none/,
    );
  });

  it("pins the shell to --app-vh rather than a CSS viewport unit", () => {
    // vh/svh/dvh resolve to the LARGE viewport in an iOS standalone PWA, which
    // renders the shell taller than the screen and clips its bottom row.
    const block = flipBlock();
    expect(block).toContain("height: var(--app-vh, 100%)");
    expect(block).not.toMatch(/height:\s*\d+(vh|svh|dvh)/);
  });
});

describe("Sidebar — the Settings route the phone needs", () => {
  const mkStore = () =>
    createLobbyStore({ initialSelected: null, notify: () => {} });

  it("shows no gear on a desktop, where the shell bar carries one", () => {
    stubViewport({ width: 1920, height: 1080, coarse: false });
    const { container } = render(() => (
      <Sidebar store={mkStore()} prefs={createPrefsStore()} />
    ));
    expect(container.querySelector(".tl-foot-settings")).toBeNull();
  });

  it("shows a gear when the shell bar is folded away, and it opens Settings", () => {
    stubViewport({ width: 390, height: 844, coarse: true });
    const onOpenSettings = vi.fn();
    const { container } = render(() => (
      <Sidebar
        store={mkStore()}
        prefs={createPrefsStore()}
        onOpenSettings={onOpenSettings}
      />
    ));
    const gear = container.querySelector<HTMLButtonElement>(".tl-foot-settings");
    expect(gear).not.toBeNull();
    expect(gear!.getAttribute("aria-label")).toBe("Settings");
    gear!.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
