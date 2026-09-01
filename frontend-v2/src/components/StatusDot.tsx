import { Show, type Component } from "solid-js";
import {
  badgeWord,
  scope,
  verdict,
  worst,
  type Channel,
  type ChannelId,
} from "../diagnostics/status";

/**
 * The connection badge — the one thing on screen that says whether this client
 * is actually connected, and the way into the Right now panel.
 *
 * IT SITS IN TWO PLACES AND IS THE SAME COMPONENT. The session bar carries all
 * five channels; the sidebar header carries the three a list screen can
 * honestly report. Scoping is the rule that makes one component safe in both:
 * a mobile list screen has no terminal on it, so a session's dead socket must
 * not colour a badge sitting above a list of sessions. It would name the wrong
 * problem on the one screen that cannot show the right one.
 *
 * DOT ALWAYS, WORD ONLY WHEN WRONG. Healthy is the state nearly all the time
 * and does not earn text in a session bar that is already tight on a phone. A
 * problem does, and gets a plain one — "Reconnecting", "Offline", "Update
 * ready" — rather than the raw stream vocabulary the old badge showed
 * ("open", "no transcript"), which described a transport rather than answering
 * a question.
 */
export const StatusDot: Component<{
  channels: () => readonly Channel[];
  /** which channels this surface can honestly report. */
  only: readonly ChannelId[];
  /** open the Right now panel. Absent leaves the badge a plain readout. */
  onOpen?: () => void;
  /** extra class for placement (the session bar and the header sit differently). */
  class?: string;
}> = (props) => {
  const shown = () => scope(props.channels(), props.only);
  const state = () => worst(shown());
  const word = () => badgeWord(shown());
  // The tooltip is the verdict, so a desktop hover answers the question without
  // opening anything. It is not the only route: the badge is a button, because
  // a title attribute is unreachable on the device this matters most on.
  const title = () => `${verdict(shown())} Tap for details.`;

  return (
    <button
      type="button"
      class={`tl-status-dot ${props.class ?? ""}`}
      classList={{ "is-flat": !props.onOpen }}
      data-status={state()}
      title={title()}
      aria-label={verdict(shown())}
      disabled={!props.onOpen}
      onClick={() => props.onOpen?.()}
    >
      <span class="tl-status-dot-mark" aria-hidden="true" />
      <Show when={word()}>
        <span class="tl-status-dot-word">{word()}</span>
      </Show>
    </button>
  );
};
