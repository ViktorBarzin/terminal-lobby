/**
 * The card head on a phone.
 *
 * At 390px the head cut to "Claude wants to use a t… · C…" beside "Open in
 * Terminal" and "Take control": the links kept their room and the words gave
 * all of theirs (deployed review rounds 3 to 5, 2026-09-28). The words now
 * keep room for about sixteen characters' worth of width at least, and the
 * links move to a line of their own, at the right, when both cannot fit.
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

describe("the card head", () => {
  it("wraps rather than squeezing the words to nothing", () => {
    expect(rule(".tl-qcard-head")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("gives the words a floor before the links wrap", () => {
    expect(css).toMatch(/\.tl-qcard-lead,\s*\n\.tl-qcard-fold \{[^}]*flex:\s*1 1 16em/);
  });
});
