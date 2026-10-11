import { describe, expect, it } from "vitest";
import { inviteUrl } from "../src/lib/shares-api";

describe("inviteUrl", () => {
  it("is the lobby's foreign-session hash", () => {
    expect(inviteUrl("https://t.example", "wizard", "fix-auth")).toBe("https://t.example/#fix-auth@wizard");
  });
});
