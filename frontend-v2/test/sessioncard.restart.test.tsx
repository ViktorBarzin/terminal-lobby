import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * Restart, from the card's ⋯ menu: stop the session's Claude and start it again
 * on the same conversation, so it loads a new binary or new settings.
 *
 * An idle session restarts on the press. A busy one asks first, because the
 * restart cuts the turn in flight (or the question on screen).
 */

const session = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 0,
  created: 0,
  tool: "claude",
  ...over,
});

function cardStore(over: Partial<LobbyStore> = {}): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard", realUser: "wizard" }),
    hold: () => () => {},
    workingSince: () => null,
    lastDriven: () => null,
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
    select: () => {},
    setState: async () => true,
    restart: async () => true,
    ...over,
  } as unknown as LobbyStore;
}

function openMenu(s: Session, store: LobbyStore = cardStore()) {
  const r = render(() => (
    <SessionCard
      store={store}
      session={s}
      groupName=""
      tick={() => 0}
      isUnseen={() => false}
      showLastActive={() => true}
    />
  ));
  const actions = r.container.querySelector(".tl-card-actions");
  if (actions) fireEvent.click(actions);
  return r;
}

const restartItem = (container: Element) =>
  [...container.querySelectorAll("[role=menuitem]")].find(
    (b) => b.textContent?.trim() === "Restart",
  );

afterEach(() => vi.restoreAllMocks());

describe("<SessionCard> — restart", () => {
  it("offers Restart on a Claude session", () => {
    const { container, unmount } = openMenu(session("a", { state: "done" }));
    expect(restartItem(container)).toBeDefined();
    unmount();
  });

  it.each([
    ["a plain shell", session("sh", { tool: "shell" })],
    ["a codex session", session("cx", { tool: "codex" })],
    ["a suspended session", session("zz", { state: "suspended", suspendedAt: 1_700_000_000 })],
  ])("offers nothing on %s", (_why, s) => {
    // A shell has no Claude to restart; a suspended session comes back on the
    // new binary just by being opened.
    const { container, unmount } = openMenu(s);
    expect(restartItem(container)).toBeUndefined();
    unmount();
  });

  it("restarts an idle session on the press, without asking", () => {
    const restart = vi.fn(async () => true);
    const ask = vi.spyOn(window, "confirm");
    const store = cardStore({ restart: restart as unknown as LobbyStore["restart"] });
    const { container, unmount } = openMenu(session("notes", { state: "done" }), store);
    fireEvent.click(restartItem(container)!);
    expect(ask).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledWith("notes");
    expect(container.querySelector(".tl-menu")).toBeNull();
    unmount();
  });

  it.each(["running", "awaiting"] as const)("asks before cutting a session that is %s", (state) => {
    const restart = vi.fn(async () => true);
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    const store = cardStore({ restart: restart as unknown as LobbyStore["restart"] });
    const { container, unmount } = openMenu(session("busy", { state }), store);
    fireEvent.click(restartItem(container)!);
    expect(ask).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();

    ask.mockReturnValue(true);
    fireEvent.click(container.querySelector(".tl-card-actions")!);
    fireEvent.click(restartItem(container)!);
    expect(restart).toHaveBeenCalledWith("busy");
    unmount();
  });
});
