import type { Question } from "./canonicalize";

/**
 * Answering an AskUserQuestion from the text view.
 *
 * The dialog belongs to the CLI, drawn in its own pane, and the only way back in
 * is the keyboard (ADR-0010). What this file does is turn a set of answers a
 * reader assembled in the browser into the keystrokes that produce them — and,
 * just as importantly, into what the pane should look like afterwards, so the
 * sequence can check it landed instead of typing on in the dark.
 *
 * The CLI's behaviour here was read out of the shipped binary (2.1.234) rather
 * than assumed:
 *
 *   - digits 1-9 select an option directly
 *   - Space toggles the focused option when the question is multi-select
 *   - ONE question that is not multi-select submits the moment it is answered
 *   - anything else — multi-select, or two to four questions — walks to a review
 *     screen that needs a final Submit
 *   - an option that takes free text is focused rather than submitted, and the
 *     text is typed into it
 *
 * Nothing is typed until the reader presses Send. Until then the walk is
 * entirely local, so abandoning it halfway leaves the dialog untouched.
 */

/** One question's answer as the reader assembled it, before anything is typed. */
export interface DraftAnswer {
  /** Option labels chosen, in the order the option list shows them. */
  chosen: string[];
  /** Free text, when the reader picked the "Other" option. */
  other?: string;
}

/**
 * A step is one question's worth of typing, plus what proves it worked.
 *
 * The batches inside a step go in back to back: there is nothing to check
 * between two toggles of the same question. The check happens at the question
 * boundary, where the pane visibly moves on — which is also the only place we
 * have something to check AGAINST, since the next question's text comes from the
 * transcript.
 */
export interface AnswerStep {
  /** Key batches, each within MAX_ANSWER_KEYS. */
  batches: string[][];
  /** Free text typed after the batches, for an "Other" answer. */
  text?: string;
  /** Keys sent after the text has been confirmed to be in the field. */
  after?: string[];
  /**
   * A fragment that must appear in the pane once this step has landed. Empty
   * means there is nothing to check — the dialog is gone by then, and the
   * transcript is what confirms the answer.
   */
  expect: string;
  /** What this step was doing, for the message when it does not land. */
  what: string;
}

/**
 * The server's cap on one batch (sessionio.MaxKeys). Chunking to it here keeps
 * that cap where it is: it exists to stop a browser typing a paragraph into
 * somebody's shell, and a wizard walk is no reason to widen it.
 */
export const MAX_ANSWER_KEYS = 8;

/** The label the CLI gives its free-text option, and the one for deferring. */
export const OTHER_LABEL = "Other";
export const CHAT_LABEL = "Chat about this";

/** What the review screen says, and what we look for to know we reached it. */
export const REVIEW_MARKER = "Review your answers";

/**
 * True when this call is the shape the CLI submits immediately: exactly one
 * question, and not a multi-select one. It is also the only shape the text view
 * could answer before this.
 */
export function submitsImmediately(questions: Question[]): boolean {
  return questions.length === 1 && !questions[0]!.multiSelect;
}

/** Every option the dialog shows, including the two the tool always appends. */
export function shownOptions(q: Question): string[] {
  return [...q.options.map((o) => o.label), OTHER_LABEL, CHAT_LABEL];
}

/**
 * What the CARD offers as an answer: the dialog's list without the chat escape.
 *
 * "Chat about this" is not an answer — it abandons the question and hands the
 * reader the composer, and it acts the moment it is pressed, while every other
 * row is a draft nothing acts on until Submit. In the same list, told apart only
 * by an arrow, it read as one more option; it belongs with the actions.
 *
 * `shownOptions` above stays the DIALOG's list, because that is what `keysFor`
 * counts to pick the digit to inject. The number beside a row is still taken
 * from there — the key we type has to be the key the CLI is listening for.
 */
export function answerableOptions(q: Question): string[] {
  return shownOptions(q).filter((label) => label !== CHAT_LABEL);
}

/** Where an option sits in the dialog's list, or -1. */
export function optionIndex(q: Question, label: string): number {
  return shownOptions(q).indexOf(label);
}

/** Split a run of keys into batches the keys route will accept. */
export function batched(keys: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_ANSWER_KEYS) {
    out.push(keys.slice(i, i + MAX_ANSWER_KEYS));
  }
  return out;
}

/**
 * The keys that answer ONE question.
 *
 * Single-select uses the digit, which selects directly. Multi-select navigates
 * and presses Space on each chosen option, because the digit path and the space
 * path are not the same call inside the CLI and only the latter is documented by
 * its own `isMultiSelect` branch as a toggle.
 */
