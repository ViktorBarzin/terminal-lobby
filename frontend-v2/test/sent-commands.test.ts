/**
 * A slash command sent from text mode has to appear in the chat.
 *
 * Reported by Viktor 2026-08-18: "it is sent successfully but doesn't appear in
 * the transcript". Measured that day on a live CLI: /wrap-up, /model, /compact
 * and /login ARE written to the transcript; /help, /context and /status leave
 * it untouched entirely. So for a good part of the menu there is no record to
 * wait for, and the surface that sent the command is the only thing that can
 * account for it.
 */
import { describe, it, expect } from "vitest";
import { isSlashCommand, sameCommand } from "../src/components/compose.logic";
import { withSentCommands } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const ev = (id: number, body: string): Event =>
  ({ id, kind: "user", session: "s", turnId: `t${id}`, body, at: id }) as Event;

describe("recognising a command", () => {
  it("takes a leading slash token as one", () => {
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("/doc-tone docs/plan.md")).toBe(true);
    expect(isSlashCommand("/superpowers:brainstorming")).toBe(true);
    expect(isSlashCommand("  /clear  ")).toBe(true);
  });

  it("leaves prose alone", () => {
    expect(isSlashCommand("please deploy")).toBe(false);
    expect(isSlashCommand("cd /usr/local and look")).toBe(false);
    // A bare slash is not a command yet — it is someone mid-type.
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});

describe("matching what the transcript eventually says", () => {
  it("ignores whitespace differences", () => {
    expect(sameCommand("/doc-tone  a.md", "/doc-tone a.md")).toBe(true);
    expect(sameCommand(" /help ", "/help")).toBe(true);
  });

  it("does not confuse two different commands", () => {
    expect(sameCommand("/help", "/helper")).toBe(false);
    expect(sameCommand("/doc-tone a.md", "/doc-tone b.md")).toBe(false);
  });
});

describe("standing in until the transcript catches up", () => {
  const sent = [{ id: -1, text: "/help", at: 1000 }];

  it("adds nothing when nothing is outstanding", () => {
    const events = [ev(1, "hello")];
    expect(withSentCommands(events, [])).toBe(events);
  });

  it("appends the command as a user event at the end", () => {
    const got = withSentCommands([ev(1, "hello")], sent);
    expect(got).toHaveLength(2);
    expect(got[1]!.kind).toBe("user");
    expect(got[1]!.body).toBe("/help");
    // Its own turn: a command with no response is a turn with nothing in it.
    expect(got[1]!.turnId).not.toBe(got[0]!.turnId);
  });

  it("uses an id that cannot collide with a transcript event", () => {
    // Rows are keyed by id; a collision would have two rows fight over one key.
    const got = withSentCommands([ev(1, "hello")], sent);
    expect(got[1]!.id).toBeLessThan(0);
  });

  it("leaves the transcript's own events untouched", () => {
    const events = [ev(1, "hello"), ev(2, "/wrap-up")];
    const got = withSentCommands(events, sent);
    expect(got.slice(0, 2)).toEqual(events);
  });
});
