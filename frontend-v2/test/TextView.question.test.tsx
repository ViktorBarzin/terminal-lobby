/**
 * The docked answer card belongs to ONE question.
 *
 * It walks — question by question, then a review — and that walk is state held
 * in the card. When the session moves from one AskUserQuestion to the next, the
 * card was reused: the walk carried over, so a fresh question could open on the
 * review step of the previous one, showing answers chosen for a question nobody
 * is being asked any more. Sending from there would type those answers into the
 * live dialog.
 */
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

let nextId = 1;
const ask = (toolId: string, questions: unknown[]): Event =>
  ({
    id: nextId++,
    kind: "tool_use",
    tool: "AskUserQuestion",
    toolId,
    session: "qa",
    body: JSON.stringify({ questions }),
  }) as unknown as Event;

const answered = (toolId: string, answers: string[]): Event =>
  ({
    id: nextId++,
    kind: "tool_result",
    toolId,
    session: "qa",
    body: "Your questions have been answered",
    result: { answers },
  }) as unknown as Event;

const question = (header: string) => ({
  question: `Which way for ${header}?`,
  header,
  multiSelect: false,
  options: [{ label: "This one", description: "" }, { label: "That one", description: "" }],
});

function mount(initial: Event[]) {
  const [events, setEvents] = createSignal<Event[]>(initial);
  const r = render(() => (
    <TextView
      events={events()}
      working={false}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={async () => true}
      onPane={async () => ({ pane: "", state: "done" })}
    />
  ));
  const card = () => r.container.querySelector<HTMLElement>(".tl-qcard");
  const step = () => r.container.querySelector<HTMLElement>(".tl-qcard-step")?.textContent;
  const click = (sel: string) => r.container.querySelector<HTMLElement>(sel)?.click();
  const optionByLabel = (label: string) =>
    [...r.container.querySelectorAll<HTMLElement>(".tl-qcard-option")].find((o) =>
      o.textContent?.includes(label),
    );
  return { ...r, setEvents, card, step, click, optionByLabel };
}

describe("the docked answer card", () => {
  it("starts a new walk when the session asks something else", async () => {
    const first = mount([ask("tool-a", [question("First"), question("Second")])]);
    expect(first.step()).toBe("question 1 of 2");

    // Answer the first question and land on the second.
    first.optionByLabel("This one")!.click();
    first.click(".tl-qcard-next");
    expect(first.step()).toBe("question 2 of 2");

    // The session answers that call — from the terminal, say — and asks a
    // different, single question.
    first.setEvents((cur) => [
      ...cur,
      answered("tool-a", ["This one", "That one"]),
      ask("tool-b", [question("Something else")]),
    ]);

    await waitFor(() => expect(first.card()).not.toBeNull());
    expect(first.step()).toBe("awaiting your answer");
    expect(first.container.textContent).toContain("Which way for Something else?");
    // Nothing from the previous walk is carried into the new one.
    expect(first.optionByLabel("This one")!.dataset.chosen).toBeUndefined();
  });

  it("goes away once the question it belongs to is answered", async () => {
    const v = mount([ask("tool-a", [question("First")])]);
    expect(v.card()).not.toBeNull();
    v.setEvents((cur) => [...cur, answered("tool-a", ["This one"])]);
    await waitFor(() => expect(v.card()).toBeNull());
  });
});

/**
 * The pane fallback, for the window where Claude Code has not written the
 * AskUserQuestion record yet (measured: 2 of 5 consecutive calls waited for the
 * ANSWER to be written, 112 s in one case). Without it the reader watches
 * "Working…" while the terminal sits on a dialog.
 */
describe("a question the transcript has not caught up with", () => {
  const asking = (body: unknown): Event =>
    ({
      id: nextId++,
      kind: "meta",
      meta: "asking",
      session: "qa",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as Event;

  const paneDialog = {
    questions: [
      {
        question: "Which way for Pane?",
        header: "Pane",
        multiSelect: false,
        options: [{ label: "This one", description: "" }, { label: "That one", description: "" }],
      },
    ],
    count: 1,
  };

  it("docks the card from the pane", async () => {
    const v = mount([ask("tool-a", [question("Answered")]), answered("tool-a", ["This one"])]);
    expect(v.card()).toBeNull();

    v.setEvents((cur) => [...cur, asking(paneDialog)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.container.textContent).toContain("Which way for Pane?");
    expect(v.step()).toBe("awaiting your answer");
  });

  it("lets go when the pane stops showing it", async () => {
    const v = mount([asking(paneDialog)]);
    expect(v.card()).not.toBeNull();
    v.setEvents((cur) => [...cur, asking("")]);
    await waitFor(() => expect(v.card()).toBeNull());
  });

  it("prefers the transcript, which carries what the pane cannot show", async () => {
    const v = mount([asking(paneDialog), ask("tool-b", [question("Recorded")])]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.container.textContent).toContain("Which way for Recorded?");
    expect(v.container.textContent).not.toContain("Which way for Pane?");
  });

  it("keeps the walk when the transcript catches up with the same question", async () => {
    const same = {
      questions: [
        {
          question: "Which way for Handover?",
          header: "Handover",
          multiSelect: false,
          options: [{ label: "This one", description: "" }, { label: "That one", description: "" }],
        },
      ],
      count: 1,
    };
    const v = mount([asking(same)]);
    v.optionByLabel("This one")!.click();
    expect(v.optionByLabel("This one")!.dataset.chosen).toBe("true");

    // The record lands. Same question, so what was chosen must survive it — a
    // single question has no review step to be in, and the choice is the state
    // a handover would actually destroy.
    v.setEvents((cur) => [...cur, ask("tool-c", [{ ...same.questions[0] }])]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.optionByLabel("This one")!.dataset.chosen).toBe("true");
  });

  it("reports a multi-question call rather than half-answering it", async () => {
    const v = mount([
      asking({
        questions: [
          {
            question: "Pick fruits",
            header: "",
            multiSelect: true,
            options: [{ label: "Apple", description: "" }],
          },
        ],
        headers: ["Fruit", "Drink"],
        count: 2,
        partial: true,
      }),
    ]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.container.textContent).toContain("Fruit");
    expect(v.container.textContent).toContain("Drink");
    // No walk, no Send: the pane shows one question of two, and answering from
    // half a call is how a wrong answer gets submitted.
    expect(v.container.querySelector(".tl-qcard-send")).toBeNull();
    expect(v.container.querySelector(".tl-qcard-next")).toBeNull();
  });
});
