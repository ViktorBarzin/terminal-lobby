/**
 * "Latest" in a band of its own above the composer (the T3 pass, prototype
 * 6-scrolled).
 *
 * The button used to sit inside the transcript's scroller, sticky 30px above
 * its foot, where it covered whatever row was passing under it. Now the
 * scroller only reports whether it is at the live end, and the view draws the
 * button in a 42px band between the transcript and the composer: the band
 * takes its height from the transcript while it shows, so it covers nothing.
 * While Claude works it reads "Latest · working". A card Claude is waiting on
 * holds the bottom of the view, and the band stays away while it is up.
 *
 * jsdom has no layout, so the scroller's geometry is stubbed, and "covers no
 * row" is checked the only way jsdom can: the band is its own box in the
 * view's column, after the transcript's and before the composer, and never
 * inside the scroller.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerResponse } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

const OPEN_TURN: Event[] = [
  {
    id: 1,
    kind: "user",
    session: "demo",
    turnId: "t1",
    body: "read the notes",
  },
  { id: 2, kind: "text", session: "demo", turnId: "t1", body: "Reading them." },
];
const DONE_TURN: Event[] = [
  ...OPEN_TURN,
  { id: 3, kind: "turn_end", session: "demo", turnId: "t1", body: "" },
];

const colour = {
  question: "Pick a colour",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Red", description: "about Red" },
    { label: "Blue", description: "about Blue" },
  ],
};
const ASKING: Event[] = [
  ...OPEN_TURN,
  {
    id: 3,
    kind: "tool_use",
    tool: "AskUserQuestion",
    toolId: "q1",
    session: "demo",
    turnId: "t1",
    body: JSON.stringify({ questions: [colour] }),
  },
  {
    id: 4,
    kind: "meta",
    meta: "held",
    session: "demo",
    body: JSON.stringify({ questions: [colour] }),
  } as unknown as Event,
];

function mount(initial: Event[]) {
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
  const [events, setEvents] = createSignal<Event[]>(initial);
  const applied: AnswerResponse = { applied: true, done: true };
  const r = render(() => (
    <TextView
      session="demo"
      events={events()}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={async () => true}
      onPane={async () => ({ pane: "", state: "done" })}
      onAnswer={async () => applied}
    />
  ));
  const el = r.container.querySelector<HTMLElement>(
    '.tl-timeline[aria-label="Session transcript"]',
  )!;
  const geom = { top: 700, content: 1000, view: 300 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geom.top,
    set: (v: number) => {
      geom.top = Math.max(0, Math.min(v, geom.content - geom.view));
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => geom.content,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => geom.view,
  });

  const scrollUp = () => {
    fireEvent.wheel(el, { deltaY: -120 });
    geom.top = 100;
    fireEvent.scroll(el);
  };
  const band = () => r.container.querySelector<HTMLElement>(".tl-latest-band");
  const latest = () => r.container.querySelector<HTMLButtonElement>(".tl-latest");
  return { ...r, el, geom, scrollUp, band, latest, setEvents };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("the Latest band", () => {
  it("is not there while the reader is at the live end", () => {
    const v = mount(DONE_TURN);
    expect(v.band()).toBeNull();
    expect(v.latest()).toBeNull();
  });

  it("sits outside the scroller, between the transcript and the composer", () => {
    const v = mount(DONE_TURN);
    v.scrollUp();
    const band = v.band();
    const button = v.latest();
    expect(band, "scrolled up, so the band shows").not.toBeNull();
    expect(button).not.toBeNull();
    expect(v.el.contains(button), "the scroller holds rows only").toBe(false);
    expect(v.el.querySelector(".tl-scroll-end, .tl-latest")).toBeNull();
    expect(band!.contains(button)).toBe(true);

    // Its own box in the view's column: the transcript's body above it, the
    // composer below it, so it takes height instead of covering a row.
    const view = v.container.querySelector<HTMLElement>(".tl-textview")!;
    expect(band!.parentElement).toBe(view);
    const body = view.querySelector<HTMLElement>(".tl-textview-body")!;
    const composer = view.querySelector<HTMLElement>(".tl-composer")!;
    expect(body.compareDocumentPosition(band!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band!.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads Latest when the turn is over", () => {
    const v = mount(DONE_TURN);
    v.scrollUp();
    expect(v.latest()!.textContent).toBe("Latest");
    expect(v.latest()!.querySelector(".tl-latest-working")).toBeNull();
  });

  it("reads Latest · working while a turn runs, and drops the word when it ends", () => {
    const v = mount(OPEN_TURN);
    v.scrollUp();
    expect(v.latest()!.textContent).toBe("Latest · working");
    expect(v.latest()!.querySelector(".tl-latest-working")?.textContent).toBe("working");

    v.setEvents(DONE_TURN);
    expect(v.latest()!.textContent).toBe("Latest");
  });

  it("takes the reader to the latest message and goes away", async () => {
    const v = mount(DONE_TURN);
    v.scrollUp();
    fireEvent.click(v.latest()!);
    expect(v.geom.top).toBe(700);
    await waitFor(() => expect(v.band()).toBeNull());
  });

  it("stays away while a card Claude is waiting on is up", async () => {
    const v = mount(DONE_TURN);
    v.scrollUp();
    expect(v.band()).not.toBeNull();

    v.setEvents(ASKING);
    await waitFor(() => expect(v.container.querySelector(".tl-qcard")).not.toBeNull());
    expect(v.band()).toBeNull();
  });
});
