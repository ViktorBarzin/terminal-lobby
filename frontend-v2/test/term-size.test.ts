/**
 * The terminal size a device last drew, kept for the claim at Send: a slot is
 * claimed before its terminal attaches, and sized to this so Claude's first
 * reply wraps to the screen it will be read on.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { lastTermSize, rememberTermSize } from "../src/lib/term-size";

beforeEach(() => localStorage.clear());

describe("term-size", () => {
  it("has nothing before any terminal has drawn", () => {
    expect(lastTermSize()).toEqual({});
  });

  it("gives back the size last remembered", () => {
    rememberTermSize(45, 30);
    rememberTermSize(52, 31);
    expect(lastTermSize()).toEqual({ cols: 52, rows: 31 });
  });

  it("ignores a size no terminal has", () => {
    rememberTermSize(0, 0);
    rememberTermSize(Number.NaN, 20);
    expect(lastTermSize()).toEqual({});
  });

  it("survives storage that is not there", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      rememberTermSize(45, 30);
      expect(lastTermSize()).toEqual({});
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real);
    }
  });
});
