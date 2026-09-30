import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import type { Question, QuestionOption } from "./canonicalize";
import { CardDot, CardHead, keepFocusIn } from "./CardHead";
import { OwnAnswer } from "./OwnAnswer";
import { buildAnswers, resolveAnswer, setCustom, toggle, type Draft } from "./question.logic";

/** How long a single-select pick shows as chosen before the card moves on:
 *  T3 Code's 200 ms, long enough to see the tap land. */
const ADVANCE_MS = 200;

/**
 * Whether the card can answer: `open` while the lobby's hook holds the
 * question, `connecting` for the moment between the call appearing and the hold
 * reaching the page, and `terminal` when nothing holds it (a session started
 * before the hook existed, say), which leaves the terminal as the only place to
 * answer.
 */
export type QuestionCardState = "open" | "connecting" | "terminal";

/**
 * The card that answers a blocking AskUserQuestion, in the composer's place
 * while Claude waits (ADR-0034; the T3 pass, prototype 6-question).
 *
 * It follows T3 Code's question panel (`ComposerPendingUserInputPanel.tsx`),
 * drawn with the lobby's own tokens: one question at a time with an `i/N`
 * counter, a single-select pick that moves on by itself after a beat, a
 * multi-select that toggles in place, keys 1-9 on a desktop, and a head that
 * collapses the card so the conversation above can be read. Nothing goes to
 * the session until every question has an answer, and then the whole call goes
 * at once, as data: the hook holding the question hands it to the CLI, and
 * nothing is typed into the pane.
 *
 * The composer is hidden while the card is up, so its draft is out of sight
 * and never becomes an answer. The free-text answer is the card's own last
 * row, "Type your own answer", which opens into a field with its own Send
 * (`OwnAnswer`). Its words are the question's custom answer: they win over the
 * ticks while there are any, a pick clears them, and Next or Submit use them
 * like a pick.
 *
 * Two things differ from T3 on purpose. Option previews are shown, because
 * Claude uses them to compare code and layouts, and "Chat about this" declines
 * the question with the field's words, as the CLI's own row does.
 */
