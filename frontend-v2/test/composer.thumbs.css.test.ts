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
  // Measured on the Android emulator's Chrome on 2026-09-27 (412x783 CSS):
  // while a picture sat INSIDE a line of text, every line of the message took
  // the picture's height, since a textarea has one line height for all of
  // them, and a four-line message scrolled the 200px field until the picture
  // was cut off at the top. The pictures now sit in a row above the text.
  it("keeps the text at its own line height while a picture is attached", () => {
    for (const sel of [
      ".tl-field[data-thumbs] .tl-composer-input",
      ".tl-field[data-thumbs] .tl-composer-mirror",
    ]) {
      const r = rule(sel);
      expect(r).not.toMatch(/line-height/);
      expect(r).toMatch(/padding-top:\s*calc\(var\(--tl-thumb-h\)/);
    }
  });

  it("draws the pictures in a row in that room, above the field", () => {
    const strip = rule(".tl-thumb-strip");
    expect(strip).toMatch(/position:\s*absolute/);
    expect(strip).toMatch(/display:\s*flex/);
    const zoom = rule(".tl-inline-zoom");
    expect(zoom).not.toMatch(/position:\s*absolute/);
    expect(zoom).toMatch(/height:\s*var\(--tl-thumb-h\)/);
    expect(zoom).toMatch(/z-index:\s*\d+/);
    // The mirror takes no clicks; the picture has to ask for them back, or it
    // cannot be opened full size.
    expect(zoom).toMatch(/pointer-events:\s*auto/);
  });

  it("draws the whole picture at its own shape rather than a crop of it", () => {
    const thumb = rule(".tl-inline-thumb");
    expect(thumb).toMatch(/height:\s*100%/);
    expect(thumb).toMatch(/width:\s*auto/);
  });

  it("sizes the picture in the stylesheet, not from script", () => {
    expect(rule(".tl-field")).toMatch(/--tl-thumb-h:\s*\d+px/);
    expect(field).not.toContain('"--tl-thumb-');
  });
});
