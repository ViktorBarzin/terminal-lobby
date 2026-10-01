/**
 * The Browser card in the conversation (design 2026-10-01): one per Browsing
 * run, after the work it records, still there once the turn folds, and its
 * "Open browser" opens the panel. A card on a run that is over does not open a
 * stream at all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { BrowserCardHost } from "../src/components/BrowserCard";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const sockets: string[] = [];
class NoSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  constructor(url: string) {
    sockets.push(url);
  }
  send(): void {}
  close(): void {}
}

afterEach(() => {
  sockets.length = 0;
  vi.unstubAllGlobals();
});

const host = (over: Partial<BrowserCardHost> = {}): BrowserCardHost => ({
  session: "work",
  state: () => "live",
  active: () => true,
  onOpen: () => {},
  ...over,
});

const browsing: Event[] = [
  ev({ id: 1, kind: "user", body: "look it up" }),
  ev({
    id: 2,
    kind: "tool_use",
    tool: "mcp__playwright__browser_navigate",
    toolId: "b1",
    body: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Tmux" }),
  }),
  ev({ id: 3, kind: "tool_result", toolId: "b1", body: "ok" }),
  ev({
    id: 4,
    kind: "tool_use",
    tool: "mcp__playwright__browser_click",
    toolId: "b2",
    body: JSON.stringify({ element: "History" }),
  }),
];

describe("<MessagesTimeline> with a session browser", () => {
  it("draws one card for a run, saying what the browser does, and opens the panel", () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const onOpen = vi.fn();
    const { container, getByText } = render(() => (
      <MessagesTimeline events={browsing} browser={host({ onOpen })} />
    ));
    const cards = container.querySelectorAll(".tl-browser-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Browser");
    expect(cards[0]!.textContent).toContain("Clicking History");
    fireEvent.click(getByText("Open browser"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The run is current and the browser live, so the card streams.
    expect(sockets).toHaveLength(1);
    expect(new URL(sockets[0]!).pathname).toBe("/browser/work/stream");
  });

  it("keeps the card after the turn folds, and does not stream a finished run", () => {
    vi.stubGlobal("WebSocket", NoSocket);
    const settled = [
      ...browsing,
      ev({ id: 5, kind: "tool_result", toolId: "b2", body: "ok" }),
      ev({ id: 6, kind: "text", body: "Found it." }),
      ev({ id: 7, kind: "turn_end" }),
    ];
    const { container } = render(() => (
      <MessagesTimeline events={settled} browser={host({ state: () => undefined })} />
    ));
    expect(container.querySelectorAll(".tl-browser-card")).toHaveLength(1);
    // No browser left to open, and a record never connects.
    expect(container.textContent).not.toContain("Open browser");
    expect(sockets).toHaveLength(0);
  });

  it("does not wake a frozen browser for a card", () => {
    vi.stubGlobal("WebSocket", NoSocket);
    render(() => <MessagesTimeline events={browsing} browser={host({ state: () => "frozen" })} />);
    expect(sockets).toHaveLength(0);
  });

  it("draws no card without a browser host", () => {
    const { container } = render(() => <MessagesTimeline events={browsing} />);
    expect(container.querySelector(".tl-browser-card")).toBeNull();
  });
});
