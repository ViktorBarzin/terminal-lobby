/**
 * How long a keystroke takes to show up.
 *
 * WHY. On 2026-09-12 a user could not work for about three hours and the only
 * thing that noticed was the user. Everything measured that day was a proxy:
 * PSI says the box is stalled on disk, api.rollup says an HTTP handler was
 * slow, term.ready says a terminal took a while to boot. None of them is the
 * thing a person actually feels, which is typing and waiting to see it.
 *
 * WHERE IT MEASURES, and what that buys. The gap between a keystroke leaving
 * xterm's onData and the next frame arriving at term.write. That path is the
 * whole round trip: websocket out, ttyd, the pty, tmux, whatever program is
 * attached, and all the way back. It therefore includes the user's own
 * network, which is the point. A session that feels bad because of cellular
 * is still a session that feels bad, and the server-side view cannot see it.
 *
 * WHAT IT CANNOT DO, stated because the number would otherwise be believed
 * too hard. A TUI redraws on its own schedule, so a frame arriving after a
 * keystroke is not necessarily caused by it. Only the FIRST frame is
 * attributed, unattributed output is dropped, and implausibly long gaps are
 * discarded rather than recorded. Across a window of many samples the p50 is
 * meaningful; a single sample is not evidence of anything.
 *
 * TIMING ONLY, NEVER CONTENT. This never sees which key was pressed or what
 * was on screen, only that something was typed and when something came back.
 * That keeps it inside the rule the rest of the telemetry follows: record
 * WHICH feature ran, never what was typed.
 */

/**
 * Beyond this a gap is not echo latency, it is a person who typed, went away,
 * and came back to find something had printed. Recording those would move a
 * p95 around on the strength of somebody's lunch break.
 */
export const MAX_PLAUSIBLE_ECHO_MS = 5_000;

/**
 * Sample ceiling for one window. This sits on the terminal's hottest path, so
 * it must not grow without bound if a rollup is never collected: a detached
 * background tab still receives output. At 2048 the oldest are dropped, which
 * biases a pathological window towards recent samples and never towards
 * unbounded memory.
 */
const MAX_SAMPLES = 2048;

export type TypingRollup = {
  n: number;
  p50: number;
  p95: number;
  max: number;
};

export class TypingLatency {
  private pending: number | null = null;
  private samples: number[] = [];

  constructor(private now: () => number = () => performance.now()) {}

  /**
   * A keystroke went out. The first one of a burst is the one that counts:
   * holding a key or pasting produces many, and overwriting the mark with the
   * latest would measure the gap from the LAST key to the frame, making every
   * burst look fast.
   */
  onInput(): void {
    if (this.pending === null) this.pending = this.now();
  }

  /** A frame arrived. Attributed only if a keystroke is waiting on one. */
  onOutput(): void {
    if (this.pending === null) return;
    const ms = this.now() - this.pending;
    this.pending = null;
    if (ms < 0 || ms > MAX_PLAUSIBLE_ECHO_MS) return;
    if (this.samples.length >= MAX_SAMPLES) this.samples.shift();
    this.samples.push(ms);
  }

  sampleCount(): number {
    return this.samples.length;
  }

  /** Summarise and reset, so consecutive windows never overlap. */
  takeRollup(): TypingRollup | null {
    if (this.samples.length === 0) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    this.samples = [];
    // The non-null assertions are safe and the length check above is what
    // makes them so: s is non-empty, and every index below is clamped into it.
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return {
      n: s.length,
      p50: round(q(0.5)),
      p95: round(q(0.95)),
      max: round(s[s.length - 1]!),
    };
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;
