import { describe, expect, it } from "vitest";
import { sessionLabel } from "../src/types/lobby";
import { composeTitle } from "../src/notify/title";
import { createVisitStore } from "../src/store/visits";

describe("sessionLabel", () => {
  it("prefers the title", () => {
    expect(sessionLabel({ name: "deploy-the-thing", title: "Deploy the thing 🚀" })).toBe(
      "Deploy the thing 🚀",
    );
  });

  it("falls back to the name — where every pre-title session sits", () => {
    expect(sessionLabel({ name: "work" })).toBe("work");
    expect(sessionLabel({ name: "work", title: "" })).toBe("work");
  });
});

describe("tab title", () => {
  const base = { osUser: "wizard", baseTitle: "Terminal", attentionSession: null };

  it("shows the title, not the slug", () => {
    const got = composeTitle({
      ...base,
      sessions: [
        { name: "deploy-the-thing", title: "Deploy the thing", pane_current_command: "claude" },
      ],
      activeSession: "deploy-the-thing",
    });
    expect(got).toBe("claude — Deploy the thing");
  });

  it("keeps the name when the session has no title", () => {
    const got = composeTitle({
      ...base,
      sessions: [{ name: "work", pane_current_command: "claude" }],
      activeSession: "work",
    });
    expect(got).toBe("claude — work");
  });

  it("uses the title in the tmux:<user>/<session> fallback too", () => {
    const got = composeTitle({
      ...base,
      sessions: [{ name: "deploy-the-thing", title: "Deploy the thing" }],
      activeSession: "deploy-the-thing",
    });
    expect(got).toBe("tmux: wizard/Deploy the thing");
  });

  it("uses the title in the attention latch", () => {
    const got = composeTitle({
      ...base,
      sessions: [{ name: "deploy-the-thing", title: "Deploy the thing", state: "awaiting" }],
      attentionSession: "deploy-the-thing",
      activeSession: null,
    });
    expect(got).toBe("● Deploy the thing (1●) Terminal");
  });

  it("falls back to the name for a session the poll has not caught up with", () => {
    const got = composeTitle({
      ...base,
      sessions: [],
      attentionSession: "gone-already",
      activeSession: null,
    });
    expect(got).toBe("● gone-already Terminal");
  });
});

describe("visit store: following a rename", () => {
  const sess = (name: string, state = "done") => ({ name, state });

  it("carries a session's visit record to its new name", () => {
    // Without this, observe() prunes the old name as dead and the new one looks
    // never-visited — so a completion the user already watched land comes back
    // as an unseen green tick.
    const visits = createVisitStore();
    visits.observe([sess("deploy-the-thing")], "deploy-the-thing");
    expect(visits.isUnseen(sess("deploy-the-thing"))).toBe(false);

    visits.rename("deploy-the-thing", "fix-the-parser");
    visits.observe([sess("fix-the-parser")], null);

    expect(visits.isUnseen(sess("fix-the-parser"))).toBe(false);
  });

  it("leaves other sessions alone", () => {
    const visits = createVisitStore();
    visits.observe([sess("a"), sess("b")], "a");
    visits.rename("a", "renamed");
    visits.observe([sess("renamed"), sess("b")], null);
    expect(visits.isUnseen(sess("renamed"))).toBe(false);
    expect(visits.isUnseen(sess("b"))).toBe(true); // never looked at
  });

  it("is a no-op when the name did not move", () => {
    const visits = createVisitStore();
    visits.observe([sess("a")], "a");
    visits.rename("a", "a");
    visits.observe([sess("a")], null);
    expect(visits.isUnseen(sess("a"))).toBe(false);
  });

  it("does not invent a record for a session that never had one", () => {
    const visits = createVisitStore();
    visits.observe([sess("a")], null); // never looked at it
    visits.rename("a", "b");
    visits.observe([sess("b")], null);
    expect(visits.isUnseen(sess("b"))).toBe(true);
  });
});
