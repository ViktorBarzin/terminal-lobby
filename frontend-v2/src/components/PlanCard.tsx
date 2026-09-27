import { For, Show, createEffect, createSignal, on, onCleanup, type Component } from "solid-js";
import type { PlanOptionView } from "../lib/answer-api";
import { Markdown } from "./Markdown";
import { feedbackClearsContext, type PlanNotice, type PlanSending } from "./plan.logic";
import type { PlanReading } from "./timeline.logic";

/** The words for each notice (docs/plans/2026-09-24-text-composer-redesign.md). */
const NOTICE_TEXT: Record<PlanNotice, string> = {
  busy: "Still sending your last answer…",
  changed: "The Terminal now shows different choices. Pick again.",
  gone: "The plan is no longer waiting in the Terminal.",
  unverified: "Your answer may not have landed. Check the Terminal.",
  "too-long":
    "Not sent: the Terminal's feedback field takes up to 2,000 bytes. Shorten it and send again.",
};

const UNREADABLE = "Couldn't read the plan's choices. Open the Terminal to answer it.";

/**
 * The card that answers Claude Code's plan approval, docked above the composer
 * where the question card docks (docs/plans/2026-09-24-text-composer-redesign.md,
 * "When the card docks, and what it shows").
 *
 * It renders; it does not send. The plan comes from the transcript (the
 * ExitPlanMode call's input, or null while the call is not written yet), the
 * approve rows from the pane's reading, and the answer in flight and the last
 * reply's notice from the caller, which is also where the composer's feedback
 * is sent from. Keeping both kinds of answer with one owner is what lets a
 * Send pressed during an approval be refused with "Still sending your last
 * answer…" rather than racing it.
 *
 * WHAT IT LEAVES OUT, ON PURPOSE. No digit shortcuts, and no raw keypad when
 * the pane cannot be read: option 1 in the usual layout clears the context and
 * starts carrying out the plan, so a stray 1 must never reach the pane. No
 * Reject button (open point 10): the CLI rejects only through Esc or Enter on
 * an empty feedback row, and the Terminal's Esc still does that. The feedback
 * row itself is not drawn, because the composer below is that row while the
 * card is up.
 */
