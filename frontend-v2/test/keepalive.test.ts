/**
 * The rules for what stays mounted between session switches.
 *
 * Two of them are easy to get wrong, and both put the 1,797 ms cover back on a
 * switch that was meant to be free: reordering the list moves a session's node
 * in the DOM, which tears its terminal down and rebuilds it, and replacing an
 * entry object makes `<For>` rebuild the row it belongs to. So the tests below
 * pin identity as hard as they pin the TTL.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_KEEP,
  KEEP_TTL_MS,
  keepSelected,
  keyOf,
  pruneKept,
  type KeepState,
} from "../src/store/keepalive";

const T0 = 1_700_000_000_000;

/** Visit each name in turn, from empty. */
const visited = (names: string[], at = T0): KeepState =>
  names.reduce((s, name) => keepSelected(s, { name }, at), EMPTY_KEEP);

describe("keeping a session mounted", () => {
  it("appends a session the first time it is opened", () => {
    const next = keepSelected(EMPTY_KEEP, { name: "alpha" }, T0);
    expect(next.list.map((k) => k.name)).toEqual(["alpha"]);
    expect(next.seen[keyOf({ name: "alpha" })]).toBe(T0);
  });

  it("never reorders, because moving a session's node rebuilds its terminal", () => {
    let state = visited(["alpha", "beta", "gamma"]);
    state = keepSelected(state, { name: "alpha" }, T0 + 9_000);
    state = keepSelected(state, { name: "beta" }, T0 + 10_000);
    expect(state.list.map((k) => k.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps the list REFERENCE when a kept session is revisited", () => {
    const state = visited(["alpha", "beta"]);
    const again = keepSelected(state, { name: "alpha" }, T0 + 5_000);
    // Same array and same entry objects: `<For>` has nothing to rebuild.
    expect(again.list).toBe(state.list);
    expect(again.list[0]).toBe(state.list[0]);
    expect(again.seen[keyOf({ name: "alpha" })]).toBe(T0 + 5_000);
  });

  it("tells a session apart from the same name owned by someone else", () => {
    const mine = keepSelected(EMPTY_KEEP, { name: "alpha" }, T0);
    const both = keepSelected(mine, { name: "alpha", owner: "bob" }, T0);
    expect(both.list).toHaveLength(2);
  });

  it("leaves the state alone when nothing is selected", () => {
    const before = visited(["alpha"]);
    expect(keepSelected(before, null, T0 + 5)).toBe(before);
  });
});

describe("dropping a mount", () => {
  it("drops a session unvisited for longer than the TTL", () => {
    let state = keepSelected(EMPTY_KEEP, { name: "stale" }, T0);
    state = keepSelected(state, { name: "fresh" }, T0 + KEEP_TTL_MS);
    const next = pruneKept(state, { name: "fresh" }, T0 + KEEP_TTL_MS + 1);
    expect(next.list.map((k) => k.name)).toEqual(["fresh"]);
    expect(next.seen[keyOf({ name: "stale" })]).toBeUndefined();
  });

  it("keeps a session that is a day old to the millisecond", () => {
    const state = visited(["edge"]);
    expect(pruneKept(state, null, T0 + KEEP_TTL_MS).list).toHaveLength(1);
  });

  it("never drops the session on screen, however long it has been open", () => {
    const state = visited(["watched"]);
    const next = pruneKept(state, { name: "watched" }, T0 + 10 * KEEP_TTL_MS);
    expect(next.list.map((k) => k.name)).toEqual(["watched"]);
  });

  it("drops a session the lobby no longer lists, even a fresh one", () => {
    const state = visited(["killed", "alive"]);
    const next = pruneKept(state, null, T0 + 1, KEEP_TTL_MS, new Set(["alive"]));
    expect(next.list.map((k) => k.name)).toEqual(["alive"]);
  });

  it("keeps everything while the session list is unknown", () => {
    const state = visited(["alpha", "beta"]);
    expect(pruneKept(state, null, T0 + 1).list).toHaveLength(2);
  });

  it("returns the same state when there is nothing to drop", () => {
    const state = visited(["alpha", "beta"]);
    expect(pruneKept(state, null, T0 + 1, KEEP_TTL_MS, new Set(["alpha", "beta"]))).toBe(state);
  });
});

describe("keyOf's separator", () => {
  /**
   * The separator is U+0000, and it is written in the source as an escape
   * sequence rather than a literal byte, because a literal one makes git and
   * grep treat the whole file as binary and skip it. The escape parses to the
   * same byte, so keys already in localStorage keep matching. This test is what
   * says so: it compares against the code point, not against the source text.
   */
  it("joins owner and name with U+0000", () => {
    expect(keyOf({ owner: "wizard", name: "alpha" })).toBe(
      `wizard${String.fromCharCode(0)}alpha`,
    );
  });

  it("leaves an empty owner in front of the separator", () => {
    expect(keyOf({ name: "alpha" })).toBe(`${String.fromCharCode(0)}alpha`);
  });

  it("cannot be forged by a name that contains the separator's printed form", () => {
    expect(keyOf({ name: "\\u0000alpha" })).not.toBe(keyOf({ name: "alpha" }));
  });
});
