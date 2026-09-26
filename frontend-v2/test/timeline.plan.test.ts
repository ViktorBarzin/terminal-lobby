/**
 * What became of a plan put up for approval.
 *
 * The outcome is read where a tool_result resolves the pending ExitPlanMode
 * call, from the result's text, its error flag and `toolUseResult`
 * (docs/plans/2026-09-24-text-composer-redesign.md, "Outcomes in the
 * timeline"). The result bodies below are copied from real transcripts: the
 * plan probes run on this box on 2026-09-24 (plan-probe runB for an approval,
 * runD for feedback, runA for Esc, runE for a plan written in the same message
 * as the call that presents it).
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import {
  deriveRows,
  planHeader,
  shownPlanOutcome,
  type PlanOutcome,
  type PlanRow,
  type TimelineRow,
} from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const PLAN_PATH = "/home/wizard/.claude/plans/plan-how-to-create-agile-llama.md";

const INPUT_PLAN =
  "# Create hello.txt\n\n## Plan\n\n1. Write `hello.txt` with `hi`.\n2. Verify with `cat hello.txt`.\n";

const planUse = (id: number, toolId: string, plan = INPUT_PLAN): Event =>
  ev({
    id,
    kind: "tool_use",
    tool: "ExitPlanMode",
    toolId,
    body: JSON.stringify({ plan, planFilePath: PLAN_PATH }),
    at: id * 1000,
  });

// plan-probe runB, 2026-09-24: the result text and toolUseResult of option 1.
const APPROVED_BODY =
  "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n" +
  `Your plan has been saved to: ${PLAN_PATH}\n` +
  "You can refer back to it if needed during implementation.\n\n" +
  "If this plan can be broken down into multiple independent tasks, consider spawning named teammates with the Agent tool (pass a `name`) to parallelize the work.\n\n" +
  `## Approved Plan:\n${INPUT_PLAN}`;

// plan-probe runD: Esc-free rejection with feedback typed into the dialog.
const SENT_BACK_BODY =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nAlso add a third step that prints the file size with wc -c.";

// plan-probe runA: Esc on the dialog. The old transcript's side of a clear
// context records the same text.
const REJECTED_BODY =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const approvedResult = (id: number, toolId: string, plan = INPUT_PLAN): Event =>
  ev({
    id,
    kind: "tool_result",
    toolId,
    body: APPROVED_BODY,
    result: { plan, isAgent: false, filePath: PLAN_PATH, hasTaskTool: true },
    at: id * 1000,
  });

const modeMeta = (id: number, mode: string): Event =>
  ev({ id, kind: "meta", meta: "permission-mode", body: mode, at: id * 1000 });

/** Every plan row, folded or not. */
const plans = (rows: TimelineRow[]): PlanRow[] =>
  rows
    .flatMap((r) => (r.kind === "turn-fold" ? r.hidden : [r]))
    .filter((r): r is PlanRow => r.kind === "plan");

