/**
 * The card head on a phone.
 *
 * At 390px the head cut to "Claude wants to use a t… · C…" beside "Open in
 * Terminal" and "Take control": the links kept their room and the words gave
 * all of theirs (deployed review rounds 3 to 5, 2026-09-28). The links now
 * move to a line of their own, at the right, when the words cannot fit in
 * full beside them.
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

  // Deployed review round 1 of the T3 pass (2026-09-29): with a 16em floor
  // the links still fitted beside the words at 390px (192px + 101px < 336px)
  // while the words needed about 260px, so "Claude wants to use a t… · C…"
  // came back. The words now ask for their whole width before the links
  // share their line.
  it("lets the links share the line only when the words fit in full beside them", () => {
    expect(css).toMatch(/\.tl-qcard-lead,\s*\n\.tl-qcard-fold \{[^}]*flex:\s*1 1 auto/);
  });

  // A folded question card's head also holds the question as a one-line
  // reminder, which is meant to be cut; it keeps the floor, or a long
  // question would push the links onto a line of their own every time.
  it("keeps the floor for a folded question's reminder", () => {
    expect(css).toMatch(/\.tl-qcard-fold:has\(\.tl-qcard-peek\) \{[^}]*flex-basis:\s*16em/);
  });
});
