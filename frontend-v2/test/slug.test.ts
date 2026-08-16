import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  fallbackName,
  MAX_NAME_LEN,
  MAX_TITLE_RUNES,
  nameForTitle,
  slugFromTitle,
} from "../src/lib/slug";

/**
 * The same vectors slug/slug_test.go reads. The browser derives a name when it
 * CREATES a session (no server call is involved) and tmux-api derives one when
 * it retitles, so the two implementations have to agree exactly — a drift would
 * create or rename the wrong session. Add cases to the shared file, not here.
 */
// Resolved from vitest's root (frontend-v2), not import.meta.url — vitest
// rewrites that to a non-file scheme during transform.
const vectorsPath = resolve(process.cwd(), "../slug/vectors.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  cases: { title: string; want: string }[];
};

describe("slugFromTitle", () => {
  it("has vectors to check against", () => {
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  it.each(vectors.cases)("$title → $want", ({ title, want }) => {
    expect(slugFromTitle(title)).toBe(want);
  });

  it("only ever yields something tmux-api's NAME_RE accepts", () => {
    for (const { title } of vectors.cases) {
      const got = slugFromTitle(title);
      if (got === "") continue; // the caller supplies a fallback
      expect(got, `title ${JSON.stringify(title)}`).toMatch(/^[a-z0-9_-]+$/);
      expect([...got].length).toBeLessThanOrEqual(MAX_NAME_LEN);
      expect(got.startsWith("-")).toBe(false);
      expect(got.endsWith("-")).toBe(false);
    }
  });

  it("is idempotent over its own output", () => {
    // A retitle compares the derived name against the current one to decide
    // whether to rename at all; drift here would rename on every poll.
    for (const { title } of vectors.cases) {
      const once = slugFromTitle(title);
      if (once === "") continue;
      expect(slugFromTitle(once)).toBe(once);
    }
  });
});

describe("cleanTitle", () => {
  it.each([
    ["Deploy the thing", "Deploy the thing"],
    ["  padded  ", "padded"],
    ["collapses   inner   runs", "collapses inner runs"],
    ["tab\tand\nnewline", "tab and newline"],
    ["bell\u0007and\u001Bescape", "bell and escape"], // BEL, ESC
    ["c1\u0085control", "c1 control"], // NEL - a C1 control
    ["", ""],
    ["   ", ""],
    ["кирилица остава", "кирилица остава"],
    ["emoji 🚀 stays", "emoji 🚀 stays"],
    ["pipe | stays", "pipe | stays"],
  ])("%j → %j", (input, want) => {
    expect(cleanTitle(input)).toBe(want);
  });

  it("caps on code points, not UTF-16 units", () => {
    // 70 emoji is 140 UTF-16 units. Slicing on .length would cut a surrogate
    // pair in half and leave a lone surrogate in the stored title.
    const got = cleanTitle("🚀".repeat(70));
    expect([...got]).toHaveLength(MAX_TITLE_RUNES);
    expect(got).toBe("🚀".repeat(MAX_TITLE_RUNES)); // every kept unit is a whole emoji
    expect(got).not.toContain("�");
  });

  it("is idempotent", () => {
    for (const input of ["  a  b  ", "é".repeat(100), "tab\there", ""]) {
      const once = cleanTitle(input);
      expect(cleanTitle(once)).toBe(once);
    }
  });
});

describe("fallbackName", () => {
  it.each([
    [[], "session-1"],
    [["session-1"], "session-2"],
    [["session-1", "session-2", "session-4"], "session-3"],
    [["unrelated"], "session-1"],
  ])("%j → %s", (taken, want) => {
    expect(fallbackName(new Set(taken))).toBe(want);
  });
});

describe("nameForTitle", () => {
  it("uses the slug when there is one", () => {
    expect(nameForTitle("Deploy the thing", new Set())).toBe("deploy-the-thing");
  });

  it("falls back for a title with nothing romanizable in it", () => {
    expect(nameForTitle("会议", new Set())).toBe("session-1");
    expect(nameForTitle("🚀", new Set(["session-1"]))).toBe("session-2");
  });

  it("does NOT resolve a collision — that is the caller's to reject", () => {
    // Reject-on-collision is the design: the person retitles, so handing them a
    // suffixed name they never typed would be worse than saying it is taken.
    expect(nameForTitle("Deploy the thing", new Set(["deploy-the-thing"]))).toBe(
      "deploy-the-thing",
    );
  });
});
