/**
 * The card that answers Claude Code's plan approval, in the composer's place
 * since the T3 pass (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows", and open point 10).
 *
 * The card renders one reading and the state its caller holds: which answer is
 * in flight, and what the last reply said. It sends nothing itself. A tap on
 * an option asks the caller to approve with that row. The last row, "Tell
 * Claude what to change", opens the card's own field (the T3 pass, prototype
 * 6-plan): its Send asks the caller to send the words as feedback, and
 * "Approve with this feedback", offered beside it while it holds text, asks
 * the caller to send them with `approve: true`.
 *
 * What it must never do is answer by accident. There are no digit shortcuts
 * and no raw keypad, because option 1 in the usual layout clears the context
 * and starts carrying out the plan. There is no Reject button either: the CLI
 * rejects only through Esc or Enter on an empty feedback row, and the
 * Terminal's Esc still works.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlanCard } from "../src/components/PlanCard";
import type { PlanReading } from "../src/components/timeline.logic";

/** plan-first.txt, as planFromPane reads it: three approve rows, feedback on 4. */
const READING: PlanReading = {
  options: [
    { number: 1, label: "Yes, clear context (6% used) and use auto mode" },
    { number: 2, label: "Yes, and use auto mode" },
    { number: 3, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 4,
  planPath: "~/.claude/plans/quiet-otter.md",
};

/** plan-no-auto.txt: auto mode off and no clear context option, feedback on 3. */
const NO_AUTO: PlanReading = {
  options: [
    { number: 1, label: "Yes, auto-accept edits" },
    { number: 2, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 3,
  planPath: "~/.claude/plans/quiet-otter.md",
};

const PLAN = "# Add a size check\n\n1. Read the file.\n2. Print its size with `wc -c`.";

type Props = ComponentProps<typeof PlanCard>;

const mount = (over: Partial<Props> = {}) => {
  const onApprove = vi.fn();
  const onFeedback = vi.fn(async (_words: string) => true);
  const onApproveWithFeedback = vi.fn(async (_words: string) => true);
  const onTerminal = vi.fn();
  const r = render(() => (
    <PlanCard
      reading={READING}
      plan={PLAN}
      onApprove={onApprove}
      onFeedback={onFeedback}
      onApproveWithFeedback={onApproveWithFeedback}
      onTerminal={onTerminal}
      {...over}
    />
  ));
  return { ...r, onApprove, onFeedback, onApproveWithFeedback, onTerminal };
};

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** The approve rows, the CLI's numbered ones; the own row is not one of them. */
const options = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLButtonElement>(".tl-qcard-option:not(.tl-qcard-own)"),
];
const ownRow = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-qcard-own");
const ownField = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>(".tl-qcard-owninput");
const ownSend = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".tl-qcard-ownfield .tl-send");
/** Open the own row and type these words into its field. */
const typeOwn = async (c: HTMLElement, words: string) => {
  fireEvent.click(ownRow(c)!);
  await Promise.resolve();
  fireEvent.input(ownField(c)!, { target: { value: words } });
};
const button = (c: HTMLElement, name: string | RegExp) =>
  [...c.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof name === "string" ? text(b) === name : name.test(text(b)),
  );
const notice = (c: HTMLElement) => text(c.querySelector(".tl-plancard-notice"));

describe("<PlanCard> at rest", () => {
  it("is titled, and docks as the question card does, under its cap", () => {
    const { container } = mount();
    const card = container.querySelector(".tl-qcard");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("dialog");
    expect(card?.getAttribute("aria-label")).toBe("Claude's plan is ready");
    expect(text(container.querySelector(".tl-qcard-title"))).toBe("Plan ready");
  });

  it("shows the plan's title as its question line and the rest as markdown", () => {
    const { container } = mount();
    expect(text(container.querySelector(".tl-qcard-question"))).toBe("Add a size check");
    const plan = container.querySelector(".tl-plancard-plan");
    expect(plan?.querySelector("h1")).toBeNull();
    expect(plan?.querySelector("code")?.textContent).toBe("wc -c");
    expect(plan?.closest(".tl-plancard-well")).not.toBeNull();
  });

  it("keeps a plan with no leading heading whole, with no question line", () => {
    const { container } = mount({ plan: "1. Read the file.\n2. Done." });
    expect(container.querySelector(".tl-qcard-question")).toBeNull();
    expect(text(container.querySelector(".tl-plancard-plan"))).toContain("Read the file.");
  });

  it("offers each approve row with its number and its label exactly as drawn", () => {
    const { container } = mount();
    const rows = options(container);
    expect(rows.map((b) => text(b.querySelector(".tl-qcard-key")))).toEqual(["1", "2", "3"]);
    expect(rows.map((b) => text(b.querySelector(".tl-qcard-label")))).toEqual(
      READING.options.map((o) => o.label),
    );
  });

  it("reads the rows off the reading rather than a list of its own", () => {
    const { container } = mount({ reading: NO_AUTO });
    expect(options(container).map((b) => text(b.querySelector(".tl-qcard-label")))).toEqual([
      "Yes, auto-accept edits",
      "Yes, manually approve edits",
    ]);
  });

  it("ends with Tell Claude what to change, a muted row with a pen and no number", () => {
    const { container } = mount();
    expect(options(container)).toHaveLength(3);
    const own = ownRow(container);
    expect(text(own?.querySelector(".tl-qcard-label") ?? null)).toBe("Tell Claude what to change");
    expect(own?.querySelector(".tl-qcard-key svg")).not.toBeNull();
    expect(text(own?.querySelector(".tl-qcard-key") ?? null)).toBe("");
    // It is the last row, under the approve rows.
    const rows = [...container.querySelectorAll(".tl-qcard-options > *")];
    expect(rows[rows.length - 1]).toBe(own);
  });

  it("approves with the row tapped, by number and label", () => {
    const { container, onApprove } = mount();
    fireEvent.click(options(container)[1]!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({ number: 2, label: "Yes, and use auto mode" });
  });

  it("says nothing under the options while nothing has happened", () => {
    const { container } = mount();
    expect(notice(container)).toBe("");
    expect(button(container, "Open Terminal")).toBeUndefined();
  });
});

describe("<PlanCard> never answers by accident", () => {
  it("has no digit shortcuts", () => {
    const { container, onApprove } = mount();
    const card = container.querySelector<HTMLElement>(".tl-qcard")!;
    for (const key of ["1", "2", "3", "4", "Enter"]) {
      fireEvent.keyDown(card, { key });
      fireEvent.keyDown(document, { key });
      fireEvent.keyDown(window, { key });
    }
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("has no Reject button, even with feedback written", async () => {
    const { container } = mount();
    await typeOwn(container, "smaller steps");
    expect(button(container, /reject|cancel|no,? /i)).toBeUndefined();
  });

  it("types digits into its own field as words, never as a pick", async () => {
    const { container, onApprove, onFeedback } = mount();
    await typeOwn(container, "");
    for (const key of ["1", "2", "3"]) fireEvent.keyDown(ownField(container)!, { key });
    expect(onApprove).not.toHaveBeenCalled();
    expect(onFeedback).not.toHaveBeenCalled();
  });

  it("never falls back to a raw keypad, even when the choices cannot be read", () => {
    const { container } = mount({ reading: null });
    // A raw capture would draw as `.tl-code` with tappable rows.
    expect(container.querySelector(".tl-code")).toBeNull();
    expect(options(container)).toHaveLength(0);
  });
});

describe("<PlanCard> plan text", () => {
  it("reads 'Loading the plan…' until the transcript holds the call", () => {
    const { container } = mount({ plan: null });
    expect(text(container.querySelector(".tl-plancard-loading"))).toBe("Loading the plan…");
    expect(container.querySelector(".tl-plancard-plan")).toBeNull();
    // The choices are the pane's, so they can be answered already.
    expect(options(container)).toHaveLength(3);
  });

  it("notes a plan changed while it was presented", () => {
    const { container } = mount({ stale: true });
    expect(text(container.querySelector(".tl-plancard-stale"))).toBe(
      "Claude changed the plan while presenting it. The Terminal shows the current version.",
    );
  });

  it("has no stale note otherwise", () => {
    const { container } = mount();
    expect(container.querySelector(".tl-plancard-stale")).toBeNull();
  });
});

describe("<PlanCard> clamps a long plan behind 'Read the full plan'", () => {
  const stub = (scroll: number, client: number) => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => scroll,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => client,
    });
  };
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  it("offers 'Read the full plan' when the plan overflows its clamp, and 'Show less' after", async () => {
    stub(600, 180);
    const { container } = mount();
    // Measured once the plan is laid out, a microtask after it mounts.
    await Promise.resolve();
    const plan = container.querySelector(".tl-plancard-plan")!;
    const toggle = button(container, "Read the full plan");
    expect(toggle).toBeDefined();
    // The prototype's link on the right of the head.
    expect(toggle!.closest(".tl-qcard-head")).not.toBeNull();
    expect(plan.getAttribute("data-full")).toBeNull();
    // Clamped, it fades out rather than cutting a line in half.
    expect(plan.getAttribute("data-clamped")).toBe("true");
    fireEvent.click(toggle!);
    expect(plan.getAttribute("data-full")).toBe("true");
    expect(plan.getAttribute("data-clamped")).toBeNull();
    expect(button(container, "Show less")).toBeDefined();
    fireEvent.click(button(container, "Show less")!);
    expect(plan.getAttribute("data-full")).toBeNull();
  });

  it("measures a plan that arrives after 'Loading the plan…'", async () => {
    stub(600, 180);
    const [plan, setPlan] = createSignal<string | null>(null);
    const { container } = render(() => (
      <PlanCard reading={READING} plan={plan()} onApprove={() => {}} />
    ));
    expect(button(container, "Read the full plan")).toBeUndefined();
    setPlan(PLAN);
    await Promise.resolve();
    expect(button(container, "Read the full plan")).toBeDefined();
  });

  it("watches the plan for growth, whenever it mounts", () => {
    // A mermaid fence or highlighted code swaps in after the first paint.
    const observed: Element[] = [];
    const Real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const [plan, setPlan] = createSignal<string | null>(null);
      const { container } = render(() => (
        <PlanCard reading={READING} plan={plan()} onApprove={() => {}} />
      ));
      setPlan(PLAN);
      expect(observed).toContain(container.querySelector(".tl-plancard-plan"));
    } finally {
      globalThis.ResizeObserver = Real;
    }
  });

  it("offers nothing for a plan that fits", async () => {
    stub(120, 120);
    const { container } = mount();
    await Promise.resolve();
    expect(button(container, "Read the full plan")).toBeUndefined();
    expect(container.querySelector(".tl-plancard-plan")?.getAttribute("data-clamped")).toBeNull();
  });

  it("clamps in CSS, and unclamps with data-full", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
    const block = (selector: string) => {
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1]!.trim().split("\n").pop()!.trim();
        if (sel === selector) return m[2]!;
      }
      throw new Error(`no rule for ${selector}`);
    };
    expect(block(".tl-plancard-plan")).toMatch(/max-height:/);
    expect(block(".tl-plancard-plan")).toMatch(/overflow:\s*hidden/);
    expect(block('.tl-plancard-plan[data-full="true"]')).toMatch(/max-height:\s*none/);
  });
});

