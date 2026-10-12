import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { sharedTitle } from "../src/components/lobby.logic";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * A shared session stands out in the sidebar (ADR-0043): a coloured ring round
 * the row, on the owner's side for a session they invited someone to and on the
 * guest's side for one shared with them. The owner's row also names who.
 */

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  attached: 0,
  lastActivity: 0,
  created: 0,
  ...over,
});

function stubStore(): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "alice", osUser: "wizard" }),
    workingSince: () => Date.now() - 5000,
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
  } as unknown as LobbyStore;
}

const card = (s: Session) =>
  render(() => <SessionCard store={stubStore()} session={s} groupName="" tick={() => 0} />);

const row = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-card")!;
const chip = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-card-guests");

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]"))),
  );
});

describe("<SessionCard> — shared sessions", () => {
  it("is unmarked when nobody else can open it", () => {
    const { container } = card(session());
    expect(row(container).classList.contains("tl-card-shared")).toBe(false);
    expect(chip(container)).toBeNull();
  });

  it("rings your own session once someone is invited, and names them", () => {
    const { container } = card(
      session({ owner: "wizard", guests: [{ name: "emil.barzin", mode: "rw" }] }),
    );
    expect(row(container).classList.contains("tl-card-shared")).toBe(true);
    expect(chip(container)?.textContent).toContain("emil.barzin");
    expect(chip(container)?.title).toBe("Shared with emil.barzin (drive)");
  });

  it("rings a session someone shared with you, without a guest chip", () => {
    const { container } = card(session({ owner: "emil.barzin", access: "ro" }));
    expect(row(container).classList.contains("tl-card-shared")).toBe(true);
    expect(chip(container)).toBeNull();
  });

  it("says it is shared to a screen reader", () => {
    const { container } = card(
      session({ owner: "wizard", guests: [{ name: "emil.barzin", mode: "ro" }] }),
    );
    expect(row(container).getAttribute("aria-label")).toContain("shared with emil.barzin");
  });
});

describe("sharedTitle", () => {
  it("lists every guest with what they may do", () => {
    expect(
      sharedTitle([
        { name: "ana", mode: "ro" },
        { name: "emil.barzin", mode: "rw" },
      ]),
    ).toBe("Shared with ana (watch), emil.barzin (drive)");
  });
});
