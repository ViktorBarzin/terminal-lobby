import { describe, it, expect } from "vitest";
import {
  focusedSession,
  shouldReport,
  FOCUS_HEARTBEAT_MS,
  FOCUS_TICK_MS,
} from "../src/notify/focus";

/**
 * What this device tells the server it is showing, and how often.
 *
 * The rule the whole change turns on: only the session actually on screen, on a
 * device that is actually being looked at, is withheld — and only from THAT
 * device. Everything else answers `""`, which silences nothing.
 */
describe("what to report", () => {
  it("names the session on screen", () => {
    expect(focusedSession({ visible: true, focused: true, selected: "billing" })).toBe("billing");
  });

  it("says nothing for the lobby list", () => {
    expect(focusedSession({ visible: true, focused: true, selected: null })).toBe("");
  });

  it("says nothing while the page is hidden", () => {
    expect(focusedSession({ visible: false, focused: true, selected: "billing" })).toBe("");
  });

  // A visible window behind another one is not being read, and this is exactly
  // the desktop case the away gate has always covered (document.hasFocus).
  it("says nothing while the window is unfocused", () => {
    expect(focusedSession({ visible: true, focused: false, selected: "billing" })).toBe("");
  });
});

describe("when to report again", () => {
  it("says the first real thing it has to say", () => {
    expect(shouldReport(null, "billing", 1_000)).toBe(true);
  });

  // An absent record and a "" record mean the same thing to the server, so
  // there is nothing to announce until there is.
  it("stays quiet when it starts with nothing to say", () => {
    expect(shouldReport(null, "", 1_000)).toBe(false);
  });

  it("announces a move to another session at once", () => {
    const prev = { session: "billing", at: 1_000 };
    expect(shouldReport(prev, "invoices", 1_100)).toBe(true);
  });

  // Looking away is announced, not waited out: the notification you want is the
  // one for the session you just left.
  it("announces looking away at once", () => {
    const prev = { session: "billing", at: 1_000 };
    expect(shouldReport(prev, "", 1_100)).toBe(true);
  });

  it("refreshes a standing report on the heartbeat", () => {
    const prev = { session: "billing", at: 1_000 };
    expect(shouldReport(prev, "billing", 1_000 + FOCUS_HEARTBEAT_MS - 1)).toBe(false);
    expect(shouldReport(prev, "billing", 1_000 + FOCUS_HEARTBEAT_MS)).toBe(true);
  });

  it("never heartbeats an empty report", () => {
    const prev = { session: "", at: 1_000 };
    expect(shouldReport(prev, "", 1_000 + 10 * FOCUS_HEARTBEAT_MS)).toBe(false);
  });

  // The refresh has to land well inside the server's window or a session you
  // are staring at starts buzzing (tmux-api pushfocus.go focusTTL = 90s).
  it("refreshes well inside the server's 90-second TTL", () => {
    expect(FOCUS_HEARTBEAT_MS).toBeLessThan(90_000 / 1.5);
  });

  // The wake-up has to be finer than the heartbeat, or every refresh lands late
  // by up to a whole tick.
  it("wakes more often than it reports", () => {
    expect(FOCUS_TICK_MS).toBeLessThan(FOCUS_HEARTBEAT_MS / 2);
  });
});
