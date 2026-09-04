import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import type { Question } from "./canonicalize";
import {
  OTHER_LABEL,
  answerableOptions,
  complete,
  optionIndex,
  submitsImmediately,
  type DraftAnswer,
} from "./answer.logic";

/**
 * The card that answers a blocking AskUserQuestion, docked above the composer.
 *
 * It WALKS: one question at a time, then a review of what is about to be sent.
 * That matches what somebody watching the pty sees, and it keeps a four-question
 * call readable on a phone, where all of them at once would be a wall.
 *
 * Nothing is typed into the session while the walk is going on. The answers are
 * held here until Send, so abandoning halfway leaves the dialog exactly as it
 * was — which is the difference between a walk you can change your mind about
 * and one that has already committed you to its first two answers.
 *
 * It docks rather than sitting in the timeline because on a phone the timeline
 * scrolls and the keyboard covers it; the permanent record of what was asked and
 * chosen is the inline row, which appears once the transcript records the answer.
 */
export const QuestionCard: Component<{
  questions: Question[];
  /** Send the assembled answers. Resolves when the sequence has finished. */
  onSend: (answers: DraftAnswer[]) => Promise<void>;
  /** Pick "Chat about this" — defer the question and type instead. */
  onChat: () => void;
  /** True while the keys are going in. */
  busy?: boolean;
  /**
   * A send STOPPED partway: some answers went in, the pane no longer shows what
   * the next step expected, and the dialog is sitting half-answered.
   *
   * The walk is over at that point and must not offer itself again. Send replays
   * the plan FROM STEP 0, and runAnswer types each step's keys BEFORE it checks
   * the pane — so a second press answers question 1 into whatever question the
   * dialog has moved on to, and only then notices. The chunk-by-chunk
   * verification guards a sequence in flight; nothing guarded starting one over.
   */
  stopped?: boolean;
  /**
   * The call is being read off the PANE, which draws one question of several at
   * a time. So it is answered one question at a time too: the answer goes in,
   * the tab bar fills that question's box, and the next reading brings the next
   * question. `answered` says how far along the terminal actually is, so the
   * card's `n of N` comes from the screen rather than from a count it keeps.
   */
  partial?: boolean;
  /** Every question's header, for a partial call. */
  headers?: string[];
  /** How many questions the call carries. */
  count?: number;
  /** How many of them the tab bar marks answered. */
  answered?: number;
  /** Show the Terminal view. */
  onTerminal?: () => void;
}> = (props) => {
  const [at, setAt] = createSignal(0);
  /** Show every description in full rather than the two-line summary. The clamp
   *  is the default because choosing between four options wants four summaries;
   *  this is for the reader who wants the whole of all of them at once, which
   *  choosing each in turn is a poor way to get. */
  const [full, setFull] = createSignal(false);
  const [drafts, setDrafts] = createSignal<DraftAnswer[]>([]);

  const total = () => props.questions.length;
  // One past the last question is the review step.
  const reviewing = () => at() >= total();
  const current = () => props.questions[at()];
  const draftAt = (i: number): DraftAnswer => drafts()[i] ?? { chosen: [] };

  const setDraft = (i: number, next: DraftAnswer) => {
    setDrafts((prev) => {
      const out = [...prev];
      while (out.length <= i) out.push({ chosen: [] });
      out[i] = next;
      return out;
    });
  };

  const toggle = (label: string) => {
    const i = at();
    const q = current();
    if (!q) return;
    const d = draftAt(i);
    if (!q.multiSelect) {
      setDraft(i, { chosen: [label], ...(label === OTHER_LABEL ? { other: d.other } : {}) });
      return;
    }
    const has = d.chosen.includes(label);
    setDraft(i, {
      ...d,
      chosen: has ? d.chosen.filter((l) => l !== label) : [...d.chosen, label],
    });
  };

  const chosenHere = (label: string) => draftAt(at()).chosen.includes(label);
  const canAdvance = () => {
    const d = draftAt(at());
    if (d.chosen.length === 0) return false;
    if (d.chosen.includes(OTHER_LABEL)) return !!(d.other ?? "").trim();
    return true;
  };
  const ready = createMemo(() => complete(props.questions, drafts()));

  if (props.partial) return <PartialCard {...props} />;

  return (
    <div class="tl-qcard" role="dialog" aria-label="Claude needs an answer">
      <div class="tl-qcard-head">
        <span class="tl-qcard-title">Claude needs answers</span>
        <Show when={!reviewing() && current() && hasDescriptions(current()!)}>
          <button
            type="button"
            class="tl-qcard-full"
            onClick={() => setFull((v) => !v)}
          >
            {full() ? "Show less" : "Show all"}
          </button>
        </Show>
        <span class="tl-qcard-step">
          {reviewing()
            ? "review"
            : submitsImmediately(props.questions)
              ? "awaiting your answer"
              : `question ${at() + 1} of ${total()}`}
        </span>
      </div>

      <Show
        when={!reviewing() && current()}
        fallback={
          <div class="tl-qcard-review">
            <For each={props.questions}>
              {(q, i) => (
                <div class="tl-qcard-reviewrow">
                  <span class="tl-qcard-reviewq">{q.header || q.question}</span>
                  <span class="tl-qcard-reviewa">
                    {draftAt(i()).chosen.includes(OTHER_LABEL)
                      ? draftAt(i()).other
                      : draftAt(i()).chosen.join(", ") || "—"}
                  </span>
                </div>
              )}
            </For>
          </div>
        }
      >
        {(q) => (
          <div class="tl-qcard-body">
            <div class="tl-qcard-question">{q().question}</div>
            <Show when={q().multiSelect}>
              <div class="tl-qcard-hint">Pick as many as apply</div>
            </Show>
            <div class="tl-qcard-options" data-full={full() ? "true" : undefined}>
              <For each={answerableOptions(q())}>
                {(label) => (
                  <button
                    type="button"
                    class="tl-qcard-option"
                    data-chosen={chosenHere(label) ? "true" : undefined}
                    data-multi={q().multiSelect ? "true" : undefined}
                    onClick={() => toggle(label)}
                  >
                    {/* The DIALOG's number, not this list's position: it is the
                        key we are about to type, so it has to be the key the CLI
                        is listening for. The transcript's recorded row numbers
                        its options the same way, and the card was the only one of
                        the three surfaces that showed no number at all. */}
                    <span class="tl-qcard-key" aria-hidden="true">
                      {optionIndex(q(), label) + 1}
                    </span>
                    <span class="tl-qcard-label">{label}</span>
                    <Show when={descriptionFor(q(), label)}>
                      {/* Clamped to two lines, and the chosen row expands (see
                          app.css). Every description stays on screen because the
                          difference between two options usually lives in them,
                          not in the labels. */}
                      <span class="tl-qcard-desc">{descriptionFor(q(), label)}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <Show when={chosenHere(OTHER_LABEL)}>
              <input
                class="tl-qcard-other"
                type="text"
                placeholder="Type something"
                aria-label="Your own answer"
                value={draftAt(at()).other ?? ""}
                onInput={(e) => setDraft(at(), { ...draftAt(at()), other: e.currentTarget.value })}
              />
            </Show>
          </div>
        )}
      </Show>

      <div class="tl-qcard-actions">
        {/* Leaving the question, not answering it. It acts on the press, while
            every row above is a draft nothing acts on until Submit — which is
            why it is here and not up there wearing an arrow. */}
        <Show when={!props.stopped}>
          <button type="button" class="tl-qcard-chat" onClick={() => props.onChat()}>
            Type a message instead
          </button>
        </Show>
        <Show when={at() > 0 && !props.stopped}>
          <button
            type="button"
            class="tl-qcard-back"
            disabled={props.busy}
            onClick={() => setAt(at() - 1)}
          >
            Back
          </button>
        </Show>
        <Show when={props.stopped}>
          {/* Not a retry. What is on the pane is half an answer, and only the
              Terminal shows which half. */}
          <span class="tl-qcard-stopped">
            Part of the answer went in before the session's screen changed.
            Finish it in the Terminal — sending again would answer the wrong
            question.
          </span>
          <Show when={props.onTerminal}>
            <button
              type="button"
              class="tl-qcard-terminal"
              onClick={() => props.onTerminal?.()}
            >
              Open Terminal
            </button>
          </Show>
        </Show>
        <Show
          when={(reviewing() || submitsImmediately(props.questions)) && !props.stopped}
          fallback={
            <Show when={!props.stopped}>
              <button
                type="button"
                class="tl-qcard-next"
                disabled={!canAdvance() || props.busy}
                onClick={() => setAt(at() + 1)}
              >
                {at() + 1 === total() ? "Review answers" : "Next"}
              </button>
            </Show>
          }
        >
          <button
            type="button"
            class="tl-qcard-send"
            disabled={!ready() || props.busy}
            onClick={() => void props.onSend(drafts())}
          >
            {props.busy ? "Submitting…" : "Submit"}
          </button>
        </Show>
      </div>
    </div>
  );
};

/**
 * A multi-question call, answered one question at a time off the pane.
 *
 * The pane draws one question of the call at a time and the transcript record
 * may not have landed — measured 2026-08-28, two of five records were written
 * only when the question was ANSWERED, one of them 112 seconds later — so
 * waiting for the whole call is not an option, and this used to hand the reader
 * to the Terminal for 22.4% of the 1,045 calls in this box's corpus.
 *
 * So it walks the terminal instead of walking a plan. One answer goes in, the
 * tab bar fills that question's box, and the next reading of the pane brings the
 * next question. `n of N` is read from those boxes: the card never counts its
 * own answers, because anything else touching the dialog — a keystroke in the
 * Terminal, an Esc, a re-ask — would make a private count wrong.
 *
 * Unlike the transcript walk, each answer commits as it is given. There is no
 * review step to change your mind at, because the questions ahead have not been
 * drawn yet.
 */
const PartialCard: Component<{
  questions: Question[];
  headers?: string[];
  count?: number;
  answered?: number;
  busy?: boolean;
  stopped?: boolean;
  onSend: (answers: DraftAnswer[]) => Promise<void>;
  onTerminal?: () => void;
  onChat: () => void;
}> = (props) => {
  const [draft, setDraft] = createSignal<DraftAnswer>({ chosen: [] });
  const names = () =>
    (props.headers ?? []).filter(Boolean).length > 0
      ? props.headers!.filter(Boolean)
      : props.questions.map((q) => q.header || q.question);
  const total = () => props.count ?? names().length;
  const done = () => props.answered ?? 0;
  const q = () => props.questions[0];
  // Every box filled: the CLI is showing its own Submit screen, which carries no
  // options of its own.
  const reviewing = () => done() >= total() || (q()?.options.length ?? 0) === 0;
  const chosen = (label: string) => draft().chosen.includes(label);
  const toggle = (label: string) => {
    const cur = draft();
    if (!q()?.multiSelect) {
      setDraft({ chosen: [label], ...(label === OTHER_LABEL ? { other: cur.other } : {}) });
      return;
    }
    setDraft({
      ...cur,
      chosen: cur.chosen.includes(label)
        ? cur.chosen.filter((l) => l !== label)
        : [...cur.chosen, label],
    });
  };
  const ready = () => {
    const d = draft();
    if (reviewing()) return true;
    if (d.chosen.length === 0) return false;
    if (d.chosen.includes(OTHER_LABEL)) return !!(d.other ?? "").trim();
    return true;
  };
  const send = () => {
    const d = draft();
    // The next question arrives as a fresh reading, so the draft has to be
    // empty by then or its answer would be pre-filled with this one's.
    setDraft({ chosen: [] });
    void props.onSend([d]);
  };

  return (
    <div class="tl-qcard" role="dialog" aria-label="Claude needs an answer">
      <div class="tl-qcard-head">
        <span class="tl-qcard-title">Claude needs answers</span>
        <span class="tl-qcard-step">
          {reviewing() ? "ready to submit" : `${Math.min(done() + 1, total())} of ${total()}`}
        </span>
      </div>
      <div class="tl-qcard-body">
        <div class="tl-qcard-question">{q()?.question}</div>
        <Show when={!reviewing()}>
          <Show when={q()?.multiSelect}>
            <div class="tl-qcard-hint">Pick as many as apply</div>
          </Show>
          <div class="tl-qcard-options">
            <For each={answerableOptions(q()!)}>
              {(label) => (
                <button
                  type="button"
                  class="tl-qcard-option"
                  data-chosen={chosen(label) ? "true" : undefined}
                  data-multi={q()!.multiSelect ? "true" : undefined}
                  onClick={() => toggle(label)}
                >
                  {/* The DIALOG's number: it is the key about to be typed, so it
                      has to be the key the CLI is listening for. */}
                  <span class="tl-qcard-key" aria-hidden="true">
                    {optionIndex(q()!, label) + 1}
                  </span>
                  <span class="tl-qcard-label">{label}</span>
                  <Show when={descriptionFor(q()!, label)}>
                    <span class="tl-qcard-desc">{descriptionFor(q()!, label)}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={chosen(OTHER_LABEL)}>
            <input
              class="tl-qcard-other"
              type="text"
              placeholder="Type something"
              aria-label="Your own answer"
              value={draft().other ?? ""}
              onInput={(e) => setDraft({ ...draft(), other: e.currentTarget.value })}
            />
          </Show>
        </Show>
        {/* What the tab bar says, which is where `n of N` came from. Shown so
            the reader can see the same progress the terminal is showing. */}
        <Show when={total() > 1}>
          <div class="tl-qcard-tabs">
            <For each={names()}>
              {(name, i) => (
                <span class="tl-qcard-tab" data-done={i() < done() ? "true" : undefined}>
                  {name}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="tl-qcard-actions">
        <Show when={!props.stopped}>
          <button type="button" class="tl-qcard-chat" onClick={() => props.onChat()}>
            Type a message instead
          </button>
        </Show>
        <Show when={props.stopped}>
          <span class="tl-qcard-stopped">
            The session's screen changed before that answer landed. Finish it in
            the Terminal — sending again would answer a different question.
          </span>
          <Show when={props.onTerminal}>
            <button
              type="button"
              class="tl-qcard-terminal"
              onClick={() => props.onTerminal?.()}
            >
              Open Terminal
            </button>
          </Show>
        </Show>
        <Show when={!props.stopped}>
          <button
            type="button"
            class="tl-qcard-send"
            disabled={!ready() || props.busy}
            onClick={send}
          >
            {props.busy
              ? "Sending…"
              : reviewing()
                ? "Submit"
                : done() + 1 === total()
                  ? "Answer, then submit"
                  : "Answer"}
          </button>
        </Show>
      </div>
    </div>
  );
};

/** True when any option carries a description worth expanding. */
export function hasDescriptions(q: Question): boolean {
  return q.options.some((o) => (o.description ?? "").trim() !== "");
}

/** The transcript's description for an option, where it recorded one. */
function descriptionFor(q: Question, label: string): string {
  return q.options.find((o) => o.label === label)?.description ?? "";
}
