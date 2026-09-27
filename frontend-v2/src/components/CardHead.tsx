import { Show, type Component, type JSX } from "solid-js";

/**
 * The head row every card in the composer's place shares (the T3 pass,
 * prototype `.cd-head`): the awaiting dot and what Claude is waiting on on the
 * left, quiet underlined links on the right.
 *
 * A watching device reads the card but cannot answer it, so the head offers
 * Take control there, the way the watching composer does.
 */
export const CardHead: Component<{
  /** The left side: the dot is drawn here, the words are the card's. */
  lead: JSX.Element;
  /** The card's own links on the right ("Open in Terminal", "Read the full plan"). */
  links?: JSX.Element;
  /** Why this device may not answer, or empty when it may. */
  inert?: string;
  onTakeControl?: () => void;
}> = (props) => (
  <div class="tl-qcard-head">
    {props.lead}
    <span class="tl-qcard-links">
      {props.links}
      <Show when={props.inert && props.onTakeControl}>
        <button
          type="button"
          class="tl-qcard-link"
          onClick={(e) => {
            // The link goes away under the click, and the focus with it, so
            // the card takes it back and its row digits work at once.
            const card = e.currentTarget.closest<HTMLElement>(".tl-qcard");
            props.onTakeControl?.();
            queueMicrotask(() => keepFocusIn(card));
          }}
        >
          Take control
        </button>
      </Show>
    </span>
  </div>
);

/** The awaiting dot at the head's left. */
export const CardDot: Component = () => <span class="tl-qcard-dot" aria-hidden="true" />;

/**
 * Hand a card the focus when the focus has fallen out of it: onto the page,
 * onto an element that has gone, or onto a button that has turned disabled.
 * The row digits only act on keys from inside the Text view, so a card that
 * loses the focus under a click of its own stops answering them.
 */
export function keepFocusIn(card: HTMLElement | null | undefined): void {
  if (!card?.isConnected) return;
  const a = document.activeElement;
  const lost =
    !a ||
    a === document.body ||
    !a.isConnected ||
    ((a instanceof HTMLButtonElement || a instanceof HTMLTextAreaElement) && a.disabled);
  if (lost) card.focus({ preventScroll: true });
}
