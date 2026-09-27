/**
 * An attached picture is drawn as the picture, in the field.
 *
 * PromptField renders a copy of the draft behind the textarea, with a
 * `.tl-inline-chip` behind each attachment token and, for an image, a
 * `.tl-inline-zoom` button holding a `.tl-inline-thumb` painted over the
 * token's characters. What makes that a thumbnail rather than a raw `[img   ]`
 * token with a full-size image spilling out under it is entirely CSS.
 *
 * The Quiet line rewrite of app.css (826896e4) dropped these rules while
 * PromptField kept emitting the markup. Measured on the branch build on
 * 2026-09-26: after "Add a photo" the field showed the bare token, a 192x192
 * icon drew at its natural size under the text, and a 1600x1200 photo drew as a
 * thin strip clipped by the 42px pill. `Composer.thumbs.test` runs in jsdom,
 * which never reads the stylesheet, so it could not see any of that.
 *
 * jsdom does no layout, so this guards the declarations rather than the
 * geometry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const app = strip(readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"));
const field = readFileSync(resolve(process.cwd(), "src/components/PromptField.tsx"), "utf8");

const rule = (selector: string): string => {
  const found: string[] = [];
  for (const m of app.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) found.push(m[2]!);
  }
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.join("\n");
};

describe("the chip layer's markup still matches its stylesheet", () => {
  it.each(["tl-inline-chip", "tl-inline-zoom", "tl-inline-thumb"])(
    "PromptField emits .%s and app.css styles it",
    (cls) => {
      expect(field).toContain(`class="${cls}"`);
      expect(() => rule(`.${cls}`)).not.toThrow();
    },
  );
});

describe("an attached image in the composer", () => {
  it("drops the pill behind a token that carries a picture", () => {
    const chip = rule('.tl-inline-chip[data-thumb]');
    expect(chip).toMatch(/position:\s*relative/);
    expect(chip).toMatch(/background:\s*none/);
  });

  it("covers the whole token with a box the thumbnail height, above the field", () => {
    const zoom = rule(".tl-inline-zoom");
    expect(zoom).toMatch(/position:\s*absolute/);
    expect(zoom).toMatch(/width:\s*100%/);
    expect(zoom).toMatch(/height:\s*var\(--tl-thumb-h\)/);
    expect(zoom).toMatch(/z-index:\s*\d+/);
    // The mirror takes no clicks; the picture has to ask for them back, or it
    // cannot be opened full size.
    expect(zoom).toMatch(/pointer-events:\s*auto/);
  });

  it("scales the picture into that box instead of drawing it at its natural size", () => {
    const thumb = rule(".tl-inline-thumb");
    expect(thumb).toMatch(/width:\s*100%/);
    expect(thumb).toMatch(/height:\s*100%/);
    expect(thumb).toMatch(/object-fit:\s*cover/);
  });

  it("grows the line in the field and in the copy behind it alike", () => {
    for (const sel of [
      ".tl-field[data-thumbs] .tl-composer-input",
      ".tl-field[data-thumbs] .tl-composer-mirror",
    ]) {
      expect(rule(sel)).toMatch(/line-height:\s*var\(--tl-thumb-line\)/);
    }
  });
});
