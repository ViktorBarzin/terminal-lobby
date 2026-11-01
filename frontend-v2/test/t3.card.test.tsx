import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@solidjs/testing-library";
import { SessionCard, PreloadHoverContext } from "../src/components/SessionCard";
import { T3OpenSheet } from "../src/components/T3OpenSheet";
import { closeT3Sheet, t3Nav, t3Sheet } from "../src/lib/t3-open";
import type { Session } from "../src/types/lobby";
import type { LobbyStore } from "../src/store/lobby";

/**
 * A T3 row in the sidebar (docs/plans/2026-10-31-t3-hosts-claude-design.md,
 * "The list", decisions 5, 7 and 8): a thread in the user's own T3 Code,
 * listed beside the tmux sessions with a T3 mark and the usual state dot. It
 * opens in T3, never in a terminal here, and its menu offers the two ways to
 * open it, Rename and Archive.
 */

const t3Row = (over: Partial<Session> = {}): Session => ({
  name: "t3_abcdefghijkl",
  title: "Fix the login page",
  attached: 0,
  lastActivity: 0,
  created: 0,
  tool: "claude",
  state: "awaiting",
  owner: "wizard",
  origin: "user",
  backend: "t3",
  t3ThreadId: "mcp:1",
  url: "https://t3.example.test/env/mcp%3A1",
  appUrl: "t3code://threads/env/mcp:1",
  ...over,
});

function cardStore(over: Partial<LobbyStore> = {}): LobbyStore {
  return {
    sessions: [],
    me: () => "wizard",
    selected: () => null,
    whoami: () => ({ authentik: "wizard", osUser: "wizard" }),
    hold: () => () => {},
    workingSince: () => null,
    layout: () => ({ version: 1, projects: [{ name: "p", sessions: [] }], ungrouped: [], ungroupedIndex: 0 }),
    killing: () => false,
    select: vi.fn(),
    kill: vi.fn(async () => {}),
    archive: vi.fn(async () => true),
    rename: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    setState: vi.fn(async () => true),
    ...over,
  } as unknown as LobbyStore;
}

