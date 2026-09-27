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
 * EVERY ROW HERE IS ONE THIS ACCOUNT CAN ACTUALLY RUN, which is a rule and not
 * an accident (Viktor, 2026-09-06: "we must only show models we can use").
 * `claude-fable-5` was in this list for a few hours and is not entitled: asking
 * for it starts a Sonnet 5 session and prints a warning, so the row promised
 * one model and delivered another. A row nobody can use is worse than a
 * missing one.
 *
 * How to check before adding a row: `~/.claude.json` carries a
 * `modelAccessCache` array of `{apiName, entitled}` for the account, which is
 * the account's own answer. Then start a session on the slug and read the
 * banner — a fallback names the OTHER model there and adds a ⚠ line. Do not
 * probe with `claude -p`: the warning is invisible in print mode and the run
 * answers normally, so an unentitled model looks like a working one. Codex is
 * blunter and needs no banner reading — an unsupported model there is a 400.
 *
 * `default` is the absence of a choice: no flag, nothing driven, and the
 * session keeps whatever it booted with. It is the value every account starts
 * on.
 *
 * PI IS THE EXCEPTION TO "WRITTEN DOWN". Pi prints what a user can run before
 * any session exists (`pi --list-models`), and it is the harness where people
 * on the box sign into different providers, so one list here would be wrong
 * for somebody from the start. Its models come from GET /pi-models, per OS
 * user (ADR-0032, lib/pi-models.ts), and are checked by the shape of a
 * reference rather than against a catalogue. Its seven thinking levels are
 * pi's own and the same for everyone, so those are written down.
 */

/** A tool that has a model to pick. A plain shell does not. */
export type ModelHarness = "claude" | "codex" | "pi";

/** The two things a harness lets you choose. */
export type ModelField = "model" | "effort";

/** The id stored and sent for "leave it alone". */
export const DEFAULT_CHOICE = "default";

/** One option: what goes on the wire, and how a settings row writes it. */
export interface ModelOption {
  /** what the CLI's own picker calls it, which is what the driver matches on. */
  readonly id: string;
  /** for a settings row, which already sits under a heading saying what it sets. */
  readonly label: string;
}

const opt = (id: string, label: string): ModelOption => ({ id, label });

/** A model row: the slug, said once. */
const slug = (id: string): ModelOption => ({ id, label: id });

