import { describe, it, expect } from "vitest";
import { KEY_BYTES, KEY_NAMES, keyBytes } from "../src/mobile/keybytes";

describe("keybytes — pre-baked byte map", () => {
  it("maps the control keys to their exact escape sequences", () => {
    expect(keyBytes("esc")).toBe("\x1b");
    expect(keyBytes("tab")).toBe("\t");
  });

  it("maps the four arrows to the correct CSI final bytes (A/B/D/C)", () => {
    expect(keyBytes("up")).toBe("\x1b[A");
    expect(keyBytes("down")).toBe("\x1b[B");
    expect(keyBytes("left")).toBe("\x1b[D");
    expect(keyBytes("right")).toBe("\x1b[C");
  });

  it("left is D and right is C (the classic swap trap)", () => {
    // Guard against the easy ANSI mistake of C=left/D=right.
    expect(keyBytes("left")).not.toBe(keyBytes("right"));
    expect(keyBytes("left").endsWith("D")).toBe(true);
    expect(keyBytes("right").endsWith("C")).toBe(true);
  });

  it("KEY_NAMES enumerates every entry in KEY_BYTES", () => {
    expect(new Set(KEY_NAMES)).toEqual(new Set(Object.keys(KEY_BYTES)));
    // Six since the key row flattened to one line (2026-09-06): backTab and
    // the four literal glyphs left with the buttons that sent them.
    expect(KEY_NAMES.length).toBe(6);
  });

  it("every byte but Tab begins with ESC", () => {
    for (const n of ["esc", "up", "down", "left", "right"] as const) {
      expect(keyBytes(n).charCodeAt(0)).toBe(0x1b);
    }
    expect(keyBytes("tab")).toBe("\t");
  });
});
