/**
 * The public-link visitor page's pure half
 * (docs/plans/2026-10-06-public-links-design.md).
 */
import { describe, expect, it } from "vitest";
import {
  argsFor,
  baseFor,
  fontToFit,
  pickToken,
  readRedeem,
  transcriptRoutes,
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
    expect(
      readRedeem(200, {
        ticket: TICKET,
        mode: "rw",
        title: "Deploy",
        expiresAt: 5,
        cols: 120,
        rows: 32,
      }),
    ).toEqual({
      kind: "ok",
      value: { ticket: TICKET, mode: "rw", title: "Deploy", expiresAt: 5, cols: 120, rows: 32 },
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

describe("a peek", () => {
  it("is an answer without a ticket", () => {
    const out = readRedeem(200, { mode: "ro", title: "t", cols: 80, rows: 24 }, true);
    expect(out).toMatchObject({ kind: "ok", value: { ticket: "", cols: 80, rows: 24 } });
  });

  it("drops a window size that is not a sane whole number", () => {
    const out = readRedeem(200, { mode: "ro", cols: -3, rows: 1e9 }, true);
    expect(out).toMatchObject({ kind: "ok", value: { cols: 0, rows: 0 } });
  });
});

describe("fitting a watcher's window across the screen", () => {
  it("shrinks the font so every column fits", () => {
    // 120 columns on a 400px phone, cells 0.6 of the font size wide.
    expect(fontToFit(400, 120, 0.6)).toBe(6);
    expect(fontToFit(1200, 120, 0.6)).toBe(14);
    expect(fontToFit(700, 100, 0.6)).toBe(11.6);
  });

  it("falls back to the default size when it cannot measure", () => {
    expect(fontToFit(400, 0, 0.6)).toBe(14);
    expect(fontToFit(0, 80, 0.6)).toBe(14);
  });
});

describe("an ended link", () => {
  it("redeems to a transcript, carrying the link id the routes take", () => {
    const out = readRedeem(200, {
      mode: "transcript",
      link: "0123456789abcdef",
      title: "Deploy",
      expiresAt: 9,
    });
    expect(out).toEqual({
      kind: "transcript",
      value: { link: "0123456789abcdef", title: "Deploy", expiresAt: 9 },
    });
  });

  it("is retried when the link id is not one tmux-api mints", () => {
    expect(readRedeem(200, { mode: "transcript", link: "../x" })).toEqual({ kind: "retry" });
  });

  it("reads through routes that carry the link id and never a secret", () => {
    const r = transcriptRoutes("0123456789abcdef");
    expect(r.transcript).toBe("/s/api/link/transcript?l=0123456789abcdef");
    expect(r.toolImage("toolu_1", 2)).toBe("/s/api/link/image?l=0123456789abcdef&tool=toolu_1&n=2");
    expect(r.promptImage("abc-123", 0)).toBe(
      "/s/api/link/image?l=0123456789abcdef&record=abc-123&n=0",
    );
    expect(r.picture("/var/lib/clipboard-store/w/s/a b.png")).toBe(
      "/s/api/link/picture?l=0123456789abcdef&p=%2Fvar%2Flib%2Fclipboard-store%2Fw%2Fs%2Fa%20b.png",
    );
  });
});
