/**
 * The Browser panel's layout rules (design 2026-10-01, "The Browser panel").
 * jsdom does no layout, so these guard the declarations the geometry rests on.
 *
 * A dialog the page raised is drawn in its own layer, and that layer covered
 * the whole panel: Stop, Hand back and close sat under it and could not be
 * pressed while the page waited on an answer (review 2026-10-01). The layer is
 * now laid over the page's own box, which has to be its containing block.
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
    const sel = m[1]!
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .join("\n");
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("the page's box", () => {
  it("is what the popups are laid over, and fills the panel under its bars", () => {
    const box = rule(".tl-browser-pagebox");
    expect(box).toMatch(/position:\s*relative/);
    expect(box).toMatch(/flex:\s*1 1 auto/);
    expect(box).toMatch(/min-height:\s*0/);
  });

  it("lets the stage fill it", () => {
    expect(rule(".tl-browser-pagebox")).toMatch(/flex-direction:\s*column/);
    expect(rule(".tl-browser-stage")).toMatch(/flex:\s*1 1 auto/);
  });
});
