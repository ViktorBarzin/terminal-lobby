/**
 * Stepper arithmetic for the three text controls.
 *
 * Line height and letter spacing were sliders, whose steps the browser handled.
 * As steppers the arithmetic is ours, and it has two ways to go wrong: binary
 * floating point (1 + 0.05 × 3 is 1.1500000000000001, which would be written
 * straight into the roamed prefs doc), and a starting value that is not on the
 * step grid — reachable from a value another client wrote, or from a slider
 * that shipped before this one.
 */
import { describe, it, expect } from "vitest";
import { stepTo, type StepSpec } from "../src/components/settings/stepper";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from "../src/store/prefs";

const FONT: StepSpec = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1 };
const LINE: StepSpec = { min: LINE_HEIGHT_MIN, max: LINE_HEIGHT_MAX, step: 0.05 };
const LETTER: StepSpec = {
  min: LETTER_SPACING_MIN,
  max: LETTER_SPACING_MAX,
  step: 0.1,
};

describe("stepTo", () => {
  it("moves one step in each direction", () => {
    expect(stepTo(11, +1, FONT)).toBe(12);
    expect(stepTo(11, -1, FONT)).toBe(10);
    expect(stepTo(1, +1, LINE)).toBe(1.05);
    expect(stepTo(0, +1, LETTER)).toBe(0.1);
  });

  it("clamps at both ends rather than running past them", () => {
    expect(stepTo(FONT_SIZE_MAX, +1, FONT)).toBe(FONT_SIZE_MAX);
    expect(stepTo(FONT_SIZE_MIN, -1, FONT)).toBe(FONT_SIZE_MIN);
    expect(stepTo(LINE_HEIGHT_MAX, +1, LINE)).toBe(LINE_HEIGHT_MAX);
    expect(stepTo(LINE_HEIGHT_MIN, -1, LINE)).toBe(LINE_HEIGHT_MIN);
    expect(stepTo(LETTER_SPACING_MAX, +1, LETTER)).toBe(LETTER_SPACING_MAX);
    expect(stepTo(LETTER_SPACING_MIN, -1, LETTER)).toBe(LETTER_SPACING_MIN);
  });

  it("walks the whole line-height range without float drift", () => {
    const seen: number[] = [];
    let v = LINE_HEIGHT_MIN;
    for (let i = 0; i < 20; i++) {
      seen.push(v);
      v = stepTo(v, +1, LINE);
    }
    // Every value is exactly two decimals, and the walk stops on the max.
    for (const n of seen) expect(n).toBe(Number(n.toFixed(2)));
    expect(seen).toContain(1.15);
    expect(seen.at(-1)).toBe(LINE_HEIGHT_MAX);
  });

  it("walks letter spacing to one decimal, ending exactly on the max", () => {
    let v = LETTER_SPACING_MIN;
    const seen: number[] = [];
    for (let i = 0; i < 15; i++) {
      seen.push(v);
      v = stepTo(v, +1, LETTER);
    }
    for (const n of seen) expect(n).toBe(Number(n.toFixed(1)));
    expect(seen).toContain(0.3);
    expect(seen.at(-1)).toBe(LETTER_SPACING_MAX);
  });

  it("is reversible: stepping up then down returns the same value", () => {
    for (const [spec, start] of [
      [FONT, 11],
      [LINE, 1.2],
      [LETTER, 0.4],
    ] as const) {
      expect(stepTo(stepTo(start, +1, spec), -1, spec)).toBe(start);
    }
  });

  it("moves an off-grid value to the nearest grid point in that direction", () => {
    // 1.13 could arrive from another client, or from the slider this replaces.
    expect(stepTo(1.13, +1, LINE)).toBe(1.15);
    expect(stepTo(1.13, -1, LINE)).toBe(1.1);
    expect(stepTo(0.45, +1, LETTER)).toBe(0.5);
    expect(stepTo(0.45, -1, LETTER)).toBe(0.4);
  });

  it("pulls a value from outside the range back inside", () => {
    expect(stepTo(99, -1, FONT)).toBe(FONT_SIZE_MAX);
    expect(stepTo(0, +1, FONT)).toBe(FONT_SIZE_MIN);
    expect(stepTo(5, -1, LINE)).toBe(LINE_HEIGHT_MAX);
  });
});
