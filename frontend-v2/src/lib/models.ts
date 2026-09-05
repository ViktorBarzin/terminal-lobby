import type { SessionTool } from "../types/lobby";

/**
 * Which model a session runs on, and how hard it thinks.
 *
 * NEITHER IS A LAUNCH FLAG. `start-claude.sh` deliberately passes no `--model`,
 * and `tmux-user-attach` pools pre-warmed sessions under the bare `claude`
 * command key — a per-model key would miss the pool and give up the ~2.4s head
 * start on every model but the default. The attach contract carries a command
 * KEY, not a command line, so there is nowhere to put a flag even if the pool
 * did not exist.
 *
 * So a choice is applied to a session that is already running, by driving the
 * CLI's own picker: `POST /model/{session}`, whose whole implementation is
 * sessionio/setmodel.go. That route replaced the `/model <name>` line this file
 * used to build, for two reasons measured on 2026-09-05. The line saves the
 * choice as the ACCOUNT default — "saved as your default for new sessions" —
 * so a model picked for one thread followed every session started afterwards;
 * and codex has no such line at all, it sends `/model gpt-5.6-sol` to the model
 * as a message.
 *
 * `default` is the absence of a choice: nothing is sent and the session keeps
 * whatever it booted with. It is the value every account starts on.
 */

/** A tool that has a model to pick. A plain shell does not. */
export type ModelHarness = "claude" | "codex";

/** The two things a harness lets you choose. */
export type ModelField = "model" | "effort";

/** The id stored and sent for "leave it alone". */
export const DEFAULT_CHOICE = "default";

/** One option: what goes on the wire, and the two ways it is written. */
export interface ModelOption {
  /** what the CLI's own picker calls it, which is what the driver matches on. */
  readonly id: string;
  /** for a settings row, which already sits under a heading saying what it sets. */
  readonly label: string;
  /**
   * for the composer's bare row of values, which has no heading. "code" beside
   * "Claude" beside "Opus" says nothing about which is the project, which is
   * the command and which is the model; reading the row as a sentence is what
   * tells you — "in code · run Claude · Opus model · max effort".
   */
  readonly phrase: string;
}

const opt = (id: string, label: string, noun: string): ModelOption => ({
  id,
  label,
  phrase: `${label} ${noun}`,
});

/** The choice that means "no choice", worded for both places it appears. */
const anyDefault = (noun: string): ModelOption => ({
  id: DEFAULT_CHOICE,
  label: `Default ${noun}`,
  phrase: `default ${noun}`,
});

/**
 * What each CLI offers, in the order its own picker lists them.
 *
 * Written down rather than fetched. Both lists come from the account — codex
 * loads its models from the server after the TUI is up — so a list here can go
 * stale, and the failure it produces is the honest one: the driver walks the
 * real picker, does not find the row, and reports what the session DOES list
 * (sessionio/setmodel.go). The alternative, picking whatever row is nearest,
 * would put a session on a model nobody chose.
 */
const CATALOGUE: Record<ModelHarness, Record<ModelField, readonly ModelOption[]>> = {
  claude: {
    model: [
      anyDefault("model"),
      opt("opus", "Opus", "model"),
      opt("sonnet", "Sonnet", "model"),
      opt("haiku", "Haiku", "model"),
    ],
    effort: [
      anyDefault("effort"),
      opt("low", "Low", "effort"),
      opt("medium", "Medium", "effort"),
      opt("high", "High", "effort"),
      opt("xhigh", "Extra high", "effort"),
      opt("max", "Max", "effort"),
      opt("ultracode", "Ultracode", "effort"),
    ],
  },
  codex: {
    model: [
      anyDefault("model"),
      opt("gpt-5.6-sol", "GPT-5.6 sol", "model"),
      opt("gpt-5.6-terra", "GPT-5.6 terra", "model"),
      opt("gpt-5.6-luna", "GPT-5.6 luna", "model"),
      opt("gpt-5.5", "GPT-5.5", "model"),
      opt("gpt-5.4-mini", "GPT-5.4 mini", "model"),
    ],
    effort: [
      anyDefault("effort"),
      opt("low", "Low", "effort"),
      opt("medium", "Medium", "effort"),
      opt("high", "High", "effort"),
      opt("xhigh", "Extra high", "effort"),
      opt("max", "Max", "effort"),
      opt("ultra", "Ultra", "effort"),
    ],
  },
};

