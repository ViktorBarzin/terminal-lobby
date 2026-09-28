/**
 * A settled turn's fold on the phone. It is drawn as a work group row since
 * the first deployed review (2026-09-28), with no file name or token count to
 * give way, and the prototype's phone rows keep only the time on the right
 * (6-tools, 6-idle). A hidden failure still says "✗ failed" in words.
 *
 * Asserted as CSS text, as textview.conversation.css.test.ts does, because
 * jsdom has no layout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(resolve(process.cwd(), "src/app.css"), "utf8"));

const PHONE = "@media (pointer: coarse) and ((max-width: 720px) or (max-height: 480px))";

function phoneCss(): string {
  const esc = PHONE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...appCss.matchAll(new RegExp(`${esc}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"))]
    .map((m) => m[1]!)
    .join("\n");
}

/** The selectors of every phone rule that hides what it names. */
function hiddenOnPhone(): string[] {
  const out: string[] = [];
  for (const m of phoneCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[;\s])display\s*:\s*none\s*;/.test(m[2]!)) continue;
    for (const s of m[1]!.split(",")) out.push(s.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("the turn fold on the phone", () => {
  it("gives the tick's room to the time, as a work group does", () => {
    expect(hiddenOnPhone()).toContain(".tl-group-okm");
  });

  it("still says a hidden failure in words", () => {
    expect(hiddenOnPhone()).not.toContain(".tl-fold-error");
  });
});
