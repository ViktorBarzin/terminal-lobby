/**
 * Every text field a phone can focus is at least 16px on a coarse pointer.
 *
 * Reported 2026-09-26 (Viktor): "in text mode, when answering questions when I
 * choose the free text on mobile, I get zoomed and the experience is very bad".
 * iOS Safari zooms the whole page when a field under 16px takes focus and
 * leaves it zoomed after blur. The question card's free-text field was 13px,
 * and the command palette's search field (search in the text view opens from
 * it) was 15px.
 *
 * The override has to come AFTER the field's own rule: both have one class of
 * specificity, so a coarse block placed earlier in the file loses to the base
 * size and the test would pass on a field that still zooms.
 *
 * Asserted against the stylesheet because the zoom is Safari's own: no test
 * browser here reproduces it, so the computed size IS the behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Rule = { selectors: string[]; body: string; at: number; coarse: boolean };

/** Every innermost rule in a file, with its offset and whether a coarse-pointer
 *  media block encloses it. */
function rules(file: string): Rule[] {
  const css = readFileSync(resolve(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) =>
    " ".repeat(c.length),
  );
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      stack.push(css.slice(head, i).trim());
      head = i + 1;
    } else if (css[i] === "}") {
      const prelude = stack.pop() ?? "";
      if (!prelude.startsWith("@")) {
        out.push({
          selectors: prelude.split(",").map((s) => s.trim()),
          body: css.slice(head, i),
          at: i,
          coarse: stack.some((p) => /@media[^{]*pointer:\s*coarse/.test(p)),
        });
      }
      head = i + 1;
    }
  }
  return out;
}

const files = ["src/app.css", "src/sidebar.css"];

/** The smallest px a font-size can resolve to, or null when it can go lower. */
function floorPx(value: string): number | null {
  const max = value.match(/^max\(\s*(\d+)px\s*,/);
  if (max) return Number(max[1]);
  const px = value.match(/^(\d+)px$/);
  return px ? Number(px[1]) : null;
}

const fontSize = (r: Rule) => r.body.match(/font-size:\s*([^;]+);/)?.[1]?.trim();

describe("a focused field does not make iOS zoom the page", () => {
  it.each(["tl-qcard-other", "tl-cp-input", "tl-composer-input", "tl-add-input", "tl-card-rename"])(
    ".%s is at least 16px on a coarse pointer",
    (cls) => {
      const sel = `.${cls}`;
      const hits = files.flatMap((f) =>
        rules(f)
          .filter((r) => r.selectors.includes(sel) && fontSize(r))
          .map((r) => ({ ...r, file: f })),
      );
      const winner = hits.filter((r) => r.coarse).at(-1);
      expect(winner, `no coarse-pointer font-size for ${sel}`).toBeDefined();
      expect(floorPx(fontSize(winner!)!)).toBeGreaterThanOrEqual(16);

      for (const base of hits.filter((r) => !r.coarse && r.file === winner!.file)) {
        expect(base.at, `${sel}'s own rule comes after its coarse override`).toBeLessThan(
          winner!.at,
        );
      }
    },
  );
});
