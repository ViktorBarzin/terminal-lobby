import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Component,
} from "solid-js";
import type { PlanOptionView } from "../lib/answer-api";
import { CardDot, CardHead } from "./CardHead";
import { Markdown } from "./Markdown";
import { OwnAnswer } from "./OwnAnswer";
import {
  feedbackClearsContext,
  splitPlanTitle,
  type PlanNotice,
  type PlanSending,
} from "./plan.logic";
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
 * The card that answers Claude Code's plan approval, in the composer's place
 * while Claude waits (docs/plans/2026-09-24-text-composer-redesign.md, "When
 * the card docks, and what it shows"; the T3 pass, prototype 6-plan).
 *
 * It renders; it does not send. The plan comes from the transcript (the
 * ExitPlanMode call's input, or null while the call is not written yet), the
 * approve rows from the pane's reading, and the answer in flight and the last
 * reply's notice from the caller, which is also where feedback is sent from.
 * Keeping both kinds of answer with one owner is what lets a Send pressed
 * during an approval be refused with "Still sending your last answer…" rather
 * than racing it.
 *
 * The last row is "Tell Claude what to change" (`OwnAnswer`), the card's own
 * field: the composer is hidden while the card has its place, so the words
 * for the dialog's feedback row are typed here. Its Send keeps Claude
 * planning; "Approve with this feedback", offered under the field while it
 * holds text, approves carrying them. The card holds the words, and drops
 * them only once a send has landed.
 *
 * WHAT IT LEAVES OUT, ON PURPOSE. No digit shortcuts, and no raw keypad when
 * the pane cannot be read: option 1 in the usual layout clears the context and
 * starts carrying out the plan, so a stray 1 must never reach the pane. No
 * Reject button (open point 10): the CLI rejects only through Esc or Enter on
 * an empty feedback row, and the Terminal's Esc still does that. An approval
 * carries only the words in the card's own field, never the hidden composer's
 * draft, so it never carries words the reader cannot see.
 */
export const PlanCard: Component<{
  /** The approve rows as the pane draws them, or null when it could not be read. */
  reading: PlanReading | null;
  /** The plan as markdown, or null while the transcript has no call for it yet. */
  plan: string | null;
  /** The plan file changed while the plan was presented, so `plan` may be older. */
  stale?: boolean;
  /** The answer in flight, if any. */
  sending?: PlanSending | null;
  /** Why this device may not answer (it is watching), or empty when it may. */
  inert?: string;
  /** What the last reply, or an ignored press, left the card to say. */
  notice?: PlanNotice | null;
  /** Approve with this row, by the number and the label the reader saw. */
  onApprove: (option: PlanOptionView) => void;
  /** Send the card's words as feedback that keeps Claude planning; false
   *  when they did not land, which keeps them in the field. Absent, the card
   *  offers no field. */
  onFeedback?: (words: string) => Promise<boolean>;
  /** Send the card's words as feedback with `approve: true`; false as above. */
  onApproveWithFeedback?: (words: string) => Promise<boolean>;
  /** Show the Terminal view. */
  onTerminal?: () => void;
  /** Stop watching and answer from this device. */
  onTakeControl?: () => void;
}> = (props) => {
  const [full, setFull] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [ownOpen, setOwnOpen] = createSignal(false);
  const [words, setWords] = createSignal("");
  let planEl: HTMLDivElement | undefined;
  let wellEl: HTMLDivElement | undefined;

  /**
   * Whether the clamped plan hides anything, which is when "Show all" is
   * offered. Measured rather than guessed from the markdown, because a few
   * long lines wrap into as many rows as a long list does. While expanded the
   * toggle stays, as "Show less".
   */
  const measure = () => {
    if (!planEl || full()) return;
    // The plan's own height, so the floor the well shrinks to (four lines)
    // never pads a shorter plan with blank lines. Set on the well, which
    // resolves the floor for itself and for the plan it holds.
    wellEl?.style.setProperty("--tl-plan-content", `${planEl.scrollHeight}px`);
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

  const split = createMemo(() => splitPlanTitle(props.plan ?? ""));
  const gone = () => props.notice === "gone";
  /** No choices to offer: the pane could not be read, and the plan has not gone. */
  const unreadable = () => !gone() && props.reading === null;
  const answerable = () => !gone() && props.reading !== null;
  const held = () => props.sending != null || !!props.inert;
  const hasWords = () => words().trim() !== "";
  const offerApprove = () => hasWords() && answerable() && !!props.onApproveWithFeedback;
  /** Send the words one way or the other, and empty the field once they land. */
  const sendWords = async (via?: (w: string) => Promise<boolean>): Promise<void> => {
    if (!via || held() || !hasWords()) return;
    if (await via(words())) {
      setWords("");
      setOwnOpen(false);
    }
  };

  const noticeText = (): string => {
    if (props.notice) return NOTICE_TEXT[props.notice];
    if (props.sending?.kind === "feedback") return "Sending your feedback…";
    if (unreadable()) return UNREADABLE;
    return "";
  };
  const offerTerminal = () => props.notice === "unverified" || unreadable();

  return (
    <div
      class="tl-qcard tl-plancard"
      role="dialog"
      aria-label="Claude's plan is ready"
      tabIndex={-1}
    >
      <CardHead
        lead={
          <span class="tl-qcard-lead">
            <CardDot />
            <span class="tl-qcard-title">Plan ready</span>
          </span>
        }
        links={
          <Show when={props.plan !== null && (overflows() || full())}>
            <button
              type="button"
              class="tl-qcard-link"
              aria-expanded={full()}
              onClick={() => setFull((v) => !v)}
            >
              {full() ? "Show less" : "Read the full plan"}
            </button>
          </Show>
        }
        inert={props.inert}
        onTakeControl={props.onTakeControl}
      />

      {/* The plan's own title is the card's question line, as the prototype
          draws it, and the well under it starts with the steps. */}
      <Show when={split().title}>
        <div class="tl-qcard-question">{split().title}</div>
      </Show>
      <div class="tl-qcard-body">
        <Show
          when={props.plan !== null}
          fallback={<div class="tl-plancard-loading">Loading the plan…</div>}
        >
          {/* The well carries the border and the fill, so the clamp's fade
              below runs over the plan's words and not over the well's edge. */}
          <div class="tl-plancard-well" ref={wellEl} data-full={full() ? "true" : undefined}>
            <div
              class="tl-plancard-plan"
              ref={attach}
              data-full={full() ? "true" : undefined}
              data-clamped={overflows() && !full() ? "true" : undefined}
            >
              <Markdown text={split().rest} />
            </div>
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
            <Show when={props.onFeedback}>
              <OwnAnswer
                label="Tell Claude what to change"
                open={ownOpen()}
                value={words()}
                disabled={held()}
                onOpen={() => setOwnOpen(true)}
                onInput={setWords}
                onSend={() => void sendWords(props.onFeedback)}
              />
            </Show>
          </div>
        </Show>
      </div>

      {/* Under the body rather than in it, so it stays in view while the
          reader types, however far the plan above is scrolled. */}
      <Show when={ownOpen() && words().trim().includes("\n") && answerable()}>
        <div class="tl-plancard-lines">
          Line breaks become spaces, because the Terminal's feedback field is one line.
        </div>
      </Show>

      {/* Always mounted, so a screen reader hears each change of what it says. */}
      <div class="tl-plancard-notice" role="status" aria-live="polite">
        {noticeText()}
      </div>

      <Show when={offerTerminal() || offerApprove()}>
        <div class="tl-qcard-actions tl-plancard-actions">
          <Show when={offerTerminal() && props.onTerminal}>
            <button type="button" class="tl-qcard-back" onClick={() => props.onTerminal?.()}>
              Open Terminal
            </button>
          </Show>
          {/* The CLI's Shift+Tab on its feedback row: approve, carrying the
              words in the field above. Offered only while there are words to
              carry. It approves through option 1, so when option 1 clears the
              context the button says so: that cannot be undone from here. */}
          <Show when={offerApprove()}>
            <button
              type="button"
              class="tl-qcard-next"
              disabled={held()}
              onClick={() => void sendWords(props.onApproveWithFeedback)}
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
