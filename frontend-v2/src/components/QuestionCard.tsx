import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import type { Question, QuestionOption } from "./canonicalize";
import { buildAnswers, resolveAnswer, setCustom, toggle, type Draft } from "./question.logic";

/** How long a single-select pick shows as chosen before the card moves on:
 *  T3 Code's 200 ms, long enough to see the tap land. */
const ADVANCE_MS = 200;

/** What the text view can ask of a docked card. */
export interface QuestionCardApi {
  /** Words from the composer, as the free-text answer to the question on show.
   *  Moves on the way Next does. False when the card cannot take them. */
  typed: (words: string) => boolean;
}

/**
 * Whether the card can answer: `open` while the lobby's hook holds the
 * question, `connecting` for the moment between the call appearing and the hold
 * reaching the page, and `terminal` when nothing holds it (a session started
 * before the hook existed, say), which leaves the terminal as the only place to
 * answer.
 */
export type QuestionCardState = "open" | "connecting" | "terminal";

/**
 * The card that answers a blocking AskUserQuestion, docked above the composer
 * (ADR-0034).
 *
 * It follows T3 Code's question panel (`ComposerPendingUserInputPanel.tsx`),
 * drawn with the lobby's own tokens: one question at a time with an `i/N`
 * counter, a single-select pick that moves on by itself after a beat, a
 * multi-select that toggles in place, keys 1-9 on a desktop, and a header that
 * collapses the card so the conversation above can be read. The composer is the
 * free-text answer while the card is up. Nothing goes to the session until every
 * question has an answer, and then the whole call goes at once, as data: the
 * hook holding the question hands it to the CLI, and nothing is typed into the
 * pane.
 *
 * Two things differ from T3 on purpose. Option previews are shown, because
 * Claude uses them to compare code and layouts, and "Chat about this" declines
 * the question and hands Claude the composer's words, as the CLI's own row does.
 */
