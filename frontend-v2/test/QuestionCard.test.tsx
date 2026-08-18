import { render, fireEvent } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard } from "../src/components/QuestionCard";
import type { Question } from "../src/components/canonicalize";

function q(over: Partial<Question> = {}): Question {
  return {
    question: "Where should the parse live?",
    header: "Parse home",
    multiSelect: false,
    options: [
      { label: "All Go", description: "parsing sits with the other parsing" },
      { label: "All TypeScript", description: "follows the modeFromPane precedent" },
      { label: "Split", description: "" },
    ],
    ...over,
  };
}

function mount(questions: Question[]) {
  const onSend = vi.fn(async () => {});
  const onChat = vi.fn();
  const r = render(() => (
    <QuestionCard questions={questions} onSend={onSend} onChat={onChat} />
  ));
  const options = () => [...r.container.querySelectorAll<HTMLElement>(".tl-qcard-option")];
  const optionByLabel = (label: string) =>
    options().find((o) => o.textContent?.includes(label))!;
  const button = (cls: string) => r.container.querySelector<HTMLButtonElement>(cls);
  return { ...r, onSend, onChat, options, optionByLabel, button };
}

describe("<QuestionCard>", () => {
  it("shows the tool's own two extra options beside the transcript's", () => {
    const { options } = mount([q()]);
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining("All Go"),
      expect.stringContaining("All TypeScript"),
      expect.stringContaining("Split"),
      expect.stringContaining("Other"),
      expect.stringContaining("Chat about this"),
    ]);
  });

  it("carries each option's description, which is where the reasoning is", () => {
    const { container } = mount([q()]);
    expect(container.textContent).toContain("parsing sits with the other parsing");
  });

  // The whole point of collecting locally: until Send, the dialog is untouched.
  it("types nothing into the session while the walk is going on", () => {
    const { optionByLabel, button, onSend } = mount([q(), q()]);
    optionByLabel("Split").click();
    button(".tl-qcard-next")!.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("will not advance until the question has an answer", () => {
    const { button, optionByLabel } = mount([q(), q()]);
    expect(button(".tl-qcard-next")!.disabled).toBe(true);
    optionByLabel("All Go").click();
    expect(button(".tl-qcard-next")!.disabled).toBe(false);
  });

  it("walks every question, not only the first", () => {
    const first = q({ question: "Which lane?", header: "Lane" });
    const second = q({ question: "How does it land?", header: "Landing" });
    const { container, optionByLabel, button } = mount([first, second]);

    expect(container.textContent).toContain("question 1 of 2");
    optionByLabel("All Go").click();
    button(".tl-qcard-next")!.click();
    expect(container.textContent).toContain("question 2 of 2");
    expect(container.textContent).toContain("How does it land?");
  });

  it("goes back without losing what was already picked", () => {
    const { container, optionByLabel, button } = mount([q(), q()]);
    optionByLabel("Split").click();
    button(".tl-qcard-next")!.click();
    button(".tl-qcard-back")!.click();
    expect(container.textContent).toContain("question 1 of 2");
    expect(optionByLabel("Split").dataset.chosen).toBe("true");
  });

  it("keeps several options for a multi-select question", () => {
    const { optionByLabel } = mount([q({ multiSelect: true })]);
    optionByLabel("All Go").click();
    optionByLabel("Split").click();
    expect(optionByLabel("All Go").dataset.chosen).toBe("true");
    expect(optionByLabel("Split").dataset.chosen).toBe("true");
  });

  it("replaces the choice for a single-select question", () => {
    const { optionByLabel } = mount([q()]);
    optionByLabel("All Go").click();
    optionByLabel("Split").click();
    expect(optionByLabel("All Go").dataset.chosen).toBeUndefined();
    expect(optionByLabel("Split").dataset.chosen).toBe("true");
  });

  it("reviews the answers before sending them", () => {
    const first = q({ header: "Lane" });
    const second = q({ header: "Landing" });
    const { container, optionByLabel, button } = mount([first, second]);
    optionByLabel("All Go").click();
    button(".tl-qcard-next")!.click();
    optionByLabel("Split").click();
    button(".tl-qcard-next")!.click();

    expect(container.textContent).toContain("review");
    expect(container.textContent).toContain("Lane");
    expect(container.textContent).toContain("All Go");
    expect(container.textContent).toContain("Split");
  });

  it("sends what the review showed", () => {
    const { optionByLabel, button, onSend } = mount([q()]);
    optionByLabel("Split").click();
    button(".tl-qcard-next")!.click();
    button(".tl-qcard-send")!.click();
    expect(onSend).toHaveBeenCalledWith([{ chosen: ["Split"] }]);
  });

  // Other is an answer in the reader's own words; an empty box is not one.
  it("asks for the text before Other counts as answered", () => {
    const { container, optionByLabel, button } = mount([q()]);
    optionByLabel("Other").click();
    const box = container.querySelector<HTMLInputElement>(".tl-qcard-other")!;
    expect(button(".tl-qcard-next")!.disabled).toBe(true);
    fireEvent.input(box, { target: { value: "none of these" } });
    expect(button(".tl-qcard-next")!.disabled).toBe(false);
  });

  it("sends the typed text with the Other answer", () => {
    const { container, optionByLabel, button, onSend } = mount([q()]);
    optionByLabel("Other").click();
    fireEvent.input(container.querySelector(".tl-qcard-other")!, {
      target: { value: "none of these" },
    });
    button(".tl-qcard-next")!.click();
    button(".tl-qcard-send")!.click();
    expect(onSend).toHaveBeenCalledWith([{ chosen: ["Other"], other: "none of these" }]);
  });

  // "Chat about this" defers the question rather than answering it.
  it("hands the reader the composer instead of choosing for them", () => {
    const { optionByLabel, onChat, onSend } = mount([q()]);
    optionByLabel("Chat about this").click();
    expect(onChat).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
