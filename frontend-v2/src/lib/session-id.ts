/**
 * Minting a session's NAME, which is an opaque id (ADR-0019).
 *
 * A session name used to be derived from the title someone typed, so that
 * `tmux ls` read like a list of conversations. Prompt-first sessions take the
 * typing-a-title moment away — the title now arrives from Claude Code's own
 * conversation summary — and a derived name would then move on its own, with
 * nobody watching. So the name stops being something anyone reads: it is an id,
 * minted here, and it never changes.
 *
 * Minted in the BROWSER because creating a session reaches no server. The id
 * goes straight into `?arg=<id>`, ttyd runs `tmux new-session -A -s <id>`, and
 * that path deliberately still works while tmux-api is down.
 *
 * The Go mirror is tmux-api/sessionid.go. The two must agree on the alphabet
 * and the length: tmux-api's one-time migration decides a session has already
 * been migrated by testing its name against this shape.
 */

/**
 * 12 characters, 60 bits. Ample against accidental collision at a few thousand
 * sessions per user, and `tmux rename-session` refuses a duplicate name, so a
 * collision is a free retry rather than a corruption.
 */
export const SESSION_ID_LEN = 12;

/**
 * Crockford's base32 alphabet, lowercase: the digits plus every letter except
 * i, l, o and u.
 *
 * Case matters because the URL hash is case-sensitive and nothing lowercases a
 * session name, so an id retyped from a screenshot in the wrong case would
 * select nothing. One case, and no character anyone confuses with another when
 * reading an id back off a screen.
 */
export const SESSION_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** What SESSION_ID_ALPHABET and SESSION_ID_LEN produce, as a test. */
const SESSION_ID_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;

/**
 * A fresh session id.
 *
 * `crypto.getRandomValues`, not `Math.random`: two tabs opening a composer in
 * the same millisecond must not mint the same id, and Math.random is seeded
 * per realm with no such guarantee.
 *
 * 256 is exactly 8 x 32, so the low five bits of a uniform byte are uniform
 * over the alphabet — masking needs no rejection loop and introduces no bias.
 */
export function newSessionId(): string {
  const bytes = new Uint8Array(SESSION_ID_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SESSION_ID_ALPHABET[b & 31];
  return out;
}

/**
 * Whether a session name is one of ours.
 *
 * Used to tell a migrated session from one still carrying a human name. A name
 * this accepts is left alone, so it must not accept anything a person would
 * have typed: excluding i, l, o and u already rules out most English words, and
 * every name on the box on 2026-09-04 fails it.
 */
export function isSessionId(name: string): boolean {
  return SESSION_ID_RE.test(name);
}
