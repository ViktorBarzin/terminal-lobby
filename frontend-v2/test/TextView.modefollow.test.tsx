/**
 * The mode dial follows a mode change the dial did not make.
 *
 * The CLI writes its `permission-mode` record when a turn starts, not when the
 * mode changes, so the pane is the live source (TextView.mode.test.tsx). It
 * was read when the view first opened and after the dial's own presses, and at
 * no other moment. Found live on 2026-09-26:
 *
 *  - approving a plan with "Yes, and bypass permissions" from the plan card
 *    put the session in Bypass while the dial read "Plan" with no danger
 *    styling for the whole approved turn;
 *  - "Yes, manually approve edits" left the dial on "Plan" after the turn had
 *    ended, until a reload;
 *  - a Shift+Tab typed in the Terminal left it stale on coming back.
 *
 * So the pane is also read after an approval from the card, whenever a turn
 * starts or ends, and each time the Text view comes back on screen.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerResponse } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

const STATUS = {
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  bypass: "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  manual: "  ⏸ manual mode on · ← for agents",
  edits: "  ⏵⏵ accept edits on (shift+tab to cycle)",
};
const pane = (status: string): string =>
  `❯ \n${"─".repeat(40)}\n  /home/wizard/code | 🤖 opus-5 | 🧠 23%\n${status}\n`;

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "qa", ...e });
const modeEvent = (id: number, mode: string): Event =>
  ev({ id, kind: "meta", meta: "permission-mode", body: mode });

const PLAN = {
  kind: "plan" as const,
  options: [
    { number: 1, label: "Yes, clear context (6% used) and bypass permissions" },
    { number: 2, label: "Yes, and bypass permissions" },
    { number: 3, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 4,
  planPath: "~/.claude/plans/plan-follow.md",
};
const PLAN_TEXT = "# Write hello.txt\n\n1. Write it.\n";

function mount(opts: { events: Event[]; onScreen?: boolean }) {
  const [events, setEvents] = createSignal<Event[]>(opts.events);
  const [onScreen, setOnScreen] = createSignal(opts.onScreen ?? true);
  let status = STATUS.plan;
  const onPane = vi.fn(async () => ({ pane: pane(status), state: "done" }));
  const onAnswer = vi.fn(async (): Promise<AnswerResponse> => ({ applied: true, done: true }));
  const r = render(() => (
    <TextView
      events={events()}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={async () => true}
      onPane={onPane}
      onAnswer={onAnswer}
      onScreen={onScreen()}
      notify={() => {}}
    />
  ));
  const dial = () => r.container.querySelector<HTMLElement>('.tl-dial[data-dial="mode"]');
  const option = (n: number) =>
    [...r.container.querySelectorAll<HTMLButtonElement>(".tl-plancard .tl-qcard-option")].find(
      (o) => o.querySelector(".tl-qcard-key")?.textContent === String(n),
    );
  return {
    setEvents,
    events,
    setOnScreen,
    onPane,
    onAnswer,
    option,
    shown: () => dial()?.querySelector(".tl-dial-value")?.textContent,
    /** The read the view makes when it opens has come back. */
    opened: async () => {
      await waitFor(() => expect(onPane).toHaveBeenCalled());
      await onPane.mock.results[0]!.value;
      await Promise.resolve();
    },
    /** What the pane will show from the next read on. */
    paneShows: (s: string) => {
      status = s;
    },
  };
}

const planTurn = (): Event[] => [
  modeEvent(1, "plan"),
  ev({ id: 2, kind: "user", body: "plan it", at: 2000 }),
  ev({
    id: 3,
    kind: "tool_use",
    tool: "ExitPlanMode",
    toolId: "p1",
    body: JSON.stringify({ plan: PLAN_TEXT }),
    at: 3000,
  }),
  ev({ id: 4, kind: "meta", meta: "asking", body: JSON.stringify(PLAN) }),
];

describe("<TextView>: the mode dial follows changes it did not make", () => {
  it("shows the mode an approval from the plan card switched to", async () => {
    const v = mount({ events: planTurn() });
    await waitFor(() => expect(v.option(2)).toBeDefined());
    await v.opened();
    expect(v.shown()).toBe("Plan");

    // The dialog closes and the CLI is in Bypass the moment the answer lands.
    v.paneShows(STATUS.bypass);
    v.option(2)!.click();
    await waitFor(() => expect(v.onAnswer).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(v.shown()).toBe("Bypass"));
  });

  it("reads the pane again when a turn ends, which is when a quiet mode change shows", async () => {
    const v = mount({
      events: [modeEvent(1, "plan"), ev({ id: 2, kind: "user", body: "go", at: 2000 })],
    });
    await v.opened();
    expect(v.shown()).toBe("Plan");
    const before = v.onPane.mock.calls.length;

    v.paneShows(STATUS.manual);
    v.setEvents([
      ...v.events(),
      ev({ id: 3, kind: "text", body: "done", at: 3000 }),
      ev({ id: 4, kind: "turn_end", at: 4000 }),
    ]);

    await waitFor(() => expect(v.shown()).toBe("Manual"));
    expect(v.onPane.mock.calls.length).toBeGreaterThan(before);
  });

  it("reads the pane again each time the Text view comes back on screen", async () => {
    const v = mount({ events: [modeEvent(1, "plan")] });
    await v.opened();
    expect(v.shown()).toBe("Plan");

    // Off to the Terminal, where a Shift+Tab moves the mode on.
    v.setOnScreen(false);
    v.paneShows(STATUS.edits);
    v.setOnScreen(true);

    await waitFor(() => expect(v.shown()).toBe("Edits"));
  });

  it("does not read the pane for a view nobody is looking at", async () => {
    const v = mount({ events: [modeEvent(1, "plan")], onScreen: false });
    v.setEvents([...v.events(), ev({ id: 2, kind: "user", body: "go", at: 2000 })]);
    v.setEvents([...v.events(), ev({ id: 3, kind: "turn_end", at: 3000 })]);
    await new Promise((r) => setTimeout(r, 50));
    expect(v.onPane).not.toHaveBeenCalled();
  });
});
