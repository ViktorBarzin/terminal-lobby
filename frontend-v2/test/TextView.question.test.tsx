/**
 * The docked card answers ONE choice at a time, against a reading of the pane.
 *
 * Nothing here plans a walk. Every reply is a reading taken after the request,
 * the card draws it, and a REFUSAL is one of those readings rather than an
 * error. That is the whole of the change: over 10 days of field data
 * four-question answers from this view failed 4 times in 5, and all six
 * recorded failures were the same shape — the browser predicted what the next
 * screen would say and did not find it
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
 *
 * What these cover is the WIRING, with the real card mounted: which request
 * each tap puts on the wire, which reading the card is handed back, and the
 * one case that reaches the toast stack.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerRequest, AnswerResponse, DialogView } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

let nextId = 1;
beforeEach(() => {
  nextId = 1;
});

/** One question as the TOOL was called: a header, and descriptions in full. */
const called = (header: string, text: string, ...labels: string[]) => ({
  question: text,
  header,
  multiSelect: false,
  options: labels.map((label) => ({ label, description: `about ${label}` })),
});

/**
 * The same question as the PANE draws it.
 *
 * No header — a multi-question dialog draws none, and which tab is current is
 * drawn in colour, which `capture-pane -p` does not carry — and no
 * descriptions, which is what the width usually costs.
 */
const drawn = (text: string, ...labels: string[]) => ({
  question: text,
  header: "",
  multiSelect: false,
  options: labels.map((label) => ({ label, description: "" })),
});

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

/** What the pane watcher reports, as a `meta` event on the stream. */
const asking = (body: unknown): Event =>
  ({
    id: nextId++,
    kind: "meta",
    meta: "asking",
    session: "qa",
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Event;

const twoQuestions = [
  called("Fruit", "Pick a fruit", "Apple", "Pear"),
  called("Drink", "Pick a drink", "Tea", "Coffee"),
];

/** A reading of a two-question call sitting on `q`. */
const paneAt = (q: ReturnType<typeof drawn>, done: number): DialogView => ({
  questions: [q],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: done,
  partial: true,
});

const reply = (view: DialogView, over: Partial<AnswerResponse> = {}): AnswerResponse => ({
  applied: true,
  dialog: view,
  ...over,
});

function mount(
  initial: Event[],
  onAnswer: (req: AnswerRequest) => Promise<AnswerResponse | null> = async () => null,
) {
  const notify = vi.fn();
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
      onAnswer={onAnswer}
      notify={notify}
    />
  ));
  const card = () => r.container.querySelector<HTMLElement>(".tl-qcard");
  const text = (sel: string) => r.container.querySelector<HTMLElement>(sel)?.textContent ?? null;
  const option = (label: string) =>
    [...r.container.querySelectorAll<HTMLElement>(".tl-qcard-option")].find(
      (o) => o.querySelector(".tl-qcard-label")?.textContent === label,
    );
  const chip = (name: string) =>
    [...r.container.querySelectorAll<HTMLElement>(".tl-qcard-tab")].find(
      (c) => c.textContent === name,
    );
  return { ...r, setEvents, notify, card, text, option, chip };
}

