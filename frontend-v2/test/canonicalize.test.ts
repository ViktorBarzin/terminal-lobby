import { describe, it, expect } from "vitest";
import {
  classifyToolItemType,
  commandOutput,
  describe as describeTool,
  diffHunks,
  diffStat,
  extractTodoSteps,
  LABEL_MAX,
  oneLine,
  questions,
  shortPath,
} from "../src/components/canonicalize";

describe("classifyToolItemType", () => {
  it("names Claude Code's own tools exactly", () => {
    expect(classifyToolItemType("Bash")).toBe("command_execution");
    expect(classifyToolItemType("Read")).toBe("file_read");
    expect(classifyToolItemType("Edit")).toBe("file_change");
    expect(classifyToolItemType("Task")).toBe("collab_agent_tool_call");
    expect(classifyToolItemType("WebSearch")).toBe("web_search");
  });

  // Upstream's substring ladder would call TodoWrite a file change and
  // AskUserQuestion generic; both are their own kind of row here.
  it("does not mistake TodoWrite for a file write", () => {
    expect(classifyToolItemType("TodoWrite")).toBe("todo");
    expect(classifyToolItemType("AskUserQuestion")).toBe("question");
    expect(classifyToolItemType("ExitPlanMode")).toBe("plan");
  });

  it("recognises an MCP tool by its prefix", () => {
    expect(classifyToolItemType("mcp__playwright__browser_click")).toBe("mcp_tool_call");
  });

  it("still lands an unfamiliar tool somewhere useful", () => {
    expect(classifyToolItemType("SomeShellRunner")).toBe("command_execution");
    expect(classifyToolItemType("PatchApplier")).toBe("file_change");
    expect(classifyToolItemType("Whatever")).toBe("dynamic_tool_call");
  });
});

describe("describe", () => {
  it("labels a command with the command, not with 'Bash'", () => {
    const d = describeTool("Bash", JSON.stringify({ command: "go test ./...", description: "run tests" }));
    expect(d.label).toBe("go test ./...");
    expect(d.detail).toBe("run tests");
  });

  it("labels a file change with the path, and reports it changed", () => {
    const d = describeTool("Edit", JSON.stringify({ file_path: "/home/w/code/x/sessionio/normalize.go" }));
    expect(d.label).toBe("sessionio/normalize.go");
    expect(d.changedFiles).toEqual(["/home/w/code/x/sessionio/normalize.go"]);
  });

  it("summarises a todo list by its progress", () => {
    const d = describeTool(
      "TodoWrite",
      JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }),
    );
    expect(d.label).toBe("1/2 done");
  });

  it("splits an MCP name into server and tool", () => {
    const d = describeTool("mcp__playwright__browser_click", "{}");
    expect(d.label).toBe("browser_click");
    expect(d.detail).toBe("playwright");
  });

  it("survives input that is not JSON at all", () => {
    const d = describeTool("Bash", "not json");
    expect(d.type).toBe("command_execution");
    expect(d.label).toBe("");
  });
});

describe("shortPath", () => {
  it("keeps enough of a path to recognise it", () => {
    expect(shortPath("/home/wizard/code/terminal-lobby/sessionio/tail.go")).toBe("sessionio/tail.go");
    expect(shortPath("README.md")).toBe("README.md");
  });
});

describe("structured payloads", () => {
  it("reads a diff out of structuredPatch", () => {
    const hunks = diffHunks({
      structuredPatch: [{ oldStart: 10, newStart: 10, lines: ["-old line", "+new line", " context"] }],
    });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.map((l) => l.sign)).toEqual(["-", "+", " "]);
    expect(hunks[0]!.lines[1]!.text).toBe("new line");
    expect(diffStat(hunks)).toEqual({ added: 1, removed: 1 });
  });

  it("splits a command's output", () => {
    const out = commandOutput({ stdout: "ok", stderr: "warn", interrupted: false }, "");
    expect(out).toEqual({ stdout: "ok", stderr: "warn", interrupted: false });
  });

  // A capped result arrives with no structured form at all, so the flattened
  // text is all there is — the row still has to render.
  it("falls back to the flattened text when the payload was dropped", () => {
    expect(commandOutput(null, "just text")).toEqual({
      stdout: "just text",
      stderr: "",
      interrupted: false,
    });
  });

  it("reads a question's options", () => {
    const qs = questions({
      questions: [
        {
          question: "Which?",
          header: "Pick",
          multiSelect: false,
          options: [{ label: "A", description: "first" }, { label: "B", description: "second" }],
        },
      ],
    });
    expect(qs[0]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("returns null for a TodoWrite with no todos", () => {
    expect(extractTodoSteps({ todos: [] })).toBeNull();
    expect(extractTodoSteps(null)).toBeNull();
  });
});

describe("oneLine", () => {
  it("takes the first meaningful line of a multi-line command", () => {
    expect(oneLine("go build ./...\ngo test ./...")).toBe("go build ./... …");
  });

  // Measured on a real session: one Bash `command` held a 60-line heredoc, and
  // the row's label was the whole script.
  it("caps a very long line", () => {
    const long = "x".repeat(400);
    expect(oneLine(long).length).toBeLessThanOrEqual(LABEL_MAX + 1);
  });

  it("drops a leading cd, which is setup rather than the command", () => {
    expect(oneLine("cd /home/wizard/code/tripit && tripit segments list")).toBe(
      "tripit segments list",
    );
    expect(oneLine("cd /home/w/code\nnpm test")).toBe("npm test …");
  });

  it("leaves an ordinary one-liner alone", () => {
    expect(oneLine("git status")).toBe("git status");
  });
});