describe("<PlanCard> 'Tell Claude what to change'", () => {
  it("opens into the card's own field, named for what it does", async () => {
    const { container } = mount();
    expect(ownField(container)).toBeNull();
    fireEvent.click(ownRow(container)!);
    await Promise.resolve();
    const field = ownField(container)!;
    expect(field.getAttribute("placeholder")).toBe("Tell Claude what to change…");
    expect(field.getAttribute("aria-label")).toBe("Tell Claude what to change");
    expect(document.activeElement).toBe(field);
  });

  it("sends the words as feedback on the Send beside them, and empties when it lands", async () => {
    const { container, onFeedback, onApprove, onApproveWithFeedback } = mount();
    await typeOwn(container, "use the existing helper");
    fireEvent.click(ownSend(container)!);
    expect(onFeedback).toHaveBeenCalledWith("use the existing helper");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onApproveWithFeedback).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(ownField(container)?.value ?? "").toBe("");
  });

  it("sends on Enter, and breaks the line on Shift+Enter", async () => {
    const { container, onFeedback } = mount();
    await typeOwn(container, "first");
    fireEvent.keyDown(ownField(container)!, { key: "Enter", shiftKey: true });
    expect(onFeedback).not.toHaveBeenCalled();
    fireEvent.keyDown(ownField(container)!, { key: "Enter" });
    expect(onFeedback).toHaveBeenCalledWith("first");
  });

  it("keeps the words when the feedback was not sent", async () => {
    const onFeedback = vi.fn(async (_w: string) => false);
    const { container } = mount({ onFeedback });
    await typeOwn(container, "keep this");
    fireEvent.click(ownSend(container)!);
    await Promise.resolve();
    await Promise.resolve();
    expect(ownField(container)!.value).toBe("keep this");
  });

  it("sends nothing for blanks", async () => {
    const { container, onFeedback } = mount();
    await typeOwn(container, "  \n  ");
    expect(ownSend(container)!.disabled).toBe(true);
    fireEvent.keyDown(ownField(container)!, { key: "Enter" });
    expect(onFeedback).not.toHaveBeenCalled();
  });

  it("is held while watching", () => {
    const { container } = mount({ inert: "Watching alice" });
    expect(ownRow(container)!.disabled).toBe(true);
  });
});

