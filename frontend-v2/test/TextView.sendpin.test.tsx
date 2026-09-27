/**
 * Sending brings the reader back to the latest message.
 *
 * Found live 2026-09-27 on the Android emulator: scrolled 145px up, the reader
 * typed "Say just pong." and pressed the keyboard's send key. The prompt went,
 * but the view stayed where it was, 509px above the bottom, so neither the
 * sent message nor the reply came into sight and only "↓ Latest" said
 * anything had happened. The reader scrolling up lets go of the live end on
 * purpose; the reader's own send is the moment to take it back.
 *
 * jsdom has no layout, so the scroller's geometry is stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

const SESSION: Event[] = [
  { id: 1, kind: "user", session: "demo", turnId: "t1", body: "read the notes" },
  { id: 2, kind: "text", session: "demo", turnId: "t1", body: "Read them." },
];

function mount(onSend: (text: string) => Promise<boolean>) {
  g.EventSource = class {
    onopen = null;
    onerror = null;
    onmessage = null;
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const r = render(() => (
    <TextView
      session="demo"
      events={SESSION}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  const el = r.container.querySelector<HTMLElement>(
    '.tl-timeline[aria-label="Session transcript"]',
  )!;
  const geom = { top: 0, content: 1000, view: 300 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geom.top,
    set: (v: number) => {
      geom.top = Math.max(0, Math.min(v, geom.content - geom.view));
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geom.content });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geom.view });

  const scrollUp = () => {
    fireEvent.wheel(el, { deltaY: -120 });
    geom.top = 100;
    fireEvent.scroll(el);
  };
  const send = (text: string) => {
    const ta = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    r.container.querySelector<HTMLButtonElement>(".tl-send")!.click();
  };
  const latest = () => r.container.querySelector(".tl-scroll-end");
  return { ...r, geom, scrollUp, send, latest };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("a send while scrolled up", () => {
  it("brings the view back to the latest message", async () => {
    const onSend = vi.fn(async () => true);
    const v = mount(onSend);
    v.scrollUp();
    expect(v.latest(), "scrolled up, so Latest shows").not.toBeNull();

    v.send("Say just pong.");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Say just pong."));
    await waitFor(() => expect(v.geom.top).toBe(700));
    expect(v.latest()).toBeNull();
  });

  it("leaves the view alone when the send was refused", async () => {
    const onSend = vi.fn(async () => false);
    const v = mount(onSend);
    v.scrollUp();

    v.send("Say just pong.");
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await Promise.resolve();
    expect(v.geom.top, "the words stay in the field, and so does the reader").toBe(100);
    expect(v.latest()).not.toBeNull();
  });
});
