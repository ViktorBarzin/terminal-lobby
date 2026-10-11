import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { SessionCard } from "../src/components/SessionCard";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * A session somebody shared with you (ADR-0043): the ⋯ menu offers only what
 * a guest may do. A driver renames and kills, asked first since there is no
 * undo; anyone who came in through a share can leave it. Every call names the
 * owner, so tmux-api acts in their server.
 */

const session = (over: Partial<Session> = {}): Session => ({
  name: "main",
  id: "$7",
  attached: 0,
  lastActivity: 0,
  created: 0,
  tool: "claude",
  owner: "emo",
  access: "rw",
  ...over,
});

function store(refresh = vi.fn(async () => {})): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard" }),
    hold: () => () => {},
    layout: () => ({ version: 1, projects: [], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
    refresh,
  } as unknown as LobbyStore;
}

const card = (s: Session, st = store()) =>
  render(() => <SessionCard store={st} session={s} groupName="" tick={() => 0} />);

const items = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button.tl-menu-item")).map((b) =>
    b.textContent?.trim(),
  );
const item = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button.tl-menu-item")).find(
    (b) => b.textContent?.trim() === text,
  );
const openMenu = (c: HTMLElement) =>
  fireEvent.click(c.querySelector<HTMLButtonElement>("button.tl-card-actions")!);

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(null, { status: 204 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<SessionCard> as a guest", () => {
  it("offers a driver Rename, Kill and Leave, and nothing of the owner's", () => {
    const { container } = card(session());
    openMenu(container);
    expect(items(container)).toEqual(["Rename", "Kill…", "Leave"]);
  });

  it("offers a watcher only Leave", () => {
    const { container } = card(session({ access: "ro" }));
    openMenu(container);
    expect(items(container)).toEqual(["Leave"]);
  });

  it("draws no menu for a watcher who came in through a project", () => {
    const { container } = card(session({ access: "ro", project: "Infra" }));
    expect(container.querySelector("button.tl-card-actions")).toBeNull();
  });

  it("kills the owner's session only after asking", async () => {
    const calls = stubFetch();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = card(session());
    openMenu(container);
    fireEvent.click(item(container, "Kill…")!);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("emo will be told it was you"));
    expect(calls).toEqual([]);

    ask.mockReturnValue(true);
    openMenu(container);
    fireEvent.click(item(container, "Kill…")!);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.url).toMatch(/\/sessions\/main\?owner=emo$/);
  });

  it("leaves by removing your own share", async () => {
    const calls = stubFetch();
    const refresh = vi.fn(async () => {});
    const { container } = card(session(), store(refresh));
    openMenu(container);
    fireEvent.click(item(container, "Leave")!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url).toMatch(/\/shares\/emo\/main\/wizard$/);
  });
});
