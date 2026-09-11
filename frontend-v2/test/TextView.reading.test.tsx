/**
 * Which reading the card draws, in the three states the happy path skips.
 *
 * TextView.question.test.tsx covers the wiring with the transcript record in
 * hand and a readable reply to every tap. These are the states underneath
 * that: the record has not been written yet, the reply could not read the
 * screen, and the reply carries a dialog the wire shapes differently from the
 * type that describes it. All three end the same way when they go wrong — the
 * reader is left on a card that cannot answer and reaches for the Terminal,
 * which is the outcome this whole change exists to delete
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
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
 * The same question as the PANE draws it: no header, because a multi-question
 * dialog draws none and which tab is current is drawn in colour, which
 * `capture-pane -p` does not carry.
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
  return { ...r, setEvents, notify, card, text, option };
}

describe("a multi-question call the transcript has not caught up with", () => {
  /**
   * The server, as answerdrive.go actually behaves.
   *
   * `answerChoice` refuses a request naming no question before it reads
   * anything else (answerdrive.go:253), because a header is what it checks the
   * pane against. A header that is merely one of the call's chips is NOT a
   * refusal: with no transcript record the driver cannot place the pane
   * either, so `drawnHeader` returns drawnUnsure and the option check against
   * the drawn question stands in for the placement (answerplan.go).
   */
  const driver = (next: DialogView) =>
    vi.fn(async (req: AnswerRequest): Promise<AnswerResponse> => {
      if ((req.header ?? "").trim() === "") {
        return {
          applied: false,
          reason: "not-drawn",
          dialog: paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0),
        };
      }
      return { applied: true, dialog: next };
    });

  it("addresses the call by a chip when no record says which question is drawn", async () => {
    // The measured window this covers: 2026-08-28, five consecutive calls, two
    // records not written until after the question was answered and one of
    // those 112 s later. Through it the tab bar is the only thing that names
    // the call's questions, and the pane draws no per-question header — so
    // without an address every tap comes back not-drawn and the card cannot
    // answer at all.
    const onAnswer = driver(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1));
    const v = mount([asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))], onAnswer);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ header: "Fruit", choice: "Apple" });
    // And the answer landed: the reply is the next question, not the same one
    // back again.
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));
  });

  it("does not claim the pane is on the chip it addressed", async () => {
    // The address names the CALL, not a position. Marking a chip current on
    // the strength of it would be the tab bar used as an index, which is the
    // mistake this design was written to remove.
    const v = mount([asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.container.querySelector("[data-current]")).toBeNull();
  });
});

describe("a reply that could not read the screen", () => {
  const halfDrawn = ["│ Pick a d", "│ 1. Te"].join("\n");

  it("gives way to the next watcher reading instead of standing for the call", async () => {
    // answerdrive polls for 600 ms (answerVerify) and then answers with
    // whatever it has, so a capture taken mid-repaint comes back as a pane and
    // no dialog. That is worth showing while it is the newest thing there is.
    // What it must not do is outlive the next reading: the watcher ticks every
    // 2 s (session-events registry PaneWatchInterval), and a reply is stored
    // once and never cleared, so a card that preferred it for the life of the
    // call would sit on a half-drawn capture with a perfectly readable dialog
    // on screen.
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({ applied: true, pane: halfDrawn }),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-code")).toContain("Pick a d"));

    v.setEvents((cur) => [...cur, asking(paneAt(drawn("Pick a drink", "Tea", "Coffee"), 1))]);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a drink"));
    expect(v.container.querySelector(".tl-code")).toBeNull();
  });

  it("keeps showing the capture while the watcher says nothing new", async () => {
    // The other half of the rule. A reading the watcher has already reported
    // is not new, so it does not displace a capture taken milliseconds ago —
    // preferring the older of the two is how a card ends up drawing a question
    // that has already been answered.
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({ applied: true, pane: halfDrawn }),
    );
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-code")).toContain("Pick a d"));

    v.setEvents((cur) => [...cur, asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))]);
    await Promise.resolve();
    expect(v.text(".tl-code")).toContain("Pick a d");
  });
});

describe("the review screen as the wire actually sends it", () => {
  /**
   * `sessionio.DialogQuestion.Options` is tagged `json:"options"` with no
   * omitempty and `reviewScreen` builds its pseudo-question with none, so
   * `"options": null` is on the wire today while `DialogQuestionView.options`
   * is typed as an array. The ordinary review screen escapes because `review`
   * is true and every read of the options sits behind it; a reply that carries
   * the same dialog WITHOUT that flag does not, and the card dereferences the
   * null while rendering.
   */
  const nullOptions = (): AnswerResponse =>
    JSON.parse(
      JSON.stringify({
        applied: true,
        dialog: {
          questions: [{ question: "Ready to submit your answers?", options: null }],
          headers: ["Fruit", "Drink"],
          count: 2,
          answered: 2,
          partial: true,
        },
      }),
    ) as AnswerResponse;

  it("renders a question with no option list at all", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest): Promise<AnswerResponse> => nullOptions());
    const v = mount(
      [ask("tool-a", twoQuestions), asking(paneAt(drawn("Pick a fruit", "Apple", "Pear"), 0))],
      onAnswer,
    );
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a fruit"));

    v.option("Apple")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Ready to submit your answers?"));
    // Nothing to choose is the CLI's Submit screen, whatever the reply says
    // about it: ParseDialog never returns a question with an empty option
    // list, so the shape is the screen.
    expect(v.text(".tl-qcard-step")).toBe("ready to submit");
    const submit = () => v.container.querySelector<HTMLButtonElement>(".tl-qcard-send");
    expect(submit()?.textContent).toBe("Submit");

    // The card clears the mark on the row it was waiting on one microtask
    // after the new screen is drawn, and a disabled button takes no click.
    await waitFor(() => expect(submit()!.disabled).toBe(false));
    submit()!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer.mock.calls[1]![0]).toEqual({ submit: true });
  });
});
