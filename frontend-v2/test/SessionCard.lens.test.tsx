import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { WATCH_KEY_PREFIX, clearResolvedWatch } from "../src/store/watchmode";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * The sidebar card in a tab acting as ANOTHER USER. `?as=` is read once at
 * module load by config.ts, so the switched tab is set up by mocking that
 * constant for this file rather than by rewriting the location mid-test.
 *
 * What the card must say: a session here opens as a viewer unless you say
 * otherwise, and Attach as is where you say it. The choice is stored under the
 * target, so it cannot decide how your own session of that name opens.
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
    // The card reads both while rendering its drop indicator (touch reorder).
    dragName: () => null,
    dropSpot: () => null,
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

  it("offers all three Attach as rows, with Auto meaning watch", () => {
    const { container } = card(session());
    openMenu(container);
    const auto = menuItem(container, "Auto");
    const watch = menuItem(container, "Watch only");
    const control = menuItem(container, "Take control");
    expect(auto?.disabled).toBe(false);
    expect(watch?.disabled).toBe(false);
    expect(control?.disabled).toBe(false);
    // Auto is the state, and here it resolves to watching rather than to
    // "watch if busy" — the row says which.
    expect(auto?.textContent).toContain("✓");
    expect(auto?.textContent).toMatch(/watch/i);
    expect(control?.textContent).not.toContain("✓");
  });

  it("says whose account the rows apply to", () => {
    const { container } = card(session());
    openMenu(container);
    const label = container.querySelector(".tl-menu-label")?.textContent ?? "";
    expect(label).toMatch(/emo/);
  });

  it("records Take control under the target, leaving your own session alone", async () => {
    const { container } = card(session());
    openMenu(container);
    fireEvent.click(menuItem(container, "Take control")!);
    await waitFor(() =>
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "as:emo:main")).toBe("rw"),
    );
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBeNull();
    expect(container.querySelector(".tl-card-watch")).toBeNull();
  });

  it("reads back a stored lens choice rather than your own", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "ro"); // your own: watch
    localStorage.setItem(WATCH_KEY_PREFIX + "as:emo:main", "rw"); // emo's: drive
    const { container } = card(session());
    expect(container.querySelector(".tl-card-watch")).toBeNull();
    openMenu(container);
    expect(menuItem(container, "Take control")?.textContent).toContain("✓");
  });
});
