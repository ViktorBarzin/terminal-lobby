import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import {
  deriveRows,
  visibleRows,
  pendingPermissions,
  sessionWorking,
  type ToolRow,
  type MessageRow,
  type TurnFoldRow,
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
    // last message of an unsettled turn is marked streaming
    expect(msg.streaming).toBe(true);
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
    expect(expanded.some((r) => r.kind === "turn-fold")).toBe(false);
    expect(expanded.some((r) => r.kind === "tool")).toBe(true);
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
