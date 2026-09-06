import type { SessionTool } from "../types/lobby";

/**
 * Which model a session runs on, and how hard it thinks.
 *
 * EVERY ID HERE IS AN EXACT SLUG, not a family word. `opus` and `sonnet` are
 * what Claude Code's stock picker offers, and they cannot name the thing a
 * person is choosing between: `claude-opus-5` and `claude-opus-5[1m]` are both
 * "opus", and so is `claude-opus-4-8`. Codex has always spelled its own rows
 * this way, so this is the two lists agreeing rather than a new convention.
 *
 * A choice reaches a session by one of two routes, depending on when it is
 * made.
 *
 * STARTING a session: as `--model` and `--effort` FLAGS on the process, carried
 * to the attach as arg6/arg7 (lib/terminal-url.ts) and turned into flags by
 * devvm/tmux-user-attach. Measured on this box 2026-09-06, launching with them
 * costs what launching without costs, while driving the picker afterwards costs
 * about four seconds and puts a `/model` line in a conversation that has not
 * started.
 *
 * CHANGING a live session: `POST /model/{session}`, which drives the CLI's own
 * picker (sessionio/setmodel.go) and matches a row by its LABEL. That is why
 * the ids here have to be the labels Claude's picker draws, and why the box
 * declares them: `modelPicker.options` in /etc/claude-code/managed-settings.json
 * (source: infra scripts/workstation/managed-settings.json) replaces the four
 * built-in family rows with one row per slug. Verified 2026-09-06 that the
 * setting is honoured from MANAGED settings only — the same block in a user or
 * project settings.json is dropped.
 *
 * A row can be offered and still not be yours to run: `claude-fable-5` is in
 * the list and, on this account today, boots as Sonnet 5 with a warning that
 * the model is restricted. Keeping the row is deliberate, so the day the
 * entitlement lands there is nothing to change.
 *
 * `default` is the absence of a choice: no flag, nothing driven, and the
 * session keeps whatever it booted with. It is the value every account starts
 * on.
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
 *
 * The Claude rows are the slugs measured against `claude --model <slug>` on
 * 2026-09-06 (Claude Code 2.1.263), and they must stay in step with the
 * `modelPicker.options` block in managed settings, which is what makes them
 * rows in the CLI's own picker.
 *
 * Two slugs the CLI knows are deliberately absent. `claude-sonnet-5[1m]` is
 * accepted and then ignored — the session boots as plain "Sonnet 5", with no
 * 1M marker, because only Opus carries the suffix — so a row for it would
 * promise something the session does not do. `claude-fable-5-1` is not in this
 * build's catalogue at all.
 */
const CATALOGUE: Record<ModelHarness, Record<ModelField, readonly ModelOption[]>> = {
  claude: {
    model: [
      anyDefault("model"),
      opt("claude-opus-5", "claude-opus-5", "model"),
      opt("claude-opus-5[1m]", "claude-opus-5[1m]", "model"),
      opt("claude-sonnet-5", "claude-sonnet-5", "model"),
      opt("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "model"),
      opt("claude-opus-4-8", "claude-opus-4-8", "model"),
      opt("claude-fable-5", "claude-fable-5", "model"),
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
      opt("gpt-5.6-sol", "gpt-5.6-sol", "model"),
      opt("gpt-5.6-terra", "gpt-5.6-terra", "model"),
      opt("gpt-5.6-luna", "gpt-5.6-luna", "model"),
      opt("gpt-5.5", "gpt-5.5", "model"),
      opt("gpt-5.4-mini", "gpt-5.4-mini", "model"),
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
 * A stored model id, carried forward to the row it means today.
 *
 * The Claude rows were family words until 2026-09-06, so a preference written
 * before that says `opus`. Dropping it would quietly reset the choice of
 * everyone who had made one; resolving it to the family's canonical row keeps
 * what they picked. Anything the catalogue still does not recognise comes back
 * undefined, which the caller reads as no choice (store/prefs.ts).
 */
export function adoptModelId(h: ModelHarness, id: unknown): string | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  if (has(h, "model", id)) return id;
  if (h === "codex") return undefined;
  return canonicalFor(h, modelFamily(h, id));
}

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
 * A model name reduced to its FAMILY, for matching a catalogue row against
 * whatever spelling the session used.
 *
 * The transcript and this catalogue both write the slug (`claude-opus-5`,
 * `claude-haiku-4-5-20251001`), so they need no reduction to agree. The one
 * source that still writes a family is the CLI's own receipt, which spells the
 * model for a person ("Sonnet 5", normalised server-side to `sonnet`) — and on
 * a box carrying the managed `modelPicker` rows even that receipt says the
 * slug, because the picker's label is the display name the CLI reaches for.
 *
 * It is NOT what the chip shows. Displaying the family threw away the version,
 * which is half of what "which model is this" means.
 */
export function modelFamily(h: ModelHarness, model: string): string {
  if (!model) return "";
  if (h === "codex") return model;
  // claude-opus-5 → opus, claude-haiku-4-5-20251001 → haiku, opus → opus.
  const m = /^claude-([a-z]+)/.exec(model);
  return m ? m[1]! : model;
}

/**
 * The row a bare family word stands for.
 *
 * Nothing in the catalogue is spelled `opus` any more, but a session can still
 * report that: between a `/model` change and the session's next turn the only
 * source is the CLI's own receipt, and on a box whose managed settings have not
 * caught up that receipt still reads "Opus 5" and normalises to `opus`
 * server-side (sessionio/model.go). The first row of the family is what such a
 * word means — the plain slug, never the `[1m]` variant or last generation.
 */
function canonicalFor(h: ModelHarness, family: string): string | undefined {
  return CATALOGUE[h].model.find(
    (o) => o.id !== DEFAULT_CHOICE && modelFamily(h, o.id) === family,
  )?.id;
}

/**
 * Whether a catalogue id names what the session reports being on.
 *
 * Both sides are slugs now, so the answer is usually the string comparison:
 * the transcript writes `claude-opus-5`, the row says `claude-opus-5`, and
 * codex's footer and its rows have always agreed this way.
 *
 * The family fallback is for the one window where they cannot agree — a
 * receipt-derived `opus` with no version on it. It ticks the family's
 * canonical row and nothing else, so `claude-opus-5` and `claude-opus-5[1m]`
 * are never both marked current.
 */
export function isCurrentModel(
  h: ModelHarness,
  id: string,
  reported: string | undefined,
): boolean {
  if (!reported) return false;
  if (reported.toLowerCase() === id.toLowerCase()) return true;
  if (h === "codex") return false;
  // A word with no version in it is a family, not a model.
  if (/\d/.test(reported)) return false;
  return canonicalFor(h, modelFamily(h, reported)) === id;
}

/**
 * What the chip says: the model and the effort, or whichever half is known.
 *
 * The model is reported VERBATIM. `claude-opus-5` and
 * `claude-haiku-4-5-20251001` are different answers to which model this is, and
 * a chip that said "opus" and "haiku" could not tell two builds of one family
 * apart. A slug outruns the chip on a phone, so the stylesheet ellipsises it
 * and the title carries the whole thing.
 *
 * Between a change and the session's next turn the only source is the CLI's own
 * receipt, which names the family. That is what the session has said, so that
 * is what shows; the slug arrives with the next turn.
 */
export function summarise(state: ModelState | undefined): string {
  if (!state) return "";
  return [state.model ?? "", state.effort ?? ""].filter((s) => s !== "").join(" · ");
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
