import { describe, it, expect } from "vitest";
import {
  applyAttentionSignal,
  clearAttention,
  emptyAttention,
  type AttentionSignal,
  type AttentionState,
} from "../src/notify/attention";

const sig = (over: Partial<AttentionSignal> = {}): AttentionSignal => ({
  kind: "output",
  session: "worktree",
  away: true,
  activeSession: null,
  ...over,
});

describe("applyAttentionSignal — latch only while away", () => {
  it("ignores a signal when NOT away (returns the same state object)", () => {
    const s = emptyAttention;
    expect(applyAttentionSignal(s, sig({ away: false }))).toBe(s); // identity
  });

  it("latches the session prefix on an output signal (no bell)", () => {
    const next = applyAttentionSignal(emptyAttention, sig({ kind: "output" }));
    expect(next).toEqual({ session: "worktree", bell: false });
  });

  it("latches the favicon bell on a bell signal", () => {
    const next = applyAttentionSignal(emptyAttention, sig({ kind: "bell" }));
    expect(next).toEqual({ session: "worktree", bell: true });
  });

  it("keeps the bell latched across a later output signal", () => {
    const belled = applyAttentionSignal(emptyAttention, sig({ kind: "bell" }));
    const then = applyAttentionSignal(belled, sig({ kind: "output", session: "other" }));
    expect(then.bell).toBe(true);
    expect(then.session).toBe("other");
  });

  it("falls back to the active session when the reported name is invalid", () => {
    const next = applyAttentionSignal(
      emptyAttention,
      sig({ session: "bad name!!", activeSession: "cur" }),
    );
    expect(next.session).toBe("cur");
  });

  it("falls back to the active session when no name is reported", () => {
    const next = applyAttentionSignal(
      emptyAttention,
      sig({ session: null, activeSession: "cur" }),
    );
    expect(next.session).toBe("cur");
  });

  it("uses a valid reported name verbatim", () => {
    const next = applyAttentionSignal(
      emptyAttention,
      sig({ session: "my_sess-1", activeSession: "cur" }),
    );
    expect(next.session).toBe("my_sess-1");
  });

  it("is a no-op (identity) when the signal changes nothing", () => {
    const s: AttentionState = { session: "worktree", bell: true };
    expect(applyAttentionSignal(s, sig({ kind: "bell", session: "worktree" }))).toBe(s);
  });
});

describe("clearAttention", () => {
  it("resets both latches on visibility/focus return", () => {
    const s: AttentionState = { session: "worktree", bell: true };
    expect(clearAttention(s)).toEqual({ session: null, bell: false });
  });

  it("is identity when already clear (no needless repaint)", () => {
    expect(clearAttention(emptyAttention)).toBe(emptyAttention);
  });
});