export const PlanCard: Component<{
  /** The approve rows as the pane draws them, or null when it could not be read. */
  reading: PlanReading | null;
  /** The plan as markdown, or null while the transcript has no call for it yet. */
  plan: string | null;
  /** The plan file changed while the plan was presented, so `plan` may be older. */
  stale?: boolean;
  /** The composer holds text that could go as feedback (PromptField `hasInput`). */
  hasInput: boolean;
  /** The answer in flight, if any. */
  sending?: PlanSending | null;
  /** What the last reply, or an ignored press, left the card to say. */
  notice?: PlanNotice | null;
  /** The composer's text has line breaks, which go out as spaces. */
  lineBreaks?: boolean;
  /** Approve with this row, by the number and the label the reader saw. */
  onApprove: (option: PlanOptionView) => void;
  /** Send the composer's text as feedback with `approve: true`. */
  onApproveWithFeedback: () => void;
  /** Show the Terminal view. */
  onTerminal?: () => void;
}> = (props) => {
  const [full, setFull] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  let planEl: HTMLDivElement | undefined;

  /**
   * Whether the clamped plan hides anything, which is when "Show all" is
   * offered. Measured rather than guessed from the markdown, because a few
   * long lines wrap into as many rows as a long list does. While expanded the
   * toggle stays, as "Show less".
   */
  const measure = () => {
    if (!planEl || full()) return;
    setOverflows(planEl.scrollHeight > planEl.clientHeight + 1);
  };
  /**
   * The plan's element, watched from the moment it mounts. That is not the
   * card's mount when the plan starts as "Loading the plan…", so this is the
   * ref rather than an onMount. The plan grows after its first paint too: a
   * mermaid fence or a highlighted code block swaps in, and the card's width
   * follows the pane, so the inner markdown is watched as well.
   */
  const attach = (el: HTMLDivElement) => {
    planEl = el;
    queueMicrotask(measure);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    queueMicrotask(() => {
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    });
    onCleanup(() => ro.disconnect());
  };
  createEffect(
    on(
      () => props.plan,
      () => queueMicrotask(measure),
      { defer: true },
    ),
  );

  const gone = () => props.notice === "gone";
  /** No choices to offer: the pane could not be read, and the plan has not gone. */
  const unreadable = () => !gone() && props.reading === null;
  const answerable = () => !gone() && props.reading !== null;
  const held = () => props.sending != null;

  const noticeText = (): string => {
    if (props.notice) return NOTICE_TEXT[props.notice];
    if (props.sending?.kind === "feedback") return "Sending your feedback…";
    if (unreadable()) return UNREADABLE;
    return "";
  };
  const offerTerminal = () => props.notice === "unverified" || unreadable();

  return (
    <div class="tl-qcard tl-plancard" role="dialog" aria-label="Claude's plan is ready">
      <div class="tl-qcard-head">
        <span class="tl-qcard-title">Claude's plan is ready</span>
        <Show when={props.plan !== null && (overflows() || full())}>
          <button
            type="button"
            class="tl-qcard-full"
            aria-expanded={full()}
            onClick={() => setFull((v) => !v)}
          >
            {full() ? "Show less" : "Show all"}
          </button>
        </Show>
      </div>

      <div class="tl-qcard-body">
        <Show
          when={props.plan !== null}
          fallback={<div class="tl-plancard-loading">Loading the plan…</div>}
        >
          <div
            class="tl-plancard-plan"
            ref={attach}
            data-full={full() ? "true" : undefined}
            data-clamped={overflows() && !full() ? "true" : undefined}
          >
            <Markdown text={props.plan ?? ""} />
          </div>
        </Show>
        <Show when={props.stale}>
          <div class="tl-plancard-stale">
            Claude changed the plan while presenting it. The Terminal shows the current version.
          </div>
        </Show>

        <Show when={answerable()}>
          <div class="tl-qcard-options">
            <For each={props.reading?.options ?? []}>
              {(option) => {
                const flying = () =>
                  props.sending?.kind === "option" && props.sending.number === option.number;
                return (
                  <button
                    type="button"
                    class="tl-qcard-option"
                    data-chosen={flying() ? "true" : undefined}
                    aria-busy={flying() ? "true" : undefined}
                    disabled={held()}
                    onClick={() => props.onApprove({ number: option.number, label: option.label })}
                  >
                    {/* The CLI's own number, shown so the row reads as the
                        Terminal's does. It is not a shortcut. */}
                    <span class="tl-qcard-key" aria-hidden="true">
                      {option.number}
                    </span>
                    <span class="tl-qcard-label">{option.label}</span>
                    <Show when={flying()}>
                      <span class="tl-plancard-flight">Approving…</span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Under the body rather than in it, so it stays in view while the
          reader types, however far the plan above is scrolled. */}
      <Show when={props.lineBreaks && answerable()}>
        <div class="tl-plancard-lines">
          Line breaks become spaces, because the Terminal's feedback field is one line.
        </div>
      </Show>

      {/* Always mounted, so a screen reader hears each change of what it says. */}
      <div class="tl-plancard-notice" role="status" aria-live="polite">
        {noticeText()}
      </div>

      <Show when={offerTerminal() || (props.hasInput && answerable())}>
        <div class="tl-qcard-actions tl-plancard-actions">
          <Show when={offerTerminal() && props.onTerminal}>
            <button type="button" class="tl-qcard-back" onClick={() => props.onTerminal?.()}>
              Open Terminal
            </button>
          </Show>
          {/* The CLI's Shift+Tab on its feedback row: approve, carrying the
              composer's text. Offered only while there is text to carry. It
              approves through option 1, so when option 1 clears the context
              the button says so: that cannot be undone from here. */}
          <Show when={props.hasInput && answerable()}>
            <button
              type="button"
              class="tl-qcard-next"
              disabled={held()}
              onClick={() => props.onApproveWithFeedback()}
            >
              {feedbackClearsContext(props.reading ?? null)
                ? "Approve with this feedback and clear context"
                : "Approve with this feedback"}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};
