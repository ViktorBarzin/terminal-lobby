/**
 * A queued message can be cancelled from its ghost bubble (Viktor,
 * 2026-10-09: "on the card we could swipe it or press and hold").
 *
 * On a phone: swipe the bubble sideways past SWIPE_MIN_PX and it is cancelled,
 * or press and hold it and a Cancel button appears under it. With a mouse a ×
 * sits on the bubble. The ghost dims while session-events takes it off the
 * queue (session-events/held.go cancelHeld), and comes back when it could not.
 * A ghost still being sent has nothing held to cancel, so it offers nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { GHOST_HOLD_MS } from "../src/components/QueuedGhost";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });
const RUNNING: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card" }),
  ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"a.ts"}' }),
];

const touch = (el: Element, type: string, x: number, y = 100) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );

function mount(opts: { onCancel?: (t: string) => Promise<boolean>; sending?: Set<number> } = {}) {
  const onCancel = opts.onCancel ?? vi.fn(async () => true);
  const r = render(() => (
    <MessagesTimeline
      events={RUNNING}
      queued={["first", "second"]}
      queuedSending={opts.sending}
      onCancelQueued={onCancel}
    />
  ));
  const ghosts = () => Array.from(r.container.querySelectorAll<HTMLElement>(".tl-row-ghost"));
  const bubble = (i: number) => ghosts()[i]!.querySelector<HTMLElement>(".tl-bubble-ghost")!;
  return { ...r, onCancel, ghosts, bubble };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelling a queued message", () => {
  it("cancels the one swiped sideways past the threshold", async () => {
    const { onCancel, bubble } = mount();
    touch(bubble(1), "pointerdown", 300);
    touch(bubble(1), "pointermove", 285);
    touch(bubble(1), "pointermove", 200);
    touch(bubble(1), "pointerup", 200);
    expect(onCancel).toHaveBeenCalledWith("second");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on a rightward swipe too", () => {
    const { onCancel, bubble } = mount();
    touch(bubble(0), "pointerdown", 100);
    touch(bubble(0), "pointermove", 115);
    touch(bubble(0), "pointermove", 190);
    touch(bubble(0), "pointerup", 190);
    expect(onCancel).toHaveBeenCalledWith("first");
  });

  it("leaves it queued when the swipe is short or brought back", () => {
    const { onCancel, bubble } = mount();
    touch(bubble(0), "pointerdown", 300);
    touch(bubble(0), "pointermove", 285);
    touch(bubble(0), "pointermove", 260);
    touch(bubble(0), "pointerup", 260);
    touch(bubble(0), "pointerdown", 300);
    touch(bubble(0), "pointermove", 200);
    touch(bubble(0), "pointermove", 290);
    touch(bubble(0), "pointerup", 290);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("leaves it queued when the finger went down the page first", () => {
    const { onCancel, bubble } = mount();
    const at = (type: string, x: number, y: number) =>
      bubble(0).dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerType: "touch",
        }),
      );
    at("pointerdown", 300, 100);
    at("pointermove", 298, 115);
    at("pointermove", 180, 120);
    at("pointerup", 180, 120);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("trails the finger while it swipes", () => {
    const { bubble, ghosts } = mount();
    touch(bubble(0), "pointerdown", 300);
    touch(bubble(0), "pointermove", 285);
    touch(bubble(0), "pointermove", 250);
    expect(ghosts()[0]!.style.transform).toBe("translateX(-50px)");
    touch(bubble(0), "pointerup", 250);
    expect(ghosts()[0]!.style.transform).toBe("");
  });

  it("offers Cancel after a press and hold, and cancels when it is tapped", async () => {
    vi.useFakeTimers();
    const { onCancel, bubble, container } = mount();
    touch(bubble(0), "pointerdown", 300);
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    touch(bubble(0), "pointerup", 300);
    const cancel = container.querySelector<HTMLButtonElement>(".tl-ghost-cancel-confirm");
    expect(cancel?.textContent).toBe("Cancel message");
    fireEvent.click(cancel!);
    expect(onCancel).toHaveBeenCalledWith("first");
  });

  it("takes the Cancel offer away on Keep, and a hold that moved offers nothing", () => {
    vi.useFakeTimers();
    const { onCancel, bubble, container } = mount();
    touch(bubble(0), "pointerdown", 300);
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    fireEvent.click(container.querySelector(".tl-ghost-keep")!);
    expect(container.querySelector(".tl-ghost-cancel-confirm")).toBeNull();

    touch(bubble(1), "pointerdown", 300);
    touch(bubble(1), "pointermove", 300, 120);
    vi.advanceTimersByTime(GHOST_HOLD_MS);
    expect(container.querySelector(".tl-ghost-cancel-confirm")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("has a × for a mouse", () => {
    const { onCancel, ghosts } = mount();
    const x = ghosts()[1]!.querySelector<HTMLButtonElement>(".tl-ghost-x")!;
    expect(x.getAttribute("aria-label")).toBe("Cancel queued message");
    fireEvent.click(x);
    expect(onCancel).toHaveBeenCalledWith("second");
  });

  it("dims the ghost while it is cancelled, and brings it back when that fails", async () => {
    let settle!: (ok: boolean) => void;
    const onCancel = vi.fn(() => new Promise<boolean>((r) => (settle = r)));
    const { ghosts } = mount({ onCancel });
    fireEvent.click(ghosts()[0]!.querySelector(".tl-ghost-x")!);
    expect(ghosts()[0]!.hasAttribute("data-cancelling")).toBe(true);
    // A second press while the first is out asks nothing more.
    fireEvent.click(ghosts()[0]!.querySelector(".tl-ghost-x")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    settle(false);
    await waitFor(() => expect(ghosts()[0]!.hasAttribute("data-cancelling")).toBe(false));
  });

  it("offers nothing on a ghost still being sent, or with no way to cancel", () => {
    const { ghosts, bubble, onCancel } = mount({ sending: new Set([1]) });
    expect(ghosts()[0]!.querySelector(".tl-ghost-x")).not.toBeNull();
    expect(ghosts()[1]!.querySelector(".tl-ghost-x")).toBeNull();
    touch(bubble(1), "pointerdown", 300);
    touch(bubble(1), "pointermove", 285);
    touch(bubble(1), "pointermove", 200);
    touch(bubble(1), "pointerup", 200);
    expect(onCancel).not.toHaveBeenCalled();

    const plain = render(() => <MessagesTimeline events={RUNNING} queued={["first"]} />);
    expect(plain.container.querySelector(".tl-ghost-x")).toBeNull();
    expect(plain.container.querySelector("[data-own-swipe]")).toBeNull();
  });

  it("keeps the session swipe off a cancellable ghost", () => {
    const { ghosts } = mount();
    expect(ghosts()[0]!.hasAttribute("data-own-swipe")).toBe(true);
  });
});
