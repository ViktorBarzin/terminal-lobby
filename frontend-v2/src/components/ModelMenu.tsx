import { For, Show, createSignal, type Accessor, type Component, type JSX } from "solid-js";
import { createDismissableMenu } from "./menu";
import {
  DEFAULT_CHOICE,
  isCurrentModel,
  labelFor,
  optionsFor,
  summarise,
  type ModelField,
  type ModelHarness,
  type ModelState,
} from "../lib/models";

/**
 * The model and effort chip, beside the permission mode on a session's own
 * composer.
 *
 * WHY HERE. Both are questions asked while looking at the conversation — "is
 * this worth Opus", "why is this taking so long" — and the answer used to be
 * two overlays away in Settings, where it applied to the NEXT session rather
 * than this one. The mode chip next door already established the shape: what is
 * in force, one tap from changing it, in the row you are typing in.
 *
 * WHAT IT SHOWS. The live pair, off the session's own transcript for Claude and
 * off its pane for codex (lib/models.ts). A session that has not answered yet
 * has said nothing about either, so the chip reads "model" rather than
 * inventing a value — showing the composer's stored preference here would be
 * showing what the NEXT session will start on, which is a different question.
 *
 * `default` is not offered. It means "leave it alone", which is a real answer
 * for a session that does not exist yet and nothing at all for one already
 * running on something.
 */
export const ModelMenu: Component<{
  harness: ModelHarness;
  /** What the session reports being on; undefined until it has answered once. */
  state: Accessor<ModelState | undefined>;
  /** A change is in flight — the picker is being driven, which takes ~1s. */
  busy: Accessor<boolean>;
  onPick: (field: ModelField, id: string) => void;
  /** Watching: the chip shows the pair but changes nothing. */
  inertReason?: string;
}> = (props) => {
  const menu = createDismissableMenu(() => () => {});
  let chipEl: HTMLButtonElement | undefined;
  /**
   * Where the popup goes, in viewport coordinates.
   *
   * It is `fixed` rather than absolutely placed inside the chip, because the
   * bar it sits in SCROLLS: `.tl-bar-left` is `overflow: auto` so a row of
   * chips can slide sideways on a narrow screen, and an absolutely-placed
   * popup inside it is clipped to that box — measured on 2026-09-05, the menu
   * rendered at the right size and was invisible but for a 4px sliver.
   * Nothing between here and the root establishes a containing block, so
   * `fixed` escapes the clip; the coordinates are read when it opens, and it
   * closes on any outside press.
   */
  const [at, setAt] = createSignal<{ left: number; bottom: number } | null>(null);
  const place = (): JSX.CSSProperties | undefined => {
    const a = at();
    return a ? { left: `${a.left}px`, bottom: `${a.bottom}px` } : undefined;
  };
  const toggle = (): void => {
    if (chipEl && !menu.open()) {
      const r = chipEl.getBoundingClientRect();
      setAt({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    }
    menu.toggle();
  };
  const summary = (): string => summarise(props.harness, props.state());
  const chosen = (field: ModelField, id: string): boolean =>
    field === "model"
      ? isCurrentModel(props.harness, id, props.state()?.model)
      : props.state()?.effort === id;

  const pick = (field: ModelField, id: string): void => {
    menu.close();
    if (chosen(field, id)) return; // already there; driving the picker would say nothing
    props.onPick(field, id);
  };

  const options = (field: ModelField) =>
    optionsFor(props.harness, field).filter((o) => o.id !== DEFAULT_CHOICE);

  return (
    <span class="tl-model" ref={menu.anchor}>
      <button
        ref={chipEl}
        type="button"
        class="tl-model-chip"
        aria-haspopup="menu"
        aria-expanded={menu.open()}
        aria-label="Model and effort"
        data-busy={props.busy() ? "" : undefined}
        disabled={!!props.inertReason || props.busy()}
        title={
          props.inertReason ||
          (summary()
            ? `Model and effort: ${summary()}`
            : "Model and effort — the session has not answered yet")
        }
        onClick={toggle}
      >
        {summary() || "model"}
      </button>
      <Show when={menu.open()}>
        <div
          class="tl-menu tl-model-menu"
          role="menu"
          style={place()}
          onClick={(e) => e.stopPropagation()}
        >
          <For each={["model", "effort"] as ModelField[]}>
            {(field) => (
              <>
                <div class="tl-menu-label">{field === "model" ? "Model" : "Effort"}</div>
                <For each={options(field)}>
                  {(o) => (
                    <button
                      type="button"
                      class="tl-menu-item tl-model-item"
                      role="menuitemradio"
                      aria-checked={chosen(field, o.id)}
                      onClick={() => pick(field, o.id)}
                    >
                      {/* The tick keeps its column whether or not it is drawn,
                          so every label sits on one left edge. */}
                      <span class="tl-model-tick" aria-hidden="true">
                        {chosen(field, o.id) ? "✓" : ""}
                      </span>
                      {labelFor(props.harness, field, o.id)}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          {/* Codex's picker writes ~/.codex/config.toml — it has no "this
              session only" key, where Claude's `s` does — so a change there
              also moves what the next codex session starts on. Said here
              rather than discovered later. */}
          <Show when={props.harness === "codex"}>
            <div class="tl-menu-note">Also becomes codex's default for new sessions.</div>
          </Show>
        </div>
      </Show>
    </span>
  );
};
