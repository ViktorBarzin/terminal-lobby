/**
 * Which model a new Claude session starts on.
 *
 * The model is NOT a launch flag. `start-claude.sh` deliberately passes no
 * `--model`, so a session inherits the org default from managed-settings.json,
 * and `tmux-user-attach` pools pre-warmed sessions under the bare `claude`
 * command key — a per-model command key would miss the pool and give up the
 * ~2.4s head start on every model but the default. So the choice is applied by
 * sending `/model <name>` down the session's own prompt channel before the
 * first prompt, which needs no new command key and no change to the `?arg=`
 * attach contract.
 *
 * `default` is the absence of a choice: nothing is sent and the box's own
 * default stands. It is the value every account starts on.
 */
export type NewModel = "default" | "opus" | "sonnet" | "haiku";

/** The models the composer offers, in the order it shows them. */
export const NEW_SESSION_MODELS: readonly NewModel[] = ["default", "opus", "sonnet", "haiku"];

/** Dropdown labels, here rather than in the picker, so nothing can disagree. */
export const MODEL_LABELS: Record<NewModel, string> = {
  default: "Default model",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export function isNewModel(v: unknown): v is NewModel {
  return typeof v === "string" && (NEW_SESSION_MODELS as readonly string[]).includes(v);
}

/**
 * The line that applies a model choice, or null when there is nothing to apply.
 *
 * Sent as its own prompt ahead of the real one. Only Claude takes it: codex and
 * a plain shell would receive it as literal text, so the caller gates on the
 * command it is starting.
 */
export function modelCommandFor(model: NewModel): string | null {
  return model === "default" ? null : "/model " + model;
}
