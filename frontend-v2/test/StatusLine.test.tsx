/**
 * The composer's thin line, as it stands while the T3 pass replaces it: Stop
 * while something runs, background work once the turn has closed, the watching
 * state with Take control, and the dials on the right.
 *
 * The turn's own words (working, waiting, clearing, the clock and the step
 * count) moved into the live group at the end of the conversation on
 * 2026-09-27 (MessagesTimeline.live.test.tsx).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { StatusLine } from "../src/components/StatusLine";
import type { WorkingRow } from "../src/components/timeline.logic";

afterEach(() => {
  vi.useRealTimers();
});

const row = (over: Partial<WorkingRow> = {}): WorkingRow => ({
  kind: "working",
  key: "working-t1",
  turnKey: "t1",
  steps: 7,
  ...over,
});

const state = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-status-state")!;
const live = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-statusline [aria-live]")!;

describe("while Claude works", () => {
  // The T3 pass (2026-09-27) moved the working words, the clock and the step
  // count into the live group at the end of the conversation
  // (MessagesTimeline.live.test.tsx). Stop stays on the line until the
  // composer's round button takes it over.
  it("offers Stop and nothing else on the left: the conversation says what runs", () => {
    const { container } = render(() => (
      <StatusLine
        live={row({
          tool: "Edit",
          toolLabel: "a/QuestionCard.tsx",
          toolStartedAt: Date.now() - 252_000,
        })}
        onStop={() => {}}
      />
    ));
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("working");
    expect(s.textContent).toBe("Stop");
    expect(s.querySelector(".tl-status-word")).toBeNull();
    expect(s.textContent).not.toContain("4m 12s");
  });

  it("Stop stops", () => {
    const onStop = vi.fn();
    const { container } = render(() => <StatusLine live={row()} onStop={onStop} />);
    const stop = state(container).querySelector<HTMLButtonElement>(".tl-stop")!;
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("keeps no clock of its own", () => {
    vi.useFakeTimers();
    render(() => (
      <StatusLine live={row({ toolStartedAt: Date.now() - 5_000 })} onStop={() => {}} />
    ));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("while Claude waits for the reader", () => {
  // A red Stop beside "waiting" read as an alarm; the ways out of a wait are
  // the card's own buttons, Send and the terminal.
  it("shows no Stop, and leaves the words to the conversation", () => {
    const { container } = render(() => (
      <StatusLine
        live={row({ waiting: true, toolStartedAt: Date.now() - 12_000 })}
        onStop={() => {}}
      />
    ));
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("idle");
    expect(s.textContent).toBe("");
    expect(container.querySelector(".tl-stop")).toBeNull();
  });
});

describe("once the turn has closed and work is still running", () => {
  it("says what the session still owes, in the session list's own words", () => {
    const { container } = render(() => <StatusLine background="2 agents" />);
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("background");
    expect(s.querySelector(".tl-status-long")?.textContent).toBe(
      "Still working in the background:",
    );
    // The narrow line keeps the short word, from the same markup.
    expect(s.querySelector(".tl-status-short")?.textContent).toBe("Background:");
    expect(s.querySelector(".tl-status-target")?.textContent).toBe("2 agents");
    // Stop ends a turn, and there is none.
    expect(container.querySelector(".tl-stop")).toBeNull();
  });
});

describe("on a device that only watches", () => {
  const reason = "Watching: this device does not type into the session";

  it("says it is watching, and why nothing here types", () => {
    const { container } = render(() => (
      <StatusLine live={row()} inertReason={reason} onStop={() => {}} />
    ));
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("watching");
    expect(s.querySelector(".tl-status-word")?.textContent).toBe("Watching");
    expect(s.querySelector(".tl-status-reason")?.textContent).toContain(
      "this device does not type into the session",
    );
  });

  // Stop types into the pane, which a watching device does not do.
  it("hides Stop even while the session it watches is working", () => {
    const { container } = render(() => (
      <StatusLine live={row()} inertReason={reason} onStop={() => {}} />
    ));
    expect(container.querySelector(".tl-stop")).toBeNull();
  });

  it("offers Take control only when there is a way to take it", () => {
    const without = render(() => <StatusLine inertReason={reason} />);
    expect(without.container.querySelector(".tl-take")).toBeNull();
    without.unmount();

    const onTakeControl = vi.fn();
    const { container } = render(() => (
      <StatusLine inertReason={reason} onTakeControl={onTakeControl} />
    ));
    fireEvent.click(container.querySelector(".tl-take")!);
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });
});

describe("what a screen reader hears", () => {
  // The turn's own states are announced by the timeline now; the line speaks
  // only for what it still shows.
  it("says when background work outlives the turn, and nothing for the turn itself", async () => {
    const [bg, setBg] = createSignal<string | undefined>(undefined);
    const [liveRow, setLive] = createSignal<WorkingRow | undefined>(row());
    const { container } = render(() => (
      <StatusLine live={liveRow()} background={bg()} onStop={() => {}} />
    ));
    expect(live(container).textContent).toBe("");
    setLive(undefined);
    setBg("2 agents");
    await Promise.resolve();
    expect(live(container).textContent).toBe("Background work is still running");
  });

  it("says nothing on arrival at an idle session", () => {
    const { container } = render(() => <StatusLine />);
    expect(live(container).textContent).toBe("");
  });
});

describe("the dials' slot", () => {
  it("puts whatever it is given after the state, on the right", () => {
    const { container } = render(() => (
      <StatusLine>
        <button type="button" class="probe-dial">
          mode
        </button>
      </StatusLine>
    ));
    const line = container.querySelector(".tl-statusline")!;
    const kids = Array.from(line.children).map((e) => e.className.split(" ")[0]);
    expect(kids.indexOf("tl-status-state")).toBeLessThan(kids.indexOf("tl-dials-slot"));
    expect(line.querySelector(".tl-dials-slot .probe-dial")).not.toBeNull();
  });

  it("starts wide where nothing has measured it", () => {
    const { container } = render(() => <StatusLine />);
    expect(container.querySelector(".tl-statusline")!.getAttribute("data-room")).toBe("wide");
  });
});
