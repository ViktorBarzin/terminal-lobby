/**
 * The phone's two-line session row (T3 pass on the list, 2026-11-23): what the
 * right-hand chip says, what the second line says, and what the list's search
 * box matches. Pure functions, so the row's words are pinned here rather than
 * read back out of the DOM.
 */
import { describe, it, expect } from "vitest";
import { matchesSearch, phoneChip, phoneMeta } from "../src/components/phone-row.logic";
import type { Session } from "../src/types/lobby";

const NOW = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

const sess = (over: Partial<Session> = {}): Session => ({
  name: "alpha",
  attached: 0,
  lastActivity: 0,
  created: sec(NOW) - 3 * 86400,
  owner: "wizard",
  origin: "user",
  ...over,
});

describe("phoneChip", () => {
  it("says Needs you while the session waits on the person", () => {
    expect(phoneChip(sess({ state: "awaiting" }), { unseen: false, now: NOW })).toEqual({
      kind: "need",
      text: "Needs you",
    });
  });

  it("runs a timer from the last prompt while Claude works", () => {
    const s = sess({ state: "running", lastPrompt: sec(NOW) - 252 });
    expect(phoneChip(s, { unseen: false, now: NOW })).toEqual({ kind: "run", text: "4:12" });
  });

  it("falls back to this tab's own start stamp when the server has no prompt time", () => {
    const s = sess({ state: "running" });
    expect(phoneChip(s, { unseen: false, now: NOW, workingSince: NOW - 48_000 })).toEqual({
      kind: "run",
      text: "0:48",
    });
  });

  it("says Done for a finished session the person has not opened", () => {
    expect(phoneChip(sess({ state: "done" }), { unseen: true, now: NOW })).toEqual({
      kind: "done",
      text: "Done",
    });
  });

  it("shows a short age for everything else", () => {
    const s = sess({ state: "done", lastPrompt: sec(NOW) - 5 * 3600 });
    expect(phoneChip(s, { unseen: false, now: NOW })).toEqual({ kind: "age", text: "5h" });
  });

  it("shows nothing for a session with no time of its own", () => {
    expect(phoneChip(sess({ created: 0 }), { unseen: false, now: NOW })).toBeNull();
  });
});

describe("phoneMeta", () => {
  it("names what a session is doing", () => {
    expect(phoneMeta(sess({ state: "running" }))).toBe("working");
    expect(phoneMeta(sess({ state: "awaiting" }))).toBe("waiting for you");
    expect(phoneMeta(sess({ state: "suspended" }))).toBe("suspended, tap to resume");
  });

  it("adds background work to a running session", () => {
    expect(phoneMeta(sess({ state: "running", bg: { agents: 2 } }))).toBe("working · 2 agents");
  });

  it("names the tool when it is not Claude, and T3 for a T3 thread", () => {
    expect(phoneMeta(sess({ tool: "shell" }))).toBe("shell");
    expect(phoneMeta(sess({ tool: "codex", state: "running" }))).toBe("working · codex");
    expect(phoneMeta(sess({ tool: "claude", backend: "t3" }))).toBe("T3");
    expect(phoneMeta(sess({ tool: "claude", state: "done" }))).toBe("");
  });

  it("leads with the project only when asked to", () => {
    expect(phoneMeta(sess({ state: "running" }), { project: "code" })).toBe("code · working");
  });

  it("says whose a shared session is, and that a watched one opens as a viewer", () => {
    expect(phoneMeta(sess({ owner: "emo", access: "ro" }), { foreign: true })).toBe(
      "emo's · read-only",
    );
    expect(phoneMeta(sess({ owner: "emo", access: "rw" }), { foreign: true })).toBe("emo's");
    expect(phoneMeta(sess({ guests: [{ name: "emo", mode: "ro" }] }))).toBe("shared");
    expect(phoneMeta(sess(), { watching: true })).toBe("opens as a viewer");
  });
});

describe("matchesSearch", () => {
  const s = sess({ name: "t3_qw63", title: "Double billing in energy provider switch" });

  it("matches the title, case-insensitively", () => {
    expect(matchesSearch(s, "", "ENERGY")).toBe(true);
    expect(matchesSearch(s, "", "solar")).toBe(false);
  });

  it("matches the tmux name and the project", () => {
    expect(matchesSearch(s, "", "qw63")).toBe(true);
    expect(matchesSearch(s, "code", "code")).toBe(true);
  });

  it("needs every word, in any order", () => {
    expect(matchesSearch(s, "code", "switch energy")).toBe(true);
    expect(matchesSearch(s, "code", "switch solar")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesSearch(s, "", "   ")).toBe(true);
  });
});
