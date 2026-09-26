/**
 * A session's timeline stays mounted, hidden, while the drill-in shows one of
 * its agents in its place: going back is then free, and finds the reader where
 * they were, folds and all.
 *
 * Two things a hidden timeline has to get right. A browser gives a
 * `display: none` box no geometry and ignores a scroll written to it, so a
 * reader who was following the live end is put back there when the timeline
 * shows again, not left where it was before the transcript grew. And a jump
 * to one of its rows, which is how a find-in-session hit is opened, asks for
 * the timeline to be shown first: scrolling a row nobody can see would report
 * success and show nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const turn = (n: number): Event[] => [
  ev({ id: n * 10, kind: "user", body: `prompt ${n}` }),
  ev({ id: n * 10 + 1, kind: "text", body: `answer ${n}` }),
  ev({ id: n * 10 + 2, kind: "turn_end" }),
];

/**
 * Scroll geometry the way a browser has it: the content height the test says,
 * and none at all, with writes ignored, while the box is `display: none`.
 */
function browserGeometry(clientHeight: number) {
  const proto = window.HTMLElement.prototype;
  const tops = new WeakMap<object, number>();
  let contentHeight = 0;
  const hidden = (el: HTMLElement) => el.classList.contains("tl-hidden");
  const saved = (["scrollHeight", "clientHeight", "scrollTop"] as const).map(
    (p) => [p, Object.getOwnPropertyDescriptor(proto, p)] as const,
  );
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return hidden(this) ? 0 : contentHeight;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return hidden(this) ? 0 : clientHeight;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      if (!hidden(this)) tops.set(this, v);
    },
  });
  return {
    grow(h: number) {
      contentHeight = h;
    },
    restore() {
      for (const [p, d] of saved) {
        if (d) Object.defineProperty(proto, p, d);
        else delete (proto as unknown as Record<string, unknown>)[p];
      }
    },
  };
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
});

describe("a hidden timeline", () => {
  it("stays mounted, out of sight and out of the accessibility tree", () => {
    const { container } = render(() => <MessagesTimeline events={turn(1)} hidden />);
    const tl = container.querySelector<HTMLElement>(".tl-timeline")!;
    expect(tl.classList.contains("tl-hidden")).toBe(true);
    expect(tl.getAttribute("aria-hidden")).toBe("true");
    expect(tl.textContent).toContain("prompt 1");
  });

  it("puts a reader who was at the live end back there when it shows again", () => {
    const geom = browserGeometry(300);
    restores.push(geom.restore);
    const [events, setEvents] = createSignal<Event[]>([...turn(1), ...turn(2)]);
    const [hidden, setHidden] = createSignal(false);
    geom.grow(800);
    const { container } = render(() => <MessagesTimeline events={events()} hidden={hidden()} />);
    const tl = container.querySelector<HTMLElement>(".tl-timeline")!;
    expect(tl.scrollTop).toBe(500);

    // The session goes on while the reader is in an agent's transcript.
    setHidden(true);
    geom.grow(1400);
    setEvents([...turn(1), ...turn(2), ...turn(3)]);
    expect(tl.scrollTop).toBe(500);

    setHidden(false);
    expect(tl.scrollTop).toBe(1100);
  });

  it("asks to be shown before it scrolls to a row", () => {
    const scrolled: { id: string | undefined; hidden: boolean }[] = [];
    const had = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        const tl = this.closest(".tl-timeline");
        scrolled.push({
          id: this.dataset.eid,
          hidden: tl?.classList.contains("tl-hidden") ?? false,
        });
      },
    });
    restores.push(() => {
      if (had) Object.defineProperty(Element.prototype, "scrollIntoView", had);
      else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    });
    const [hidden, setHidden] = createSignal(true);
    let reveals = 0;
    render(() => (
      <MessagesTimeline
        events={turn(1)}
        hidden={hidden()}
        onReveal={() => {
          reveals++;
          setHidden(false);
        }}
      />
    ));
    expect(window.__tlScrollToEvent?.(10)).toBe(true);
    expect(reveals).toBe(1);
    expect(scrolled).toEqual([{ id: "10", hidden: false }]);

    // On screen already, it just scrolls.
    expect(window.__tlScrollToEvent?.(10)).toBe(true);
    expect(reveals).toBe(1);
  });
});
