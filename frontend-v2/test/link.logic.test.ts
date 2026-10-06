/**
 * The public-link visitor page's pure half
 * (docs/plans/2026-10-06-public-links-design.md).
 */
import { describe, expect, it } from "vitest";
import {
  argsFor,
  baseFor,
  pickToken,
  readRedeem,
  tokenFromHash,
} from "../src/link/link.logic";

const TOKEN = "abcdefghijklmnopqrstuv"; // 22 chars, base64url
const TICKET = "A".repeat(32);

describe("the token", () => {
  it("is read from the fragment, with or without the #", () => {
    expect(tokenFromHash("#" + TOKEN)).toBe(TOKEN);
    expect(tokenFromHash(TOKEN)).toBe(TOKEN);
  });

  it("is refused when it is not the shape tmux-api mints", () => {
    for (const bad of ["", "#", "#short", "#" + TOKEN + "x", "#abc/defghijklmnopqrstu"]) {
      expect(tokenFromHash(bad)).toBe("");
    }
  });

  it("falls back to the tab's stored copy once the address bar is clean", () => {
    expect(pickToken("", TOKEN)).toBe(TOKEN);
    expect(pickToken("#" + TOKEN, "B".repeat(22))).toBe(TOKEN);
    expect(pickToken("", "junk")).toBe("");
    expect(pickToken("", null)).toBe("");
  });
});

describe("which server attaches", () => {
  it("sends a watcher to the instance that takes no input", () => {
    expect(baseFor("ro")).toBe("/s");
    expect(baseFor("rw")).toBe("/s/rw");
  });

  it("puts the ticket, and only the ticket, in ttyd's args", () => {
    expect(argsFor(TICKET)).toBe("arg=" + TICKET);
  });
});

describe("a redeem answer", () => {
  it("is a ticket when tmux-api says so", () => {
    expect(readRedeem(200, { ticket: TICKET, mode: "rw", title: "Deploy", expiresAt: 5 })).toEqual({
      kind: "ok",
      value: { ticket: TICKET, mode: "rw", title: "Deploy", expiresAt: 5 },
    });
  });

  it("is the end of the link on every 404", () => {
    expect(readRedeem(404, null)).toEqual({ kind: "ended" });
  });

  it("is worth retrying when it is anything else", () => {
    expect(readRedeem(503, null)).toEqual({ kind: "retry" });
    expect(readRedeem(429, null)).toEqual({ kind: "retry" });
    expect(readRedeem(200, { ticket: "short", mode: "ro" })).toEqual({ kind: "retry" });
    expect(readRedeem(200, { ticket: TICKET, mode: "admin" })).toEqual({ kind: "retry" });
  });
});
