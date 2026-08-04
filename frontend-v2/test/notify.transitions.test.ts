import { describe, it, expect } from "vitest";
import {
  computeTransitions,
  snapshotStates,
  type SessionLike,
  type StateMap,
  type TransitionGate,
} from "../src/notify/transitions";

const S = (name: string, state?: string): SessionLike => ({ name, state });

/** default gate: away (so no per-session suppression), both edges enabled. */
const gate = (over: Partial<TransitionGate> = {}): TransitionGate => ({
  away: true,
  activeSession: null,
  onAwaiting: true,
  onDone: true,
  pushDelivers: false,
  ...over,
});

const prevOf = (...pairs: [string, string][]): StateMap => new Map(pairs);

describe("snapshotStates", () => {
  it("maps name → state, normalizing missing state to ''", () => {
    const snap = snapshotStates([S("a", "running"), S("b")]);
    expect(snap.get("a")).toBe("running");
    expect(snap.get("b")).toBe("");
  });
});

describe("computeTransitions", () => {
  it("seeds quietly on the first poll (prev === null)", () => {
    expect(computeTransitions(null, [S("a", "awaiting")], gate())).toEqual([]);
  });

  it("fires on running→awaiting", () => {
    const fires = computeTransitions(prevOf(["a", "running"]), [S("a", "awaiting")], gate());
    expect(fires).toEqual([{ session: "a", kind: "awaiting" }]);
  });

  it("fires on running→done (strict)", () => {
    const fires = computeTransitions(prevOf(["a", "running"]), [S("a", "done")], gate());
    expect(fires).toEqual([{ session: "a", kind: "done" }]);
  });

  it("announces a freshly-SEEN awaiting session (was undefined)", () => {
    const fires = computeTransitions(prevOf(), [S("a", "awaiting")], gate());
    expect(fires).toEqual([{ session: "a", kind: "awaiting" }]);
  });

  it("does NOT re-fire awaiting→awaiting (the tag would merely re-fire)", () => {
    expect(
      computeTransitions(prevOf(["a", "awaiting"]), [S("a", "awaiting")], gate()),
    ).toEqual([]);
  });

  it("does NOT announce a freshly-seen done (strict running→done only)", () => {
    expect(computeTransitions(prevOf(), [S("a", "done")], gate())).toEqual([]);
  });

  it("does NOT fire done from a non-running prior state (e.g. awaiting→done)", () => {
    expect(
      computeTransitions(prevOf(["a", "awaiting"]), [S("a", "done")], gate()),
    ).toEqual([]);
  });

  it("respects onAwaiting=false / onDone=false", () => {
    expect(
      computeTransitions(prevOf(["a", "running"]), [S("a", "awaiting")], gate({ onAwaiting: false })),
    ).toEqual([]);
    expect(
      computeTransitions(prevOf(["a", "running"]), [S("a", "done")], gate({ onDone: false })),
    ).toEqual([]);
  });

  describe("per-session away gate", () => {
    it("stays QUIET for the active session while focused (!away)", () => {
      const fires = computeTransitions(
        prevOf(["a", "running"]),
        [S("a", "awaiting")],
        gate({ away: false, activeSession: "a" }),
      );
      expect(fires).toEqual([]);
    });

    it("NOTIFIES the active session when away (hidden/unfocused)", () => {
      const fires = computeTransitions(
        prevOf(["a", "running"]),
        [S("a", "awaiting")],
        gate({ away: true, activeSession: "a" }),
      );
      expect(fires).toEqual([{ session: "a", kind: "awaiting" }]);
    });

    it("NOTIFIES a BACKGROUND session even while focused (Viktor's fix)", () => {
      // Focused, looking at 'a'; 'b' finishes in the background → still notifies.
      const fires = computeTransitions(
        prevOf(["a", "running"], ["b", "running"]),
        [S("a", "running"), S("b", "done")],
        gate({ away: false, activeSession: "a" }),
      );
      expect(fires).toEqual([{ session: "b", kind: "done" }]);
    });
  });

  describe("pushDelivers (the double-alert fix)", () => {
    // Viktor, 2026-08-04: an iPhone showed TWO identical banners seconds apart
    // for one turn completing — the page's own notification AND the server's
    // background push. The shared tl-<session> tag coalesces them on
    // Android/desktop but NOT on iOS, where the later same-tag notification
    // raises a second banner. So when this device is registered for background
    // push, the SERVER is the single notifier and the page must stay silent.
    it("fires nothing at all when the server pushes to this device", () => {
      expect(
        computeTransitions(
          prevOf(["a", "running"], ["b", "running"]),
          [S("a", "awaiting"), S("b", "done")],
          gate({ pushDelivers: true }),
        ),
      ).toEqual([]);
    });

    it("still fires when this device is NOT registered for push", () => {
      expect(
        computeTransitions(
          prevOf(["a", "running"]),
          [S("a", "done")],
          gate({ pushDelivers: false }),
        ),
      ).toEqual([{ session: "a", kind: "done" }]);
    });
  });
});
