import { describe, expect, it } from "vitest";
import { cleanTitle, MAX_TITLE_RUNES } from "../src/lib/title";
import vectors from "../../slug/vectors.json";

/**
 * cleanTitle mirrors Go's slug.CleanTitle, which tmux-api runs on every title
 * that reaches it. The browser shows what was typed optimistically and the
 * server stores what it stamped, so the two disagreeing would make a card
 * change under the person who just retitled it.
 *
 * The cases are NOT written here. Both suites read `cleanTitleCases` out of
 * slug/vectors.json, which is what makes them the same cases: they were
 * hand-copied into each language before, so adding a case to one list left the
 * other implementation unpinned against it. Vite reaches the sibling directory
 * because vitest.config.ts allows it.
 *
 * Name DERIVATION used to be tested here against the `cases` list in the same
 * file. ADR-0019 ended it: a session name is a minted id now (lib/session-id.ts,
 * with its own test file), derived from nothing.
 */

describe("cleanTitle", () => {
  it("reads a non-empty shared list (an unresolved fixture must not pass silently)", () => {
    expect(vectors.cleanTitleCases.length).toBeGreaterThan(0);
  });

  it.each(vectors.cleanTitleCases.map((c) => [c.in, c.want] as const))(
    "%j → %j",
    (input, want) => {
      expect(cleanTitle(input)).toBe(want);
    },
  );

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
