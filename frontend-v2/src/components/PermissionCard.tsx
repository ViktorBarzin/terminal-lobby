import { For, Show, createSignal, type Component } from "solid-js";
import type { PermissionReading } from "./timeline.logic";

/**
 * The card that answers Claude Code's tool permission prompt, docked above the
 * composer where the question and plan cards dock.
 *
 * The rows are the prompt's own, numbered and worded as the Terminal draws
 * them (sessionio permdialog.go): what "Yes, and always allow" covers changes
 * with the tool and the directory, so the card shows the CLI's words rather
 * than its own. A tap presses the row's number, which picks the row with no
 * Enter (measured on CLI 2.1.283, 2026-09-27).
 *
 * One press per prompt. The caller keys the card on the reading, so a new
 * prompt gets a new card, and once a press has landed this one stays inert:
 * a second tap would reach the pane after the prompt has gone, and type a
 * digit into Claude's input line.
 */
export const PermissionCard: Component<{
  reading: PermissionReading;
  /** Press the row's number; false when the key did not reach the session. */
  onPick: (option: number) => Promise<boolean>;
  /** Show the Terminal view. */
  onTerminal?: () => void;
  /** Why this device may not answer (it is watching), or empty when it may. */
  inert?: string;
  /**
   * Hand the caller the card's own press, for a row's number typed on the
   * keyboard. It answers true when the card has that row, whether or not the
   * press went out, so the digit is not typed into the field instead.
   */
  register?: (press: (row: number) => boolean) => void;
}> = (props) => {
  const [pressed, setPressed] = createSignal<number | null>(null);
  // The refusal while watching is the caller's (onPick), so a key press is
  // told why; a tap cannot reach here, the rows being disabled.
  const pick = async (n: number): Promise<void> => {
    if (pressed() !== null) return;
    setPressed(n);
    if (!(await props.onPick(n))) setPressed(null);
  };
  props.register?.((row) => {
    if (!props.reading.options.some((o) => o.number === row)) return false;
    void pick(row);
    return true;
  });
  return (
    <div class="tl-qcard tl-permcard" role="dialog" aria-label="Claude is asking to use a tool">
      <div class="tl-qcard-head">
        <span class="tl-qcard-title">
          {props.reading.title || "Claude is asking to use a tool"}
        </span>
      </div>
      <div class="tl-qcard-body">
        <Show when={props.reading.detail.length > 0}>
          <pre class="tl-code tl-permcard-detail">{props.reading.detail.join("\n")}</pre>
        </Show>
        <Show when={props.reading.prompt}>
          <div class="tl-qcard-question">{props.reading.prompt}</div>
        </Show>
        <div class="tl-qcard-options">
          <For each={props.reading.options}>
            {(option) => (
              <button
                type="button"
                class="tl-qcard-option"
                data-chosen={pressed() === option.number ? "true" : undefined}
                aria-busy={pressed() === option.number ? "true" : undefined}
                disabled={pressed() !== null || !!props.inert}
                title={props.inert || undefined}
                onClick={() => void pick(option.number)}
              >
                <span class="tl-qcard-key" aria-hidden="true">
                  {option.number}
                </span>
                <span class="tl-qcard-label">{option.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <Show when={props.onTerminal}>
        <div class="tl-qcard-actions">
          <button type="button" class="tl-qcard-back" onClick={() => props.onTerminal?.()}>
            Open Terminal
          </button>
        </div>
      </Show>
    </div>
  );
};