/** A device that hovers (pointer: fine) or one that does not. */
function pointer(fine: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("fine") ? fine : q.includes("coarse") ? !fine : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function mount(s: Session, store = cardStore(), isUnseen = () => false) {
  const hover = { hoverEnter: vi.fn(), hoverLeave: vi.fn() };
  const r = render(() => (
    <PreloadHoverContext.Provider value={hover}>
      <SessionCard
        store={store}
        session={s}
        groupName=""
        tick={() => 0}
        isUnseen={isUnseen}
        showLastActive={() => true}
      />
    </PreloadHoverContext.Provider>
  ));
  const card = r.container.querySelector<HTMLElement>(".tl-card")!;
  return { ...r, card, hover, store };
}

const menuItems = (c: Element): string[] =>
  [...c.querySelectorAll("[role=menuitem], [role=menuitemradio]")].map(
    (b) => b.textContent?.trim() ?? "",
  );

let opened: unknown[][];
beforeEach(() => {
  opened = [];
  vi.stubGlobal("open", (...args: unknown[]) => {
    opened.push(args);
    return null;
  });
  pointer(true);
});
afterEach(() => {
  cleanup();
  closeT3Sheet();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<SessionCard> — a T3 row", () => {
  it("wears a T3 mark beside the Claude mark and its state dot", () => {
    const { card } = mount(t3Row());
    expect(card.querySelector(".tl-card-t3 svg")).not.toBeNull();
    expect(card.querySelector(".tl-tool-claude")).not.toBeNull();
    expect(card.querySelector(".tl-state-dot, [data-state]")).not.toBeNull();
    expect(card.getAttribute("aria-label")).toContain("in T3");
    expect(card.querySelector(".tl-card-name")?.textContent).toBe("Fix the login page");
  });

  it("a tmux row has no T3 mark", () => {
    const { card } = mount(t3Row({ backend: undefined, name: "work" }));
    expect(card.querySelector(".tl-card-t3")).toBeNull();
  });

  it("opens in a new tab with a mouse, and selects nothing", () => {
    const { card, store } = mount(t3Row());
    fireEvent.click(card);
    expect(opened).toEqual([["https://t3.example.test/env/mcp%3A1", "_blank", "noopener"]]);
    expect(store.select).not.toHaveBeenCalled();
    expect(t3Sheet()).toBeNull();
  });

  it("offers the app or the browser on a touch screen", () => {
    pointer(false);
    const { card, store } = mount(t3Row());
    fireEvent.click(card);
    expect(opened).toEqual([]);
    expect(store.select).not.toHaveBeenCalled();
    expect(t3Sheet()).toMatchObject({
      url: "https://t3.example.test/env/mcp%3A1",
      appUrl: "t3code://threads/env/mcp:1",
    });

    const toApp = vi.spyOn(t3Nav, "toApp").mockImplementation(() => {});
    const target = t3Sheet()!;
    const sheet = render(() => <T3OpenSheet target={target} />);
    const button = (label: string) =>
      [...sheet.container.querySelectorAll("button")].find((b) => b.textContent === label)!;
    fireEvent.click(button("Open in T3 app"));
    expect(toApp).toHaveBeenCalledWith("t3code://threads/env/mcp:1");
    expect(t3Sheet()).toBeNull();
  });

  it("the sheet's browser row opens the web client", () => {
    const sheet = render(() => (
      <T3OpenSheet target={{ url: "https://t3.example.test/x", appUrl: "t3code://x" }} />
    ));
    const browser = [...sheet.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Open in browser",
    )!;
    fireEvent.click(browser);
    expect(opened).toEqual([["https://t3.example.test/x", "_blank", "noopener"]]);
  });

  it("is never preloaded on hover: it has no terminal", () => {
    const { card, hover } = mount(t3Row());
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    expect(hover.hoverEnter).not.toHaveBeenCalled();
  });

  it("is never marked unread: it is read in T3", () => {
    const { card } = mount(t3Row({ state: "done" }), cardStore(), () => true);
    expect(card.classList.contains("tl-card-unseen")).toBe(false);
  });

  it("offers Open in T3, Open in T3 app, Rename and Archive, and nothing about a terminal", () => {
    const { container, card } = mount(t3Row());
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    expect(menuItems(container)).toEqual(["Open in T3", "Open in T3 app", "Rename", "Archive"]);
  });

  it("leaves Open in T3 app out when the row has no app link", () => {
    const { container, card } = mount(t3Row({ appUrl: undefined }));
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    expect(menuItems(container)).toEqual(["Open in T3", "Rename", "Archive"]);
  });

  it("Open in T3 opens the web client even on a touch screen", () => {
    pointer(false);
    const { container, card } = mount(t3Row());
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    const item = [...container.querySelectorAll("[role=menuitem]")].find(
      (b) => b.textContent?.trim() === "Open in T3",
    )!;
    fireEvent.click(item);
    expect(opened).toEqual([["https://t3.example.test/env/mcp%3A1", "_blank", "noopener"]]);
  });

  it("Archive archives at once, with no confirm and no kill", () => {
    const ask = vi.spyOn(window, "confirm");
    const { container, card, store } = mount(t3Row());
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    const archive = [...container.querySelectorAll("[role=menuitem]")].find(
      (b) => b.textContent?.trim() === "Archive",
    )!;
    fireEvent.click(archive);
    expect(store.archive).toHaveBeenCalledWith("t3_abcdefghijkl");
    expect(store.kill).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("renames through the title route, and ignores an emptied box", async () => {
    const { container, card, store } = mount(t3Row());
    fireEvent.click(card.querySelector(".tl-card-actions")!);
    const rename = [...container.querySelectorAll("[role=menuitem]")].find(
      (b) => b.textContent?.trim() === "Rename",
    )!;
    fireEvent.click(rename);
    const input = container.querySelector<HTMLInputElement>(".tl-card-rename")!;
    expect(input.value).toBe("Fix the login page");
    input.value = "Login page";
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(store.rename).toHaveBeenCalledWith("t3_abcdefghijkl", "Login page");

    fireEvent.dblClick(card);
    const again = container.querySelector<HTMLInputElement>(".tl-card-rename")!;
    again.value = "   ";
    fireEvent.keyDown(again, { key: "Enter" });
    await Promise.resolve();
    expect(store.rename).toHaveBeenCalledTimes(1);
  });

  it("a right swipe does not close it, where it kills a tmux row", () => {
    pointer(false);
    const swipeRight = (card: HTMLElement) => {
      fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
      fireEvent.pointerMove(card, { pointerType: "touch", clientX: 200, clientY: 12 });
      fireEvent.pointerUp(card, { pointerType: "touch", clientX: 200, clientY: 12 });
    };
    const tmux = mount(t3Row({ backend: undefined, name: "work" }));
    swipeRight(tmux.card);
    expect(tmux.store.kill).toHaveBeenCalledWith("work");
    tmux.unmount();

    const { card, store } = mount(t3Row());
    swipeRight(card);
    expect(store.kill).not.toHaveBeenCalled();
    expect(store.archive).not.toHaveBeenCalled();
  });
});
