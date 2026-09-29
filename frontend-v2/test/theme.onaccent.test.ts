/**
 * What is drawn ON the accent: Send's arrow, the question card's Submit and
 * chosen keycap, the preview toggle.
 *
 * It was white in every theme, and in Mono the accent is #e8e8e8, so the Send
 * arrow was all but invisible (deployed review rounds 3 to 5, 2026-09-28).
 * Each theme now says what reads on its accent (--on-accent), and every theme
 * clears 3:1, the WCAG floor for an icon.
 *
 * CSS text, because none of this is behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const theme = readFileSync(resolve(process.cwd(), "src/theme/theme.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const app = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const THEMES = [
  "carbon",
  "slate",
  "mono",
  "ink",
  "t3-dark",
  "t3-light",
  "catppuccin-mocha",
  "catppuccin-latte",
];

/** The declarations the theme's own block sets. */
function block(name: string): string {
  const m = new RegExp(`body\\.theme-${name},[^{]*\\{([^}]*)\\}`).exec(theme);
  if (!m) throw new Error(`no block for ${name}`);
  return m[1]!;
}

function token(decls: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(decls)?.[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const rootOnAccent = /:root\s*\{[^}]*--on-accent:\s*(#[0-9a-fA-F]{6})/.exec(theme)?.[1];

describe("what is drawn on the accent", () => {
  it("has a default", () => {
    expect(rootOnAccent).toBeDefined();
  });

  for (const name of THEMES) {
    it(`reads at 3:1 or better on ${name}'s accent`, () => {
      const decls = block(name);
      const accent = token(decls, "accent")!;
      const on = token(decls, "on-accent") ?? rootOnAccent!;
      expect(contrast(accent, on)).toBeGreaterThanOrEqual(3);
    });
  }

  it("is what every filled accent control draws with", () => {
    for (const sel of [
      ".tl-send .tl-disc",
      ".tl-qcard-send",
      ".tl-preview-toggle button.on",
      '.tl-qcard-option[data-chosen="true"] .tl-qcard-key',
    ]) {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rules = [...app.matchAll(new RegExp(`(?:^|\\})\\s*${esc} \\{([^}]*)\\}`, "g"))].map(
        (m) => m[1]!,
      );
      expect(rules.join(" "), sel).toMatch(/color:\s*var\(--on-accent\)/);
      expect(rules.join(" "), sel).not.toMatch(/color:\s*#fff/);
    }
  });
});
