/**
 * Every custom property this app reads has to exist.
 *
 * `--fg-muted` did not. It was read 29 times in app.css, never with a fallback,
 * and no `--fg-*` token is defined anywhere — the theme layer ships
 * `--text-muted`. A `var()` reference to an undefined property with no fallback
 * is invalid at computed-value time, so `color` fell back to INHERIT and every
 * one of those 29 places rendered at full foreground weight.
 *
 * That was not a question-card bug, which is where it was noticed. It covered
 * thinking blocks, tool names and details, diff hunks, todo counts, plan state,
 * meta rows, working steps, the queued chip, the mode chip, the context meter
 * and the find bar — the whole text view had no secondary text tier, and read as
 * a wall of one colour.
 *
 * A typo in a token name is invisible: nothing errors, nothing warns, the text
 * simply renders in the wrong colour. So it is asserted here instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = ["src/app.css", "src/sidebar.css", "src/theme/theme.css"] as const;
const css = FILES.map((f) => readFileSync(resolve(process.cwd(), f), "utf8"));
const all = css.join("\n");

/**
 * Set from JavaScript at runtime rather than declared in a stylesheet:
 * mobile/viewport.ts publishes the first three, and index.html seeds --app-vh
 * before first paint. They are legitimately absent from the CSS.
 */
const SET_BY_JS = new Set(["--kb-offset", "--sk-h", "--app-vh"]);

/** Every `--name:` declaration across the stylesheets. */
function defined(): Set<string> {
  const out = new Set<string>(SET_BY_JS);
  for (const m of all.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1]!);
  return out;
}

/** Every `var(--name)` read with NO fallback, and where it is. */
function readWithoutFallback(): { token: string; file: string; line: number }[] {
  const out: { token: string; file: string; line: number }[] = [];
  css.forEach((text, i) => {
    text.split("\n").forEach((line, n) => {
      for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
        out.push({ token: m[1]!, file: FILES[i]!, line: n + 1 });
      }
    });
  });
  return out;
}

describe("CSS custom properties", () => {
  it("finds tokens to check", () => {
    expect(defined().size).toBeGreaterThan(20);
    expect(readWithoutFallback().length).toBeGreaterThan(20);
  });

  it("never reads a token that is not defined anywhere", () => {
    const known = defined();
    const missing = readWithoutFallback().filter((r) => !known.has(r.token));
    // The message names the site, so a failure says which line to fix rather
    // than only that something is wrong.
    expect(
      missing.map((r) => `${r.file}:${r.line} reads ${r.token}`),
      "undefined custom properties (a var() with no fallback silently inherits)",
    ).toEqual([]);
  });

  it("still defines the muted text tier the text view reads", () => {
    // The specific regression: the whole text view lost its secondary tier.
    expect(all).toMatch(/--text-muted\s*:/);
    expect(all).not.toMatch(/--fg-muted/);
  });
});
