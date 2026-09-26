/**
 * The text view should read as one calm surface, not a pile of competing boxes.
 *
 * Viktor, 2026-08-29: "it doesn't look very aesthetic." Measured what was on
 * screen at 390px rather than guessing:
 *  - Submit was a ghost outline while Send, doing the same thing 100px below,
 *    was solid accent. Two grammars for one act.
 *  - the attach button was the only icon control wearing a 1px box, which made
 *    it read as an empty input rather than a button.
 *  - five border radii in one view: 999px, 10px, 7px, 5px, 4px.
 *  - the field carried a border and the control bar carried none, so the
 *    composer read as a boxed input with loose controls beneath it.
 *
 * NOT changed, and worth recording so nobody "fixes" it later: the mode's
 * colour is SEMANTIC, not decoration. manual is green, plan purple, auto blue,
 * bypass red, red because bypass is the mode that lets everything through.
 * Since the Quiet line composer (2026-09-24) the colour is the mode dial's
 * shield, and bypass turns the whole dial into a hatched danger tab, told
 * apart from Stop by the hatching and by where it sits.
 *
 * The Quiet line also rewrote two of these on purpose. The attach button went
 * behind the pill's `+`, and the "one surface" is the pill: `+`, the field and
 * Send, with the dials on a line of plain type above it rather than a bar
 * inside the box.
 *
 * CSS text, because none of this is behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Comments are stripped first: a rule preceded by one would otherwise have the
// comment text read as part of its selector.
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

describe("one grammar per act", () => {
  it("fills Submit the way Send is filled", () => {
    // The card's commit and the composer's commit sit ~100px apart.
    expect(rule(".tl-qcard-send")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".tl-qcard-send")).toMatch(/color:\s*#fff/);
  });

  it("keeps the walk's own steps secondary", () => {
    // Next and Back move through the walk; only Submit commits. They take the
    // transparent background from the shared rule and must not fill it in.
    expect(rule(".tl-qcard-back,\n.tl-qcard-next,\n.tl-qcard-send")).toMatch(
      /background:\s*transparent/,
    );
    expect(rule(".tl-qcard-next")).not.toMatch(/background:/);
  });
});

describe("icons are icons", () => {
  it("does not put a box round the + or Send; the disc inside is the drawing", () => {
    expect(rule(".tl-plus,\n.tl-send")).toMatch(/border:\s*0/);
  });
});

describe("the composer is one control", () => {
  it("draws +, the field and Send as a single pill", () => {
    const pill = rule(".tl-pill");
    expect(pill).toMatch(/border:\s*1px solid/);
    expect(pill).toMatch(/border-radius:\s*21px/);
  });

  it("leaves the status line as type on the page, with no box of its own", () => {
    const line = rule(".tl-statusline");
    expect(line).not.toMatch(/border/);
    expect(line).not.toMatch(/background/);
  });

  it("takes the border off the field, which the surface now carries", () => {
    expect(rule(".tl-composer-input")).toMatch(/border:\s*0/);
    expect(rule(".tl-composer-input")).toMatch(/background:\s*transparent/);
  });
});

describe("radii agree", () => {
  it("uses the radius token for the card's buttons", () => {
    // They were 7px, a value nothing else in the app uses.
    for (const sel of [".tl-qcard-back,\n.tl-qcard-next,\n.tl-qcard-send"]) {
      expect(rule(sel)).toMatch(/border-radius:\s*var\(--radius\)/);
    }
  });

  it("gives the two micro-elements the same small radius", () => {
    // A 10px radius on an 18px chip looks like a mistake; these two are the
    // only things small enough to want their own, so they should agree.
    expect(rule(".tl-option-key")).toMatch(/border-radius:\s*5px/);
    expect(rule(".tl-qcard-key")).toMatch(/border-radius:\s*5px/);
    expect(rule(".tl-inline-code")).toMatch(/border-radius:\s*5px/);
  });
});
