/**
 * The model popover's "more below" fade.
 *
 * Deployed review round 1 of the T3 pass (2026-09-29): in a tile at 1280x800,
 * and in any pane about 720px tall, the popover is shorter than the sheet and
 * its last rows faded out. The fade was a mask on the popover itself, which
 * made its background see-through too: the conversation behind showed through
 * the Bypass and No ask rows, and the "Context N% used" line could not be
 * read. The fade is now drawn over the rows in the card's own colour.
 *
 * CSS text, because none of this is behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rule = (sel: string): string =>
  new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("the model popover with more below its edge", () => {
  it("does not mask itself, which would show the page through its background", () => {
    expect(rule(".tl-ms-pop[data-more]")).not.toMatch(/mask/);
    expect(css).not.toMatch(/\.tl-ms-pop[^{]*\{[^}]*mask-image/);
  });

  it("fades its last rows into the card's own colour, pinned to its bottom edge", () => {
    const fade = rule(".tl-ms-pop[data-more]::after");
    expect(fade).toMatch(/position:\s*sticky/);
    expect(fade).toMatch(/bottom:/);
    expect(fade).toMatch(/linear-gradient\([^;]*var\(--bg-card\)/);
    expect(fade).toMatch(/pointer-events:\s*none/);
  });
});