export const modelsFor = (h: ModelHarness): readonly ModelOption[] => CATALOGUE[h].model;
export const effortsFor = (h: ModelHarness): readonly ModelOption[] => CATALOGUE[h].effort;
export const optionsFor = (h: ModelHarness, f: ModelField): readonly ModelOption[] =>
  CATALOGUE[h][f];

const has = (h: ModelHarness, f: ModelField, id: unknown): boolean =>
  typeof id === "string" && CATALOGUE[h][f].some((o) => o.id === id);

export const isModelFor = (h: ModelHarness, id: unknown): boolean => has(h, "model", id);
export const isEffortFor = (h: ModelHarness, id: unknown): boolean => has(h, "effort", id);

/**
 * The label for a value, or the value itself when the catalogue has not heard
 * of it — a session put on a model from the CLI shows what it is on rather
 * than a blank.
 */
export function labelFor(h: ModelHarness, f: ModelField, id: string): string {
  return CATALOGUE[h][f].find((o) => o.id === id)?.label ?? id;
}

export function phraseFor(h: ModelHarness, f: ModelField, id: string): string {
  return CATALOGUE[h][f].find((o) => o.id === id)?.phrase ?? id;
}

/** Which harness a session's tool is, or null for one with no model to pick. */
export function modelHarness(tool: SessionTool | undefined): ModelHarness | null {
  return tool === "claude" || tool === "codex" ? tool : null;
}

/** What a session says it is running as. Either half may be missing. */
export interface ModelState {
  model?: string;
  effort?: string;
}

/**
 * The wire name of a model, shortened to the one a person uses.
 *
 * The transcript names Claude's models in full — `claude-opus-5`,
 * `claude-haiku-4-5` — and codex names its own with a `gpt-` prefix every one
 * of them shares. A chip sits beside the permission mode on a 390px screen, so
 * neither spelling fits and neither is what anybody calls them.
 */
export function shortModel(h: ModelHarness, model: string): string {
  if (!model) return "";
  if (h === "codex") return model.replace(/^gpt-/, "");
  // claude-opus-5 → opus, claude-haiku-4-5 → haiku, opus → opus.
  const m = /^claude-([a-z]+)/.exec(model);
  return m ? m[1]! : model;
}

/**
 * Whether a catalogue id names what the session reports being on.
 *
 * The two sides are spelled differently for Claude and identically for codex:
 * the transcript writes `claude-opus-5` where the picker's row — and so this
 * catalogue — says `opus`, while codex's footer and its rows both say
 * `gpt-5.6-terra`.
 */
export function isCurrentModel(
  h: ModelHarness,
  id: string,
  reported: string | undefined,
): boolean {
  if (!reported) return false;
  return h === "codex" ? reported === id : shortModel("claude", reported) === id;
}

/** What the chip says: the model and the effort, or whichever half is known. */
export function summarise(h: ModelHarness, state: ModelState | undefined): string {
  if (!state) return "";
  return [shortModel(h, state.model ?? ""), state.effort ?? ""]
    .filter((s) => s !== "")
    .join(" · ");
}

/**
 * The body of a `POST /model/{session}`, or null when there is nothing to
 * apply. `default` on both sides means the session keeps what it booted with,
 * which is a real instruction and not a request to send.
 */
export function modelRequest(
  h: ModelHarness,
  choice: { model: string; effort: string },
): { tool: ModelHarness; model: string; effort: string } | null {
  const model = choice.model === DEFAULT_CHOICE ? "" : choice.model;
  const effort = choice.effort === DEFAULT_CHOICE ? "" : choice.effort;
  if (!model && !effort) return null;
  return { tool: h, model, effort };
}
