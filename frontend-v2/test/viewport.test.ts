import { describe, it, expect } from "vitest";
import { keyboardOffset } from "../src/mobile/viewport";

describe("viewport — keyboardOffset", () => {
  it("is 0 when the visual viewport fills the layout viewport (no keyboard)", () => {
    expect(keyboardOffset(800, 800, 0)).toBe(0);
  });

  it("equals the covered height when the keyboard shrinks the visual viewport", () => {
    // iOS Safari: innerHeight stays 800, visualViewport shrinks to 500.
    expect(keyboardOffset(800, 500, 0)).toBe(300);
  });

  it("accounts for a scrolled visual viewport (offsetTop)", () => {
    expect(keyboardOffset(800, 500, 50)).toBe(250);
  });

  it("never goes negative (visual viewport reported taller than layout)", () => {
    expect(keyboardOffset(800, 850, 0)).toBe(0);
  });
});
