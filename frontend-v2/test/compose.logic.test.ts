import { describe, it, expect } from "vitest";
import {
  BRACKET_END,
  BRACKET_START,
  SUBMIT,
  bracketedPaste,
  softNewlines,
  splitComposeSubmit,
} from "../src/mobile/compose";

describe("compose — softNewlines", () => {
  it("collapses CRLF and lone CR to LF", () => {
    expect(softNewlines("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("preserves internal LFs", () => {
    expect(softNewlines("a\nb\nc")).toBe("a\nb\nc");
  });

  it("drops a single trailing newline (expressed by the submit instead)", () => {
    expect(softNewlines("hello\n")).toBe("hello");
    expect(softNewlines("hello\r\n")).toBe("hello");
  });

  it("leaves single-line text untouched", () => {
    expect(softNewlines("just one line")).toBe("just one line");
  });
});

describe("compose — splitComposeSubmit (bracketed paste + separate submit)", () => {
  it("wraps the text in bracketed-paste markers", () => {
    const f = splitComposeSubmit("hello");
    expect(f.paste).toBe(`${BRACKET_START}hello${BRACKET_END}`);
  });

  it("returns the submit as a SEPARATE \\r frame, not inside the paste", () => {
    const f = splitComposeSubmit("hello");
    expect(f.submit).toBe(SUBMIT);
    expect(f.submit).toBe("\r");
    // The CR must NOT appear inside the bracketed payload.
    expect(f.paste).not.toContain("\r");
    expect(f.paste.endsWith(BRACKET_END)).toBe(true);
  });

  it("keeps a CR/newline INSIDE the text as a soft newline (not a submit)", () => {
    const f = splitComposeSubmit("line one\nline two");
    // Two lines survive as ONE bracketed payload (soft newline between them).
    expect(f.paste).toBe(`${BRACKET_START}line one\nline two${BRACKET_END}`);
    // The only submit is the trailing standalone CR.
    expect(f.submit).toBe("\r");
  });

  it("softens an embedded CR so it can never be mistaken for a submit", () => {
    const f = splitComposeSubmit("a\r\nb");
    expect(f.paste).toBe(`${BRACKET_START}a\nb${BRACKET_END}`);
    expect(f.paste).not.toContain("\r");
  });

  it("handles an empty message (empty bracketed paste + submit)", () => {
    const f = splitComposeSubmit("");
    expect(f.paste).toBe(`${BRACKET_START}${BRACKET_END}`);
    expect(f.submit).toBe("\r");
  });

  it("concatenating paste then submit is the full byte stream, in order", () => {
    const f = splitComposeSubmit("cmd --flag");
    expect(f.paste + f.submit).toBe(
      `${BRACKET_START}cmd --flag${BRACKET_END}\r`,
    );
  });
});

describe("compose — bracketedPaste (no submit)", () => {
  it("wraps without appending a submit", () => {
    expect(bracketedPaste("/path/to/img.png")).toBe(
      `${BRACKET_START}/path/to/img.png${BRACKET_END}`,
    );
  });

  it("softens newlines but adds no trailing CR", () => {
    const out = bracketedPaste("x\r\ny");
    expect(out).toBe(`${BRACKET_START}x\ny${BRACKET_END}`);
    expect(out).not.toContain("\r");
  });
});
