/**
 * The Browser panel's layout rules (design 2026-10-01, "The Browser panel").
 * jsdom does no layout, so these guard the declarations the geometry rests on.
 *
 * A dialog the page raised is drawn in its own layer, and that layer covered
 * the whole panel: Stop, Hand back and close sat under it and could not be
 * pressed while the page waited on an answer (review 2026-10-01). The layer is
 * now laid over the page's own box, which has to be its containing block.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const rule = (selector: string): string => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .join("\n");
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
};

describe("the page's box", () => {
  it("is what the popups are laid over, and fills the panel under its bars", () => {
    const box = rule(".tl-browser-pagebox");
    expect(box).toMatch(/position:\s*relative/);
    expect(box).toMatch(/flex:\s*1 1 auto/);
    expect(box).toMatch(/min-height:\s*0/);
  });

  it("lets the stage fill it", () => {
    expect(rule(".tl-browser-pagebox")).toMatch(/flex-direction:\s*column/);
    expect(rule(".tl-browser-stage")).toMatch(/flex:\s*1 1 auto/);
  });
});

describe("the panel over a narrow pane", () => {
  it("covers the pane instead of taking its right side", () => {
    const full = rule(".tl-browser-panel[data-full]");
    expect(full).toMatch(/left:\s*0/);
    expect(full).toMatch(/width:\s*auto/);
  });
});

describe("the page's focus ring", () => {
  // A watcher's keys are dropped, so a ring on its stage would promise typing
  // that cannot happen (review 2026-10-01).
  it("is drawn only for the viewer in control", () => {
    expect(rule(".tl-browser-stage[data-control]:focus-visible")).toMatch(/box-shadow/);
    expect(() => rule(".tl-browser-stage:focus-visible")).toThrow();
  });
});

/**
 * The Browser cursor (Viktor, 2026-10-02). jsdom runs no transitions, so these
 * pin the declarations the glide, the ring and the reduced-motion fallback
 * rest on.
 */
describe("the cursor", () => {
  const rawCss = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  const reduced = (): string => {
    const blocks = rawCss.split("@media (prefers-reduced-motion: reduce)").slice(1);
    const mine = blocks.find((b) => b.slice(0, b.indexOf("\n}")).includes(".tl-browser-cursor"));
    if (!mine) throw new Error("no reduced-motion block for the cursor");
    return mine.slice(0, mine.indexOf("\n}"));
  };

  it("is laid over the picture and never takes a press", () => {
    expect(rule(".tl-browser-canvas")).toMatch(/position:\s*relative/);
    const layer = rule(".tl-browser-cursor-layer");
    expect(layer).toMatch(/position:\s*absolute/);
    expect(layer).toMatch(/inset:\s*0/);
    expect(layer).toMatch(/pointer-events:\s*none/);
  });

  it("glides with a short ease-out, only when told to", () => {
    expect(rule(".tl-browser-cursor")).not.toMatch(/transition/);
    const glide = rule(".tl-browser-cursor[data-glide]");
    const ms = Number(/transition:\s*transform\s+(\d+)ms\s+ease-out/.exec(glide)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(180);
  });

  it("rings where a press lands", () => {
    expect(rule(".tl-browser-ripple")).toMatch(/animation:\s*tl-browser-ripple\s/);
    expect(rawCss).toMatch(/@keyframes tl-browser-ripple\s*\{/);
  });

  it("jumps instead of gliding with reduced motion, and still rings briefly", () => {
    const block = reduced();
    expect(block).toMatch(/\.tl-browser-cursor\[data-glide\]\s*\{[^}]*transition:\s*none/);
    expect(block).toMatch(/\.tl-browser-ripple\s*\{[^}]*animation:\s*tl-browser-ripple-still\s/);
    expect(rawCss).toMatch(/@keyframes tl-browser-ripple-still\s*\{/);
  });
});

describe("the real pointer of the person in control", () => {
  // The drawn cursor follows their mouse at once, so the real pointer over the
  // page would be a second cursor (Viktor, 2026-10-02).
  it("is hidden over the page while the drawn cursor follows it", () => {
    expect(rule(".tl-browser-stage[data-own-cursor]")).toMatch(/cursor:\s*none/);
  });
});
