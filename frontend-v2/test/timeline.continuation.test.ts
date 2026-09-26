/**
 * The first record after the plan approval clears the context.
 *
 * Approving a plan with "clear context" starts a new conversation whose first
 * user record the CLI writes, not the reader: "Implement the following plan:"
 * and the plan, the old transcript's path, a line about teammates, and
 * "User feedback on this plan: <text>" when the approval carried feedback.
 * sessionio marks that record's user event with `origin` and `plan`
 * (normalize.go). The Text view draws it as a continuation row in the turn's
 * user-row slot rather than as a long message the reader never typed
 * (docs/plans/2026-09-24-text-composer-redesign.md, "After clear context").
 *
 * The record below is the real one, read from sessionio's capture
 * (testdata/plan-continuation.jsonl, CLI 2.1.281, 2026-09-24). sessionio has
 * no capture of the with-feedback variant, so that case appends the feedback
 * line the way CLI 2.1.283 writes it: two newlines, then
 * "User feedback on this plan: " and the text, after everything else. That
 * shape was checked on 2026-09-26 against a real "approve with this feedback"
 * in a scratch session.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { ORIGIN_AUTO_CONTINUATION, type Event } from "../src/types/events";
import {
  deriveRows,
  planHeader,
  type ContinuationRow,
  type TimelineRow,
} from "../src/components/timeline.logic";

interface ContinuationRecord {
  timestamp: string;
  origin: { kind: string };
  planContent: string;
  message: { content: string };
}

const record = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../sessionio/testdata/plan-continuation.jsonl"),
    "utf8",
  ).split("\n")[0]!,
) as ContinuationRecord;

const FEEDBACK = "Also print the file size with wc -c.";
const WITH_FEEDBACK = `${record.message.content}\n\nUser feedback on this plan: ${FEEDBACK}`;

/** The user event normalize.go makes of the record. */
const continuationEvent = (body = record.message.content): Event => ({
  id: 1,
  kind: "user",
  session: "s",
  turnId: "t1",
  body,
  at: Date.parse(record.timestamp),
  origin: record.origin.kind,
  plan: record.planContent,
});

const at0 = Date.parse(record.timestamp);
const inTurn = (e: Omit<Event, "session" | "turnId">): Event => ({
  session: "s",
  turnId: "t1",
  ...e,
});

/** The work Claude does on the plan: a message, a Write, a closing message. */
const work: Event[] = [
  inTurn({ id: 2, kind: "text", body: "Writing hello.txt now.", at: at0 + 1000 }),
  inTurn({
    id: 3,
    kind: "tool_use",
    tool: "Write",
    toolId: "w1",
    body: JSON.stringify({ file_path: "/tmp/runF/hello.txt", content: "hi\n" }),
    at: at0 + 2000,
  }),
  inTurn({ id: 4, kind: "tool_result", toolId: "w1", body: "File created", at: at0 + 3000 }),
  inTurn({ id: 5, kind: "text", body: "Done: `hello.txt` holds `hi`.", at: at0 + 4000 }),
  inTurn({ id: 6, kind: "turn_end", at: at0 + 5000 }),
];

/** The row kinds, without the working row an open turn ends with. */
const kinds = (rows: TimelineRow[]): string[] =>
  rows.map((r) => r.kind).filter((k) => k !== "working");

const continuations = (rows: TimelineRow[]): ContinuationRow[] =>
  rows.filter((r): r is ContinuationRow => r.kind === "continuation");

describe("the record a clear context opens with", () => {
  it("is the capture the server marks", () => {
    // Guards the fixture: if the capture changes shape, the tests below would
    // otherwise pass against something that is no longer the real record.
    expect(record.origin.kind).toBe(ORIGIN_AUTO_CONTINUATION);
    expect(record.message.content.startsWith("Implement the following plan:")).toBe(true);
    expect(record.planContent.startsWith("# Create hello.txt")).toBe(true);
  });

  it("becomes a continuation row, not a user row", () => {
    const rows = deriveRows([continuationEvent()]);
    expect(rows.filter((r) => r.kind === "user")).toHaveLength(0);
    const [row] = continuations(rows);
    expect(row).toBeDefined();
    expect(row!.key).toBe("continuation-1");
    expect(row!.id).toBe(1);
    expect(row!.turnKey).toBe("t1");
    expect(row!.at).toBe(at0);
  });

  it("carries the plan as a plan row headed 'carrying it out in a fresh context'", () => {
    const [row] = continuations(deriveRows([continuationEvent()]));
    expect(row!.plan.kind).toBe("plan");
    expect(row!.plan.body).toBe(record.planContent);
    expect(row!.plan.pending).toBe(false);
    expect(row!.plan.outcome).toEqual({ kind: "continuation" });
    expect(planHeader(row!.plan.outcome)).toBe(
      "Plan approved · carrying it out in a fresh context",
    );
  });

  it("does not carry the long 'Implement the following plan' text anywhere", () => {
    const rows = deriveRows([continuationEvent()]);
    expect(JSON.stringify(rows)).not.toContain("Implement the following plan");
    expect(JSON.stringify(rows)).not.toContain("read the full transcript at");
  });

  it("has no feedback when the approval carried none", () => {
    const [row] = continuations(deriveRows([continuationEvent()]));
    expect(row!.feedback).toBe("");
  });

  it("quotes the feedback when the body ends with 'User feedback on this plan'", () => {
    const [row] = continuations(deriveRows([continuationEvent(WITH_FEEDBACK)]));
    expect(row!.feedback).toBe(FEEDBACK);
    expect(row!.plan.body).toBe(record.planContent);
  });

  it("does not take a plan that quotes the feedback line for the feedback", () => {
    // Only what follows the plan is the reader's feedback; a plan that mentions
    // the phrase is still just the plan.
    const plan = "# Parse the continuation\n\nMatch `User feedback on this plan: x` in the body.\n";
    const body = `Implement the following plan:\n\n${plan}\n\nIf you need specific details, read the full transcript at: /x.jsonl`;
    const [row] = continuations(deriveRows([{ ...continuationEvent(body), plan }]));
    expect(row!.feedback).toBe("");
  });

  it("stays in the user-row slot when the turn folds", () => {
    const rows = deriveRows([continuationEvent(WITH_FEEDBACK), ...work]);
    expect(rows.map((r) => r.kind)).toEqual(["continuation", "turn-fold", "message"]);
    const fold = rows.find((r) => r.kind === "turn-fold");
    expect(fold?.kind === "turn-fold" && fold.hidden.some((r) => r.kind === "user")).toBe(false);
    const [row] = continuations(rows);
    expect(row!.feedback).toBe(FEEDBACK);
  });

  it("leaves a typed prompt a user row", () => {
    const typed: Event = { id: 1, kind: "user", session: "s", body: "say ok" };
    expect(kinds(deriveRows([typed]))).toEqual(["user"]);
  });

  it("leaves a user event a user row when the origin comes without a plan", () => {
    // The server sets both or neither; a half-marked event is drawn as sent.
    const half: Event = { ...continuationEvent(), plan: "" };
    const rows = deriveRows([half]);
    expect(kinds(rows)).toEqual(["user"]);
    expect(rows[0]!.kind === "user" && rows[0]!.body).toBe(record.message.content);
  });
});
