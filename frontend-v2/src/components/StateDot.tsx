import { type Component } from "solid-js";
import { stateLabel } from "./lobby.logic";
import type { BackgroundWork } from "../types/lobby";

/**
 * Claude state dot (inventory Cat.1 "Claude state dots"): running pulses,
 * awaiting shows a static violet glow ring, done sits dimmed — or full with a
 * ring while UNSEEN. Colors come from the per-theme --state-* tokens. Sizes are
 * driven by the `size` prop so the same dot serves cards and collapsed-header
 * chips.
 */
export const StateDot: Component<{
  state?: string;
  unseen?: boolean;
  size?: number;
  title?: boolean;
  /** What a running session is still waiting on, so the tooltip and the screen
   *  reader can say WHY it is working. The dot itself does not change: a
   *  session held by background work is running, not a fourth state. */
  bg?: BackgroundWork;
}> = (props) => {
  const cls = () => {
    const parts = ["tl-state-dot"];
    if (props.state) parts.push("tl-state-" + props.state);
    if (props.state === "done" && props.unseen) parts.push("tl-state-unseen");
    return parts.join(" ");
  };
  return (
    <span
      class={cls()}
      style={props.size ? { width: `${props.size}px`, height: `${props.size}px`, "flex-basis": `${props.size}px` } : undefined}
      aria-label={props.title !== false ? stateLabel(props.state, props.unseen, props.bg) : undefined}
      title={props.title !== false ? stateLabel(props.state, props.unseen, props.bg) : undefined}
    />
  );
};
