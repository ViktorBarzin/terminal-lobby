/**
 * Toasts sit under the session bar, not on it.
 *
 * The stack was pinned 12px from the top-right corner, which is where the
 * session bar keeps its icon group: a toast covered the Terminal button,
 * including the toast that tells you to press it (deployed review rounds 3 to
 * 5, 2026-09-28). On a desktop the bar (56px) sits under the lobby's 42px
 * top bar, on the phone it is 58px under the safe area, so the stack starts
 * below the lower of the two.
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

describe("the toast stack", () => {
  it("starts below the session bar and the safe area", () => {
    const rule = /\n\.tl-toaster \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const top = /top:\s*([^;]+);/.exec(rule)?.[1] ?? "";
    expect(top).toContain("env(safe-area-inset-top");
    const px = Number(/(\d+)px\s*\)?\s*$/.exec(top)?.[1] ?? 0);
    expect(px).toBeGreaterThanOrEqual(42 + 56 + 6);
  });
});