export const QuestionCard: Component<{
  questions: Question[];
  state: QuestionCardState;
  /** A request is in flight. */
  busy: boolean;
  /** Why this device may not answer (it is watching), or empty when it may.
   *  The rows then draw disabled. */
  inert?: string;
  /** The composer holds words, so Next and Submit use them as the answer. */
  hasInput: boolean;
  /** Keys 1-9 reach this card: its view is the one being typed into. */
  keysActive: boolean;
  /** Send the whole call. Resolves true once the session has it. */
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
  /** Decline the question and talk instead. */
  onChat: () => void;
  /** Next or Submit with words in the composer: the text view hands them to
   *  `typed` through the composer, so the field clears only if they are taken. */
  onUseTyped: () => void;
  onTerminal?: () => void;
  register?: (api: QuestionCardApi) => void;
}> = (props) => {
  const [index, setIndex] = createSignal(0);
  const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});
  /** The question text whose card is collapsed. Moving to another question
   *  opens the card again, as T3's does. */
  const [collapsedAt, setCollapsedAt] = createSignal<string | null>(null);
  /** The option whose preview shows: the last one pointed at or picked. */
  const [focused, setFocused] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(advanceTimer));

  const count = () => props.questions.length;
  const question = createMemo(() => props.questions[Math.min(index(), count() - 1)]);
  const draft = () => {
    const q = question();
    return q ? drafts()[q.question] : undefined;
  };
  const collapsed = () => collapsedAt() !== null && collapsedAt() === question()?.question;
  const last = () => index() >= count() - 1;
  const answerable = () => props.state === "open" && !props.busy && !props.inert && !sent();
  const hasCustom = () => (draft()?.custom.trim() ?? "") !== "";
  const chosen = (o: QuestionOption) => !hasCustom() && (draft()?.selected ?? []).includes(o.label);
  const current = () => {
    const q = question();
    return q ? resolveAnswer(q, draft()) : null;
  };

  const put = (q: Question, d: Draft) => setDrafts((all) => ({ ...all, [q.question]: d }));

  /** Send the call if every question has an answer, or go to the first that has
   *  none. */
  const submit = async (): Promise<void> => {
    const answers = buildAnswers(props.questions, drafts());
    if (!answers) {
      const gap = props.questions.findIndex((q) => !resolveAnswer(q, drafts()[q.question]));
      if (gap >= 0) setIndex(gap);
      return;
    }
    if (await props.onSubmit(answers)) setSent(true);
  };

  /** T3's advance: the last question submits, any other moves to the next. */
  const advance = (): void => {
    clearTimeout(advanceTimer);
    if (!answerable()) return;
    if (last()) {
      void submit();
      return;
    }
    setIndex((i) => i + 1);
    setFocused(null);
  };

  const pick = (o: QuestionOption): void => {
    const q = question();
    if (!q || !answerable()) return;
    put(q, toggle(q, draft(), o.label));
    setFocused(o.label);
    if (q.multiSelect) return;
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(advance, ADVANCE_MS);
  };

  const next = (): void => {
    if (props.hasInput) {
      props.onUseTyped();
      return;
    }
    advance();
  };

  props.register?.({
    typed: (words) => {
      const q = question();
      if (!q || !answerable() || !words.trim()) return false;
      put(q, setCustom(draft(), words));
      advance();
      return true;
    },
  });

  // Keys 1-9 pick, when nothing editable has the focus and this card's view is
  // the one being typed into. A collapsed card opts out, since the numbers it
  // would pick are not on screen.
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!props.keysActive || collapsed() || !answerable()) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.closest('[contenteditable]:not([contenteditable="false"])'))
        return;
      const n = Number.parseInt(e.key, 10);
      const o = question()?.options[n - 1];
      if (!o || n < 1 || n > 9) return;
      e.preventDefault();
      pick(o);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  /** The preview on show: the option in focus, else the first chosen one that
   *  has a preview, else the first option that has one. */
  const preview = createMemo((): string => {
    const opts = question()?.options ?? [];
    const f = opts.find((o) => o.label === focused() && o.preview);
    if (f) return f.preview!;
    return (opts.find((o) => chosen(o) && o.preview) ?? opts.find((o) => o.preview))?.preview ?? "";
  });

  const nextLabel = () => (last() ? "Submit" : "Next");
  const canNext = () => answerable() && (props.hasInput || current() !== null);

  return (
    <div class="tl-qcard" role="dialog" aria-label="Claude is asking a question">
      <button
        type="button"
        class="tl-qcard-head"
        aria-expanded={!collapsed()}
        title={collapsed() ? "Show the question and its options" : "Hide the question and its options"}
        onClick={() => setCollapsedAt(collapsed() ? null : (question()?.question ?? null))}
      >
        <span class="tl-qcard-title">{question()?.header || "Question"}</span>
        <Show when={count() > 1}>
          <span class="tl-qcard-step">
            {index() + 1}/{count()}
          </span>
        </Show>
        <Show when={collapsed()}>
          <span class="tl-qcard-peek">{question()?.question}</span>
        </Show>
        <span class="tl-qcard-chevron" data-collapsed={collapsed() ? "true" : undefined} aria-hidden="true" />
      </button>
      <Show when={!collapsed()}>
        <div class="tl-qcard-body">
          <div class="tl-qcard-question">{question()?.question}</div>
          <Show
            when={props.state !== "terminal"}
            fallback={
              <div class="tl-qcard-hint">
                This question can only be answered in the Terminal right now.
              </div>
            }
          >
            <Show when={question()?.multiSelect}>
              <div class="tl-qcard-hint">Select one or more options.</div>
            </Show>
            <div class="tl-qcard-options">
              <For each={question()?.options ?? []}>
                {(o, i) => (
                  <button
                    type="button"
                    class="tl-qcard-option"
                    data-chosen={chosen(o) ? "true" : undefined}
                    data-multi={question()?.multiSelect ? "true" : undefined}
                    aria-pressed={chosen(o)}
                    disabled={!answerable()}
                    onClick={() => pick(o)}
                    onPointerEnter={() => o.preview && setFocused(o.label)}
                    onFocus={() => o.preview && setFocused(o.label)}
                  >
                    <span class="tl-qcard-label">{o.label}</span>
                    <Show when={o.description && o.description !== o.label}>
                      <span class="tl-qcard-desc">{o.description}</span>
                    </Show>
                    <span class="tl-qcard-key" aria-hidden="true">
                      {chosen(o) ? "✓" : i() < 9 ? String(i() + 1) : ""}
                    </span>
                  </button>
                )}
              </For>
            </div>
            <Show when={preview()}>
              <pre class="tl-qcard-preview">{preview()}</pre>
            </Show>
            <Show when={props.state === "connecting"}>
              <div class="tl-qcard-hint">Connecting to the question…</div>
            </Show>
            <Show when={sent()}>
              <div class="tl-qcard-hint" role="status">
                Answer sent.
              </div>
            </Show>
          </Show>
        </div>
        <div class="tl-qcard-actions">
          <Show
            when={props.state !== "terminal"}
            fallback={
              <Show when={props.onTerminal}>
                <button type="button" class="tl-qcard-send" onClick={() => props.onTerminal?.()}>
                  Open Terminal
                </button>
              </Show>
            }
          >
            <button
              type="button"
              class="tl-qcard-chat"
              disabled={!answerable()}
              title="Decline the question and send Claude what is in the message field instead"
              onClick={() => props.onChat()}
            >
              Chat about this
            </button>
            <Show when={index() > 0}>
              <button
                type="button"
                class="tl-qcard-back"
                disabled={!answerable()}
                onClick={() => {
                  clearTimeout(advanceTimer);
                  setIndex((i) => Math.max(0, i - 1));
                  setFocused(null);
                }}
              >
                Previous
              </button>
            </Show>
            <button
              type="button"
              class={last() ? "tl-qcard-send" : "tl-qcard-next"}
              disabled={!canNext()}
              onClick={next}
            >
              {nextLabel()}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};
