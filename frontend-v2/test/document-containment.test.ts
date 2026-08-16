/**
 * The document must never scroll. This app is an inner-scroller shell: the
 * session list scrolls, the terminal scrolls itself, and the page behind them
 * holds still.
 *
 * Why it is asserted rather than assumed. On iOS a percentage height resolves
 * against the LARGE viewport (URL bar hidden) while the visible area is the
 * SMALL one, so `html, body, #root { height: 100% }` alone makes the document
 * taller than the screen and the page pans — which is what a swipe on the
 * terminal ends up moving. The same class was measured on the vanilla page
 * before (rendered 681px against a 641px window) and cured there; v2 was built
 * without the guard.
 *
 * These are CSS-text assertions because the behaviour they protect only appears
 * on a viewport whose layout and visual sizes differ — something jsdom does not
 * have and headless Chromium does not emulate (measured: with a deliberately
 * scrollable parent, Chromium kept the swipe inside the iframe and the page did
 * not move). The rules below are what makes the difference unreachable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_CSS = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
const TERM_HTML = readFileSync(
  resolve(process.cwd(), "../frontend/term.html"),
  "utf8",
);

/** The declaration block of the first rule whose selector list matches. */
function ruleFor(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `a rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
}

describe("the lobby document cannot scroll", () => {
  it("pins html and body with overflow: hidden", () => {
    // Without this the root chain is 100% of the LARGE viewport while the
    // visible area is the small one, and the difference is scrollable.
    const rule = ruleFor(APP_CSS, "html,\nbody");
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it("suppresses overscroll on html, not only on body", () => {
    // body alone is not enough: whether the viewport picks up the body value
    // depends on the root element's own being auto, and on iOS the rubber-band
    // is what makes a swipe read as the page moving.
    const rule = ruleFor(APP_CSS, "html,\nbody");
    expect(rule).toMatch(/overscroll-behavior:\s*none/);
  });

  it("sizes #root to the measured window height, not to a percentage", () => {
    // --app-vh is window.innerHeight in px (mobile/viewport.ts, seeded
    // pre-paint). A percentage here is the large viewport on iOS.
    const rule = ruleFor(APP_CSS, "#root {");
    expect(rule).toMatch(/height:\s*var\(--app-vh/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it("keeps the same guard on the terminal page inside the iframe", () => {
    // term.html is its own document; a gesture that escapes it lands on the
    // lobby behind it.
    const rule = ruleFor(TERM_HTML, "html, body {");
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/overscroll-behavior:\s*none/);
  });
});