describe("one choice, one request", () => {
  it("addresses the question by the header the transcript gave it", async () => {
    // The pane draws no per-question header on a multi-question dialog, and
    // the header is what the server checks a request against — it refuses one
    // that names no question — so the call's own content is merged into the
    // drawn question before the card can address it at all.
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );

    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
    expect(v.text(".tl-qcard-step")).toBe("question 1 of 2");
    // And the description the pane had no width for is there.
    expect(v.container.textContent).toContain("about Apple");

    v.option("Apple")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ header: "Fruit", choice: "Apple" });

    // The reply is the next screen, and the card draws it.
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));
    expect(v.text(".tl-qcard-step")).toBe("question 2 of 2");
  });

  it("puts the whole desired set on the wire when a multi-select already holds a pick", async () => {
    // THE WIRE, end to end through the watcher's own reading. The `asking`
    // meta event is a marshalled sessionio.Dialog, so the ticks come off the
    // pane, through canonicalize, into the card — and the card's second tap
    // asks for both fruits rather than for the one that was tapped.
    //
    // With one label this was a replacement: the server toggles the rows that
    // differ from the set it is given, so "Pear" against a question holding
    // Apple plans a Space on Apple too. Measured 2026-09-11.
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const fruit = {
      question: "Pick a fruit",
      header: "",
      multiSelect: true,
      options: [
        { label: "Apple", description: "", checked: true },
        { label: "Pear", description: "" },
      ],
    };
    const v = mount([ask("tool-a", twoQuestions), asking(paneAt(fruit, 1))], onAnswer);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
    // What is held is on screen before anything is tapped, because it is what
    // the next tap will send.
    expect(v.option("Apple")!.dataset.chosen).toBe("true");

    v.option("Pear")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ header: "Fruit", choices: ["Apple", "Pear"] });
  });

  it("walks back to an answered question from its chip", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 1)),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));

    v.chip("Fruit")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ back: "Fruit" });
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
  });

  it("opens the free-text field and sends what was typed with the choice", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    // The CLI appends this row to every AskUserQuestion, the parser drops it,
    // and the card puts it back — so it is offered even though the reading
    // carries no such option.
    v.option("Type something")!.click();
    const field = v.container.querySelector<HTMLInputElement>(".tl-qcard-other")!;
    field.value = "a plum, actually";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    v.container.querySelector<HTMLElement>(".tl-qcard-send")!.click();

    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      header: "Fruit",
      choice: "Type something",
      text: "a plum, actually",
    });
  });

  it("submits from the review screen, and the card goes when the dialog does", async () => {
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({ applied: true, done: true }),
    );
    const v = mount(
      [
        ask("tool-a", twoQuestions),
        // The CLI's own Submit screen: every box filled, nothing to choose.
        asking({
          questions: [
            {
              question: "Ready to submit your answers?",
              header: "",
              multiSelect: false,
              options: [],
            },
          ],
          headers: ["Fruit", "Drink"],
          count: 2,
          answered: 2,
          partial: true,
        }),
      ],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-step")).toBe("ready to submit"));

    v.container.querySelector<HTMLElement>(".tl-qcard-send")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ submit: true });
    // `done` carries no reading, and there is nothing left to draw.
    await waitFor(() => expect(v.card()).toBeNull());
  });

  it("shows which questions the terminal has already taken an answer for", async () => {
    const v = mount([
      ask("tool-a", twoQuestions),
      asking(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    ]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    const chips = [...v.container.querySelectorAll(".tl-qcard-tab")];
    expect(chips.map((c) => [c.textContent, c.getAttribute("data-done")])).toEqual([
      ["Fruit", "true"],
      ["Drink", null],
    ]);
  });
});

describe("a refusal is a reading, not an error", () => {
  it("re-renders against what IS on screen, and the next tap goes to it", async () => {
    // The reader tapped a question the pane has already moved past. The reply
    // carries the screen, so the card corrects itself and stays usable; the
    // card this replaces latched Send disabled and sent them to the Terminal.
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1), {
        applied: false,
        reason: "not-drawn",
      }),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));
    expect(v.notify).not.toHaveBeenCalled();

    // The card marks the row it is waiting on and clears that mark when the
    // reply resolves, one microtask after the new screen is drawn.
    await waitFor(() => expect((v.option("Tea") as HTMLButtonElement).disabled).toBe(false));
    v.option("Tea")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer.mock.calls[1]![0]).toEqual({ header: "Drink", choice: "Tea" });
  });

  it("shows a screen the parser could not read, with its rows tappable", async () => {
    const pane = [
      "│ Something we have never drawn before",
      "│ 1. Carry on",
      "│ 2. Stop",
      "│ Enter to select · Esc to cancel",
    ].join("\n");
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({ applied: true, pane }),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.container.querySelector(".tl-code")).not.toBeNull());
    expect(v.text(".tl-code")).toContain("Something we have never drawn before");

    v.option("Carry on")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer.mock.calls[1]![0]).toEqual({ keys: ["1"] });
  });
});

