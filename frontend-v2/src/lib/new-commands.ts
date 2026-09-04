import type { NewCommand } from "../store/prefs";

/**
 * Which of the new-session commands this box can actually run.
 *
 * A key only starts something if the tool behind it is installed. Offering one
 * that is not hands back a session that closes the instant it opens, with
 * nothing on screen to explain it — the published container did exactly that
 * with Claude before Claude was in the image, and still does with Codex.
 *
 * tmux-api answers `GET /new-commands` with `{key: canRun}`, computed by
 * running tmux-user-attach --probe as the session's own user, inside the same
 * login+interactive shell a session gets. That shell is the only place the
 * answer is true: on the devvm `claude` is a shell function from a user's rc
 * file, which no PATH lookup outside it can see.
 */
export type CommandAvailability = Record<string, boolean>;

/** The commands the new-session row offers, in the order it shows them. Shared
 *  with App, which resolves the same list down to the one the terminal is told
 *  to run — the row and the attach must not disagree about that. `default` is
 *  storable but not offered: it means "whatever the box does by default". */
export const NEW_SESSION_COMMANDS: readonly NewCommand[] = ["claude", "codex", "shell"];

/** The dropdown labels, here rather than in one of the two pickers that show
 *  them, so the sidebar's row and the Settings page cannot disagree. */
export const COMMAND_LABELS: Record<NewCommand, string> = {
  claude: "Claude",
  codex: "Codex",
  shell: "Plain shell",
  default: "Default",
};

/**
 * The same commands as a PHRASE, for the new-session composer.
 *
 * Separate from COMMAND_LABELS on purpose. A settings row already sits under a
 * heading that says what it sets, so "Claude" is right there. The composer's
 * controls have no heading: they are a row of bare values, and "code" beside
 * "Claude" beside "Opus" says nothing about which is the project, which is the
 * command and which is the model. Reading the row as a sentence is what tells
 * you — "in code · run Claude · Opus model" — so the noun travels with the
 * value instead of being implied by a label that is not on screen.
 *
 * Lowercase verbs: these are fragments of one line, not headings.
 */
export const COMMAND_PHRASES: Record<NewCommand, string> = {
  claude: "run Claude",
  codex: "run Codex",
  // Already a noun phrase, and "run plain shell" reads worse than the thing
  // it describes.
  shell: "plain shell",
  default: "run the default",
};

/**
 * Can this key run?
 *
 * A key the server said nothing about is treated as runnable. Every failure on
 * the way here — the request, the probe, a shell that printed a banner instead
 * of an answer — arrives as an absent key, so all of them leave the dropdown
 * exactly as it was before it could grey anything out. The opposite default
 * would let one failed request take away a tool the box has.
 */
export function canRun(key: NewCommand, avail: CommandAvailability): boolean {
  return avail[key] !== false;
}

/**
 * The key that should actually run, given what the user picked.
 *
 * A stored preference outlives the tool it names: pick Claude in the container,
 * then run an image without it, and the pref still says claude. Rather than
 * start a session that dies, fall back to the first offered key that runs. The
 * stored pref is deliberately NOT rewritten — put Claude back on the box and
 * the choice the user made comes back with it.
 */
export function effectiveCommand(
  pref: NewCommand,
  avail: CommandAvailability,
  offered: readonly NewCommand[],
): NewCommand {
  if (offered.includes(pref) && canRun(pref, avail)) return pref;
  return offered.find((k) => canRun(k, avail)) ?? pref;
}
