import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { Event } from "../src/types/events";

/**
 * The pin the timeline publishes upward.
 *
 * The store holds the last TRANSCRIPT_WINDOW_TURNS turns and trims only while
 * the reader is at the bottom, because turns paged in on purpose must not be
 * dropped out from under them. Nothing but this view knows where the reader
 * is, so the rule is only half a rule until this prop carries it.
 *
 * The store walks its event array to answer each call, and a scroll fires many
 * times a second, so what is checked here is that CHANGES are published and
 * repeats are not.
 *
 * A change against WHAT is the part with a trap in it. The store moves this
 * value on its own — every `loadEarlier` unpins it, so a window just paged in
 * is not trimmed straight back out — so "the same as what I last published" is
 * not the same question as "the same as what the store holds". Deduping against
 * the first left the store unpinned for good, and the sliding window off with
 * it, which the last case here is about.
 */

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "first prompt" }),
  ev({ id: 2, kind: "text", body: "first answer" }),
  ev({ id: 3, kind: "turn_end" }),
  ev({ id: 4, kind: "user", body: "second prompt" }),
  ev({ id: 5, kind: "text", body: "second answer" }),
];

/**
 * jsdom lays nothing out, so every scroll measurement is 0 and the view reads
 * as pinned. These fix a geometry the test can then move the reader around in.
 */
function geometry(el: HTMLElement, scrollTop: number): void {
  Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  el.scrollTop = scrollTop;
}

function mount(): { log: boolean[]; scroller: HTMLElement } {
  const log: boolean[] = [];
  const { container } = render(() => (
    <MessagesTimeline events={TRANSCRIPT} onPinned={(p) => log.push(p)} />
  ));
  const scroller = container.querySelector<HTMLElement>(".tl-timeline");
  if (!scroller) throw new Error("no scroller");
  return { log, scroller };
}

describe("<MessagesTimeline> — telling the store where the reader is", () => {
  it("says nothing at mount, where both sides already start pinned", () => {
    expect(mount().log).toEqual([]);
  });

  it("reports the scroll up that unpins", () => {
    const { log, scroller } = mount();
    geometry(scroller, 0); // 1000 - 0 - 300 = 700px from the bottom
    fireEvent.scroll(scroller);
    expect(log).toEqual([false]);
  });

  it("reports the return to the bottom", () => {
    const { log, scroller } = mount();
    geometry(scroller, 0);
    fireEvent.scroll(scroller);
    geometry(scroller, 700); // 1000 - 700 - 300 = 0
    fireEvent.scroll(scroller);
    expect(log).toEqual([false, true]);
  });

  it("does not repeat itself while the reader stays put", () => {
    const { log, scroller } = mount();
    geometry(scroller, 0);
    for (let i = 0; i < 5; i++) fireEvent.scroll(scroller);
    expect(log).toEqual([false]);
  });

  it("counts a scroll within the slack as still at the bottom", () => {
    const { log, scroller } = mount();
    geometry(scroller, 0);
    fireEvent.scroll(scroller);
    geometry(scroller, 680); // 20px short of the end, inside PIN_SLACK_PX
    fireEvent.scroll(scroller);
    expect(log).toEqual([false, true]);
  });

  it("reports the pin the ↓ Latest button restores", () => {
    const { log, scroller } = mount();
    geometry(scroller, 0);
    fireEvent.scroll(scroller);
    const latest = scroller.parentElement?.querySelector<HTMLElement>(".tl-scroll-end");
    if (!latest) throw new Error("no ↓ Latest button while unpinned");
    fireEvent.click(latest);
    expect(log).toEqual([false, true]);
  });

  /**
   * `store.loadEarlier()` sets the store's pin to false directly — the scroll
   * gesture, the auto-fill for a transcript that does not reach the bottom of
   * its own viewport, and a find-in-session jump all reach it, and none of them
   * passes through this view. A view deduping against its own last published
   * value then believes it has already said `true`, never says it again, and
   * the store stops trimming for the rest of the session's 24-hour mount.
   */
  it("says the reader is back at the bottom after the store unpinned itself", () => {
    const log: boolean[] = [];
    const [stored, setStored] = createSignal(true);
    const { container } = render(() => (
      <MessagesTimeline
        events={TRANSCRIPT}
        pinned={stored()}
        onPinned={(p) => {
          log.push(p);
          setStored(p);
        }}
      />
    ));
    const scroller = container.querySelector<HTMLElement>(".tl-timeline");
    if (!scroller) throw new Error("no scroller");

    // The store pages in history and unpins itself. This view never heard it.
    setStored(false);

    geometry(scroller, 700); // 1000 - 700 - 300 = 0, i.e. at the bottom
    fireEvent.scroll(scroller);
    expect(log, "the reader is at the bottom and the store has to be told").toEqual([true]);
  });

  it("is optional — a timeline rendered without the prop still scrolls", () => {
    const { container } = render(() => <MessagesTimeline events={TRANSCRIPT} />);
    const scroller = container.querySelector<HTMLElement>(".tl-timeline");
    if (!scroller) throw new Error("no scroller");
    geometry(scroller, 0);
    expect(() => fireEvent.scroll(scroller)).not.toThrow();
  });
});
