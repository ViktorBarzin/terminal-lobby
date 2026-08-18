/**
 * What `/` and `@` offer at the caret. Pure, so the matching rules are tested
 * without a DOM — the composer only has to render what this returns.
 *
 * Both triggers fire only at the START of a token (preceded by nothing or by
 * whitespace). Without that rule a path like `src/lib` opens the slash menu
 * mid-word and an email address opens the file picker.
 */

/**
 * The slash commands Claude Code BUILDS IN, with the descriptions the CLI's own
 * menu shows for them.
 *
 * Captured from that menu on 2026-08-17 by scrolling it and reading the rows
 * back, then subtracting everything discoverable from the filesystem — what is
 * left is what every session has regardless of user. The previous hand-written
 * list had 27 entries: it was missing 72 of these and still offered four the
 * CLI has since dropped (/cost, /pr-comments, /review, /vim).
 *
 * A `/` typed in the composer reaches the CLI verbatim, so this is an aid to
 * typing rather than a gate — anything not listed still sends. It ships with
 * the page so the menu works even when the per-user catalogue cannot be
 * fetched.
 */
const BUILTIN: ReadonlyArray<readonly [string, string]> = [
  ["/add-dir", "Add a new working directory"],
  ["/advisor", "Let Claude consult a stronger model at key moments"],
  ["/agents", "(removed) Ask Claude to create/manage subagents, or edit"],
  ["/artifact-capabilities", "Runtime capabilities a published Artifact page can be granted — behavior static HTML cannot provide on its own, such as the page reading live or"],
  ["/artifact-design", "Design guidance and fundamentals for Artifacts."],
  ["/artifact-diagramming", "Diagramming know-how for Artifacts — when a picture earns its place, how to draw one that shows the real mechanism, and the inline-SVG mechanics that keep"],
  ["/artifacts", "Browse your published and shared artifacts"],
  ["/autocompact", "Set how full the context gets before auto-summarizing"],
  ["/autofix-pr", "Monitor and autofix any issues with the current PR"],
  ["/background", "Send this session to the background and free the"],
  ["/batch", "Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR."],
  ["/branch", "Create a branch of the current conversation at this"],
  ["/btw", "Ask a quick side question without interrupting the main"],
  ["/bug", "Report a bug or share your conversation"],
  ["/cd", "Move this session to a new working directory"],
  ["/chrome", "Open Claude in Chrome settings"],
  ["/claude-api", "Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration."],
  ["/clear", "Start a new session with empty context; previous session stays on disk (resumable with /resume)"],
  ["/color", "Set the prompt bar color for this session"],
  ["/compact", "Free up context by summarizing the conversation so far"],
  ["/config", "Open settings"],
  ["/context", "Visualize current context usage as a colored grid"],
  ["/copy", "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)"],
  ["/dataviz", "Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React"],
  ["/debug", "Enable debug logging for this session and help diagnose"],
  ["/deep-research", "[dynamic workflow] Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report."],
  ["/design", "Grant or revoke Claude agent access to your Design"],
  ["/design-login", "Authorize design-system access for /design-sync with your claude.ai"],
  ["/design-sync", "Push a React design system to claude.ai/design. This runs a converter that bundles the real component code (from Storybook or a bare package) and uploads it."],
  ["/diff", "View uncommitted changes and per-turn diffs"],
  ["/doctor", "Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local"],
  ["/effort", "Set effort level for model usage"],
  ["/exit", "Exit the CLI"],
  ["/export", "Export the current conversation to a file or clipboard"],
  ["/fast", "Toggle fast mode (Opus 5)"],
  ["/feedback", "Send feedback to Anthropic or report a bug"],
  ["/fewer-permission-prompts", "Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce"],
  ["/focus", "Toggle focus view: just your prompt, summary, and"],
  ["/fork", "Copy this conversation into a new background session and keep working"],
  ["/goal", "Set a goal Claude checks before stopping"],
  ["/help", "Show help and available commands"],
  ["/hooks", "View hook configurations for tool events"],
  ["/ide", "Manage IDE integrations and show status"],
  ["/import", "Import config from another AI coding agent"],
  ["/init", "Initialize a new CLAUDE.md file with codebase"],
  ["/insights", "Generate a report analyzing your Claude Code sessions"],
  ["/install-github-app", "Set up Claude GitHub Actions for a repository"],
  ["/install-slack-app", "Install the Claude Slack app"],
  ["/keybindings", "Open your keyboard shortcuts file"],
  ["/list-agents", "List subagents and other Claude sessions you can"],
  ["/login", "Sign in with your Anthropic account"],
  ["/logout", "Sign out from your Anthropic account"],
  ["/loop", "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace."],
  ["/mcp", "Manage MCP servers"],
  ["/memory", "Edit CLAUDE.md files and memory settings"],
  ["/mobile", "Show QR code to download the Claude mobile app"],
  ["/model", "Set the AI model for Claude Code (currently Opus 5)"],
  ["/permissions", "Manage allow and deny tool permission rules"],
  ["/plan", "Enable plan mode or view the current session plan"],
  ["/plugin", "Manage Claude Code plugins"],
  ["/powerup", "Discover Claude Code features through quick interactive"],
  ["/radio", "Listen to Claude FM lo-fi radio"],
  ["/recap", "Generate a one-line session recap now"],
  ["/release-notes", "View release notes"],
  ["/reload-plugins", "Activate pending plugin changes in the current session"],
  ["/reload-skills", "Pick up skills added or changed on disk during this"],
  ["/remote-control", "Control this session from your phone or claude.ai/code"],
  ["/remote-env", "Choose the default environment for cloud agents"],
  ["/rename", "Rename the current conversation"],
  ["/resume", "Resume a previous conversation"],
  ["/rewind", "Restore the code and/or conversation to a previous"],
  ["/run", "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real"],
  ["/run-skill-generator", "Author or improve the run-<unit> skill — a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks"],
  ["/sandbox", "◯ sandbox disabled (⏎ to configure)"],
  ["/schedule", "Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule."],
  ["/scroll-speed", "Adjust mouse wheel scroll speed"],
  ["/security-review", "Complete a security review of the pending changes on the current"],
  ["/simplify", "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs;"],
  ["/skills", "List available skills"],
  ["/status", "Show Claude Code status including version, model, account, API connectivity, and tool"],
  ["/statusline", "Set up Claude Code's status line UI"],
  ["/stickers", "Order Claude Code stickers"],
  ["/subtask", "Send a subagent off with your full context; its result comes back"],
  ["/tasks", "View and manage everything running in the background"],
  ["/team-onboarding", "Help teammates ramp on Claude Code with a guide from your"],
  ["/teleport", "Send this session to the cloud, or resume one from"],
  ["/terminal-setup", "Install Shift+Enter key binding for newlines"],
  ["/theme", "Change the theme"],
  ["/tui", "Set the terminal UI renderer (default | fullscreen)"],
  ["/update-config", "Use this skill to configure the Claude Code harness via settings.json. Automated behaviors (\"from now on when X\", \"each time X\", \"whenever X\","],
  ["/usage", "Show session cost, plan usage, and activity stats"],
  ["/usage-credits", "Configure usage credits or request them from your admin when you hit a"],
  ["/verify", "Verify that a code change actually does what it's supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests"],
  ["/voice", "Toggle voice mode"],
  ["/workflows", "Browse running and completed workflows"],
];

