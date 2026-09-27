/**
 * A settled turn's fold on the phone: "Worked for 38s · 5 steps" has to read
 * whole at 390px. The live check on 2026-09-27 found it cut to "Worked for 38s
 * · 5 ste…" because the changed file's name took the room, and the prototype's
 * phone rows keep only the time on the right (6-tools, 6-idle). The fold's own
 * label already carries the time, and a failure still says "✗ failed" in
 * words, so the file name and the token count are the parts that give way.
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
  it("gives the file name's room to the label, as it does the token count", () => {
    expect(hiddenOnPhone()).toContain(".tl-fold-tokens");
    expect(hiddenOnPhone()).toContain(".tl-fold-files");
  });

  it("still says a hidden failure in words", () => {
    expect(hiddenOnPhone()).not.toContain(".tl-fold-error");
  });
});
