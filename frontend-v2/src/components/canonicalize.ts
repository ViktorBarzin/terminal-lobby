/**
 * Tool call → canonical item, ported from T3 Code.
 *
 * Upstream: t3code apps/server/src/provider/Layers/ClaudeAdapter.ts
 *   (classifyToolItemType, isReadOnlyToolName, extractPlanStepsFromTodoInput)
 * at 6bc6cb6b, MIT licensed:
 *
 *   MIT License · Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction… The above copyright notice and
 *   this permission notice shall be included in all copies or substantial
 *   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 *   WARRANTY OF ANY KIND.
 *
 * Ported rather than imported: upstream is React + Effect-TS over its own
 * contracts package, and the classification is plain string work. The
 * substring matching is kept as upstream wrote it — it is deliberately loose so
 * an unfamiliar tool (an MCP server's, a plugin's) still lands somewhere useful
 * instead of falling to a generic row. What is ADDED here is everything below
 * `describe`: Claude Code's transcript carries the tool's actual input and its
 * structured result, which upstream's event stream does not, so we can label a
 * row with the command that ran or the file that changed.
 */

import type { Event } from "../types/events";

export type ItemType =
  | "file_read"
  | "file_change"
  | "command_execution"
  | "web_search"
  | "image_view"
  | "mcp_tool_call"
  | "collab_agent_tool_call"
  | "todo"
  | "question"
  | "plan"
  | "dynamic_tool_call";

/** Upstream's tone tag: what a work-log row MEANS, independent of its type. */
export type Tone = "info" | "tool" | "approval" | "error";

/** Ported verbatim in behaviour from ClaudeAdapter.classifyToolItemType. */
export function classifyToolItemType(toolName: string): ItemType {
  const normalized = toolName.toLowerCase();
  // Claude Code's own names first — exact, and cheaper than the substring
  // ladder. These did not exist upstream, which never sees a Claude tool by
  // name; without them "TodoWrite" would classify as file_change ("write") and
  // "AskUserQuestion" as dynamic.
  switch (toolName) {
    case "TodoWrite":
      return "todo";
    case "AskUserQuestion":
      return "question";
    case "ExitPlanMode":
      return "plan";
    case "Read":
    case "Glob":
    case "Grep":
    case "NotebookRead":
      return "file_read";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "file_change";
    case "Bash":
    case "BashOutput":
      return "command_execution";
    case "Task":
    case "Agent":
      return "collab_agent_tool_call";
    case "WebSearch":
      return "web_search";
    case "WebFetch":
      return "web_search";
  }
  if (normalized.startsWith("mcp__")) return "mcp_tool_call";
  if (normalized.includes("agent")) return "collab_agent_tool_call";
  if (
    normalized === "task" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

/** Ported from ClaudeAdapter.isReadOnlyToolName. */
export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export interface TodoStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

/** Ported from ClaudeAdapter.extractPlanStepsFromTodoInput. */
export function extractTodoSteps(input: unknown): TodoStep[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

// ---------------------------------------------------------------------------
// Below here is ours: the transcript's own payloads, which upstream never sees.
// ---------------------------------------------------------------------------

/** Parse a JSON string field, returning null rather than throwing. */
export function parseJSON(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** How much of a label a row can show before it is just noise. */
export const LABEL_MAX = 120;

/**
 * A row's label is ONE line. A Bash call routinely carries a whole heredoc —
 * measured on a real session, a single `command` held a 60-line embedded script
 * — and pasting that into a one-line row gives a reader nothing to recognise it
 * by. Take the first line that says something, drop a leading `cd … &&` (it is
 * setup, not the command), and cap the rest. The full input is one expand away.
 */
export function oneLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let first = lines[0] ?? "";
  const cd = /^cd\s+\S+\s*&&\s*/.exec(first);
  if (cd && first.length > cd[0].length) first = first.slice(cd[0].length);
  // A `cd` on its own line is setup too; the next line is the command.
  else if (/^cd\s+\S+$/.test(first) && lines.length > 1) first = lines[1]!;
  const more = lines.length > 1 ? " …" : "";
  return first.length > LABEL_MAX ? first.slice(0, LABEL_MAX) + "…" : first + more;
}

/** The last two segments of a path — enough to recognise, short enough to fit. */
export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

/** One line of a unified diff, as `structuredPatch` hunks describe it. */
export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Read `structuredPatch` out of a tool result. Claude records it for Edit and
 * Write as `[{oldStart, oldLines, newStart, newLines, lines: ["+added", …]}]`,
 * which is a unified diff already — we only have to type it.
 */
export function diffHunks(result: unknown): Hunk[] {
  const patch = (result as { structuredPatch?: unknown } | null)?.structuredPatch;
  if (!Array.isArray(patch)) return [];
  const out: Hunk[] = [];
  for (const h of patch) {
    if (!h || typeof h !== "object") continue;
    const raw = (h as { lines?: unknown }).lines;
    if (!Array.isArray(raw)) continue;
    const oldStart = Number((h as { oldStart?: unknown }).oldStart) || 0;
    const newStart = Number((h as { newStart?: unknown }).newStart) || 0;
    out.push({
      header: `@@ -${oldStart} +${newStart} @@`,
      lines: raw.filter((l): l is string => typeof l === "string").map((l) => ({
        sign: l.startsWith("+") ? "+" : l.startsWith("-") ? "-" : " ",
        text: l.slice(1),
      })),
    });
  }
  return out;
}

/** +added / −removed across every hunk, for the collapsed row's summary. */
export function diffStat(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === "+") added++;
      else if (l.sign === "-") removed++;
    }
  }
  return { added, removed };
}

