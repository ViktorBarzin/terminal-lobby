/**
 * The live group at the end of the conversation (the T3 pass, 2026-09-27).
 *
 * The composer's status line goes, and the session's state lives where the
 * work is: the running work group names the call in flight with a spinner and
 * counts the calls done and the time so far ("Running sleep 6 && echo b · 2
 * done · 14s"). Before the first call a row in the same place says "Working…";
 * while Claude is stopped on the reader it says "Waiting for you" with a still
 * dot, unless a docked card is what it waits on (the card says so, and the
 * TextView tests cover that); while this device's plan answer clears the
 * context it says so.
 *
 * One clock for the whole timeline, running only while a turn is open, and one
 * live indicator per open turn. A screen reader hears the kind of state
 * change, never the clock.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { deriveRows, liveRow, type WorkingRow } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const bash = (id: number, toolId: string, command: string, at: number): Event =>
  ev({ id, kind: "tool_use", tool: "Bash", toolId, body: JSON.stringify({ command }), at });

const askBody = JSON.stringify({
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      multiSelect: false,
      options: [{ label: "Red", description: "" }],
    },
  ],
});

const liveBoxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>(".tl-timeline .tl-group-box[data-live]"));
const liveBox = (c: HTMLElement) => {
  const boxes = liveBoxes(c);
  expect(boxes, "one live indicator per open turn").toHaveLength(1);
  return boxes[0]!;
};
const sum = (c: HTMLElement) => liveBox(c).querySelector(".tl-group-sum")!.textContent;
const meta = (c: HTMLElement) => liveBox(c).querySelector(".tl-group-meta")?.textContent ?? "";
const spoken = (c: HTMLElement) => c.querySelector(".tl-timeline-live")!.textContent;

describe("while a call runs", () => {
  it("names it on the running group, with a spinner, the count done and the time", () => {
    vi.useFakeTimers({ now: 20_000 });
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "ls", 6_000),
      ev({ id: 3, kind: "tool_result", toolId: "b1", body: "a", at: 7_000 }),
      bash(4, "b2", "sleep 6 && echo b", 8_000),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    const box = liveBox(container);
    expect(box.getAttribute("data-live")).toBe("working");
    expect(box.closest(".tl-row-group"), "the group itself carries it").not.toBeNull();
    expect(box.querySelector(".tl-group-spin")).not.toBeNull();
    expect(sum(container)).toBe("Running sleep 6 && echo b");
    expect(meta(container)).toBe("1 done · 14s");
  });

  it.each([
    [
      "an edit by its verb and file name",
      {
        tool: "Edit",
        input: { file_path: "/w/src/store/session.ts", old_string: "a", new_string: "b" },
      },
      "Editing session.ts",
      "edit",
    ],
    [
      "a command with Claude's description of it, muted",
      { tool: "Bash", input: { command: "npm test", description: "Run the card tests" } },
      "Running npm test · Run the card tests",
      "command",
    ],
    [
      "a search and where it looks",
      { tool: "Grep", input: { pattern: "liveGroupState", path: "src" } },
      "Searching for liveGroupState · in src",
      "search",
    ],
  ])("says %s, with the call's icon", (_name, call, words, icon) => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: call.tool,
        toolId: "c1",
        body: JSON.stringify(call.input),
        at: 2_000,
      }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    expect(sum(container)).toBe(words);
    expect(liveBox(container).querySelector(".tl-group-ico")?.getAttribute("data-icon")).toBe(icon);
  });

  it("shows a path by its file name, with the call's whole label in the title", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Read",
        toolId: "r1",
        body: JSON.stringify({ file_path: "/home/wizard/code/frontend-v2/src/QuestionCard.tsx" }),
        at: 2_000,
      }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    const code = liveBox(container).querySelector(".tl-group-sum code")!;
    expect(code.textContent).toBe("QuestionCard.tsx");
    // The label is the path as the call row shows it; the title keeps all of it.
    expect(code.getAttribute("title")).toMatch(/\/QuestionCard\.tsx$/);
  });
});

describe("before the first call", () => {
  it("draws a row of its own at the end that says Claude is working", () => {
    vi.useFakeTimers({ now: 10_000 });
    const events = [ev({ id: 1, kind: "user", body: "go", at: 4_000 })];
    const { container } = render(() => <MessagesTimeline events={events} />);
    const box = liveBox(container);
    expect(box.closest(".tl-row-live")).not.toBeNull();
    expect(box.querySelector(".tl-group-spin")).not.toBeNull();
    expect(sum(container)).toBe("Working…");
    expect(meta(container)).toBe("6s");
    // It is the last row, after the bubble that opened the turn.
    const rows = Array.from(container.querySelectorAll(".tl-timeline > .tl-row"));
    expect(rows.at(-1)!.classList.contains("tl-row-live")).toBe(true);
  });

  it("comes before the queued prompts, which land after it", () => {
    const events = [ev({ id: 1, kind: "user", body: "go", at: 4_000 })];
    const { container } = render(() => <MessagesTimeline events={events} queued={["also this"]} />);
    const rows = Array.from(container.querySelectorAll(".tl-timeline > .tl-row"));
    const live = rows.findIndex((r) => r.classList.contains("tl-row-live"));
    const ghost = rows.findIndex((r) => r.classList.contains("tl-row-ghost"));
    expect(live).toBeGreaterThan(-1);
    expect(ghost).toBeGreaterThan(live);
  });
});

describe("while Claude waits on the reader", () => {
  it("says so with a still dot and no spinner", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "pick", at: 1_000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "AskUserQuestion",
        toolId: "q1",
        body: askBody,
        at: 2_000,
      }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    const box = liveBox(container);
    expect(box.getAttribute("data-live")).toBe("waiting");
    expect(sum(container)).toBe("Waiting for you");
    expect(box.querySelector(".tl-group-spin")).toBeNull();
    expect(box.querySelector(".tl-live-dot")).not.toBeNull();
  });

  it("waits on the running group when a prompt holds its call", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "rm -rf x", 2_000),
    ];
    const rows = deriveRows(events);
    const live: WorkingRow = { ...liveRow(rows)!, waiting: true };
    const { container } = render(() => (
      <MessagesTimeline events={events} rows={rows} live={live} />
    ));
    const box = liveBox(container);
    expect(box.closest(".tl-row-group")).not.toBeNull();
    expect(sum(container)).toBe("Waiting for you");
    expect(box.querySelector(".tl-group-head > .tl-group-spin")).toBeNull();
  });
});

describe("the view's own reading of the turn", () => {
  it("draws no live group when the view says no turn is open", () => {
    const events = [ev({ id: 1, kind: "user", body: "/help", at: 1_000 })];
    const { container } = render(() => <MessagesTimeline events={events} live={null} />);
    expect(liveBoxes(container)).toHaveLength(0);
  });

  it("says the context is clearing for the plan this device approved", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "plan it", at: 1_000 }),
      ev({ id: 2, kind: "text", body: "Here is the plan.", at: 2_000 }),
      ev({ id: 3, kind: "turn_end", at: 3_000 }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} clearing />);
    const box = liveBox(container);
    expect(box.getAttribute("data-live")).toBe("clearing");
    expect(sum(container)).toBe("Clearing the context and starting the plan…");
    expect(box.querySelector(".tl-group-spin")).not.toBeNull();
  });

  it("draws nothing once the turn has ended", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      ev({ id: 2, kind: "text", body: "done", at: 2_000 }),
      ev({ id: 3, kind: "turn_end", at: 3_000 }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    expect(liveBoxes(container)).toHaveLength(0);
  });

  // The drill-in draws the agent's own working row; the live group would be a
  // second indicator for the same turn.
  it("leaves the drill-in to its working row", () => {
    const events = [ev({ id: 1, kind: "user", body: "go", at: 1_000 })];
    const { container } = render(() => (
      <MessagesTimeline
        events={events}
        rows={deriveRows(events, { fold: false, group: false })}
        workingRow
      />
    ));
    expect(liveBoxes(container)).toHaveLength(0);
    expect(container.querySelectorAll(".tl-row-working")).toHaveLength(1);
  });
});

describe("the clock", () => {
  it("ticks once a second while a turn is open, and stops when it closes", () => {
    vi.useFakeTimers({ now: 10_000 });
    const open = [ev({ id: 1, kind: "user", body: "go", at: 5_000 })];
    const [events, setEvents] = createSignal<Event[]>(open);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    expect(meta(container)).toBe("5s");
    vi.advanceTimersByTime(3_000);
    expect(meta(container)).toBe("8s");
    expect(vi.getTimerCount(), "one interval for the whole timeline").toBe(1);
    setEvents([
      ...open,
      ev({ id: 2, kind: "text", body: "done", at: 9_000 }),
      ev({ id: 3, kind: "turn_end", at: 9_000 }),
    ]);
    expect(vi.getTimerCount(), "no clock while nothing runs").toBe(0);
  });
});

describe("what a screen reader hears", () => {
  it("speaks once per change of state, never per tick of the clock", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const working = [ev({ id: 1, kind: "user", body: "go", at: 9_000 })];
    const [events, setEvents] = createSignal<Event[]>(working);
    const { container } = render(() => <MessagesTimeline events={events()} />);
    const region = container.querySelector(".tl-timeline-live")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(spoken(container)).toBe("Claude is working");

    const changes: string[] = [];
    const mo = new MutationObserver(() => changes.push(region.textContent ?? ""));
    mo.observe(region, { childList: true, characterData: true, subtree: true });
    vi.advanceTimersByTime(4_000);
    await Promise.resolve();
    expect(changes, "no announcement from the clock").toEqual([]);
    // The ticking row itself is kept out of the log's announcements.
    expect(liveBox(container).getAttribute("aria-live")).toBe("off");

    setEvents([
      ...working,
      ev({
        id: 2,
        kind: "tool_use",
        tool: "AskUserQuestion",
        toolId: "q1",
        body: askBody,
        at: 11_000,
      }),
    ]);
    await Promise.resolve();
    expect(spoken(container)).toBe("Claude is waiting for you");
    setEvents([
      ...working,
      ev({ id: 3, kind: "text", body: "done", at: 12_000 }),
      ev({ id: 4, kind: "turn_end", at: 12_000 }),
    ]);
    await Promise.resolve();
    expect(spoken(container)).toBe("Claude finished");
    mo.disconnect();
  });

  it("says nothing on arrival at an idle session", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      ev({ id: 2, kind: "turn_end", at: 2_000 }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    expect(spoken(container)).toBe("");
  });
});

describe("the running group still opens", () => {
  it("lists its calls when pressed, the one in flight spinning", () => {
    const events = [
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "ls", 2_000),
      ev({ id: 3, kind: "tool_result", toolId: "b1", body: "a", at: 2_500 }),
      bash(4, "b2", "sleep 6", 3_000),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    fireEvent.click(liveBox(container).querySelector(".tl-group-head")!);
    const calls = container.querySelectorAll(".tl-group-call");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.getAttribute("data-status")).toBe("running");
  });
});
