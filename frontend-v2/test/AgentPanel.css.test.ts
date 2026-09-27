/**
 * The agent panel's stylesheet rules that markup alone cannot show.
 *
 * Anything that ticks sits in a fixed-width cell (`.tl-agents-elapsed`,
 * `min-width: 6ch`), right-aligned so an agent's elapsed lines up with the
 * counts under it. A running phase is the one place the figure follows words:
 * "3 running · 15s". Right-aligned there, a figure under a minute left three
 * blank characters inside the phrase, "3 running ·    15s", seen live at 1440px
 * and at 400px on 2026-09-24.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

/** The body of the one rule with exactly this selector, or "" without it. */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  return "";
}

describe("the agent panel's ticking cells", () => {
  it("keeps every elapsed figure in a fixed-width cell", () => {
    expect(rule(".tl-agents-elapsed")).toMatch(/min-width:\s*6ch/);
  });

  it("starts a running phase's elapsed at the left of its cell, against its words", () => {
    expect(rule(".tl-agents-phase-status .tl-agents-elapsed")).toMatch(/text-align:\s*left/);
  });
});

describe("the agent colours", () => {
  // The drill-in's header draws the same spine as the panel entry, from the
  // same tokens. Scoped to the panel alone, `var(--tl-agent-green)` resolved
  // to nothing there and the header's spine fell back to plain grey.
  it("reach the drill-in's header as well as the panel", () => {
    expect(rule(".tl-drill")).toMatch(/--tl-agent-green:/);
    expect(rule(".tl-drill")).toMatch(/--tl-agent-none:/);
  });
});

describe("the panel's type", () => {
  // Viktor, 2026-09-27: the rail's text "looks weird and is difficult to
  // read". It was 10–10.5px, a third of it monospace, and every heading
  // uppercased and letter-spaced. The rail now reads in the transcript's own
  // face at 12px and up; the one monospace line left is a workflow's id,
  // which is a handle rather than words.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1]!.trim().split("\n").pop()!.trim(), body: m[2]! }))
    .filter((r) => /\.tl-agents?\b|\.tl-agents?-/.test(r.sel));

  it("finds the panel's rules", () => {
    expect(rules.length).toBeGreaterThan(30);
  });

  it.each(rules.filter((r) => /font-size:/.test(r.body)).map((r) => [r.sel, r.body]))(
    "sets %s at 12px or larger",
    (_sel, body) => {
      const px = Number(/font-size:\s*calc\(([\d.]+)px/.exec(body)?.[1]);
      expect(px).toBeGreaterThanOrEqual(12);
    },
  );

  it("uppercases nothing", () => {
    expect(rules.filter((r) => /text-transform:\s*uppercase/.test(r.body)).map((r) => r.sel)).toEqual([]);
  });

  it("keeps monospace for the workflow id alone", () => {
    expect(rules.filter((r) => /font-family:[^;]*mono/.test(r.body)).map((r) => r.sel)).toEqual([
      '.tl-agents-run-title[data-id="true"]',
    ]);
  });
});
