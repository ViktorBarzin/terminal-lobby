/**
 * A watching device does not type into the session, from the Text view either.
 *
 * Found in review on 2026-09-27 against 0.78.0: while the status line read
 * "Watching · this device does not type into the session", Enter in the field
 * posted the prompt and Claude answered it, Send over a plan dialog went out
 * as plan feedback, and a tap on the permission card's "No" answered the CLI's
 * prompt. Only the tray and the dials honoured the watch. The server takes a
 * prompt or an answer from any client, so the view is where watching holds.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AnswerRequest, AnswerResponse } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

const WATCHING = "Watching: this device does not type into the session";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "qa", ...e });

/** The card's row digits arm a moment after it docks (TextView
 *  CARD_KEYS_ARM_MS); a digit pressed before that is typing. */
const armed = (root: HTMLElement) =>
  waitFor(() => expect(root.querySelector('[data-card-keys="armed"]')).not.toBeNull(), {
    timeout: 2000,
  });
const asking = (id: number, body: unknown): Event =>
  ev({ id, kind: "meta", meta: "asking", body: JSON.stringify(body) });
/** A question the lobby's hook is holding for the card (ADR-0034). */
const held = (id: number, body: unknown): Event =>
  ev({ id, kind: "meta", meta: "held", body: JSON.stringify(body) });

const PERMISSION = {
  kind: "permission",
  title: "Bash command",
  detail: ["touch second.txt"],
  prompt: "Do you want to proceed?",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "Yes, and switch to auto mode" },
    { number: 3, label: "No" },
  ],
};
const PLAN = {
  kind: "plan",
  options: [
    { number: 1, label: "Yes, and use auto mode" },
    { number: 2, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 3,
  planPath: "~/.claude/plans/plan-x.md",
};
const QUESTION = {
  questions: [
    {
      header: "Colour",
      question: "Which colour?",
      multiSelect: false,
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "" },
      ],
    },
  ],
  count: 1,
};

function mount(initial: Event[]) {
  const onSend = vi.fn(async (_t: string) => true);
  const onKeys = vi.fn(async (_k: string[]) => true);
  const onAnswer = vi.fn(
    async (_r: AnswerRequest): Promise<AnswerResponse | null> => ({ applied: true, done: true }),
  );
  const notify = vi.fn();
  const onTakeControl = vi.fn();
  const [events] = createSignal<Event[]>(initial);
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
      notify={notify}
      inertReason={WATCHING}
      onTakeControl={onTakeControl}
    />
  ));
  const field = () => r.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const rows = (card: string) => [
    ...r.container.querySelectorAll<HTMLButtonElement>(`${card} .tl-qcard-option`),
  ];
  const type = (text: string) => {
    fireEvent.input(field(), { target: { value: text } });
    fireEvent.keyDown(field(), { key: "Enter" });
  };
  return { r, field, rows, type, onSend, onKeys, onAnswer, notify, onTakeControl };
}

const prompt = ev({ id: 1, kind: "user", body: "hello", at: 1000 });

describe("a watching Text view", () => {
  it("reads Watching with Take control in the composer's place, and has no textbox", () => {
    const v = mount([prompt]);
    const pill = v.r.container.querySelector(".tl-pill[data-watch]")!;
    expect(pill.querySelector(".tl-watch")?.textContent).toMatch(/^Watching/);
    expect(v.r.queryByRole("textbox")).toBeNull();
    const take = v.r.getByRole("button", { name: "Take control" });
    fireEvent.click(take);
    expect(v.onTakeControl).toHaveBeenCalledTimes(1);
  });

  it("does not send the field, keeps the words, and says why", async () => {
    const v = mount([prompt]);
    v.type("Reply with the word watched");
    await waitFor(() => expect(v.notify).toHaveBeenCalledWith(WATCHING, "info"));
    expect(v.onSend).not.toHaveBeenCalled();
    expect(v.field().value).toBe("Reply with the word watched");
  });

  it("does not send the hidden composer while the plan card is up", async () => {
    const v = mount([prompt, asking(2, PLAN)]);
    v.type("watching text 1");
    await waitFor(() => expect(v.notify).toHaveBeenCalledWith(WATCHING, "info"));
    expect(v.onAnswer).not.toHaveBeenCalled();
    expect(v.onSend).not.toHaveBeenCalled();
    expect(v.field().value).toBe("watching text 1");
  });

  it("draws the plan card's rows inert", async () => {
    const v = mount([prompt, asking(2, PLAN)]);
    // The two approve rows and the card's "Tell Claude what to change", all inert.
    await waitFor(() => expect(v.rows(".tl-plancard")).toHaveLength(3));
    for (const b of v.rows(".tl-plancard")) expect(b.disabled).toBe(true);
    fireEvent.click(v.rows(".tl-plancard")[0]!);
    expect(v.onAnswer).not.toHaveBeenCalled();
  });

  it("draws the permission card's rows inert and presses nothing", async () => {
    const v = mount([prompt, asking(2, PERMISSION)]);
    // The prompt's rows and the card's "Type your own answer", all inert.
    await waitFor(() => expect(v.rows(".tl-permcard")).toHaveLength(4));
    for (const b of v.rows(".tl-permcard")) expect(b.disabled).toBe(true);
    fireEvent.click(v.rows(".tl-permcard")[2]!);
    await armed(v.r.container);
    fireEvent.keyDown(v.field(), { key: "1" });
    await waitFor(() => expect(v.notify).toHaveBeenCalledWith(WATCHING, "info"));
    expect(v.onKeys).not.toHaveBeenCalled();
  });

  it("draws the question card's rows inert and answers nothing", async () => {
    const v = mount([prompt, held(2, QUESTION)]);
    const options = () =>
      v.rows(".tl-qcard").filter((b) => b.classList.contains("tl-qcard-option"));
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    for (const b of options()) expect(b.disabled).toBe(true);
    fireEvent.click(options()[0]!);
    v.type("Green");
    await waitFor(() => expect(v.notify).toHaveBeenCalledWith(WATCHING, "info"));
    expect(v.onAnswer).not.toHaveBeenCalled();
    expect(v.onKeys).not.toHaveBeenCalled();
    expect(v.onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["plan", ".tl-plancard", asking(2, PLAN)],
    ["permission", ".tl-permcard", asking(2, PERMISSION)],
    ["question", ".tl-qcard:not(.tl-plancard):not(.tl-permcard)", held(2, QUESTION)],
  ] as const)("offers Take control from the %s card's head", async (_name, sel, event) => {
    const v = mount([prompt, event]);
    const link = () =>
      [...v.r.container.querySelectorAll<HTMLButtonElement>(`${sel} .tl-qcard-head button`)].find(
        (b) => b.textContent === "Take control",
      );
    await waitFor(() => expect(link()).toBeDefined());
    link()!.click();
    expect(v.onTakeControl).toHaveBeenCalledTimes(1);
  });
});
