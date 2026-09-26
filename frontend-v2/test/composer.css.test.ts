/**
 * The Quiet line composer's stylesheet: the parts that are a decision rather
 * than a measurement.
 *
 * The dock lost its fill and top border (the transcript fades out under it),
 * its top edge carries the session's state, the two modes that ask nothing
 * get a danger edge on the pill, motion stops for a reader who asked for less
 * of it, and a phone gets 44px targets. CSS text, because none of this is
 * behaviour a DOM test can see.
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

describe("the dock", () => {
  // The band (a sidebar fill and a top border) made the composer read as a
  // separate panel; the conversation now slides under a transparent dock.
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

  it("carries the session's state on its top edge", () => {
    expect(rule('.tl-composer[data-status="working"]::before')).toMatch(
      /animation:\s*tl-sweep 2\.6s/,
    );
    expect(rule('.tl-composer[data-status="waiting"]::before')).toMatch(/--state-awaiting/);
    expect(rule(".tl-composer[data-danger]::before")).toMatch(
      /repeating-linear-gradient\(90deg, var\(--danger\) 0 14px, transparent 14px 20px\)/,
    );
  });
});

describe("the modes that ask nothing", () => {
  it("put a danger edge on the pill", () => {
    expect(rule(".tl-composer[data-danger] .tl-pill")).toMatch(/border-color:[^;]*var\(--danger\)/);
  });

  it("turn the mode dial into a hatched tab", () => {
    expect(rule(".tl-dial[data-danger]")).toMatch(/repeating-linear-gradient\(\s*135deg/);
  });
});

describe("a reader who asked for less motion", () => {
  it("gets a steady working edge rather than a sweep", () => {
    const reduced = blocks("(prefers-reduced-motion: reduce)").join("\n");
    const edge = rule('.tl-composer[data-status="working"]::before', reduced);
    expect(edge).toMatch(/animation:\s*none/);
    expect(edge).toMatch(/--state-running/);
  });
});

describe("a coarse pointer", () => {
  const coarse = () => blocks("(pointer: coarse)").join("\n");

  it("makes + and Send 44px targets round a 36px disc", () => {
    expect(rule(".tl-plus,\n.tl-send", coarse())).toMatch(/width:\s*44px[\s\S]*height:\s*44px/);
    expect(rule(".tl-disc", coarse())).toMatch(/width:\s*36px/);
  });

  // 28px drawn, 44px pressable: the press area reaches into the dock's padding
  // above and stops at the pill below.
  it("gives the line's small controls a taller press area", () => {
    const area = rule(
      ".tl-dial::after,\n.tl-statusline .tl-stop::after,\n.tl-take::after",
      coarse(),
    );
    expect(area).toMatch(/top:\s*-11px/);
    expect(area).toMatch(/bottom:\s*-5px/);
  });
});

describe("no container queries", () => {
  // Safari 15.6 is the oldest engine served and has none; the line folds by
  // `data-room`, which StatusLine measures and writes.
  it("folds the line by the attribute its own width writes", () => {
    expect(css).not.toMatch(/@container/);
    expect(css).toMatch(/\.tl-statusline\[data-room="tight"\]/);
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

  // The phone's field keeps room to write in, so that pill is taller at rest
  // than the live composer's (open point 9).
  it("keeps the phone field's 76px minimum", () => {
    const coarse = blocks("(pointer: coarse)").join("\n");
    expect(rule(".tl-new-composer .tl-composer-input", coarse)).toMatch(/min-height:\s*76px/);
  });
});
