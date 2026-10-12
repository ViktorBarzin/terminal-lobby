/**
 * Claude tool calls as T3 turn items.
 *
 * The classification is T3's own table (apps/server/src/orchestration-v2/
 * Adapters/ClaudeAdapterV2.ts, CLAUDE_KNOWN_TOOL_CLASSIFICATIONS at the pin),
 * copied rather than imported because that module pulls in the Claude Agent
 * SDK. Bash is a command_execution, the editing tools are file_change, the
 * two web tools are web_search, and everything else is a dynamic_tool that
 * carries Claude's input and output as they were.
 */
import type { OrchestrationV2TurnItem, ProviderRequestKind } from "@t3tools/contracts";

export type ToolItemType = "command_execution" | "file_change" | "web_search" | "dynamic_tool";

interface Classification {
  readonly itemType: ToolItemType;
  readonly requestKind: ProviderRequestKind;
}

const KNOWN: Readonly<Record<string, Classification>> = {
  agent: { itemType: "dynamic_tool", requestKind: "command" },
  bash: { itemType: "command_execution", requestKind: "command" },
  edit: { itemType: "file_change", requestKind: "file-change" },
  glob: { itemType: "dynamic_tool", requestKind: "file-read" },
  grep: { itemType: "dynamic_tool", requestKind: "file-read" },
  ls: { itemType: "dynamic_tool", requestKind: "file-read" },
  monitor: { itemType: "dynamic_tool", requestKind: "command" },
  multiedit: { itemType: "file_change", requestKind: "file-change" },
  notebookedit: { itemType: "file_change", requestKind: "file-change" },
  read: { itemType: "dynamic_tool", requestKind: "file-read" },
  sendmessage: { itemType: "dynamic_tool", requestKind: "command" },
  task: { itemType: "dynamic_tool", requestKind: "command" },
  taskstop: { itemType: "dynamic_tool", requestKind: "command" },
  todowrite: { itemType: "dynamic_tool", requestKind: "command" },
  toolsearch: { itemType: "dynamic_tool", requestKind: "command" },
  webfetch: { itemType: "web_search", requestKind: "command" },
  websearch: { itemType: "web_search", requestKind: "command" },
  write: { itemType: "file_change", requestKind: "file-change" },
};

const normalized = (tool: string): string => tool.toLowerCase().replaceAll(/[\s_-]/g, "");

export function classifyTool(tool: string): Classification {
  return KNOWN[normalized(tool)] ?? { itemType: "dynamic_tool", requestKind: "command" };
}

/** Claude's tool input, parsed from the event body (a JSON string). */
export function parseToolInput(body: string | undefined): unknown {
  if (body === undefined || body === "") return {};
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** The fields every turn item shares, filled in by the mapper. */
export type ItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
  "type" | "toolName" | "input" | "output" | "viewedImagePath" | "outputOmitted"
>;

export interface ToolResult {
  readonly body: string;
  readonly isError: boolean;
  readonly result: unknown;
}

function stdoutOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { stdout, stderr } = result as Record<string, unknown>;
  if (typeof stdout !== "string" && typeof stderr !== "string") return undefined;
  return [stdout, stderr].filter((s): s is string => typeof s === "string" && s !== "").join("\n");
}

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

function isHunk(value: unknown): value is Hunk {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.oldStart === "number" &&
    typeof h.oldLines === "number" &&
    typeof h.newStart === "number" &&
    typeof h.newLines === "number" &&
    Array.isArray(h.lines) &&
    h.lines.every((l) => typeof l === "string")
  );
}

/** A unified diff from the Edit tool's structuredPatch, when the result carries one. */
export function unifiedDiff(fileName: string, result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const patch = (result as Record<string, unknown>).structuredPatch;
  if (!Array.isArray(patch) || patch.length === 0 || !patch.every(isHunk)) return undefined;
  const out = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const h of patch) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
  }
  return out.join("\n");
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * The turn item for a tool call, before and after its result. `result` is
 * undefined while the call runs.
 */
export function toolItem(
  base: ItemBase,
  tool: string,
  input: unknown,
  result: ToolResult | undefined,
): OrchestrationV2TurnItem {
  const { itemType } = classifyTool(tool);
  const failed = result?.isError === true;
  const status = result === undefined ? "running" : failed ? "failed" : "completed";
  const common = { ...base, status } as const;
  switch (itemType) {
    case "command_execution": {
      const output = result === undefined ? undefined : (stdoutOf(result.result) ?? result.body);
      return {
        ...common,
        type: "command_execution",
        input:
          field(input, "command") ?? (typeof input === "string" ? input : JSON.stringify(input)),
        ...(output === undefined || output === "" ? {} : { output }),
        ...(failed ? { outputIndicatesFailure: true } : {}),
      };
    }
    case "file_change": {
      const fileName =
        field(input, "file_path") ?? field(input, "notebook_path") ?? field(input, "path") ?? tool;
      const diff = result === undefined ? undefined : unifiedDiff(fileName, result.result);
      const oldStr = field(input, "old_string");
      const newStr = field(input, "new_string") ?? field(input, "content");
      return {
        ...common,
        type: "file_change",
        fileName,
        ...(diff === undefined ? {} : { diffStr: diff, ...countDiff(diff) }),
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
      };
    }
    case "web_search": {
      const pattern = field(input, "query") ?? field(input, "url");
      const url = field(input, "url");
      return {
        ...common,
        type: "web_search",
        ...(pattern === undefined ? {} : { patterns: [pattern] }),
        ...(result === undefined || result.body === ""
          ? {}
          : {
              results: [
                { ...(url === undefined ? {} : { url }), snippet: result.body.slice(0, 2000) },
              ],
            }),
      };
    }
    case "dynamic_tool":
      return {
        ...common,
        type: "dynamic_tool",
        toolName: tool === "" ? null : tool,
        input,
        ...(result === undefined ? {} : { output: result.body }),
      };
  }
}
