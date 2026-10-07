import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { closeShare, shareTarget } from "../src/store/share-dialog";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * Share… on the sidebar card's ⋯ menu, in an ordinary tab: offered on your own
 * session running Claude, not on one somebody shared with you or a plain
 * shell, and it opens the app-wide dialog for the session by tmux's id. The lens case is in
 * SessionCard.lens.test.tsx, which mocks `?as=`.
 */

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  id: "$7",
  attached: 0,
  lastActivity: 0,
  created: 0,
  tool: "claude",
  ...over,
});

function store(): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard" }),
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
  } as unknown as LobbyStore;
}

const card = (s: Session) =>
  render(() => <SessionCard store={store()} session={s} groupName="" tick={() => 0} />);

const shareItem = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button.tl-menu-item")).find((b) =>
    b.textContent?.includes("Share"),
  );
const openMenu = (c: HTMLElement) =>
  fireEvent.click(c.querySelector<HTMLButtonElement>("button.tl-card-actions")!);

afterEach(() => {
  cleanup();
  closeShare();
});

describe("<SessionCard> Share…", () => {
  it("is offered on your own session and opens the dialog by session id", () => {
    const { container } = card(session({ owner: "wizard" }));
    openMenu(container);
    const item = shareItem(container);
    expect(item).toBeDefined();
    fireEvent.click(item!);
    expect(shareTarget()).toEqual({ id: "$7", name: "main" });
  });

  it("is offered on a session with no owner field (a server that predates it)", () => {
    const { container } = card(session());
    openMenu(container);
    expect(shareItem(container)).toBeDefined();
  });

  it("is not offered on a session shared with you", () => {
    // A foreign card draws no ⋯ at all today; if it ever gains one, Share…
    // must still stay off it.
    const { container } = card(session({ owner: "emo", access: "rw" }));
    const actions = container.querySelector<HTMLButtonElement>("button.tl-card-actions");
    if (actions) fireEvent.click(actions);
    expect(shareItem(container)).toBeUndefined();
  });

  it("is not offered on a plain shell, which has no conversation to share", () => {
    const { container } = card(session({ owner: "wizard", tool: "shell" }));
    openMenu(container);
    expect(shareItem(container)).toBeUndefined();
  });
});
