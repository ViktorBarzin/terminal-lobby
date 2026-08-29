import { describe, it, expect } from "vitest";
import { multiUser, canActAs } from "../src/lib/mode";
import type { Whoami } from "../src/types/lobby";

const who = (o: Partial<Whoami>): Whoami => ({
  authentik: "alice",
  osUser: "wizard",
  ...o,
});

describe("mode — which features this box has", () => {
  // The flag is what /whoami reports. Inferring the mode from an empty /users
  // list is what this replaces: a Share dialog that opens onto nobody reads as
  // a defect rather than as a mode.
  it("reads multiUser from whoami", () => {
    expect(multiUser(who({ multiUser: true }))).toBe(true);
    expect(multiUser(who({ multiUser: false }))).toBe(false);
  });

  // A server built before the flag existed sends no multiUser. Treating that as
  // multi-user keeps an older backend behaving as it does today, rather than
  // hiding features from it.
  it("treats an absent flag as multi-user, so an older server is unchanged", () => {
    expect(multiUser(who({}))).toBe(true);
    expect(multiUser(undefined)).toBe(true);
  });

  // Both conditions, not either. Single-user has exactly one account, so there
  // is nobody to act as even for someone the server calls an administrator.
  it("offers act-as only when the caller is an admin AND the box is multi-user", () => {
    expect(canActAs(who({ admin: true, multiUser: true }))).toBe(true);
    expect(canActAs(who({ admin: true, multiUser: false }))).toBe(false);
    expect(canActAs(who({ admin: false, multiUser: true }))).toBe(false);
    expect(canActAs(who({ admin: false, multiUser: false }))).toBe(false);
  });

  it("offers nothing without a whoami", () => {
    expect(canActAs(undefined)).toBe(false);
  });
});
