/**
 * The transcript never pans sideways.
 *
 * Reported 2026-08-29: "in text mode I still see cases where I can scroll
 * horizontally — all text must fit in the viewer's width."
 *
 * The cause was not a rule anyone wrote. `.tl-timeline` declared `overflow-y:
 * auto` and nothing about the x axis, and CSS turns a `visible` axis into
 * `auto` when its partner is not visible — so the transcript was a horizontal
 * scroller by default, waiting for one row to be wider than the screen. One
 * was: a `queued` meta row carries the whole prompt, `.tl-meta-text` was
 * `flex: none`, and a prompt holding an unbroken token (a socket path) grew the
 * row to a measured 12,190px inside a 343px column. Every row then panned with
 * it, because the scroller is the timeline, not the row.
 *
 * Two rules keep it fixed and they are a pair — asserted here as CSS text
 * because what they prevent needs real layout, which jsdom does not have (same
 * reasoning as document-containment.test.ts):
 *
 *   - the timeline says `overflow-x: hidden`, so no row can ever make the
 *     reader's viewport pannable again;
 *   - content that does not fit wraps or scrolls INSIDE its own box, so the
 *     guard above never has to clip anything.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

/** The declaration block of the first top-level rule with this exact selector. */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

describe("the transcript cannot be panned sideways", () => {
  it("spells out overflow-x on the timeline", () => {
    // Without this the axis is `auto` by inheritance from `overflow-y`, and a
    // single over-wide row turns the whole transcript into a canvas.
    expect(rule(".tl-timeline")).toMatch(/overflow-x:\s*hidden/);
  });

  it("still scrolls vertically", () => {
    // The guard must not cost the transcript its own scroll.
    expect(rule(".tl-timeline")).toMatch(/overflow-y:\s*auto/);
  });
});

describe("what does not fit is wrapped or scrolled in its own box", () => {
  it("lets a meta row's text shrink instead of widening the row", () => {
    // `flex: none` is what let a queued prompt set the transcript's width.
    const meta = rule(".tl-meta-text");
    expect(meta).not.toMatch(/flex:\s*none/);
    expect(meta).toMatch(/min-width:\s*0/);
  });

  it("breaks an unbroken token in a meta row", () => {
    // A queued prompt can be one long path with nothing to break at.
    expect(rule(".tl-meta-text")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("clamps a meta row rather than letting a whole prompt fill the screen", () => {
    // Wrapping alone turns "queued · <prompt>" into 35 lines of grey text; the
    // row is a marker, and the prompt arrives as its own row anyway.
    const meta = rule(".tl-meta-text");
    expect(meta).toMatch(/-webkit-line-clamp:\s*3/);
    expect(meta).toMatch(/overflow:\s*hidden/);
  });

  it("breaks long tokens in rendered markdown", () => {
    // Prose is the other place a bare URL can be wider than a phone.
    expect(rule(".tl-markdown")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it.each([
    [".tl-code", "code blocks"],
    [".tl-markdown table", "markdown tables"],
    [".tl-mermaid", "diagrams"],
    [".tl-diff", "diffs"],
  ])("keeps %s scrolling inside itself (%s)", (selector) => {
    // These genuinely cannot wrap. They scroll in their OWN box, which is
    // contained — that is the difference between panning a code block and
    // panning the transcript it sits in.
    expect(rule(selector)).toMatch(/overflow-x:\s*auto|overflow:\s*auto/);
  });
});
