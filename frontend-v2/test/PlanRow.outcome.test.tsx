/**
 * A plan row says what became of the plan.
 *
 * Until 2026-09-26 a plan row read "awaiting approval" while pending and said
 * nothing once answered, so a plan sent back with feedback read the same as
 * one that was approved. deriveRows now records the outcome
 * (timeline.plan.test.ts); this file pins how the row draws it
 * (docs/plans/2026-09-24-text-composer-redesign.md, "Outcomes in the
 * timeline" and "When the card docks, and what it shows"):
 *
 *  - a header per outcome, and the feedback quoted under "Sent back";
 *  - this client's own answer in flight as "Approving…", "Sending back…" or
 *    "Clearing context…";
 *  - a resolved body collapsed to its first line behind "Show plan";
 *  - while the plan card is docked, the pending row as a one-line stub, so a
 *    long plan is not on screen twice.
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { PlanRowView } from "../src/components/rows";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { PlanOutcome, PlanRow } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const BODY = "# Add a size check\n\n1. Read the file.\n2. Print its size with wc -c.";

const planRow = (outcome: PlanOutcome, body = BODY): PlanRow => ({
  kind: "plan",
  key: "plan-p1",
  id: 1,
  toolId: "p1",
  body,
  pending: outcome.kind === "pending",
  outcome,
  turnKey: "turn-1",
});

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("a pending plan row", () => {
  it("says it is waiting for approval and shows the whole plan", () => {
    const { container } = render(() => <PlanRowView row={planRow({ kind: "pending" })} />);
    expect(text(container.querySelector(".tl-plan-head"))).toBe("Plan waiting for your approval");
    expect(container.textContent).not.toContain("awaiting approval");
    expect(container.querySelector(".tl-plan-body h1")?.textContent).toBe("Add a size check");
    expect(container.textContent).toContain("Print its size with wc -c.");
    expect(container.querySelector(".tl-plan-toggle")).toBeNull();
  });

  it("collapses to one line while the plan card below shows it", () => {
    const { container } = render(() => <PlanRowView row={planRow({ kind: "pending" })} docked />);
    const row = container.querySelector(".tl-row-plan")!;
    expect(row.getAttribute("data-docked")).toBe("true");
    expect(text(row.querySelector(".tl-plan-head"))).toBe(
      "Plan waiting for your approval · shown below",
    );
    expect(row.querySelector(".tl-plan-body")).toBeNull();
    expect(row.textContent).not.toContain("Print its size");
  });
});

describe("a resolved plan row's header", () => {
  it.each<[string, PlanOutcome, string]>([
    ["approved in auto mode", { kind: "approved", mode: "auto" }, "Plan approved · auto mode"],
    [
      "approved, each edit by hand",
      { kind: "approved", mode: "default" },
      "Plan approved · you approve each edit",
    ],
    [
      "approved with edits accepted",
      { kind: "approved", mode: "acceptEdits" },
      "Plan approved · accept edits",
    ],
    ["approved before the mode record lands", { kind: "approved" }, "Plan approved"],
    ["rejected", { kind: "rejected" }, "Plan rejected"],
    ["never answered", { kind: "superseded" }, "Plan not answered"],
  ])("reads right when %s", (_name, outcome, header) => {
    const { container } = render(() => <PlanRowView row={planRow(outcome)} />);
    const head = container.querySelector(".tl-plan-head")!;
    expect(text(head)).toBe(header);
    expect(head.querySelector(".tl-plan-outcome")?.getAttribute("data-outcome")).toBe(outcome.kind);
    expect(container.textContent).not.toContain("waiting for your approval");
  });

  it("quotes the feedback under a plan sent back", () => {
    const feedback = "Also add a third step that prints the file size with wc -c.";
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "sent-back", feedback })} />
    ));
    expect(text(container.querySelector(".tl-plan-head"))).toBe("Sent back with feedback");
    const quote = container.querySelector("blockquote.tl-plan-feedback");
    expect(quote?.textContent).toBe(feedback);
  });

  it("does not draw an empty quote when the feedback could not be read", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "sent-back", feedback: "" })} />
    ));
    expect(container.querySelector(".tl-plan-feedback")).toBeNull();
  });
});

describe("this client's own answer in flight", () => {
  it.each<[PlanOutcome, "approve" | "feedback" | "clear", string]>([
    [{ kind: "pending" }, "approve", "Approving…"],
    [{ kind: "pending" }, "feedback", "Sending back…"],
    [{ kind: "pending" }, "clear", "Clearing context…"],
    // The old transcript records a clear as a rejection; the answering client
    // knows better until the stream switches.
    [{ kind: "rejected" }, "clear", "Clearing context…"],
  ])("from %o, %s reads %s", (outcome, transient, header) => {
    const { container } = render(() => (
      <PlanRowView row={planRow(outcome)} transient={transient} />
    ));
    expect(text(container.querySelector(".tl-plan-head"))).toBe(header);
    expect(container.querySelector(".tl-plan-outcome")?.getAttribute("data-outcome")).toBe(
      "transient",
    );
  });

  it("gives way to the transcript's outcome once it lands", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "approved", mode: "auto" })} transient="approve" />
    ));
    expect(text(container.querySelector(".tl-plan-head"))).toBe("Plan approved · auto mode");
  });

  it("wins over the docked stub, since the card undocks when the answer applies", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "pending" })} docked transient="approve" />
    ));
    expect(text(container.querySelector(".tl-plan-head"))).toBe("Approving…");
    expect(container.textContent).not.toContain("shown below");
  });
});

describe("a resolved plan's body", () => {
  it("collapses to its first line behind Show plan", async () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "approved", mode: "auto" })} />
    ));
    const summary = container.querySelector(".tl-plan-summary");
    expect(summary?.textContent).toBe("Add a size check");
    expect(container.textContent).not.toContain("Print its size");

    const toggle = container.querySelector<HTMLButtonElement>(".tl-plan-toggle")!;
    expect(toggle.textContent).toBe("Show plan");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(container.textContent).toContain("Print its size with wc -c.");
    expect(container.querySelector(".tl-plan-summary")).toBeNull();
    expect(toggle.textContent).toBe("Hide plan");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(container.textContent).not.toContain("Print its size");
  });

  it("collapses while this client's answer is in flight too", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "pending" })} transient="feedback" />
    ));
    expect(container.querySelector(".tl-plan-summary")?.textContent).toBe("Add a size check");
    expect(container.textContent).not.toContain("Print its size");
  });

  it("skips blank leading lines and markdown markers when picking the first line", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "rejected" }, "\n\n## **Plan:** tidy the logs\n\nstep")} />
    ));
    expect(container.querySelector(".tl-plan-summary")?.textContent).toBe("Plan: tidy the logs");
  });

  it("needs no toggle when the plan is one line", () => {
    const { container } = render(() => (
      <PlanRowView row={planRow({ kind: "rejected" }, "Rename the flag.")} />
    ));
    expect(container.querySelector(".tl-plan-summary")?.textContent).toBe("Rename the flag.");
    expect(container.querySelector(".tl-plan-toggle")).toBeNull();
  });

  /* Found live 2026-09-27: a plan written as one long paragraph folded to a
     line cut off with an ellipsis, and no toggle, since the plan had only one
     line. On a 412px phone that hid most of the plan for good. The row now
     offers Show plan whenever the folded line does not fit its box. */
  it("offers Show plan when a one-line plan is cut off", async () => {
    const proto = HTMLElement.prototype;
    const saved = (["scrollWidth", "clientWidth"] as const).map(
      (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
    );
    Object.defineProperty(proto, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("tl-plan-summary") ? 900 : 0;
      },
    });
    Object.defineProperty(proto, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("tl-plan-summary") ? 380 : 0;
      },
    });
    try {
      const para =
        "Delete the empty file /var/tmp/ql-r4/work/go with rm, then list the directory to confirm it is gone and nothing else moved.";
      const { container } = render(() => (
        <PlanRowView row={planRow({ kind: "approved", mode: "auto" }, para)} />
      ));
      await Promise.resolve();
      const toggle = container.querySelector<HTMLButtonElement>(".tl-plan-toggle");
      expect(toggle?.textContent).toBe("Show plan");
      fireEvent.click(toggle!);
      expect(container.querySelector(".tl-plan-body")?.textContent).toContain(
        "nothing else moved.",
      );
      expect(toggle!.textContent).toBe("Hide plan");
      fireEvent.click(toggle!);
      expect(container.querySelector(".tl-plan-summary")).not.toBeNull();
      expect(container.querySelector(".tl-plan-toggle")?.textContent).toBe("Show plan");
    } finally {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(proto, k, d);
        else delete (proto as unknown as Record<string, unknown>)[k];
      }
    }
  });
});