describe("only a call that failed reaches the toast stack", () => {
  it("notifies on a null reply and keeps the reading it had", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => null);
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.notify).toHaveBeenCalledTimes(1));
    expect(v.notify.mock.calls[0]![1]).toBe("error");
    expect(v.text(".tl-qcard-question")).toBe("Pick a fruit");
    // Nothing latched: the same tap is available again.
    await waitFor(() => expect((v.option("Apple") as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("where the card gets its position", () => {
  it("stands the call's own questions in when the pane has said nothing", async () => {
    // Not a two-second gap. The watcher's reading is withdrawn by the record
    // itself and only reappears when the READING changes, so this state can
    // last as long as the reader takes to answer — and with nothing to draw
    // there would be no card, and no way to ask for a reading either.
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const v = mount([ask("tool-a", twoQuestions)], onAnswer);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
    expect(v.text(".tl-qcard-step")).toBe("question 1 of 2");

    // A starting point rather than a prediction: the request still names the
    // question, and the server is what decides whether that is the one drawn.
    v.option("Apple")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ header: "Fruit", choice: "Apple" });
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));
  });

  it("prefers the reply over a watcher reading taken before it", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));

    // A watcher tick that began before the keys went in lands afterwards. It
    // is up to 2s old and the reply is milliseconds old, so the older of the
    // two must not win — that is how a card ends up showing a question that
    // has already been answered.
    v.setEvents((cur) => [...cur, asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))]);
    await Promise.resolve();
    expect(v.text(".tl-qcard-question")).toBe("Pick a drink");
  });

  it("drops the reading when the session asks something else", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) =>
      reply(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1)),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));
    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));

    // A different call, with its own reading. The previous call's goes with
    // the card that asked for it rather than being drawn over a question
    // nobody is being asked any more.
    const colour = called("Colour", "Pick a colour", "Red", "Blue");
    v.setEvents((cur) => [
      ...cur,
      ask("tool-b", [colour]),
      asking({ questions: [colour], headers: ["Colour"], count: 1, answered: 0 }),
    ]);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a colour"));
  });
});

/**
 * The pane fallback, for the window where Claude Code has not written the
 * AskUserQuestion record yet. Measured 2026-08-28 over five consecutive calls
 * in one session: two records landed within 3-8 s of the dialog appearing and
 * two were not written until the question was ANSWERED, 112 s later in one
 * case. Without this the reader watches "Working…" while the terminal sits on
 * a dialog.
 */
describe("a question the transcript has not caught up with", () => {
  const onePaneQuestion = {
    questions: [
      {
        question: "Which way for Pane?",
        header: "Pane",
        multiSelect: false,
        options: [
          { label: "This one", description: "" },
          { label: "That one", description: "" },
        ],
      },
    ],
    headers: ["Pane"],
    count: 1,
  };

  it("docks the card from the pane alone", async () => {
    const v = mount([
      ask("tool-a", [called("Answered", "Which way for Answered?", "This one")]),
      answered("tool-a", ["This one"]),
    ]);
    expect(v.card()).toBeNull();

    v.setEvents((cur) => [...cur, asking(onePaneQuestion)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.text(".tl-qcard-question")).toBe("Which way for Pane?");
    expect(v.text(".tl-qcard-step")).toBe("awaiting your answer");
  });

  it("lets go when the pane stops showing it", async () => {
    const v = mount([asking(onePaneQuestion)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    v.setEvents((cur) => [...cur, asking("")]);
    await waitFor(() => expect(v.card()).toBeNull());
  });

  it("goes away once the question it belongs to is answered", async () => {
    const v = mount([
      ask("tool-a", [called("First", "Which way for First?", "This one")]),
      asking({
        questions: [drawn("Which way for First?", "This one")],
        headers: ["First"],
        count: 1,
      }),
    ]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    v.setEvents((cur) => [...cur, answered("tool-a", ["This one"])]);
    await waitFor(() => expect(v.card()).toBeNull());
  });

  it("keeps the reading when the transcript catches up with the same question", async () => {
    // The handover. The same question arrives first from the pane and then
    // from the transcript, and the card is keyed on content so that moment
    // does not throw away what the reader has already been told.
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({
        applied: false,
        reason: "unknown-option",
        dialog: {
          questions: [drawn("Which way for Handover?", "This one", "That one")],
          headers: ["Handover"],
          count: 1,
          answered: 0,
        },
      }),
    );
    const pane = {
      questions: [drawn("Which way for Handover?", "This one", "That one")],
      headers: ["Handover"],
      count: 1,
    };
    const v = mount([asking(pane)], onAnswer);
    await waitFor(() => expect(v.card()).not.toBeNull());
    v.option("This one")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));

    v.setEvents((cur) => [
      ...cur,
      ask("tool-c", [called("Handover", "Which way for Handover?", "This one", "That one")]),
    ]);
    await waitFor(() => expect(v.container.textContent).toContain("about This one"));
    // The reading survived: same call, same card, and the transcript only
    // filled in what the pane could not show.
    expect(v.text(".tl-qcard-question")).toBe("Which way for Handover?");
  });
});