const onlyPlan = (events: Event[]): PlanRow => {
  const found = plans(deriveRows(events));
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("a plan row's outcome, from the result that resolves it", () => {
  it("is pending while the call has no result and nothing followed it", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
    ]);
    expect(row.outcome).toEqual({ kind: "pending" });
    expect(row.pending).toBe(true);
    expect(row.body).toBe(INPUT_PLAN);
  });

  it("is approved on a result starting 'User has approved your plan'", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      approvedResult(3, "p1"),
    ]);
    expect(row.outcome).toEqual({ kind: "approved" });
    expect(row.pending).toBe(false);
  });

  it.each([
    ["auto", "Plan approved · auto mode"],
    ["default", "Plan approved · you approve each edit"],
    ["manual", "Plan approved · you approve each edit"],
    ["acceptEdits", "Plan approved · accept edits"],
  ])("takes its mode from the next permission-mode record (%s)", (mode, header) => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      modeMeta(2, "plan"),
      planUse(3, "p1"),
      approvedResult(4, "p1"),
      modeMeta(5, mode),
      ev({ id: 6, kind: "text", body: "Writing it now.", at: 6000 }),
    ]);
    expect(row.outcome).toEqual({ kind: "approved", mode });
    expect(planHeader(row.outcome)).toBe(header);
  });

  it("reads plain 'Plan approved' until the permission-mode record arrives", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      // The mode in force while planning is not the mode the approval chose.
      modeMeta(2, "plan"),
      planUse(3, "p1"),
      approvedResult(4, "p1"),
    ]);
    expect(planHeader(row.outcome)).toBe("Plan approved");
  });

  it("does not take a mode from a later turn", () => {
    const inTurn = (turnId: string, e: Event): Event => ({ ...e, turnId });
    const rows = deriveRows([
      inTurn("t1", ev({ id: 1, kind: "user", body: "plan it", at: 1000 })),
      inTurn("t1", planUse(2, "p1")),
      inTurn("t1", approvedResult(3, "p1")),
      inTurn("t1", ev({ id: 4, kind: "turn_end", at: 4000 })),
      inTurn("t2", ev({ id: 5, kind: "user", body: "next", at: 5000 })),
      inTurn("t2", modeMeta(6, "auto")),
    ]);
    expect(plans(rows)[0]!.outcome).toEqual({ kind: "approved" });
  });

  it("counts a result with no error flag as approved even if the wording changes", () => {
    // Every refusal measured carries the error flag, and no approval does.
    const row = onlyPlan([
      planUse(1, "p1"),
      ev({
        id: 2,
        kind: "tool_result",
        toolId: "p1",
        body: "Plan accepted. Go ahead.",
        result: { plan: INPUT_PLAN },
      }),
    ]);
    expect(row.outcome).toEqual({ kind: "approved" });
  });

  it("is sent back on an error carrying the user's words, with the feedback extracted", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      ev({
        id: 3,
        kind: "tool_result",
        toolId: "p1",
        isError: true,
        body: SENT_BACK_BODY,
        result: `Error: ${SENT_BACK_BODY}`,
        at: 3000,
      }),
    ]);
    expect(row.outcome).toEqual({
      kind: "sent-back",
      feedback: "Also add a third step that prints the file size with wc -c.",
    });
    expect(planHeader(row.outcome)).toBe("Sent back with feedback");
    expect(row.pending).toBe(false);
  });

  it("finds the feedback in toolUseResult when the text is missing", () => {
    const row = onlyPlan([
      planUse(1, "p1"),
      ev({
        id: 2,
        kind: "tool_result",
        toolId: "p1",
        isError: true,
        result: `Error: ${SENT_BACK_BODY}`,
      }),
    ]);
    expect(row.outcome).toEqual({
      kind: "sent-back",
      feedback: "Also add a third step that prints the file size with wc -c.",
    });
  });

  it("is rejected on any other error: Esc, an empty feedback row, a clear", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      ev({
        id: 3,
        kind: "tool_result",
        toolId: "p1",
        isError: true,
        body: REJECTED_BODY,
        result: "User rejected tool use",
        at: 3000,
      }),
    ]);
    expect(row.outcome).toEqual({ kind: "rejected" });
    expect(planHeader(row.outcome)).toBe("Plan rejected");
  });

  it("is superseded when it has no result and a newer row exists", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      ev({ id: 3, kind: "text", body: "Something else came up.", at: 3000 }),
    ]);
    expect(row.outcome).toEqual({ kind: "superseded" });
    expect(row.pending).toBe(false);
    expect(planHeader(row.outcome)).toBe("Plan not answered");
  });

  it("is superseded when it has no result and its turn has settled", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      ev({ id: 2, kind: "text", body: "Here is the plan.", at: 2000 }),
      planUse(3, "p1"),
      ev({ id: 4, kind: "user", body: "never mind", at: 4000 }),
    ]);
    const row = plans(rows)[0]!;
    expect(row.outcome).toEqual({ kind: "superseded" });
    expect(row.pending).toBe(false);
  });

  it("keeps each of two plans in one turn apart", () => {
    const found = plans(
      deriveRows([
        ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
        planUse(2, "p1"),
        ev({
          id: 3,
          kind: "tool_result",
          toolId: "p1",
          isError: true,
          body: SENT_BACK_BODY,
          at: 3000,
        }),
        planUse(4, "p2", `${INPUT_PLAN}3. Print the size with wc -c.\n`),
      ]),
    );
    expect(found.map((r) => r.outcome.kind)).toEqual(["sent-back", "pending"]);
  });
});

