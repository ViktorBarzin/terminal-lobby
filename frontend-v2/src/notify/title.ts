/**
 * Tab-title state badge (inventory Cat.9, high-risk). Ported from the vanilla
 * frontend's `updateTitle`. The lobby owns the tab title and prefixes it with:
 *
 *   1. an attention prefix `● <session> ` while a bell/output signal is latched
 *      (cleared the moment the user looks again — see attention.ts), then
 *   2. a count badge for the MAX-priority state across ALL sessions, precedence
 *      awaiting `(N●)` > running `(N⋯)` > unseen-done `(N✓)` (mirrors T3's pill
 *      ranking), then
 *   3. the body: while a session is active, its live pane command — "claude —
 *      worktree" — falling back to "tmux: <user>/<session>" until the poll knows
 *      a command; with nothing active, the base title.
 *
 * Both functions are PURE and unit-tested. The count of unseen-done is supplied
 * by an injectable predicate: real seen/visit tracking is a separate subsystem
 * (inventory Cat.2, not yet ported), so the default treats every `done` session
 * as unseen — consistent with the current SessionCard placeholder. Swap the
 * predicate in once seen-tracking lands.
 */

export type TitleSession = {
  name: string;
  state?: string;
  pane_current_command?: string;
};

export interface TitleCounts {
  awaiting: number;
  running: number;
  unseenDone: number;
}

/** The leading count badge (with trailing space), or "" when nothing to badge. */
export function titleBadge(c: TitleCounts): string {
  if (c.awaiting > 0) return "(" + c.awaiting + "●) "; // ●
  if (c.running > 0) return "(" + c.running + "⋯) "; // ⋯
  if (c.unseenDone > 0) return "(" + c.unseenDone + "✓) "; // ✓
  return "";
}

export interface TitleParts {
  sessions: readonly TitleSession[];
  /** the '● <name>' attention latch, or null. */
  attentionSession: string | null;
  /** the session currently attached, or null. */
  activeSession: string | null;
  /** OS user, for the "tmux: <user>/<session>" fallback body. */
  osUser: string;
  /** the document title with nothing active. */
  baseTitle: string;
  /** counts a `done` session as unseen (default: all done are unseen). */
  isUnseen?: (s: TitleSession) => boolean;
}

/** Compose the full document.title string (attention prefix + badge + body). */
export function composeTitle(p: TitleParts): string {
  const isUnseen = p.isUnseen ?? ((s: TitleSession) => s.state === "done");
  const counts: TitleCounts = {
    awaiting: p.sessions.filter((s) => s.state === "awaiting").length,
    running: p.sessions.filter((s) => s.state === "running").length,
    unseenDone: p.sessions.filter(isUnseen).length,
  };
  const badge = titleBadge(counts);
  const attention = p.attentionSession ? "● " + p.attentionSession + " " : "";
  const active =
    p.activeSession != null
      ? p.sessions.find((s) => s.name === p.activeSession)
      : undefined;
  const cmd = active?.pane_current_command;
  const body = p.activeSession
    ? cmd
      ? cmd + " — " + p.activeSession // em dash
      : "tmux: " + p.osUser + "/" + p.activeSession
    : p.baseTitle;
  return attention + badge + body;
}
