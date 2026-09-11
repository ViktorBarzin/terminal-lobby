/**
 * Answering an AskUserQuestion: one choice, one request.
 *
 * The browser no longer plans a walk. It renders the question the pane is
 * drawing, sends the reader's choice, and renders whatever comes back. The
 * server answers that one question and takes the next reading, so nothing here
 * predicts a screen.
 *
 * That prediction is what this replaces. The old client set each step's
 * expectation to the NEXT question's text and the last step's to the review
 * screen's title, then stopped when it did not find one. Over 10 days of field
 * data four-question answers failed 4 times in 5, every failure a `desync`
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
 *
 * The Go types this mirrors are in `sessionio/answerapi.go`; keep the two in
 * step.
 */

import { answerUrl } from "./config";
import { fetchWithDeadline } from "./http";

/** One option a question offers. */
export interface DialogOptionView {
  label: string;
  description?: string;
  /**
   * The multi-select box the pane drew FILLED. Always absent on a
   * single-select question, which draws no boxes.
   *
   * This is what lets a second pick add to a multi-select rather than replace
   * it. Space is a toggle, so the server answers one by diffing the set it is
   * asked for against the boxes on screen, and the card can only ask for the
   * right set if it can see what the CLI is already holding
   * (`sessionio.DialogOption.Checked`).
   */
  checked?: boolean;
}

/** One question, shaped as the tool was called so the card needs no special case. */
export interface DialogQuestionView {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: DialogOptionView[];
}

/**
 * A reading of the dialog, mirroring `sessionio.Dialog`.
 *
 * `answered` is how many boxes the tab bar marks `☒`. It is a PROGRESS signal
 * and not a position: measured 2026-09-10, a multi-select question's box fills
 * on the first Space, before the Enter that leaves the question, so `answered`
 * runs one ahead there. Which question is on screen comes from `questions[0]`,
 * which is what the pane is actually drawing.
 */
export interface DialogView {
  questions: DialogQuestionView[];
  headers?: string[];
  count: number;
  partial?: boolean;
  answered?: number;
}

/** Why a request was not applied. Empty means it was. */
export type AnswerReason = "not-drawn" | "no-dialog" | "unknown-option" | "refused" | "unverified";

/**
 * Which of the CLI's landmarks a capture carried, for a screen the parser could
 * not fully read. Structure only, never screen text (ADR-0008).
 */
export interface DialogMarkers {
  tabBar: boolean;
  answeredBox: boolean;
  openBox: boolean;
  reviewTitle: boolean;
  readyPrompt: boolean;
  footer: boolean;
  numberedList: boolean;
  freeText: boolean;
  chatOption: boolean;
}

/** What the pane shows once the request has been applied, or refused. */
export interface AnswerResponse {
  applied: boolean;
  reason?: AnswerReason;
  /** The reading taken AFTER the request; absent when the screen was unreadable. */
  dialog?: DialogView;
  /** The pane is on the review screen, where the only action left is Submit. */
  review?: boolean;
  /** The dialog is gone. A successful Submit reports itself this way. */
  done?: boolean;
  /** The raw capture, sent only when `dialog` is absent and `done` is false. */
  pane?: string;
  markers?: DialogMarkers;
}

/** One request: a choice, a navigation, a submit, or raw keys. */
export interface AnswerRequest {
  header?: string;
  /** One label. Shorthand for a `choices` of exactly one. */
  choice?: string;
  /**
   * Every label the question should be left holding.
   *
   * A MULTI-SELECT REQUEST IS THE DESIRED FINAL STATE, NOT A DELTA. The
   * server diffs it against the boxes the pane has ticked and toggles only
   * the rows that differ, so a reader adding a second fruit sends both of
   * them and the first survives. Measured 2026-09-11 with Apple ticked and
   * the cursor on its row: naming Pear alone plans [Space Down Space], and
   * that first Space unticks Apple.
   *
   * Sending one label is still how a pick is REPLACED, which is what the
   * revisit flow is for. `choice` and `choices` may both be sent only when
   * they name the same single row; a request that means two different things
   * is refused rather than resolved (`sessionio/answerapi.go`).
   */
  choices?: string[];
  text?: string;
  back?: string;
  submit?: boolean;
  keys?: string[];
}

/**
 * The label the CLI gives its free-text option.
 *
 * Measured on CLI 2.1.267: the row reads "Type something." The frontend called
 * it "Other" until 2026-09-10, which was harmless only because the digit
 * position happened to match. Both are accepted so a client and a server on
 * different builds still agree.
 */
export const FREE_TEXT_LABEL = "Type something";
export const LEGACY_FREE_TEXT_LABEL = "Other";
export const CHAT_LABEL = "Chat about this";

/** Whether this option label opens the free-text field rather than answering. */
export function isFreeText(label: string): boolean {
  const l = label.replace(/\.$/, "");
  return l === FREE_TEXT_LABEL || l === LEGACY_FREE_TEXT_LABEL;
}

/**
 * What the CARD offers as an answer: the dialog's list without the chat escape.
 *
 * "Chat about this" is not an answer — it abandons the question and hands the
 * reader the composer — so it belongs with the actions, not in the option list.
 */
export function answerableOptions(q: DialogQuestionView): DialogOptionView[] {
  return q.options.filter((o) => o.label !== CHAT_LABEL);
}

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
