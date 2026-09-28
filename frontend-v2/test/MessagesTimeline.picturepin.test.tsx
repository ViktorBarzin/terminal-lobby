/**
 * A reader at the live end stays there while the conversation's pictures load.
 *
 * Every picture in the Text view is a lazy <img>, so it arrives after the rows
 * that hold it have been laid out and pinned. Each one then grows the content by
 * its own height, which moves no scrollTop and fires no scroll event, and the
 * timeline's own box does not change size either. Measured live on 2026-09-26 at
 * 1280x800: a session with pictures opened 3014px above its latest message with
 * the pin still set and no "Latest" button, and stayed there until the next event
 * arrived. With every picture blocked, the same session opened at the bottom.
 *
 * A reader who scrolled up to read is left where they are, as for every other
 * change in height (MessagesTimeline's pin effect says why).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

afterEach(() => cleanup());

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "plot it" }),
  ev({
    id: 2,
    kind: "text",
    body: "I wrote the chart to /tmp/claude-1000/x/plot.png for you.",
  }),
  ev({ id: 3, kind: "turn_end" }),
];

/**
 * The scroll geometry a browser would report, which the test then moves. jsdom
 * lays nothing out, so without this every measurement is 0 and the view reads
 * as pinned whatever happens.
 */
function geometry(el: HTMLElement, g: { content: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => g.content,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => g.client,
  });
  return g;
}

function mount(hidden?: () => boolean) {
  let atEnd = true;
  const { container } = render(() => (
    <MessagesTimeline
      events={TRANSCRIPT}
      me="wizard"
      session="s"
      hidden={hidden?.()}
      onAtEnd={(v) => (atEnd = v)}
    />
  ));
  const tl = container.querySelector<HTMLElement>(".tl-timeline");
  if (!tl) throw new Error("no timeline");
  const img = () => {
    const found = tl.querySelector<HTMLImageElement>(".tl-md-pictures img");
    if (!found) throw new Error("no picture drawn");
    return found;
  };
  /** Whether the view offers "Latest": it reports leaving the live end. */
  const offered = () => !atEnd;
  return { tl, img, offered };
}

/** Let the re-pin a picture's load schedules run. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("<MessagesTimeline> while its pictures load", () => {
  it("keeps a reader at the live end there when a picture arrives and grows the content", async () => {
    const { tl, img, offered } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700; // at the bottom: 1000 - 700 - 300 = 0
    fireEvent.scroll(tl);

    g.content = 1320; // the chart drew, 320px tall
    img().dispatchEvent(new window.Event("load")); // load does not bubble
    await settle();

    expect(tl.scrollTop).toBe(1020);
    expect(offered(), "the reader is at the live end, so nothing offers to take them there").toBe(
      false,
    );
  });

  it("keeps the live end when a picture cannot be read and its text takes its place", async () => {
    const { tl, img } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700;
    fireEvent.scroll(tl);

    g.content = 1040; // the broken image's box, then the path text
    img().dispatchEvent(new window.Event("error"));
    await settle();

    expect(tl.querySelector(".tl-md-pictures img")).toBe(null);
    expect(tl.scrollTop).toBe(740);
  });

  // Since the T3 pass (2026-09-27) a call's pictures are drawn under the work
  // group holding it, folded or open, and under a settled turn's fold while
  // the fold hides the group.
  const READ_SHOT: Event[] = [
    ev({ id: 1, kind: "user", body: "look at it" }),
    ev({
      id: 2,
      kind: "tool_use",
      tool: "Read",
      toolId: "toolu_01EaDF17CdmXP8Wc3ctiXaL2",
      body: '{"file_path":"/tmp/claude-1000/x/scratchpad/shot.png"}',
    }),
    ev({
      id: 3,
      kind: "tool_result",
      toolId: "toolu_01EaDF17CdmXP8Wc3ctiXaL2",
      images: [{ n: 0, mediaType: "image/png", bytes: 139874 }],
    }),
  ];

  it.each([
    ["a running work group", READ_SHOT, ".tl-row-group .tl-group-pics .tl-tool-thumb img"],
    [
      "a settled turn's fold",
      [
        READ_SHOT[0]!,
        ev({ id: 11, kind: "text", body: "reading it" }),
        ...READ_SHOT.slice(1),
        ev({ id: 4, kind: "text", body: "the header overlaps" }),
        ev({ id: 5, kind: "turn_end" }),
      ],
      ".tl-row-fold .tl-group-pics .tl-tool-thumb img",
    ],
    [
      "a settled turn's one work group",
      [
        ...READ_SHOT,
        ev({ id: 4, kind: "text", body: "the header overlaps" }),
        ev({ id: 5, kind: "turn_end" }),
      ],
      ".tl-row-group .tl-group-pics .tl-tool-thumb img",
    ],
  ])("keeps the live end when a thumbnail arrives under %s", async (_what, events, selector) => {
    const { container } = render(() => (
      <MessagesTimeline events={events} me="wizard" session="s" />
    ));
    const tl = container.querySelector<HTMLElement>(".tl-timeline")!;
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700;
    fireEvent.scroll(tl);

    g.content = 1086; // the thumbnail, 76px tall plus its gap
    const img = tl.querySelector(selector);
    expect(img, "the thumbnail is drawn while the group is folded").not.toBe(null);
    img!.dispatchEvent(new window.Event("load"));
    await settle();

    expect(tl.scrollTop).toBe(786);
  });

  it("leaves a reader who scrolled up where they were", async () => {
    const { tl, img, offered } = mount();
    const g = geometry(tl, { content: 1000, client: 300 });
    fireEvent.wheel(tl, { deltaY: -120 }); // the reader scrolls up
    tl.scrollTop = 100;
    fireEvent.scroll(tl);
    expect(offered()).toBe(true);

    g.content = 1320;
    img().dispatchEvent(new window.Event("load"));
    await settle();

    expect(tl.scrollTop).toBe(100);
    expect(offered()).toBe(true);
  });

  it("writes nothing while it is hidden behind the drill-in", async () => {
    const [hidden, setHidden] = createSignal(false);
    const { tl, img } = mount(hidden);
    const g = geometry(tl, { content: 1000, client: 300 });
    tl.scrollTop = 700;
    fireEvent.scroll(tl);

    setHidden(true);
    g.content = 1320;
    img().dispatchEvent(new window.Event("load"));
    await settle();

    // Showing it again is the pin effect's to handle, from the geometry it has then.
    expect(tl.scrollTop).toBe(700);
  });
});
