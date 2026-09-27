/**
 * POST /answer: a held AskUserQuestion answered as data (ADR-0034), or Claude
 * Code's plan approval answered one action at a time.
 *
 * The Go types this mirrors are in `sessionio/answerapi.go`; keep the two in
 * step.
 */

import { answerUrl } from "./config";
import { fetchWithDeadline } from "./http";

/**
 * One approve row of Claude Code's plan approval: the digit that selects it,
 * and its label exactly as drawn (`sessionio.PlanOption`).
 */
export interface PlanOptionView {
  number: number;
  label: string;
}

/**
 * A reading of a dialog on the pane, mirroring `sessionio.Dialog`: the plan
 * approval (`kind: "plan"`) or a tool permission prompt (`kind:
 * "permission"`). An AskUserQuestion is not read off the pane any more; the
 * lobby's hook holds it and it arrives as a `held` event (ADR-0034).
 * `planFromPane` (components/timeline.logic.ts) is the checked way to read the
 * plan half.
 */
export interface DialogView {
  kind?: "plan" | "permission";
  /**
   * The plan approval's approve rows, as drawn. The labels change between
   * sessions ("(6% used)" climbs, and auto mode or the clear context option
   * may be missing), so a card shows these rather than words of its own.
   */
  options?: PlanOptionView[];
  /** The "Tell Claude what to change" row: 4 with three approve rows, 3 with two. */
  feedbackRow?: number;
  /** The plan file the footer names, "~/.claude/plans/<slug>.md". */
  planPath?: string;
  /** A permission prompt's first line, "Bash command" (sessionio permdialog.go). */
  title?: string;
  /** What the tool will do, as the permission prompt draws it. */
  detail?: string[];
  /** The permission prompt's question, "Do you want to proceed?". */
  prompt?: string;
}

/** Why a request was not applied. Empty means it was. */
export type AnswerReason =
  | "not-drawn"
  | "no-dialog"
  | "unknown-option"
  | "refused"
  | "unverified"
  /** Nothing holds a question for this session: answer it in the Terminal. */
  | "not-held"
  /** A held call was answered with a question left empty. */
  | "incomplete";

/** The outcome of one request, and for a plan answer what the pane shows next. */
export interface AnswerResponse {
  applied: boolean;
  reason?: AnswerReason;
  /** The plan approval as read AFTER the request; absent when none is on screen. */
  dialog?: DialogView;
  /** The dialog is gone: the answer landed. */
  done?: boolean;
}

/** One request: a held call's answers, a decline, or a plan answer. */
export interface AnswerRequest {
  /**
   * A whole AskUserQuestion call answered at once, keyed by each question's
   * text, for a call the lobby's hook is holding
   * (`sessionio.AnswerRequest.Answers`). One label for a single-select, the
   * labels picked for a multi-select, or the free-text answer's words.
   */
  answers?: Record<string, string[]>;
  /** Decline a held call and hand Claude these words instead ("Chat about
   *  this"). An empty string declines with no words. */
  chat?: string;
  /** An answer to the plan approval. */
  plan?: PlanAnswer;
}

/**
 * One answer to the plan approval, mirroring `sessionio.PlanAnswer`.
 *
 * An approve row goes by its number AND the label the reader saw on it: the
 * server refuses a label that is not the one drawn now as `unknown-option`,
 * rather than approving with whatever row carries that number today.
 *
 * Feedback is typed into the feedback row and read back before the committing
 * key: `approve: false` presses Enter, which sends the words back and Claude
 * keeps planning; `approve: true` presses Shift+Tab, "approve with this
 * feedback". It is one line of at most 2,000 bytes and must not be blank.
 */
export type PlanAnswer = { option: number; label: string } | { feedback: string; approve: boolean };

/**
 * Send one request and return the reading that came back.
 *
 * Returns null only when the call itself failed. A REFUSED request is not an
 * error: it comes back with `applied: false`, a reason, and the current
 * reading, which is what lets the card re-render against what is actually on
 * screen instead of latching.
 */
export async function sendAnswer(
  session: string,
  req: AnswerRequest,
): Promise<AnswerResponse | null> {
  try {
    const res = await fetchWithDeadline(answerUrl(session), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    return (await res.json()) as AnswerResponse;
  } catch {
    return null;
  }
}
