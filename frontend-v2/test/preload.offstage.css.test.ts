/**
 * A preloaded terminal has to be MEASURABLE while nobody can see it.
 *
 * The hover preload (ADR-0026) mounts a terminal for a session the tab has
 * never shown, then reveals it on the click. It used to be mounted `tl-hidden`,
 * which is `display: none`, and a terminal built inside one cannot measure its
 * own font: measured on the deployed build on 2026-09-12, xterm read 0 px for a
 * character, its DOM renderer set the per-row `letter-spacing` to a whole cell,
 * and the first frame after the click was double-width and colourless for 90 to
 * 200 ms before a real measurement corrected it. The first open of a page load
 * was worse at 207 ms, because the grid was xterm's constructed 80x24 as well.
 *
 * `visibility: hidden` on a laid-out box measures exactly like a visible one.
 * Verified against the deployed bundle the same day by injecting this rule and
 * reading xterm's own numbers while the preload was still hidden: char measure
 * 256 px, letter-spacing 0 px, 53 rows, and nothing changed at the click.
 *
 * jsdom does no layout, so this guards the declarations that make it true
 * rather than the geometry. `slotClasses` in App.tsx guards which slot gets it,
 * and `preload.mount.test.tsx` pins that.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const app = strip(readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"));
const sidebar = strip(readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8"));

const rule = (css: string, selector: string): string => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("an offstage preload", () => {
  const offstage = rule(app, ".tl-session-slot.tl-offstage");

  it("keeps a box, so xterm can measure a character in it", () => {
    // The whole bug in one assertion: anything that computes to `display: none`
    // takes the box away and the measurement with it.
    expect(offstage).toMatch(/display:\s*flex/);
    expect(offstage).not.toMatch(/display:\s*none/);
    expect(offstage).toMatch(/visibility:\s*hidden/);
  });

  it("takes the pane's own box rather than pushing the session aside", () => {
    expect(offstage).toMatch(/position:\s*absolute/);
    expect(offstage).toMatch(/left:\s*0/);
    expect(offstage).toMatch(/right:\s*0/);
    expect(offstage).toMatch(/top:\s*0/);
  });

  it("leaves the scratch-shell panel out of the box it measures", () => {
    // Without this a preload counted the dock's rows as its own, and the click
    // resized them away — the reflow this whole rule exists to remove.
    expect(offstage).toMatch(/bottom:\s*var\(--tl-dock-h,\s*0px\)/);
  });

  it("cannot be clicked, sitting over the session on screen", () => {
    expect(offstage).toMatch(/pointer-events:\s*none/);
  });

  it("is positioned against the shell body, which says so", () => {
    expect(rule(sidebar, ".tl-shell-body")).toMatch(/position:\s*relative/);
  });
});
