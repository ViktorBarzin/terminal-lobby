import { For, Show, type Component } from "solid-js";
import {
  DEFAULT_CHOICE,
  isCurrentModel,
  labelFor,
  modelName,
  optionsFor,
  type ModelField,
  type ModelHarness,
  type ModelState,
} from "../lib/models";
import { CheckIcon } from "./Icons";

/**
 * The model dial's list: the running CLI's models, and how hard it thinks.
 *
 * WHY IT IS ON THE COMPOSER. Both are questions asked while looking at the
 * conversation, "is this worth Opus", "why is this taking so long", and the
 * answer used to be two overlays away in Settings, where it applied to the
 * NEXT session rather than this one. It was a chip with a menu until
 * 2026-09-24, and the menu was `position: fixed` because the bar it sat in
 * scrolled sideways and clipped it; the Quiet line's dials do not scroll, so
 * this is the body of an ordinary popover (or of the phone's sheet) and
 * nothing more.
 *
 * WHAT IT SHOWS. Each model by name with its exact slug under it: the name is
 * what the dial shows ("Opus 5.5"), and the slug is what the CLI's picker is
 * driven by (lib/models.ts). Codex names its models by slug already, so its
 * rows carry one line. Effort is a segmented control laid out three by two,
 * since both CLIs offer six levels.
 *
 * `default` is offered only where it means something. It is "leave it alone",
 * which is a real answer for a session that does not exist yet (the
 * new-session composer passes `offerDefault`) and nothing at all for one
 * already running on something.
 */
export const ModelPanel: Component<{
  harness: ModelHarness;
  /** What the session reports being on; undefined until it has answered once. */
  state: ModelState | undefined;
  /** A change is in flight, and the picker is being typed into. */
  busy: boolean;
  /** Watching: the rows show the pair and change nothing. */
  inertReason?: string;
  onPick: (field: ModelField, id: string) => void;
  /** Called after any pick, including one of the value already in force. */
  onDone?: () => void;
  /** Offer `default` as a model row and an effort choice: a session that
   *  does not exist yet can be told to start on whatever the CLI would. */
  offerDefault?: boolean;
  /** The two lists' accessible names, "Model" and "Effort" unless given. */
  names?: { model: string; effort: string };
  /** The line under the lists, in place of the one about a live session. */
  note?: string;
}> = (props) => {
  const held = (): boolean => !!props.inertReason || props.busy;
  const chosen = (field: ModelField, id: string): boolean =>
    field === "model"
      ? isCurrentModel(props.harness, id, props.state?.model)
      : props.state?.effort === id;
  const options = (field: ModelField) =>
    optionsFor(props.harness, field).filter((o) => o.id !== DEFAULT_CHOICE);
  /** `default`, where it is offered: first in both lists. */
  const offered = (): string[] => (props.offerDefault ? [DEFAULT_CHOICE] : []);
  const liveNote = (): string =>
    props.harness === "codex"
      ? "Also becomes codex's default for new sessions."
      : "Applies to this session now. The picker takes about a second.";

  const pick = (field: ModelField, id: string): void => {
    if (held()) return;
    // Driving a picker types into somebody's live pane. Doing that to land on
    // the row it is already on would put a `/model` line in the conversation
    // and change nothing.
    if (!chosen(field, id)) props.onPick(field, id);
    props.onDone?.();
  };

  return (
    <>
      <div class="tl-pick-head" aria-hidden="true">
        Model
      </div>
      <div role="radiogroup" aria-label={props.names?.model ?? "Model"}>
        <For each={offered()}>
          {(id) => (
            <button
              type="button"
              role="radio"
              class="tl-pick-row tl-pick-model"
              data-value={id}
              aria-checked={chosen("model", id)}
              aria-disabled={held() ? "true" : undefined}
              onClick={() => pick("model", id)}
            >
              <span class="tl-pick-name">Default</span>
              <span class="tl-pick-tick" aria-hidden="true">
                <Show when={chosen("model", id)}>
                  <CheckIcon />
                </Show>
              </span>
              <span class="tl-pick-sub">Whatever the CLI starts on</span>
            </button>
          )}
        </For>
        <For each={options("model")}>
          {(o) => (
            <button
              type="button"
              role="radio"
              class="tl-pick-row tl-pick-model"
              data-value={o.id}
              aria-checked={chosen("model", o.id)}
              aria-disabled={held() ? "true" : undefined}
              title={props.inertReason || o.id}
              onClick={() => pick("model", o.id)}
            >
              <span class="tl-pick-name">{modelName(props.harness, o.id)}</span>
              <span class="tl-pick-tick" aria-hidden="true">
                <Show when={chosen("model", o.id)}>
                  <CheckIcon />
                </Show>
              </span>
              <Show when={modelName(props.harness, o.id) !== o.id}>
                <span class="tl-pick-slug">{o.id}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="tl-pick-head" aria-hidden="true">
        Effort
      </div>
      <div class="tl-effort-seg" role="radiogroup" aria-label={props.names?.effort ?? "Effort"}>
        {/* A row of its own above the six levels, which keep their three by
            two. */}
        <For each={offered()}>
          {(id) => (
            <button
              type="button"
              role="radio"
              class="tl-effort-default"
              data-value={id}
              aria-checked={chosen("effort", id)}
              aria-disabled={held() ? "true" : undefined}
              onClick={() => pick("effort", id)}
            >
              Default
            </button>
          )}
        </For>
        <For each={options("effort")}>
          {(o) => (
            <button
              type="button"
              role="radio"
              data-value={o.id}
              aria-checked={chosen("effort", o.id)}
              aria-disabled={held() ? "true" : undefined}
              onClick={() => pick("effort", o.id)}
            >
              {labelFor(props.harness, "effort", o.id)}
            </button>
          )}
        </For>
      </div>
      {/* Codex's picker writes ~/.codex/config.toml and has no "this
          session only" key, where Claude's `s` does, so a change there also
          moves what the next codex session starts on. Said here rather than
          discovered later. */}
      <div class="tl-pick-note">{props.inertReason || props.note || liveNote()}</div>
    </>
  );
};
