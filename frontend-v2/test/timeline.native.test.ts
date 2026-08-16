import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import {
  currentMode,
  deriveRows,
  pendingQuestion,
  promptHistory,
  queuedPrompts,
  sameRow,
  visibleRows,
  type QuestionRow,
  type TodoRow,
  type ToolRow,
  type TurnFoldRow,
  type WorkingRow,
} from "../src/components/timeline.logic";

let seq = 0;
const ev = (e: Partial<Event> & { kind: Event["kind"] }): Event => ({
  id: ++seq,
  session: "demo",
  turnId: "t1",
  ...e,
});
const prompt = (text = "go") => ev({ kind: "user", body: text });

/** Rows of one unsettled turn, flattened past any fold. */
const rowsOf = (...events: Event[]) => deriveRows(events);
const flat = (rows: ReturnType<typeof deriveRows>) =>
  visibleRows(
    rows,
    new Set(rows.filter((r) => r.kind === "turn-fold").map((r) => r.turnKey)),
  );

describe("tool rows carry what the call is doing", () => {
  it("labels a command row with the command", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: JSON.stringify({ command: "go test ./..." }) }),
    );
    const tool = rows.find((r) => r.kind === "tool") as ToolRow;
    expect(tool.itemType).toBe("command_execution");
    expect(tool.label).toBe("go test ./...");
    expect(tool.done).toBe(false);
  });

  it("pairs the structured result onto its call", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: "{}" }),
      ev({
        kind: "tool_result",
        toolId: "tu1",
        body: "ok",
        result: { stdout: "ok", stderr: "", interrupted: false },
      }),
    );
    const tool = flat(rows).find((r) => r.kind === "tool") as ToolRow;
    expect(tool.done).toBe(true);
    expect(tool.payload).toEqual({ stdout: "ok", stderr: "", interrupted: false });
  });

  it("marks a capped result so the view can offer the rest", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: "{}" }),
      ev({ kind: "tool_result", toolId: "tu1", body: "cut…", truncated: true }),
    );
    const tool = flat(rows).find((r) => r.kind === "tool") as ToolRow;
    expect(tool.truncated).toBe(true);
  });
});

describe("thinking", () => {
  it("becomes its own row rather than assistant text", () => {
    const rows = flat(rowsOf(prompt(), ev({ kind: "thinking", body: "weighing it" })));
    expect(rows.some((r) => r.kind === "thinking")).toBe(true);
    expect(rows.some((r) => r.kind === "message")).toBe(false);
  });
});

describe("todo lists", () => {
  // Six TodoWrites in a turn is one list revised six times, not six rows.
  it("collapses every TodoWrite of a turn into one checklist", () => {
    const todo = (a: string, b: string) =>
      ev({
        kind: "tool_use",
        tool: "TodoWrite",
        toolId: `tu${seq}`,
        body: JSON.stringify({ todos: [{ content: "one", status: a }, { content: "two", status: b }] }),
      });
    const rows = flat(rowsOf(prompt(), todo("in_progress", "pending"), todo("completed", "in_progress")));
    const todos = rows.filter((r) => r.kind === "todo") as TodoRow[];
    expect(todos).toHaveLength(1);
    expect(todos[0]!.steps.map((s) => s.status)).toEqual(["completed", "inProgress"]);
  });
});

describe("questions", () => {
  const askEvent = () =>
    ev({
      kind: "tool_use",
      tool: "AskUserQuestion",
      toolId: "q1",
      body: JSON.stringify({
        questions: [
          {
            question: "Which way?",
            header: "Route",
            multiSelect: false,
            options: [{ label: "Left", description: "" }, { label: "Right", description: "" }],
          },
        ],
      }),
    });

  it("is pending until its result lands, and is findable while it blocks", () => {
    const rows = rowsOf(prompt(), askEvent());
    const q = pendingQuestion(rows);
    expect(q).not.toBeNull();
    expect(q!.questions[0]!.options.map((o) => o.label)).toEqual(["Left", "Right"]);
  });

  it("records what was chosen once answered, and stops being pending", () => {
    const rows = rowsOf(
      prompt(),
      askEvent(),
      ev({ kind: "tool_result", toolId: "q1", body: "", result: { answers: { Route: "Right" } } }),
    );
    const q = flat(rows).find((r) => r.kind === "question") as QuestionRow;
    expect(q.pending).toBe(false);
    expect(q.answers).toEqual(["Right"]);
    expect(pendingQuestion(rows)).toBeNull();
  });

  // A question inside a settled turn is folded away, but it is still the thing
  // blocking the session, so the search has to look inside folds.
  it("is found even when the turn folded around it", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "text", body: "some words" }),
      askEvent(),
      ev({ kind: "text", body: "more words" }),
      ev({ kind: "user", body: "next", turnId: "t2" }), // a later turn settles t1
    );
    expect(rows.some((r) => r.kind === "turn-fold")).toBe(true);
    expect(pendingQuestion(rows)).not.toBeNull();
  });
});

