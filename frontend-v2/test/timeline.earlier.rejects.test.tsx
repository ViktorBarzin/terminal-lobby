/**
 * A caller whose `onLoadEarlier` REJECTS must not leave an unhandled rejection
 * behind.
 *
 * The component's own interface declares `onLoadEarlier?: () => Promise<void>`
 * and its sibling test already feeds it a rejecting mock to prove the loading
 * flag clears — so a rejecting caller is legitimate input, not misuse. Today
 * `loadEarlier` wraps the await in try/FINALLY with no catch and both scroll
 * paths invoke it as `void loadEarlier()`, so the rejection escapes.
 *
 * In production the store catches its own fetch failures and resolves, so this
 * is latent rather than firing: the component simply must not depend on that.
 * When it does escape, ADR-0008's `unhandledrejection` handler records it as an
 * app.exception — a real failure reported as an unexplained one.
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

/**
 * The runner's own unhandled-rejection channel. Declared narrowly rather than
 * pulling in @types/node, which this project's tsconfig deliberately does not
 * list — an escaped rejection is reported by the runner, not by jsdom, so this
 * is the hook that can observe one.
 */
declare const process: {
  on(event: "unhandledRejection", fn: (reason: unknown) => void): void;
  off(event: "unhandledRejection", fn: (reason: unknown) => void): void;
};

/** Collect anything the runner would otherwise report as an unhandled rejection. */
async function unhandledDuring(fn: () => void | Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    // Node raises unhandledRejection only after the microtask queue drains,
    // so a macrotask hop is what makes an escaped rejection observable.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe("a rejecting onLoadEarlier", () => {
  it("leaks nothing when the scroll path drives it", async () => {
    const onLoadEarlier = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("network"));
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;

    const seen = await unhandledDuring(async () => {
      const geom = stubScroller(el, 4000, 400);
      geom.top = 10;
      fireEvent.scroll(el);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoadEarlier).toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("leaks nothing when the button drives it", async () => {
    // The button hands the async function straight to onClick, which discards
    // the promise exactly as `void` does.
    const onLoadEarlier = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("network"));
    const { container, queryByText } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    stubScroller(container.querySelector<HTMLElement>(".tl-timeline")!, 4000, 400);
    const button = queryByText("Load earlier turns");

    const seen = await unhandledDuring(async () => {
      if (button) fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(seen).toEqual([]);
  });

  it("still asks again after a failure, rather than locking up", async () => {
    // The behaviour the sibling test pins, re-asserted here so a catch that
    // swallowed too much would be caught.
    const onLoadEarlier = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const { container } = render(() => (
      <MessagesTimeline events={TURN} hasEarlier={true} onLoadEarlier={onLoadEarlier} />
    ));
    const el = container.querySelector<HTMLElement>(".tl-timeline")!;

    await unhandledDuring(async () => {
      const geom = stubScroller(el, 4000, 400);
      geom.top = 10;
      fireEvent.scroll(el);
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.scroll(el);
    });

    expect(onLoadEarlier.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