export const QuestionCard: Component<{
  questions: Question[];
  state: QuestionCardState;
  /** A request is in flight. */
  busy: boolean;
  /** Why this device may not answer (it is watching), or empty when it may.
   *  The rows then draw disabled. */
  inert?: string;
  /** Keys 1-9 reach this card: its view is the one being typed into. */
  keysActive: boolean;
  /** Send the whole call. Resolves true once the session has it. */
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
  /** Decline the question and talk instead, handing Claude these words (the
   *  own-answer field's, or empty). */
  onChat: (words: string) => void;
  onTerminal?: () => void;
  /** Stop watching and answer from this device. */
  onTakeControl?: () => void;
}> = (props) => {
  const [index, setIndex] = createSignal(0);
  const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});
  /** The question text whose card is collapsed. Moving to another question
   *  opens the card again, as T3's does. */
  const [collapsedAt, setCollapsedAt] = createSignal<string | null>(null);
  /** The option whose preview shows: the last one pointed at or picked. */
  const [focused, setFocused] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);
  /** The questions whose "Type your own answer" row has been opened into its
   *  field, by question text. Each question opens on its row. */
  const [ownOpen, setOwnOpen] = createSignal<Record<string, true>>({});
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
      if (gap >= 0) goTo(gap);
      return;
    }
    if (await props.onSubmit(answers)) setSent(true);
  };

  let cardEl: HTMLDivElement | undefined;
  /**
   * Move to another question, keeping the focus in the card. The button that
   * moved can turn disabled (Next on a question with no answer yet) or go
   * away (Previous on the first), and the focus would fall to the page, where
   * the row digits are not the card's (found live on 2026-09-27).
   */
  const goTo = (i: number): void => {
    const had = !!cardEl && cardEl.contains(document.activeElement);
    setIndex(i);
    setFocused(null);
    // Each question opens at the top of the card's scroll box. Kept where
    // the last one was scrolled, a tall question opened on the tail of its
    // options with its title out of sight (deployed review round 6,
    // 2026-09-30, a phone at 390x664).
    const body = cardEl?.querySelector<HTMLElement>(".tl-qcard-body");
    if (body) body.scrollTop = 0;
    if (had) queueMicrotask(() => keepFocusIn(cardEl));
  };

  /** T3's advance: the last question submits, any other moves to the next. */
  const advance = (): void => {
    clearTimeout(advanceTimer);
    if (!answerable()) return;
    if (last()) {
      void submit();
      return;
    }
    goTo(index() + 1);
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

  const typed = (): string => draft()?.custom ?? "";
  const openOwn = (): void => {
    const q = question();
    if (q) setOwnOpen((all) => ({ ...all, [q.question]: true }));
  };
  const typeOwn = (words: string): void => {
    const q = question();
    if (q) put(q, setCustom(draft(), words));
  };

  // Keys 1-9 pick, when the focus is in this card's Text view, nothing editable
  // has it, and the view is the one being typed into. A collapsed card opts
  // out, since the numbers it would pick are not on screen.
  //
  // In the view, not anywhere on the page: the composer hides the moment the
  // card docks, so the rest of a sentence being typed lands on the page's body,
  // and "use 2 of them" must not answer. The text view hands the card the
  // focus when it docks and nothing else had it.
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!props.keysActive || collapsed() || !answerable()) return;
      const t = e.target;
      const view = cardEl?.closest(".tl-textview") ?? cardEl;
      if (!(t instanceof Node) || !view?.contains(t)) return;
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
  const canNext = () => answerable() && current() !== null;
  /** A lone single-select question answers on the pick, or on its own field's
   *  Send, so Submit would only ever repeat one of them. */
  const offerNext = () => count() > 1 || question()?.multiSelect === true;

  return (
    <div
      class="tl-qcard"
      role="dialog"
      aria-label="Claude is asking a question"
      tabIndex={-1}
      ref={cardEl}
    >
      <CardHead
        lead={
          <button
            type="button"
            class="tl-qcard-fold"
            aria-expanded={!collapsed()}
            title={
              collapsed()
                ? "Show the question and its options"
                : "Hide the question and its options"
            }
            onClick={() => setCollapsedAt(collapsed() ? null : (question()?.question ?? null))}
          >
            <CardDot />
            <span class="tl-qcard-title">Claude asks</span>
            <Show when={question()?.header}>
              <span class="tl-qcard-tag">{question()?.header}</span>
            </Show>
            <Show when={count() > 1}>
              <span class="tl-qcard-step">
                {index() + 1}/{count()}
              </span>
            </Show>
            <Show when={collapsed()}>
              <span class="tl-qcard-peek">{question()?.question}</span>
            </Show>
            <span
              class="tl-qcard-chevron"
              data-collapsed={collapsed() ? "true" : undefined}
              aria-hidden="true"
            />
          </button>
        }
        links={
          <Show when={props.onTerminal}>
            <button type="button" class="tl-qcard-link" onClick={() => props.onTerminal?.()}>
              Open in Terminal
            </button>
          </Show>
        }
        inert={props.inert}
        onTakeControl={props.onTakeControl}
      />
      <Show when={!collapsed()}>
        {/* The question scrolls with its options, in the card's one scroll
            box. Pinned above it, a 60-80 word question kept its full height
            and left the options and the typed-answer field a 0px box once a
            phone's keyboard was up (deployed review round 3, 2026-09-28). */}
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
                    <span class="tl-qcard-key" aria-hidden="true">
                      {chosen(o) ? "✓" : i() < 9 ? String(i() + 1) : ""}
                    </span>
                    <span class="tl-qcard-label">{o.label}</span>
                    <Show when={o.description && o.description !== o.label}>
                      <span class="tl-qcard-desc">{o.description}</span>
                    </Show>
                  </button>
                )}
              </For>
              <OwnAnswer
                label="Type your own answer"
                open={ownOpen()[question()?.question ?? ""] === true}
                value={typed()}
                disabled={!answerable()}
                onOpen={openOwn}
                onInput={typeOwn}
                onSend={advance}
              />
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
              title="Decline the question and talk to Claude about it instead"
              onClick={() => props.onChat(typed().trim())}
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
                  goTo(Math.max(0, index() - 1));
                }}
              >
                Previous
              </button>
            </Show>
            <Show when={offerNext()}>
              <button
                type="button"
                class={last() ? "tl-qcard-send" : "tl-qcard-next"}
                disabled={!canNext()}
                onClick={advance}
              >
                {nextLabel()}
              </button>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};
