/**
 * Public links, the rules (components/links.logic.ts): who is offered Share…,
 * which lifetimes a mode allows, how a link's time left and its visitors are
 * said, and the URL a token becomes. The dialog, Settings and the session bar
 * all read these, so they are pinned here rather than through the DOM.
 */
import { describe, it, expect } from "vitest";
import {
  LINK_TTLS,
  canShare,
  clampTtl,
  countVisitors,
  expiryLabel,
  linkUrl,
  linksForSession,
  modeBadge,
  ttlAllowed,
  visitorCountLabel,
  visitorLabel,
  visitorSummary,
} from "../src/components/links.logic";
import type { LinkView } from "../src/types/lobby";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

describe("canShare", () => {
  it.each([
    ["own session, owner stamped", { owner: "viktor" }, "viktor", "", true],
    ["own session, no owner field", {}, "viktor", "", true],
    ["own session, empty access", { owner: "viktor", access: "" as const }, "viktor", "", true],
    ["someone else's session", { owner: "emo" }, "viktor", "", false],
    ["shared with you read-write", { owner: "emo", access: "rw" as const }, "viktor", "", false],
    ["shared with you read-only", { owner: "emo", access: "ro" as const }, "viktor", "", false],
    ["own session in a lens tab", { owner: "emo" }, "emo", "emo", false],
    ["no owner in a lens tab", {}, "viktor", "emo", false],
  ])("%s", (_name, session, me, actAs, want) => {
    expect(canShare(session, me, actAs)).toBe(want);
  });
});

describe("lifetimes per mode", () => {
  it("offers every lifetime to a watch link", () => {
    for (const t of LINK_TTLS) expect(ttlAllowed("ro", t)).toBe(true);
  });

  it("caps a link that can type at 24 hours, like the server", () => {
    expect(LINK_TTLS.filter((t) => ttlAllowed("rw", t))).toEqual(["1h", "24h"]);
  });

  it.each([
    ["rw", "7d", "24h"],
    ["rw", "never", "24h"],
    ["rw", "1h", "1h"],
    ["rw", "24h", "24h"],
    ["ro", "7d", "7d"],
    ["ro", "never", "never"],
  ] as const)("switching to %s keeps %s as %s", (mode, ttl, want) => {
    expect(clampTtl(mode, ttl)).toBe(want);
  });
});

describe("expiryLabel", () => {
  it.each([
    [0, "until revoked"],
    [NOW - 1, "expired"],
    [NOW, "expired"],
    [NOW + 5, "expires in 1 min"],
    [NOW + 59 * 60, "expires in 59 min"],
    [NOW + 3600, "expires in 1 h"],
    [NOW + 24 * 3600, "expires in 24 h"],
    [NOW + 23 * 3600 + 10 * 60, "expires in 23 h"],
    [NOW + 47 * 3600, "expires in 47 h"],
    [NOW + 7 * 86400, "expires in 7 d"],
  ])("expiresAt %d reads %s", (at, want) => {
    expect(expiryLabel(at, NOW_MS)).toBe(want);
  });
});

describe("visitors", () => {
  it("names a watcher by number and marks a driver", () => {
    expect(visitorLabel({ guest: 1, mode: "rw", since: NOW })).toBe("guest 1 (driving)");
    expect(visitorLabel({ guest: 2, mode: "ro", since: NOW })).toBe("guest 2");
  });

  it("counts a link's visitors the way the session list does", () => {
    expect(
      countVisitors([
        { guest: 1, mode: "rw", since: NOW },
        { guest: 2, mode: "ro", since: NOW },
        { guest: 3, mode: "ro", since: NOW },
      ]),
    ).toEqual({ total: 3, driving: 1 });
    expect(countVisitors([])).toEqual({ total: 0, driving: 0 });
  });

  it("says the bar's count, with drivers only when there are some", () => {
    expect(visitorSummary({ total: 2, driving: 1 })).toEqual({
      text: "2 via link",
      driving: "(1 driving)",
    });
    expect(visitorSummary({ total: 1, driving: 0 })).toEqual({ text: "1 via link", driving: "" });
  });

  it("says nothing when nobody is on a link", () => {
    expect(visitorSummary(undefined).text).toBe("");
    expect(visitorSummary({ total: 0, driving: 0 }).text).toBe("");
  });

  it("counts for Settings in words", () => {
    expect(visitorCountLabel({ total: 0, driving: 0 })).toBe("");
    expect(visitorCountLabel({ total: 1, driving: 0 })).toBe("1 visitor");
    expect(visitorCountLabel({ total: 3, driving: 2 })).toBe("3 visitors (2 driving)");
  });
});

describe("linkUrl", () => {
  it("puts the token in the fragment under /s/, never in the path or query", () => {
    const url = linkUrl("https://terminal.viktorbarzin.me", "abc_-123");
    expect(url).toBe("https://terminal.viktorbarzin.me/s/#abc_-123");
    const u = new URL(url);
    expect(u.pathname).toBe("/s/");
    expect(u.search).toBe("");
    expect(u.hash).toBe("#abc_-123");
  });
});

describe("modeBadge", () => {
  it("calls the modes Watch and Drive", () => {
    expect(modeBadge("ro")).toBe("Watch");
    expect(modeBadge("rw")).toBe("Drive");
  });
});

describe("linksForSession", () => {
  const link = (id: string, session: string, sessionId: string): LinkView => ({
    id,
    session,
    sessionId,
    mode: "ro",
    createdAt: NOW,
    expiresAt: 0,
    visitors: [],
  });
  const links = [link("a", "auth", "$1"), link("b", "renamed", "$2"), link("c", "auth", "$3")];

  it("matches by tmux's session id, which a rename keeps", () => {
    expect(linksForSession(links, { name: "old-name", id: "$2" }).map((l) => l.id)).toEqual(["b"]);
  });

  it("falls back to the name when the session list carries no id", () => {
    expect(linksForSession(links, { name: "auth" }).map((l) => l.id)).toEqual(["a", "c"]);
  });
});