describe("an approved row's body", () => {
  it("is toolUseResult.plan, so an edit made with ctrl+g shows", () => {
    const edited = `${INPUT_PLAN}3. Edited in the CLI.\n`;
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      approvedResult(3, "p1", edited),
    ]);
    expect(row.body).toBe(edited);
  });

  it("falls back to input.plan when the result was pruned for the wire", () => {
    // sessionio drops a structured result over MaxInlineResult (8 KiB) whole
    // and marks the event truncated.
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      planUse(2, "p1"),
      ev({
        id: 3,
        kind: "tool_result",
        toolId: "p1",
        body: APPROVED_BODY,
        truncated: true,
        at: 3000,
      }),
    ]);
    expect(row.outcome.kind).toBe("approved");
    expect(row.body).toBe(INPUT_PLAN);
  });

  it("keeps the input as the body of a plan that was sent back", () => {
    const row = onlyPlan([
      planUse(1, "p1"),
      ev({ id: 2, kind: "tool_result", toolId: "p1", isError: true, body: SENT_BACK_BODY }),
    ]);
    expect(row.body).toBe(INPUT_PLAN);
  });
});

describe("a plan written in the same message as the call that presents it", () => {
  // plan-probe runE, 2026-09-24: Claude wrote the plan file and called
  // ExitPlanMode in one message. The call's input held the OLD file, while the
  // dialog drew, and the approval carried, the new one. The transcript orders
  // it: Write call, ExitPlanMode call, Write result, ExitPlanMode result.
  const NEW_PLAN = "1. Create the 70 files with one loop.\n2. Verify with ls | wc -l.\n";
  const OLD_PLAN = "1. Create f01.txt containing 1\n2. Create f02.txt containing 2\n";

  const write = (id: number, toolId: string, content: string, filePath = PLAN_PATH): Event =>
    ev({
      id,
      kind: "tool_use",
      tool: "Write",
      toolId,
      body: JSON.stringify({ file_path: filePath, content }),
      at: id * 1000,
    });
  const edit = (id: number, toolId: string, oldString: string, newString: string): Event =>
    ev({
      id,
      kind: "tool_use",
      tool: "Edit",
      toolId,
      body: JSON.stringify({
        replace_all: false,
        file_path: PLAN_PATH,
        old_string: oldString,
        new_string: newString,
      }),
      at: id * 1000,
    });
  const done = (id: number, toolId: string, isError = false): Event =>
    ev({
      id,
      kind: "tool_result",
      toolId,
      body: isError ? "String to replace not found" : "ok",
      isError,
      at: id * 1000,
    });

  it("shows the Write's content when its result lands after the call", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      write(2, "w1", NEW_PLAN),
      planUse(3, "p1", OLD_PLAN),
      done(4, "w1"),
    ]);
    expect(row.body).toBe(NEW_PLAN);
    expect(row.stale).toBeUndefined();
    expect(row.outcome).toEqual({ kind: "pending" });
  });

  it("applies an Edit whose old text occurs once", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      edit(
        2,
        "e1",
        "2. Create f02.txt containing 2\n",
        "2. Create f02.txt containing 2\n3. Count them.\n",
      ),
      planUse(3, "p1", OLD_PLAN),
      done(4, "e1"),
    ]);
    expect(row.body).toBe(`${OLD_PLAN}3. Count them.\n`);
    expect(row.stale).toBeUndefined();
  });

  it.each([
    ["does not occur", "5. Not in the plan\n"],
    ["occurs twice", "Create f0"],
  ])("keeps the input and flags it when the Edit's old text %s", (_, oldString) => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      edit(2, "e1", oldString, "changed"),
      planUse(3, "p1", OLD_PLAN),
      done(4, "e1"),
    ]);
    expect(row.body).toBe(OLD_PLAN);
    expect(row.stale).toBe(true);
  });

  it("applies a replace_all Edit wherever its old text occurs", () => {
    const row = onlyPlan([
      ev({
        id: 1,
        kind: "tool_use",
        tool: "Edit",
        toolId: "e1",
        body: JSON.stringify({
          replace_all: true,
          file_path: PLAN_PATH,
          old_string: "Create",
          new_string: "Make",
        }),
      }),
      planUse(2, "p1", OLD_PLAN),
      done(3, "e1"),
    ]);
    expect(row.body).toBe("1. Make f01.txt containing 1\n2. Make f02.txt containing 2\n");
    expect(row.stale).toBeUndefined();
  });

  it("drops the stale flag once the approval carries the plan, and keeps it when that was pruned", () => {
    const events = [
      edit(1, "e1", "nowhere in the plan", "x"),
      planUse(2, "p1", OLD_PLAN),
      done(3, "e1"),
    ];
    const carried = onlyPlan([...events, approvedResult(4, "p1", "the approved text")]);
    expect(carried.body).toBe("the approved text");
    expect(carried.stale).toBeUndefined();
    const pruned = onlyPlan([
      ...events,
      ev({ id: 4, kind: "tool_result", toolId: "p1", body: APPROVED_BODY, truncated: true }),
    ]);
    expect(pruned.body).toBe(OLD_PLAN);
    expect(pruned.stale).toBe(true);
  });

  it("ignores a Write whose result landed before the call, the usual order", () => {
    const row = onlyPlan([
      ev({ id: 1, kind: "user", body: "plan it", at: 1000 }),
      write(2, "w1", NEW_PLAN),
      done(3, "w1"),
      planUse(4, "p1", OLD_PLAN),
    ]);
    expect(row.body).toBe(OLD_PLAN);
  });

  it("ignores a Write to another file", () => {
    const row = onlyPlan([
      write(1, "w1", "hi\n", "/tmp/hello.txt"),
      planUse(2, "p1", OLD_PLAN),
      done(3, "w1"),
    ]);
    expect(row.body).toBe(OLD_PLAN);
    expect(row.stale).toBeUndefined();
  });

  it("ignores a Write that failed", () => {
    const row = onlyPlan([
      write(1, "w1", NEW_PLAN),
      planUse(2, "p1", OLD_PLAN),
      done(3, "w1", true),
    ]);
    expect(row.body).toBe(OLD_PLAN);
    expect(row.stale).toBeUndefined();
  });

  it("keeps the corrected text on a rejected row", () => {
    const row = onlyPlan([
      write(1, "w1", NEW_PLAN),
      planUse(2, "p1", OLD_PLAN),
      done(3, "w1"),
      ev({ id: 4, kind: "tool_result", toolId: "p1", isError: true, body: REJECTED_BODY }),
    ]);
    expect(row.outcome).toEqual({ kind: "rejected" });
    expect(row.body).toBe(NEW_PLAN);
  });

  it("falls back to the corrected text, not the stale input, when an approval was pruned", () => {
    const row = onlyPlan([
      write(1, "w1", NEW_PLAN),
      planUse(2, "p1", OLD_PLAN),
      done(3, "w1"),
      ev({ id: 4, kind: "tool_result", toolId: "p1", body: APPROVED_BODY, truncated: true }),
    ]);
    expect(row.body).toBe(NEW_PLAN);
  });
});

