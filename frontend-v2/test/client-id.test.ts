import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT_ID_RE, newClientId } from "../src/lib/client-id";

const REPO = (p: string): string => resolve(__dirname, "../..", p);

/**
 * The per-connection client id: which tmux client a size claim belongs to.
 *
 * tmux sizes a window from its clients, and an HTTP request names none. Two
 * devices of one person arrive with a single identity header, so before this
 * existed tmux-api could see that somebody wanted the window and never who.
 * The browser mints an id per terminal mount, sends it as ttyd arg 8, and
 * devvm/tmux-attach.sh records that connection's pty against it.
 *
 * The shape is a contract with three other places: the shell's CLIENT_ID_RE
 * (devvm/tmux-attach.sh), tmux-api's clientIDRe (tmux-api/clientreg.go), and
 * the file NAME the record is written under. That last one is why the charset
 * is this narrow: `[0-9a-f]` admits no '/', no '.' and no space, so no id can
 * ever build a path.
 */
describe("newClientId", () => {
  it("is 32 lowercase hex characters, which is 16 random bytes", () => {
    for (let i = 0; i < 200; i++) {
      const id = newClientId();
      expect(id).toHaveLength(32);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("satisfies its own validator", () => {
    for (let i = 0; i < 200; i++) expect(CLIENT_ID_RE.test(newClientId())).toBe(true);
  });

  /**
   * Two tabs, or two tiles of one workspace, must never claim as the same
   * client: each one is a separate ttyd connection and a separate tmux client,
   * and last-active-wins would be meaningless if they shared a name.
   */
  it("mints a different id every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(newClientId());
    expect(seen.size).toBe(500);
  });

  /** The shell gate is where an id that does not match becomes no id at all,
   *  so the two ends must agree on the class down to the character. */
  it("agrees with the gate in devvm/tmux-attach.sh", () => {
    const sh = readFileSync(REPO("devvm/tmux-attach.sh"), "utf8");
    const m = /^CLIENT_ID_RE='(.+)'$/m.exec(sh);
    expect(m, "devvm/tmux-attach.sh declares CLIENT_ID_RE").not.toBeNull();
    expect(m?.[1]).toBe(CLIENT_ID_RE.source);
  });

  /** And with the reader, which refuses anything else before it touches the
   *  filesystem (tmux-api/clientreg.go). */
  it("agrees with clientIDRe in tmux-api", () => {
    const go = readFileSync(REPO("tmux-api/clientreg.go"), "utf8");
    expect(go).toContain("regexp.MustCompile(`" + CLIENT_ID_RE.source + "`)");
  });

  it("rejects the shapes a claim must not carry", () => {
    for (const bad of [
      "",
      "deadbeef",
      "0".repeat(31),
      "0".repeat(33),
      "DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
      "../../etc/passwd",
      "deadbeefdeadbeefdeadbeefdeadbee/",
      "deadbeef deadbeefdeadbeefdeadbe",
    ]) {
      expect(CLIENT_ID_RE.test(bad), bad).toBe(false);
    }
  });
});
