/**
 * The live group at the end of the conversation: what it says while a turn is
 * open, as one pure function (docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * The T3 pass retires the composer's status line. The session's state moves
 * into the conversation: the running work group names the call in flight and
 * counts what is done, and before the first call a row in the same place says
 * "Working…". The precedence is the status line's, ported: a context clear
 * this device started, then the open turn (waiting when Claude is stopped on
 * the reader, working otherwise), then nothing. Watching no longer hides the
 * state, since a device that only watches still wants to see progress.
 */
import { describe, it, expect } from "vitest";
import {
  deriveRows,
  liveGroupState,
  liveRow,
  shortTarget,
  type TimelineRow,
  type WorkGroupRow,
  type WorkingRow,
} from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const row = (over: Partial<WorkingRow> = {}): WorkingRow => ({
  kind: "working",
  key: "working-t1",
  turnKey: "t1",
  steps: 3,
  ...over,
});

const bash = (id: number, toolId: string, command: string, at: number): Event =>
  ev({ id, kind: "tool_use", tool: "Bash", toolId, body: JSON.stringify({ command }), at });

/** The rows the timeline draws: everything but the working marker. */
const drawn = (rows: TimelineRow[]) => rows.filter((r) => r.kind !== "working");

describe("liveGroupState", () => {
  it("says nothing while no turn is open", () => {
    expect(liveGroupState({})).toEqual({ kind: "idle" });
  });

  it("says Claude is working before the first call, counting from the turn's start", () => {
    const live = row({ startedAt: 1_000 });
    expect(liveGroupState({ live })).toEqual({ kind: "working", done: 0, since: 1_000 });
  });

  it("names a call in flight that has no group of its own", () => {
    // A TodoWrite in flight is a todo row, not a group, so the live row stands
    // alone and still says what runs.
    const live = row({
      tool: "TodoWrite",
      toolLabel: "3 todos",
      startedAt: 1_000,
      toolStartedAt: 5_000,
    });
    expect(liveGroupState({ live })).toEqual({
      kind: "working",
      tool: "TodoWrite",
      label: "3 todos",
      done: 0,
      since: 5_000,
    });
  });

  it("puts the state on the running group at the end, with its call and count", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "ls", 2_000),
      ev({ id: 3, kind: "tool_result", toolId: "b1", body: "a", at: 2_500 }),
      bash(4, "b2", "sleep 6 && echo b", 3_000),
    ]);
    const group = drawn(rows).at(-1) as WorkGroupRow;
    expect(group.kind).toBe("work-group");
    expect(liveGroupState({ live: liveRow(rows), last: group })).toEqual({
      kind: "working",
      tool: "Bash",
      label: "sleep 6 && echo b",
      done: 1,
      since: 2_000,
      groupKey: group.key,
    });
  });

  it("leaves a group from another turn alone", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "ls", 2_000),
    ]);
    const group = drawn(rows).at(-1) as WorkGroupRow;
    const s = liveGroupState({ live: row({ turnKey: "other", startedAt: 9_000 }), last: group });
    expect(s).toEqual({ kind: "working", done: 0, since: 9_000 });
  });

  it("says Claude is waiting while it is stopped on the reader, timed from the wait", () => {
    const live = row({ waiting: true, startedAt: 1_000, toolStartedAt: 3_000 });
    expect(liveGroupState({ live })).toEqual({ kind: "waiting", since: 3_000 });
  });

  it("waits on the running group when a permission prompt holds its call", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "b1", "rm -rf x", 2_000),
    ]);
    const group = drawn(rows).at(-1) as WorkGroupRow;
    const live = { ...liveRow(rows)!, waiting: true };
    expect(liveGroupState({ live, last: group })).toEqual({
      kind: "waiting",
      since: 2_000,
      groupKey: group.key,
    });
  });

  // This device approved the plan with an option that clears the context. The
  // old transcript closes its turn and the new one has not arrived, so the
  // live row says what is happening in between.
  it("puts a context clear this device started ahead of the turn", () => {
    expect(liveGroupState({ live: row(), clearing: true })).toEqual({ kind: "clearing" });
    expect(liveGroupState({ clearing: true })).toEqual({ kind: "clearing" });
  });
});

describe("liveRow", () => {
  it("finds the open turn's working row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "b1", body: '{"command":"ls"}' }),
    ]);
    const live = liveRow(rows);
    expect(live?.kind).toBe("working");
    expect(live?.tool).toBe("Bash");
  });

  it("finds nothing once the turn has ended", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "text", body: "done" }),
      ev({ id: 3, kind: "turn_end" }),
    ]);
    expect(liveRow(rows)).toBeUndefined();
  });
});

describe("shortTarget", () => {
  it("shows a path by its file name", () => {
    expect(shortTarget("frontend-v2/src/components/QuestionCard.tsx")).toBe("QuestionCard.tsx");
    expect(shortTarget("/home/wizard/code/infra/")).toBe("infra");
  });

  it("shows a command whole, since its first word is not its point", () => {
    expect(shortTarget("npx vitest run QuestionCard")).toBe("npx vitest run QuestionCard");
    expect(shortTarget("cd /srv && ls")).toBe("cd /srv && ls");
    expect(shortTarget("ls")).toBe("ls");
  });

  it("leaves an address alone", () => {
    expect(shortTarget("https://example.com/a/b")).toBe("https://example.com/a/b");
  });
});
