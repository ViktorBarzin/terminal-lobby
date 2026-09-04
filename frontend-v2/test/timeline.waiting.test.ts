/**
 * A turn blocked on the human is not a turn that is working.
 *
 * The timeline draws its live row whenever the last turn carries no turn_end,
 * and a turn_end only comes from an assistant record with a terminal
 * stop_reason. An AskUserQuestion carries stop_reason "tool_use" and its result
 * is not written until somebody answers, so through the whole time the dialog
 * is up the row says "Working…" with a ticking clock over a session where
 * Claude is stopped, waiting on a keypress.
 *
 * Measured 2026-09-04 by replaying the 357 session transcripts on this box
 * through the normalizer: 3,212 windows where the last turn was open and the
 * transcript then went quiet for 60 s or more, 1,562 hours in total, of which
 * 742 windows and 895 hours (57%) were an unreturned AskUserQuestion. The
 * longest single one was 11 h 44 m. This is the largest cause of the row lying,
 * and it is decidable from the transcript alone: the thing that has not come
 * back is a question addressed to the reader.
 *
 * The turn stays open, because it is — answering resumes it — so the Stop
 * button stays reachable (sessionWorking). What changes is what the row says.
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, sessionWorking, type WorkingRow } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const askBody = JSON.stringify({
  questions: [
    {
      question: "Which colour should the badge be?",
      header: "Colour",
      multiSelect: false,
      options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }],
    },
  ],
  count: 1,
});

/** The live row of the last turn. */
const live = (rows: ReturnType<typeof deriveRows>): WorkingRow => {
  const last = rows.at(-1)!;
  expect(last.kind).toBe("working");
  return last as WorkingRow;
};

describe("the live row while the session is blocked on the human", () => {
  it("says it is waiting, not working, while a question has no answer", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "pick one", at: 1000 }),
      ev({ id: 2, kind: "text", body: "I need a decision", at: 2000 }),
      ev({ id: 3, kind: "tool_use", tool: "AskUserQuestion", toolId: "q1", body: askBody, at: 3000 }),
    ]);
    const row = live(rows);
    expect(row.waiting).toBe(true);
    // Nothing is in flight, so the row names no call. It used to fall through
    // to a bare "Working…" here, since a question is a QuestionRow rather than
    // a ToolRow and the scan for the call in flight never found it.
    expect(row.tool).toBeUndefined();
    // The clock counts the WAIT, not the turn: the turn started at 1000.
    expect(row.toolStartedAt).toBe(3000);
    // The turn is still open, so Stop still has something to stop.
    expect(sessionWorking(rows)).toBe(true);
  });

  it("goes back to working the moment the answer lands", () => {
    const answered = deriveRows([
      ev({ id: 1, kind: "user", body: "pick one", at: 1000 }),
      ev({ id: 3, kind: "tool_use", tool: "AskUserQuestion", toolId: "q1", body: askBody, at: 3000 }),
      ev({ id: 4, kind: "tool_result", toolId: "q1", body: "Red", at: 9000 }),
    ]);
    expect(live(answered).waiting).toBeUndefined();
  });

  it("says it is waiting while a plan sits unapproved", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "ExitPlanMode",
        toolId: "p1",
        body: JSON.stringify({ plan: "1. do the thing" }),
        at: 4000,
      }),
    ]);
    expect(live(rows).waiting).toBe(true);
    expect(live(rows).toolStartedAt).toBe(4000);
  });

  it("says it is waiting while a permission request is unanswered", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "delete it", at: 1000 }),
      ev({ id: 2, kind: "permission_request", reqId: "r1", tool: "Bash", body: "rm -rf x", at: 5000 }),
    ]);
    expect(live(rows).waiting).toBe(true);
    // And not once it is decided — the turn carries on by itself from there.
    const decided = deriveRows([
      ev({ id: 1, kind: "user", body: "delete it", at: 1000 }),
      ev({ id: 2, kind: "permission_request", reqId: "r1", tool: "Bash", body: "rm -rf x", at: 5000 }),
      ev({ id: 3, kind: "permission_resolved", reqId: "r1", body: "allow", at: 6000 }),
    ]);
    expect(live(decided).waiting).toBeUndefined();
  });

  it("believes the pane while the transcript has not written the question yet", () => {
    // Two of five consecutive AskUserQuestion calls in one session were written
    // only when the question was ANSWERED, 112 s later in one case (measured
    // 2026-08-28). The pane watcher reports the dialog through that window and
    // the answer card already uses it; the live row has to agree with the card
    // sitting under it.
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "pick one", at: 1000 }),
      ev({ id: 2, kind: "meta", meta: "asking", body: askBody, at: 3000 }),
    ]);
    expect(live(rows).waiting).toBe(true);
  });

  it("lets go of the pane's reading the moment the dialog does", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "pick one", at: 1000 }),
      ev({ id: 2, kind: "meta", meta: "asking", body: askBody, at: 3000 }),
      ev({ id: 3, kind: "meta", meta: "asking", body: "", at: 4000 }),
    ]);
    expect(live(rows).waiting).toBeUndefined();
  });

  it("is working, not waiting, while a call is genuinely in flight", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1000 }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}', at: 2000 }),
    ]);
    const row = live(rows);
    expect(row.waiting).toBeUndefined();
    expect(row.tool).toBe("Bash");
  });

  it("is working again once the human's answer sets Claude going", () => {
    // A question answered, then a real call: the newest unresolved thing wins,
    // so the row must not stay stuck on the question that came before it.
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "pick one", at: 1000 }),
      ev({ id: 2, kind: "tool_use", tool: "AskUserQuestion", toolId: "q1", body: askBody, at: 3000 }),
      ev({ id: 3, kind: "tool_result", toolId: "q1", body: "Red", at: 9000 }),
      ev({ id: 4, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}', at: 9500 }),
    ]);
    expect(live(rows).waiting).toBeUndefined();
    expect(live(rows).tool).toBe("Bash");
  });
});
