import { For, Show, createSignal, createUniqueId, type JSX, type Component } from "solid-js";
import { formatStep, stepTo, type StepSpec } from "./stepper";

/**
 * The row grammar every settings page is built from.
 *
 * The panel's thirteen groups each wrote their own markup, so a checkbox, a
 * slider and a segmented picker sat at three different heights with their
 * labels in three different places. Here a row is always the same shape —
 * label flush left, control flush right, on one baseline — which is what lets
 * the right-hand edge read as a column of states rather than a stack of forms.
 *
 * Explanations sit behind the ⓘ beside the label and expand in place. A `note`
 * is the exception: text that describes a CONSEQUENCE rather than explaining a
 * control, which stays visible because not reading it has a cost.
 */

/** A titled block within a page. The title is optional: a page with one block
 *  does not need to repeat the page's own name. */
export const Group: Component<{ title?: string; children: JSX.Element }> = (props) => (
  <section class="tl-set-group">
    <Show when={props.title}>
      <h3 class="tl-set-group-title">{props.title}</h3>
    </Show>
    {props.children}
  </section>
);

/** Marks a row whose value lives in this browser only. Roaming is the common
 *  case and stays unmarked, so this reads as an exception rather than as
 *  furniture on every line. */
export const ScopeChip: Component = () => (
  <span class="tl-set-chip" title="Stored in this browser — it does not follow you to your other devices">
    this device
  </span>
);

export const Row: Component<{
  label: string;
  /** Associates the label with a single control, so clicking it activates. */
  labelFor?: string;
  /** Behind the ⓘ. Absent means no ⓘ is drawn. */
  hint?: JSX.Element;
  /** Always visible under the row. For consequences, not explanations. */
  note?: JSX.Element;
  /** Draw the "this device" chip. */
  deviceOnly?: boolean;
  /** Stack the control under the label instead of beside it — for controls
   *  too wide to share a baseline, like the theme grid. */
  stacked?: boolean;
  children: JSX.Element;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const hintId = createUniqueId();

  return (
    <div class="tl-set-row" classList={{ "is-stacked": props.stacked }}>
      <div class="tl-set-row-main">
        <div class="tl-set-row-head">
          <Show
            when={props.labelFor}
            fallback={<span class="tl-set-row-label">{props.label}</span>}
          >
            <label class="tl-set-row-label" for={props.labelFor}>
              {props.label}
            </label>
          </Show>
          <Show when={props.deviceOnly}>
            <ScopeChip />
          </Show>
          <Show when={props.hint}>
            <button
              type="button"
              class="tl-set-info"
              aria-expanded={open()}
              aria-controls={hintId}
              aria-label={`Explain ${props.label}`}
              title={open() ? "Hide" : "What is this?"}
              onClick={() => setOpen((v) => !v)}
            >
              ⓘ
            </button>
          </Show>
        </div>
        <div class="tl-set-row-ctl">{props.children}</div>
      </div>
      <Show when={props.hint && open()}>
        <div class="tl-set-hint" id={hintId}>
          {props.hint}
        </div>
      </Show>
      <Show when={props.note}>
        <div class="tl-set-note">{props.note}</div>
      </Show>
    </div>
  );
};

/**
 * A checkbox drawn as a switch.
 *
 * Still an `<input type="checkbox">` underneath — `role="switch"` narrows what
 * assistive tech announces without changing how it is operated, and keeps every
 * existing test that reads `.checked` working.
 */
export const Toggle: Component<{
  checked: boolean;
  onChange: (on: boolean) => void;
  /** For the accessible name when no Row label points at this control. */
  label?: string;
  id?: string;
  disabled?: boolean;
}> = (props) => (
  <input
    type="checkbox"
    role="switch"
    class="tl-set-toggle"
    id={props.id}
    checked={props.checked}
    disabled={props.disabled}
    aria-label={props.label}
    onChange={(e) => props.onChange(e.currentTarget.checked)}
  />
);

/** − value + over a fixed range. The value is `aria-live` so a screen reader
 *  hears the result of a press rather than only the press. */
export const Stepper: Component<{
  value: number;
  spec: StepSpec;
  unit?: string;
  /** Names the group, and the two buttons derive their labels from it. */
  label: string;
  onChange: (v: number) => void;
}> = (props) => {
  const at = (dir: number) => stepTo(props.value, dir, props.spec);
  return (
    <div class="tl-set-stepper" role="group" aria-label={props.label}>
      <button
        type="button"
        class="tl-set-step-btn"
        aria-label={`Decrease ${props.label.toLowerCase()}`}
        title="Decrease"
        disabled={props.value <= props.spec.min}
        onClick={() => props.onChange(at(-1))}
      >
        −
      </button>
      <span class="tl-set-step-value" aria-live="polite">
        {formatStep(props.value, props.spec, props.unit)}
      </span>
      <button
        type="button"
        class="tl-set-step-btn"
        aria-label={`Increase ${props.label.toLowerCase()}`}
        title="Increase"
        disabled={props.value >= props.spec.max}
        onClick={() => props.onChange(at(+1))}
      >
        +
      </button>
    </div>
  );
};

/** One-of-N as a button strip. Carries the same palette the panel used before,
 *  so a page that mixes it with toggles still reads as one surface. */
export function Segmented<T extends string | number>(props: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  format?: (v: T) => string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div class="tl-set-seg" role="group" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            classList={{ active: props.value === o }}
            aria-pressed={props.value === o}
            disabled={props.disabled}
            onClick={() => props.onChange(o)}
          >
            {props.format ? props.format(o) : String(o)}
          </button>
        )}
      </For>
    </div>
  );
}

/** A read-only fact about this device: permission state, subscription, bell.
 *  Visually distinct from a control row so nobody tries to click it. */
export const Readout: Component<{ label: string; value: JSX.Element }> = (props) => (
  <div class="tl-set-readout">
    <span>{props.label}</span>
    <b>{props.value}</b>
  </div>
);

/** A row whose "control" is an action. The label carries the button. */
export const ActionRow: Component<{
  label: string;
  note?: JSX.Element;
  hint?: JSX.Element;
  deviceOnly?: boolean;
  children: JSX.Element;
}> = (props) => (
  <Row
    label={props.label}
    hint={props.hint}
    note={props.note}
    deviceOnly={props.deviceOnly}
  >
    <div class="tl-set-actions">{props.children}</div>
  </Row>
);