/** One offerable command: a built-in, a skill, a custom command, a plugin's. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** "builtin" | "skill" | "command" | "project" | "plugin". */
  source?: string;
}

export const BUILTIN_COMMANDS: ReadonlyArray<SlashCommand> = BUILTIN.map(
  ([name, description]) => ({ name, description, source: "builtin" }),
);

/**
 * The built-ins plus what this session actually has, one entry per name.
 *
 * Discovered entries win: a project or personal command that shadows a built-in
 * name is what the CLI would run, so it is what the menu should describe.
 */
export function mergeCommands(
  builtins: ReadonlyArray<SlashCommand>,
  discovered: ReadonlyArray<SlashCommand>,
): SlashCommand[] {
  const by = new Map<string, SlashCommand>();
  for (const c of builtins) by.set(c.name, c);
  for (const c of discovered) if (c.name) by.set(c.name, c);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A row in the completion menu. */
export interface CompletionItem {
  /** What replaces the token when it is picked. */
  value: string;
  /** Shown beside it — a command's own description; paths have none. */
  description?: string;
}

export interface Completion {
  trigger: "/" | "@";
  /** Index in the text where the token being completed starts. */
  start: number;
  /** The token typed so far, including its trigger. */
  token: string;
  /** For `@`: the directory whose listing the items came from. */
  dir: string;
  items: CompletionItem[];
}

/**
 * How well a command answers what has been typed, or -1 for not at all.
 *
 * Three tiers, because a namespaced catalogue makes a prefix-only match too
 * blunt: `/brainstorming` should still find `/superpowers:brainstorming`, and a
 * skill is often remembered by what it DOES rather than by its name. The CLI's
 * own menu matches descriptions too — typing `/help` there offers `/debug`
 * ("…help diagnose issues") — so this mirrors it rather than inventing a
 * different rule for the same keystrokes.
 */
export function commandRank(cmd: SlashCommand, token: string): number {
  const q = token.slice(1).toLowerCase();
  if (!q) return 0;
  const name = cmd.name.slice(1).toLowerCase();
  if (name.startsWith(q)) return 0;
  // After the namespace: `/superpowers:brainstorming` for "brain".
  const colon = name.indexOf(":");
  if (colon >= 0 && name.slice(colon + 1).startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if ((cmd.description ?? "").toLowerCase().includes(q)) return 3;
  return -1;
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
  commands: ReadonlyArray<SlashCommand> = BUILTIN_COMMANDS,
): Completion | null {
  const at = tokenAt(text, caret);
  if (!at) return null;
  const { start, token } = at;

  if (token.startsWith("/")) {
    // Only at the very beginning of the message: a slash command is the whole
    // prompt, and `cd /usr` should not open a command menu.
    if (start !== 0) return null;
    const ranked = commands
      .map((c) => ({ c, rank: commandRank(c, token) }))
      .filter((r) => r.rank >= 0);
    // Stable within a tier: the catalogue arrives sorted by name, and a menu
    // that reorders itself as the ranks shift is hard to aim at.
    ranked.sort((a, b) => a.rank - b.rank);
    const items = ranked.map(({ c }) => ({
      value: c.name,
      description: c.description,
    }));
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
      .map((p) => ({ value: `@${dir}${p}` }));
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

/**
 * A slash command this surface sent, which the transcript may never mention.
 *
 * Measured 2026-08-18: the CLI records /wrap-up, /model, /compact and /login,
 * and records NOTHING at all for /help, /context or /status. So a command sent
 * from the composer can land, do exactly what it was asked to, and leave the
 * chat with no trace that anything was sent — which is what Viktor reported.
 * The surface that sent it is the only thing that can account for those.
 */
export interface SentCommand {
  /** Negative, so it can never collide with a transcript event's id. */
  id: number;
  text: string;
  at: number;
}

/** Whether a composed message is a slash command rather than prose. */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z0-9][\w:-]*(\s|$)/.test(text.trim());
}

/** Whitespace-insensitive, so `/doc-tone  a.md` matches the recorded form. */
export function sameCommand(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}
