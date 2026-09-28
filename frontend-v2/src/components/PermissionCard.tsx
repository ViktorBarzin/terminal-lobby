import { For, Match, Show, Switch, createSignal, type Component } from "solid-js";
import { CardDot, CardHead } from "./CardHead";
import { OwnAnswer } from "./OwnAnswer";
import type { PermissionPreview } from "./permission.logic";
import type { PermissionReading } from "./timeline.logic";

/** "Type your own answer" as the reader has it: open or not, and its words. */
export interface OwnDraft {
  open: boolean;
  words: string;
}

/** A Bash prompt is titled "Bash command"; every other tool is titled by what
 *  it does ("Edit file"), which the head then names beside its words. */
const isCommand = (title: string): boolean => /^bash\b/i.test(title.trim());

/** The prompt's No row, as it reads at rest ("No") or with its field open
 *  ("No, and tell Claude what to do differently", "No, <words>"). */
const isNoRow = (label: string): boolean => label === "No" || label.startsWith("No,");

/**
 * How the pane marks a line of an Edit's diff: "4 +def mul(a, b):" put in,
 * "5 -# end" taken out, and no mark for anything else. Used while the call is
 * not in the transcript yet, when the well has only the pane's lines.
 */
const paneSign = (line: string): "+" | "-" | undefined => {
  const m = /^\s*\d+ ([+-])/.exec(line);
  return m ? (m[1] as "+" | "-") : undefined;
};

/**
 * Scroll the well to the first changed line, one line above it, so a diff
 * whose unchanged lines fill the well still shows its change.
 */
const scrollToChange = (el: HTMLPreElement): void => {
  queueMicrotask(() => {
    const first = el.querySelector<HTMLElement>('[data-sign="+"], [data-sign="-"]');
    if (first) el.scrollTop = Math.max(0, first.offsetTop - el.offsetTop - first.offsetHeight);
  });
};

/**
 * The card that answers Claude Code's tool permission prompt, in the
 * composer's place while Claude waits (the T3 pass, prototype 6-permission).
 *
 * The rows are the prompt's own, numbered and worded as the Terminal draws
 * them (sessionio permdialog.go): what "Yes, and always allow" covers changes
 * with the tool and the directory, so the card shows the CLI's words rather
 * than its own. A tap picks the row by its number, which picks it with no
 * Enter (measured on CLI 2.1.283, 2026-09-27); the caller sends it through
 * the answer route, which first takes the cursor out of an open No field.
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
  /** The call the prompt asks about, from the transcript (permission.logic):
   *  an Edit's change or a Bash command in the well, in place of the pane's
   *  lines. Absent or null, the well shows what the pane drew. */
  preview?: PermissionPreview | null;
  /** Pick the row by its number; false when the pick did not land. */
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
  /** "Type your own answer" as the reader left it on an earlier card for the
   *  same prompt: the pane redrew the rows and a new card took over. */
  own?: OwnDraft;
  /** Told whenever the typed answer opens or its words change. */
  onOwn?: (own: OwnDraft) => void;
}> = (props) => {
  /** The row pressed, "own" for the typed answer, null before either. */
  const [pressed, setPressed] = createSignal<number | "own" | null>(null);
  const [ownOpen, setOwnOpenSignal] = createSignal(props.own?.open ?? false);
  const [words, setWordsSignal] = createSignal(props.own?.words ?? "");
  const setOwnOpen = (open: boolean): void => {
    setOwnOpenSignal(open);
    props.onOwn?.({ open, words: words() });
  };
  const setWords = (w: string): void => {
    setWordsSignal(w);
    props.onOwn?.({ open: ownOpen(), words: w });
  };
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
  const diff = () => (props.preview?.kind === "diff" ? props.preview : undefined);
  const command = () => (props.preview?.kind === "command" ? props.preview : undefined);
  /** The quiet line under the well: a command's description, as the
   *  prototype draws it, else the prompt's own question. */
  const why = (): string => command()?.description || props.reading.prompt;
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
              {isCommand(props.reading.title) || command()
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
        <Switch
          fallback={
            <Show when={props.reading.detail.length > 0}>
              <pre class="tl-code tl-permcard-detail" ref={scrollToChange}>
                <For each={props.reading.detail}>
                  {(line) => (
                    <span class="tl-permcard-line" data-sign={paneSign(line)}>
                      {line}
                    </span>
                  )}
                </For>
              </pre>
            </Show>
          }
        >
          <Match when={diff()}>
            {(d) => (
              <pre class="tl-code tl-permcard-detail">
                <span class="tl-permcard-file">{d().file}</span>
                <For each={d().lines}>
                  {(l) => (
                    <span class="tl-permcard-line" data-sign={l.sign}>
                      {`${l.sign} ${l.text}`}
                    </span>
                  )}
                </For>
              </pre>
            )}
          </Match>
          <Match when={command()}>
            {(c) => <pre class="tl-code tl-permcard-detail">{c().command}</pre>}
          </Match>
        </Switch>
        <Show when={why()}>
          <div class="tl-permcard-prompt">{why()}</div>
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
