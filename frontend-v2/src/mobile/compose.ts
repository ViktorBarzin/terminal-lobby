/**
 * Compose-bar send shaping — the bracketed-paste + SEPARATE trailing submit
 * split, ported from the vanilla frontend/index.html compose bar (the multiline
 * paste path ~11642-11656 and the Enter-submit path ~11625-11641).
 *
 * The problem it solves: a multiline block typed/pasted into the compose bar
 * must reach the receiving TUI (Claude Code / a shell) as ONE message, not N
 * submitted lines. The fix is xterm/DEC bracketed paste: the text is wrapped in
 * ESC[200~ … ESC[201~, and every newline INSIDE those brackets is a SOFT
 * newline (the receiver inserts it literally and does NOT act on it). The actual
 * submit is a SEPARATE `\r` frame emitted AFTER the paste — so a CR inside the
 * paste is soft, and only the trailing CR submits.
 *
 * `splitComposeSubmit` returns the two pieces separately (the caller sends them
 * as two distinct writes / postMessages) precisely so the submit can never be
 * folded into the bracketed block. Pure + string-only, so it is unit-testable
 * and reusable by both the terminal-forward path and any injection path.
 */

/** DEC bracketed-paste start marker. */
export const BRACKET_START = "\x1b[200~";
/** DEC bracketed-paste end marker. */
export const BRACKET_END = "\x1b[201~";
/** The carriage return that submits the line. */
export const SUBMIT = "\r";

export interface ComposeFrames {
  /** ESC[200~ <soft-newline text> ESC[201~ — send as its own frame. */
  paste: string;
  /** "\r" — a SEPARATE trailing frame; NEVER concatenated into `paste`. */
  submit: string;
}

/**
 * Normalize a composed message's newlines to soft LFs for a bracketed paste:
 * CRLF and lone CR both collapse to LF, so no stray CR inside the paste can be
 * mistaken for a submit. Internal newlines are preserved; a single trailing
 * newline is dropped (it is expressed by the separate submit, not a soft line).
 */
export function softNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/**
 * Split a composed message into a bracketed-paste payload + a separate trailing
 * submit. Newlines inside the payload are SOFT (kept inside the brackets); the
 * submit is the standalone `\r`.
 */
export function splitComposeSubmit(text: string): ComposeFrames {
  return {
    paste: BRACKET_START + softNewlines(text) + BRACKET_END,
    submit: SUBMIT,
  };
}

/**
 * Wrap arbitrary text as a bracketed paste WITHOUT a submit (e.g. inserting a
 * file path or a snippet into the input line the user will edit before sending).
 * Newlines are softened exactly as in `splitComposeSubmit`.
 */
export function bracketedPaste(text: string): string {
  return BRACKET_START + softNewlines(text) + BRACKET_END;
}
