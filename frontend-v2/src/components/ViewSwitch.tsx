import { Show, type Component } from "solid-js";
import type { ViewMode } from "../store/viewmode";

/**
 * Segmented [ Text | Terminal ] XOR switch (design pillar #2). A two-state
 * segment control reads honestly as "pick one view of this session" (vs T3's
 * pressed-toggle "add a pane"). An activity dot marks the inactive segment when
 * its hidden view has unseen content. Cmd/Ctrl-J drives the same toggle.
 */
export const ViewSwitch: Component<{
  mode: ViewMode;
  onSet: (m: ViewMode) => void;
  textDot?: boolean;
  terminalDot?: boolean;
}> = (props) => {
  return (
    <div class="tl-viewswitch" role="tablist" aria-label="View mode">
      <button
        type="button"
        role="tab"
        class="tl-seg"
        classList={{ active: props.mode === "text" }}
        aria-selected={props.mode === "text"}
        title="Text view (⌘/Ctrl-J to toggle)"
        onClick={() => props.onSet("text")}
      >
        <span class="tl-seg-label">Text</span>
        <Show when={props.textDot && props.mode !== "text"}>
          <span class="tl-activity-dot" aria-label="new activity" />
        </Show>
      </button>
      <button
        type="button"
        role="tab"
        class="tl-seg"
        classList={{ active: props.mode === "terminal" }}
        aria-selected={props.mode === "terminal"}
        title="Terminal view (⌘/Ctrl-J to toggle)"
        onClick={() => props.onSet("terminal")}
      >
        <span class="tl-seg-label">Terminal</span>
        <Show when={props.terminalDot && props.mode !== "terminal"}>
          <span class="tl-activity-dot" aria-label="new activity" />
        </Show>
      </button>
    </div>
  );
};
