/**
 * The T3 pass's reading column: the three derived colours, the system font
 * and the 760px column the conversation and the composer share.
 *
 * docs/plans/2026-09-27-text-view-t3-pass.md, prototype
 * pages/wizard/composer/6-t3.html (`.col` and `.dock-in`). The prototype
 * derives a bubble fill, a field fill and a sparkle colour from each theme's
 * own tokens, so every theme gets them without a value per theme; these tests
 * resolve each one against every theme's declarations, because a token that
 * reads an undefined property renders nothing and warns nobody.
 *
 * The system font belongs to the Text view and only to it. The sidebar and
 * the rest of the lobby keep DM Sans, so every rule that reads --font-text has
 * to sit under `.tl-textview` (or the session bar while it heads a Text view).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES } from "../src/theme/theme";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (f: string): string => strip(readFileSync(resolve(process.cwd(), f), "utf8"));

const themeCss = read("src/theme/theme.css");
const appCss = read("src/app.css");
const sidebarCss = read("src/sidebar.css");

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule, with its selector list split and trimmed. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => s.length > 0);
    out.push({ selectors, body: m[2]! });
  }
  return out;
}

/** The custom properties a declaration block sets, in order. */
function props(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

/** One property's value in the first rule whose selector list is exactly `selector`. */
function decl(css: string, selector: string, property: string): string | undefined {
  const r = rules(css).find((x) => x.selectors.length === 1 && x.selectors[0] === selector);
  if (!r) throw new Error(`no rule for ${selector}`);
  const m = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(r.body);
  return m?.[1]?.trim().replace(/\s+/g, " ");
}

/**
 * Every custom property a `body.theme-<t>` element sees, in cascade order:
 * `:root` and bare `body` first, then any rule naming this theme's body class,
 * which outranks them on specificity.
 */
function envFor(theme: string): Map<string, string> {
  const env = new Map<string, string>();
  const all = rules(themeCss);
  for (const r of all) {
    if (r.selectors.includes(":root") || r.selectors.includes("body")) {
      for (const [k, v] of props(r.body)) env.set(k, v);
    }
  }
  for (const r of all) {
    if (r.selectors.includes(`body.theme-${theme}`)) {
      for (const [k, v] of props(r.body)) env.set(k, v);
    }
  }
  return env;
}

/** Substitute every var() until none is left, or throw naming the missing one. */
function resolveVar(name: string, env: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`${name} is circular`);
  const raw = env.get(name);
  if (raw === undefined) throw new Error(`${name} is undefined`);
  return raw.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g, (_m, inner: string) =>
    resolveVar(inner, env, depth + 1),
  );
}

const PAINTED = THEMES.filter((t) => t !== "system");
const LIGHT = ["ink", "t3-light", "catppuccin-latte"];

