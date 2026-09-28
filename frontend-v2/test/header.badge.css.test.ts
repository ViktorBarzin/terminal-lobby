/**
 * The header's subtitle carries one dot: the session's state.
 *
 * Found in the T3 pass's live check on 2026-09-28: "● waiting for you ●", the
 * second a green connection badge (ADR-0016) saying all is well. The
 * prototype's subtitle has one dot. The badge stays on that line and speaks
 * when a channel is degraded or down; while everything works, or nothing has
 * reported yet, it is not drawn there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function bodyOf(selectorList: string): string | undefined {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selectorList)) return m[2];
  }
  return undefined;
}

describe("the header's connection badge", () => {
  it.each(["working", "unknown"])("is not drawn while it would say %s", (state) => {
    const body = bodyOf(`.tl-bar-sub .tl-conn-badge[data-status="${state}"]`);
    expect(body).toMatch(/display:\s*none/);
  });

  it("is drawn when something is wrong", () => {
    for (const state of ["degraded", "down"]) {
      expect(bodyOf(`.tl-bar-sub .tl-conn-badge[data-status="${state}"]`)).toBeUndefined();
    }
  });
});
