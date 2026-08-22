/**
 * A press-and-hold on a session row opens the row's actions menu, and that is
 * ALL it should do.
 *
 * Reported 2026-08-22 (Viktor): "touch and hold a session selects the text as
 * well as opening the context menu. let's keep only the context menu". The row
 * carries a name, a state and a time, all of them plain text in a div, so the
 * platform's own long-press behaviour — select the word, raise the callout —
 * runs alongside ours and leaves selection handles over the list.
 *
 * The guard has to be STATIC CSS. iOS decides who owns a long press before any
 * JS runs, so setting `user-select` at pointerdown, or when the hold timer
 * fires, is already too late (learned in the tasks PWA, 2026-07-03).
 *
 * Asserted against the stylesheet rather than a rendered row because jsdom has
 * no selection controller and headless Chromium has no touch callout: the
 * property IS the behaviour here, and nothing below it can be observed in a
 * test environment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The body of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

describe("a session row is not text to select", () => {
  const card = ruleBody(".tl-card");

  it("refuses the platform's own selection on the row", () => {
    expect(card).toMatch(/(^|[\s;])user-select:\s*none/);
    expect(card).toMatch(/-webkit-user-select:\s*none/);
  });

  it("refuses the callout too, which is the other half on iOS", () => {
    expect(card).toMatch(/-webkit-touch-callout:\s*none/);
  });

  // Selection is refused on the ROW, and the row contains the rename box while
  // a session is being renamed. An input you cannot select inside is worse than
  // the problem this fixes.
  it("gives selection back to the rename box inside it", () => {
    const rename = ruleBody(".tl-card-rename");
    expect(rename).toMatch(/(^|[\s;])user-select:\s*text/);
    expect(rename).toMatch(/-webkit-user-select:\s*text/);
  });

  // The horizontal drag stays this row's; the vertical one is the list's.
  it("still hands vertical scrolling to the browser", () => {
    expect(card).toMatch(/touch-action:\s*pan-y/);
  });
});
