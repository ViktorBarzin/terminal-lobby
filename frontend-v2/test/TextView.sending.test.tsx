/**
 * A message shows the moment Send is pressed, dimmed with a spinner until the
 * session says it took it.
 *
 * Before this the bubble appeared only once POST /prompt answered: ~23 ms on a
 * quiet box, but 4 s or more while a suspended session wakes, and the field had
 * already emptied. Two places draw a message sent from here, and both say
 * "sending": the bubble of a new turn when the session is idle, and the ghost
 * at the end when a turn is running.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { PendingPrompt } from "../src/logic/compose.logic";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const SETTLED: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card", turnId: "t1" }),
  ev({ id: 2, kind: "text", body: "Done.", turnId: "t1" }),
  ev({ id: 3, kind: "turn_end", turnId: "t1" }),
];

const RUNNING: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card" }),
  ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"a.ts"}' }),
];

const prompt = (sending: boolean): PendingPrompt => ({
  id: -1,
  text: "also check the phone",
  at: 5,
  command: false,
  afterId: 3,
  sending,
});

function mount(events: Event[], first: PendingPrompt) {
  const [held, setHeld] = createSignal<PendingPrompt[]>([first]);
  const r = render(() => (
    <TextView
      events={events}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      pendingPrompts={held}
    />
  ));
  const bubble = () =>
    Array.from(r.container.querySelectorAll<HTMLElement>(".tl-row-user")).find((row) =>
      (row.textContent ?? "").includes("also check the phone"),
    );
  return { ...r, bubble, setHeld };
}

describe("a message on its way", () => {
  it("is drawn dimmed with a spinner while the send is in flight", () => {
    const { bubble } = mount(SETTLED, prompt(true));
    const row = bubble()!;
    expect(row.hasAttribute("data-sending")).toBe(true);
    expect(row.querySelector(".tl-sending")?.getAttribute("aria-label")).toBe("Sending");
  });

  it("drops the dimming once the session has it", () => {
    const { bubble, setHeld } = mount(SETTLED, prompt(true));
    setHeld([prompt(false)]);
    const row = bubble()!;
    expect(row.hasAttribute("data-sending")).toBe(false);
    expect(row.querySelector(".tl-sending")).toBeNull();
  });

  it("says Sending on the ghost while a turn runs, then Queued", () => {
    const { bubble, setHeld } = mount(RUNNING, prompt(true));
    const ghost = () => bubble()!;
    expect(ghost().classList.contains("tl-row-ghost")).toBe(true);
    expect(ghost().hasAttribute("data-sending")).toBe(true);
    expect(ghost().querySelector(".tl-ghost-tag")?.textContent).toBe("Sending");
    expect(ghost().querySelector(".tl-sending")).not.toBeNull();
    setHeld([prompt(false)]);
    expect(ghost().hasAttribute("data-sending")).toBe(false);
    expect(ghost().querySelector(".tl-ghost-tag")?.textContent).toBe("Queued");
  });
});
