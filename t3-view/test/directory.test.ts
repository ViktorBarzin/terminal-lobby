import { describe, expect, it } from "vitest";

import type { LobbyLayout, LobbySession } from "../src/lobby/api.ts";
import { SessionDirectory, SYSTEM_PROJECT, UNGROUPED_PROJECT } from "../src/shell/directory.ts";

const claude = (name: string, extra: Partial<LobbySession> = {}): LobbySession => ({
  name,
  created: 1,
  tool: "claude",
  origin: "user",
  owner: "wizard",
  ...extra,
});

const layout: LobbyLayout = {
  projects: [
    { name: "lobby", sessions: ["placed", "gone"], dir: "/home/wizard/code/lobby" },
    { name: "empty", sessions: [] },
  ],
  ungrouped: ["loose"],
};

describe("SessionDirectory", () => {
  it("lists Claude sessions only, grouped as the lobby's sidebar groups them", () => {
    const d = new SessionDirectory("wizard");
    d.update(
      [
        claude("placed"),
        claude("loose"),
        claude("named-project", { project: "lobby" }),
        claude("nowhere"),
        claude("qa-probe", { origin: "test" }),
        claude("agent-made", { caller: "bot" }),
        { name: "a-shell", created: 1, tool: "shell", owner: "wizard", origin: "user" },
        { name: "a-pi", created: 1, tool: "pi", owner: "wizard", origin: "user" },
      ],
      layout,
    );
    const where = Object.fromEntries(d.entries.map((e) => [e.name, e.projectId]));
    expect(where).toEqual({
      placed: "project:lobby",
      loose: UNGROUPED_PROJECT,
      "named-project": "project:lobby",
      nowhere: UNGROUPED_PROJECT,
      "qa-probe": SYSTEM_PROJECT,
      "agent-made": SYSTEM_PROJECT,
    });
    expect(d.projects.map((p) => [p.id, p.title, p.workspaceRoot])).toEqual([
      ["project:lobby", "lobby", "/home/wizard/code/lobby"],
      ["project:empty", "empty", "/home/wizard"],
      [UNGROUPED_PROJECT, "Ungrouped", "/home/wizard"],
      [SYSTEM_PROJECT, "System", "/home/wizard"],
    ]);
  });

  it("keys a session by its birth name, so the rename from its title keeps the thread", () => {
    const d = new SessionDirectory("wizard");
    d.update([claude("bw8k5gt9v314", { id: "$7" })], layout);
    expect(d.entries.map((e) => e.threadId)).toEqual(["bw8k5gt9v314"]);
    d.update([claude("fix-the-deploy", { id: "$7", bornAs: "bw8k5gt9v314" })], layout);
    expect(d.byId("bw8k5gt9v314")?.name).toBe("fix-the-deploy");
  });

  it("follows a hand-named session's rename by its tmux id", () => {
    const d = new SessionDirectory("wizard");
    d.update([claude("notes", { id: "$3" })], layout);
    d.update([claude("notes-renamed", { id: "$3" })], layout);
    expect(d.entries.map((e) => [e.threadId, e.name])).toEqual([["notes", "notes-renamed"]]);
  });

  it("puts sessions shared with the user in a project per owner, keyed with the owner", () => {
    const d = new SessionDirectory("wizard");
    d.update([claude("theirs", { owner: "emo", access: "ro", bornAs: "k9x" })], layout);
    expect(d.entries).toEqual([
      expect.objectContaining({
        threadId: "emo~k9x",
        name: "theirs",
        owner: "emo",
        access: "ro",
        projectId: "shared:emo",
      }),
    ]);
    expect(d.project("shared:emo")?.title).toBe("Shared by emo");
  });

  it("keeps the thread id T3 minted for a session it created, before and after the rename", () => {
    const d = new SessionDirectory("wizard", {
      alias: (minted) => (minted === "bw8k5gt9v314" ? "5992c13c-t3-draft" : undefined),
    });
    d.update([claude("bw8k5gt9v314", { id: "$9" })], layout);
    expect(d.entries.map((e) => e.threadId)).toEqual(["5992c13c-t3-draft"]);
    d.update([claude("say-hi", { id: "$9", bornAs: "bw8k5gt9v314" })], layout);
    expect(d.byId("5992c13c-t3-draft")?.name).toBe("say-hi");
  });

  describe("resolve, from the key the lobby frames a thread by", () => {
    it("finds a session T3 created by its birth name, under T3's own thread id", () => {
      const d = new SessionDirectory("wizard", {
        alias: (minted) => (minted === "bw8k5gt9v314" ? "5992c13c-t3-draft" : undefined),
      });
      d.update([claude("say-hi", { id: "$9", bornAs: "bw8k5gt9v314" })], layout);
      expect(d.resolve("bw8k5gt9v314")?.threadId).toBe("5992c13c-t3-draft");
      expect(d.resolve("5992c13c-t3-draft")?.threadId).toBe("5992c13c-t3-draft");
    });

    it("finds a hand-named session by its name now, after a rename this directory followed", () => {
      const d = new SessionDirectory("wizard");
      d.update([claude("notes", { id: "$3" })], layout);
      d.update([claude("notes-renamed", { id: "$3" })], layout);
      expect(d.resolve("notes-renamed")?.threadId).toBe("notes");
    });

    it("knows nothing of a key no session of the user's answers to", () => {
      const d = new SessionDirectory("wizard");
      d.update([claude("theirs", { owner: "emo", access: "ro", bornAs: "k9x" })], layout);
      expect(d.resolve("nope")).toBeUndefined();
      expect(d.resolve("k9x")).toBeUndefined();
      expect(d.resolve("theirs")).toBeUndefined();
    });
  });

  describe("lobbyKey, from a thread id back to the key the lobby frames it by", () => {
    it("names a session T3 created by its birth name, and its name now", () => {
      const d = new SessionDirectory("wizard", {
        alias: (minted) => (minted === "bw8k5gt9v314" ? "5992c13c-t3-draft" : undefined),
      });
      d.update([claude("say-hi", { id: "$9", bornAs: "bw8k5gt9v314" })], layout);
      expect(d.lobbyKey("5992c13c-t3-draft")).toEqual({ key: "bw8k5gt9v314", name: "say-hi" });
    });

    it("names a hand-named session by its name now, as the lobby keys it", () => {
      const d = new SessionDirectory("wizard");
      d.update([claude("notes", { id: "$3" })], layout);
      d.update([claude("notes-renamed", { id: "$3" })], layout);
      expect(d.lobbyKey("notes")).toEqual({ key: "notes-renamed", name: "notes-renamed" });
    });

    it("names nothing for someone else's thread or an unknown one", () => {
      const d = new SessionDirectory("wizard");
      d.update([claude("theirs", { owner: "emo", access: "ro", bornAs: "k9x" })], layout);
      expect(d.lobbyKey("emo~k9x")).toBeUndefined();
      expect(d.lobbyKey("nope")).toBeUndefined();
    });
  });
});
