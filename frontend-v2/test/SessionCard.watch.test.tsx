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
