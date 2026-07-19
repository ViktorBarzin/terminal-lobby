import { describe, it, expect } from "vitest";
import { base64urlToUint8Array } from "../src/pwa/vapid";

/** Encode bytes as base64url (no padding) — the shape the server sends. */
function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("base64urlToUint8Array (VAPID applicationServerKey)", () => {
  it("decodes an unpadded base64url string to the right bytes", () => {
    // base64url of "hello" is "aGVsbG8" (standard base64 "aGVsbG8=").
    expect(Array.from(base64urlToUint8Array("aGVsbG8"))).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it("maps the URL-safe alphabet (- _) back to (+ /)", () => {
    // bytes [251,255,191] → standard base64 "+/+/" → base64url "-_-_".
    expect(Array.from(base64urlToUint8Array("-_-_"))).toEqual([251, 255, 191]);
  });

  it("re-pads lengths that are 2 and 3 mod 4", () => {
    // "TWE" (len 3, 1 pad) → "Ma"; "TQ" (len 2, 2 pad) → "M".
    expect(Array.from(base64urlToUint8Array("TWE"))).toEqual([77, 97]); // "Ma"
    expect(Array.from(base64urlToUint8Array("TQ"))).toEqual([77]); // "M"
  });

  it("round-trips a realistic 65-byte P-256 VAPID key", () => {
    // Uncompressed P-256 public point: 0x04 || X(32) || Y(32) = 65 bytes.
    const key = new Uint8Array(65);
    key[0] = 0x04;
    for (let i = 1; i < 65; i++) key[i] = (i * 37 + 11) & 0xff;
    const b64url = bytesToBase64url(key);
    expect(b64url).not.toContain("+");
    expect(b64url).not.toContain("/");
    expect(b64url).not.toContain("=");
    const decoded = base64urlToUint8Array(b64url);
    expect(decoded.length).toBe(65);
    expect(Array.from(decoded)).toEqual(Array.from(key));
  });

  it("returns a real Uint8Array (PushManager needs the typed array)", () => {
    expect(base64urlToUint8Array("aGVsbG8")).toBeInstanceOf(Uint8Array);
  });
});
