import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import type { TimelineRow, TurnFoldRow } from "../src/components/timeline.logic";

/**
 * How many times the timeline compares a row, and which rows it compared.
 *
 * The comparison is the whole of the change detection: deriveRows allocates
 * fresh row objects on every call, so `sameRow` is the only thing that can
 * tell a row that CHANGED from a row that was merely recomputed. Counting the
 * calls is therefore counting the work, and it is the one part of this that a
 * test can see. A memo that re-ran and decided nothing changed leaves no trace
 * in the DOM, by design.
 *
 * Recursive calls do not land here: `sameRow` recurses through its own module
 * binding, so only the calls the renderer makes are counted.
 */
const spy = vi.hoisted(() => ({ keys: [] as string[] }));

vi.mock("../src/components/timeline.logic", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/components/timeline.logic")>();
  return {
    ...mod,
    sameRow: (a: TimelineRow, b: TimelineRow): boolean => {
      spy.keys.push(b.key);
      return mod.sameRow(a, b);
    },
  };
});

const { MessagesTimeline } = await import("../src/components/MessagesTimeline");
const { deriveRows, sameRow, visibleRows } = await import("../src/components/timeline.logic");

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

/**
 * Two settled turns and one still running: eleven visible rows, which is under
 * FIRST_MOUNT_ROWS, so the whole list is mounted on the first paint and the
 * progressive fill never runs. That keeps every count below a number the test
 * can state rather than one it has to wait for.
 */
const TRANSCRIPT: Event[] = [
  ev({ id: 1, kind: "user", body: "first prompt" }),
  ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
  ev({ id: 3, kind: "tool_result", toolId: "t1", body: "README.md" }),
  ev({ id: 4, kind: "text", body: "first answer" }),
  ev({ id: 5, kind: "turn_end" }),
  ev({ id: 6, kind: "user", body: "second prompt" }),
  ev({ id: 7, kind: "tool_use", tool: "Read", toolId: "t2", body: '{"file_path":"a.txt"}' }),
  ev({ id: 8, kind: "tool_result", toolId: "t2", body: "hello" }),
  ev({ id: 9, kind: "text", body: "second answer" }),
  ev({ id: 10, kind: "turn_end" }),
  ev({ id: 11, kind: "user", body: "third prompt" }),
  ev({ id: 12, kind: "text", body: "working on it" }),
];

const visibleKeys = (events: Event[], expanded = new Set<string>()): string[] =>
  visibleRows(deriveRows(events), expanded).map((r) => r.key);

beforeEach(() => {
  spy.keys = [];
});

/**
 * The cost this file exists to hold down.
 *
 * `keyed` returns a fresh object literal on every run and carries no `equals`,
 * so it notifies on every stream event. While each row found itself by reading
 * `keyed()` from inside its own memo, that notification reached one memo per
 * mounted row, and each of those called `sameRow` through its `equals`. The
 * rows are never unmounted (see the note in MessagesTimeline.tsx), so the
 * multiplier was the whole transcript against every event, sixty times a
 * second while a turn runs.
 */
describe("<MessagesTimeline> per-event comparison", () => {
  it("compares each mounted row at most once per stream event", () => {
    const [events, setEvents] = createSignal<Event[]>(TRANSCRIPT);
    render(() => <MessagesTimeline events={events()} />);

    const whole = [...TRANSCRIPT, ev({ id: 13, kind: "text", body: "an update" })];
    spy.keys = [];
    setEvents(whole);

    // No row is asked twice. This is what rules out the other shape on offer:
    // an `equals` on `keyed` would compare the whole list once to decide
    // whether to notify, and every row again afterwards when one of them had
    // moved, which during a live turn is every event.
    expect(new Set(spy.keys).size).toBe(spy.keys.length);
    // …and nothing outside what is on screen is compared.
    const mounted = visibleKeys(whole);
    for (const key of spy.keys) expect(mounted).toContain(key);
    expect(spy.keys.length).toBeLessThanOrEqual(mounted.length);
  });

  it("compares the same number of rows however many events arrive", () => {
    const [events, setEvents] = createSignal<Event[]>(TRANSCRIPT);
    render(() => <MessagesTimeline events={events()} />);

    spy.keys = [];
    setEvents([...TRANSCRIPT, ev({ id: 13, kind: "text", body: "one" })]);
    const first = spy.keys.length;

    spy.keys = [];
    setEvents([
      ...TRANSCRIPT,
      ev({ id: 13, kind: "text", body: "one" }),
      ev({ id: 14, kind: "text", body: "two" }),
    ]);
    // One more row on screen, one more comparison. Not a comparison per row
    // per row.
    expect(spy.keys.length).toBe(first + 1);
  });

  it("stops comparing a row once it leaves the list", () => {
    const { container } = render(() => <MessagesTimeline events={TRANSCRIPT} />);
    const fold = deriveRows(TRANSCRIPT).find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const hiddenKey = fold.hidden[0]!.key;

    // Unfolding puts the turn's hidden rows on screen, so they get holders of
    // their own and join the per-event pass.
    fireEvent.click(container.querySelector(".tl-fold-btn")!);
    spy.keys = [];
    fireEvent.click(container.querySelectorAll(".tl-fold-btn")[1]!);
    expect(spy.keys).toContain(hiddenKey);

    // Re-folding takes them off screen again. Their holders have to go with
    // them, or the pass walks rows nobody can see for the rest of the session.
    // That is the leak that matters most here, since the sliding transcript
    // window drops the oldest turns all day.
    fireEvent.click(container.querySelector(".tl-fold-btn")!);
    spy.keys = [];
    fireEvent.click(container.querySelectorAll(".tl-fold-btn")[1]!);
    expect(spy.keys).not.toContain(hiddenKey);
  });
});

