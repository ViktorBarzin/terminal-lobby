/**
 * The permission modes, as the Text view's model sheet lists them.
 *
 * WHY A LIST. The chip this replaces stepped the mode on every click, the way
 * Shift+Tab does in the CLI, so a reader who wanted plan clicked until plan
 * showed and read the mode's meaning off its colour. Viktor chose the Quiet
 * line composer on 2026-09-24, and with it a dial that opens every mode with
 * one line on what it does; picking one asks the server to press Shift+Tab one
 * stop at a time until the pane shows it (POST /model/{session} with a
 * "mode", lib/mode-api.ts). Shift+Tab in the message still steps once. The
 * T3 pass (2026-09-27) moved the list into the model sheet, under the one
 * model button in the composer's box.
 *
 * THE WORDS. The labels are the CLI's own mode titles from its mode table
 * (2.1.281: Manual, Plan, Accept edits, Auto, Bypass Permissions, Don't Ask),
 * cut where they run long, so the sheet and the status line under the terminal
 * name the same thing. "Accept edits" became Edits and "Bypass Permissions"
 * became Bypass when the mode was a dial on a 390px phone beside two others,
 * and the sheet kept the short words.
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
 * In the order the model sheet draws them (the T3 pass, 2026-09-27): the four
 * that ask first, a rule, then the two that do not. The four run Manual,
 * Edits, Auto by how much each lets land unasked, then Plan, which changes
 * nothing and so sits apart from the three that act. That is not the
 * Shift+Tab order (manual, acceptEdits, plan, bypassPermissions, auto,
 * measured 2026-09-24, memory #13911), which the server walks whatever order
 * this list is in.
 */
export const MODES: readonly ModeRow[] = [
  { id: "manual", label: "Manual", line: "Asks before every edit and command", tone: "safe" },
  {
    id: "acceptEdits",
    label: "Edits",
    line: "File edits land unasked. Commands still ask",
    tone: "caution",
  },
  { id: "auto", label: "Auto", line: "Most actions land unasked. Risky ones ask", tone: "caution" },
  { id: "plan", label: "Plan", line: "Reads and plans. Changes nothing", tone: "plan" },
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

/** What the sheet calls a mode. An unfamiliar one shows as the CLI spelled it,
 *  rather than as a blank the reader cannot ask about. */
export function modeTitle(mode: string): string {
  return modeRow(mode)?.label ?? mode;
}

/** Bypass and No ask: the two modes in which nothing asks the reader first. */
export function isDangerMode(mode: string): boolean {
  return modeRow(mode)?.tone === "danger";
}

/**
 * Whether the model decides if this mode is offered. Claude Code offers Auto
 * on some models and not others (Haiku 4.5 drops it, deployed review round 4,
 * 2026-09-29); the others are the launch flags' to decide.
 */
export function modeHangsOnModel(mode: ModeId): boolean {
  return mode === "auto";
}
