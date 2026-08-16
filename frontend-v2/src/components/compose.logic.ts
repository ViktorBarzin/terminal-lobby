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
 * The permission modes Shift+Tab cycles, in the CLI's order. `bypassPermissions`
 * is deliberately NOT in the cycle: it is a deliberate choice made once at
 * startup, not something to land on by pressing a key one time too many.
 */
export const PERMISSION_MODES: ReadonlyArray<string> = [
  "default",
  "acceptEdits",
  "plan",
];

export function nextMode(current: string): string {
  const i = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length] ?? "default";
}
