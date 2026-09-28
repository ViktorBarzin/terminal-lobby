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

  // The header is one bar over both views, and its title keeps one face when
  // the view switches under it (the T3 header, 2026-09-27).
  it("heads the session bar in both views", () => {
    expect(decl(sidebarCss, ".tl-session-bar", "font-family")).toBe("var(--font-text)");
    expect(appCss).not.toContain('.tl-session-bar[data-mode="text"]');
  });

  it("draws the new-session screen in the same face, its prompt field too", () => {
    expect(decl(appCss, ".tl-new-view", "font-family")).toBe("var(--font-text)");
    const scoped = rules(appCss)
      .filter((r) => /font-family:\s*var\(--font-text\)/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(scoped).toContain(".tl-new-view .tl-composer-input");
    expect(scoped).toContain(".tl-new-view .tl-composer-mirror");
  });

  it("leaves the lobby in DM Sans", () => {
    expect(decl(appCss, "body", "font-family")).toBe("var(--font-ui)");
  });

  // Three exceptions. The model sheet's phone layer and its desktop popover
  // are drawn into the document's body, because the composer's blurred surface
  // would pin a fixed float to the box (ModelSheet.tsx), so each names the
  // face itself. The
  // session bar heads both views and keeps one face across them. The
  // new-session screen is drawn as the Text view is (prototype 6-new).
  it("is read only under the Text view", () => {
    const allowed = (s: string): boolean =>
      s.startsWith(".tl-textview") ||
      s.startsWith(".tl-new-view") ||
      s === ".tl-session-bar" ||
      s === ".tl-ms-layer" ||
      s === ".tl-ms-pop";
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

/**
 * The cards that take the composer's place (prototype `.card` and `.cd-*`):
 * the same rounded surface as the box, edged in the awaiting colour, with the
 * option rows as bordered rows and a finger-sized row on the phone.
 */
describe("the card in the composer's place", () => {
  it("draws the prototype's surface from theme tokens", () => {
    expect(decl(appCss, ".tl-qcard", "border-radius")).toBe("22px");
    expect(decl(appCss, ".tl-qcard", "border")).toBe(
      "1px solid color-mix(in srgb, var(--state-awaiting) 55%, var(--border-strong))",
    );
    expect(decl(appCss, ".tl-qcard", "background")).toBe("var(--bg-card)");
    expect(decl(appCss, ".tl-qcard", "padding")).toBe("12px 12px 10px");
    expect(decl(appCss, ".tl-qcard-dot", "background")).toBe("var(--state-awaiting)");
  });

  it("draws each option as a bordered row with its keycap first", () => {
    expect(decl(appCss, ".tl-qcard-option", "border-radius")).toBe("12px");
    expect(decl(appCss, ".tl-qcard-option", "border")).toBe("1px solid var(--border)");
    expect(decl(appCss, ".tl-qcard-key", "grid-column")).toBe("1");
    expect(decl(appCss, ".tl-qcard-key", "width")).toBe("22px");
  });

  it("shows an option's whole description, since nothing else can reveal the rest", () => {
    // Found live on 2026-09-27: 25-word descriptions ended in an ellipsis
    // after two lines, and a single-select pick moves on before a chosen row
    // could open.
    expect(decl(appCss, ".tl-qcard-desc", "-webkit-line-clamp")).toBeUndefined();
    expect(decl(appCss, ".tl-qcard-desc", "line-clamp")).toBeUndefined();
    expect(decl(appCss, ".tl-qcard-desc", "overflow")).toBeUndefined();
  });

  it("shows twelve lines of a plan on a desktop, so its steps are in view", () => {
    // Found live on 2026-09-27: six lines held only the plan's Context
    // section, and the steps the reader approves were under the fade.
    expect(decl(appCss, ".tl-plancard-plan", "max-height")).toBe(
      "calc(13px * 1.45 * 12 * var(--tl-text-scale, 1))",
    );
  });

  it("lets the plan give way before the rows it is approved from", () => {
    // Found live on 2026-09-28 at 1280x800: a three-step plan fit the twelve
    // lines, so nothing was clamped and no "Read the full plan" showed, and
    // the card's body scrolled with "Tell Claude what to change" below the
    // fold. The body lays the well and the rows out as a column, the rows
    // keep their height, and the plan shrinks (down to four lines, or its own
    // height when shorter) to what
    // is left, which clamps it and brings the link.
    expect(decl(appCss, ".tl-plancard .tl-qcard-body", "display")).toBe("flex");
    expect(decl(appCss, ".tl-plancard .tl-qcard-body", "flex-direction")).toBe("column");
    expect(decl(appCss, ".tl-plancard-well", "flex")).toBe("0 1 auto");
    expect(decl(appCss, ".tl-plancard-plan", "flex")).toBe("0 1 auto");
    // The formatter breaks the long value over lines inside its parentheses.
    const floor = decl(appCss, ".tl-plancard-well", "--tl-plan-floor")
      ?.replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")");
    expect(floor).toBe(
      "min(calc(13px * 1.45 * 4 * var(--tl-text-scale, 1)), var(--tl-plan-content, 100vh))",
    );
    expect(decl(appCss, ".tl-plancard-plan", "min-height")).toBe("var(--tl-plan-floor)");
    expect(decl(appCss, ".tl-plancard .tl-qcard-options", "flex")).toBe("none");
    // Opened in full, the plan takes its height and the body scrolls.
    expect(decl(appCss, '.tl-plancard-well[data-full="true"]', "flex")).toBe("none");
  });

  it("never lets the well shrink under the plan it holds", () => {
    // Found live on 2026-09-28 on a phone with the keyboard up and "Tell
    // Claude what to change" focused: the body was 182px tall, the well had
    // shrunk to less than the plan's four-line floor, and the plan drew on
    // top of the first option's second line. The well's floor is the plan's
    // plus the well's own padding (10px) and border (1px), top and bottom.
    expect(decl(appCss, ".tl-plancard-well", "min-height")).toBe(
      "calc(var(--tl-plan-floor) + 22px)",
    );
    expect(decl(appCss, ".tl-plancard-well", "padding")).toBe("10px 12px");
    expect(decl(appCss, ".tl-plancard-well", "border")).toBe("1px solid var(--border)");
  });

  it("gives the phone 48px rows and a 16px question", () => {
    expect(appCss).toMatch(/\.tl-qcard-option\s*\{[^}]*min-height:\s*48px/);
    expect(appCss).toMatch(/\.tl-qcard-question\s*\{[^}]*font-size:\s*calc\(16px/);
  });

  it("hides the composer it replaces without unmounting it", () => {
    expect(decl(appCss, ".tl-composer[hidden]", "display")).toBe("none");
  });
});
