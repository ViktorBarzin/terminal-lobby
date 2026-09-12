/**
 * What a reattach clears, and what it deliberately leaves alone.
 *
 * The constant is one string, so what is worth pinning is not its shape but
 * the membership decision behind it: tracking and focus go, encodings and
 * intent-carrying modes stay. Each half has a way of going wrong that this
 * catches — adding `?2004` here would turn a paste in the attach gap into
 * keystrokes, and dropping `?1003` would leave the reports that caused the bug.
 */
import { describe, expect, it } from "vitest";
import { DETACHED_MODE_RESET } from "../src/terminal/modes";

/** The private modes a sequence resets, in the order they appear. */
function resets(seq: string): string[] {
  return Array.from(seq.matchAll(/\x1b\[\?(\d+)l/g), (m) => m[1]!);
}

describe("the modes a departed program leaves behind", () => {
  /**
   * The three tracking modes are the whole reported bug: with any one of them
   * still set, a pointer crossing a terminal whose socket has just reopened
   * emits reports into a pty that is still echoing, and the echo lands on the
   * grid until tmux's redraw wipes it ~500 ms later.
   */
  it("clears every mouse tracking mode", () => {
    expect(resets(DETACHED_MODE_RESET)).toEqual(
      expect.arrayContaining(["1000", "1002", "1003"]),
    );
  });

  /**
   * The other unprompted sender. A session switch moves the keyboard, and a
   * terminal still in `?1004` answers that with `\x1b[I` — which is what went
   * out 14 ms before the new socket's handshake in the measurement.
   */
  it("clears focus reporting", () => {
    expect(resets(DETACHED_MODE_RESET)).toContain("1004");
  });

  /**
   * Bracketed paste changes what a paste MEANS: Claude Code reads the wrapper
   * to tell a paste from typing. A paste is a person asking for something and
   * has to arrive intact, wrapper and all, even inside the attach gap.
   */
  it("leaves bracketed paste alone", () => {
    expect(resets(DETACHED_MODE_RESET)).not.toContain("2004");
  });

  /**
   * The encodings decide the shape of a report, not whether one is sent, so
   * with tracking off they produce nothing. tmux sets the one it wants in the
   * same write as the tracking mode it re-enables.
   */
  it("leaves the report encodings alone", () => {
    const got = resets(DETACHED_MODE_RESET);
    for (const encoding of ["1005", "1006", "1015"]) {
      expect(got).not.toContain(encoding);
    }
  });

  /** Nothing but DECRST: a stray SET here would arm what this is turning off. */
  it("sets no mode and prints nothing", () => {
    const leftover = DETACHED_MODE_RESET.replace(/\x1b\[\?\d+l/g, "");
    expect(leftover).toBe("");
  });
});
