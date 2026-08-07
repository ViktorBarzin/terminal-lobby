import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

describe("<MessagesTimeline> (smoke)", () => {
  it("renders a settled turn: user bubble, folded work, and the final markdown answer", () => {
    const events: Event[] = [
      ev({ id: 1, kind: "user", body: "please list files" }),
      ev({ id: 2, kind: "text", body: "let me check" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "README.md" }),
      ev({ id: 5, kind: "text", body: "All **done** now." }),
      ev({ id: 6, kind: "turn_end" }),
    ];

    const { container, getByText, queryByText, getByRole } = render(() => (
      <MessagesTimeline events={events} />
    ));

    // user prompt is shown
    expect(getByText("please list files")).toBeInTheDocument();
    // final assistant message rendered through markdown (bold -> <strong>)
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("done");
    expect(container.textContent).toContain("All");
    // the fold summary is present, and folded work (the Bash tool) is hidden
    expect(getByText(/Worked/)).toBeInTheDocument();
    expect(getByText(/2 steps/)).toBeInTheDocument();
    expect(queryByText("Bash")).toBeNull();

    // expanding the fold reveals the hidden tool row
    fireEvent.click(getByRole("button", { name: /Worked/ }));
    expect(getByText("Bash")).toBeInTheDocument();
  });

  it("shows a working indicator while the last turn is still running", () => {
    const events: Event[] = [
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "text", body: "on it" }),
    ];
    const { getByText } = render(() => <MessagesTimeline events={events} />);
    expect(getByText("Working…")).toBeInTheDocument();
    expect(getByText("on it")).toBeInTheDocument();
  });

  it("renders an empty state with no events", () => {
    const { getByText } = render(() => <MessagesTimeline events={[]} />);
    expect(getByText(/No messages yet/)).toBeInTheDocument();
  });
});

/**
 * Row identity across a stream append.
 *
 * `<For>` reconciles by object REFERENCE and deriveRows allocates fresh rows on
 * every call, so a single SSE event tore down and rebuilt the whole timeline:
 * measured in a browser, an expanded tool row snapped shut mid-turn and every
 * mermaid diagram re-mounted (its generated svg id walked tl-mmd-5 → 6 → 8 in
 * one turn). Node identity is the testable core of that: a diagram can only
 * re-render if the subtree holding it was re-created.
 */
describe("<MessagesTimeline> row identity", () => {
  /** A running turn — rows render unfolded, so the tool row is reachable. */
  const LIVE: Event[] = [
    ev({ id: 1, kind: "user", body: "read the notes" }),
    ev({ id: 2, kind: "text", body: "on it" }),
    ev({
      id: 3,
      kind: "tool_use",
      tool: "Read",
      toolId: "t1",
      body: '{"file_path":"notes.txt"}',
    }),
  ];

  it("keeps every existing row's DOM node when an event arrives", () => {
    const [events, setEvents] = createSignal<Event[]>(LIVE);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const before = [...container.querySelectorAll(".tl-row")];
    expect(before.length).toBeGreaterThan(2);

    setEvents([...LIVE, ev({ id: 4, kind: "text", body: "here it is" })]);

    const after = [...container.querySelectorAll(".tl-row")];
    expect(after).toHaveLength(before.length + 1);
    for (const node of before) {
      expect(
        after.includes(node),
        `${node.className} was re-created instead of updated in place`,
      ).toBe(true);
    }
  });

  it("leaves an expanded tool row expanded when its own result lands", () => {
    const [events, setEvents] = createSignal<Event[]>(LIVE);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const tool = container.querySelector(".tl-row-tool")!;
    const toggle = tool.querySelector(".tl-tool-toggle")!;
    fireEvent.click(toggle);
    expect(tool.querySelector(".tl-code")).not.toBeNull();
    expect(tool.getAttribute("data-status")).toBe("running");

    setEvents([
      ...LIVE,
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "line one" }),
    ]);

    expect(container.querySelector(".tl-row-tool")).toBe(tool);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // …and the row updated in place rather than being replaced.
    expect(tool.getAttribute("data-status")).toBe("ok");
    expect(tool.textContent).toContain("line one");
  });
});

/**
 * Turn folds toggle both ways. Expanding used to remove the fold row from the
 * DOM, so nothing could put the turn back short of a reload — while the tool
 * rows right next to it toggled correctly in the same component.
 */
