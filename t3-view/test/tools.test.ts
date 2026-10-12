import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { classifyTool, type ItemBase, toolItem, unifiedDiff } from "../src/threads/tools.ts";

const base: ItemBase = {
  id: TurnItemId.make("item:1"),
  threadId: ThreadId.make("t"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};

describe("classifyTool", () => {
  it.each([
    ["Bash", "command_execution"],
    ["Edit", "file_change"],
    ["MultiEdit", "file_change"],
    ["Write", "file_change"],
    ["NotebookEdit", "file_change"],
    ["WebSearch", "web_search"],
    ["WebFetch", "web_search"],
    ["Read", "dynamic_tool"],
    ["AskUserQuestion", "dynamic_tool"],
    ["mcp__x__y", "dynamic_tool"],
  ])("%s is a %s", (tool, type) => {
    expect(classifyTool(tool).itemType).toBe(type);
  });
});

describe("toolItem", () => {
  it("shows a running Bash call with its command, then its output", () => {
    const input = { command: "echo hi", description: "Print hi" };
    expect(toolItem(base, "Bash", input, undefined)).toMatchObject({
      type: "command_execution",
      status: "running",
      input: "echo hi",
    });
    const done = toolItem(base, "Bash", input, {
      body: "hi",
      isError: false,
      result: { stdout: "hi", stderr: "" },
    });
    expect(done).toMatchObject({ status: "completed", output: "hi" });
  });

  it("marks a failed call", () => {
    const item = toolItem(
      base,
      "Bash",
      { command: "sleep 30" },
      {
        body: "Blocked",
        isError: true,
        result: "Error: Blocked",
      },
    );
    expect(item).toMatchObject({
      status: "failed",
      output: "Blocked",
      outputIndicatesFailure: true,
    });
  });

  it("turns an Edit's structured patch into a unified diff with counts", () => {
    const result = {
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] },
      ],
    };
    expect(unifiedDiff("f.txt", result)).toBe(
      "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n-a\n+b\n+c",
    );
    const item = toolItem(
      base,
      "Edit",
      { file_path: "/x/f.txt", old_string: "a", new_string: "b\nc" },
      { body: "ok", isError: false, result },
    );
    expect(item).toMatchObject({
      type: "file_change",
      fileName: "/x/f.txt",
      oldStr: "a",
      newStr: "b\nc",
      additions: 2,
      deletions: 1,
    });
  });

  it("keeps any other tool's input and output as they were", () => {
    const item = toolItem(
      base,
      "Read",
      { file_path: "/a" },
      {
        body: "contents",
        isError: false,
        result: undefined,
      },
    );
    expect(item).toMatchObject({
      type: "dynamic_tool",
      toolName: "Read",
      input: { file_path: "/a" },
      output: "contents",
    });
  });
});
