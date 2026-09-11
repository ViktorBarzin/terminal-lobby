/**
 * What a finished drag means, away from the DOM.
 *
 * The library reports a list's whole order once the pointer comes up; the store
 * moves one session against a neighbour. Everything between those two is here,
 * because it is arithmetic and none of it is observable in jsdom (no layout, no
 * hit-testing). The gesture that produces the order is exercised in a real
 * browser instead — see docs/development.md.
 */
import { describe, it, expect } from "vitest";
import { anchorFor, groupSeqTarget } from "../src/dnd/anchor";
import { planMove } from "../src/dnd/sidebar";

describe("anchorFor — the neighbour a dropped card is placed against", () => {
  const order = ["a", "b", "c"];

  it("anchors below the row above it, which is the one it was dragged past", () => {
    expect(anchorFor(order, "b")).toEqual({ name: "a", side: "below" });
    expect(anchorFor(order, "c")).toEqual({ name: "b", side: "below" });
  });

  it("anchors above the next row when it landed at the top, which has none above", () => {
    expect(anchorFor(order, "a")).toEqual({ name: "b", side: "above" });
  });

  it("has no anchor when it is alone: an append and slot zero are the same seat", () => {
    expect(anchorFor(["a"], "a")).toBeUndefined();
  });

  it("has no anchor for a name that is not in the list", () => {
    expect(anchorFor(order, "z")).toBeUndefined();
  });

  // The property that matters: applying the anchor to the OTHER rows, in the
  // order they were already in, reproduces the order the drag ended on.
  it("reproduces the dropped order from the rows around it", () => {
    for (const at of [0, 1, 2, 3]) {
      const rest = ["a", "b", "c"];
      const dropped = [...rest.slice(0, at), "x", ...rest.slice(at)];
      const anchor = anchorFor(dropped, "x");
      const i = anchor ? rest.indexOf(anchor.name) : rest.length;
      const insert = anchor?.side === "below" ? i + 1 : i;
      expect([...rest.slice(0, insert), "x", ...rest.slice(insert)]).toEqual(dropped);
    }
  });
});

describe("planMove — a drag that changed nothing writes nothing", () => {
  it("asks for nothing when the card came back to its own seat", () => {
    const same = { group: "p", names: ["a", "b", "c"] };
    expect(planMove(same, { group: "p", values: ["a", "b", "c"] }, "b")).toBeNull();
  });

  it("moves within a group, anchored on the row above", () => {
    expect(
      planMove({ group: "p", names: ["a", "b", "c"] }, { group: "p", values: ["b", "a", "c"] }, "a"),
    ).toEqual({ group: "p", anchor: { name: "b", side: "below" } });
  });

  it("moves into another group even when that group's order reads the same", () => {
    // The card is new to this list, so an identical-looking order is still a
    // move: the group changed, and only the group check can see that.
    expect(
      planMove({ group: "p", names: ["x"] }, { group: "", values: ["x"] }, "x"),
    ).toEqual({ group: "", anchor: undefined });
  });

  it("moves into an empty group with no anchor at all", () => {
    expect(planMove({ group: "p", names: ["x"] }, { group: "q", values: ["x"] }, "x")).toEqual({
      group: "q",
      anchor: undefined,
    });
  });
});

/**
 * The two orders a group drag straddles are not the same list: an empty
 * Ungrouped keeps its slot in the layout but renders nothing, so the sequence
 * the store splices holds tokens the drag never saw.
 *
 * `reorderGroups` splices the token out and then back in, which is what makes
 * the answer depend on which way it travelled — this mirrors that splice and
 * checks the visible result over every small arrangement.
 */
function splice(seq: readonly string[], from: number, to: number): string[] {
  const out = [...seq];
  const at = Math.max(0, Math.min(to, out.length - 1));
  const [moved] = out.splice(from, 1);
  out.splice(at, 0, moved!);
  return out;
}

describe("groupSeqTarget — where a dragged group lands in the raw sequence", () => {
  const seq = ["u", "p:a", "p:b", "p:c"];

  it("stays put when the drag ended where it started", () => {
    expect(groupSeqTarget(seq, ["u", "p:a", "p:b", "p:c"], "p:b")).toBeNull();
  });

  it("has nothing to do for a group that is alone on screen", () => {
    expect(groupSeqTarget(seq, ["p:b"], "p:b")).toBeNull();
  });

  it("ignores a token the layout does not hold", () => {
    expect(groupSeqTarget(seq, ["p:z", "p:a"], "p:z")).toBeNull();
  });

  // Every visible arrangement of every hidden subset: whatever index this
  // returns, splicing to it has to reproduce the order the drag ended on.
  it("reproduces the dropped order, hidden groups and all", () => {
    for (let hidden = 0; hidden < 1 << seq.length; hidden++) {
      const visible = seq.filter((_, i) => (hidden & (1 << i)) === 0);
      if (visible.length < 2) continue;
      for (const token of visible) {
        const rest = visible.filter((t) => t !== token);
        for (let at = 0; at <= rest.length; at++) {
          const dropped = [...rest.slice(0, at), token, ...rest.slice(at)];
          const to = groupSeqTarget(seq, dropped, token);
          const after = to === null ? seq : splice(seq, seq.indexOf(token), to);
          expect(after.filter((t) => visible.includes(t))).toEqual(dropped);
        }
      }
    }
  });
});
