import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import {
  deriveRows,
  visibleRows,
  pendingPermissions,
  sessionWorking,
  sameRow,
  currentMode,
  type ToolRow,
  type MessageRow,
  type TurnFoldRow,
  type TimelineRow,
  type WorkGroupRow,
  groupSummary,
} from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

/**
 * Every row a derivation holds, with folds and work groups opened. Calls sit
 * inside a work group since 2026-09-27, so tests about one call look here.
 */
const leaves = (rows: TimelineRow[]): TimelineRow[] =>
  rows.flatMap((r) => {
    if (r.kind === "turn-fold") return leaves(r.hidden);
    if (r.kind === "work-group") return r.calls;
    return [r];
  });

describe("deriveRows", () => {
  it("emits a user row then the assistant message, with a working row for the running turn", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "hi" }),
      ev({ id: 2, kind: "text", body: "hello" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "message", "working"]);
    const msg = rows[1] as MessageRow;
    expect(msg.body).toBe("hello");
  });

  // A running turn reports itself in ONE place. The message used to carry a
  // blinking cursor of its own, which claimed the text was still arriving —
  // untrue, since Claude Code writes one record per completed block — and
  // blinked directly above the tool rows that message had announced.
  it("gives a running turn exactly one progress indicator, and it is the working row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "text", body: "let me check the logs" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
    ]);
    expect(rows.filter((r) => r.kind === "working")).toHaveLength(1);
    // The working row is LAST — below the commands, not over them.
    expect(rows.at(-1)!.kind).toBe("working");
    for (const r of rows.filter((r) => r.kind === "message")) {
      expect(r).not.toHaveProperty("streaming");
    }
  });

  it("pairs tool_use with tool_result by toolId into one row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
      ev({ id: 3, kind: "tool_result", toolId: "t1", body: "file.txt", isError: false }),
      ev({ id: 4, kind: "turn_end" }),
    ]);
    const tools = leaves(rows).filter((r): r is ToolRow => r.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("Bash");
    expect(tools[0]!.input).toBe('{"command":"ls"}');
    expect(tools[0]!.result).toBe("file.txt");
    expect(tools[0]!.done).toBe(true);
    expect(tools[0]!.isError).toBe(false);
    // no working row: the turn ended
    expect(sessionWorking(rows)).toBe(false);
  });

  it("marks a tool_result as error", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "tool_use", tool: "Bash", toolId: "t1", body: "x" }),
      ev({ id: 2, kind: "tool_result", toolId: "t1", body: "boom", isError: true }),
      ev({ id: 3, kind: "turn_end" }),
    ]);
    const tool = leaves(rows).find((r): r is ToolRow => r.kind === "tool")!;
    expect(tool.isError).toBe(true);
  });

  it("folds a settled turn, keeping the last assistant message visible", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "do it" }),
      ev({ id: 2, kind: "text", body: "thinking" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "ok" }),
      ev({ id: 5, kind: "text", body: "all done" }),
      ev({ id: 6, kind: "turn_end" }),
    ]);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("turn-fold");
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    // hidden = first message + the tool (2 rows); "all done" stays visible
    expect(fold.count).toBe(2);
    const lastVisible = rows[rows.length - 1] as MessageRow;
    expect(lastVisible.kind).toBe("message");
    expect(lastVisible.body).toBe("all done");
  });

  it("expands a folded turn via visibleRows", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "do it" }),
      ev({ id: 2, kind: "text", body: "thinking" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "text", body: "all done" }),
      ev({ id: 5, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const collapsed = visibleRows(rows, new Set());
    expect(collapsed.some((r) => r.kind === "turn-fold")).toBe(true);
    expect(collapsed.some((r) => r.kind === "work-group")).toBe(false);
    const expanded = visibleRows(rows, new Set([fold.turnKey]));
    expect(expanded.some((r) => r.kind === "work-group")).toBe(true);
  });

  // Expanding used to SPLICE the fold row out, which removed the only control
  // that could put the turn back — expansion was one-way until a reload.
  it("keeps the fold control in place when the turn is expanded", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "do it" }),
      ev({ id: 2, kind: "text", body: "thinking" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "text", body: "all done" }),
      ev({ id: 5, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const expanded = visibleRows(rows, new Set([fold.turnKey]));

    expect(expanded.filter((r) => r.kind === "turn-fold")).toHaveLength(1);
    // …and it heads the block it holds, so the control reads as its handle.
    const at = expanded.findIndex((r) => r.kind === "turn-fold");
    expect(expanded.slice(at + 1, at + 1 + fold.hidden.length)).toEqual(fold.hidden);
  });

  // The fold row holds the work that came AFTER the visible message here, so
  // putting it first printed the announcement below the call it announced.
  it("orders rows chronologically when a turn's last work item is a tool call", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "touch a marker file", at: 1000 }),
      ev({
        id: 2,
        kind: "text",
        body: "I'll create /tmp/marker.txt using touch.",
        at: 2000,
      }),
      ev({
        id: 3,
        kind: "tool_use",
        tool: "Bash",
        toolId: "t1",
        body: '{"command":"touch /tmp/marker.txt"}',
        at: 3000,
      }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "", isError: true, at: 4000 }),
      ev({ id: 5, kind: "turn_end", at: 4000 }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["user", "message", "turn-fold"]);
    const fold = rows[2] as TurnFoldRow;
    expect(fold.hidden.map((r) => r.kind)).toEqual(["work-group"]);
  });

  // The common shape is unchanged: work first, then the answer it produced.
  it("keeps the fold above the answer when the turn ends in prose", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "do it" }),
      ev({ id: 2, kind: "text", body: "thinking" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "text", body: "all done" }),
      ev({ id: 5, kind: "turn_end" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "turn-fold", "message"]);
  });

  const rowsFor = (extra: Parameters<typeof deriveRows>[0] = []) =>
    deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1000 }),
      ev({ id: 2, kind: "text", body: "on it", at: 2000 }),
      ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: "{}", at: 3000 }),
      ...extra,
    ]);
  const byKey = (rows: TimelineRow[], key: string) =>
    [...rows, ...leaves(rows)].find((r) => r.key === key)!;

  // `<For>` reconciles by object reference and deriveRows allocates fresh rows
  // on every call, so one stream event used to rebuild the whole timeline DOM:
  // an expanded tool row snapped shut and every mermaid diagram re-rendered.
  // The renderer now reconciles by row key and holds each row behind a memo
  // whose equality is sameRow — an unchanged row never notifies its view.
  it("treats two derivations of an unchanged row as the same row", () => {
    const a = rowsFor();
    const b = rowsFor();
    for (const row of a) {
      const other = byKey(b, row.key);
      expect(other).not.toBe(row);
      expect(sameRow(row, other), `row ${row.key} should compare equal`).toBe(true);
    }
  });

  it("reports a tool row as changed once its result lands", () => {
    const before = byKey(rowsFor(), "tool-t1");
    const after = byKey(
      rowsFor([ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hi", at: 4000 })]),
      "tool-t1",
    );
    expect(sameRow(before, after)).toBe(false);
    // …and so is the work group holding it, which is what the timeline mounts.
    const groupBefore = byKey(rowsFor(), "group-tool-t1");
    const groupAfter = byKey(
      rowsFor([ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hi", at: 4000 })]),
      "group-tool-t1",
    );
    expect(sameRow(groupBefore, groupAfter)).toBe(false);
  });

  it("reports a fold row as changed when its hidden contents change", () => {
    const settled = (body: string) =>
      deriveRows([
        ev({ id: 1, kind: "user", body: "go" }),
        ev({ id: 2, kind: "text", body }),
        ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: "{}" }),
        ev({ id: 4, kind: "text", body: "done" }),
        ev({ id: 5, kind: "turn_end" }),
      ]).find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(sameRow(settled("a"), settled("a"))).toBe(true);
    expect(sameRow(settled("a"), settled("b"))).toBe(false);
  });

  // A fold hides the steps of a settled turn. When one of those steps FAILED,
  // the collapsed row is the only thing on screen standing for it, so the row
  // has to carry the fact — TurnFoldRowView cannot re-derive it from a count.
  it("flags a fold row that hides a failed tool call", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "read the missing file" }),
      ev({ id: 2, kind: "text", body: "reading it" }),
      ev({
        id: 3,
        kind: "tool_use",
        tool: "Read",
        toolId: "t1",
        body: '{"file_path":"/nope.txt"}',
      }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "ENOENT", isError: true }),
      ev({ id: 5, kind: "text", body: "the read failed: no such file" }),
      ev({ id: 6, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.hidden.some((r) => r.kind === "work-group" && r.hasError)).toBe(true);
    expect(fold.hasError).toBe(true);
  });

  it("flags a fold row that hides an error row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "error", body: "stream aborted" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "text", body: "recovered" }),
      ev({ id: 5, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.hasError).toBe(true);
  });

  it("leaves hasError false when every hidden step succeeded", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "do it" }),
      ev({ id: 2, kind: "text", body: "thinking" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "ok", isError: false }),
      ev({ id: 5, kind: "text", body: "all done" }),
      ev({ id: 6, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.hasError).toBe(false);
  });

  it("groups multiple user messages into separate turns", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "first" }),
      ev({ id: 2, kind: "text", body: "reply one" }),
      ev({ id: 3, kind: "user", body: "second" }),
      ev({ id: 4, kind: "text", body: "reply two" }),
    ]);
    const userRows = rows.filter((r) => r.kind === "user");
    expect(userRows).toHaveLength(2);
    // only the last (running) turn has a working row
    expect(rows.filter((r) => r.kind === "working")).toHaveLength(1);
  });

  it("honors an explicit backend turnId over synthetic grouping", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "text", turnId: "T1", body: "a" }),
      ev({ id: 2, kind: "tool_use", turnId: "T1", tool: "X", toolId: "t", body: "" }),
      ev({ id: 3, kind: "turn_end", turnId: "T1" }),
      ev({ id: 4, kind: "text", turnId: "T2", body: "b" }),
    ]);
    // T1 settled (T2 started) → folds; T2 running.
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(true);
    expect(sessionWorking(rows)).toBe(true);
  });
});