describe("<PlanCard> 'Approve with this feedback'", () => {
  /* Found live 2026-09-27 on the Android emulator: with option 1 "Yes, clear
     context (9% used) and use auto mode", the button approved through option 1
     and the context meter went from 9% to 5%. The CLI's Shift+Tab takes option
     1, as the first measured session did too, so the button says it clears the
     context whenever option 1 does. */
  it("says it clears the context when option 1 does", async () => {
    const { container } = mount();
    await typeOwn(container, "and keep the tests");
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    expect(button(container, "Approve with this feedback and clear context")).toBeDefined();
  });

  it("stays plain when option 1 keeps the context", async () => {
    const { container } = mount({ reading: NO_AUTO });
    await typeOwn(container, "and keep the tests");
    expect(button(container, "Approve with this feedback")).toBeDefined();
  });

  it("is offered only while the card's field holds text, and carries those words", async () => {
    const { container, onApproveWithFeedback, onFeedback } = mount({ reading: NO_AUTO });
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    await typeOwn(container, "   ");
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    fireEvent.input(ownField(container)!, { target: { value: "approve, and keep the tests" } });
    const approve = button(container, "Approve with this feedback");
    expect(approve).toBeDefined();
    fireEvent.click(approve!);
    expect(onApproveWithFeedback).toHaveBeenCalledWith("approve, and keep the tests");
    expect(onFeedback).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(button(container, "Approve with this feedback")).toBeUndefined();
  });

  it("keeps the words when the approval was not sent", async () => {
    const onApproveWithFeedback = vi.fn(async (_w: string) => false);
    const { container } = mount({ reading: NO_AUTO, onApproveWithFeedback });
    await typeOwn(container, "keep this");
    fireEvent.click(button(container, "Approve with this feedback")!);
    await Promise.resolve();
    await Promise.resolve();
    expect(ownField(container)!.value).toBe("keep this");
  });
});

