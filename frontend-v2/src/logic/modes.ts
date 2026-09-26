/**
 * The permission modes, as the Text view's mode dial lists them.
 *
 * WHY A LIST. The chip this replaces stepped the mode on every click, the way
 * Shift+Tab does in the CLI, so a reader who wanted plan clicked until plan
 * showed and read the mode's meaning off its colour. Viktor chose the Quiet
 * line composer on 2026-09-24, and with it a dial that opens every mode with
 * one line on what it does; picking one asks the server to press Shift+Tab one
 * stop at a time until the pane shows it (POST /model/{session} with a
 * "mode", lib/mode-api.ts). Shift+Tab in the message still steps once.
 *
 * THE WORDS. The labels are the CLI's own mode titles from its mode table
 * (2.1.281: Manual, Plan, Accept edits, Auto, Bypass Permissions, Don't Ask),
 * cut where they run long, so the dial and the status line under the terminal
 * name the same thing. "Accept edits" becomes Edits and "Bypass Permissions"
 * becomes Bypass because the dial sits on a 390px phone beside two others.
 *
 * No ask's line is the one that differs from the prototype, which called it
 * the same as bypass under a newer name. The CLI maps dontAsk to deny: a tool
 * call that would have asked is refused, with "Permission to use X has been
 * denied because Claude Code is running in don't ask mode" (memory #13914).
 * It is still drawn as a danger mode, since nothing asks the reader first
 * (open point O1 in the spec).
 *
 * The Auto line is the prototype's and was not checked against the CLI.
 */

/** The CLI's own identifiers (`claude --help`). */
export type ModeId = "manual" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/**
 * How much the mode lets through without asking, which is what colours its
 * icon: `safe` asks before everything, `plan` changes nothing at all,
 * `caution` lets some things land unasked, `danger` asks about nothing.
 */
export type ModeTone = "safe" | "plan" | "caution" | "danger";

export interface ModeRow {
  readonly id: ModeId;
  readonly label: string;
  /** One line on what the mode does, under its name in the list. */
  readonly line: string;
  readonly tone: ModeTone;
}

/**
 * In the order the list draws them: the four that ask first, a rule, then the
 * two that do not. That is not the Shift+Tab order (manual, acceptEdits, plan,
 * bypassPermissions, auto, measured 2026-09-24, memory #13911); the list is
 * sorted by how much each mode lets through, which is the question a reader
 * opening it is asking.
 */
export const MODES: readonly ModeRow[] = [
  { id: "manual", label: "Manual", line: "Asks before every edit and command", tone: "safe" },
  { id: "plan", label: "Plan", line: "Reads and plans. Changes nothing", tone: "plan" },
  {
    id: "acceptEdits",
    label: "Edits",
    line: "File edits land unasked. Commands still ask",
    tone: "caution",
  },
  { id: "auto", label: "Auto", line: "Most actions land unasked. Risky ones ask", tone: "caution" },
  {
    id: "bypassPermissions",
    label: "Bypass",
    line: "Nothing asks. Every tool runs",
    tone: "danger",
  },
  {
    id: "dontAsk",
    label: "No ask",
    line: "Nothing asks. Anything that would ask is refused",
    tone: "danger",
  },
];

/**
 * The identifier a mode string stands for, or undefined for one this list does
 * not know. `default` is what transcripts written before the CLI's rename call
 * `manual`, and they are still most of what ~/.claude/projects holds.
 */
export function modeId(mode: string): ModeId | undefined {
  const id = mode === "default" ? "manual" : mode;
  return MODES.some((m) => m.id === id) ? (id as ModeId) : undefined;
}

/** The list's row for a mode, or undefined for one it does not know. */
export function modeRow(mode: string): ModeRow | undefined {
  const id = modeId(mode);
  return id ? MODES.find((m) => m.id === id) : undefined;
}

/** What the dial calls a mode. An unfamiliar one shows as the CLI spelled it,
 *  rather than as a blank the reader cannot ask about. */
export function modeTitle(mode: string): string {
  return modeRow(mode)?.label ?? mode;
}

/** Bypass and No ask: the two modes in which nothing asks the reader first. */
export function isDangerMode(mode: string): boolean {
  return modeRow(mode)?.tone === "danger";
}

/**
 * The message field's placeholder under a mode.
 *
 * One of four signals the danger modes get (the hatched dial, the pill's
 * danger edge and the dashed rule along the dock's top are the other three),
 * and the one sitting exactly where the reader is about to type.
 */
export function placeholderFor(mode: string): string {
  return isDangerMode(mode) ? `${modeTitle(mode)} is on · nothing asks first` : "Message…";
}
