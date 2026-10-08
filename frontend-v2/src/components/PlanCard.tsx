import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { PlanOptionView } from "../lib/answer-api";
import { CardDot, CardHead } from "./CardHead";
import { Markdown } from "./Markdown";
import { OwnAnswer } from "./OwnAnswer";
import { splitPlanTitle, type PlanNotice, type PlanSending } from "./plan.logic";
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
 * ExitPlanMode call's input, or null while the call is not written yet), or
 * from the reading when the call was written with an empty input, the
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
 * DIGITS. A digit approves the row it names, as the question and permission
 * cards' keycaps do (deployed review rounds 3 to 5, 2026-09-28: the card drew
 * numbered keycaps while a digit typed into the hidden message). Option 1 in
 * the usual layout clears the context and starts carrying out the plan, so a
 * stray 1 must never be one: digits count only once the Text view arms the
 * card's keys, a moment after it docks, and only from inside the view with
 * nothing editable focused.
 *
 * WHAT IT LEAVES OUT, ON PURPOSE. No raw keypad when the pane cannot be read,
 * for the same reason. No
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
  /** The Text view says the card's keys are live: a digit approves its row. */
  keysActive?: boolean;
}> = (props) => {
  const [full, setFull] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [ownOpen, setOwnOpen] = createSignal(false);
  const [words, setWords] = createSignal("");
  let planEl: HTMLDivElement | undefined;
  let wellEl: HTMLDivElement | undefined;
  let cardEl: HTMLDivElement | undefined;

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

  // Keys 1-9 approve the row they name, the way the question and permission
  // cards' keycaps do: when the Text view says the card's keys are live (a
  // moment after it docks), the focus is in this card's view, and nothing
  // editable has it, so the rest of a sentence typed as the card docked is
  // never an approval.
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!props.keysActive || !answerable() || held()) return;
      const t = e.target;
      const view = cardEl?.closest(".tl-textview") ?? cardEl;
      if (!(t instanceof Node) || !view?.contains(t)) return;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.closest('[contenteditable]:not([contenteditable="false"])'))
        return;
      if (!/^[1-9]$/.test(e.key)) return;
      const option = props.reading?.options.find((o) => o.number === Number(e.key));
      if (!option) return;
      e.preventDefault();
      props.onApprove({ number: option.number, label: option.label });
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <div
      ref={cardEl}
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
                    {/* The CLI's own number, which a digit presses once the
                        card's keys are live. */}
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
          {/* Approve, carrying the words in the field above. Offered only
              while there are words to carry. The server presses the first row
              that keeps the context, and the words reach Claude with the
              approval (ADR-0036, 2026-10-08), so it never clears the context. */}
          <Show when={offerApprove()}>
            <button
              type="button"
              class="tl-qcard-next"
              disabled={held()}
              onClick={() => void sendWords(props.onApproveWithFeedback)}
            >
              Approve with this feedback
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};