function keysForQuestion(q: Question, a: DraftAnswer): string[] {
  const opts = shownOptions(q);
  if (!q.multiSelect) {
    const i = opts.indexOf(a.chosen[0] ?? "");
    return i >= 0 ? [String(i + 1)] : [];
  }
  // Toggle in list order, so the cursor only ever moves downward and each hop is
  // the difference between two indexes.
  const wanted = a.chosen
    .map((label) => opts.indexOf(label))
    .filter((i) => i >= 0)
    .sort((x, y) => x - y);
  const keys: string[] = [];
  let at = 0;
  for (const i of wanted) {
    for (let n = 0; n < i - at; n++) keys.push("Down");
    keys.push("Space");
    at = i;
  }
  return keys;
}

/**
 * Turn the walk's answers into the sequence that produces them.
 *
 * Returns an empty plan when there is nothing to send, so a caller never types
 * a bare Enter into somebody's dialog on an empty answer.
 */
export function planAnswer(questions: Question[], answers: DraftAnswer[]): AnswerStep[] {
  if (questions.length === 0) return [];
  const steps: AnswerStep[] = [];

  questions.forEach((q, i) => {
    const a = answers[i] ?? { chosen: [] };
    const last = i === questions.length - 1;
    // What proves this question is behind us: the next question's text, or the
    // review screen. A call the CLI submits outright leaves nothing to check.
    const expect = last
      ? submitsImmediately(questions)
        ? ""
        : REVIEW_MARKER
      : questions[i + 1]!.question;
    const what = `answering "${q.header || q.question}"`;

    if (a.chosen[0] === OTHER_LABEL && (a.other ?? "").trim()) {
      const idx = optionIndex(q, OTHER_LABEL);
      steps.push({
        // The digit FOCUSES a free-text option rather than submitting it, which
        // is exactly what is wanted: focus, type, then confirm.
        batches: [[String(idx + 1)]],
        text: a.other!.trim(),
        after: ["Enter"],
        expect,
        what,
      });
      return;
    }

    const keys = keysForQuestion(q, a);
    if (keys.length === 0) return;
    const batches = batched(keys);
    // A multi-select question has toggled its options but not moved on; Enter is
    // what leaves it. A single-select digit has already moved on by itself.
    if (q.multiSelect) batches.push(["Enter"]);
    steps.push({ batches, expect, what });
  });

  if (steps.length === 0) return [];

  // The review screen needs its own Submit. A call the CLI submits outright
  // never shows one.
  if (!submitsImmediately(questions)) {
    steps.push({ batches: [["Enter"]], expect: "", what: "submitting the answers" });
  }
  return steps;
}

/**
 * One reading of a multi-question dialog off the pane.
 *
 * The same shape `askingFromPane` returns. It lives here because the pane walk
 * plans from it, and the planner is pure so the walk is testable without a
 * session (timeline.logic re-exports the type it builds).
 */
export interface PaneDialog {
  questions: Question[];
  headers: string[];
  count: number;
  /** How many questions the tab bar marks `☒`. */
  answered: number;
  partial: boolean;
}

/**
 * What answers the ONE question a partial dialog is currently drawing.
 *
 * A multi-question call cannot be planned whole from the pane: only the question
 * on screen has been drawn, and each next one appears as the one before it is
 * answered. So the walk is one step at a time, and the step's expectation is the
 * tab bar filling in the box of the question just left — `☒ Fruit`. Not the next
 * question's text, which is exactly what is unknown here.
 *
 * At the review screen every box is filled and Enter commits, which leaves no
 * dialog to check, the same way `planAnswer`'s own final submit does.
 */
export function planPaneStep(d: PaneDialog, a: DraftAnswer): AnswerStep[] {
  if (d.answered >= d.count) {
    return [{ batches: [["Enter"]], expect: "", what: "submitting the answers" }];
  }
  const q = d.questions[0];
  if (!q) return [];
  // The header whose box should fill. Absent when the tab bar could not be
  // read, and then there is nothing to wait for — one question still goes in,
  // and the walk stops after it either way, because the next reading is what
  // supplies the next question.
  //
  // For a MULTI-SELECT question this check is weaker than it looks. Measured
  // against Claude Code on 2026-09-04: the box fills on the first Space, before
  // the Enter that leaves the question — `←  ☐ Picks  ☐ One` became
  // `←  ☒ Picks  ☐ One` with only a toggle sent. So it still catches the case
  // that matters, nothing landing at all, and it does NOT catch a toggle that
  // landed while its Enter did not. The cost of that gap is a step number one
  // ahead of the question on screen; the card always answers the question the
  // pane is drawing, so it cannot put an answer against the wrong question.
  const header = d.headers[d.answered] ?? "";
  const expect = header ? `${ANSWERED_MARK} ${header}` : "";
  const what = `answering "${q.header || q.question}"`;

  if (a.chosen[0] === OTHER_LABEL) {
    const other = (a.other ?? "").trim();
    if (!other) return [];
    const idx = optionIndex(q, OTHER_LABEL);
    if (idx < 0) return [];
    return [{ batches: [[String(idx + 1)]], text: other, after: ["Enter"], expect, what }];
  }

  const keys = keysForQuestion(q, a);
  if (keys.length === 0) return [];
  const batches = batched(keys);
  if (q.multiSelect) batches.push(["Enter"]);
  return [{ batches, expect, what }];
}

