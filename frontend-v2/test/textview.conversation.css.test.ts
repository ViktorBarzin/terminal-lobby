/**
 * How the T3 pass's conversation reads: the user's messages as rounded grey
 * bubbles on the right, Claude's replies as plain text, queued prompts as
 * dashed ghosts of the bubble they will become, and small notes centred and
 * muted.
 *
 * docs/plans/2026-09-27-text-view-t3-pass.md, prototype
 * pages/wizard/composer/6-t3.html (`.m-user`, `.m-asst`, `.m-ghost`,
 * `.m-note`), states 6-idle, 6-queued and 6-tools. Asserted as CSS text, as
 * textview.column.css.test.ts does, because jsdom has no layout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"));

/** The stylesheet with every @-rule block cut out, so a rule read here is one
 *  that applies everywhere rather than under a media query. */
function withoutAtBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf("{", at);
    const semi = css.indexOf(";", at);
    if (open < 0 || (semi >= 0 && semi < open)) {
      i = semi < 0 ? css.length : semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}
const topCss = withoutAtBlocks(appCss);

interface Rule {
  selectors: string[];
  body: string;
}

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

/** Every declaration the rules naming exactly `selector` make, later ones winning. */
function declsOf(css: string, selector: string): Map<string, string> {
  const found = rules(css).filter((r) => r.selectors.includes(selector));
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  const out = new Map<string, string>();
  for (const r of found) {
    for (const m of r.body.matchAll(/(?:^|[;\s])([a-z-]+)\s*:\s*([^;]+);/g)) {
      out.set(m[1]!, m[2]!.trim().replace(/\s+/g, " "));
    }
  }
  return out;
}

const PHONE = "@media (pointer: coarse) and ((max-width: 720px) or (max-height: 480px))";

