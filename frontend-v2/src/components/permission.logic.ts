import { parseJSON } from "./canonicalize";
import type { PermissionReading } from "./timeline.logic";
import type { Event } from "../types/events";

/**
 * What the permission card shows in its well, read from the call the prompt
 * asks about rather than from the pane.
 *
 * The pane draws a tool's prompt for a terminal: an Edit's diff with its
 * unchanged lines first and colour as the only mark of what changed, a Bash
 * command behind a bar with "This command requires approval" under it. The
 * card has that text without the colour, and a 4-line well, so for an Edit
 * that appends a function it showed the two unchanged lines above the change
 * and hid the change itself (found live on 2026-09-27). The transcript holds
 * the call's own input, which says exactly what the reader is approving.
 *
 * `null` when no call waiting in the transcript matches the prompt, and the
 * card then shows the pane's own lines, as it did before.
 */
export type PermissionPreview =
  | { kind: "command"; command: string; description: string }
  | { kind: "diff"; file: string; lines: DiffLine[] };

/** One line of an Edit's change: kept, taken out, or put in. */
export interface DiffLine {
  sign: " " | "-" | "+";
  text: string;
}

/** A call in the transcript with no result yet. */
interface Waiting {
  tool: string;
  input: Record<string, unknown>;
}

/** Unchanged lines kept on each side of a change, so it reads in place. */
const CONTEXT = 1;

/** The calls with no result yet, oldest first. */
function waitingCalls(events: readonly Event[]): Waiting[] {
  const open = new Map<string, Waiting>();
  for (const e of events) {
    if (e.kind === "tool_use" && e.toolId && e.tool) {
      const input = parseJSON(e.body);
      open.set(e.toolId, {
        tool: e.tool,
        input: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
      });
    } else if (e.kind === "tool_result" && e.toolId) {
      open.delete(e.toolId);
    }
  }
  return [...open.values()];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** The lines that changed between `from` and `to`, with CONTEXT kept lines
 *  either side. Lines shared at both ends are the context. */
function diffLines(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  // A blank line says nothing about where the change sits or what it is, and
  // takes a line of a small well: the kept lines shown are the nearest ones
  // with words in them, and each changed block drops blank lines at its ends.
  const words = (text: string): boolean => text.trim() !== "";
  const kept = (lines: string[]): DiffLine[] =>
    lines.filter(words).map((text) => ({ sign: " ", text }));
  const block = (lines: string[], sign: "-" | "+"): DiffLine[] => {
    let from = 0;
    let to = lines.length;
    while (from < to && !words(lines[from]!)) from++;
    while (to > from && !words(lines[to - 1]!)) to--;
    return lines.slice(from, to).map((text) => ({ sign, text }));
  };
  const before = kept(a.slice(0, head)).slice(-CONTEXT);
  const after = kept(a.slice(a.length - tail)).slice(0, CONTEXT);
  return [
    ...before,
    ...block(a.slice(head, a.length - tail), "-"),
    ...block(b.slice(head, b.length - tail), "+"),
    ...after,
  ];
}

/** An Edit's or MultiEdit's change, each edit's lines one after another. */
function editLines(c: Waiting): DiffLine[] {
  const edits =
    c.tool === "MultiEdit" && Array.isArray(c.input.edits)
      ? (c.input.edits as unknown[]).map((x) => (x && typeof x === "object" ? x : {}))
      : [c.input];
  const out: DiffLine[] = [];
  for (const e of edits as Record<string, unknown>[]) {
    if (out.length > 0) out.push({ sign: " ", text: "…" });
    out.push(...diffLines(str(e.old_string), str(e.new_string)));
  }
  return out;
}

/** The words of a Bash command with its whitespace collapsed, for comparing
 *  it with the pane's wrapped lines. */
const squash = (s: string): string => s.replace(/[\s│▏|]+/g, " ").trim();

/**
 * The preview for this prompt: the oldest waiting call of the tool the prompt
 * names whose target the prompt's lines also name. A Bash prompt is matched on
 * its command, an Edit on its file's name.
 */
export function permissionPreview(
  reading: PermissionReading,
  events: readonly Event[],
): PermissionPreview | null {
  const title = reading.title.trim().toLowerCase();
  const shown = squash(reading.detail.join(" "));
  const calls = waitingCalls(events);
  if (title.startsWith("bash")) {
    for (const c of calls) {
      if (c.tool !== "Bash") continue;
      const command = str(c.input.command);
      const head = squash(command).slice(0, 40);
      if (command && head && shown.includes(head)) {
        return { kind: "command", command, description: str(c.input.description) };
      }
    }
    return null;
  }
  if (title.startsWith("edit")) {
    for (const c of calls) {
      if (c.tool !== "Edit" && c.tool !== "MultiEdit") continue;
      const file = baseName(str(c.input.file_path));
      const first = (reading.detail[0] ?? "").trim();
      if (!file || baseName(first) !== file) continue;
      const lines = editLines(c);
      if (lines.length > 0) return { kind: "diff", file: first, lines };
    }
  }
  return null;
}
