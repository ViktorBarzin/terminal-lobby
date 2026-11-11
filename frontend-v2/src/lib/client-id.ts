/**
 * WHICH TMUX CLIENT THIS CONNECTION IS, minted in the browser.
 *
 * tmux sizes a window from its clients, and an HTTP request names no client.
 * Two devices of one person reach tmux-api behind one identity header, so the
 * grid endpoint could see that somebody wanted the window and never who —
 * which is why it used to promote whichever preload client it found and 409 if
 * it found none. Last-active-wins needs the answer, so the browser supplies
 * it: an id per terminal mount, sent as ttyd arg 8, recorded by
 * devvm/tmux-attach.sh against that connection's pty before it execs, and read
 * back by tmux-api (clientreg.go), which validates it against tmux's own
 * client list on every claim.
 *
 * THE SHAPE IS A CONTRACT with three other places: `CLIENT_ID_RE` in
 * devvm/tmux-attach.sh, `clientIDRe` in tmux-api/clientreg.go, and the file
 * NAME the record is written under. That last one is why the charset is this
 * narrow rather than base32 or base64url: `[0-9a-f]` admits no '/', no '.' and
 * no space, so nothing an id contains can build a path.
 *
 * NOT the device id (telemetry/device.ts), which mints the identical 16 bytes
 * of hex and then persists them in localStorage. That one names a browser
 * installation, shared by every tab and every tile; this one names a
 * connection, and two tiles of a workspace claiming under one name is exactly
 * what would make per-tile ownership meaningless. Same bytes, different
 * lifetime, so a separate module.
 */

/** 16 random bytes as lowercase hex: what {@link newClientId} produces, and
 *  the only shape the shell gate and tmux-api accept. */
export const CLIENT_ID_RE = /^[0-9a-f]{32}$/;

/**
 * A fresh connection id.
 *
 * `crypto.getRandomValues`, not `Math.random`: two tabs opening the same
 * session in the same millisecond must not mint the same id, and an id
 * collision here would hand one tab's claim to the other tab's tmux client.
 * 128 bits is far past needing to think about that.
 */
export function newClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
