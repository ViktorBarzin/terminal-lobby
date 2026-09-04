import { describe, expect, it } from "vitest";
import { cleanTitle, MAX_TITLE_RUNES } from "../src/lib/title";

/**
 * cleanTitle mirrors Go's slug.CleanTitle, which tmux-api runs on every title
 * that reaches it (TestCleanTitle* in slug/slug_test.go holds the same cases).
 * The browser shows what was typed optimistically and the server stores what it
 * stamped, so the two disagreeing would make a card change under the person who
 * just retitled it.
 *
 * Name DERIVATION used to be tested here against slug/vectors.json. ADR-0019
 * ended it: a session name is a minted id now (lib/session-id.ts, with its own
 * test file), derived from nothing.
 */

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
