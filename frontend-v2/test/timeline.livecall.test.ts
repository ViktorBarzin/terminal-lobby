/**
 * What the live row says about the call in flight.
 *
 * It said "Running <label>" for every tool, so an edit read "Running
 * session.ts" and a search "Running liveGroupState". Viktor asked for more of
 * an idea of what the agent is doing (2026-10-02): a verb for the kind of call,
 * the target (the row shows its file name), and the call's own second line where Claude gave one (a
 * command's description, the folder a search runs in, a subagent's task).
 * T3 Code's live row is the reference: one line, verb plus target.
 */
import { describe, it, expect } from "vitest";
import { classifyToolItemType, describe as describeCall } from "../src/components/canonicalize";
import { liveCall } from "../src/components/timeline.logic";

/** The call in flight as the live state carries it, from a tool name and input. */
const inFlight = (tool: string, input: Record<string, unknown>) => {
  const d = describeCall(tool, JSON.stringify(input));
  return { tool, itemType: classifyToolItemType(tool), label: d.label, detail: d.detail };
};

describe("liveCall", () => {
  it.each([
    [
      "a command, with its description",
      inFlight("Bash", {
        command: "npm test --run QuestionCard",
        description: "Run the card tests",
      }),
      {
        icon: "command",
        verb: "Running",
        target: "npm test --run QuestionCard",
        detail: "Run the card tests",
      },
    ],
    [
      "an edit, by file name",
      inFlight("Edit", {
        file_path: "/home/w/src/store/session.ts",
        old_string: "a",
        new_string: "b",
      }),
      { icon: "edit", verb: "Editing", target: "store/session.ts", detail: "" },
    ],
    [
      "a new file",
      inFlight("Write", { file_path: "/home/w/test/x.test.ts", content: "…" }),
      { icon: "edit", verb: "Writing", target: "test/x.test.ts", detail: "" },
    ],
    [
      "a read",
      inFlight("Read", { file_path: "/home/w/src/components/rows.tsx" }),
      { icon: "read", verb: "Reading", target: "components/rows.tsx", detail: "" },
    ],
    [
      "a grep, and where it looks",
      inFlight("Grep", { pattern: "liveGroupState", path: "src/components" }),
      {
        icon: "search",
        verb: "Searching for",
        target: "liveGroupState",
        detail: "in src/components",
      },
    ],
    [
      "a glob",
      inFlight("Glob", { pattern: "**/*.test.tsx" }),
      { icon: "search", verb: "Finding", target: "**/*.test.tsx", detail: "" },
    ],
    [
      "a web search",
      inFlight("WebSearch", { query: "solidjs createMemo equals" }),
      {
        icon: "search",
        verb: "Searching the web for",
        target: "solidjs createMemo equals",
        detail: "",
      },
    ],
    [
      "a fetch",
      inFlight("WebFetch", {
        url: "https://docs.solidjs.com/reference",
        prompt: "find createMemo",
      }),
      {
        icon: "search",
        verb: "Fetching",
        target: "https://docs.solidjs.com/reference",
        detail: "find createMemo",
      },
    ],
    [
      "a subagent, and its task",
      inFlight("Agent", {
        description: "Map T3 display",
        prompt: "Read the T3 source.\nAnswer briefly.",
      }),
      { icon: "tools", verb: "Agent:", target: "Map T3 display", detail: "Read the T3 source." },
    ],
    [
      "a skill",
      inFlight("Skill", { skill: "wrap-up" }),
      { icon: "tools", verb: "Loading skill", target: "wrap-up", detail: "" },
    ],
    [
      "an MCP tool, and its server",
      inFlight("mcp__playwright__browser_click", { element: "Send" }),
      { icon: "tools", verb: "Using", target: "browser_click", detail: "playwright" },
    ],
    [
      "a tool nothing here knows",
      inFlight("Frobnicate", { what: "the widget" }),
      { icon: "tools", verb: "Running", target: "Frobnicate", detail: "the widget" },
    ],
  ])("says %s", (_name, call, want) => {
    expect(liveCall(call)).toEqual(want);
  });

  it("keeps the detail to its first line", () => {
    const got = liveCall(inFlight("Bash", { command: "make", description: "Build it\nthen test" }));
    expect(got?.detail).toBe("Build it");
  });

  it("says nothing when no call is in flight", () => {
    expect(liveCall({})).toBeNull();
  });
});