/** The choice that means "no choice". */
const anyDefault = (noun: string): ModelOption => ({
  id: DEFAULT_CHOICE,
  label: `Default ${noun}`,
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
 * rows in the CLI's own picker. The codex rows are what its own picker listed
 * on codex-cli 0.153.4 the same day, each one run through `codex exec -m`.
 *
 * `gpt-6-astra` is a reminder that a stale CLI is indistinguishable from a
 * model that does not exist. It is codex's DEFAULT on 0.153.4 and was absent
 * from 0.144.3, which this box ran for eight weeks — so the model was missing
 * from the picker, from the binary and from every probe, and looked like it had
 * never shipped. The devvm now tracks latest and refreshes daily
 * (infra playbooks/devvm.yml, codex-update.timer).
 *
 * `claude-opus-5-5` leads the list because the box leads with it: the managed
 * `model` key became `claude-opus-5-5` on 2026-09-22, the day Opus 5.5 became
 * entitled to this account. Being first also makes it what a bare `opus`
 * receipt resolves to (canonicalFor below), which is the same answer the box
 * would give. Checked the way this comment asks: a real pane on the slug
 * answered with no fallback warning, and its transcript recorded
 * `claude-opus-5-5` at `speed: fast`.
 *
 * Three slugs the CLI knows are deliberately absent. `claude-sonnet-5[1m]` is
 * accepted and then ignored — the session boots as plain "Sonnet 5", with no
 * 1M marker, because only Opus carries the suffix — so a row for it would
 * promise something the session does not do. `claude-fable-5` is in the
 * catalogue and not entitled to this account. `claude-fable-5-1` is not in this
 * build's catalogue at all.
 */
const CATALOGUE: Record<ModelHarness, Record<ModelField, readonly ModelOption[]>> = {
  claude: {
    model: [
      anyDefault("model"),
      slug("claude-opus-5-5"),
      slug("claude-opus-5"),
      slug("claude-opus-5[1m]"),
      slug("claude-sonnet-5"),
      slug("claude-haiku-4-5-20251001"),
      slug("claude-opus-4-8"),
    ],
    effort: [
      anyDefault("effort"),
      opt("low", "Low"),
      opt("medium", "Medium"),
      opt("high", "High"),
      opt("xhigh", "Extra high"),
      opt("max", "Max"),
      opt("ultracode", "Ultracode"),
    ],
  },
  codex: {
    model: [
      anyDefault("model"),
      slug("gpt-6-astra"),
      slug("gpt-5.6-sol"),
      slug("gpt-5.6-terra"),
      slug("gpt-5.6-luna"),
      slug("gpt-5.5"),
      slug("gpt-5.4-mini"),
    ],
    effort: [
      anyDefault("effort"),
      opt("low", "Low"),
      opt("medium", "Medium"),
      opt("high", "High"),
      opt("xhigh", "Extra high"),
      opt("max", "Max"),
      opt("ultra", "Ultra"),
    ],
  },
  // No model rows: pi lists its own, per user (see the header), and
  // `optionsFor` puts them after this one. The levels are pi's seven, in the
  // order `/thinking` lists them, under pi's own word for the setting.
  // Which of them a given model supports is what a running session stamps
  // (`piLevels`); the composer offers all seven and pi clamps an unsupported
  // one at start (ADR-0032).
  pi: {
    model: [anyDefault("model")],
    effort: [
      anyDefault("thinking"),
      opt("off", "Off"),
      opt("minimal", "Minimal"),
      opt("low", "Low"),
      opt("medium", "Medium"),
      opt("high", "High"),
      opt("xhigh", "Extra high"),
      opt("max", "Max"),
    ],
  },
};

/**
 * What a pi model reference may look like: `provider/id`, as pi prints it.
 *
 * The same pattern the attach scripts check the launch argument against
 * (devvm/tmux-attach.sh, devvm/tmux-user-attach), so a reference this accepts
 * is one the attach passes on, and one it refuses never reaches a shell. Up to
 * 96 characters, starting with a letter or digit, so nothing here can be read
 * as a flag.
 */
const PI_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,95}$/;

export function isPiModelRef(v: unknown): v is string {
  return typeof v === "string" && PI_MODEL_REF.test(v);
}

/**
 * What pi offers right now, which nothing in this file writes down: the models
 * pi lists for this user (GET /pi-models), and the thinking levels a running
 * session's model supports (its `piLevels` stamp). Either may be missing,
 * which means "not known yet", never "none".
 */
export interface PiOffer {
  models?: readonly string[];
  levels?: readonly string[];
}

/** The levels a pi session stamped, off the comma-separated option. */
export function piLevels(stamp: string | undefined): string[] {
  return (stamp ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The default row, then each model pi listed, once, and only real references. */
function piModelOptions(refs: readonly string[] | undefined): readonly ModelOption[] {
  const rows: ModelOption[] = [...CATALOGUE.pi.model];
  const seen = new Set<string>([DEFAULT_CHOICE]);
  for (const ref of refs ?? []) {
    if (!isPiModelRef(ref) || seen.has(ref)) continue;
    seen.add(ref);
    rows.push(slug(ref));
  }
  return rows;
}

/**
 * Pi's levels, narrowed to the ones the session's model supports. Nothing
 * stamped, or nothing this build recognises, leaves all seven: a picker with
 * no rows helps nobody, and pi clamps a level its model cannot use.
 */
function piEffortOptions(levels: readonly string[] | undefined): readonly ModelOption[] {
  const all = CATALOGUE.pi.effort;
  if (!levels || levels.length === 0) return all;
  const known = all.filter((o) => o.id === DEFAULT_CHOICE || levels.includes(o.id));
  return known.length > 1 ? known : all;
}

export const modelsFor = (h: ModelHarness): readonly ModelOption[] => CATALOGUE[h].model;
export const effortsFor = (h: ModelHarness): readonly ModelOption[] => CATALOGUE[h].effort;

/**
 * What a picker offers for one field. Claude's and codex's rows are the
 * written-down lists; pi's come from `pi`, which only pi's callers have.
 */
export function optionsFor(h: ModelHarness, f: ModelField, pi?: PiOffer): readonly ModelOption[] {
  switch (h) {
    case "claude":
    case "codex":
      return CATALOGUE[h][f];
    case "pi":
      return f === "model" ? piModelOptions(pi?.models) : piEffortOptions(pi?.levels);
  }
}

/**
 * The effort rungs each Claude model offers, by exact slug.
 *
 * Read from the Claude Code 2.1.283 binary's built-in model catalogue on
 * 2026-09-27 (memory #14201). Each entry carries capabilities: `effort` says
 * the model has the setting at all, and `xhigh_effort` and `max_effort` gate
 * those two rungs; the CLI's own model list filters its levels the same way.
 * Every row here but Haiku has all five, Sonnet 5 included. Haiku 4.5 has no
 * effort capability, so it has one level and no rungs to pick.
 *
 * `ultracode` is left out on purpose. It is xhigh plus dynamic workflows
 * rather than a rung of thinking, and the model sheet's row is "how hard it
 * thinks". It stays in the catalogue above, where the new-session picker
 * offers it, and the sheet still shows it on a session already running on it.
 */
const FIVE_RUNGS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  "claude-opus-5-5": FIVE_RUNGS,
  "claude-opus-5": FIVE_RUNGS,
  "claude-opus-5[1m]": FIVE_RUNGS,
  "claude-sonnet-5": FIVE_RUNGS,
  "claude-haiku-4-5-20251001": [],
  "claude-opus-4-8": FIVE_RUNGS,
};

/**
 * The effort levels a live session's model offers, without `default` (which
 * only a session not yet started can mean).
 *
 * Claude's come from the table above, keyed by slug, with a bare family word
 * read as its family's first row the way `isCurrentModel` reads it. A slug the
 * table does not know, or no model reported yet, gets the harness's whole list:
 * the CLI refuses a level its model lacks, and an empty picker helps nobody.
 * Codex keeps its catalogue, since nothing here knows its levels per model.
 * Pi keeps the levels the session stamped (`optionsFor`).
 */
export function effortsForModel(
  h: ModelHarness,
  model: string | undefined,
  pi?: PiOffer,
): readonly ModelOption[] {
  const all = optionsFor(h, "effort", pi).filter((o) => o.id !== DEFAULT_CHOICE);
  if (h !== "claude" || !model) return all;
  const slugged = has(h, "model", model) ? model : canonicalFor(h, modelFamily(h, model));
  const rungs = slugged ? CLAUDE_EFFORTS[slugged] : undefined;
  return rungs ? all.filter((o) => rungs.includes(o.id)) : all;
}

/**
 * The levels a NEW session can start on, for the new-session model sheet.
 *
 * `default` leads, because "whatever the CLI starts on" is a real answer for a
 * session that does not exist yet. Then the model's own levels
 * (`effortsForModel`; a `default` model is read as no model yet, which gets
 * the whole list). Claude's ultracode joins every model with xhigh: it is
 * xhigh plus dynamic workflows, chosen by the launch flag and lasting one
 * session (`isOneSessionEffort`). A model with one level (Haiku 4.5) gets no
 * rows at all, so the sheet says so instead of offering a control.
 */
export function startEfforts(h: ModelHarness, model: string, pi?: PiOffer): readonly ModelOption[] {
  const rows = effortsForModel(h, model === DEFAULT_CHOICE ? undefined : model, pi);
  if (rows.length === 0) return [];
  const ultra = CATALOGUE.claude.effort.find((o) => o.id === "ultracode");
  const withUltra =
    h === "claude" && ultra && rows.some((o) => o.id === "xhigh") && !rows.includes(ultra)
      ? [...rows, ultra]
      : rows;
  const dflt = optionsFor(h, "effort", pi).find((o) => o.id === DEFAULT_CHOICE);
  return dflt ? [dflt, ...withUltra] : withUltra;
}

/**
 * Whether a stored id is one this harness could be sent. A pi model is judged
 * by its shape, because the list it came from is pi's and not this file's:
 * judged against the catalogue, every pi pick would be dropped on load.
 */
function has(h: ModelHarness, f: ModelField, id: unknown): boolean {
  if (typeof id !== "string") return false;
  if (h === "pi" && f === "model") return isPiModelRef(id);
  return CATALOGUE[h][f].some((o) => o.id === id);
}

export const isModelFor = (h: ModelHarness, id: unknown): boolean => has(h, "model", id);

export const isEffortFor = (h: ModelHarness, id: unknown): boolean => has(h, "effort", id);

/**
 * Efforts that last ONE new session, per harness.
 *
 * The new-session pick roams and sticks (store/prefs.ts), so any row there can
 * quietly become every later session's default. Viktor's rule is Claude at
 * high by default and nobody on max by default (2026-09-25), with max still
 * offered in the picker (2026-09-26). So these launch the session they were
 * picked for and then go back to default (resetOneSessionEffort), and a saved
 * one reads as no choice (coercePrefs). Pi's thinking levels include max, so
 * the rule covers it too.
 */
const ONE_SESSION_EFFORTS: Record<ModelHarness, ReadonlySet<string>> = {
  claude: new Set(["max", "ultracode"]),
  codex: new Set(),
  pi: new Set(["max"]),
};

export const isOneSessionEffort = (h: ModelHarness, id: unknown): boolean =>
  typeof id === "string" && ONE_SESSION_EFFORTS[h].has(id);

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
  switch (h) {
    case "claude":
      return canonicalFor(h, modelFamily(h, id));
    // Neither has family words to carry forward: codex has always spelled its
    // rows as slugs, and a pi reference the pattern refuses is one no attach
    // would pass on.
    case "codex":
    case "pi":
      return undefined;
  }
}

/**
 * The label for a value, or the value itself when the catalogue has not heard
 * of it — a session put on a model from the CLI shows what it is on rather
 * than a blank.
 */
export function labelFor(h: ModelHarness, f: ModelField, id: string): string {
  return CATALOGUE[h][f].find((o) => o.id === id)?.label ?? id;
}

/**
 * Which harness a session's tool is, or null for one with no model to pick.
 * A tool this build has never heard of gets no picker rather than borrowing
 * one: a newer server can report a tool before the frontend knows it.
 */
export function modelHarness(tool: SessionTool | undefined): ModelHarness | null {
  switch (tool) {
    case "claude":
    case "codex":
    case "pi":
      return tool;
    case "shell":
    case undefined:
      return null;
    default: {
      const unknown: never = tool;
      void unknown;
      return null;
    }
  }
}

/** What a harness calls a field, for a heading over its rows. */
export function fieldHeading(h: ModelHarness, f: ModelField): string {
  if (f === "model") return "Model";
  switch (h) {
    case "claude":
    case "codex":
      return "Effort";
    // Pi's own word, and the one its `/thinking` command uses.
    case "pi":
      return "Thinking";
  }
}

/** What the chip is called, in the harness's own words. */
export function chipName(h: ModelHarness): string {
  return `${fieldHeading(h, "model")} and ${fieldHeading(h, "effort").toLowerCase()}`;
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
 * It is NOT what the model dial shows. Displaying the family threw away the
 * version, which is half of what "which model is this" means (`modelName`).
 */
export function modelFamily(h: ModelHarness, model: string): string {
  if (!model) return "";
  switch (h) {
    case "claude": {
      // claude-opus-5 → opus, claude-haiku-4-5-20251001 → haiku, opus → opus.
      const m = /^claude-([a-z]+)/.exec(model);
      return m ? m[1]! : model;
    }
    // Both only ever spell the whole reference, so the reference is the family.
    case "codex":
    case "pi":
      return model;
  }
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
  return CATALOGUE[h].model.find((o) => o.id !== DEFAULT_CHOICE && modelFamily(h, o.id) === family)
    ?.id;
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
export function isCurrentModel(h: ModelHarness, id: string, reported: string | undefined): boolean {
  if (!reported) return false;
  if (reported.toLowerCase() === id.toLowerCase()) return true;
  switch (h) {
    case "claude":
      // A word with no version in it is a family, not a model.
      if (/\d/.test(reported)) return false;
      return canonicalFor(h, modelFamily(h, reported)) === id;
    // Codex's footer and pi's stamp both name the whole reference, so there is
    // no receipt-shaped window to cover.
    case "codex":
    case "pi":
      return false;
  }
}

/**
 * The model and the effort as one exact string, or whichever half is known.
 *
 * The model is reported VERBATIM. `claude-opus-5` and
 * `claude-haiku-4-5-20251001` are different answers to which model this is, and
 * a label that said "opus" and "haiku" could not tell two builds of one family
 * apart. This is what the model dial's title carries; the dial itself shows
 * `modelName` below, which keeps the version and drops the rest of the slug.
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
 * What the model dial calls a model: `claude-opus-5-5` is "Opus 5.5".
 *
 * The chip before the dial showed the slug and nothing else, which on a 390px
 * phone ran under Send and read "claude-opus-5-5 · ı" (measured on 0.71.2,
 * memory #13886). The Quiet line composer (2026-09-24) shows a name and moves
 * the slug into the picker and the dial's title. The rule `summarise` states
 * still holds, because the version stays in the name: Opus 5 and Opus 5.5 are
 * two answers, as are Opus 5 and Opus 5 · 1M.
 *
 * A date in the slug is part of the build and not the name, so Haiku's
 * `-20251001` goes to the title with the rest. A bare family word, which is
 * what the CLI's receipt normalises to before the next turn names the slug,
 * reads as the family. Codex already names its models this way, so its slugs
 * pass through, and so does anything this does not recognise.
 */
export function modelName(h: ModelHarness, model: string): string {
  if (h !== "claude" || !model) return model;
  if (/^(opus|sonnet|haiku)$/i.test(model)) return capitalise(model.toLowerCase());
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (!m) return model;
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2]!;
  return `${capitalise(m[1]!.toLowerCase())} ${version}${m[4] ? " · 1M" : ""}`;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
