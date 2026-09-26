/**
 * How the record a clear context opens with is drawn.
 *
 * deriveRows turns it into a continuation row (timeline.continuation.test.ts).
 * This file pins what the reader sees
 * (docs/plans/2026-09-24-text-composer-redesign.md, "After clear context"):
 * the "Context cleared · carrying out the plan" marker, the plan as a plan row
 * headed "Plan approved · carrying it out in a fresh context", and the
 * feedback quoted when there was some. The long "Implement the following
 * plan: …" text the CLI wrote is not drawn, and the row stays on screen when
 * the turn under it folds.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { ContinuationRowView } from "../src/components/rows";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { deriveRows, type ContinuationRow } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

// The real record (sessionio/testdata/plan-continuation.jsonl, CLI 2.1.281).
const record = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../sessionio/testdata/plan-continuation.jsonl"),
    "utf8",
  ).split("\n")[0]!,
) as { origin: { kind: string }; planContent: string; message: { content: string } };

const FEEDBACK = "Also print the file size with wc -c.";

const continuationEvent = (feedback?: string): Event => ({
  id: 1,
  kind: "user",
  session: "s",
  turnId: "t1",
  body:
    feedback === undefined
      ? record.message.content
      : `${record.message.content}\n\nUser feedback on this plan: ${feedback}`,
  at: 1000,
  origin: record.origin.kind,
  plan: record.planContent,
});

const inTurn = (e: Omit<Event, "session" | "turnId">): Event => ({
  session: "s",
  turnId: "t1",
  ...e,
});

const work: Event[] = [
  inTurn({ id: 2, kind: "text", body: "Writing hello.txt now.", at: 2000 }),
  inTurn({
    id: 3,
    kind: "tool_use",
    tool: "Write",
    toolId: "w1",
    body: JSON.stringify({ file_path: "/tmp/runF/hello.txt", content: "hi\n" }),
    at: 3000,
  }),
  inTurn({ id: 4, kind: "tool_result", toolId: "w1", body: "File created", at: 4000 }),
  inTurn({ id: 5, kind: "text", body: "Done, hello.txt holds hi.", at: 5000 }),
  inTurn({ id: 6, kind: "turn_end", at: 6000 }),
];

const rowFor = (feedback?: string): ContinuationRow => {
  const row = deriveRows([continuationEvent(feedback)]).find((r) => r.kind === "continuation");
  if (row?.kind !== "continuation") throw new Error("no continuation row");
  return row;
};

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("a continuation row", () => {
  it("opens with the context-cleared marker", () => {
    const { container } = render(() => <ContinuationRowView row={rowFor()} />);
    const row = container.querySelector(".tl-row-continuation")!;
    expect(row.getAttribute("data-eid")).toBe("1");
    expect(text(row.querySelector(".tl-continuation-marker"))).toBe(
      "Context cleared · carrying out the plan",
    );
  });

  it("then shows the plan as a plan row with the fresh-context header", () => {
    const { container } = render(() => <ContinuationRowView row={rowFor()} />);
    const plan = container.querySelector(".tl-row-continuation .tl-row-plan")!;
    expect(plan.getAttribute("data-outcome")).toBe("continuation");
    expect(text(plan.querySelector(".tl-plan-head"))).toBe(
      "Plan approved · carrying it out in a fresh context",
    );
    // Resolved, so folded to its first line behind "Show plan".
    expect(text(plan.querySelector(".tl-plan-summary"))).toBe("Create hello.txt");
    expect(plan.querySelector(".tl-plan-body")).toBeNull();
    fireEvent.click(plan.querySelector(".tl-plan-toggle")!);
    expect(plan.querySelector(".tl-plan-body")?.textContent).toContain("Verify by reading it back");
  });

  it("does not draw the text the CLI wrote on the reader's behalf", () => {
    const { container } = render(() => <ContinuationRowView row={rowFor(FEEDBACK)} />);
    fireEvent.click(container.querySelector(".tl-plan-toggle")!);
    expect(container.textContent).not.toContain("Implement the following plan");
    expect(container.textContent).not.toContain("read the full transcript at");
    expect(container.textContent).not.toContain("User feedback on this plan");
  });

  it("quotes the feedback after the plan when there was some", () => {
    const { container } = render(() => <ContinuationRowView row={rowFor(FEEDBACK)} />);
    const row = container.querySelector(".tl-row-continuation")!;
    const quote = row.querySelector(".tl-continuation-feedback blockquote");
    expect(text(quote)).toBe(FEEDBACK);
    const plan = row.querySelector(".tl-row-plan")!;
    expect(plan.compareDocumentPosition(quote!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("quotes nothing when there was no feedback", () => {
    const { container } = render(() => <ContinuationRowView row={rowFor()} />);
    expect(container.querySelector(".tl-continuation-feedback")).toBeNull();
  });
});

describe("the timeline around a continuation", () => {
  it("keeps the continuation row on screen when the turn folds", () => {
    const { container } = render(() => (
      <MessagesTimeline events={[continuationEvent(FEEDBACK), ...work]} />
    ));
    const cont = container.querySelector(".tl-row-continuation");
    expect(cont).not.toBeNull();
    expect(container.querySelector(".tl-row-user")).toBeNull();
    const fold = container.querySelector(".tl-row-fold")!;
    expect(fold).not.toBeNull();
    expect(cont!.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text(cont!.querySelector(".tl-continuation-feedback blockquote"))).toBe(FEEDBACK);
    expect(container.textContent).toContain("Done, hello.txt holds hi.");
    expect(container.textContent).not.toContain("Implement the following plan");
  });
});