/** A command's output, split the way the transcript records it. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
}

export function commandOutput(result: unknown, fallback: string): CommandOutput | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") {
    return fallback ? { stdout: fallback, stderr: "", interrupted: false } : null;
  }
  if (!("stdout" in r) && !("stderr" in r)) {
    return fallback ? { stdout: fallback, stderr: "", interrupted: false } : null;
  }
  return {
    stdout: str(r.stdout),
    stderr: str(r.stderr),
    interrupted: r.interrupted === true,
  };
}

/** One option of an AskUserQuestion, as the transcript records it. */
export interface QuestionOption {
  label: string;
  description: string;
}
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export function questions(input: unknown): Question[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      question: str(q.question),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o) => ({ label: str(o.label), description: str(o.description) }))
        : [],
    }));
}

export interface Described {
  type: ItemType;
  /** The row's headline: the command, the path, the query. */
  label: string;
  /** A second line where one helps — a Grep pattern, a Task's prompt. */
  detail: string;
  /** Files this call changed, for the turn's changed-file summary. */
  changedFiles: string[];
}

/**
 * What a tool call is doing, from its name and its input. This is the row the
 * reader sees before expanding anything, so it answers "what is happening" —
 * `go test ./sessionio/`, not `Bash`.
 */
export function describe(tool: string, inputRaw: string | undefined): Described {
  const type = classifyToolItemType(tool);
  const input = parseJSON(inputRaw) as Record<string, unknown> | null;
  const get = (k: string) => str(input?.[k]);
  const d = (label: string, detail = "", changedFiles: string[] = []): Described => ({
    type,
    label,
    detail,
    changedFiles,
  });

  switch (tool) {
    case "Bash":
      return d(oneLine(get("command")), get("description"));
    case "Read":
      return d(shortPath(get("file_path")), get("file_path"));
    case "Edit":
    case "Write":
      return d(shortPath(get("file_path")), get("file_path"), [get("file_path")].filter(Boolean));
    case "Glob":
      return d(get("pattern"), get("path"));
    case "Grep":
      return d(get("pattern"), get("path") || get("glob"));
    case "WebSearch":
      return d(get("query"));
    case "WebFetch":
      return d(get("url"), get("prompt"));
    case "Task":
    case "Agent":
      return d(get("description") || get("subagent_type") || "subagent", get("prompt"));
    case "Skill":
      return d(get("skill") || get("command"), get("args"));
    case "AskUserQuestion": {
      const qs = questions(input);
      return d(qs[0]?.question || "a question", qs[0]?.header ?? "");
    }
    case "TodoWrite": {
      const steps = extractTodoSteps(input) ?? [];
      const done = steps.filter((s) => s.status === "completed").length;
      return d(`${done}/${steps.length} done`);
    }
  }
  if (type === "mcp_tool_call") {
    // mcp__playwright__browser_click → playwright · browser_click
    const parts = tool.split("__");
    return d(parts.slice(2).join("__") || tool, parts[1] ?? "");
  }
  // An unfamiliar tool: show its name, and the first string its input carries
  // rather than nothing at all.
  const first = input
    ? Object.values(input).find((v) => typeof v === "string" && v.length > 0)
    : undefined;
  return d(tool || "tool", typeof first === "string" ? first : "");
}

/**
 * Whether a finished call failed. `is_error` is authoritative when the harness
 * set it; a command that exited non-zero is also a failure even when the
 * harness did not flag it, which is upstream's heuristic kept for the case the
 * transcript stays quiet about.
 */
export function failed(ev: Event, result: unknown): boolean {
  if (ev.isError) return true;
  const out = commandOutput(result, "");
  if (out?.interrupted) return true;
  return false;
}
