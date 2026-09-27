import { For, Show, createSignal, type Component } from "solid-js";
import { CardDot, CardHead } from "./CardHead";
import { OwnAnswer } from "./OwnAnswer";
import type { PermissionReading } from "./timeline.logic";

/** A Bash prompt is titled "Bash command"; every other tool is titled by what
 *  it does ("Edit file"), which the head then names beside its words. */
const isCommand = (title: string): boolean => /^bash\b/i.test(title.trim());

/** The prompt's No row, as it reads at rest ("No") or with its field open
 *  ("No, and tell Claude what to do differently", "No, <words>"). */
const isNoRow = (label: string): boolean => label === "No" || label.startsWith("No,");

/**
 * The card that answers Claude Code's tool permission prompt, in the
 * composer's place while Claude waits (the T3 pass, prototype 6-permission).
 *
 * The rows are the prompt's own, numbered and worded as the Terminal draws
 * them (sessionio permdialog.go): what "Yes, and always allow" covers changes
 * with the tool and the directory, so the card shows the CLI's words rather
 * than its own. A tap presses the row's number, which picks the row with no
 * Enter (measured on CLI 2.1.283, 2026-09-27).
 *
 * The last row is "Type your own answer" (`OwnAnswer`), under the CLI's own
 * rows, No included. Its words decline the tool call and tell Claude what to
 * do instead: the server drives the prompt's No row, whose Tab opens a field
 * the CLI hands Claude as "the user said: <words>" (sessionio permdrive.go).
 * It is offered only when the prompt draws a No row to drive.
 *
 * One press per prompt, a row or the words. The caller keys the card on the
 * reading, so a new prompt gets a new card, and once a press has landed this
 * one stays inert: a second tap would reach the pane after the prompt has
 * gone, and type a digit into Claude's input line.
 */
export const PermissionCard: Component<{
  reading: PermissionReading;
  /** Press the row's number; false when the key did not reach the session. */
  onPick: (option: number) => Promise<boolean>;
  /** Decline with these words; false when the decline did not land. Absent
   *  means this view cannot, and the card offers no typed answer. */
  onDecline?: (words: string) => Promise<boolean>;
  /** Show the Terminal view. */
  onTerminal?: () => void;
  /** Why this device may not answer (it is watching), or empty when it may. */
  inert?: string;
  /** Stop watching and answer from this device. */
  onTakeControl?: () => void;
  /**
   * Hand the caller the card's own press, for a row's number typed on the
   * keyboard. It answers true when the card has that row, whether or not the
   * press went out, so the digit is not typed into the field instead.
   */
  register?: (press: (row: number) => boolean) => void;
}> = (props) => {
  /** The row pressed, "own" for the typed answer, null before either. */
  const [pressed, setPressed] = createSignal<number | "own" | null>(null);
  const [ownOpen, setOwnOpen] = createSignal(false);
  const [words, setWords] = createSignal("");
  // The refusal while watching is the caller's (onPick), so a key press is
  // told why; a tap cannot reach here, the rows being disabled.
  const pick = async (n: number): Promise<void> => {
    if (pressed() !== null) return;
    setPressed(n);
    if (!(await props.onPick(n))) setPressed(null);
  };
  const decline = async (): Promise<void> => {
    if (pressed() !== null || !props.onDecline) return;
    setPressed("own");
    if (!(await props.onDecline(words()))) setPressed(null);
  };
  const canDecline = (): boolean =>
    !!props.onDecline && props.reading.options.some((o) => isNoRow(o.label));
  props.register?.((row) => {
    if (!props.reading.options.some((o) => o.number === row)) return false;
    void pick(row);
    return true;
  });
  /** The tool's own title, when the head's words do not already say it. */
  const tag = (): string => (isCommand(props.reading.title) ? "" : props.reading.title.trim());
  return (
    <div
      class="tl-qcard tl-permcard"
      role="dialog"
      aria-label="Claude is asking to use a tool"
      tabIndex={-1}
    >
      <CardHead
        lead={
          <span class="tl-qcard-lead">
            <CardDot />
            <span class="tl-qcard-title">
              {isCommand(props.reading.title)
                ? "Claude wants to run a command"
                : "Claude wants to use a tool"}
            </span>
            <Show when={tag()}>
              <span class="tl-qcard-tag">{tag()}</span>
            </Show>
          </span>
        }
        links={
          <Show when={props.onTerminal}>
            <button type="button" class="tl-qcard-link" onClick={() => props.onTerminal?.()}>
              Open in Terminal
            </button>
          </Show>
        }
        inert={props.inert}
        onTakeControl={props.onTakeControl}
      />
      <div class="tl-qcard-body">
        <Show when={props.reading.detail.length > 0}>
          <pre class="tl-code tl-permcard-detail">{props.reading.detail.join("\n")}</pre>
        </Show>
        <Show when={props.reading.prompt}>
          <div class="tl-permcard-prompt">{props.reading.prompt}</div>
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
          <Show when={canDecline()}>
            <OwnAnswer
              label="Type your own answer"
              sub="Says no, and tells Claude what to do instead"
              open={ownOpen()}
              value={words()}
              disabled={pressed() !== null || !!props.inert}
              onOpen={() => setOwnOpen(true)}
              onInput={setWords}
              onSend={() => void decline()}
            />
          </Show>
        </div>
      </div>
    </div>
  );
};