describe("the transient state this client's own answer puts on a row", () => {
  const pending = (): PlanRow =>
    onlyPlan([ev({ id: 1, kind: "user", body: "plan it", at: 1000 }), planUse(2, "p1")]);

  it.each([
    ["approve", "Approving…"],
    ["feedback", "Sending back…"],
    ["clear", "Clearing context…"],
  ] as const)("shows %s while the result is not written yet", (action, header) => {
    const shown = shownPlanOutcome(pending(), action);
    expect(shown).toEqual({ kind: "transient", action });
    expect(planHeader(shown)).toBe(header);
  });

  it("gives way to the transcript's result once it lands", () => {
    const row = onlyPlan([planUse(1, "p1"), approvedResult(2, "p1"), modeMeta(3, "auto")]);
    expect(shownPlanOutcome(row, "approve")).toEqual({ kind: "approved", mode: "auto" });
  });

  it("covers the rejection the old transcript records for a clear", () => {
    const row = onlyPlan([
      planUse(1, "p1"),
      ev({ id: 2, kind: "tool_result", toolId: "p1", isError: true, body: REJECTED_BODY }),
    ]);
    expect(shownPlanOutcome(row, "clear")).toEqual({ kind: "transient", action: "clear" });
    // An approval or feedback in flight does not hide a rejection.
    expect(shownPlanOutcome(row, "approve")).toEqual({ kind: "rejected" });
  });

  it("is the row's own outcome when the caller has nothing in flight", () => {
    const row = pending();
    expect(shownPlanOutcome(row, undefined)).toBe(row.outcome);
  });

  it("names every outcome", () => {
    const all: PlanOutcome[] = [
      { kind: "pending" },
      { kind: "approved" },
      { kind: "sent-back", feedback: "x" },
      { kind: "rejected" },
      { kind: "superseded" },
      { kind: "transient", action: "approve" },
    ];
    for (const o of all) expect(planHeader(o)).not.toBe("");
  });
});
