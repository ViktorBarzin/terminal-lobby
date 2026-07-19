import { describe, it, expect } from "vitest";
import { faviconKind } from "../src/notify/favicon";

const S = (state?: string) => ({ state });

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
    expect(faviconKind([S("running"), S("done")], true)).toBe("done");
  });

  it("awaiting OUTRANKS the bell 'done' signal", () => {
    // amber only when action is actually wanted — the bell must not mask it.
    expect(faviconKind([S("awaiting")], true)).toBe("awaiting");
  });

  it("is '' when nothing awaits and no bell (done alone is not badged here)", () => {
    // done without a bell does not badge the favicon (title carries unseen-done).
    expect(faviconKind([S("done"), S("running")], false)).toBe("");
  });
});