describe("pendingPermissions", () => {
  it("returns unresolved requests and drops resolved ones", () => {
    const base: Event[] = [
      ev({ id: 1, kind: "permission_request", reqId: "p1", tool: "Bash", body: "rm -rf" }),
      ev({ id: 2, kind: "permission_request", reqId: "p2", tool: "Write", body: "x" }),
    ];
    expect(pendingPermissions(base)).toHaveLength(2);
    const withResolve = [
      ...base,
      ev({ id: 3, kind: "permission_resolved", reqId: "p1", body: "allow" }),
    ];
    const pending = pendingPermissions(withResolve);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reqId).toBe("p2");
    expect(pending[0]!.tool).toBe("Write");
  });
});

// --- the mode/permission meta rows are noise in the timeline ---------------
// Viktor, 2026-08-17, from a screenshot: "we don't need to add the mode or
// permissions". Both are STATE, not events — the composer's chip always shows
// the mode in force — so a divider announcing each change interrupts the
// conversation to repeat what is already on screen. The events keep flowing;
// only the row is dropped, so currentMode() still reads them.
describe("mode and permission-mode do not become rows", () => {
  const meta = (id: number, m: string, body: string): Event =>
    ev({ id, kind: "meta", meta: m as Event["meta"], body });

  it("drops a mode change", () => {
    const rows = deriveRows([meta(1, "mode", "normal"), ev({ id: 2, kind: "turn_end" })]);
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(0);
  });

  it("drops a permission-mode change", () => {
    const rows = deriveRows([
      meta(1, "permission-mode", "bypassPermissions"),
      ev({ id: 2, kind: "turn_end" }),
    ]);
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(0);
  });

  // The ones that are genuinely events, and have nowhere else to show, stay —
  // each where it already belonged: a failed hook is promoted to its own row,
  // a compaction boundary rides inside the turn's folded work.
  it("keeps a compaction boundary and a failed hook", () => {
    const rows = deriveRows([
      meta(1, "compact", ""),
      meta(2, "hook-error", "PreToolUse failed"),
      ev({ id: 3, kind: "turn_end" }),
    ]);
    const top = rows.filter((r) => r.kind === "meta").map((r) => (r as { meta: string }).meta);
    expect(top).toEqual(["hook-error"]);
    const folded = rows
      .filter((r): r is TurnFoldRow => r.kind === "turn-fold")
      .flatMap((r) => r.hidden)
      .filter((h) => h.kind === "meta")
      .map((h) => (h as { meta: string }).meta);
    expect(folded).toEqual(["compact"]);
  });

  // A mode change must not survive inside the FOLD either — folding it away is
  // still carrying it, and expanding a turn would put the divider back.
  it("drops them from the folded work as well", () => {
    const rows = deriveRows([
      meta(1, "mode", "normal"),
      meta(2, "permission-mode", "bypassPermissions"),
      ev({ id: 3, kind: "turn_end" }),
    ]);
    const anywhere = rows
      .flatMap((r) => (r.kind === "turn-fold" ? r.hidden : [r]))
      .filter((r) => r.kind === "meta");
    expect(anywhere).toHaveLength(0);
  });

  // The composer reads the mode from the same events, so dropping the ROW must
  // not cost the chip its value.
  it("still reports the mode in force to the composer", () => {
    const events = [
      meta(1, "permission-mode", "bypassPermissions"),
      ev({ id: 2, kind: "turn_end" }),
    ];
    expect(deriveRows(events).filter((r) => r.kind === "meta")).toHaveLength(0);
    expect(currentMode(events)).toBe("bypassPermissions");
  });
});

