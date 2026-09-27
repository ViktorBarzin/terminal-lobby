import { Show, type Component } from "solid-js";
import { PenIcon, SendArrowIcon } from "./Icons";

/**
 * A card's last row, "Type your own answer" (the T3 pass, prototype
 * 6-question `.cd-own`): a muted row with a pen where the digit would be, which
 * a tap turns into a field with its own round Send. It is where the reader's
 * words go while a card has the composer's place, since the composer itself is
 * hidden then.
 *
 * It holds nothing: the card owns whether it is open and what it says, so the
 * words can belong to one question and survive moving between questions.
 */
export const OwnAnswer: Component<{
  /** The row's words, and the field's name and placeholder. */
  label: string;
  /** A line under the label, as the permission card's row carries. */
  sub?: string;
  open: boolean;
  value: string;
  disabled: boolean;
  onOpen: () => void;
  onInput: (value: string) => void;
  onSend: () => void;
}> = (props) => {
  let field: HTMLTextAreaElement | undefined;
  const canSend = () => !props.disabled && props.value.trim() !== "";
  const send = (): void => {
    if (canSend()) props.onSend();
  };
  return (
    <Show
      when={props.open}
      fallback={
        <button
          type="button"
          class="tl-qcard-option tl-qcard-own"
          disabled={props.disabled}
          onClick={() => {
            props.onOpen();
            // The field is drawn by the time the open lands; focusing it
            // raises the keyboard on a phone and scrolls it into view.
            queueMicrotask(() => field?.focus());
          }}
        >
          <span class="tl-qcard-key" aria-hidden="true">
            <PenIcon />
          </span>
          <span class="tl-qcard-label">{props.label}</span>
          <Show when={props.sub}>
            <span class="tl-qcard-desc">{props.sub}</span>
          </Show>
        </button>
      }
    >
      <div class="tl-qcard-ownfield">
        <textarea
          ref={field}
          class="tl-qcard-owninput"
          rows={1}
          aria-label={props.label}
          placeholder={`${props.label}…`}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter sends and Shift+Enter breaks the line, as in the composer.
            // `isComposing` leaves the Enter an IME uses to commit a candidate.
            if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
            e.preventDefault();
            send();
          }}
        />
        <button
          type="button"
          class="tl-send"
          aria-label="Send your answer"
          title="Send your answer (Enter)"
          disabled={!canSend()}
          onClick={send}
        >
          <span class="tl-disc">
            <SendArrowIcon />
          </span>
        </button>
      </div>
    </Show>
  );
};
