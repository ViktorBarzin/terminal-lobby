/**
 * VAPID application-server-key decoding (inventory Cat.9 "Web Push subscribe").
 *
 * The server hands the frontend its VAPID public key as base64url text
 * (GET /push/vapid-public). `PushManager.subscribe({applicationServerKey})`
 * requires that key as a raw `Uint8Array`, so we convert here. This is the
 * SAME algorithm the (verbatim) service worker uses in its
 * `pushsubscriptionchange` re-subscribe path (public/sw.js `urlB64ToUint8Array`)
 * and the vanilla frontend used inline — kept byte-identical so a page-subscribe
 * and an SW-re-subscribe produce the same key material for the same endpoint.
 */

/**
 * Decode a base64url (RFC 4648 §5) string into the raw bytes a
 * PushManager applicationServerKey needs.
 *
 *  - re-pads to a multiple of 4 with `=`,
 *  - maps the URL-safe alphabet (`-`,`_`) back to standard base64 (`+`,`/`),
 *  - `atob` → binary string → byte array.
 *
 * Assumes a well-formed key (the server controls it); a malformed key throws
 * from `atob`, which the best-effort push callers already swallow.
 */
// Returns a fresh ArrayBuffer-backed array (not ArrayBufferLike): PushManager's
// `applicationServerKey: BufferSource` rejects the SharedArrayBuffer half of the
// default `Uint8Array<ArrayBufferLike>` under the TS 5.7 DOM lib.
export function base64urlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
