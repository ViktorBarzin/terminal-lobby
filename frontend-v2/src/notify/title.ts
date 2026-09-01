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
 * by an injectable predicate, so this module stays pure: notifications.ts passes
 * the real one from the visit store (store/visits.ts — a `done` session counts
 * only until the user looks at it), and the same predicate drives the favicon's
 * green tick so both badges clear together. The bare default (every `done` is
 * unseen) is what a caller without a visit store gets.
 */

export type TitleSession = {
  name: string;
  /** tmux's session id, the one identifier a rename does not change. */
  id?: string;
  /** The display title, when the session has one. */
  title?: string;
  state?: string;
  pane_current_command?: string;
  /**
   * The OS user who owns it, when that is NOT the viewer — a session shared with
   * you through a project or a direct share. Absent for your own.
   *
   * Carried so the app-icon badge can leave other people's work out of "how many
   * are waiting for you". The push sender only ever sees the caller's own tmux
   * server, so without this the page's count and the server's could not agree
   * for anyone who has been shared a session.
   */
  owner?: string;
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
  // The tab speaks in titles like every other surface. Both the attention latch
  // and the body look the session up so a titled one reads as its title; a
  // session with no title, or one the poll has not caught up with, falls back
  // to its name exactly as before.
  const labelFor = (name: string): string => {
    const s = p.sessions.find((x) => x.name === name);
    return s?.title || name;
  };
  const attention = p.attentionSession ? "● " + labelFor(p.attentionSession) + " " : "";
  const active =
    p.activeSession != null
      ? p.sessions.find((s) => s.name === p.activeSession)
      : undefined;
  const cmd = active?.pane_current_command;
  const body = p.activeSession
    ? cmd
      ? cmd + " — " + labelFor(p.activeSession) // em dash
      : "tmux: " + p.osUser + "/" + labelFor(p.activeSession)
    : p.baseTitle;
  return attention + badge + body;
}
