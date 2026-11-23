import { isT3Session, sessionLabel, SUSPENDED, type Session } from "../types/lobby";
import { agoLabel, backgroundLabel, formatWorking } from "./lobby.logic";
import { lastActiveAt } from "../logic/order.logic";
import { TOOL_LABELS } from "./ToolIcon";

/**
 * The phone's session row, in words (T3 pass on the list, 2026-11-23).
 *
 * T3 Code's mobile home screen gives each thread two lines: the title, then a
 * line of what it is and what it is doing, with ONE thing on the right — a
 * status chip or a time. A T3 thread's mark sits beside that chip, on the
 * title line, so it costs no line of its own. The lobby's desktop row says the same facts with a
 * dot, a tool mark, a T3 glyph and a string of badges on one line, which is
 * what a 390px screen cannot fit. These functions are that row's text, kept
 * pure so its wording is pinned by test/phone-row.logic.test.ts.
 */

/** The one thing on the right of a phone row. */
export type PhoneChip =
  | { kind: "need"; text: string }
  | { kind: "run"; text: string }
  | { kind: "done"; text: string }
  | { kind: "age"; text: string };

/**
 * What the right of the row says, most urgent first: the session is waiting on
 * you, it is working (and for how long), it finished since you last looked, or
 * how long ago you last wrote to it.
 *
 * `workingSince` is this tab's own stamp of the turn starting, for a server
 * that sends no `lastPrompt`; the desktop row's timer reads the same pair.
 */
export function phoneChip(
  s: Session,
  opts: { unseen: boolean; now: number; workingSince?: number },
): PhoneChip | null {
  if (s.state === "awaiting") return { kind: "need", text: "Needs you" };
  if (s.state === "running") {
    const since = s.lastPrompt ? s.lastPrompt * 1000 : opts.workingSince;
    return since ? { kind: "run", text: formatWorking(opts.now - since) } : null;
  }
  if (opts.unseen) return { kind: "done", text: "Done" };
  const at = lastActiveAt(s);
  if (!at) return null;
  return { kind: "age", text: agoLabel(opts.now - at * 1000).replace(" ago", "") };
}

/**
 * The second line: what kind of session this is and what it is doing, joined
 * with " · ". Empty for an idle Claude session of your own, which needs no
 * explanation.
 *
 * `project` leads the line only where no group header above the row already
 * says it, which is the search results.
 */
export function phoneMeta(
  s: Session,
  opts: { project?: string; foreign?: boolean; watching?: boolean } = {},
): string {
  const parts: string[] = [];
  if (opts.project) parts.push(opts.project);
  if (s.state === "running") {
    const bg = backgroundLabel(s.bg);
    parts.push(bg ? `working · ${bg}` : "working");
  } else if (s.state === "awaiting") {
    parts.push("waiting for you");
  } else if (s.state === SUSPENDED) {
    parts.push("suspended, tap to resume");
  }
  // A T3 thread is marked by the glyph on the title line instead: the word
  // alone gave an idle T3 row a whole second line (Viktor, 2026-11-23).
  if (!isT3Session(s) && s.tool && s.tool !== "claude") parts.push(TOOL_LABELS[s.tool]);
  if (opts.foreign && s.owner) {
    parts.push(`${s.owner}'s`);
    if (s.access !== "rw") parts.push("read-only");
  } else if ((s.guests ?? []).length > 0) {
    parts.push("shared");
  }
  if (opts.watching && !opts.foreign) parts.push("opens as a viewer");
  return parts.join(" · ");
}

/**
 * Does this session answer the list's search box?
 *
 * Every word of the query has to appear somewhere in the title, the tmux name
 * or the project, case-insensitively and in any order. Titles only for now:
 * matching what was SAID in a session needs a search across transcripts that
 * the server does not offer yet (Viktor, 2026-11-23).
 */
export function matchesSearch(s: Session, project: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [sessionLabel(s), s.name, project].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}
