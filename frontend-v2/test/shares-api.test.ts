import { describe, expect, it } from "vitest";
import { inviteUrl } from "../src/lib/shares-api";

describe("inviteUrl", () => {
  it("is the lobby's foreign-session hash, with the session id when known", () => {
    expect(inviteUrl("https://t.example", "wizard", "fix-auth")).toBe(
      "https://t.example/#fix-auth@wizard",
    );
    expect(inviteUrl("https://t.example", "wizard", "fix-auth", "$7")).toBe(
      "https://t.example/#fix-auth@wizard!$7",
    );
  });
});
