import { For, Show, type Component } from "solid-js";
import { MODES, modeId, type ModeId } from "../logic/modes";
import { CheckIcon, ShieldIcon, WarnIcon } from "./Icons";

/**
 * The mode dial's list: every permission mode, one line each on what it does.
 *
 * It replaced a chip that stepped the mode on every click (Quiet line
 * composer, 2026-09-24). A pick goes to the caller by the CLI's identifier and
 * the server walks Shift+Tab to it (lib/mode-api.ts); this view draws the
 * rows and says which ones cannot be picked, and why.
 *
 * THREE REASONS A ROW IS HELD. No ask is not a stop on Shift+Tab: a session
 * can start in it, and the first press leaves it for good (measured on CLI
 * 2.1.281, memory #13911), so no walk can reach it, and its row is offered
 * only to a session already in it. A mode the server has answered
 * `unavailable` for is not offered by this session's launch flags. And every
 * row is held while a dialog is on the pane, because Shift+Tab means
 * something else there: on the plan approval's feedback row it approves the
 * plan with whatever was typed (memory #13896).
 */
export const ModePanel: Component<{
  /** The mode the dial shows, as read off the pane or the transcript. */
  current: string;
  /** Modes the server has said this session does not offer. */
  unavailable?: ReadonlySet<string>;
  /** Why no mode can be picked right now; every row is held. */
  held?: string;
  onPick: (mode: ModeId) => void;
}> = (props) => {
  const current = () => modeId(props.current);
  /** Why this row cannot be picked, or "" when it can. */
  const why = (id: ModeId): string => {
    if (props.held) return props.held;
    if (props.unavailable?.has(id)) return "Not offered in this session";
    if (id === "dontAsk" && current() !== "dontAsk") {
      return "Set when the session starts. Shift+Tab cannot reach it";
    }
    return "";
  };
  return (
    <>
      <div class="tl-pick-head" aria-hidden="true">
        Permission mode
      </div>
      <div role="radiogroup" aria-label="Permission mode">
        <For each={MODES}>
          {(m, i) => (
            <>
              <Show when={m.tone === "danger" && MODES[i() - 1]?.tone !== "danger"}>
                <div class="tl-pick-gap" aria-hidden="true" />
              </Show>
              <button
                type="button"
                role="radio"
                class="tl-pick-row"
                data-tone={m.tone}
                aria-checked={current() === m.id}
                aria-disabled={why(m.id) ? "true" : undefined}
                title={why(m.id) || undefined}
                onClick={() => {
                  if (!why(m.id)) props.onPick(m.id);
                }}
              >
                <span class="tl-pick-icon">
                  <Show when={m.tone === "danger"} fallback={<ShieldIcon size={14} />}>
                    <WarnIcon size={14} />
                  </Show>
                </span>
                <span class="tl-pick-name">{m.label}</span>
                <span class="tl-pick-tick" aria-hidden="true">
                  <Show when={current() === m.id}>
                    <CheckIcon />
                  </Show>
                </span>
                {/* A held row says why in its own sub line, where a phone
                    can read it; the dialog hold says it once, below. */}
                <span class="tl-pick-sub">
                  {why(m.id) && why(m.id) !== props.held ? why(m.id) : m.line}
                </span>
              </button>
            </>
          )}
        </For>
      </div>
      <div class="tl-pick-note">
        {props.held || "Shift+Tab in the message steps to the next mode."}
      </div>
    </>
  );
};
