import { For, Match, Show, Switch, createSignal, onMount, type Component } from "solid-js";
import type { ListPlacement, PageRect } from "./browser.logic";
import type { BrowserPopup, DialogType } from "../lib/browser-stream";

type SelectPopup = Extract<BrowserPopup, { kind: "select" }>;
type DialogPopup = Extract<BrowserPopup, { kind: "dialog" }>;

/**
 * The popups a headless frame does not show, drawn by the Browser panel
 * (design 2026-10-01, "What a headless frame does not show"). Chrome draws a
 * select's list, alert/confirm/prompt and the file chooser outside the page,
 * so the screencast never has them; the host reports each to the person in
 * control and this draws its own.
 *
 * Laid over the page's box, beside the stage rather than in it, so a press
 * here never reaches the stage's handlers and is never sent on to the page as
 * a click, and the panel's header (Stop, Hand back, close) stays pressable
 * while a dialog waits for an answer.
 */
export const BrowserPopups: Component<{
  /** The popup to draw for the tab on screen, if any. */
  popup: BrowserPopup | null;
  phone: boolean;
  /** Where a select's list goes, in the page box's own pixels; null to centre it. */
  place: (rect: PageRect) => ListPlacement | null;
  onChoose: (p: SelectPopup, values: string[]) => void;
  onAnswer: (p: DialogPopup, accept: boolean, text?: string) => void;
  /** Stop drawing the popup without answering it. */
  onDismiss: (p: BrowserPopup) => void;
}> = (props) => (
  <Show when={props.popup} keyed>
    {(p) => (
      <Switch>
        <Match when={p.kind === "select" && p}>
          {(s) => (
            <SelectList
              popup={s()}
              phone={props.phone}
              place={props.place}
              onChoose={(values) => props.onChoose(s(), values)}
              onDismiss={() => props.onDismiss(s())}
            />
          )}
        </Match>
        <Match when={p.kind === "dialog" && p}>
          {(d) => (
            <PageDialog
              popup={d()}
              onAnswer={(accept, text) => props.onAnswer(d(), accept, text)}
            />
          )}
        </Match>
        <Match when={p.kind === "filechooser"}>
          <div class="tl-browser-popup-notice" role="status">
            <span>File upload is not supported in the browser panel.</span>
            <button type="button" class="tl-btn" onClick={() => props.onDismiss(p)}>
              Dismiss
            </button>
          </div>
        </Match>
      </Switch>
    )}
  </Show>
);

/**
 * A select's options, hung under the select the way Chrome hangs its list, or
 * as a sheet across the bottom of a phone. A single select chooses on a press;
 * a multiple one toggles options and sends them with Done. Escape, or a press
 * beside the list, closes it without choosing.
 */
const SelectList: Component<{
  popup: SelectPopup;
  phone: boolean;
  place: (rect: PageRect) => ListPlacement | null;
  onChoose: (values: string[]) => void;
  onDismiss: () => void;
}> = (props) => {
  let box: HTMLDivElement | undefined;
  const [chosen, setChosen] = createSignal(
    new Set(props.popup.options.filter((o) => o.selected).map((o) => o.value)),
  );
  const at = props.phone ? null : props.place(props.popup.rect);
  const style = at
    ? {
        left: `${at.left}px`,
        top: `${at.top}px`,
        width: `${at.width}px`,
        "max-height": `${at.maxHeight}px`,
        transform: at.above ? "translateY(-100%)" : undefined,
      }
    : {};
  onMount(() => box?.focus({ preventScroll: true }));

  const pick = (value: string): void => {
    if (!props.popup.multiple) {
      props.onChoose([value]);
      return;
    }
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };
  const done = (): void => {
    const set = chosen();
    props.onChoose(props.popup.options.filter((o) => set.has(o.value)).map((o) => o.value));
  };

  return (
    <>
      <div
        class="tl-browser-popup-backdrop"
        ref={(el) =>
          // Not a JSX handler: the backdrop is no control, and Escape on the
          // list is its keyboard way out (components/overlay.ts).
          el.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            props.onDismiss();
          })
        }
      />
      <div
        class="tl-browser-list"
        data-sheet={at ? undefined : ""}
        data-above={at?.above ? "" : undefined}
        style={style}
      >
        <div
          ref={box}
          class="tl-browser-list-options"
          role="listbox"
          aria-label="Choose an option"
          aria-multiselectable={props.popup.multiple}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            props.onDismiss();
          }}
        >
          <For each={props.popup.options}>
            {(o) => (
              <button
                type="button"
                role="option"
                class="tl-browser-option"
                aria-selected={chosen().has(o.value)}
                disabled={o.disabled}
                onClick={() => pick(o.value)}
              >
                {o.label || " "}
              </button>
            )}
          </For>
        </div>
        <Show when={props.popup.multiple}>
          <div class="tl-browser-list-foot">
            <button type="button" class="tl-btn tl-btn-approve" onClick={done}>
              Done
            </button>
          </div>
        </Show>
      </div>
    </>
  );
};

const OK_LABEL: Record<DialogType, string> = {
  alert: "OK",
  confirm: "OK",
  prompt: "OK",
  beforeunload: "Leave",
};
const CANCEL_LABEL: Record<DialogType, string> = {
  alert: "",
  confirm: "Cancel",
  prompt: "Cancel",
  beforeunload: "Stay",
};

/**
 * alert, confirm, prompt or the leave-page question, as a small modal over the
 * page. The page waits on it, so it has no way out but an answer; Stop and
 * Hand back in the header above it still work.
 */
const PageDialog: Component<{
  popup: DialogPopup;
  onAnswer: (accept: boolean, text?: string) => void;
}> = (props) => {
  const [text, setText] = createSignal(props.popup.defaultValue);
  let first: HTMLElement | undefined;
  onMount(() => first?.focus({ preventScroll: true }));
  const isPrompt = (): boolean => props.popup.type === "prompt";
  const ok = (): void => {
    if (isPrompt()) props.onAnswer(true, text());
    else props.onAnswer(true);
  };
  return (
    <div class="tl-browser-dialog-layer">
      <form
        class="tl-browser-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="The page asks"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <p class="tl-browser-dialog-message">
          {props.popup.type === "beforeunload"
            ? "Leave this page? Changes you made may not be saved."
            : props.popup.message}
        </p>
        <Show when={isPrompt()}>
          <input
            ref={(el) => {
              first = el;
            }}
            class="tl-browser-dialog-field"
            type="text"
            aria-label="Answer"
            autocomplete="off"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Show>
        <div class="tl-browser-dialog-actions">
          <Show when={CANCEL_LABEL[props.popup.type]}>
            {(label) => (
              <button type="button" class="tl-btn" onClick={() => props.onAnswer(false)}>
                {label()}
              </button>
            )}
          </Show>
          <button
            ref={(el) => {
              if (!isPrompt()) first = el;
            }}
            type="submit"
            class="tl-btn tl-btn-approve"
          >
            {OK_LABEL[props.popup.type]}
          </button>
        </div>
      </form>
    </div>
  );
};
