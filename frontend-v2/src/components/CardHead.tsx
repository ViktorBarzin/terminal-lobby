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
        <button type="button" class="tl-qcard-link" onClick={() => props.onTakeControl?.()}>
          Take control
        </button>
      </Show>
    </span>
  </div>
);

/** The awaiting dot at the head's left. */
export const CardDot: Component = () => <span class="tl-qcard-dot" aria-hidden="true" />;
