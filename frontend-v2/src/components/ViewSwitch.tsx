import { Show, type Component } from "solid-js";
import type { ViewMode } from "../store/viewmode";
import { MessageTextIcon, TerminalIcon } from "./Icons";

/**
 * Segmented [ Text | Terminal ] XOR switch (design pillar #2). A two-state
 * segment control reads honestly as "pick one view of this session" (vs T3's
 * pressed-toggle "add a pane"). An activity dot marks the inactive segment when
 * its hidden view has unseen content. Cmd/Ctrl-J drives the same toggle.
 *
 * Each segment carries an icon AND a label; a narrow bar hides the labels (see
 * .tl-seg-label in sidebar.css) and keeps the icons, which is what the pillar-#2
 * research asked for. At its labelled size the control is 131px of a 390px
 * header, and with a back button and an act-as chip beside it that did not fit —
 * measured overflowing the bar by 25px with the session name squeezed to 18px.
 * The aria-label is on the button rather than on the text, so an icon-only
 * segment still announces itself.
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
        aria-label="Text view"
        title="Text view (⌘/Ctrl-J to toggle)"
        onClick={() => props.onSet("text")}
      >
        <MessageTextIcon size={15} />
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
        aria-label="Terminal view"
        title="Terminal view (⌘/Ctrl-J to toggle)"
        onClick={() => props.onSet("terminal")}
      >
        <TerminalIcon size={15} />
        <span class="tl-seg-label">Terminal</span>
        <Show when={props.terminalDot && props.mode !== "terminal"}>
          <span class="tl-activity-dot" aria-label="new activity" />
        </Show>
      </button>
    </div>
  );
};
