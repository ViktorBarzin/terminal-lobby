/**
 * Normalizing a session's display TITLE.
 *
 * A title is arbitrary text — spaces, punctuation, emoji, any script — and is
 * the only string on a session that anyone reads. It used to be the source a
 * tmux session NAME was derived from; ADR-0019 ended that, and a name is now a
 * minted id (lib/session-id.ts) that never moves. So nothing here derives
 * anything: it only cleans what a person typed before it is stored.
 *
 * The mirror of Go's terminal-lobby/slug CleanTitle, which tmux-api runs on
 * every title that reaches it. The two agreeing matters because the browser
 * shows what it typed optimistically and the server stores what it stamped.
 */

/**
 * Title cap, in code points. An emoji is one character to the person who typed
 * it, and cutting on UTF-16 units would split a surrogate pair.
 */
export const MAX_TITLE_RUNES = 64;

/** Control characters (C0 and C1) and every flavour of Unicode whitespace. */
const CONTROL_OR_SPACE = /[\p{Cc}\p{Zs}\p{Zl}\p{Zp}\s]/u;

/**
 * Normalize a title for storage and display.
 *
 * Control characters become a space rather than vanishing: a title pasted out
 * of a terminal or an editor arrives with tabs and newlines in it, and "tab and
 * newline" is what the person meant where "tabandnewline" is not. Whitespace
 * runs then collapse, so the result is stable whichever control character
 * produced the gap.
 *
 * Idempotent — a retitle compares against the stored value, and a clean that
 * kept changing its own output would write on every poll.
 */
export function cleanTitle(title: string): string {
  let out = "";
  let space = true; // leading whitespace is dropped by starting "in" a run
  for (const ch of title) {
    if (CONTROL_OR_SPACE.test(ch)) {
      if (!space) {
        out += " ";
        space = true;
      }
      continue;
    }
    out += ch;
    space = false;
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);
  const runes = [...out];
  if (runes.length > MAX_TITLE_RUNES) {
    out = runes.slice(0, MAX_TITLE_RUNES).join("");
    if (out.endsWith(" ")) out = out.slice(0, -1);
  }
  return out;
}
