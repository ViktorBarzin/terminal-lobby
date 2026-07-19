import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
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
