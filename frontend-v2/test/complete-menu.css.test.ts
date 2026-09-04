/**
 * The `/` menu's rows must not give up height to the scroller.
 *
 * `.tl-complete` is a flex column with a max-height, so every row was a
 * shrinkable flex child. Measured in a real browser at 390x844 on 2026-09-04
 * with 130 entries loaded: each row sat at its 40px finger-target floor, the
 * name row took 19.5px, and the description was squeezed to 7.5px of the 15.5px
 * its line needs — so `overflow: hidden` cut every description horizontally
 * through the middle of its glyphs. jsdom does no layout, so this guards the two
 * declarations that stop it rather than the geometry.
 *
 * Also here: the failed-catalogue note is stuck to the bottom edge, not merely
 * last. Last is 95 rows down a 220px scroller, where the same measurement found
 * it present in the DOM and off screen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const rule = (selector: string): string => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").map((s) => s.trim()).join("\n");
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("a menu row keeps its own height", () => {
  it("does not let the scroller shrink the row", () => {
    expect(rule(".tl-complete-item")).toMatch(/flex:\s*none/);
  });

  it("does not let the row shrink the description", () => {
    expect(rule(".tl-complete-desc")).toMatch(/flex:\s*none/);
  });

  it("still gives a finger a 40px target", () => {
    // The floor is what (pointer: coarse) is for; the bug was treating it as a
    // ceiling. Both must hold: a minimum, and permission to exceed it.
    expect(css).toMatch(/\.tl-question-option,\s*\.tl-complete-item\s*\{[^}]*min-height:\s*40px/);
    expect(rule(".tl-complete-item")).not.toMatch(/max-height:/);
    // `(?:^|[;\s])` so the min-height above is not read as a fixed height.
    expect(rule(".tl-complete-item")).not.toMatch(/(?:^|[;\s])height:/);
  });
});

describe("the failed-catalogue note", () => {
  it("sticks to the bottom edge rather than scrolling away", () => {
    const note = rule(".tl-complete-note");
    expect(note).toMatch(/position:\s*sticky/);
    expect(note).toMatch(/bottom:\s*0/);
    expect(note).toMatch(/flex:\s*none/);
  });

  it("is opaque, because the rows scroll behind it", () => {
    expect(rule(".tl-complete-note")).toMatch(/background:\s*var\(--bg-card\)/);
  });

  it("reads as information rather than an error", () => {
    // The rows above it are real and usable. Muted text, no error colour.
    const note = rule(".tl-complete-note");
    expect(note).toMatch(/color:\s*var\(--text-muted\)/);
    expect(note).not.toMatch(/var\(--err/);
  });
});

describe("the source badge", () => {
  it("never gives up width, so it cannot be truncated to nothing", () => {
    expect(rule(".tl-complete-source")).toMatch(/flex:\s*none/);
  });

  it("lets the name give up width instead", () => {
    expect(rule(".tl-complete-row .tl-complete-name")).toMatch(/flex:\s*0 1 auto/);
    expect(rule(".tl-complete-row .tl-complete-name")).toMatch(/text-overflow:\s*ellipsis/);
  });
});
