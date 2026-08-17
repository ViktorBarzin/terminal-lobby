/**
 * What `/` and `@` offer at the caret. Pure, so the matching rules are tested
 * without a DOM — the composer only has to render what this returns.
 *
 * Both triggers fire only at the START of a token (preceded by nothing or by
 * whitespace). Without that rule a path like `src/lib` opens the slash menu
 * mid-word and an email address opens the file picker.
 */

/** The slash commands Claude Code ships. A `/` typed in the composer reaches
 *  the CLI verbatim, so this list is an aid to typing, not a gate: anything not
 *  listed still sends. */
export const SLASH_COMMANDS: ReadonlyArray<string> = [
  "/add-dir",
  "/agents",
  "/clear",
  "/compact",
  "/config",
  "/context",
  "/cost",
  "/diff",
  "/doctor",
  "/exit",
  "/export",
  "/help",
  "/hooks",
  "/init",
  "/login",
  "/logout",
  "/mcp",
  "/memory",
  "/model",
  "/permissions",
  "/pr-comments",
  "/release-notes",
  "/resume",
  "/review",
  "/status",
  "/terminal-setup",
  "/vim",
];

export interface Completion {
  trigger: "/" | "@";
  /** Index in the text where the token being completed starts. */
  start: number;
  /** The token typed so far, including its trigger. */
  token: string;
  /** For `@`: the directory whose listing the items came from. */
  dir: string;
  items: string[];
}

/** The token the caret sits in, if it begins with a completion trigger. */
function tokenAt(text: string, caret: number): { start: number; token: string } | null {
  if (caret < 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const token = text.slice(start, caret);
  if (!token) return null;
  return { start, token };
}

/**
 * The completion offered at `caret`, or null.
 *
 * `paths` is the directory listing the composer fetched for the token's
 * directory; it is passed in rather than fetched here so this stays pure.
 */
export function completionFor(
  text: string,
  caret: number,
  paths: ReadonlyArray<string>,
): Completion | null {
  const at = tokenAt(text, caret);
  if (!at) return null;
  const { start, token } = at;

  if (token.startsWith("/")) {
    // Only at the very beginning of the message: a slash command is the whole
    // prompt, and `cd /usr` should not open a command menu.
    if (start !== 0) return null;
    const items = SLASH_COMMANDS.filter((c) => c.startsWith(token));
    return { trigger: "/", start, token, dir: "", items };
  }

  if (token.startsWith("@")) {
    const raw = token.slice(1);
    const cut = raw.lastIndexOf("/");
    const dir = cut < 0 ? "" : raw.slice(0, cut + 1);
    const stem = cut < 0 ? raw : raw.slice(cut + 1);
    const items = paths
      .filter((p) => p.startsWith(stem))
      .slice(0, 20)
      .map((p) => `@${dir}${p}`);
    return { trigger: "@", start, token, dir, items };
  }

  return null;
}

/**
 * The permission mode the session's pane is reporting, or "" if its status line
 * says nothing about one.
 *
 * This is the only LIVE source for the mode. The transcript's `permission-mode`
 * record is written when a turn happens, not when the mode changes: measured
 * 2026-08-17, Shift+Tab moved a session from bypass to auto in 40ms while its
 * transcript sat unwritten for the next twenty minutes, still saying bypass. So
 * a chip fed only by the transcript cannot show what pressing it just did.
 *
 * The status lines, captured from the CLI's own cycle in that session:
 *
 *   ⏵⏵ bypass permissions on (shift+tab to cycle)   bypassPermissions
 *   ⏵⏵ auto mode on (shift+tab to cycle)            auto
 *   ⏸ manual mode on                                manual
 *   ⏵⏵ accept edits on (shift+tab to cycle)         acceptEdits
 *   ⏸ plan mode on (shift+tab to cycle)             plan
 *
 * The identifiers are the CLI's own (`claude --help`: acceptEdits, auto,
 * bypassPermissions, manual, dontAsk, plan). `default` is the older name for
 * `manual` and still appears in transcripts written before the rename.
 *
 * Matched on the phrase alone — the ⏵⏵/⏸ glyph, the "(shift+tab to cycle)" tail
 * and the "· ← for agents" suffix all vary with the session and the build.
 */
const PANE_MODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/bypass permissions on/i, "bypassPermissions"],
  [/accept edits on/i, "acceptEdits"],
  [/auto mode on/i, "auto"],
  [/manual mode on/i, "manual"],
  [/plan mode on/i, "plan"],
  [/don'?t ask mode on/i, "dontAsk"],
];

export function modeFromPane(pane: string): string {
  // Last match wins: a pane holds scrollback, and the status line is the most
  // recent thing in it. Transcript text quoting an older status line would
  // otherwise outrank the live one.
  let found = "";
  let at = -1;
  for (const [re, mode] of PANE_MODES) {
    const i = pane.search(re);
    if (i > at) {
      at = i;
      found = mode;
    }
  }
  return found;
}

/**
 * The mode, short enough to sit in a chip beside the input. The full names run
 * to `bypassPermissions`, which on a 390px screen crowds out both the message
 * field and the Send button.
 *
 * The words are the CLI's own, so the chip and the status line under the
 * terminal agree.
 */
export function modeLabel(mode: string): string {
  switch (mode) {
    case "bypassPermissions":
      return "bypass";
    case "acceptEdits":
      return "edits";
    case "dontAsk":
      return "no ask";
    // `default` is what transcripts written before the rename call `manual`.
    case "manual":
    case "default":
      return "manual";
    default:
      return mode;
  }
}

/**
 * The message an attachment-carrying composer sends (design decision 9): each
 * path on its own line, then the prose.
 *
 * Paths FIRST so Claude has the files before the instruction that refers to
 * them, and one per line so a bubble reads as attachments-then-message.
 * Newlines are safe because session-events pastes the prompt in bracketed mode
 * and submits with a separate Enter (sessionio/tmux.go) — inside a bracketed
 * paste a newline is a soft newline, not a submit.
 *
 * Returns "" when there is nothing to send, which is what the caller checks
 * instead of testing the text alone: attachments with no prose is a valid send.
 */
export function composeMessage(text: string, paths: readonly string[]): string {
  const body = text.trim();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return body;
  return [...unique, ...(body ? [body] : [])].join("\n");
}
