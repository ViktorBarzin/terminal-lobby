import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Layout rules for the Data used breakdown that a component test cannot reach:
 * jsdom does no layout, so the only place these can be pinned is the stylesheet
 * itself.
 *
 * Measured in a real browser at 390px on 2026-08-30: one operator name
 * ("_Uzbektelekom_ Joint Stock Company (UZ)") sized the name column to 242px
 * and pushed the figure and its bar 27px outside the panel. Both rules below
 * are what put it back, and either one alone is not enough.
 */
const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

/** The body of one rule, by selector. */
function rule(selector: string): string {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(i, css.indexOf("}", i));
}

describe("the Data used breakdown stays inside its panel", () => {
  it("lets the name column shrink below its content", () => {
    // A bare `auto` track is floored at min-content, and the min-content of a
    // label is the whole label — which is how one long operator name pushed
    // the row out of the panel.
    const cols = /grid-template-columns:\s*([^;]+);/.exec(rule(".tl-netusage-breakdown"))?.[1];
    expect(cols, "the breakdown's columns").toBeDefined();
    expect(cols).toMatch(/minmax\(\s*0\s*,/);
    expect(cols, "a bare auto first track re-floors the column").not.toMatch(/^\s*auto\b/);
  });

  it("wraps a long network name rather than holding it on one line", () => {
    const name = rule(".tl-netusage-name");
    // `nowrap` is what made the min-content width the whole string.
    expect(name).not.toMatch(/white-space:\s*nowrap/);
    // Only `anywhere` lowers the intrinsic min-content width; `break-word`
    // would wrap the text and still leave the grid track too wide.
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
    expect(name).toMatch(/min-width:\s*0/);
  });

  it("keeps the figure itself on one line", () => {
    // Wrapping a byte count across two lines would be worse than the bug.
    expect(rule(".tl-netusage-bytes")).toMatch(/white-space:\s*nowrap/);
  });

  it("never truncates the network you are on", () => {
    const netname = rule(".tl-netusage-netname");
    expect(netname).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(netname).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
