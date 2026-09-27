/**
 * The plan card, docked in the Text view where the question card docks.
 *
 * What these cover is the WIRING, with the real card, timeline and composer
 * mounted: when the card docks and what plan it shows, which request an
 * option tap puts on the wire, what the view shows between an applied answer
 * and the transcript's record of it (the transient, up to 20 s), a refusal
 * that redraws the card from the reply, feedback sent through the card's own
 * "Tell Claude what to change" field (the T3 pass, prototype 6-plan), and the
 * words on the live group
 * (docs/plans/2026-09-24-text-composer-redesign.md, "The plan-approval flow",
 * "When the card docks, and what it shows", "After clear context").
 *
 * The readings and result bodies are the Go fixtures' and the real
 * transcripts' (timeline.plandock.test.ts, timeline.plan.test.ts).
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerRequest, AnswerResponse, DialogView } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

afterEach(() => {
  vi.useRealTimers();
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "qa",
  ...e,
});

const PLAN_FIRST = {
  kind: "plan" as const,
  options: [
    { number: 1, label: "Yes, clear context (6% used) and use auto mode" },
    { number: 2, label: "Yes, and use auto mode" },
    { number: 3, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 4,
  planPath: "~/.claude/plans/plan-how-to-create-calm-starfish.md",
};
const PLAN_NO_AUTO = {
  kind: "plan" as const,
  options: [
    { number: 1, label: "Yes, auto-accept edits" },
    { number: 2, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 3,
  planPath: "~/.claude/plans/plan-do-not-execute-delightful-whisper.md",
};

const INPUT_PLAN = "# Create hello.txt\n\n1. Write `hello.txt` with `hi`.\n2. Verify it.\n";

const APPROVED_BODY =
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n" +
  `## Approved Plan:\n${INPUT_PLAN}`;
const REJECTED_BODY =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const prompt = (id: number): Event => ev({ id, kind: "user", body: "plan it", at: id * 1000 });
const planUse = (id: number, toolId: string): Event =>
  ev({
    id,
    kind: "tool_use",
    tool: "ExitPlanMode",
    toolId,
    body: JSON.stringify({ plan: INPUT_PLAN }),
    at: id * 1000,
  });
const asking = (id: number, body: unknown): Event =>
  ev({
    id,
    kind: "meta",
    meta: "asking",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const approved = (id: number, toolId: string): Event =>
  ev({
    id,
    kind: "tool_result",
    toolId,
    body: APPROVED_BODY,
    result: { plan: INPUT_PLAN },
    at: id * 1000,
  });
const rejected = (id: number, toolId: string): Event =>
  ev({
    id,
    kind: "tool_result",
    toolId,
    body: REJECTED_BODY,
    isError: true,
    at: id * 1000,
  });

const applied = (): AnswerResponse => ({ applied: true, done: true });

function mount(
  initial: Event[],
  onAnswer: (req: AnswerRequest) => Promise<AnswerResponse | null> = async () => applied(),
  onSend: (text: string) => Promise<boolean> = async () => true,
  onKeys: (keys: string[]) => Promise<boolean> = async () => true,
  extra: Partial<ComponentProps<typeof TextView>> = {},
) {
  const [events, setEvents] = createSignal<Event[]>(initial);
  const r = render(() => (
    <TextView
      events={events()}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
      onKeys={onKeys}
      onPane={async () => ({ pane: "", state: "done" })}
      onAnswer={onAnswer}
      notify={() => {}}
      {...extra}
    />
  ));
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => r.container.querySelector<T>(sel);
  const card = () => q(".tl-plancard");
  const option = (n: number) =>
    [...r.container.querySelectorAll<HTMLButtonElement>(".tl-plancard .tl-qcard-option")].find(
      (o) => o.querySelector(".tl-qcard-key")?.textContent === String(n),
    );
  /** The approve rows' labels, as the pane draws them; the own row is not one. */
  const labels = () =>
    [
      ...r.container.querySelectorAll(
        ".tl-plancard .tl-qcard-option:not(.tl-qcard-own) .tl-qcard-label",
      ),
    ].map((l) => l.textContent);
  const row = () => q(".tl-row-plan");
  const header = () => row()?.querySelector(".tl-plan-outcome")?.textContent ?? null;
  /** What the live group at the end of the conversation says. */
  const status = () =>
    q(".tl-timeline .tl-group-box[data-live] .tl-group-sum")?.textContent ?? null;
  /** The composer's field and its round button, hidden behind the card. */
  const field = () => q<HTMLTextAreaElement>(".tl-composer textarea")!;
  const send = () => q<HTMLButtonElement>(".tl-composer .tl-send")!;
  /** The card's "Tell Claude what to change" row, and the field it opens. */
  const ownRow = () => q<HTMLButtonElement>(".tl-plancard .tl-qcard-own");
  const ownField = () => q<HTMLTextAreaElement>(".tl-plancard .tl-qcard-owninput");
  const ownSend = () => q<HTMLButtonElement>(".tl-plancard .tl-qcard-ownfield .tl-send")!;
  /** Open the card's own row and type these words into it. */
  const typeOwn = async (words: string) => {
    fireEvent.click(ownRow()!);
    await waitFor(() => expect(ownField()).not.toBeNull());
    fireEvent.input(ownField()!, { target: { value: words } });
  };
  const approveWithFeedback = () =>
    [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((x) =>
      (x.textContent ?? "").startsWith("Approve with this feedback"),
    );
  /** The model button, which holds the mode and the model alike. */
  const dial = () => q<HTMLButtonElement>(".tl-model-btn");
  return {
    dial,
    ...r,
    setEvents,
    events,
    card,
    option,
    labels,
    row,
    header,
    status,
    field,
    send,
    ownRow,
    ownField,
    ownSend,
    typeOwn,
    approveWithFeedback,
  };
}

