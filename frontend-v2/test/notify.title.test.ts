import { describe, it, expect } from "vitest";
import { composeTitle, titleBadge, type TitleSession } from "../src/notify/title";

describe("titleBadge — count + precedence", () => {
  it("is '' when nothing is notable", () => {
    expect(titleBadge({ awaiting: 0, running: 0, unseenDone: 0 })).toBe("");
  });
  it("awaiting outranks running and done", () => {
    expect(titleBadge({ awaiting: 2, running: 3, unseenDone: 4 })).toBe("(2●) ");
  });
  it("running outranks done", () => {
    expect(titleBadge({ awaiting: 0, running: 3, unseenDone: 4 })).toBe("(3⋯) ");
  });
  it("unseen-done shows when nothing higher", () => {
    expect(titleBadge({ awaiting: 0, running: 0, unseenDone: 4 })).toBe("(4✓) ");
  });
});

describe("composeTitle", () => {
  const base = {
    attentionSession: null,
    activeSession: null,
    osUser: "wizard",
    baseTitle: "terminal-lobby",
  };

  it("shows the base title with nothing active or notable", () => {
    expect(composeTitle({ ...base, sessions: [] })).toBe("terminal-lobby");
  });

  it("prefixes the max-state count badge", () => {
    const sessions: TitleSession[] = [
      { name: "a", state: "awaiting" },
      { name: "b", state: "running" },
    ];
    expect(composeTitle({ ...base, sessions })).toBe("(1●) terminal-lobby");
  });

  it("shows the active session's live pane command", () => {
    const sessions: TitleSession[] = [
      { name: "worktree", state: "running", pane_current_command: "claude" },
    ];
    expect(composeTitle({ ...base, sessions, activeSession: "worktree" })).toBe(
      "(1⋯) claude — worktree",
    );
  });

  it("falls back to tmux: <user>/<session> when no command is known", () => {
    const sessions: TitleSession[] = [{ name: "worktree", state: "running" }];
    expect(composeTitle({ ...base, sessions, activeSession: "worktree" })).toBe(
      "(1⋯) tmux: wizard/worktree",
    );
  });

  it("leads with the '● <session>' attention prefix while latched", () => {
    const sessions: TitleSession[] = [{ name: "a", state: "awaiting" }];
    expect(composeTitle({ ...base, sessions, attentionSession: "a" })).toBe(
      "● a (1●) terminal-lobby",
    );
  });

  it("honors a custom isUnseen predicate for the done count", () => {
    const sessions: TitleSession[] = [
      { name: "a", state: "done" },
      { name: "b", state: "done" },
    ];
    // only 'a' counts as unseen → badge shows 1, not 2.
    expect(composeTitle({ ...base, sessions, isUnseen: (s) => s.name === "a" })).toBe(
      "(1✓) terminal-lobby",
    );
  });

  it("drops the (N✓) badge once every finished session has been seen", () => {
    const sessions: TitleSession[] = [
      { name: "a", state: "done" },
      { name: "b", state: "done" },
    ];
    expect(composeTitle({ ...base, sessions, isUnseen: () => false })).toBe("terminal-lobby");
  });

  it("leaves quiet (Caller or System) sessions out of every count", () => {
    const sessions: TitleSession[] = [
      { name: "mine", state: "awaiting" },
      { name: "muse", state: "awaiting", quiet: true },
      { name: "muse-run", state: "running", quiet: true },
      { name: "muse-done", state: "done", quiet: true },
    ];
    expect(composeTitle({ ...base, sessions })).toBe("(1●) terminal-lobby");
    expect(composeTitle({ ...base, sessions: sessions.slice(1) })).toBe("terminal-lobby");
  });

  it("still names an active quiet session in the body", () => {
    const sessions: TitleSession[] = [
      { name: "muse", state: "done", quiet: true, pane_current_command: "claude" },
    ];
    expect(composeTitle({ ...base, sessions, activeSession: "muse" })).toBe("claude — muse");
  });
});
