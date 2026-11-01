import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import {
  claudeBackendFor,
  coercePrefs,
  createPrefsStore,
  PREF_DEFAULTS,
} from "../src/store/prefs";
import { SessionsPage } from "../src/components/settings/pages/SessionsPage";
import type { Whoami } from "../src/types/lobby";

/**
 * `session.claudeBackend`: where a user's new Claude session starts, T3 or a
 * tmux session. Unset follows the box's default for the user (whoami), and a
 * user with no T3 always starts in tmux (ADR-0046 decision 3).
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("session.claudeBackend", () => {
  it("defaults to unset", () => {
    expect(PREF_DEFAULTS.session.claudeBackend).toBe("");
    expect(coercePrefs({}).session.claudeBackend).toBe("");
  });

  it.each([
    ["t3", "t3"],
    ["tmux", "tmux"],
    ["T3", ""],
    ["docker", ""],
    [3, ""],
    [null, ""],
  ])("coerces %j to %j", (raw, want) => {
    expect(coercePrefs({ session: { claudeBackend: raw } }).session.claudeBackend).toBe(want);
  });

  const withT3 = (claudeBackend?: "t3" | "tmux"): Pick<Whoami, "t3" | "claudeBackend"> => ({
    t3: true,
    ...(claudeBackend ? { claudeBackend } : {}),
  });
  it.each([
    ["unset follows a T3 default", "", withT3("t3"), "t3"],
    ["unset follows a tmux default", "", withT3("tmux"), "tmux"],
    ["unset with no default is tmux", "", withT3(), "tmux"],
    ["the user's own choice wins", "tmux", withT3("t3"), "tmux"],
    ["either way", "t3", withT3("tmux"), "t3"],
    ["no T3 is always tmux", "t3", { t3: false, claudeBackend: "t3" }, "tmux"],
    ["an older server is tmux", "t3", {}, "tmux"],
    ["no whoami yet is tmux", "t3", null, "tmux"],
  ] as const)("%s", (_why, pref, who, want) => {
    expect(claudeBackendFor(pref, who)).toBe(want);
  });
});

describe("Settings > Sessions", () => {
  const prefsStore = () =>
    createPrefsStore({ fetchImpl: async () => new Response("{}", { status: 200 }) });

  it("offers T3 or the terminal lobby to a user with a T3, showing the effective one", () => {
    const prefs = prefsStore();
    const who: Whoami = { authentik: "w", osUser: "wizard", t3: true, claudeBackend: "t3" };
    const { container } = render(() => <SessionsPage prefs={prefs} whoami={() => who} />);
    const group = container.querySelector('[role="group"][aria-label="New Claude sessions run in"]')!;
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["T3", "Terminal lobby"]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(buttons[1]!);
    expect(prefs.prefs().session.claudeBackend).toBe("tmux");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers nothing T3 to a user without one", () => {
    const prefs = prefsStore();
    const who: Whoami = { authentik: "e", osUser: "emo" };
    const { container } = render(() => <SessionsPage prefs={prefs} whoami={() => who} />);
    expect(container.textContent).not.toContain("New Claude sessions run in");
    // The page's other row is still there.
    expect(container.textContent).toContain("Show when each session was last driven");
  });
});
