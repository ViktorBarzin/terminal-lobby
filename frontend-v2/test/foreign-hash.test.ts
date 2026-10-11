import { describe, expect, it } from "vitest";
import { foreignHash, parseForeignHash } from "../src/lib/foreign-hash";

describe("the foreign-session hash", () => {
  it("reads name and owner, with or without the session id", () => {
    expect(parseForeignHash("#fix-auth@emo")).toEqual({ name: "fix-auth", owner: "emo" });
    expect(parseForeignHash("#fix-auth@emo!$202")).toEqual({ name: "fix-auth", owner: "emo", id: "$202" });
    expect(parseForeignHash("fix-auth@emo!%24202")).toEqual({ name: "fix-auth", owner: "emo", id: "$202" });
  });

  it("ignores an id that is not one, and refuses what names no owner", () => {
    expect(parseForeignHash("#a@emo!junk")).toEqual({ name: "a", owner: "emo" });
    expect(parseForeignHash("#a@")).toBeNull();
    expect(parseForeignHash("#a@!$3")).toBeNull();
    expect(parseForeignHash("#plain")).toBeNull();
  });

  it("round-trips what an invite writes", () => {
    expect(parseForeignHash(foreignHash("wizard", "colour-check", "$202"))).toEqual({
      name: "colour-check",
      owner: "wizard",
      id: "$202",
    });
    expect(foreignHash("wizard", "a")).toBe("#a@wizard");
  });
});
