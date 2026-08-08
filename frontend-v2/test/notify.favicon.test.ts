import { describe, it, expect } from "vitest";
import { faviconKind, type BadgeSession } from "../src/notify/favicon";

let seq = 0;
const S = (state?: string, name?: string): BadgeSession => ({
  name: name ?? `s${++seq}`,
  state,
});
/** the user has already looked at everything */
const allSeen = () => false;

describe("faviconKind — badge precedence", () => {
  it("is '' with no sessions and no bell", () => {
    expect(faviconKind([], false)).toBe("");
  });

  it("is 'awaiting' when any session awaits input", () => {
    expect(faviconKind([S("running"), S("awaiting"), S("done")], false)).toBe(
      "awaiting",
    );
  });

  it("is 'done' when a bell latched and nothing awaits", () => {
    expect(faviconKind([S("running"), S("done")], true, allSeen)).toBe("done");
  });

  it("awaiting OUTRANKS the bell 'done' signal", () => {
    // amber only when action is actually wanted — the bell must not mask it.
    expect(faviconKind([S("awaiting")], true)).toBe("awaiting");
  });

  it("is '' when nothing awaits, no bell, and every finished session was seen", () => {
    expect(faviconKind([S("done"), S("running")], false, allSeen)).toBe("");
  });
});

describe("faviconKind — unseen-done tracks the SAME predicate as the title", () => {
  // A finished session used to badge the tab TITLE while the favicon reverted
  // to the plain icon: only a bell could paint the green tick. Badge and clear
  // now happen together, off one shared `isUnseen`.
  it("badges 'done' for a finished session the user has not seen yet", () => {
    expect(faviconKind([S("done"), S("running")], false)).toBe("done");
  });

  it("clears the moment that session is seen", () => {
    const list = [S("done", "a"), S("running", "b")];
    const unseen = new Set(["a"]);
    expect(faviconKind(list, false, (s) => unseen.has(s.name))).toBe("done");
    unseen.delete("a"); // the user attached 'a'
    expect(faviconKind(list, false, (s) => unseen.has(s.name))).toBe("");
  });

  it("still lets awaiting outrank an unseen done", () => {
    expect(faviconKind([S("awaiting", "a"), S("done", "b")], false)).toBe(
      "awaiting",
    );
  });

  it("defaults to 'every done is unseen' when no predicate is injected", () => {
    expect(faviconKind([S("done")], false)).toBe("done");
  });
});
