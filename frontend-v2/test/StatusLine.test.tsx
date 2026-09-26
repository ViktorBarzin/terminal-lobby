/**
 * The composer's thin line: the session's state on the left, the dials on the
 * right, and Stop beside the work it stops.
 *
 * It took over from two things (Quiet line composer, 2026-09-24): the working
 * row at the foot of the timeline, which scrolled with the transcript and
 * stood 16px above the composer, and the background strip under the timeline.
 * The row's words carry over unchanged: the call in flight, its target, how
 * long it has run and the step count above one. What changed is WHERE, and
 * that Stop no longer shows while Claude is only waiting for the reader.
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
  it("names the call, its target, how long it has run and the steps so far", () => {
    const { container } = render(() => (
      <StatusLine
        live={row({
          tool: "Edit",
          toolLabel: "frontend-v2/src/components/QuestionCard.tsx",
          toolStartedAt: Date.now() - 252_000,
        })}
        onStop={() => {}}
      />
    ));
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("working");
    expect(s.querySelector(".tl-status-word")?.textContent).toBe("Working");
    expect(s.querySelector(".tl-status-tool")?.textContent).toBe("Edit");
    // The file's name on the line, the whole path in its title.
    const target = s.querySelector(".tl-status-target")!;
    expect(target.textContent).toBe("QuestionCard.tsx");
    expect(target.getAttribute("title")).toBe("frontend-v2/src/components/QuestionCard.tsx");
    expect(s.textContent).toContain("4m 12s");
    expect(s.querySelector(".tl-status-steps")?.textContent).toContain("7 steps");
  });

  it("leaves the step count out until there is more than one", () => {
    const { container } = render(() => <StatusLine live={row({ steps: 1 })} onStop={() => {}} />);
    expect(container.querySelector(".tl-status-steps")).toBeNull();
  });

  it("offers Stop beside the work, and Stop stops", () => {
    const onStop = vi.fn();
    const { container } = render(() => <StatusLine live={row()} onStop={onStop} />);
    const stop = state(container).querySelector<HTMLButtonElement>(".tl-stop")!;
    expect(stop.textContent).toContain("Stop");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ticks its clock once a second while the turn is open", () => {
    vi.useFakeTimers();
    const { container } = render(() => (
      <StatusLine live={row({ toolStartedAt: Date.now() - 5_000 })} onStop={() => {}} />
    ));
    expect(state(container).textContent).toContain("5s");
    vi.advanceTimersByTime(3_000);
    expect(state(container).textContent).toContain("8s");
  });
});

describe("while Claude waits for the reader", () => {
  // The turn is open because Claude asked something and stopped. The row said
  // "Working…" over this for a week of 57% of all quiet open turns (replayed
  // 2026-09-04), and a red Stop beside "waiting" read as an alarm.
  it("says so, with a still dot and no Stop", () => {
    const { container } = render(() => (
      <StatusLine
        live={row({ waiting: true, toolStartedAt: Date.now() - 12_000 })}
        onStop={() => {}}
      />
    ));
    const s = state(container);
    expect(s.getAttribute("data-kind")).toBe("waiting");
    expect(s.querySelector(".tl-status-word")?.textContent).toBe("Waiting for you");
    expect(s.textContent).toContain("12s");
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
  it("speaks once per change of state, never per tick of the clock", async () => {
    vi.useFakeTimers();
    const [liveRow, setLive] = createSignal<WorkingRow | undefined>(
      row({ toolStartedAt: Date.now() - 1_000 }),
    );
    const { container } = render(() => <StatusLine live={liveRow()} onStop={() => {}} />);
    expect(live(container).textContent).toBe("Claude is working");

    const changes: string[] = [];
    const mo = new MutationObserver(() => changes.push(live(container).textContent ?? ""));
    mo.observe(live(container), { childList: true, characterData: true, subtree: true });
    vi.advanceTimersByTime(4_000);
    await Promise.resolve();
    expect(changes, "no announcement from the clock").toEqual([]);

    setLive(row({ waiting: true }));
    await Promise.resolve();
    expect(live(container).textContent).toBe("Claude is waiting for you");
    setLive(undefined);
    await Promise.resolve();
    expect(live(container).textContent).toBe("Claude finished");
    mo.disconnect();
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
