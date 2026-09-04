import { describe, it, expect, vi } from "vitest";
import {
  newSessionId,
  isSessionId,
  SESSION_ID_LEN,
  SESSION_ID_ALPHABET,
} from "../src/lib/session-id";
import { NAME_RE } from "../src/types/lobby";

/**
 * The session id is the tmux session NAME (ADR-0019), so its shape is a
 * contract with seven independent copies of `^[a-zA-Z0-9_-]{1,32}$` across the
 * Go services, the frontend and tmux-attach.sh — and with tmux-api's
 * `sessionIDRe`, which is what the one-time migration reads to decide a session
 * has already been migrated. A change here that is not mirrored there either
 * re-migrates every session on every restart or refuses to migrate at all.
 */
describe("newSessionId", () => {
  it("is 12 characters from the lowercase Crockford base32 alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const id = newSessionId();
      expect(id).toHaveLength(SESSION_ID_LEN);
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
    }
  });

  it("satisfies the session-name validator every service shares", () => {
    for (let i = 0; i < 200; i++) expect(NAME_RE.test(newSessionId())).toBe(true);
  });

  it("excludes the four characters people confuse when retyping an id", () => {
    // i/1, l/1, o/0 and u/v. An id is what someone quotes when reporting a
    // problem, and the URL hash is case-sensitive with no fuzzy match.
    expect(SESSION_ID_ALPHABET).toHaveLength(32);
    for (const ch of "ilou") expect(SESSION_ID_ALPHABET).not.toContain(ch);
    expect(SESSION_ID_ALPHABET).toBe(SESSION_ID_ALPHABET.toLowerCase());
  });

  it("comes from crypto.getRandomValues, not Math.random", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const random = vi.spyOn(Math, "random");
    newSessionId();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(random).not.toHaveBeenCalled();
    spy.mockRestore();
    random.mockRestore();
  });

  it("maps every byte value into the alphabet without bias", () => {
    // 256 is 8 x 32, so the low five bits of a uniform byte are uniform over
    // the alphabet: masking needs no rejection loop and skews nothing. Feed
    // the 256 byte values and each of the 32 symbols must come up 8 times.
    let fed = 0;
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
        const b = buf as unknown as Uint8Array;
        for (let i = 0; i < b.length; i++) b[i] = fed++ & 0xff;
        return buf;
      });
    const counts = new Map<string, number>();
    // 256 mints is 3072 bytes, twelve whole passes over the 256 byte values.
    for (let i = 0; i < 256; i++) {
      for (const ch of newSessionId()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    spy.mockRestore();
    const each = (256 * SESSION_ID_LEN) / SESSION_ID_ALPHABET.length;
    for (const ch of SESSION_ID_ALPHABET) expect(counts.get(ch)).toBe(each);
  });

  it("does not repeat itself", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(newSessionId());
    expect(seen.size).toBe(2000);
  });
});

describe("isSessionId", () => {
  it("accepts what newSessionId mints", () => {
    for (let i = 0; i < 50; i++) expect(isSessionId(newSessionId())).toBe(true);
  });

  it("rejects the human names sessions carried before ids", () => {
    // These are real names off the box on 2026-09-04. The migration skips a
    // name this accepts, so a false positive leaves a session unmigrated.
    for (const n of [
      "authentik",
      "ca-asia",
      "hyperoptic",
      "ny-reibursment",
      "notifications-when-running",
      "new-session",
      "shell",
      "session-1",
      "",
    ]) {
      expect(isSessionId(n)).toBe(false);
    }
  });

  it("rejects an id of the right shape wearing the wrong case or length", () => {
    expect(isSessionId("K7M2Q9X4TPZ3")).toBe(false); // uppercase
    expect(isSessionId("k7m2q9x4tp")).toBe(false); // ten characters
    expect(isSessionId("k7m2q9x4tpz3v")).toBe(false); // thirteen
    expect(isSessionId("k7m2q9x4tpzi")).toBe(false); // i is not in the alphabet
    expect(isSessionId("k7m2q9x4tp-3")).toBe(false); // a dash is not either
  });
});