describe("<MessagesTimeline> turn fold", () => {
  const SETTLED: Event[] = [
    ev({ id: 1, kind: "user", body: "do it" }),
    ev({ id: 2, kind: "text", body: "thinking" }),
    ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
    ev({ id: 4, kind: "text", body: "all done" }),
    ev({ id: 5, kind: "turn_end" }),
  ];

  it("expands and re-folds, with the caret and aria-expanded following state", () => {
    const { container } = render(() => <MessagesTimeline events={SETTLED} />);
    const fold = container.querySelector(".tl-fold-btn")!;
    const caret = () => container.querySelector(".tl-fold-caret")!.textContent;

    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(caret()).toBe("▸");
    expect(container.querySelector(".tl-row-tool")).toBeNull();

    fireEvent.click(fold);
    expect(container.querySelector(".tl-row-tool")).not.toBeNull();
    expect(container.querySelector(".tl-fold-btn")).toBe(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(caret()).toBe("▾");

    fireEvent.click(fold);
    expect(container.querySelector(".tl-row-tool")).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(caret()).toBe("▸");
  });
});

/**
 * A collapsed fold that hides a FAILED step used to read exactly
 * "▸ Worked for 5s · 1 step" — count and duration, nothing else. The failure
 * was still narrated by the visible assistant message and still visible on
 * expansion (the ✗, the "output (error)" label, the red output), so nothing
 * malfunctioned; the fold row alone gave the eye no reason to open it.
 */
describe("<MessagesTimeline> collapsed failure signal", () => {
  const FAILED: Event[] = [
    ev({ id: 1, kind: "user", body: "read the missing file" }),
    ev({ id: 2, kind: "text", body: "reading it" }),
    ev({
      id: 3,
      kind: "tool_use",
      tool: "Read",
      toolId: "t1",
      body: '{"file_path":"/nope.txt"}',
    }),
    ev({
      id: 4,
      kind: "tool_result",
      toolId: "t1",
      body: "ENOENT: no such file",
      isError: true,
    }),
    ev({ id: 5, kind: "text", body: "the read failed: no such file" }),
    ev({ id: 6, kind: "turn_end" }),
  ];

  const HEALTHY: Event[] = [
    ev({ id: 1, kind: "user", body: "read the notes" }),
    ev({ id: 2, kind: "text", body: "reading it" }),
    ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: "{}" }),
    ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hello", isError: false }),
    ev({ id: 5, kind: "text", body: "here it is" }),
    ev({ id: 6, kind: "turn_end" }),
  ];

  it("marks the collapsed fold row when it hides a failure", () => {
    const { container } = render(() => <MessagesTimeline events={FAILED} />);
    const btn = container.querySelector(".tl-fold-btn")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("data-has-error")).toBe("true");
    const signal = container.querySelector(".tl-fold-error");
    expect(signal).not.toBeNull();
    expect(signal!.textContent).toContain("✗");
    // …and the label says so in words, not by colour alone.
    expect(btn.textContent).toContain("failed");
  });

  it("renders no failure signal on a healthy turn", () => {
    const { container } = render(() => <MessagesTimeline events={HEALTHY} />);
    const btn = container.querySelector(".tl-fold-btn")!;
    expect(btn.getAttribute("data-has-error")).toBeNull();
    expect(container.querySelector(".tl-fold-error")).toBeNull();
    expect(btn.textContent).not.toContain("failed");
  });

  it("still shows the ✗, the output (error) label and the red output when expanded", () => {
    const { container } = render(() => <MessagesTimeline events={FAILED} />);
    fireEvent.click(container.querySelector(".tl-fold-btn")!);
    const tool = container.querySelector(".tl-row-tool")!;
    expect(tool.getAttribute("data-status")).toBe("error");
    expect(tool.querySelector(".tl-tool-tick")!.textContent).toBe("✗");

    fireEvent.click(tool.querySelector(".tl-tool-toggle")!);
    const labels = [...tool.querySelectorAll(".tl-tool-section-label")].map(
      (n) => n.textContent,
    );
    expect(labels).toContain("output (error)");
    expect(tool.querySelector(".tl-code-error")!.textContent).toContain("ENOENT");
  });
});
