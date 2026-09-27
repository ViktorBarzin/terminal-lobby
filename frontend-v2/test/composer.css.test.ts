/**
 * The T3 composer's stylesheet: the parts that are a decision rather than a
 * measurement (docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * A 50px pill at rest on the phone, a box with a 22px radius when focused and
 * always on a desktop, drawn with the theme's `--field-bg` behind a 14px blur.
 * Bypass and No ask get a danger border and nothing else. The Quiet line's
 * dock edge (a sweep while working, a dashed danger rule) and its status line
 * are gone. Sizes are the prototype's (composer/6-t3.html), measured there as
 * a 108px box on a desktop, a 50px pill on the phone and a 142px focused box.
 *
 * CSS text, because none of this is behaviour a DOM test can see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block of the first rule with exactly this selector. */
function rule(selector: string, within = css): string {
  for (const m of within.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .join("\n");
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

/** The bodies of every `@media <query>` block (each runs to a `}` at column 0). */
function blocks(query: string): string[] {
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`@media ${esc}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"))].map(
    (m) => m[1]!,
  );
}
const coarse = () => blocks("(pointer: coarse)").join("\n");

describe("the dock", () => {
  // The band (a sidebar fill and a top border) made the composer read as a
  // separate panel; the conversation slides under a transparent dock.
  it("draws no band of its own", () => {
    const dock = rule(".tl-composer");
    expect(dock).not.toMatch(/border-top/);
    expect(dock).not.toMatch(/background/);
  });

  it("fades the transcript's foot out under it instead", () => {
    const timeline = rule(".tl-timeline");
    expect(timeline).toMatch(
      /mask-image:\s*linear-gradient\(to bottom, #000 calc\(100% - 26px\), transparent\)/,
    );
    expect(timeline).toMatch(/-webkit-mask-image/);
  });

  // The live state is the conversation's to show now (the live work group).
  it("carries no state edge and no status line", () => {
    expect(css).not.toMatch(/\.tl-composer[^{]*::before/);
    expect(css).not.toMatch(/@keyframes tl-sweep\s*\{/);
    expect(css).not.toMatch(/\.tl-statusline/);
  });

  it("leaves 14px under the box on a desktop and 8px under the pill on a phone", () => {
    expect(rule(".tl-composer")).toMatch(/padding:\s*0 clamp\(12px, 6vw, 80px\) 14px/);
    expect(rule(".tl-composer", coarse())).toMatch(/padding-bottom:\s*8px/);
  });
});

describe("one surface", () => {
  it("is drawn on the field fill, behind a 14px blur, with the surface shadow", () => {
    const s = rule(".tl-pill");
    expect(s).toMatch(/background:\s*var\(--field-bg\)/);
    expect(s).toMatch(/-webkit-backdrop-filter:\s*blur\(14px\)/);
    expect(s).toMatch(/(^|[^-])backdrop-filter:\s*blur\(14px\)/);
    expect(s).toMatch(/box-shadow:\s*var\(--surface-shadow\)/);
    expect(s).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(s).toMatch(/display:\s*grid/);
  });

  it("is a 50px pill with a 25px radius: + | field | round button", () => {
    const pill = rule('.tl-pill[data-shape="pill"]');
    expect(pill).toMatch(/height:\s*50px/);
    expect(pill).toMatch(/border-radius:\s*25px/);
    expect(pill).toMatch(/grid-template-columns:\s*44px minmax\(0, 1fr\) minmax\(46px, auto\)/);
  });

  it("is a box with a 22px radius: the text on top, the controls beneath", () => {
    const box = rule('.tl-pill[data-shape="box"]');
    expect(box).toMatch(/border-radius:\s*22px/);
    expect(box).toMatch(/padding:\s*4px 6px 6px/);
    expect(box).toMatch(/grid-template-areas:\s*"field field field"\s*"plus tools end"/);
  });

  it("turns the box's border to the accent at 55% while focused", () => {
    expect(rule('.tl-pill[data-shape="box"]:focus-within')).toMatch(
      /border-color:\s*color-mix\(in srgb, var\(--accent\) 55%, var\(--border-strong\)\)/,
    );
  });

  it("hides the model slot, the chips and the pictures in the pill", () => {
    const hidden = rule(
      '.tl-pill[data-shape="pill"] .tl-box-tools,\n.tl-pill[data-shape="pill"] .tl-composer-mirror',
    );
    expect(hidden).toMatch(/display:\s*none/);
  });
});

describe("the modes that ask nothing", () => {
  it("turn the border the danger colour, focused or not", () => {
    expect(rule(".tl-pill[data-danger],\n.tl-pill[data-danger]:focus-within")).toMatch(
      /border-color:\s*var\(--danger\)/,
    );
  });

  it("add a 3px danger ring at 18% while focused", () => {
    expect(rule(".tl-pill[data-danger]:focus-within")).toMatch(
      /0 0 0 3px color-mix\(in srgb, var\(--danger\) 18%, transparent\)/,
    );
  });
});

describe("the field", () => {
  // The box is the default shape, so the field's own rules are the box's.
  it("is 14px on 22px in the desktop box, between 60px and 220px", () => {
    const f = rule(".tl-composer-input,\n.tl-composer-mirror");
    expect(f).toMatch(/font-size:\s*calc\(14px \* var\(--tl-text-scale, 1\)\)/);
    expect(f).toMatch(/line-height:\s*calc\(22px \* var\(--tl-text-scale, 1\)\)/);
    expect(f).toMatch(/padding:\s*10px 8px 6px/);
    const input = rule(".tl-composer-input");
    expect(input).toMatch(/min-height:\s*60px/);
    expect(input).toMatch(/max-height:\s*220px/);
  });

  // 16px keeps iOS Safari from zooming the page on focus.
  it("is 16px on 24px on a coarse pointer, between 86px and 148px in the box", () => {
    const within = coarse();
    const size = rule(".tl-composer-input,\n.tl-composer-mirror", within);
    expect(size).toMatch(/font-size:\s*max\(16px, calc\(16px \* var\(--tl-text-scale, 1\)\)\)/);
    expect(within).toMatch(/line-height:\s*max\(24px, calc\(24px \* var\(--tl-text-scale, 1\)\)\)/);
    const input = rule(".tl-composer-input", within);
    expect(input).toMatch(/min-height:\s*86px/);
    expect(input).toMatch(/max-height:\s*148px/);
  });

  // The field fills the pill's height, so a press anywhere across the middle
  // lands in it, and shows one 24px line of it.
  it("is one line in the pill, cut rather than wrapped", () => {
    const f = rule('.tl-pill[data-shape="pill"] .tl-composer-input');
    expect(f).toMatch(/height:\s*48px/);
    expect(f).toMatch(/padding:\s*12px 4px/);
    expect(f).toMatch(/white-space:\s*pre/);
    expect(f).toMatch(/overflow:\s*hidden/);
    const draft = rule(".tl-pill-draft");
    expect(draft).toMatch(/text-overflow:\s*ellipsis/);
    expect(draft).toMatch(/white-space:\s*nowrap/);
    expect(draft).toMatch(/pointer-events:\s*none/);
  });
});

describe("a coarse pointer", () => {
  it("makes + and the round button 44px targets round a 32px disc", () => {
    expect(rule(".tl-plus,\n.tl-send", coarse())).toMatch(/width:\s*44px[\s\S]*height:\s*44px/);
    expect(rule(".tl-disc")).toMatch(/width:\s*32px/);
    expect(() => rule(".tl-disc", coarse())).toThrow();
  });
});

describe("a watching device", () => {
  it("draws only the watch row in the pill", () => {
    expect(rule(".tl-pill[data-watch] > :not(.tl-watch)")).toMatch(/display:\s*none/);
    expect(rule(".tl-pill[data-watch]")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe("a reader who asked for less motion", () => {
  it("gets no transition on the surface", () => {
    const reduced = blocks("(prefers-reduced-motion: reduce)").join("\n");
    expect(reduced).toMatch(/\.tl-pill\s*\{[^}]*transition:\s*none/);
  });
});

describe("no container queries", () => {
  // Safari 15.6 is the oldest engine served and has none.
  it("uses none", () => {
    expect(css).not.toMatch(/@container/);
  });
});

describe("the new-session line", () => {
  // The dials sit right-aligned with nothing on their left, as the live
  // composer's do; left-aligned they would read as a sentence (open point 8).
  it("right-aligns its dials, and is what their popover hangs from", () => {
    const line = rule(".tl-new-line");
    expect(line).toMatch(/justify-content:\s*flex-end/);
    expect(line).toMatch(/position:\s*relative/);
  });
});
