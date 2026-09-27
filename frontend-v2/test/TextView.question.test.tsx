/**
 * The question card answers a HELD call as data (ADR-0034).
 *
 * The lobby's PermissionRequest hook holds the AskUserQuestion and the stream
 * says so with a `held` meta event. The card then works the way T3 Code's
 * question panel does: one question at a time, a single-select pick moves on
 * by itself, a multi-select toggles, and the whole call goes out in one
 * request once every question has an answer. Nothing is read off the pane and
 * nothing is typed into it.
 *
 * Since the T3 pass the card takes the composer's place: the composer is
 * hidden while the card is up but stays mounted, so its draft survives, and
 * nothing the reader cannot see goes out as an answer.
 *
 * What these cover is the WIRING, with the real card mounted: what each tap
 * puts on the wire and what the card shows for each state of the hold.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerRequest, AnswerResponse } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

let nextId = 1;
beforeEach(() => {
  nextId = 1;
});

const question = (header: string, text: string, labels: string[], multiSelect = false) => ({
  question: text,
  header,
  multiSelect,
  options: labels.map((label) => ({ label, description: `about ${label}` })),
});

const colour = question("Colour", "Pick a colour", ["Red", "Blue"]);
const fruits = question("Fruit", "Pick fruits", ["Apple", "Pear", "Plum"], true);

const ask = (toolId: string, questions: unknown[]): Event =>
  ({
    id: nextId++,
    kind: "tool_use",
    tool: "AskUserQuestion",
    toolId,
    session: "qa",
    body: JSON.stringify({ questions }),
  }) as unknown as Event;

const result = (toolId: string): Event =>
  ({ id: nextId++, kind: "tool_result", toolId, session: "qa", body: "answered" }) as unknown as Event;

const held = (questions: unknown[] | null): Event =>
  ({
    id: nextId++,
    kind: "meta",
    meta: "held",
    session: "qa",
    body: questions ? JSON.stringify({ questions }) : "",
  }) as unknown as Event;

const applied: AnswerResponse = { applied: true, done: true };

function mount(
  initial: Event[],
  onAnswer: (req: AnswerRequest) => Promise<AnswerResponse | null> = async () => applied,
  onSend: (text: string) => Promise<boolean> = async () => true,
) {
  const notify = vi.fn();
  const onOpenTerminal = vi.fn();
  const [events, setEvents] = createSignal<Event[]>(initial);
  const r = render(() => (
    <TextView
      events={events()}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={async () => true}
      onPane={async () => ({ pane: "", state: "done" })}
      onAnswer={onAnswer}
      onOpenTerminal={onOpenTerminal}
      notify={notify}
    />
  ));
  const card = () => r.container.querySelector<HTMLElement>(".tl-qcard:not(.tl-plancard)");
  const text = (sel: string) => r.container.querySelector<HTMLElement>(sel)?.textContent ?? null;
  const option = (label: string) =>
    [...r.container.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")].find(
      (o) => o.querySelector(".tl-qcard-label")?.textContent === label,
    );
  const button = (label: string) =>
    [...r.container.querySelectorAll<HTMLButtonElement>(".tl-qcard button")].find(
      (b) => b.textContent === label,
    );
  const sendFromComposer = (words: string) => {
    const ta = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    ta.value = words;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    r.container.querySelector<HTMLButtonElement>(".tl-send")!.click();
  };
  const typeInComposer = (words: string) => {
    const ta = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    ta.value = words;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return {
    ...r,
    setEvents,
    events,
    notify,
    onOpenTerminal,
    card,
    text,
    option,
    button,
    sendFromComposer,
    typeInComposer,
  };
}

describe("a held call", () => {
  it("steps through the questions and sends every answer in one request", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour, fruits])], onAnswer);

    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a colour"));
    expect(v.text(".tl-qcard-title")).toBe("Claude asks");
    expect(v.text(".tl-qcard-tag")).toBe("Colour");
    expect(v.text(".tl-qcard-step")).toBe("1/2");
    expect(v.container.textContent).toContain("about Red");

    // A single-select pick moves on by itself.
    v.option("Blue")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick fruits"));
    expect(v.text(".tl-qcard-step")).toBe("2/2");
    expect(v.container.textContent).toContain("Select one or more options.");

    // A multi-select toggles in place, and Submit waits for a pick.
    expect(v.button("Submit")!.disabled).toBe(true);
    v.option("Plum")!.click();
    v.option("Apple")!.click();
    v.option("Plum")!.click();
    v.option("Pear")!.click();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(v.option("Apple")!.getAttribute("aria-pressed")).toBe("true");
    expect(v.option("Plum")!.getAttribute("aria-pressed")).toBe("false");

    v.button("Submit")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      answers: { "Pick a colour": ["Blue"], "Pick fruits": ["Apple", "Pear"] },
    });
    await waitFor(() => expect(v.container.textContent).toContain("Answer sent."));
  });

  it("goes back to an earlier question and keeps its pick", async () => {
    const v = mount([held([colour, fruits])]);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    v.option("Red")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick fruits"));
    v.button("Previous")!.click();
    expect(v.text(".tl-qcard-question")).toBe("Pick a colour");
    expect(v.option("Red")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("submits a one-question single-select call on the pick itself", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    expect(v.card()!.querySelector(".tl-qcard-step")).toBeNull();
    v.option("Red")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ answers: { "Pick a colour": ["Red"] } });
  });

  it("answers the question on show with what the composer sends", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const onSend = vi.fn(async (_t: string) => true);
    const v = mount([held([colour, fruits])], onAnswer, onSend);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a colour"));
    expect(
      (v.getByLabelText("Message to send to the session") as HTMLTextAreaElement).placeholder,
    ).toBe("Or type your own answer…");

    v.sendFromComposer("green,\nactually");
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick fruits"));
    v.sendFromComposer("mango");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      answers: { "Pick a colour": ["green, actually"], "Pick fruits": ["mango"] },
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes the composer's place, which stays mounted with its draft", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([], onAnswer);
    const composer = () => v.container.querySelector<HTMLElement>(".tl-composer")!;
    const field = () => v.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    expect(composer().hidden).toBe(false);
    v.typeInComposer("half a thought");

    v.setEvents([held([colour, fruits])]);
    await waitFor(() => expect(v.card()).toBeTruthy());
    expect(composer().hidden).toBe(true);
    expect(field().value).toBe("half a thought");
    // The card is the view's bottom slot: nothing but the hidden composer
    // follows it.
    expect(v.card()!.nextElementSibling).toBe(composer());

    // The hidden draft is never the answer: Next waits for a pick, and the
    // pick is what goes out.
    v.option("Blue")!.click();
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick fruits"));
    expect(v.button("Submit")!.disabled).toBe(true);
    v.option("Pear")!.click();
    v.button("Submit")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      answers: { "Pick a colour": ["Blue"], "Pick fruits": ["Pear"] },
    });

    v.setEvents([...v.events(), held(null)]);
    await waitFor(() => expect(v.card()).toBeNull());
    expect(composer().hidden).toBe(false);
    expect(field().value).toBe("half a thought");
  });

  it("declines without the hidden composer's words on Chat about this", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.button("Chat about this")).toBeTruthy());
    v.typeInComposer("a draft for later");
    v.button("Chat about this")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ chat: "" });
    expect(
      (v.getByLabelText("Message to send to the session") as HTMLTextAreaElement).value,
    ).toBe("a draft for later");
  });

  it("answers a one-question single-select on the pick, with no Submit to press", async () => {
    const v = mount([held([colour])]);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    expect(v.button("Submit")).toBeUndefined();
  });

  it("offers the Terminal from its head", async () => {
    const v = mount([held([colour])]);
    await waitFor(() => expect(v.card()).toBeTruthy());
    const link = v.card()!.querySelector<HTMLButtonElement>(".tl-qcard-head .tl-qcard-link");
    expect(link?.textContent).toBe("Open in Terminal");
    link!.click();
    expect(v.onOpenTerminal).toHaveBeenCalled();
  });

  it("declines with no words when the composer is empty", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.button("Chat about this")).toBeTruthy());
    v.button("Chat about this")!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ chat: "" });
  });

  it("shows the preview of the option in focus", async () => {
    const withPreview = {
      ...colour,
      options: [
        { label: "Red", description: "", preview: "RED BOX" },
        { label: "Blue", description: "", preview: "BLUE BOX" },
      ],
    };
    const v = mount([held([withPreview, fruits])]);
    await waitFor(() => expect(v.text(".tl-qcard-preview")).toBe("RED BOX"));
    fireEvent.focus(v.option("Blue")!);
    expect(v.text(".tl-qcard-preview")).toBe("BLUE BOX");
  });

  it("picks with keys 1-9 while the focus is in the Text view", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.option("Blue")).toBeTruthy());
    fireEvent.keyDown(v.card()!, { key: "2" });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({ answers: { "Pick a colour": ["Blue"] } });
  });

  it("leaves a digit typed outside the Text view alone", async () => {
    // The composer hides the moment the card docks, so the rest of a sentence
    // being typed lands on the page. "use 2 of them" must not answer.
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.option("Blue")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "2" });
    // A pick marks its row at once, before the beat that moves on.
    expect(v.option("Blue")!.getAttribute("aria-pressed")).toBe("false");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("takes the focus when it docks and nothing had it, so the keys work at once", async () => {
    const v = mount([held([colour])]);
    await waitFor(() => expect(v.card()).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(v.card()));
  });

  it("collapses to one line and opens again", async () => {
    const v = mount([held([colour])]);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    v.card()!.querySelector<HTMLButtonElement>(".tl-qcard-fold")!.click();
    expect(v.option("Red")).toBeUndefined();
    expect(v.text(".tl-qcard-peek")).toBe("Pick a colour");
    v.card()!.querySelector<HTMLButtonElement>(".tl-qcard-fold")!.click();
    expect(v.option("Red")).toBeTruthy();
  });

  it("goes when the hold ends and the transcript has the answer", async () => {
    const v = mount([held([colour]), ask("t1", [colour])]);
    await waitFor(() => expect(v.card()).toBeTruthy());
    v.setEvents([...v.events(), held(null), result("t1")]);
    await waitFor(() => expect(v.card()).toBeNull());
  });

  it("sends the reader to the Terminal when the server says nothing holds it", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => ({ applied: false, reason: "not-held" }) as AnswerResponse);
    const v = mount([held([colour])], onAnswer);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    v.option("Red")!.click();
    await waitFor(() => expect(v.button("Open Terminal")).toBeTruthy());
    expect(v.notify).toHaveBeenCalled();
    v.button("Open Terminal")!.click();
    expect(v.onOpenTerminal).toHaveBeenCalled();
  });
});

describe("a call no hook is holding", () => {
  it("shows the question, then points at the Terminal once the hold does not come", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied);
    const v = mount([ask("t1", [colour])], onAnswer);
    await waitFor(() => expect(v.text(".tl-qcard-question")).toBe("Pick a colour"));
    expect(v.container.textContent).toContain("Connecting to the question…");
    expect(v.option("Red")!.disabled).toBe(true);

    await waitFor(() => expect(v.button("Open Terminal")).toBeTruthy(), { timeout: 6000 });
    expect(v.container.textContent).toContain("can only be answered in the Terminal");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("becomes answerable when the hold arrives after the record", async () => {
    const v = mount([ask("t1", [colour])]);
    await waitFor(() => expect(v.option("Red")).toBeTruthy());
    v.setEvents([...v.events(), held([colour])]);
    await waitFor(() => expect(v.option("Red")!.disabled).toBe(false));
  });

  it("does not send the composer's words as a prompt while the question waits", async () => {
    const onSend = vi.fn(async (_t: string) => true);
    const v = mount([ask("t1", [colour])], async () => applied, onSend);
    await waitFor(() => expect(v.card()).toBeTruthy());
    v.sendFromComposer("blue");
    await waitFor(() => expect(v.notify).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
  });
});
