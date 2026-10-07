/**
 * The public-link visitor page's pure half
 * (docs/plans/2026-10-06-public-links-design.md, ADR-0041).
 */
import { describe, expect, it } from "vitest";
import {
  mergeEvents,
  pickToken,
  readRedeem,
  tokenFromHash,
  transcriptRoutes,
} from "../src/link/link.logic";

const TOKEN = "abcdefghijklmnopqrstuv"; // 22 chars, base64url
const LINK = "0123456789abcdef";

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

describe("a redeem answer", () => {
  it("names the link, its title and whether the session has ended", () => {
    expect(readRedeem(200, { link: LINK, title: "Deploy", expiresAt: 9, endedAt: 0 })).toEqual({
      kind: "ok",
      value: { link: LINK, title: "Deploy", expiresAt: 9, endedAt: 0 },
    });
  });

  it("is the end of the link on every 404", () => {
    expect(readRedeem(404, null)).toEqual({ kind: "gone" });
  });

  it("is worth retrying when it is anything else", () => {
    expect(readRedeem(503, null)).toEqual({ kind: "retry" });
    expect(readRedeem(429, null)).toEqual({ kind: "retry" });
    expect(readRedeem(200, { link: "../x" })).toEqual({ kind: "retry" });
  });
});

describe("the read routes", () => {
  it("carry the link id and never a secret", () => {
    const r = transcriptRoutes(LINK);
    expect(r.transcript(0)).toBe(`/s/api/link/transcript?l=${LINK}`);
    expect(r.transcript(41)).toBe(`/s/api/link/transcript?l=${LINK}&after=41`);
    expect(r.toolImage("toolu_1", 2)).toBe(`/s/api/link/image?l=${LINK}&tool=toolu_1&n=2`);
    expect(r.promptImage("abc-123", 0)).toBe(`/s/api/link/image?l=${LINK}&record=abc-123&n=0`);
    expect(r.picture("/var/lib/clipboard-store/w/s/a b.png")).toBe(
      `/s/api/link/picture?l=${LINK}&p=%2Fvar%2Flib%2Fclipboard-store%2Fw%2Fs%2Fa%20b.png`,
    );
  });
});

describe("following a live conversation", () => {
  const ev = (id: number) => ({ id });

  it("takes the first read whole", () => {
    expect(mergeEvents([ev(1)], [ev(1), ev(2)], 0)).toEqual([ev(1), ev(2)]);
  });

  it("appends only what is newer than the last event held", () => {
    const held = [ev(1), ev(2)];
    expect(mergeEvents(held, [ev(3), ev(4)], 2)).toEqual([ev(1), ev(2), ev(3), ev(4)]);
    // A repeated answer draws nothing twice.
    expect(mergeEvents(held, [ev(2)], 1)).toBe(held);
    expect(mergeEvents(held, [], 2)).toBe(held);
  });
});
