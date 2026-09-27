/**
 * The card that answers Claude Code's plan approval, docked above the composer
 * (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows", and open point 10).
 *
 * The card renders one reading and the state its caller holds: which answer is
 * in flight, and what the last reply said. It sends nothing itself. A tap on
 * an option asks the caller to approve with that row, and "Approve with this
 * feedback" asks the caller to send the composer's text with `approve: true`.
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
  const onApproveWithFeedback = vi.fn();
  const onTerminal = vi.fn();
  const r = render(() => (
    <PlanCard
      reading={READING}
      plan={PLAN}
      hasInput={false}
      onApprove={onApprove}
      onApproveWithFeedback={onApproveWithFeedback}
      onTerminal={onTerminal}
      {...over}
    />
  ));
  return { ...r, onApprove, onApproveWithFeedback, onTerminal };
};

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const options = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>(".tl-qcard-option")];
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
    expect(text(container.querySelector(".tl-qcard-title"))).toBe("Claude's plan is ready");
  });

  it("renders the plan as markdown", () => {
    const { container } = mount();
    const plan = container.querySelector(".tl-plancard-plan");
    expect(plan?.querySelector("h1")?.textContent).toBe("Add a size check");
    expect(plan?.querySelector("code")?.textContent).toBe("wc -c");
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

  it("does not draw the feedback row as an option, since the composer is that row", () => {
    const { container } = mount();
    expect(container.textContent).not.toContain("Tell Claude what to change");
    expect(options(container)).toHaveLength(3);
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

  it("has no Reject button", () => {
    const { container } = mount({ hasInput: true });
    expect(button(container, /reject|cancel|no,? /i)).toBeUndefined();
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

describe("<PlanCard> clamps a long plan behind 'Show all'", () => {
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

  it("offers 'Show all' when the plan overflows its clamp, and 'Show less' after", async () => {
    stub(600, 180);
    const { container } = mount();
    // Measured once the plan is laid out, a microtask after it mounts.
    await Promise.resolve();
    const plan = container.querySelector(".tl-plancard-plan")!;
    const toggle = button(container, "Show all");
    expect(toggle).toBeDefined();
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
      <PlanCard
        reading={READING}
        plan={plan()}
        hasInput={false}
        onApprove={() => {}}
        onApproveWithFeedback={() => {}}
      />
    ));
    expect(button(container, "Show all")).toBeUndefined();
    setPlan(PLAN);
    await Promise.resolve();
    expect(button(container, "Show all")).toBeDefined();
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
        <PlanCard
          reading={READING}
          plan={plan()}
          hasInput={false}
          onApprove={() => {}}
          onApproveWithFeedback={() => {}}
        />
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
    expect(button(container, "Show all")).toBeUndefined();
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

describe("<PlanCard> 'Approve with this feedback'", () => {
  /* Found live 2026-09-27 on the Android emulator: with option 1 "Yes, clear
     context (9% used) and use auto mode", the button approved through option 1
     and the context meter went from 9% to 5%. The CLI's Shift+Tab takes option
     1, as the first measured session did too, so the button says it clears the
     context whenever option 1 does. */
  it("says it clears the context when option 1 does", () => {
    const { container } = mount({ hasInput: true });
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    expect(button(container, "Approve with this feedback and clear context")).toBeDefined();
  });

  it("stays plain when option 1 keeps the context", () => {
    const { container } = mount({ reading: NO_AUTO, hasInput: true });
    expect(button(container, "Approve with this feedback")).toBeDefined();
  });

  it("is offered only while the composer holds text", () => {
    const [has, setHas] = createSignal(false);
    const onApproveWithFeedback = vi.fn();
    const { container } = render(() => (
      <PlanCard
        reading={NO_AUTO}
        plan={PLAN}
        hasInput={has()}
        onApprove={() => {}}
        onApproveWithFeedback={onApproveWithFeedback}
      />
    ));
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    setHas(true);
    const approve = button(container, "Approve with this feedback");
    expect(approve).toBeDefined();
    fireEvent.click(approve!);
    expect(onApproveWithFeedback).toHaveBeenCalledTimes(1);
    setHas(false);
    expect(button(container, "Approve with this feedback")).toBeUndefined();
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

  it("says feedback is on its way and holds every choice", () => {
    const { container } = mount({ sending: { kind: "feedback" }, hasInput: true });
    expect(notice(container)).toBe("Sending your feedback…");
    for (const row of options(container)) expect(row.disabled).toBe(true);
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
    const { container } = mount({ notice: "gone", hasInput: true });
    expect(notice(container)).toBe("The plan is no longer waiting in the Terminal.");
    expect(options(container)).toHaveLength(0);
    expect(button(container, "Approve with this feedback")).toBeUndefined();
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
    expect(button(container, "Approve with this feedback")).toBeUndefined();
    fireEvent.click(button(container, "Open Terminal")!);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("<PlanCard> notes about the feedback", () => {
  it("says line breaks become spaces", () => {
    const { container } = mount({ hasInput: true, lineBreaks: true });
    expect(text(container.querySelector(".tl-plancard-lines"))).toBe(
      "Line breaks become spaces, because the Terminal's feedback field is one line.",
    );
  });

  it("has no line-break note otherwise", () => {
    const { container } = mount({ hasInput: true });
    expect(container.querySelector(".tl-plancard-lines")).toBeNull();
  });

  it("says why feedback over 2,000 bytes was not sent", () => {
    const { container } = mount({ hasInput: true, notice: "too-long" });
    expect(notice(container)).toBe(
      "Not sent: the Terminal's feedback field takes up to 2,000 bytes. Shorten it and send again.",
    );
  });
});
