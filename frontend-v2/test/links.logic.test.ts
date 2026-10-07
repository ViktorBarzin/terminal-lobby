/**
 * Public links, the rules (components/links.logic.ts): who is offered Share…,
 * how a link's time left and its readers are said, and the URL a token
 * becomes. The dialog, Settings and the session bar all read these, so they
 * are pinned here rather than through the DOM.
 */
import { describe, it, expect } from "vitest";
import {
  canShare,
  expiryLabel,
  linkUrl,
  linksForSession,
  viewersLabel,
} from "../src/components/links.logic";
import type { LinkView } from "../src/types/lobby";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

describe("canShare", () => {
  const claude = { tool: "claude" as const };
  it.each([
    ["own session, owner stamped", { ...claude, owner: "viktor" }, "viktor", "", true],
    ["own session, no owner field", { ...claude }, "viktor", "", true],
    [
      "own session, empty access",
      { ...claude, owner: "viktor", access: "" as const },
      "viktor",
      "",
      true,
    ],
    ["someone else's session", { ...claude, owner: "emo" }, "viktor", "", false],
    [
      "shared with you read-write",
      { ...claude, owner: "emo", access: "rw" as const },
      "viktor",
      "",
      false,
    ],
    [
      "shared with you read-only",
      { ...claude, owner: "emo", access: "ro" as const },
      "viktor",
      "",
      false,
    ],
    ["own session in a lens tab", { ...claude, owner: "emo" }, "emo", "emo", false],
    ["no owner in a lens tab", { ...claude }, "viktor", "emo", false],
    // A link shares the conversation; a session with no Claude has none (ADR-0041).
    ["own plain shell", { tool: "shell" as const }, "viktor", "", false],
    ["own codex session", { tool: "codex" as const }, "viktor", "", false],
    ["tool not known yet", {}, "viktor", "", false],
  ])("%s", (_name, session, me, actAs, want) => {
    expect(canShare(session, me, actAs)).toBe(want);
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

describe("viewersLabel", () => {
  it("says how many are reading, and nothing when nobody is", () => {
    expect(viewersLabel(2)).toBe("2 viewing");
    expect(viewersLabel(1)).toBe("1 viewing");
    expect(viewersLabel(0)).toBe("");
    expect(viewersLabel(undefined)).toBe("");
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

describe("linksForSession", () => {
  const link = (id: string, session: string, sessionId: string): LinkView => ({
    id,
    session,
    sessionId,
    createdAt: NOW,
    expiresAt: 0,
    viewers: 0,
  });
  const links = [link("a", "auth", "$1"), link("b", "renamed", "$2"), link("c", "auth", "$3")];

  it("matches by tmux's session id, which a rename keeps", () => {
    expect(linksForSession(links, { name: "old-name", id: "$2" }).map((l) => l.id)).toEqual(["b"]);
  });

  it("falls back to the name when the session list carries no id", () => {
    expect(linksForSession(links, { name: "auth" }).map((l) => l.id)).toEqual(["a", "c"]);
  });
});
