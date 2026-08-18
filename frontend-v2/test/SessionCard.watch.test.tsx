import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import { WATCH_KEY_PREFIX, publishResolvedWatch, clearResolvedWatch } from "../src/store/watchmode";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * The sidebar card's Watch surface: a mark saying how this device will attach,
 * and a menu to decide it BEFORE opening the session — which is the only moment
 * that helps, since v2 is terminal-first and selecting a session attaches in
 * the same tick.
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
    // The card reads /whoami to know whether this tab is acting as another user
    // (which locks Attach as to watching). An ordinary tab: no realUser.
    whoami: () => ({ authentik: "vbarzin", osUser: "wizard" }),
    // A running session shows its live working timer instead of a relative
    // time; the card asks the store when the turn started.
    workingSince: () => Date.now() - 5000,
    // The card holds the poll open while its menu is up; the real store returns
    // a release function.
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
  } as unknown as LobbyStore;
}

const card = (s: Session) =>
  render(() => (
    <SessionCard
      store={stubStore()}
      session={s}
      groupName=""
      tick={() => 0}
      confirm={() => true}
    />
  ));

const badge = (c: HTMLElement) => c.querySelector(".tl-card-watch");
const menuItem = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button.tl-menu-item")).find((b) =>
    b.textContent?.includes(text),
  );
const openMenu = (c: HTMLElement) =>
  fireEvent.click(c.querySelector<HTMLButtonElement>("button.tl-card-actions")!);

beforeEach(() => {
  localStorage.clear();
  clearResolvedWatch("main");
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]"))));
});

describe("<SessionCard> — the watch marker", () => {
  it("is absent for an ordinary session nobody is driving", () => {
    const { container } = card(session({ driven: false }));
    expect(badge(container)).toBeNull();
  });

  it("appears when someone is already driving, because you would join as a viewer", () => {
    const { container } = card(session({ driven: true }));
    expect(badge(container)).not.toBeNull();
  });

  it("appears when you have set Watch only, even on an idle session", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "ro");
    const { container } = card(session({ driven: false }));
    expect(badge(container)).not.toBeNull();
  });

  it("is absent when you have taken control, even though it is driven", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "rw");
    const { container } = card(session({ driven: true }));
    expect(badge(container)).toBeNull();
  });

  /**
   * The trap this exists to avoid: `driven` counts OUR OWN client, so a session
   * this browser is driving reads as driven. Without deferring to the open
   * view's resolved state, its own card would claim it opens as a viewer.
   */
  it("defers to the open view rather than to a driven count that includes us", () => {
    publishResolvedWatch("main", false); // the live view is DRIVING it
    const { container } = card(session({ driven: true }));
    expect(
      badge(container),
      "the card marked a session this browser is driving as a viewer",
    ).toBeNull();
  });

  it("still marks an open session the view resolved as watching", () => {
    publishResolvedWatch("main", true);
    const { container } = card(session({ driven: false }));
    expect(badge(container)).not.toBeNull();
  });
});

describe("<SessionCard> — the Attach as menu", () => {
  it("offers all three states and marks Auto as the initial one", () => {
    const { container } = card(session());
    openMenu(container);
    for (const label of ["Auto", "Watch only", "Take control"]) {
      expect(menuItem(container, label), `missing "${label}"`).toBeTruthy();
    }
    expect(menuItem(container, "Auto")!.getAttribute("aria-checked")).toBe("true");
  });

  it("records a choice without opening the session", async () => {
    const { container } = card(session());
    openMenu(container);
    fireEvent.click(menuItem(container, "Watch only")!);
    await waitFor(() =>
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("ro"),
    );
  });

  it("Take control is storable, so the automatic rule cannot undo it", async () => {
    const { container } = card(session({ driven: true }));
    openMenu(container);
    fireEvent.click(menuItem(container, "Take control")!);
    await waitFor(() =>
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("rw"),
    );
    expect(badge(container)).toBeNull();
  });

  /**
   * Without a way back to Auto, a session taken control of once would never
   * auto-join as a viewer again on this device — the fix would quietly stop
   * applying to it, with nothing in the UI explaining why.
   */
  it("Auto clears an explicit choice and restores the automatic behaviour", async () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "rw");
    const { container } = card(session({ driven: true }));
    expect(badge(container)).toBeNull();

    openMenu(container);
    fireEvent.click(menuItem(container, "Auto")!);
    await waitFor(() =>
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBeNull(),
    );
    expect(badge(container)).not.toBeNull(); // driven again, so a viewer again
  });

  it("closes the menu after a choice", async () => {
    const { container } = card(session());
    openMenu(container);
    expect(container.querySelector(".tl-menu")).not.toBeNull();
    fireEvent.click(menuItem(container, "Watch only")!);
    await waitFor(() => expect(container.querySelector(".tl-menu")).toBeNull());
  });
});

/**
 * The card's relative time is LAST DRIVEN, not tmux's activity.
 *
 * tmux bumps #{session_activity} on any attach, read-only included, so opening a
 * session to watch it used to reset the "5m ago" — the opposite of what Watch
 * mode promises, which is that a viewer leaves the session as it found it.
 */
describe("<SessionCard> — the relative time answers 'when was this last driven'", () => {
  const withTime = (over: Partial<Session>) =>
    card(session({ state: "", lastActivity: 0, created: 0, ...over }));

  it("shows the drive time, not the activity time", () => {
    const now = Math.floor(Date.now() / 1000);
    const { container } = render(() => (
      <SessionCard
        store={stubStore()}
        session={session({
          state: "",
          lastDrive: now - 3 * 3600, // driven 3h ago
          lastActivity: now - 5,     // "active" 5s ago, because a watcher just attached
          created: now - 4 * 3600,
        })}
        groupName=""
        tick={() => 0}
        confirm={() => true}
        showLastActive={() => true}
      />
    ));
    const t = container.querySelector(".tl-card-time")?.textContent ?? "";
    expect(t).toMatch(/3h/);
    expect(t).not.toMatch(/5s|now/);
  });

  it("says nothing rather than falling back to the activity time", () => {
    const now = Math.floor(Date.now() / 1000);
    const { container } = render(() => (
      <SessionCard
        store={stubStore()}
        session={session({ state: "", lastActivity: now - 5, created: now - 60 })}
        groupName=""
        tick={() => 0}
        confirm={() => true}
        showLastActive={() => true}
      />
    ));
    expect(container.querySelector(".tl-card-time")).toBeNull();
  });

  it("still yields to the live working timer on a running session", () => {
    const now = Math.floor(Date.now() / 1000);
    const { container } = withTime({ state: "running", lastDrive: now - 7200 });
    expect(container.querySelector(".tl-card-time")?.textContent ?? "").not.toMatch(/2h/);
  });
});
