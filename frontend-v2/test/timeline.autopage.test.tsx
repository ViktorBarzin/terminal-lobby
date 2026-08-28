/**
 * Reading upward loads history on its own.
 *
 * The button that used to sit at the top is still there — as a status line, and
 * as the retry when a fetch fails — but reaching the top of what is held is now
 * the thing that asks for more.
 *
 * jsdom has no layout, so the scroller's geometry is stubbed. What is under
 * test is the DECISION to page, which is where the risk is: this adds a fourth
 * writer to a scrollTop that three others already share, and the reader must
 * not move when history lands above them.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const EVENTS: Event[] = [
  ev({ id: 1, kind: "user", body: "hello" }),
  ev({ id: 2, kind: "text", body: "hi" }),
  ev({ id: 3, kind: "turn_end" }),
];

function stubScroller(el: HTMLElement, content: number, view: number) {
  const state = { top: 0, content, view };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => (state.top = v),
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.view });
  return state;
}

function mount(over: { hasEarlier?: boolean; onLoadEarlier?: () => Promise<void> } = {}) {
  const r = render(() => (
    <MessagesTimeline
      events={EVENTS}
      hasEarlier={over.hasEarlier ?? true}
      onLoadEarlier={over.onLoadEarlier}
    />
  ));
  const el = r.container.querySelector(".tl-timeline") as HTMLElement;
  const geo = stubScroller(el, 4000, 800);
  return { ...r, el, geo };
}

const settle = () => new Promise((res) => setTimeout(res, 0));

describe("reaching the top", () => {
  it("asks for history without being clicked", async () => {
    const load = vi.fn(async () => {});
    const m = mount({ onLoadEarlier: load });
    m.geo.top = 3000; // nowhere near the top
    fireEvent.scroll(m.el);
    await settle();
    expect(load).not.toHaveBeenCalled();

    m.geo.top = 400; // inside one screen of it
    fireEvent.scroll(m.el);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("asks once per approach, not once per scroll event", async () => {
    let release!: () => void;
    const load = vi.fn(() => new Promise<void>((r) => (release = r)));
    const m = mount({ onLoadEarlier: load });
    m.geo.top = 100;
    fireEvent.scroll(m.el);
    fireEvent.scroll(m.el);
    fireEvent.scroll(m.el);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await settle();
    // A step that landed does not immediately fire another: the reader has to
    // reach for it again, or a session of small pages would page itself back to
    // its own beginning while nobody was scrolling.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not ask when there is nothing behind the transcript", async () => {
    const load = vi.fn(async () => {});
    const m = mount({ hasEarlier: false, onLoadEarlier: load });
    m.geo.top = 0;
    fireEvent.scroll(m.el);
    await settle();
    expect(load).not.toHaveBeenCalled();
  });

  it("says where it is: loading, then the start of the session", async () => {
    const [has, setHas] = createSignal(true);
    let release!: () => void;
    const load = () => new Promise<void>((r) => (release = r));
    const r = render(() => (
      <MessagesTimeline events={EVENTS} hasEarlier={has()} onLoadEarlier={load} />
    ));
    const el = r.container.querySelector(".tl-timeline") as HTMLElement;
    const geo = stubScroller(el, 4000, 800);

    expect(r.container.textContent).toContain("Load earlier");
    geo.top = 100;
    fireEvent.scroll(el);
    await settle();
    expect(r.container.textContent).toContain("Loading earlier");
    release();
    await settle();

    setHas(false);
    expect(r.container.textContent).toContain("Start of session");
    expect(r.container.textContent).not.toContain("Load earlier");
  });

  it("keeps the manual control, for a reader who wants it and a fetch that failed", async () => {
    const load = vi.fn(async () => {});
    const m = mount({ onLoadEarlier: load });
    const btn = m.container.querySelector(".tl-row-earlier button") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
