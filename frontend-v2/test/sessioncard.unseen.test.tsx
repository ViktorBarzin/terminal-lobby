import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * Which sessions are unread, in the list.
 *
 * The card used to answer this with `state === "done"`, so every finished
 * session drew the unread treatment and the dimmed "seen" variant in
 * sidebar.css could not occur. The app-icon badge counts the real set, so the
 * two disagreed and the number named something the sidebar could not point at.
 */
const session = (name: string, state: Session["state"] = "done"): Session => ({
  name,
  attached: 0,
  lastActivity: 0,
  created: 0,
  state,
});

/** Only the members the card's render path reads (mirrors SessionCard.lens). */
function cardStore(): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard", realUser: "wizard" }),
    hold: () => () => {},
    workingSince: () => null,
    lastDriven: () => null,
    dragName: () => null,
    dropSpot: () => null,
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
  } as unknown as LobbyStore;
}

function renderCard(s: Session, unseen: boolean) {
  return render(() => (
    <SessionCard store={cardStore()} session={s} groupName="" tick={() => 0} isUnseen={() => unseen} />
  ));
}

describe("SessionCard — the unread marker", () => {
  it("marks a finished session you have not looked at", () => {
    const { container, unmount } = renderCard(session("a"), true);
    expect(container.querySelectorAll(".tl-state-unseen")).toHaveLength(1);
    expect(container.querySelectorAll(".tl-card-unseen")).toHaveLength(1);
    unmount();
  });

  it("leaves a finished session you HAVE looked at unmarked", () => {
    const { container, unmount } = renderCard(session("a"), false);
    expect(container.querySelectorAll(".tl-state-unseen")).toHaveLength(0);
    expect(container.querySelectorAll(".tl-card-unseen")).toHaveLength(0);
    unmount();
  });

  it("says so in words, for a tooltip and a screen reader", () => {
    const { container, unmount } = renderCard(session("a"), true);
    const dot = container.querySelector(".tl-state-dot");
    expect(dot?.getAttribute("title")).toBe("Done, not seen yet");
    expect(dot?.getAttribute("aria-label")).toBe("Done, not seen yet");
    expect(container.querySelector(".tl-card")?.getAttribute("aria-label")).toContain(
      "Done, not seen yet",
    );
    unmount();
  });

  it("says plain Done once it has been seen", () => {
    const { container, unmount } = renderCard(session("a"), false);
    expect(container.querySelector(".tl-state-dot")?.getAttribute("title")).toBe("Done");
    unmount();
  });

  it("never marks a running or awaiting session, whatever the predicate says", () => {
    for (const st of ["running", "awaiting"] as const) {
      const { container, unmount } = renderCard(session("a", st), true);
      expect(container.querySelectorAll(".tl-state-unseen")).toHaveLength(0);
      unmount();
    }
  });

  it("defaults to unmarked when no predicate is supplied", () => {
    const { container, unmount } = render(() => (
      <SessionCard store={cardStore()} session={session("a")} groupName="" tick={() => 0} />
    ));
    expect(container.querySelectorAll(".tl-state-unseen")).toHaveLength(0);
    unmount();
  });
});
