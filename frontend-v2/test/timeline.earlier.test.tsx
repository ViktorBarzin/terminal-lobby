/**
 * Reaching the top of the transcript is the request for earlier turns.
 *
 * It used to be a link: scroll up, arrive at the oldest row, stop, aim at "Load
 * earlier turns", click, resume. Reading back through a conversation is one
 * continuous gesture and that interrupted it every window.
 *
 * The thing that makes this safe to fire automatically already existed: the
 * anchor-based compensation in `loadEarlier` pushes the reader down by exactly
 * the height inserted above them, so after a load the top of the transcript is a
 * whole window further away and the trigger zone is left behind. Without that,
 * an auto-loader at the top edge walks the entire session in one gesture.
 *
 * jsdom has no layout, so the scroller's geometry is stubbed the same way
 * timeline.pin.test.tsx stubs it. What is pinned here is the DECISION to ask for
 * more, which is where this behaviour lives.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const TURN: Event[] = [
  ev({ id: 1, kind: "user", body: "read the notes" }),
  ev({ id: 2, kind: "text", body: "on it" }),
];

function stubScroller(el: HTMLElement, content: number, view: number) {
  const state = { top: 0, content, view };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.view });
  return state;
}

afterEach(() => vi.unstubAllGlobals());

describe("loading earlier turns by reaching the top", () => {
  it("asks for more when the reader reaches the top", async () => {
    const onLoadEarlier = vi.fn(async () => {});
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    geom.top = 3600; // at the live end
    fireEvent.scroll(el);
    expect(onLoadEarlier).not.toHaveBeenCalled();

    geom.top = 120; // scrolled up to the oldest rows
    fireEvent.scroll(el);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("stays quiet in the middle of a long transcript", () => {
    const onLoadEarlier = vi.fn(async () => {});
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 8000, 400);
    geom.top = 4000;
    fireEvent.scroll(el);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("loads one window at a time, however hard the reader scrolls", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onLoadEarlier = vi.fn(async () => {
      await gate;
    });
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    geom.top = 40;
    fireEvent.scroll(el);
    fireEvent.scroll(el);
    fireEvent.scroll(el);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
  });

  it("never asks once the server says there is nothing earlier", () => {
    const onLoadEarlier = vi.fn(async () => {});
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={false} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    geom.top = 0;
    fireEvent.scroll(el);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("fills a transcript that cannot scroll, since no gesture is coming", async () => {
    // A short window of short turns has no scrollbar, so no scroll event will
    // ever arrive — the reader would be stranded with nothing to drag.
    const onLoadEarlier = vi.fn(async () => {});
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    stubScroller(el, 200, 600); // content shorter than the viewport
    fireEvent.scroll(el);
    await Promise.resolve();
    expect(onLoadEarlier).toHaveBeenCalled();
  });

  it("recovers from a failed load instead of locking up", async () => {
    // The old flag was set before the await and cleared after it, so a rejected
    // fetch left it set and no further window could ever be requested.
    const onLoadEarlier = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    geom.top = 10;
    fireEvent.scroll(el);
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.scroll(el);
    expect(onLoadEarlier.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not chain on its own compensation", async () => {
    // loadEarlier writes scrollTop to keep the reader in place, and that write
    // fires a scroll event. Treated as a gesture it asks for another window —
    // and a window shorter than the trigger zone would then ask again, pulling
    // the whole session while the reader sits still.
    // A SMALL window: 170px inserted above, well inside the 400px trigger zone,
    // so the compensated position still qualifies and the chain would continue.
    let anchorTop = 30;
    const onLoadEarlier = vi.fn(async () => {
      anchorTop = 200;
    });
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;
    const geom = stubScroller(el, 4000, 400);
    const anchor = el.querySelector<HTMLElement>(".tl-row:not(.tl-row-filling)");
    if (anchor) {
      Object.defineProperty(anchor, "offsetTop", { configurable: true, get: () => anchorTop });
    }
    geom.top = 100;
    fireEvent.scroll(el);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // The compensation's own scroll event, replayed the way the browser would.
    fireEvent.scroll(el);
    expect(onLoadEarlier, "asked again without being asked").toHaveBeenCalledTimes(1);
    // A real gesture still works.
    geom.top = 20;
    fireEvent.scroll(el);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  /**
   * The row keeps a control, and this test used to assert it does not.
   *
   * Reaching the top is what loads the next window — that has not changed, and
   * every test above still holds. What changed is what the row says when a
   * gesture is not the whole story: a fetch that failed, a link that is down, or
   * a reader who would rather tap than scroll all need something to press, and a
   * transcript whose history has run out needs to say so rather than keep
   * inviting a scroll that will never load anything (Viktor, 2026-08-28
   * grilling: "the existing top row stays — showing Loading earlier turns…,
   * then Load earlier turns as a manual retry if a fetch fails or you're
   * offline; no more → Start of session").
   */
  it("keeps a control, for a retry and for a reader who would rather tap", async () => {
    const load = vi.fn(async () => {});
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={load} />
    ));
    const row = container.querySelector(".tl-row-earlier")!;
    expect(row).not.toBeNull();
    const btn = row.querySelector("button")!;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says it is working while a window is on its way", async () => {
    let release!: () => void;
    const { container } = render(() => (
      <MessagesTimeline
        events={TURN}
        hasEarlier={true}
        onLoadEarlier={() => new Promise<void>((r) => (release = r))}
      />
    ));
    const row = container.querySelector(".tl-row-earlier")!;
    fireEvent.click(row.querySelector("button")!);
    await Promise.resolve();
    expect(row.textContent).toMatch(/loading earlier/i);
    release();
    await Promise.resolve();
  });

  it("says the history has run out rather than inviting a scroll that cannot load", () => {
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={false} onLoadEarlier={async () => {}} />
    ));
    const row = container.querySelector(".tl-row-earlier")!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).toMatch(/start of session/i);
  });
});