/**
 * The glyph the CLI's tab bar draws for a question it has an answer for.
 *
 * `☐` is still open. sessionio counts the same character to report `answered`
 * (dialog.go tabAnswered), so the two agree by construction.
 */
export const ANSWERED_MARK = "☒";

/** Whether every question has something to send. */
export function complete(questions: Question[], answers: DraftAnswer[]): boolean {
  if (questions.length === 0) return false;
  return questions.every((q, i) => {
    const a = answers[i];
    if (!a || a.chosen.length === 0) return false;
    if (a.chosen[0] === OTHER_LABEL) return !!(a.other ?? "").trim();
    return a.chosen.every((label) => optionIndex(q, label) >= 0);
  });
}

/** What the runner needs of the session, kept narrow so it tests without one. */
export interface AnswerIO {
  /** Type keys into the pane. False when the session refused them. */
  keys: (keys: string[]) => Promise<boolean>;
  /** Type free text into the pane without submitting it. */
  text: (text: string) => Promise<boolean>;
  /** Read what the pane currently shows. */
  pane: () => Promise<string | null>;
}

export type AnswerResult =
  | { ok: true }
  | { ok: false; reason: "refused" | "desync" | "unreadable"; what: string };

/**
 * How long to wait before reading the pane back, and how many times to look.
 *
 * The dialog repaints a frame or two after the keystroke, so the first read can
 * still show the previous screen. Two looks cover that without turning a real
 * desync into a long stall.
 */
export const PANE_CHECK_DELAYS_MS = [90, 220];

/**
 * Run a plan, checking the pane between questions.
 *
 * The check is the point. The keys go into a live TUI that we do not control and
 * whose wording changes between releases, so a step that did not land has to
 * STOP the sequence — the alternative is typing the rest of the answers into
 * whatever screen is actually there, which is how a wrong answer gets submitted
 * without anyone seeing it happen. A stopped sequence leaves a half-answered
 * dialog, which the reader can finish in the Terminal; that is recoverable, and
 * a wrong answer is not.
 */
export async function runAnswer(
  steps: AnswerStep[],
  io: AnswerIO,
  delays: number[] = PANE_CHECK_DELAYS_MS,
): Promise<AnswerResult> {
  for (const step of steps) {
    for (const batch of step.batches) {
      if (!(await io.keys(batch))) return { ok: false, reason: "refused", what: step.what };
    }
    if (step.text !== undefined) {
      if (!(await io.text(step.text))) return { ok: false, reason: "refused", what: step.what };
      // Confirm the text is in the field BEFORE the Enter that commits it — an
      // Enter on an empty field answers the question with nothing.
      const seen = await checkPane(io, step.text, delays);
      if (seen !== true) {
        return { ok: false, reason: seen === null ? "unreadable" : "desync", what: step.what };
      }
    }
    if (step.after) {
      if (!(await io.keys(step.after))) return { ok: false, reason: "refused", what: step.what };
    }
    if (step.expect) {
      const seen = await checkPane(io, step.expect, delays);
      if (seen !== true) {
        return { ok: false, reason: seen === null ? "unreadable" : "desync", what: step.what };
      }
    }
  }
  return { ok: true };
}

/** true = found, false = the pane showed something else, null = unreadable. */
async function checkPane(io: AnswerIO, want: string, delays: number[]): Promise<boolean | null> {
  let read = false;
  for (const wait of delays) {
    await new Promise((r) => setTimeout(r, wait));
    const pane = await io.pane();
    if (pane === null) continue;
    read = true;
    if (landed(pane, want)) return true;
  }
  return read ? false : null;
}

/**
 * Whether the pane shows what a step expected.
 *
 * Compared on a normalised form: the CLI wraps a long question across the
 * dialog's width, so the text in the pane is the same words with different
 * whitespace. Matching on words rather than on the exact string is what keeps a
 * correct step from reading as a desync at 80 columns.
 */
export function landed(pane: string, expect: string): boolean {
  if (!expect) return true;
  // Box-drawing glyphs are stripped BEFORE the whitespace collapse, because the
  // dialog draws a border at the start of every line: leaving them in turns
  // "Where should the │ parse live?" into two fragments that match nothing.
  const norm = (s: string) =>
    s
      .replace(/[─-╿❯]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const want = norm(expect);
  if (!want) return true;
  const hay = norm(pane);
  if (hay.includes(want)) return true;
  // A question longer than the dialog is wide gets truncated with an ellipsis
  // as well as wrapped, so fall back to a distinctive prefix of it.
  const head = want.slice(0, 40);
  return head.length >= 12 && hay.includes(head);
}