/** Let the answer's promise settle while the clock is faked. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("when the plan card docks", () => {
  it("docks with the transcript's plan and the pane's choices", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.card()!.textContent).toContain("Create hello.txt");
    expect(v.labels()).toEqual(PLAN_FIRST.options.map((o) => o.label));
    // The last row is the card's own field for the dialog's feedback row.
    expect(v.ownRow()?.textContent).toBe("Tell Claude what to change");
    // The plan is on screen once: the row shrinks to its stub.
    expect(v.row()!.getAttribute("data-docked")).toBe("true");
    expect(v.row()!.textContent).toContain("shown below");
  });

  it("reads 'Loading the plan…' while the transcript has no call yet", async () => {
    const v = mount([prompt(1), asking(2, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.card()!.textContent).toContain("Loading the plan…");
    expect(v.labels()).toHaveLength(3);
  });

  it("does not dock for a question reading, or for a dialog already answered", () => {
    const question = mount([
      prompt(1),
      asking(2, {
        questions: [
          {
            header: "Colour",
            question: "Which colour?",
            options: [{ label: "Red" }],
          },
        ],
      }),
    ]);
    expect(question.card()).toBeNull();
    const answered = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST), approved(4, "p1")]);
    expect(answered.card()).toBeNull();
  });

  it("withholds Shift+Tab while the card is docked", async () => {
    // Shift+Tab on the feedback row approves the plan, so the field must not
    // send it while the card is up.
    const keys = vi.fn(async (_keys: string[]) => true);
    const v = mount([prompt(1), asking(2, PLAN_FIRST)], undefined, undefined, keys);
    await waitFor(() => expect(v.card()).not.toBeNull());
    fireEvent.keyDown(v.field(), { key: "Tab", shiftKey: true });
    expect(keys).not.toHaveBeenCalledWith(["BTab"]);
  });
});

describe("an option tap", () => {
  it("puts the option's number and label on the wire, and shows it in flight", async () => {
    let finish: (r: AnswerResponse) => void = () => {};
    const onAnswer = vi.fn(
      (_req: AnswerRequest) =>
        new Promise<AnswerResponse | null>((res) => {
          finish = res;
        }),
    );
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer);
    await waitFor(() => expect(v.option(2)).toBeDefined());
    v.option(2)!.click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      plan: { option: 2, label: "Yes, and use auto mode" },
    });
    await waitFor(() => expect(v.option(2)!.textContent).toContain("Approving…"));
    expect(v.option(1)!.disabled).toBe(true);

    finish(applied());
    // Applied: the card undocks at once, and the row says what is happening.
    await waitFor(() => expect(v.card()).toBeNull());
    expect(v.header()).toBe("Approving…");

    // The transcript's record takes over when it lands.
    v.setEvents([...v.events(), approved(4, "p1")]);
    await waitFor(() => expect(v.header()).toBe("Plan approved"));
  });

  it("says it is clearing context, on the row and the live group, for an option that clears", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await waitFor(() => expect(v.option(1)).toBeDefined());
    v.option(1)!.click();
    await waitFor(() => expect(v.card()).toBeNull());
    expect(v.header()).toBe("Clearing context…");
    expect(v.status()).toBe("Clearing the context and starting the plan…");

    // The old transcript records the clear as a rejection; this client knows
    // better, so the row keeps saying what it did.
    v.setEvents([...v.events(), rejected(4, "p1")]);
    await waitFor(() => expect(v.row()!.getAttribute("data-outcome")).toBe("transient"));
    expect(v.header()).toBe("Clearing context…");

    // The stream switches to the new conversation: the old events go, and
    // with them the transient.
    v.setEvents([ev({ id: 10, kind: "text", body: "Starting on it.", at: 10_000 })]);
    await waitFor(() => expect(v.status()).not.toBe("Clearing the context and starting the plan…"));
  });
});

describe("the transient after an applied answer", () => {
  it("lasts 20 s when the transcript records nothing", async () => {
    vi.useFakeTimers();
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await settle();
    v.option(1)!.click();
    await settle();
    expect(v.card()).toBeNull();
    expect(v.header()).toBe("Clearing context…");
    // The pane takes the dialog down and the old transcript records the clear.
    v.setEvents([...v.events(), asking(4, ""), rejected(5, "p1")]);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(v.header()).toBe("Clearing context…");
    expect(v.status()).toBe("Clearing the context and starting the plan…");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(v.header()).toBe("Plan rejected");
    expect(v.status()).not.toBe("Clearing the context and starting the plan…");
  });

  it("does not re-dock the reading it answered while that answer settles, and does after 20 s", async () => {
    vi.useFakeTimers();
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await settle();
    v.option(3)!.click();
    await settle();
    expect(v.card()).toBeNull();
    expect(v.header()).toBe("Approving…");
    // The watcher has not withdrawn its reading yet, and nothing is recorded.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.card()).toBeNull();
    // Twenty seconds and still no record: the answer did not land, and the
    // dialog the pane still draws is answerable again.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(v.card()).not.toBeNull();
    expect(v.row()!.getAttribute("data-outcome")).toBe("pending");
  });
});

describe("a refused option", () => {
  it("redraws the card from the reply's reading on unknown-option", async () => {
    const onAnswer = vi.fn(
      async (_req: AnswerRequest): Promise<AnswerResponse> => ({
        applied: false,
        reason: "unknown-option",
        dialog: PLAN_NO_AUTO as unknown as DialogView,
      }),
    );
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer);
    await waitFor(() => expect(v.option(2)).toBeDefined());
    v.option(2)!.click();
    await waitFor(() => expect(v.labels()).toEqual(PLAN_NO_AUTO.options.map((o) => o.label)));
    expect(v.card()!.textContent).toContain(
      "The Terminal now shows different choices. Pick again.",
    );
    // Still docked, nothing transient, and the next tap names the new row.
    expect(v.row()!.getAttribute("data-outcome")).toBe("pending");
    v.option(1)!.click();
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer.mock.calls[1]![0]).toEqual({
      plan: { option: 1, label: "Yes, auto-accept edits" },
    });
  });

  it("says the plan has gone on not-drawn, and keeps the card", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], async () => ({
      applied: false,
      reason: "not-drawn",
    }));
    await waitFor(() => expect(v.option(2)).toBeDefined());
    v.option(2)!.click();
    await waitFor(() =>
      expect(v.card()!.textContent).toContain("The plan is no longer waiting in the Terminal."),
    );
    expect(v.header()).toBeNull();
  });
});

describe("feedback through the card's own field", () => {
  it("sends the words as feedback that keeps Claude planning", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const onSend = vi.fn(async () => true);
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer, onSend);
    await waitFor(() => expect(v.card()).not.toBeNull());
    await v.typeOwn("use the\nexisting helper");
    fireEvent.click(v.ownSend());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      plan: { feedback: "use the existing helper", approve: false },
    });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(v.card()).toBeNull());
    expect(v.header()).toBe("Sending back…");
  });

  it("keeps the words in the card when the feedback is refused", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], async () => ({
      applied: false,
      reason: "unverified",
    }));
    await waitFor(() => expect(v.card()).not.toBeNull());
    await v.typeOwn("smaller steps");
    fireEvent.click(v.ownSend());
    await waitFor(() =>
      expect(v.card()!.textContent).toContain(
        "Your answer may not have landed. Check the Terminal.",
      ),
    );
    expect(v.ownField()!.value).toBe("smaller steps");
  });

  it("approves with the card's words, through option 1, and says it clears the context", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer);
    await waitFor(() => expect(v.card()).not.toBeNull());
    await v.typeOwn("and keep the tests");
    const approve = v.approveWithFeedback();
    expect(approve?.textContent).toBe("Approve with this feedback and clear context");
    fireEvent.click(approve!);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer.mock.calls[0]![0]).toEqual({
      plan: { feedback: "and keep the tests", approve: true },
    });
    await waitFor(() => expect(v.card()).toBeNull());
    expect(v.header()).toBe("Clearing context…");
    expect(v.status()).toBe("Clearing the context and starting the plan…");
  });

  it("approves plainly when option 1 keeps the context", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_NO_AUTO)], onAnswer);
    await waitFor(() => expect(v.card()).not.toBeNull());
    await v.typeOwn("and keep the tests");
    fireEvent.click(v.approveWithFeedback()!);
    await waitFor(() => expect(v.card()).toBeNull());
    expect(v.header()).toBe("Approving…");
  });

  it("offers no Approve with this feedback for words the hidden composer holds", async () => {
    // The card takes the composer's place, so a draft in the field is out of
    // sight and must not ride along with an approval.
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer);
    await waitFor(() => expect(v.card()).not.toBeNull());
    fireEvent.input(v.field(), { target: { value: "and add tests" } });
    await Promise.resolve();
    expect(v.approveWithFeedback()).toBeUndefined();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("refuses from a watching device and keeps the words", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const v = mount(
      [prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)],
      onAnswer,
      undefined,
      undefined,
      { inertReason: "Watching alice" },
    );
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.ownRow()!.disabled).toBe(true);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("the composer's place", () => {
  it("hides the composer while the card is up, keeps its draft, and brings it back", async () => {
    const v = mount([prompt(1), planUse(2, "p1")]);
    const composer = () => v.container.querySelector<HTMLElement>(".tl-composer")!;
    fireEvent.input(v.field(), { target: { value: "a draft" } });
    v.setEvents([...v.events(), asking(3, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(composer().hidden).toBe(true);
    expect(v.field().value).toBe("a draft");
    v.setEvents([...v.events(), asking(4, ""), approved(5, "p1")]);
    await waitFor(() => expect(v.card()).toBeNull());
    expect(composer().hidden).toBe(false);
    expect(v.field().value).toBe("a draft");
  });

  it("gives the composer back while the card says the plan has gone", async () => {
    // Nothing is left to answer, and the field is where the next prompt goes.
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], async () => ({
      applied: false,
      reason: "not-drawn",
    }));
    await waitFor(() => expect(v.option(2)).toBeDefined());
    expect(v.container.querySelector<HTMLElement>(".tl-composer")!.hidden).toBe(true);
    v.option(2)!.click();
    await waitFor(() =>
      expect(v.card()!.textContent).toContain("The plan is no longer waiting in the Terminal."),
    );
    expect(v.container.querySelector<HTMLElement>(".tl-composer")!.hidden).toBe(false);
  });
});

describe("what the card's field sends", () => {
  it("sends nothing for blanks and line breaks", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const onSend = vi.fn(async () => true);
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer, onSend);
    await waitFor(() => expect(v.card()).not.toBeNull());
    await v.typeOwn("  \n \n ");
    fireEvent.keyDown(v.ownField()!, { key: "Enter" });
    fireEvent.click(v.ownSend());
    await Promise.resolve();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(v.card()).not.toBeNull();
  });

  it("does not send feedback over 2,000 bytes, says why, and keeps the words", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const onSend = vi.fn(async () => true);
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer, onSend);
    await waitFor(() => expect(v.card()).not.toBeNull());
    // 1,001 two-byte characters: 1,001 characters, 2,002 bytes.
    const long = "é".repeat(1001);
    await v.typeOwn(long);
    fireEvent.click(v.ownSend());
    await waitFor(() =>
      expect(v.card()!.textContent).toContain(
        "Not sent: the Terminal's feedback field takes up to 2,000 bytes.",
      ),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(v.ownField()!.value).toBe(long);
  });

  it("says line breaks become spaces for the card's words, not the hidden composer's", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    fireEvent.input(v.field(), { target: { value: "first\nsecond" } });
    await Promise.resolve();
    expect(v.card()!.querySelector(".tl-plancard-lines")).toBeNull();
    await v.typeOwn("first\nsecond");
    expect(v.card()!.querySelector(".tl-plancard-lines")).not.toBeNull();
  });

  it.each(["no-dialog", "not-drawn"] as const)(
    "hands the words to the composer on %s, and its next Send goes as a prompt",
    async (reason) => {
      const onAnswer = vi.fn(
        async (_req: AnswerRequest): Promise<AnswerResponse> => ({ applied: false, reason }),
      );
      const onSend = vi.fn(async (_text: string) => true);
      const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)], onAnswer, onSend);
      await waitFor(() => expect(v.card()).not.toBeNull());
      await v.typeOwn("one more step");
      fireEvent.click(v.ownSend());
      await waitFor(() =>
        expect(v.card()!.textContent).toContain("The plan is no longer waiting in the Terminal."),
      );
      // Nothing is left to answer: the composer is back, holding the words.
      const composer = v.container.querySelector<HTMLElement>(".tl-composer")!;
      await waitFor(() => expect(composer.hidden).toBe(false));
      await waitFor(() => expect(v.field().value).toBe("one more step"));
      expect(v.ownField()).toBeNull();
      expect(onSend).not.toHaveBeenCalled();

      fireEvent.click(v.send());
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("one more step"));
      expect(onAnswer).toHaveBeenCalledTimes(1);
    },
  );
});

describe("the hidden composer while the card is docked", () => {
  it("keeps its words and says to answer from the card, rather than typing into the menu", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const onSend = vi.fn(async () => true);
    const notify = vi.fn();
    const v = mount(
      [prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)],
      onAnswer,
      onSend,
      undefined,
      { notify },
    );
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.field().getAttribute("placeholder")).toBe("Ask Claude, or run a command…");
    fireEvent.input(v.field(), { target: { value: "a draft" } });
    fireEvent.click(v.send());
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Claude's plan is waiting. Answer it from the card first.",
        "warning",
      ),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(v.field().value).toBe("a draft"));
  });

  it("leaves 1 and 2 on an empty field to a permission, never the plan", async () => {
    const onAnswer = vi.fn(async (_req: AnswerRequest) => applied());
    const onResolve = vi.fn();
    const v = mount(
      [prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)],
      onAnswer,
      undefined,
      undefined,
      { onResolve },
    );
    await waitFor(() => expect(v.card()).not.toBeNull());
    fireEvent.keyDown(v.field(), { key: "1" });
    fireEvent.keyDown(v.field(), { key: "2" });
    await Promise.resolve();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
    expect(v.card()).not.toBeNull();
  });
});

describe("the model button while the card is docked", () => {
  const modeEvent = (id: number, mode: string): Event =>
    ev({ id, kind: "meta", meta: "permission-mode", body: mode });

  it("holds the model button with the reason as the title, before the transcript has the call", async () => {
    // The prompt opened a turn and nothing records the plan call yet, so only
    // the pane's reading says a dialog is up.
    const onSetModel = vi.fn(async () => ({
      ok: true as const,
      state: { model: "claude-sonnet-5", effort: "" },
    }));
    const v = mount(
      [modeEvent(1, "default"), prompt(2), asking(3, PLAN_FIRST)],
      undefined,
      undefined,
      undefined,
      { harness: "claude", onSetModel },
    );
    await waitFor(() => expect(v.card()).not.toBeNull());
    await waitFor(() => expect(v.dial()?.getAttribute("data-mode")).toBe("default"));
    const model = v.dial()!;
    expect(model.getAttribute("aria-disabled")).toBe("true");
    expect(model.getAttribute("title")).toBe(
      "Answer Claude first: a model change now would type into the open dialog",
    );
    fireEvent.click(model);
    expect(v.container.querySelector(".tl-ms-pop")).toBeNull();
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("frees the model button once the dialog has been answered", async () => {
    const v = mount(
      [modeEvent(1, "default"), prompt(2), planUse(3, "p1"), asking(4, PLAN_FIRST)],
      undefined,
      undefined,
      undefined,
      {
        harness: "claude",
        onSetModel: async () => ({ ok: true as const, state: { model: "", effort: "" } }),
      },
    );
    await waitFor(() => expect(v.card()).not.toBeNull());
    v.setEvents([...v.events(), asking(5, ""), approved(6, "p1")]);
    await waitFor(() => expect(v.card()).toBeNull());
    await waitFor(() => expect(v.dial()!.getAttribute("aria-disabled")).toBeNull());
  });
});

describe("the live group while the card is docked", () => {
  it("reads 'Waiting for you' before the transcript has the call", async () => {
    // The prompt opened a turn, so the transcript alone says Claude works.
    const v = mount([prompt(1), asking(2, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.status()).toBe("Waiting for you");
  });

  it("reads 'Waiting for you' with the call pending, and moves on once answered", async () => {
    const v = mount([prompt(1), planUse(2, "p1"), asking(3, PLAN_FIRST)]);
    await waitFor(() => expect(v.card()).not.toBeNull());
    expect(v.status()).toBe("Waiting for you");
    v.option(2)!.click();
    await waitFor(() => expect(v.card()).toBeNull());
    v.setEvents([...v.events(), asking(4, ""), approved(5, "p1")]);
    await waitFor(() => expect(v.status()).toBe("Working…"));
  });
});
