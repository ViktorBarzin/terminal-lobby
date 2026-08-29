/**
 * The box you are typing into on the list screen has to be ON the screen.
 *
 * Reported 2026-08-29: "when creating a new session on mobile, the session
 * input box is not visible (not scrolled to), so I'm typing blind."
 *
 * Measured at 390x844 against a project whose sessions run past the fold: its
 * "new session" box opened at y=543-583, and an iPhone's keyboard covers
 * everything below y=508. The browser's own scroll-into-view had already run —
 * and could not help, because it aims for the SCROLL CONTAINER's box, and that
 * box carried on underneath the keyboard. On iOS Safari it always does: the
 * keyboard shrinks only the visual viewport, so the layout is unchanged.
 *
 * Two things fix it, and they are a pair:
 *   1. the sidebar reserves the covered strip (--kb-offset), so its scroller
 *      ENDS above the keyboard and "into view" starts meaning something;
 *   2. mobile/reveal.ts re-reveals the field once the keyboard settles (its own
 *      tests) — the browser's single attempt runs against the geometry from
 *      before the keyboard opened.
 *
 * And underneath both: --kb-offset has to exist on this screen at all. It is
 * published by installViewportSync, which used to be mounted by SessionView —
 * so on the list screen, with no session open, it was never published.
 *
 * CSS text rather than layout, for the reason document-containment.test.ts
 * gives: the difference between the layout and visual viewports is not
 * something jsdom has or headless Chromium emulates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sidebarCss = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");
const appTsx = readFileSync(resolve(process.cwd(), "src/components/App.tsx"), "utf8");
const sessionTsx = readFileSync(
  resolve(process.cwd(), "src/components/SessionView.tsx"),
  "utf8",
);

/** The phone block, by its media query — the same one mobile/pointer.ts pins. */
const phoneBlock = (): string => {
  const at = sidebarCss.indexOf(
    "@media (pointer: coarse) and ((max-width: 720px) or (max-height: 480px))",
  );
  expect(at, "the phone media query").toBeGreaterThan(-1);
  const start = sidebarCss.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < sidebarCss.length; i++) {
    if (sidebarCss[i] === "{") depth++;
    else if (sidebarCss[i] === "}") {
      depth--;
      if (depth === 0) return sidebarCss.slice(start, i);
    }
  }
  throw new Error("unbalanced phone block");
};

const ruleFor = (block: string, selector: string): string => {
  const at = block.indexOf(selector + " {");
  expect(at, `${selector} in the phone block`).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf("}", at));
};

describe("the list screen gives the soft keyboard its strip back", () => {
  it("reserves --kb-offset at the bottom of the sidebar", () => {
    expect(ruleFor(phoneBlock(), ".tl-sidebar")).toMatch(
      /padding-bottom:\s*var\(--kb-offset,\s*0px\)/,
    );
  });

  it("takes the reservation out of the sidebar's own height", () => {
    // Without border-box the padding is ADDED to height:100% and the screen
    // grows by the keyboard instead of shrinking by it.
    expect(ruleFor(phoneBlock(), ".tl-sidebar")).toMatch(/box-sizing:\s*border-box/);
  });

  it("is a phone rule — a mouse has no soft keyboard", () => {
    // Keyed with the rest of the one-pane layout, not globally: --kb-offset is
    // 0 on a desktop, but a rule that only ever resolves to 0 is noise.
    expect(phoneBlock()).toContain(".tl-sidebar {");
  });
});

describe("--kb-offset is published while the list screen is up", () => {
  it("installs the viewport sync in the shell", () => {
    expect(appTsx).toMatch(/installViewportSync\(/);
  });

  it("installs the focus reveal in the shell", () => {
    expect(appTsx).toMatch(/installFocusReveal\(/);
  });

  it("no longer installs the viewport sync per session", () => {
    // It ran once per session kept in the tab — five open sessions meant five
    // syncs writing the same three custom properties — and not at all until a
    // session was opened.
    expect(sessionTsx).not.toMatch(/installViewportSync\(/);
  });
});
