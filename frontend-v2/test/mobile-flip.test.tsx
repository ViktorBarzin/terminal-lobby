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

/** The touch-ergonomics block: everything a FINGER needs, phone or tablet. */
const TOUCH_HEADER = "/* ---- Touch ergonomics";
const touchBlock = (): string => {
  const css = readCss();
  const at = css.indexOf(TOUCH_HEADER);
  expect(at, "the touch-ergonomics block").toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("/* ---- Phone: one view at a time"));
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

describe("touch ergonomics — sized for a finger, phone or tablet", () => {
  it("lives under the pointer query, not the phone flip", () => {
    // A finger is a finger at 768px. Measured on a tablet, the session bar's
    // buttons were the one row still at their 28px mouse size because the rule
    // had been written into the flip block by mistake — everything around them
    // had already grown.
    const block = touchBlock();
    expect(block).toContain("@media (pointer: coarse)");
    expect(block).not.toContain(FLIP_QUERY);
    expect(flipBlock()).not.toContain(".tl-session-bar .tl-icon-btn");
  });

  // The ⋯ button used to be revealed here (opacity:1), because hover never
  // arrives on a touch screen. That made rename/kill/move reachable, but it
  // also put a 40px target inside a 40px row, so a thumb aiming at the row's
  // right half opened the menu instead of the session. Since 2026-08-16 the
  // button is hidden on touch and a 450ms press on the row opens the same menu
  // (SessionCard), which hands the whole row back to "open this session".
  it("hides the card's ⋯ button, since a long press opens the menu", () => {
    const block = touchBlock();
    expect(block).toMatch(/\.tl-card-actions\s*\{[^}]*display:\s*none/);
  });

  it("makes the session row itself a comfortable target", () => {
    const block = touchBlock();
    const at = block.indexOf(".tl-card {");
    expect(at, ".tl-card in the touch block").toBeGreaterThan(-1);
    const rule = block.slice(at, block.indexOf("}", at));
    expect(rule).toMatch(/min-height:\s*48px/);
  });

  const FLOOR_SELECTORS = [
    ".tl-menu-item",
    ".tl-head-btn",
    ".tl-foot-btn",
    ".tl-group-header",
    ".tl-session-bar .tl-icon-btn",
  ];
  for (const sel of FLOOR_SELECTORS) {
    it(`gives ${sel} a 40px target`, () => {
      const block = touchBlock();
      const at = block.indexOf(sel + " {");
      expect(at, `${sel} in the touch block`).toBeGreaterThan(-1);
      const rule = block.slice(at, block.indexOf("}", at));
      expect(rule, sel).toMatch(/(min-)?height:\s*40px/);
    });
  }

  it("lets the 40px target BE the row, instead of padding around it", () => {
    // The action button is the tallest thing in a session row, and it is a flex
    // child of a card that also carries 6px of its own vertical padding — so the
    // 40px floor rendered as a 54px row (measured, 390x844, 6 sessions). The
    // padding is what has to go: the target stays 40px, the row becomes 40px,
    // and the list gets 14px per session back. Same shape as the vanilla page's
    // 2026-07-17 finding, where a 44px button inflated a 28px row.
    const block = touchBlock();
    const at = block.indexOf(".tl-card {");
    expect(at, ".tl-card in the touch block").toBeGreaterThan(-1);
    const rule = block.slice(at, block.indexOf("}", at));
    expect(rule, "no vertical padding on top of the target").toMatch(
      /padding:\s*0\s+8px/,
    );
  });

  it("sets 16px on every text input, or iOS zooms the page on focus", () => {
    // Safari zooms when a focused field is under 16px and does not zoom back
    // out, which on the phone layout leaves a list you have to pan sideways.
    const block = touchBlock();
    for (const sel of [".tl-new-cmd", ".tl-add-input", ".tl-card-rename"]) {
      expect(block, sel).toContain(sel);
    }
    expect(block).toMatch(/font-size:\s*16px/);
  });
});

describe("Sidebar — the Skills route the phone needs", () => {
  const mkStore = () =>
    createLobbyStore({ initialSelected: null, notify: () => {} });

  it("shows no Skills button on a desktop, where the shell bar carries one", () => {
    stubViewport({ width: 1920, height: 1080, coarse: false });
    const { container } = render(() => (
      <Sidebar store={mkStore()} prefs={createPrefsStore()} />
    ));
    expect(container.querySelector(".tl-foot-skills")).toBeNull();
  });

  it("shows one when the shell bar is folded away, and it opens the panel", () => {
    // The shell-bar Skills button is not rendered on a phone, and the session-bar
    // menu that also carries it only exists once a session is open — so without
    // this the panel is unreachable from the list screen. It was, for a few hours.
    stubViewport({ width: 390, height: 844, coarse: true });
    const onOpenSkills = vi.fn();
    const { container } = render(() => (
      <Sidebar store={mkStore()} prefs={createPrefsStore()} onOpenSkills={onOpenSkills} />
    ));
    const btn = container.querySelector<HTMLButtonElement>(".tl-foot-skills");
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Skills");
    // An SVG, not a glyph: emoji render in colour and at a different size on
    // every OS, and the ⌘ this replaced reads as the Mac command key on iOS.
    expect(btn!.querySelector("svg")).not.toBeNull();
    expect(btn!.textContent).toBe("");
    btn!.click();
    expect(onOpenSkills).toHaveBeenCalledTimes(1);
  });

  it("sits beside the gear, so both routes are in one place", () => {
    stubViewport({ width: 390, height: 844, coarse: true });
    const { container } = render(() => (
      <Sidebar
        store={mkStore()}
        prefs={createPrefsStore()}
        onOpenSkills={() => {}}
        onOpenSettings={() => {}}
      />
    ));
    const foot = container.querySelector(".tl-sidebar-foot")!;
    expect(foot.querySelector(".tl-foot-skills")).not.toBeNull();
    expect(foot.querySelector(".tl-foot-settings")).not.toBeNull();
  });
});
