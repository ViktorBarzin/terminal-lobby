import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { WATCH_KEY_PREFIX, clearResolvedWatch } from "../src/store/watchmode";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * The sidebar card in a tab acting as ANOTHER USER. `?as=` is read once at
 * module load by config.ts, so the switched tab is set up by mocking that
 * constant for this file rather than by rewriting the location mid-test.
 *
 * What the card must say: every session here opens as a viewer, so Attach as
 * has nothing left to choose — the rows are disabled and Watch only carries the
 * tick, rather than three live radio buttons that all lead to the same
 * read-only attach.
 */
vi.mock("../src/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config")>();
  return { ...actual, ACT_AS: "emo" };
});

const { SessionCard } = await import("../src/components/SessionCard");

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  attached: 0,
  lastActivity: 0,
  created: 0,
  ...over,
});

/** A store whose /whoami says this tab IS switched — the server's own answer. */
function lensStore(): LobbyStore {
  return {
    sessions: [],
    me: () => "emo",
    selected: () => null,
    whoami: () => ({ authentik: "vbarzin", osUser: "emo", realUser: "wizard" }),
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
  } as unknown as LobbyStore;
}

const card = (s: Session) =>
  render(() => (
    <SessionCard
      store={lensStore()}
      session={s}
      groupName=""
      tick={() => 0}
      confirm={() => true}
    />
  ));

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

describe("<SessionCard> in a tab acting as another user", () => {
  it("marks the card as one that will open as a viewer", () => {
    const { container } = card(session({ driven: false }));
    expect(container.querySelector(".tl-card-watch")).not.toBeNull();
  });

  it("disables all three Attach as rows and ticks Watch only", () => {
    const { container } = card(session());
    openMenu(container);
    const auto = menuItem(container, "Auto");
    const watch = menuItem(container, "Watch only");
    const control = menuItem(container, "Take control");
    expect(auto?.disabled).toBe(true);
    expect(watch?.disabled).toBe(true);
    expect(control?.disabled).toBe(true);
    expect(watch?.textContent).toContain("✓");
    expect(auto?.textContent).not.toContain("✓");
    expect(control?.textContent).not.toContain("✓");
  });

  it("says why, in the group's own label", () => {
    const { container } = card(session());
    openMenu(container);
    const label = container.querySelector(".tl-menu-label")?.textContent ?? "";
    expect(label).toMatch(/watching/i);
    expect(label).toMatch(/acting as/i);
  });

  // The stored choice is keyed by session NAME, so it is shared with your own
  // session of that name: a lens that could write would change how YOUR session
  // opens.
  it("records nothing even if the row is driven programmatically", () => {
    const { container } = card(session());
    openMenu(container);
    fireEvent.click(menuItem(container, "Take control")!);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBeNull();
  });
});