/** The text of every phone-query block, so a rule inside one can be read. */
function phoneCss(): string {
  const esc = PHONE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...appCss.matchAll(new RegExp(`${esc}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"))]
    .map((m) => m[1]!)
    .join("\n");
}

const scaled = (px: number): string => `calc(${px}px * var(--tl-text-scale, 1))`;

describe("the user's bubble", () => {
  const bubble = () => declsOf(topCss, ".tl-bubble-user");

  it("is a rounded grey fill on the right, 84% of the column at most", () => {
    expect(bubble().get("background")).toBe("var(--bubble)");
    expect(bubble().get("border-radius")).toBe("20px");
    expect(bubble().get("padding")).toBe("9px 15px");
    expect(bubble().get("max-width")).toBe("84%");
    expect(declsOf(topCss, ".tl-row-user").get("justify-content")).toBe("flex-end");
  });

  it("has no outline, as the prototype's .m-user has none", () => {
    expect(bubble().has("border")).toBe(false);
  });

  it("keeps the message's own line breaks and breaks a long token", () => {
    const text = declsOf(topCss, ".tl-user-text");
    expect(text.get("white-space")).toBe("pre-wrap");
    expect(text.get("overflow-wrap")).toBe("anywhere");
  });
});

describe("a queued prompt's ghost", () => {
  // Keyed on the row's data-queued, which GhostRowsView sets
  // (MessagesTimeline.ghost.test.tsx pins that it does).
  const ghost = () => declsOf(topCss, ".tl-row-user[data-queued] .tl-bubble-user");

  it("is a dashed outline of the bubble, in the muted colour", () => {
    expect(ghost().get("border")).toBe("1px dashed var(--border-strong)");
    expect(ghost().get("background")).toBe("transparent");
    expect(ghost().get("color")).toBe("var(--text-muted)");
    // One pixel of the 9px 15px goes to the border, so the text sits where
    // the bubble's will.
    expect(ghost().get("padding")).toBe("8px 14px");
  });

  it("rises into place", () => {
    expect(ghost().get("animation")).toBe("tl-rise 0.22s ease-out");
  });

  it("stops rising for a reader who asked for less motion", () => {
    const reduced = [
      ...appCss.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1]!)
      .join("\n");
    const stopped = rules(reduced).find((r) =>
      r.selectors.includes(".tl-row-user[data-queued] .tl-bubble-user"),
    );
    expect(stopped?.body).toMatch(/animation:\s*none/);
  });

  it("carries a small uppercase Queued tag on an accent chip", () => {
    const tag = declsOf(topCss, ".tl-ghost-tag");
    expect(tag.get("text-transform")).toBe("uppercase");
    expect(tag.get("font-size")).toBe(scaled(10.5));
    expect(tag.get("padding")).toBe("0 7px");
    expect(tag.get("margin-right")).toBe("8px");
    expect(tag.get("border-radius")).toBe("999px");
    expect(tag.get("background")).toBe("color-mix(in srgb, var(--accent) 15%, transparent)");
    expect(tag.get("color")).toBe("var(--accent)");
  });
});

describe("Claude's reply", () => {
  it("is plain text, with no bubble", () => {
    const reply = declsOf(topCss, ".tl-row-message");
    for (const p of ["background", "border", "padding", "border-radius"]) {
      expect(reply.has(p), p).toBe(false);
    }
  });

  it("sets paragraphs and code blocks 10px apart", () => {
    expect(declsOf(topCss, ".tl-row-message .tl-markdown p").get("margin-block")).toBe("10px");
    expect(declsOf(topCss, ".tl-row-message .tl-code-block").get("margin-block")).toBe("10px");
    // The block's own <pre> adds none, or the gap would be the pre's instead.
    expect(declsOf(topCss, ".tl-row-message .tl-code-block > .tl-code").get("margin-block")).toBe(
      "0",
    );
  });

  it("adds nothing above the first block or below the last", () => {
    // solid-markdown wraps the blocks in a div of its own inside .tl-markdown.
    const first = declsOf(topCss, ".tl-row-message .tl-markdown > div > :first-child");
    const last = declsOf(topCss, ".tl-row-message .tl-markdown > div > :last-child");
    expect(first.get("margin-top")).toBe("0");
    expect(last.get("margin-bottom")).toBe("0");
  });

  it("draws inline code a little smaller, on the hover fill with a hairline", () => {
    expect(declsOf(topCss, ".tl-row-message .tl-inline-code").get("font-size")).toBe("0.84em");
    const code = declsOf(topCss, ".tl-inline-code");
    expect(code.get("background")).toBe("var(--bg-card-hover)");
    expect(code.get("border")).toBe("1px solid var(--border)");
    expect(code.get("border-radius")).toBe("5px");
  });

  it("draws a code block on the card fill, radius 10, at 12.5px on 19px", () => {
    const pre = declsOf(topCss, ".tl-row-message .tl-code");
    expect(pre.get("border-radius")).toBe("10px");
    expect(pre.get("background")).toBe("var(--bg-card)");
    expect(pre.get("font-size")).toBe(scaled(12.5));
    expect(pre.get("line-height")).toBe("calc(19 / 12.5)");
  });

  it("drops the code block to 12px on 19px on a phone", () => {
    const pre = declsOf(phoneCss(), ".tl-row-message .tl-code");
    expect(pre.get("font-size")).toBe(scaled(12));
    expect(pre.get("line-height")).toBe("calc(19 / 12)");
  });
});

describe("a note", () => {
  it.each([".tl-row-meta", ".tl-row-permission", ".tl-row-status"])(
    "%s is one centred 12px muted line",
    (selector) => {
      const note = declsOf(topCss, selector);
      expect(note.get("font-size")).toBe(scaled(12));
      expect(note.get("color")).toBe("var(--text-muted)");
      const centred =
        note.get("text-align") === "center" || note.get("justify-content") === "center";
      expect(centred, selector).toBe(true);
    },
  );

  it("draws no card around a permission", () => {
    const note = declsOf(topCss, ".tl-row-permission");
    for (const p of ["border", "border-left", "background", "padding"]) {
      expect(note.has(p), p).toBe(false);
    }
  });

  it("names a permission's tool in the text colour", () => {
    expect(declsOf(topCss, ".tl-row-permission b").get("color")).toBe("var(--text-primary)");
  });

  it("keeps a meta row's value quiet, since it can be a long hook message", () => {
    expect(declsOf(topCss, ".tl-meta-value").has("color")).toBe(false);
    expect(declsOf(topCss, ".tl-meta-value").has("font-weight")).toBe(false);
  });
});

describe("the live group at the end of an open turn (6-working)", () => {
  it("borders a running group, and the clearing row, in the running colour at 45%", () => {
    for (const sel of [
      '.tl-group-box[data-live="working"]',
      '.tl-group-box[data-live="clearing"]',
    ]) {
      expect(declsOf(topCss, sel).get("border-color")).toBe(
        "color-mix(in srgb, var(--state-running) 45%, var(--border-strong))",
      );
    }
  });

  it("keeps the plain border while Claude waits, with a still awaiting dot", () => {
    expect(() => declsOf(topCss, '.tl-group-box[data-live="waiting"]')).toThrow();
    const dot = declsOf(topCss, ".tl-live-dot");
    expect(dot.get("background")).toBe("var(--state-awaiting)");
    expect(dot.get("border-radius")).toBe("50%");
    expect(dot.has("animation")).toBe(false);
  });

  it("does not light up a live row that nothing opens", () => {
    expect(declsOf(topCss, ".tl-live-head").get("cursor")).toBe("default");
    expect(declsOf(topCss, ".tl-live-head:hover").get("background")).toBe("none");
  });
});