describe("subagents", () => {
  it("nests a subagent's work under the call that spawned it", () => {
    const rows = flat(
      rowsOf(
        prompt(),
        ev({ kind: "tool_use", tool: "Task", toolId: "ta1", body: JSON.stringify({ description: "explore" }) }),
        ev({ kind: "thinking", body: "inner reasoning", sidechain: true }),
        ev({ kind: "tool_use", tool: "Read", toolId: "r1", body: "{}", sidechain: true }),
        ev({ kind: "tool_result", toolId: "ta1", body: "found it" }),
      ),
    );
    const task = rows.find((r) => r.kind === "tool" && (r as ToolRow).tool === "Task") as ToolRow;
    expect(task.children).toHaveLength(2);
    // and the subagent's own rows are NOT loose in the main timeline
    expect(rows.filter((r) => r.kind === "thinking")).toHaveLength(0);
  });
});

describe("the working row", () => {
  it("names the call in flight and counts the steps so far", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "text", body: "I'll run the tests" }),
      ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: JSON.stringify({ command: "go test ./..." }), at: 1000 }),
    );
    const working = rows.find((r) => r.kind === "working") as WorkingRow;
    expect(working.toolLabel).toBe("go test ./...");
    expect(working.tool).toBe("Bash");
    expect(working.toolStartedAt).toBe(1000);
    expect(working.steps).toBe(2);
  });

  it("stops naming a call once its result lands", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: "{}" }),
      ev({ kind: "tool_result", toolId: "tu1", body: "done" }),
    );
    const working = rows.find((r) => r.kind === "working") as WorkingRow;
    expect(working.toolLabel).toBeUndefined();
  });
});

describe("the fold", () => {
  it("summarises the turn's changed files and token usage", () => {
    const rows = rowsOf(
      prompt(),
      ev({ kind: "tool_use", tool: "Edit", toolId: "e1", body: JSON.stringify({ file_path: "/x/a.go" }) }),
      ev({ kind: "tool_result", toolId: "e1", body: "" }),
      ev({ kind: "text", body: "changed it" }),
      ev({ kind: "turn_end", usage: { input_tokens: 7, output_tokens: 3 } }),
    );
    const fold = rows.find((r) => r.kind === "turn-fold") as TurnFoldRow;
    expect(fold.changedFiles).toEqual(["/x/a.go"]);
    expect(fold.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });
});

describe("session lifecycle", () => {
  it("reports the permission mode now in force", () => {
    expect(
      currentMode([
        ev({ kind: "meta", meta: "permission-mode", body: "default" }),
        ev({ kind: "meta", meta: "permission-mode", body: "bypassPermissions" }),
      ]),
    ).toBe("bypassPermissions");
  });

  it("lists prompts still sitting in the queue", () => {
    const events = [
      ev({ kind: "meta", meta: "queued", body: "first" }),
      ev({ kind: "meta", meta: "queued", body: "second" }),
      ev({ kind: "user", body: "first" }), // Claude picked this one up
    ];
    expect(queuedPrompts(events)).toEqual(["second"]);
  });

  it("gives the composer its prompt history", () => {
    expect(
      promptHistory([ev({ kind: "user", body: "one" }), ev({ kind: "text", body: "reply" }), ev({ kind: "user", body: "two" })]),
    ).toEqual(["one", "two"]);
  });
});

describe("sameRow", () => {
  // The renderer keeps a row's DOM while sameRow says it is unchanged, which is
  // what stops an expanded tool row snapping shut on every stream event.
  it("sees through a re-derivation of identical rows", () => {
    const build = () =>
      deriveRows([
        prompt(),
        ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: JSON.stringify({ command: "ls" }) }),
      ]);
    seq = 0;
    const a = build();
    seq = 0;
    const b = build();
    expect(a.every((row, i) => sameRow(row, b[i]!))).toBe(true);
  });

  it("notices a changed structured payload", () => {
    const mk = (stdout: string) =>
      deriveRows([
        prompt(),
        ev({ kind: "tool_use", tool: "Bash", toolId: "tu1", body: "{}" }),
        ev({ kind: "tool_result", toolId: "tu1", body: "x", result: { stdout } }),
      ]);
    seq = 0;
    const a = mk("one").find((r) => r.kind === "tool")!;
    seq = 0;
    const b = mk("two").find((r) => r.kind === "tool")!;
    expect(sameRow(a, b)).toBe(false);
  });
});
