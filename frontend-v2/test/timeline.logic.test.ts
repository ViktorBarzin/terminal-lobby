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
} from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
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
    const tools = rows.filter((r): r is ToolRow => r.kind === "tool");
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
    const tool = rows.find((r): r is ToolRow => r.kind === "tool")!;
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
    expect(collapsed.some((r) => r.kind === "tool")).toBe(false);
    const expanded = visibleRows(rows, new Set([fold.turnKey]));
    expect(expanded.some((r) => r.kind === "tool")).toBe(true);
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
    expect(expanded.slice(at + 1, at + 1 + fold.hidden.length)).toEqual(
      fold.hidden,
    );
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
    expect(fold.hidden.map((r) => r.kind)).toEqual(["tool"]);
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
    rows.find((r) => r.key === key)!;

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
      expect(sameRow(row, other), `row ${row.key} should compare equal`).toBe(
        true,
      );
    }
  });

  it("reports a tool row as changed once its result lands", () => {
    const before = byKey(rowsFor(), "tool-t1");
    const after = byKey(
      rowsFor([ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hi", at: 4000 })]),
      "tool-t1",
    );
    expect(sameRow(before, after)).toBe(false);
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
      ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: '{"file_path":"/nope.txt"}' }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "ENOENT", isError: true }),
      ev({ id: 5, kind: "text", body: "the read failed: no such file" }),
      ev({ id: 6, kind: "turn_end" }),
    ]);
    const fold = rows.find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    expect(fold.hidden.some((r) => r.kind === "tool" && r.isError)).toBe(true);
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
