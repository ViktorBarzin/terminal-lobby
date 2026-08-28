import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import type { Question } from "./canonicalize";
import {
  CHAT_LABEL,
  OTHER_LABEL,
  complete,
  shownOptions,
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
   * The call cannot be answered from here: it is being read off the PANE, which
   * shows one question of several at a time. What is being asked is worth
   * saying — the reader is otherwise left with "Working…" while the terminal
   * sits blocked — but answering half a call is how a wrong answer gets
   * submitted, so the card reports and points at the Terminal instead.
   */
  partial?: boolean;
  /** Every question's header, for a partial call. */
  headers?: string[];
  /** How many questions the call carries. */
  count?: number;
  /** Show the Terminal view. */
  onTerminal?: () => void;
}> = (props) => {
  const [at, setAt] = createSignal(0);
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
        <span class="tl-qcard-step">
          {reviewing() ? "review" : `question ${at() + 1} of ${total()}`}
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
            <div class="tl-qcard-options">
              <For each={shownOptions(q())}>
                {(label) => (
                  <button
                    type="button"
                    class="tl-qcard-option"
                    data-chosen={chosenHere(label) ? "true" : undefined}
                    // "Chat about this" is not an answer — it defers the whole
                    // question and hands the reader the composer, which is what
                    // the CLI's own option of that name does.
                    onClick={() => (label === CHAT_LABEL ? props.onChat() : toggle(label))}
                  >
                    <span class="tl-qcard-mark">
                      {label === CHAT_LABEL ? "→" : chosenHere(label) ? "●" : "○"}
                    </span>
                    <span class="tl-qcard-label">{label}</span>
                    <Show when={descriptionFor(q(), label)}>
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
        <Show when={at() > 0}>
          <button
            type="button"
            class="tl-qcard-back"
            disabled={props.busy}
            onClick={() => setAt(at() - 1)}
          >
            Back
          </button>
        </Show>
        <Show
          when={reviewing()}
          fallback={
            <button
              type="button"
              class="tl-qcard-next"
              disabled={!canAdvance() || props.busy}
              onClick={() => setAt(at() + 1)}
            >
              {at() + 1 === total() ? "Review" : "Next"}
            </button>
          }
        >
          <button
            type="button"
            class="tl-qcard-send"
            disabled={!ready() || props.busy}
            onClick={() => void props.onSend(drafts())}
          >
            {props.busy ? "Answering…" : "Send answers"}
          </button>
        </Show>
      </div>
    </div>
  );
};

/**
 * What is being asked, when the pane is all there is to go on and it can only
 * show part of the call.
 *
 * The transcript carries every question of a multi-question call; the pane
 * carries the one on screen. So this says what the session is waiting for and
 * hands over to the Terminal, and gives way to the full walk the moment the
 * record lands.
 */
const PartialCard: Component<{
  questions: Question[];
  headers?: string[];
  count?: number;
  onTerminal?: () => void;
  onChat: () => void;
}> = (props) => {
  const names = () =>
    (props.headers ?? []).filter(Boolean).length > 0
      ? props.headers!.filter(Boolean)
      : props.questions.map((q) => q.header || q.question);
  return (
    <div class="tl-qcard" role="dialog" aria-label="Claude needs an answer">
      <div class="tl-qcard-head">
        <span class="tl-qcard-title">Claude needs answers</span>
        <span class="tl-qcard-step">{props.count ?? names().length} questions</span>
      </div>
      <div class="tl-qcard-body">
        <div class="tl-qcard-question">{props.questions[0]?.question}</div>
        <div class="tl-qcard-hint">
          The session is waiting on {names().join(", ")}. Only the question on
          screen has reached here — answer them in the Terminal.
        </div>
      </div>
      <div class="tl-qcard-actions">
        <Show when={props.onTerminal}>
          <button type="button" class="tl-qcard-send" onClick={() => props.onTerminal?.()}>
            Open Terminal
          </button>
        </Show>
      </div>
    </div>
  );
};

/** The transcript's description for an option, where it recorded one. */
function descriptionFor(q: Question, label: string): string {
  return q.options.find((o) => o.label === label)?.description ?? "";
}
