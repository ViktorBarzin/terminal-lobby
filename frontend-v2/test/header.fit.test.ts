/**
 * The session bar has to FIT on a phone.
 *
 * Reported 2026-08-17: in the terminal view on mobile the header cut items off,
 * worst when acting as another user. Measured at 390px with an act-as chip: the
 * bar's content ran 25px past its right edge (67px once the view switch gained
 * icons), the `[Text|Terminal]` switch was clipped, and the session name — the
 * one thing that says which session you are typing into — was squeezed to 18px.
 *
 * The rules that fix it are keyed on WIDTH, not on pointer type. That distinction
 * is the whole lesson: the first attempt put them in the coarse-pointer block,
 * which left a narrow desktop window worse than before, so these assertions pin
 * the media query as much as the declarations.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The narrow-header block, by its media query. */
const narrowBlock = (): string => {
  const at = css.indexOf("@media (max-width: 520px)");
  expect(at, "the narrow-header media query").toBeGreaterThan(-1);
  // Balance braces from the query's opening brace to find its end.
  const start = css.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i);
    }
  }
  throw new Error("unbalanced narrow-header block");
};

const ruleFor = (block: string, selector: string): string => {
  const at = block.indexOf(selector + " {");
  expect(at, `${selector} in the narrow-header block`).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf("}", at));
};

describe("the narrow session bar", () => {
  it("is keyed on width, not on pointer type", () => {
    // A 500px browser window is as short of room as a phone is.
    expect(css).toContain("@media (max-width: 520px)");
  });

  it("never lets a control paint outside the header", () => {
    expect(ruleFor(narrowBlock(), ".tl-session-bar")).toMatch(/overflow:\s*hidden/);
  });

  it("keeps a readable share for the session name", () => {
    expect(ruleFor(narrowBlock(), ".tl-session")).toMatch(/min-width:\s*5ch/);
  });

  it("drops the view switch to icons, which halves it", () => {
    expect(ruleFor(narrowBlock(), ".tl-viewswitch .tl-seg-label")).toMatch(/display:\s*none/);
  });

  it("hides the terminal tools the soft-key row already carries", () => {
    expect(ruleFor(narrowBlock(), ".tl-term-tools")).toMatch(/display:\s*none/);
  });

  // The touch block sets `.tl-session-bar > * { flex: 0 0 auto }` so a control
  // cannot shrink below its content — right for buttons, wrong for this one,
  // whose username ellipsizes. It has to be the item that gives up width first,
  // and it needs the same selector shape to win.
  it("makes the act-as chip the one item that shrinks", () => {
    const rule = ruleFor(narrowBlock(), ".tl-session-bar > .tl-actas-chip");
    expect(rule).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/max-width:\s*26vw/);
  });
});