describe("the Text view's derived colours", () => {
  it("covers all eight painted themes", () => {
    expect(PAINTED).toHaveLength(8);
  });

  it.each(PAINTED)("resolves --bubble, --field-bg and --sparkle on %s", (theme) => {
    const env = envFor(theme);
    for (const token of ["--bubble", "--field-bg", "--sparkle"]) {
      const value = resolveVar(token, env);
      expect(value, `${token} on ${theme}`).toMatch(/^color-mix\(in srgb, /);
      expect(value, `${token} on ${theme}`).not.toMatch(/var\(/);
    }
  });

  it("derives them the way the prototype does", () => {
    const env = envFor("slate");
    expect(env.get("--bubble")).toBe("color-mix(in srgb, var(--text-primary) 8%, var(--bg-page))");
    expect(env.get("--field-bg")).toBe("color-mix(in srgb, var(--bg-card) 80%, transparent)");
    expect(env.get("--sparkle")).toBe(
      "color-mix(in srgb, var(--terminal-ansi-red) 55%, var(--terminal-ansi-yellow))",
    );
  });

  // 8% of a dark text colour into white is a grey that reads as a panel; the
  // light themes take 6%, as t3-light does in the prototype.
  it.each(PAINTED)("gives %s the bubble weight of its scheme", (theme) => {
    const want = LIGHT.includes(theme) ? "6%" : "8%";
    expect(envFor(theme).get("--bubble")).toContain(` ${want}, `);
  });
});

describe("the system font", () => {
  it("is declared once, as the system stack", () => {
    expect(decl(themeCss, ":root", "--font-text")).toBe(
      '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    );
  });

  it("is the Text view's own face", () => {
    expect(decl(appCss, ".tl-textview", "font-family")).toBe("var(--font-text)");
  });

  it("heads the session bar only while the Text view shows", () => {
    expect(decl(appCss, '.tl-session-bar[data-mode="text"]', "font-family")).toBe(
      "var(--font-text)",
    );
    expect(decl(sidebarCss, ".tl-session-bar", "font-family")).toBeUndefined();
  });

  it("leaves the lobby in DM Sans", () => {
    expect(decl(appCss, "body", "font-family")).toBe("var(--font-ui)");
  });

  // The model sheet's phone layer is the one exception: it is drawn into the
  // document's body, because the composer's blurred surface would pin a fixed
  // sheet to the box (ModelSheet.tsx), so it names the face itself.
  it("is read only under the Text view", () => {
    const allowed = (s: string): boolean =>
      s.startsWith(".tl-textview") ||
      s.startsWith('.tl-session-bar[data-mode="text"]') ||
      s === ".tl-ms-layer";
    const offenders = [appCss, sidebarCss].flatMap((css) =>
      rules(css)
        .filter((r) => /var\(--font-text\)/.test(r.body))
        .flatMap((r) => r.selectors.filter((s) => !allowed(s))),
    );
    expect(offenders).toEqual([]);
  });

  // A rule that names DM Sans on its own beats the view's inherited face, so
  // each one that can render inside the Text view needs the scoped override.
  // The three exempt ones are overlays the session view opens, not the view.
  it("overrides every explicit DM Sans rule that renders inside the view", () => {
    const outside = new Set([
      "body",
      ".tl-gallery-panel",
      ".tl-lightbox-chip",
      ".tl-preview-panel",
    ]);
    const scoped = new Set(
      rules(appCss)
        .filter((r) => /font-family:\s*var\(--font-text\)/.test(r.body))
        .flatMap((r) => r.selectors),
    );
    const missing = rules(appCss)
      .filter((r) => /font-family:\s*var\(--font-ui\)/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((s) => !outside.has(s) && !scoped.has(`.tl-textview ${s}`));
    expect(missing).toEqual([]);
  });

  it("keeps code, commands and tool labels in the mono face", () => {
    expect(decl(appCss, ".tl-code", "font-family")).toMatch(/--font-mono/);
    expect(decl(appCss, ".tl-inline-code", "font-family")).toMatch(/--font-mono/);
    expect(decl(appCss, ".tl-tool-label", "font-family")).toMatch(/monospace/);
  });
});

describe("the prose", () => {
  it("reads at 14px on 22.75px with 18px between rows on a desktop", () => {
    expect(decl(appCss, ".tl-timeline", "font-size")).toBe("calc(14px * var(--tl-text-scale, 1))");
    expect(decl(appCss, ".tl-timeline", "line-height")).toBe("calc(22.75 / 14)");
    expect(decl(appCss, ".tl-timeline", "gap")).toBe("18px");
  });

  it("reads at 15.5px on 24px on a phone", () => {
    const phone = "@media (pointer: coarse) and ((max-width: 720px) or (max-height: 480px))";
    const esc = phone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodies = [...appCss.matchAll(new RegExp(`${esc}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"))].map(
      (m) => m[1]!,
    );
    const inPhone = bodies.join("\n");
    expect(decl(inPhone, ".tl-timeline", "font-size")).toBe(
      "calc(15.5px * var(--tl-text-scale, 1))",
    );
    expect(decl(inPhone, ".tl-timeline", "line-height")).toBe("calc(24 / 15.5)");
  });
});

describe("one 760px column", () => {
  it("caps the timeline's rows at 760px, centred", () => {
    expect(decl(appCss, ".tl-row", "max-width")).toBe("760px");
    expect(decl(appCss, ".tl-row", "margin")).toBe("0 auto");
  });

  it("caps what the dock holds at the same 760px, centred", () => {
    for (const box of [".tl-pillwrap", ".tl-permpanel"]) {
      expect(decl(appCss, box, "max-width"), box).toBe("760px");
      expect(decl(appCss, box, "margin"), box).toMatch(/^0 auto/);
    }
    expect(decl(appCss, ".tl-qcard", "max-width")).toBe("760px");
  });

  it("leaves no 860px column behind", () => {
    expect(appCss).not.toMatch(/\b860px/);
  });
});