describe("<PlanCard> while an answer is in flight", () => {
  it("marks the option being approved and holds the others", () => {
    const { container, onApprove } = mount({ sending: { kind: "option", number: 2 } });
    const rows = options(container);
    expect(text(rows[1]!)).toContain("Approving…");
    expect(rows[1]!.getAttribute("aria-busy")).toBe("true");
    expect(text(rows[0]!)).not.toContain("Approving…");
    for (const row of rows) expect(row.disabled).toBe(true);
    fireEvent.click(rows[0]!);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("says feedback is on its way and holds every choice", async () => {
    const [sending, setSending] = createSignal<Props["sending"]>(null);
    const { container } = mount({
      get sending() {
        return sending();
      },
    });
    await typeOwn(container, "smaller steps");
    setSending({ kind: "feedback" });
    expect(notice(container)).toBe("Sending your feedback…");
    for (const row of options(container)) expect(row.disabled).toBe(true);
    expect(ownField(container)!.disabled).toBe(true);
    expect(ownSend(container)!.disabled).toBe(true);
    expect(button(container, "Approve with this feedback and clear context")?.disabled).toBe(true);
  });

  it("says the last answer is still going when Send is pressed again", () => {
    const { container } = mount({ sending: { kind: "option", number: 1 }, notice: "busy" });
    expect(notice(container)).toBe("Still sending your last answer…");
  });

  it("announces what it says, politely", () => {
    const { container } = mount({ sending: { kind: "feedback" } });
    const region = container.querySelector(".tl-plancard-notice");
    expect(region?.getAttribute("role")).toBe("status");
  });
});

describe("<PlanCard> after a refused reply", () => {
  it("re-renders the reply's choices and asks for a new pick (unknown-option)", () => {
    const { container } = mount({ reading: NO_AUTO, notice: "changed" });
    expect(notice(container)).toBe("The Terminal now shows different choices. Pick again.");
    expect(options(container).map((b) => text(b.querySelector(".tl-qcard-label")))).toEqual([
      "Yes, auto-accept edits",
      "Yes, manually approve edits",
    ]);
    for (const row of options(container)) expect(row.disabled).toBe(false);
  });

  it("says the plan has gone, and offers nothing to answer (not-drawn, no-dialog)", () => {
    const { container } = mount({ notice: "gone" });
    expect(notice(container)).toBe("The plan is no longer waiting in the Terminal.");
    expect(options(container)).toHaveLength(0);
    expect(ownRow(container)).toBeNull();
    expect(ownField(container)).toBeNull();
  });

  it("says the plan has gone even when the reply carried no plan reading", () => {
    // not-drawn carries the OTHER dialog's reading, which is no plan reading.
    const { container } = mount({ reading: null, notice: "gone" });
    expect(notice(container)).toBe("The plan is no longer waiting in the Terminal.");
    expect(container.textContent).not.toContain("Couldn't read the plan's choices");
  });

  it("sends the reader to the Terminal when the answer may not have landed", () => {
    const { container, onTerminal } = mount({ notice: "unverified" });
    expect(notice(container)).toBe("Your answer may not have landed. Check the Terminal.");
    const terminal = button(container, "Open Terminal");
    expect(terminal).toBeDefined();
    fireEvent.click(terminal!);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("says why it cannot offer the choices when the pane could not be read", () => {
    const { container, onTerminal } = mount({ reading: null });
    expect(notice(container)).toBe(
      "Couldn't read the plan's choices. Open the Terminal to answer it.",
    );
    expect(ownRow(container)).toBeNull();
    fireEvent.click(button(container, "Open Terminal")!);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("<PlanCard> notes about the feedback", () => {
  it("says line breaks become spaces while the field has one", async () => {
    const { container } = mount();
    await typeOwn(container, "first\nsecond");
    expect(text(container.querySelector(".tl-plancard-lines"))).toBe(
      "Line breaks become spaces, because the Terminal's feedback field is one line.",
    );
  });

  it("has no line-break note otherwise", async () => {
    const { container } = mount();
    await typeOwn(container, "one line");
    expect(container.querySelector(".tl-plancard-lines")).toBeNull();
  });

  it("says why feedback over 2,000 bytes was not sent", () => {
    const { container } = mount({ notice: "too-long" });
    expect(notice(container)).toBe(
      "Not sent: the Terminal's feedback field takes up to 2,000 bytes. Shorten it and send again.",
    );
  });
});

/**
 * The numbered keycaps are shortcuts, as they are on the question and
 * permission cards (deployed review rounds 3 to 5, 2026-09-28: the plan card
 * drew them and a digit typed into the hidden message instead). Armed the same
 * way: only once the Text view says the card's keys are live, which it does a
 * moment after the card docks, and only from inside the view with nothing
 * editable focused, so the rest of a sentence typed as the card docks is not
 * an approval.
 */
describe("<PlanCard> digits", () => {
  const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k, bubbles: true });

  it("approves the row a digit names once its keys are live", () => {
    const { container, onApprove } = mount({ keysActive: true });
    const card = container.querySelector<HTMLElement>(".tl-qcard")!;
    card.focus();
    key(card, "2");
    expect(onApprove).toHaveBeenCalledWith({ number: 2, label: READING.options[1]!.label });
  });

  it("takes no digit before its keys are live", () => {
    const { container, onApprove } = mount({ keysActive: false });
    key(container.querySelector(".tl-qcard")!, "1");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("leaves a digit typed into its own field alone", async () => {
    const { container, onApprove } = mount({ keysActive: true });
    await typeOwn(container, "use");
    key(ownField(container)!, "1");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("takes no digit while an answer is in flight or on a watching device", () => {
    const flying = mount({ keysActive: true, sending: { kind: "option", number: 1 } });
    key(flying.container.querySelector(".tl-qcard")!, "2");
    expect(flying.onApprove).not.toHaveBeenCalled();
    flying.unmount();
    const watching = mount({ keysActive: true, inert: "Watching" });
    key(watching.container.querySelector(".tl-qcard")!, "2");
    expect(watching.onApprove).not.toHaveBeenCalled();
  });

  it("ignores a digit with no row", () => {
    const { container, onApprove } = mount({ keysActive: true });
    key(container.querySelector(".tl-qcard")!, "7");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