/**
 * Nothing above may change what the reader sees. The rows arriving over a
 * stream have to land on the same DOM as the rows that were there from the
 * start.
 */
describe("<MessagesTimeline> rendering is unchanged", () => {
  it("draws the same DOM whether the last event arrived with the rest or over the stream", () => {
    const whole = [...TRANSCRIPT, ev({ id: 13, kind: "text", body: "an update" })];

    const [events, setEvents] = createSignal<Event[]>(TRANSCRIPT);
    const { container: streamed } = render(() => <MessagesTimeline events={events()} />);
    setEvents(whole);

    const { container: atOnce } = render(() => <MessagesTimeline events={whole} />);
    expect(streamed.innerHTML).toBe(atOnce.innerHTML);
  });

  it("updates the row that changed and leaves the rest alone", () => {
    const live: Event[] = [
      ev({ id: 1, kind: "user", body: "read the notes" }),
      ev({ id: 2, kind: "text", body: "on it" }),
      ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: '{"file_path":"a.txt"}' }),
    ];
    const [events, setEvents] = createSignal<Event[]>(live);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const tool = container.querySelector(".tl-row-tool")!;
    const user = container.querySelector(".tl-row-user")!;
    const userText = user.querySelector(".tl-user-text")!;
    expect(tool.getAttribute("data-status")).toBe("running");

    setEvents([...live, ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hello" })]);

    // The tool row moved, so its view was told.
    expect(container.querySelector(".tl-row-tool")).toBe(tool);
    expect(tool.getAttribute("data-status")).toBe("ok");
    // The user row did not, so nothing about it was rebuilt, down to the node
    // inside the bubble that a re-render would have replaced.
    expect(container.querySelector(".tl-row-user")).toBe(user);
    expect(user.querySelector(".tl-user-text")).toBe(userText);
  });

  it("keeps an expanded tool row open across an unrelated event", () => {
    const live: Event[] = [
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
    ];
    const [events, setEvents] = createSignal<Event[]>(live);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const toggle = container.querySelector(".tl-tool-toggle")!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    setEvents([...live, ev({ id: 3, kind: "text", body: "something else entirely" })]);
    expect(container.querySelector(".tl-tool-toggle")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

/**
 * `sameRow` answers the same question it did before it stopped allocating two
 * key arrays per call. The field-count comparison is the part most easily lost
 * in that rewrite: it moved from before the value loop to after it, and the
 * case it exists for is a field that is present on one side and absent on the
 * other, which reads as `undefined` on both and passes every value check.
 */
describe("sameRow field sets", () => {
  const base = (): TimelineRow => ({
    kind: "message",
    key: "msg-1",
    id: 1,
    body: "hello",
    turnKey: "s1",
  });

  it("calls two identical derivations the same row", () => {
    expect(sameRow(base(), base())).toBe(true);
  });

  it("calls a row with an extra field a different row, from either side", () => {
    const extra = { ...base(), at: undefined } as unknown as TimelineRow;
    expect(sameRow(base(), extra)).toBe(false);
    expect(sameRow(extra, base())).toBe(false);
  });

  it("still compares the values it always did", () => {
    const changed = { ...base(), body: "goodbye" } as TimelineRow;
    expect(sameRow(base(), changed)).toBe(false);
    const optional = { ...base(), at: 1000 } as TimelineRow;
    expect(sameRow(base(), optional)).toBe(false);
    expect(sameRow(optional, { ...base(), at: 1000 } as TimelineRow)).toBe(true);
  });

  it("agrees with itself over a whole real transcript, both directions", () => {
    const a = visibleRows(deriveRows(TRANSCRIPT), new Set<string>());
    const b = visibleRows(deriveRows(TRANSCRIPT), new Set<string>());
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).not.toBe(b[i]);
      expect(sameRow(a[i]!, b[i]!), `row ${a[i]!.key}`).toBe(true);
      expect(sameRow(b[i]!, a[i]!), `row ${a[i]!.key} reversed`).toBe(true);
    }
  });
});
