/**
 * Stepper arithmetic for font size, line height and letter spacing.
 *
 * Two of the three were sliders, so the browser owned the stepping and the
 * rounding. As steppers that is ours, and there are two traps:
 *
 *   - Binary floating point. 1 + 0.05 × 3 is 1.1500000000000001, and this value
 *     is written into the roamed prefs doc and read back by the terminal page,
 *     so drift does not stay local.
 *   - A starting value off the step grid. Reachable from a client that wrote a
 *     different step, or from the sliders that shipped before this. Pressing +
 *     on 1.13 should land on 1.15, not on 1.18.
 *
 * So the work happens in step-index space and comes back rounded to the step's
 * own precision, and a value between two grid points moves to the next one in
 * the direction pressed.
 */

export interface StepSpec {
  min: number;
  max: number;
  step: number;
}

/** Decimal places the step itself carries — 1 → 0, 0.1 → 1, 0.05 → 2. */
const decimals = (step: number): number => {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
};

/**
 * `current` moved one step in the direction of `dir` (+1 up, −1 down), clamped
 * to the spec and snapped to the step grid.
 *
 * The epsilon absorbs the float error in the index itself: (1.15 − 1) / 0.05 is
 * 2.9999999999999996, and without it a press of + from 1.15 would land back on
 * 1.15 rather than on 1.20.
 */
export const stepTo = (current: number, dir: number, spec: StepSpec): number => {
  const { min, max, step } = spec;
  const lastIndex = Math.round((max - min) / step);
  const index = (current - min) / step;
  const eps = 1e-9;
  const next =
    dir > 0 ? Math.floor(index + eps) + 1 : Math.ceil(index - eps) - 1;
  const clamped = Math.min(lastIndex, Math.max(0, next));
  return Number((min + clamped * step).toFixed(decimals(step)));
};

/** How a stepper's value reads on screen, at the step's own precision. */
export const formatStep = (value: number, spec: StepSpec, unit = ""): string =>
  `${value.toFixed(decimals(spec.step))}${unit}`;