// --- work groups (docs/plans/2026-09-27-text-view-t3-pass.md) -----------------
// Each run of tool calls between two replies is ONE row: "Ran 3 commands,
// edited 2 files · 28s". The thinking among the calls rides inside it. Todo,
// question, plan, permission and error rows keep their own rows and end a run.
describe("work groups", () => {
  const bash = (id: number, toolId: string, command: string, at?: number): Event =>
    ev({
      id,
      kind: "tool_use",
      tool: "Bash",
      toolId,
      body: JSON.stringify({ command }),
      ...(at !== undefined ? { at } : {}),
    });
  const done = (id: number, toolId: string, extra: Partial<Event> = {}): Event =>
    ev({ id, kind: "tool_result", toolId, body: "ok", ...extra });
  const groups = (rows: TimelineRow[]): WorkGroupRow[] =>
    rows
      .flatMap((r) => (r.kind === "turn-fold" ? r.hidden : [r]))
      .filter((r): r is WorkGroupRow => r.kind === "work-group");
  const shape = (rows: TimelineRow[]): string[] =>
    rows.map((r) =>
      r.kind === "work-group" ? `group(${r.calls.map((c) => c.kind).join(",")})` : r.kind,
    );

  it.each<[string, Event[], string[]]>([
    [
      "a run of calls between two replies is one row",
      [
        ev({ id: 2, kind: "text", body: "a" }),
        bash(3, "t1", "ls"),
        done(4, "t1"),
        bash(5, "t2", "pwd"),
        done(6, "t2"),
        ev({ id: 7, kind: "text", body: "b" }),
      ],
      ["user", "message", "group(tool,tool)", "message", "working"],
    ],
    [
      "thinking among the calls rides inside the group",
      [
        bash(2, "t1", "ls"),
        done(3, "t1"),
        ev({ id: 4, kind: "thinking", body: "hm" }),
        bash(5, "t2", "pwd"),
      ],
      ["user", "group(tool,thinking,tool)", "working"],
    ],
    [
      "thinking that opens the run belongs to it",
      [ev({ id: 2, kind: "thinking", body: "plan" }), bash(3, "t1", "ls")],
      ["user", "group(thinking,tool)", "working"],
    ],
    [
      "thinking with no call after it stays its own row",
      [ev({ id: 2, kind: "thinking", body: "hm" }), ev({ id: 3, kind: "text", body: "hi" })],
      ["user", "thinking", "message", "working"],
    ],
    [
      "a todo list splits a run in two",
      [
        bash(2, "t1", "ls"),
        ev({ id: 3, kind: "tool_use", tool: "TodoWrite", toolId: "td", body: '{"todos":[]}' }),
        bash(4, "t2", "pwd"),
      ],
      ["user", "group(tool)", "todo", "group(tool)", "working"],
    ],
    [
      "an error row ends a run",
      [bash(2, "t1", "ls"), ev({ id: 3, kind: "error", body: "boom" }), bash(4, "t2", "pwd")],
      ["user", "group(tool)", "error", "group(tool)", "working"],
    ],
    [
      "a permission request ends a run",
      [
        bash(2, "t1", "ls"),
        ev({ id: 3, kind: "permission_request", reqId: "p1", tool: "Bash", body: "rm" }),
      ],
      ["user", "group(tool)", "permission", "working"],
    ],
    [
      "a question ends a run",
      [
        bash(2, "t1", "ls"),
        done(3, "t1"),
        ev({
          id: 4,
          kind: "tool_use",
          tool: "AskUserQuestion",
          toolId: "q1",
          body: '{"questions":[{"question":"Which?","options":[{"label":"A"}]}]}',
        }),
      ],
      ["user", "group(tool)", "question", "working"],
    ],
    [
      "a plan ends a run",
      [
        bash(2, "t1", "ls"),
        done(3, "t1"),
        ev({
          id: 4,
          kind: "tool_use",
          tool: "ExitPlanMode",
          toolId: "p1",
          body: '{"plan":"do it"}',
        }),
      ],
      ["user", "group(tool)", "plan", "working"],
    ],
    [
      "a skill load joins the run",
      [
        ev({ id: 2, kind: "tool_use", tool: "Skill", toolId: "s1", body: '{"skill":"tdd"}' }),
        bash(3, "t1", "ls"),
      ],
      ["user", "group(tool,tool)", "working"],
    ],
  ])("%s", (_name, work, want) => {
    const rows = deriveRows([ev({ id: 1, kind: "user", body: "go" }), ...work]);
    expect(shape(rows)).toEqual(want);
  });

  // MessagesTimeline keys rows by `key`, so an open group stays open and the
  // scroll pin holds only while the key survives the run growing and the turn
  // settling.
  it("keeps one key while the run grows and after the turn settles", () => {
    const start = [
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "text", body: "on it" }),
      bash(3, "t1", "ls"),
    ];
    const first = groups(deriveRows(start));
    const grown = groups(deriveRows([...start, done(4, "t1"), bash(5, "t2", "pwd")]));
    const settledRows = deriveRows([
      ...start,
      done(4, "t1"),
      bash(5, "t2", "pwd"),
      done(6, "t2"),
      ev({ id: 7, kind: "text", body: "done" }),
      ev({ id: 8, kind: "turn_end" }),
    ]);
    const settled = groups(settledRows);
    expect(first.map((g) => g.key)).toEqual(["group-tool-t1"]);
    expect(grown.map((g) => g.key)).toEqual(["group-tool-t1"]);
    expect(settled.map((g) => g.key)).toEqual(["group-tool-t1"]);
    // Opened, the settled turn draws the group under the same key.
    const fold = settledRows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const opened = visibleRows(settledRows, new Set([fold.turnKey]));
    expect(opened.filter((r) => r.kind === "work-group").map((r) => r.key)).toEqual([
      "group-tool-t1",
    ]);
  });

  it.each<[string, Event[], string]>([
    ["one command", [bash(1, "a", "ls")], "Ran 1 command"],
    [
      "three commands",
      [bash(1, "a", "ls"), bash(2, "b", "pwd"), bash(3, "c", "id")],
      "Ran 3 commands",
    ],
    [
      "commands and edits, in the order they first appear",
      [
        bash(1, "a", "ls"),
        ev({
          id: 2,
          kind: "tool_use",
          tool: "Edit",
          toolId: "e1",
          body: '{"file_path":"/r/a.ts"}',
        }),
        bash(3, "b", "pwd"),
        ev({
          id: 4,
          kind: "tool_use",
          tool: "Write",
          toolId: "e2",
          body: '{"file_path":"/r/b.ts"}',
        }),
        bash(5, "c", "id"),
      ],
      "Ran 3 commands, edited 2 files",
    ],
    [
      "two edits to one file edit one file",
      [
        ev({
          id: 1,
          kind: "tool_use",
          tool: "Edit",
          toolId: "e1",
          body: '{"file_path":"/r/a.ts"}',
        }),
        ev({
          id: 2,
          kind: "tool_use",
          tool: "Edit",
          toolId: "e2",
          body: '{"file_path":"/r/a.ts"}',
        }),
      ],
      "Edited 1 file",
    ],
    [
      "reads count files, not calls",
      [
        ev({
          id: 1,
          kind: "tool_use",
          tool: "Read",
          toolId: "r1",
          body: '{"file_path":"/r/a.ts"}',
        }),
        ev({
          id: 2,
          kind: "tool_use",
          tool: "Read",
          toolId: "r2",
          body: '{"file_path":"/r/a.ts","offset":200}',
        }),
        ev({
          id: 3,
          kind: "tool_use",
          tool: "Read",
          toolId: "r3",
          body: '{"file_path":"/r/b.ts"}',
        }),
      ],
      "Read 2 files",
    ],
    [
      "one web search",
      [ev({ id: 1, kind: "tool_use", tool: "WebSearch", toolId: "w", body: '{"query":"x"}' })],
      "Searched once",
    ],
    [
      "greps and web searches are searches",
      [
        ev({ id: 1, kind: "tool_use", tool: "Grep", toolId: "g1", body: '{"pattern":"x"}' }),
        ev({ id: 2, kind: "tool_use", tool: "Glob", toolId: "g2", body: '{"pattern":"*.ts"}' }),
        ev({ id: 3, kind: "tool_use", tool: "WebFetch", toolId: "w", body: '{"url":"https://x"}' }),
      ],
      "Searched 3 times",
    ],
    [
      "tools from MCP and elsewhere are tools",
      [
        ev({
          id: 1,
          kind: "tool_use",
          tool: "mcp__playwright__browser_click",
          toolId: "m1",
          body: "{}",
        }),
        ev({ id: 2, kind: "tool_use", tool: "Frobnicate", toolId: "m2", body: "{}" }),
      ],
      "Used 2 tools",
    ],
    [
      "one MCP tool",
      [ev({ id: 1, kind: "tool_use", tool: "mcp__x__y", toolId: "m1", body: "{}" })],
      "Used 1 tool",
    ],
    [
      "an agent",
      [
        ev({
          id: 1,
          kind: "tool_use",
          tool: "Agent",
          toolId: "a1",
          body: '{"description":"look"}',
        }),
      ],
      "Ran 1 agent",
    ],
    [
      "two agents",
      [
        ev({ id: 1, kind: "tool_use", tool: "Agent", toolId: "a1", body: '{"description":"a"}' }),
        ev({ id: 2, kind: "tool_use", tool: "Task", toolId: "a2", body: '{"description":"b"}' }),
      ],
      "Ran 2 agents",
    ],
    [
      "a skill by name",
      [ev({ id: 1, kind: "tool_use", tool: "Skill", toolId: "s1", body: '{"skill":"tdd"}' })],
      "Loaded tdd",
    ],
    [
      "two skills by name",
      [
        ev({ id: 1, kind: "tool_use", tool: "Skill", toolId: "s1", body: '{"skill":"tdd"}' }),
        ev({ id: 2, kind: "tool_use", tool: "Skill", toolId: "s2", body: '{"skill":"unslop"}' }),
      ],
      "Loaded tdd and unslop",
    ],
    [
      "a skill and a command",
      [
        ev({ id: 1, kind: "tool_use", tool: "Skill", toolId: "s1", body: '{"skill":"tdd"}' }),
        bash(2, "a", "ls"),
      ],
      "Loaded tdd, ran 1 command",
    ],
    [
      "pictures viewed",
      [
        ev({ id: 1, kind: "tool_use", tool: "view_image", toolId: "v1", body: "{}" }),
        ev({ id: 2, kind: "tool_use", tool: "view_image", toolId: "v2", body: "{}" }),
      ],
      "Viewed 2 pictures",
    ],
    [
      // Found live on 2026-09-28: Claude reading two attached screenshots
      // summed up as "Read 2 files".
      "pictures read with the Read tool",
      [
        ev({
          id: 1,
          kind: "tool_use",
          tool: "Read",
          toolId: "r1",
          body: '{"file_path":"/tmp/a.png"}',
        }),
        ev({
          id: 2,
          kind: "tool_use",
          tool: "Read",
          toolId: "r2",
          body: '{"file_path":"/tmp/B.JPG"}',
        }),
        ev({
          id: 3,
          kind: "tool_use",
          tool: "Read",
          toolId: "r3",
          body: '{"file_path":"/tmp/notes.md"}',
        }),
      ],
      "Viewed 2 pictures, read 1 file",
    ],
  ])("summarises %s", (_name, calls, want) => {
    const rows = deriveRows([ev({ id: 0, kind: "user", body: "go" }), ...calls]);
    const [group] = groups(rows);
    expect(groupSummary(group!.calls)).toBe(want);
  });

  it("collects each call's pictures in call order, blocks before files within a call", () => {
    const img = (n: number) => ({ n, mediaType: "image/png" });
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "shoot" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Read",
        toolId: "r1",
        body: '{"file_path":"/tmp/a.png"}',
      }),
      ev({ id: 3, kind: "tool_result", toolId: "r1", images: [img(0), img(1)] }),
      ev({
        id: 4,
        kind: "tool_use",
        tool: "mcp__playwright__browser_take_screenshot",
        toolId: "s1",
        body: "{}",
      }),
      ev({
        id: 5,
        kind: "tool_result",
        toolId: "s1",
        body: "shot",
        files: ["/home/w/one.png", "/home/w/two.png"],
      }),
      bash(6, "b1", "ls"),
      done(7, "b1"),
    ]);
    expect(groups(rows)[0]!.pictures).toEqual([
      { kind: "block", toolId: "r1", n: 0, label: "/tmp/a.png" },
      { kind: "block", toolId: "r1", n: 1, label: "/tmp/a.png" },
      { kind: "file", path: "/home/w/one.png" },
      { kind: "file", path: "/home/w/two.png" },
    ]);
  });

  it.each<[string, boolean]>([
    ["a failed call", true],
    ["no failed call", false],
  ])("flags a group with %s", (_name, failed) => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "t1", "ls"),
      done(3, "t1"),
      bash(4, "t2", "false"),
      done(5, "t2", { isError: failed }),
      ev({ id: 6, kind: "turn_end" }),
    ]);
    expect(groups(rows)[0]!.hasError).toBe(failed);
  });

  it.each<[string, Event[], boolean]>([
    [
      "interrupted mid-call",
      [
        bash(2, "t1", "sleep 60", 1000),
        done(3, "t1", {
          body: "[Request interrupted by user for tool use]",
          isError: true,
          at: 4000,
        }),
        ev({ id: 4, kind: "state", body: "[Request interrupted by user for tool use]", at: 4000 }),
        ev({ id: 5, kind: "turn_end", at: 4000 }),
      ],
      true,
    ],
    [
      "interrupted before the call came back, with no result written",
      [bash(2, "t1", "sleep 60"), ev({ id: 3, kind: "turn_end" })],
      true,
    ],
    [
      "finished cleanly",
      [
        bash(2, "t1", "ls"),
        done(3, "t1"),
        ev({ id: 4, kind: "text", body: "ok" }),
        ev({ id: 5, kind: "turn_end" }),
      ],
      false,
    ],
    ["still running", [bash(2, "t1", "sleep 60")], false],
  ])("marks a group stopped when %s", (_name, work, stopped) => {
    const rows = deriveRows([ev({ id: 1, kind: "user", body: "go" }), ...work]);
    expect(groups(rows)[0]!.stopped).toBe(stopped);
  });

  // Found live on 2026-09-28: a stopped turn folded as a green "Worked for Ns"
  // with the CLI's own "[Request interrupted by user]" as its visible row.
  it.each<[string, Event[]]>([
    [
      "stopped after a reply",
      [
        ev({ id: 2, kind: "text", body: "looking" }),
        bash(3, "t1", "sleep 60", 1000),
        done(4, "t1", { body: "[Request interrupted by user for tool use]", isError: true }),
        ev({ id: 5, kind: "state", body: "[Request interrupted by user for tool use]" }),
        ev({ id: 6, kind: "turn_end" }),
      ],
    ],
    [
      "stopped between two replies",
      [
        ev({ id: 2, kind: "text", body: "looking" }),
        bash(3, "t1", "ls", 1000),
        done(4, "t1"),
        ev({ id: 5, kind: "text", body: "now the tests" }),
        ev({ id: 6, kind: "state", body: "[Request interrupted by user]" }),
        ev({ id: 7, kind: "turn_end" }),
      ],
    ],
  ])("folds a turn %s as stopped and keeps the stop in view", (_name, work) => {
    const rows = deriveRows([ev({ id: 1, kind: "user", body: "go" }), ...work]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.stopped).toBe(true);
    const last = rows[rows.length - 1]!;
    expect(last.kind === "status" && last.body.startsWith("[Request interrupted")).toBe(true);
    expect(rows.indexOf(fold)).toBeLessThan(rows.length - 1);
  });

  it("leaves a stopped turn with one group unfolded, the group saying stopped", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "t1", "sleep 60", 1000),
      ev({ id: 3, kind: "state", body: "[Request interrupted by user]" }),
      ev({ id: 4, kind: "turn_end" }),
    ]);
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(false);
    expect(groups(rows)[0]!.stopped).toBe(true);
    expect(rows[rows.length - 1]!.kind).toBe("status");
  });

  it("does not call a turn that finished cleanly stopped", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "t1", "ls"),
      done(3, "t1"),
      ev({ id: 4, kind: "text", body: "ok" }),
      ev({ id: 5, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.stopped).toBe(false);
  });

  // Found live on 2026-09-27: a local command typed after a turn settled
  // (/context, which writes into the transcript with no turn of its own)
  // joined the turn before it and stretched its "Worked for" to the minute
  // the command ran.
  it("ends a settled turn's fold at its turn_end, not at a later local command", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
      bash(2, "t1", "ls", 2_000),
      done(3, "t1", { at: 3_000 }),
      ev({ id: 4, kind: "text", body: "done", at: 9_000 }),
      ev({ id: 5, kind: "turn_end", at: 9_000 }),
      ev({ id: 6, kind: "meta", meta: "context", body: "", at: 60_000 }),
    ]);
    const fold = rows.find((r) => r.kind === "turn-fold");
    expect(fold?.kind === "turn-fold" ? fold.durationMs : null).toBe(8_000);
  });

  it("measures a group from its first call to its last result", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 500 }),
      bash(2, "t1", "ls", 1000),
      done(3, "t1", { at: 3000 }),
      bash(4, "t2", "pwd", 3500),
      done(5, "t2", { at: 29_000 }),
      ev({ id: 6, kind: "text", body: "done", at: 30_000 }),
      ev({ id: 7, kind: "turn_end", at: 30_000 }),
    ]);
    expect(groups(rows)[0]!.durationMs).toBe(28_000);
  });

  it("says what the running group is doing, how many calls are back, and since when", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go", at: 500 }),
      bash(2, "t1", "ls", 1000),
      done(3, "t1", { at: 2000 }),
      bash(4, "t2", "sleep 6 && echo b", 2500),
    ]);
    expect(groups(rows)[0]!.live).toEqual({
      tool: "Bash",
      label: "sleep 6 && echo b",
      startedAt: 1000,
      callStartedAt: 2500,
      done: 1,
    });
  });

  it("keeps the running group live between calls, with nothing in flight", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "t1", "ls", 1000),
      done(3, "t1", { at: 2000 }),
    ]);
    expect(groups(rows)[0]!.live).toEqual({ startedAt: 1000, done: 1 });
  });

  it.each<[string, Event[]]>([
    [
      "a reply follows it",
      [bash(2, "t1", "ls"), done(3, "t1"), ev({ id: 4, kind: "text", body: "hm" })],
    ],
    ["the turn settled", [bash(2, "t1", "ls"), done(3, "t1"), ev({ id: 4, kind: "turn_end" })]],
  ])("has no live state once %s", (_name, work) => {
    const rows = deriveRows([ev({ id: 1, kind: "user", body: "go" }), ...work]);
    expect(groups(rows)[0]!.live).toBeUndefined();
  });

  // Viktor, 2026-09-27: a finished turn still folds to its last reply, and
  // opening it shows the replies and work groups in order.
  it("folds a finished turn to its last reply, holding replies and groups in order", () => {
    const img = { n: 0, mediaType: "image/png" };
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "text", body: "a" }),
      bash(3, "t1", "ls"),
      done(4, "t1"),
      ev({ id: 5, kind: "text", body: "b" }),
      ev({
        id: 6,
        kind: "tool_use",
        tool: "Read",
        toolId: "r1",
        body: '{"file_path":"/tmp/s.png"}',
      }),
      done(7, "r1", { body: "", images: [img] }),
      bash(8, "t2", "pwd"),
      done(9, "t2"),
      ev({ id: 10, kind: "text", body: "c" }),
      ev({ id: 11, kind: "turn_end" }),
    ]);
    expect(shape(rows)).toEqual(["user", "turn-fold", "message"]);
    expect((rows[2] as MessageRow).body).toBe("c");
    const fold = rows[1] as TurnFoldRow;
    expect(shape(fold.hidden)).toEqual(["message", "group(tool)", "message", "group(tool,tool)"]);
    // The fold still counts steps, not rows.
    expect(fold.count).toBe(5);
    // A folded turn keeps its pictures in view.
    expect(fold.pictures).toEqual([{ kind: "block", toolId: "r1", n: 0, label: "/tmp/s.png" }]);
    const opened = visibleRows(rows, new Set([fold.turnKey]));
    expect(shape(opened)).toEqual([
      "user",
      "turn-fold",
      "message",
      "group(tool)",
      "message",
      "group(tool,tool)",
      "message",
    ]);
  });

  it("leaves a declined or failed edit's file out of what a fold says changed", () => {
    // Seen live on 2026-09-27: a turn whose only Edit the reader declined
    // folded to "Worked for 3m 16s · 1 step · calc.py".
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"/r/a.ts"}' }),
      done(3, "e1", {
        isError: true,
        body: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      }),
      ev({ id: 4, kind: "tool_use", tool: "Edit", toolId: "e2", body: '{"file_path":"/r/b.ts"}' }),
      done(5, "e2", { isError: true, body: "File has not been read yet." }),
      ev({ id: 6, kind: "text", body: "ok" }),
      ev({ id: 7, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
      done(8, "t1"),
      ev({ id: 9, kind: "text", body: "done" }),
      ev({ id: 10, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.changedFiles).toEqual([]);
  });

  it("reads the changed files and failures inside the groups a fold hides", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"/r/a.ts"}' }),
      done(3, "e1"),
      bash(4, "t1", "false"),
      done(5, "t1", { isError: true }),
      ev({ id: 6, kind: "text", body: "done" }),
      ev({ id: 7, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.changedFiles).toEqual(["/r/a.ts"]);
    expect(fold.hasError).toBe(true);
  });

  it("treats two derivations of an unchanged group as the same row, and a new call as a change", () => {
    const start = [ev({ id: 1, kind: "user", body: "go" }), bash(2, "t1", "ls", 1000)];
    const [a] = groups(deriveRows(start));
    const [b] = groups(deriveRows(start));
    const [c] = groups(deriveRows([...start, done(3, "t1", { at: 2000 })]));
    expect(sameRow(a!, b!)).toBe(true);
    expect(sameRow(a!, c!)).toBe(false);
  });

  // The drill-in reads one agent's transcript to see its calls, so it keeps
  // them as rows of their own.
  it("leaves calls as their own rows when grouping is off", () => {
    const rows = deriveRows(
      [
        ev({ id: 1, kind: "user", body: "go" }),
        bash(2, "t1", "ls"),
        done(3, "t1"),
        bash(4, "t2", "pwd"),
      ],
      { fold: false, group: false },
    );
    expect(shape(rows)).toEqual(["user", "tool", "tool", "working"]);
  });
});
