import { beforeEach, describe, expect, it } from "vitest";
import { sessionLabel } from "../src/types/lobby";
import { composeTitle } from "../src/notify/title";
import { createVisitStore, STATES_KEY, VISITS_KEY } from "../src/store/visits";

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
  /** The same session, under whatever name it is wearing. */
  const kept = (name: string, state = "done") => ({ name, id: "$3", state });

  // The store persists to localStorage and every createVisitStore() seeds from
  // it, so without this a visit stamped by an earlier case is still there for a
  // later one that reuses the same session name. Whether that mattered came
  // down to whether Date.now() had ticked -- isUnseen compares with a strict
  // `>` -- which made the last case in this block fail about half the time.
  beforeEach(() => {
    localStorage.removeItem(VISITS_KEY);
    localStorage.removeItem(STATES_KEY);
  });

  // The guarantee is unchanged: a rename must not resurrect work the user has
  // already read. What changed is HOW it is kept. There used to be an explicit
  // rename() driven by a `tl:session-renamed` window event, which only fired for
  // a rename made in the same tab — one from a second tab, the phone, or a shell
  // still pruned the record. Records are keyed by tmux's session id now, so the
  // rename carries itself and no notification is involved.
  it("carries a session's visit record across a rename", () => {
    const visits = createVisitStore({ visible: () => true });
    visits.observe([kept("deploy-the-thing")], "deploy-the-thing");
    expect(visits.isUnseen(kept("deploy-the-thing"))).toBe(false);

    visits.observe([kept("fix-the-parser")], null);

    expect(visits.isUnseen(kept("fix-the-parser"))).toBe(false);
  });

  it("carries it for a rename this tab was never told about", () => {
    const visits = createVisitStore({ visible: () => true });
    visits.observe([kept("old")], "old");
    // No event, no rename() call: just the next poll, with a different name.
    visits.observe([kept("new")], null);
    expect(visits.isUnseen(kept("new"))).toBe(false);
  });

  it("leaves other sessions alone", () => {
    const visits = createVisitStore({ visible: () => true });
    visits.observe([kept("a"), sess("b")], "a");
    visits.observe([kept("renamed"), sess("b")], null);
    expect(visits.isUnseen(kept("renamed"))).toBe(false);
    expect(visits.isUnseen(sess("b"))).toBe(true); // never looked at
  });

  it("does not invent a record for a session that never had one", () => {
    const visits = createVisitStore({ visible: () => true });
    visits.observe([kept("a")], null); // never looked at it
    visits.observe([kept("b")], null);
    expect(visits.isUnseen(kept("b"))).toBe(true);
  });

  it("does not hand a NEW session the record of a dead one with the same name", () => {
    const visits = createVisitStore({ visible: () => true });
    visits.observe([{ name: "work", id: "$1", state: "done" }], "work");
    visits.observe([{ name: "work", id: "$2", state: "done" }], null);
    expect(visits.isUnseen({ name: "work", id: "$2", state: "done" })).toBe(true);
  });
});
