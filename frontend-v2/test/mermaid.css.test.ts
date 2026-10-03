/**
 * A diagram wider than the column is never cut off at either edge.
 *
 * `.tl-mermaid` centred its SVG with `justify-content: center`. A centred flex
 * item that is wider than its box overflows BOTH sides, and a scroll container
 * cannot scroll to negative offsets, so the left part is unreachable. Measured
 * at 723px on a desktop, on a 1064px flowchart: the SVG started 170px left of
 * its box, and the box scrolled only 170px to the right. Both edges were cut.
 *
 * Now the diagram shrinks to fit the column, down to 65% of its natural size
 * (Mermaid.tsx sets that floor per diagram as --tl-mmd-floor), and pans past
 * that. `margin-inline: auto` still centres one that fits, and an auto margin
 * resolves to zero when there is no room, so an overflowing one starts at the
 * left edge and the scroller reaches all of it.
 *
 * jsdom does no layout, so this guards the declarations rather than geometry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The first top-level rule for `selector`, outside any @media block. */
const rule = (selector: string): string => {
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of top.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("a wide diagram", () => {
  it("is not centred by its box, which pushes the left edge out of reach", () => {
    expect(rule(".tl-mermaid")).not.toMatch(/justify-content:\s*center/);
  });

  it("centres itself with auto margins, which collapse when it overflows", () => {
    expect(rule(".tl-mermaid svg")).toMatch(/margin-inline:\s*auto/);
  });

  it("shrinks to the column, but not below its legibility floor", () => {
    const r = rule(".tl-mermaid svg");
    expect(r).toMatch(/max-width:\s*100%/);
    expect(r).toMatch(/min-width:\s*var\(--tl-mmd-floor/);
  });

  it("still scrolls sideways in its own box past the floor", () => {
    expect(rule(".tl-mermaid")).toMatch(/overflow-x:\s*auto/);
  });
});
