/**
 * A wide table scrolls inside its own box instead of squeezing its columns.
 *
 * The table used to be the scroller and the content at once —
 * `display: block; overflow-x: auto` on the `<table>` itself. An element cannot
 * be wider than its own scrollport, so it took the column's width and wrapped
 * every cell rather than overflowing. Measured in a real browser at 390px
 * against this stylesheet, on a five-column table: 221px tall, 3 lines in every
 * cell, and `on-screen-here` broken into 3 separate pieces each drawing its own
 * code background. With the scroller split out: 116px, one line per cell, one
 * piece, and the box scrolls to 613px.
 *
 * jsdom does no layout, so this guards the declarations that produce that
 * rather than the geometry. The pairing is what matters and it spans two files:
 * Markdown.tsx emits the wrapper, this stylesheet gives it the overflow, and
 * neither half is any use alone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const css = read("src/app.css").replace(/\/\*[\s\S]*?\*\//g, "");
const markdownTsx = read("src/components/Markdown.tsx");

const rule = (selector: string): string => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .join("\n");
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("the table's scroller", () => {
  it("is the wrapper, and it scrolls sideways", () => {
    expect(rule(".tl-table-scroll")).toMatch(/overflow-x:\s*auto/);
  });

  // Reaching the end of a table must not hand the swipe to the transcript.
  it("keeps the swipe to itself", () => {
    expect(rule(".tl-table-scroll")).toMatch(/overscroll-behavior-x:\s*contain/);
  });

  // There is no hover on a phone, so a hover-revealed scrollbar is an invisible
  // one, and a scroller nobody can see reads as a truncated table.
  it("shows its scrollbar without being hovered", () => {
    expect(rule(".tl-table-scroll")).toMatch(/scrollbar-width:\s*thin/);
  });
});

describe("the table itself", () => {
  it("is as wide as its content, not as wide as the column", () => {
    const r = rule(".tl-markdown table");
    expect(r).toMatch(/width:\s*max-content/);
    expect(r).toMatch(/max-width:\s*none/);
  });

  // Both halves of the old shape have to be gone. Either one left behind puts
  // the scrollport back on the element that has to overflow it.
  it("is no longer its own scroller", () => {
    const r = rule(".tl-markdown table");
    expect(r).not.toMatch(/display:\s*block/);
    expect(r).not.toMatch(/overflow-x/);
  });

  it("does not break an identifier across lines", () => {
    expect(rule(".tl-markdown th code,\n.tl-markdown td code")).toMatch(
      /white-space:\s*nowrap/,
    );
  });
});

describe("the wrapper actually gets emitted", () => {
  it("Markdown.tsx wraps every table in the scroller", () => {
    expect(markdownTsx).toMatch(/table:\s*\(props\)\s*=>/);
    expect(markdownTsx).toMatch(/class="tl-table-scroll"/);
  });
});

describe("a wide table cannot drag the transcript sideways", () => {
  // The guard that was already there, kept honest: the timeline clips, so
  // anything too wide has to scroll in its own box. That is now true of tables,
  // and this asserts the clip it depends on has not been relaxed.
  it("the timeline still clips", () => {
    expect(css).toMatch(/overflow-x:\s*hidden/);
  });

  // And the scroller must not fight that clip: a negative margin to bleed the
  // table to the screen edges would be cut off by it, losing the first column.
  it("the scroller does not bleed past the clip", () => {
    expect(rule(".tl-table-scroll")).not.toMatch(/margin:[^;]*-/);
  });
});
