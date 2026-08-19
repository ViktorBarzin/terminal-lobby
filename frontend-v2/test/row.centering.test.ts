/**
 * Every timeline row sits in the SAME column.
 *
 * `.tl-row` is `max-width: 860px; width: 100%; margin: 0 auto` — the auto side
 * margins are what centre a row in a timeline wider than 860px. A row type that
 * wants breathing room above and below reaches for `margin: 8px 0`, which is the
 * shorthand: it resets the side margins to 0 and the row drops out of the column
 * to the timeline's left edge.
 *
 * Reported 2026-08-19 against the question card, and measured at 1440px: the
 * question row rendered at x=340 while every tool row beside it sat at x=420 —
 * 80px out, the timeline's own right padding. Four other row types (thinking,
 * todo, plan, meta) had the same shorthand and the same 80px offset; the
 * question card is simply the one with a border around it, so it is the one that
 * looks wrong.
 *
 * `margin-block` is the fix and the rule: it says "vertical only" and leaves the
 * centring alone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

interface Rule {
  selector: string;
  body: string;
  line: number;
}

/** Every top-level rule whose selector mentions a `.tl-row-*` row type. */
function rowRules(): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().split("\n").pop()!.trim();
    if (!selector.includes(".tl-row-")) continue;
    out.push({
      selector,
      body: m[2]!,
      line: css.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** The `margin: …` shorthand a rule sets, if it sets one. */
function marginShorthand(body: string): string | null {
  const m = /(?:^|[;{\s])margin\s*:\s*([^;]+);/.exec(body);
  return m ? m[1]!.trim() : null;
}

describe("timeline rows keep their column", () => {
  it("has rows centred by auto side margins", () => {
    const base = /\.tl-row\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(base).toMatch(/margin:\s*0\s+auto/);
    expect(base).toMatch(/max-width:\s*860px/);
  });

  it("never lets a row type cancel them with the margin shorthand", () => {
    const offenders = rowRules()
      .map((r) => ({ ...r, margin: marginShorthand(r.body) }))
      .filter((r) => r.margin !== null && !/\bauto\b/.test(r.margin!))
      .map((r) => `${r.selector} (app.css:${r.line}) sets margin: ${r.margin}`);
    // A row type wanting vertical rhythm uses `margin-block`, which leaves the
    // inline margins — and so the centring — where `.tl-row` put them.
    expect(offenders).toEqual([]);
  });

  it("gives the row types that want vertical rhythm a margin-block", () => {
    for (const selector of [
      ".tl-row-thinking",
      ".tl-row-todo",
      ".tl-row-question",
      ".tl-row-plan",
      ".tl-row-meta",
    ]) {
      const rule = rowRules().find((r) => r.selector === selector);
      expect(rule, `${selector} in app.css`).toBeTruthy();
      expect(rule!.body, selector).toMatch(/margin-block:\s*\d/);
    }
  });
});