describe("the timeline hands a plan row its dock and answer state", () => {
  const events: Event[] = [
    { id: 1, session: "s", kind: "user", body: "plan it" },
    {
      id: 2,
      session: "s",
      kind: "tool_use",
      tool: "ExitPlanMode",
      toolId: "p1",
      body: JSON.stringify({ plan: BODY }),
    },
  ];

  it("stubs the row whose call the card has docked", () => {
    const { container } = render(() => <MessagesTimeline events={events} planDocked="p1" />);
    expect(text(container.querySelector(".tl-row-plan .tl-plan-head"))).toBe(
      "Plan waiting for your approval · shown below",
    );
  });

  it("leaves another call's row whole", () => {
    const { container } = render(() => <MessagesTimeline events={events} planDocked="p0" />);
    expect(text(container.querySelector(".tl-row-plan .tl-plan-head"))).toBe(
      "Plan waiting for your approval",
    );
  });

  it("never stubs a call without an id when nothing is docked", () => {
    const bare: Event[] = [events[0]!, { ...events[1]!, toolId: undefined }];
    const { container } = render(() => <MessagesTimeline events={bare} planDocked={null} />);
    expect(text(container.querySelector(".tl-row-plan .tl-plan-head"))).toBe(
      "Plan waiting for your approval",
    );
  });

  it("shows this client's answer on the row it answered", () => {
    const { container } = render(() => (
      <MessagesTimeline events={events} planAnswer={{ toolId: "p1", action: "clear" }} />
    ));
    expect(text(container.querySelector(".tl-row-plan .tl-plan-head"))).toBe("Clearing context…");
  });
});
