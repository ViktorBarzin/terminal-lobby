import { describe, it, expect } from "vitest";
import {
  eventChordKeys,
  eventMatchesChord,
  evalWhen,
  parseChord,
  type ChordEventLike,
} from "../src/keybindings/chords.logic";

/** Build a keydown-like event with all modifiers off unless overridden. */
function ev(over: Partial<ChordEventLike>): ChordEventLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    type: "keydown",
    ...over,
  };
}

describe("parseChord", () => {
  it("parses modifiers + key and folds synonyms", () => {
    expect(parseChord("alt+shift+[")).toEqual({
      ctrl: false,
      shift: true,
      alt: true,
      meta: false,
      key: "[",
    });
    expect(parseChord("Control+Shift+K")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: "k",
    });
    expect(parseChord("Option+/")).toEqual({
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
      key: "/",
    });
    expect(parseChord("cmd+j")).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: true,
      key: "j",
    });
    expect(parseChord("super+j")?.meta).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseChord("  ALT + Shift + Enter ")).toEqual({
      ctrl: false,
      shift: true,
      alt: true,
      meta: false,
      key: "enter",
    });
  });

  it("rejects bare keys with no ctrl/alt/meta (they must reach the pty)", () => {
    expect(parseChord("k")).toBeNull();
    expect(parseChord("shift+k")).toBeNull(); // shift alone is not enough
    expect(parseChord("/")).toBeNull();
  });

  it("rejects garbage, empty, non-strings, and modifier-only chords", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("+++")).toBeNull();
    expect(parseChord("ctrl+alt")).toBeNull(); // last segment is a modifier word
    expect(parseChord("ctrl")).toBeNull();
    expect(parseChord(null)).toBeNull();
    expect(parseChord(42 as unknown)).toBeNull();
  });

  it("rejects a non-modifier before the last segment", () => {
    expect(parseChord("a+ctrl+b")).toBeNull();
  });
});

describe("eventChordKeys — layout-proof identities", () => {
  it("includes the lowercased e.key and normalizes esc", () => {
    expect(eventChordKeys({ key: "K", code: "KeyK" }).has("k")).toBe(true);
    expect(eventChordKeys({ key: "Esc", code: "Escape" }).has("escape")).toBe(true);
  });

  it("adds the physical e.code alias for letters (KeyN survives Mac Option)", () => {
    // Mac Option+n produces a dead-key e.key, but e.code stays "KeyN".
    const keys = eventChordKeys({ key: "Dead", code: "KeyN" });
    expect(keys.has("n")).toBe(true);
  });

  it("adds the digit alias so Alt+1 works on AZERTY (e.key='&')", () => {
    const keys = eventChordKeys({ key: "&", code: "Digit1" });
    expect(keys.has("1")).toBe(true);
  });

  it("adds bracket aliases when the layout shifts [ to {", () => {
    expect(eventChordKeys({ key: "{", code: "BracketLeft" }).has("[")).toBe(true);
    expect(eventChordKeys({ key: "}", code: "BracketRight" }).has("]")).toBe(true);
  });

  it("adds the Slash alias so Alt+/ matches when Option remaps e.key", () => {
    // Mac Option+/ = a division sign; the Slash code alias rescues the match.
    const keys = eventChordKeys({ key: "÷", code: "Slash" });
    expect(keys.has("/")).toBe(true);
  });
});

describe("eventMatchesChord — exact modifier gating", () => {
  const altOne = parseChord("alt+1");

  it("matches Alt+1 on a US layout (e.key='1')", () => {
    expect(eventMatchesChord(ev({ altKey: true, key: "1", code: "Digit1" }), altOne)).toBe(true);
  });

  it("matches Alt+1 on AZERTY (e.key='&', e.code='Digit1')", () => {
    expect(eventMatchesChord(ev({ altKey: true, key: "&", code: "Digit1" }), altOne)).toBe(true);
  });

  it("does NOT match when an extra modifier is held (AltGr = Ctrl+Alt)", () => {
    expect(
      eventMatchesChord(ev({ altKey: true, ctrlKey: true, key: "1", code: "Digit1" }), altOne),
    ).toBe(false);
  });

  it("does NOT match when a required modifier is missing", () => {
    expect(eventMatchesChord(ev({ altKey: false, key: "1", code: "Digit1" }), altOne)).toBe(false);
  });

  it("matches Alt+Shift+[ when the layout shifts the bracket", () => {
    const chord = parseChord("alt+shift+[");
    expect(
      eventMatchesChord(ev({ altKey: true, shiftKey: true, key: "{", code: "BracketLeft" }), chord),
    ).toBe(true);
  });

  it("matches Option+/ (Mac) via the Slash code alias", () => {
    const chord = parseChord("alt+/");
    expect(
      eventMatchesChord(ev({ altKey: true, key: "÷", code: "Slash" }), chord),
    ).toBe(true);
  });

  it("returns false for a null chord", () => {
    expect(eventMatchesChord(ev({ altKey: true, key: "1" }), null)).toBe(false);
  });
});

describe("evalWhen", () => {
  const ctx = { terminalFocus: true, lobbyOpen: false, galleryOpen: false };

  it("returns true for an empty/undefined clause", () => {
    expect(evalWhen(undefined, ctx)).toBe(true);
    expect(evalWhen("", ctx)).toBe(true);
  });

  it("evaluates identifiers, negation, && and ||", () => {
    expect(evalWhen("terminalFocus", ctx)).toBe(true);
    expect(evalWhen("!galleryOpen", ctx)).toBe(true);
    expect(evalWhen("lobbyOpen && !galleryOpen", ctx)).toBe(false);
    expect(evalWhen("terminalFocus && !galleryOpen", ctx)).toBe(true);
    expect(evalWhen("lobbyOpen || terminalFocus", ctx)).toBe(true);
  });

  it("treats unknown identifiers as false", () => {
    expect(evalWhen("nope", ctx)).toBe(false);
    expect(evalWhen("!nope", ctx)).toBe(true);
  });
});
