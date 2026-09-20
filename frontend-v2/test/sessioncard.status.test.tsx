import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { stateLabel } from "../src/components/lobby.logic";
import { SETTABLE_STATES, type Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * Setting a session's state by hand, from the card's ⋯ menu.
 *
 * The dot comes from hooks (ADR-0001) and has a documented history of reading
 * wrong: an interrupt typed straight at the pty, a dialog the harness took
 * down without reporting it, a background id nobody retired. Each was fixed
 * where it broke, and in the meantime the only way out was to wait for the
 * session to say something new. These three rows are the way out.
 *
 * What they are NOT is a mode. The write goes to the same option the hooks
 * write, so the next hook event replaces it — which is why nothing here has
 * an "unset" row, a lock, or a marker saying a person chose this.
 */

const session = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 0,
  created: 0,
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

/** The Status rows, in the order they are drawn. */
const statusRows = (container: Element) =>
  [...container.querySelectorAll("[role=menuitemradio]")].filter((b) =>
    SETTABLE_STATES.some((st) => b.textContent?.includes(stateLabel(st))),
  );

describe("<SessionCard> — setting the status by hand", () => {
  it("offers the three stamped states, in the words the dot uses", () => {
    const { container, unmount } = openMenu(session("a", { state: "running" }));
    expect(statusRows(container).map((b) => b.textContent?.trim())).toEqual([
      "✓ " + stateLabel("running"),
      stateLabel("awaiting"),
      stateLabel("done"),
    ]);
    unmount();
  });

  it("marks the state the session is in, so the menu says where it starts", () => {
    const { container, unmount } = openMenu(session("a", { state: "awaiting" }));
    const checked = statusRows(container).filter((b) => b.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toContain(stateLabel("awaiting"));
    unmount();
  });

  it("writes the state that was clicked", async () => {
    const setState = vi.fn(async () => true);
    const store = cardStore({ setState: setState as unknown as LobbyStore["setState"] });
    const { container, unmount } = openMenu(session("stuck", { state: "running" }), store);
    const done = statusRows(container).find((b) => b.textContent?.includes(stateLabel("done")))!;
    fireEvent.click(done);
    expect(setState).toHaveBeenCalledWith("stuck", "done");
    unmount();
  });

  it("closes the menu on the press, like every other action does", () => {
    const { container, unmount } = openMenu(session("a", { state: "running" }));
    fireEvent.click(statusRows(container)[2]!);
    expect(container.querySelector(".tl-menu")).toBeNull();
    unmount();
  });

  it("offers nothing on a session no Claude has run in", () => {
    // A plain shell has no dot, and a stamp would grow it one. The server
    // refuses the write, so the rows would be a button that only toasts.
    const { container, unmount } = openMenu(session("shell", { tool: "shell" }));
    expect(statusRows(container)).toHaveLength(0);
    unmount();
  });

  it("offers nothing on a suspended session", () => {
    // Its dot is derived from @tl_suspended, not stamped, and the list forces
    // it whatever the option says. Resume is the way back, not a status row.
    const { container, unmount } = openMenu(
      session("napping", { state: "suspended", suspendedAt: 1_700_000_000 }),
    );
    expect(statusRows(container)).toHaveLength(0);
    unmount();
  });

  it("offers nothing on somebody else's session", () => {
    // The whole ⋯ menu is hidden for a foreign row: correcting a state is an
    // action on the owner's session, and this card cannot even rename it.
    const { container, unmount } = openMenu(
      session("theirs", { state: "running", owner: "emo", access: "ro" }),
    );
    expect(container.querySelector(".tl-card-actions")).toBeNull();
    expect(statusRows(container)).toHaveLength(0);
    unmount();
  });
});
