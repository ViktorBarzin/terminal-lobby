/**
 * A prompt has to appear the moment it is sent.
 *
 * Measured on a live session 2026-08-18: POST /prompt returns in ~23ms and the
 * transcript tail delivers in ~50ms, but the CLI takes 620-680ms to write its
 * own record of the prompt — 1.2s on a session's first turn, and unbounded when
 * the prompt is QUEUED behind a running turn, since that record only lands once
 * the queue drains. Waiting for it is why a message sat invisible for most of a
 * second after Send (Viktor, 2026-08-18).
 *
 * Slash commands are the extreme case: /help, /context and /status are never
 * recorded at all, so for those this is not a stand-in but the whole account.
 */
import { describe, it, expect } from "vitest";
import { isSlashCommand, sameCommand } from "../src/components/compose.logic";
import { withPendingPrompts } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const ev = (id: number, body: string): Event =>
  ({ id, kind: "user", session: "s", turnId: `t${id}`, body, at: id }) as Event;

const prompt = (text: string, over: Partial<Record<string, unknown>> = {}) => ({
  id: -1,
  text,
  at: 1000,
  command: isSlashCommand(text),
  afterId: 0,
  ...over,
});

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
    // Measured: the CLI TRIMS trailing whitespace off a prompt, so an exact
    // compare would never let that one go.
    expect(sameCommand("MARKE trailing spaces", "MARKE trailing spaces   ")).toBe(true);
    expect(sameCommand("/doc-tone  a.md", "/doc-tone a.md")).toBe(true);
  });

  it("does not confuse two different prompts", () => {
    expect(sameCommand("/help", "/helper")).toBe(false);
    expect(sameCommand("deploy the api", "deploy the ui")).toBe(false);
  });
});

describe("showing a prompt before the transcript has it", () => {
  it("adds nothing when nothing is outstanding", () => {
    const events = [ev(1, "hello")];
    expect(withPendingPrompts(events, [])).toBe(events);
  });

  it("appends it as a user event at the end", () => {
    const got = withPendingPrompts([ev(1, "hello")], [prompt("deploy the api")]);
    expect(got).toHaveLength(2);
    expect(got[1]!.kind).toBe("user");
    expect(got[1]!.body).toBe("deploy the api");
    // Its own turn: a prompt still waiting on a reply is a turn with nothing
    // in it yet, which is what it is.
    expect(got[1]!.turnId).not.toBe(got[0]!.turnId);
  });

  it("uses an id that cannot collide with a transcript event", () => {
    // Rows are keyed by id; a collision would have two rows fight over one key.
    const got = withPendingPrompts([ev(1, "hello")], [prompt("hi")]);
    expect(got[1]!.id).toBeLessThan(0);
  });

  it("keeps them in the order they were sent", () => {
    const got = withPendingPrompts(
      [ev(1, "hello")],
      [prompt("first", { id: -1 }), prompt("second", { id: -2 })],
    );
    expect(got.slice(1).map((e) => e.body)).toEqual(["first", "second"]);
  });

  it("leaves the transcript's own events untouched", () => {
    const events = [ev(1, "hello"), ev(2, "/wrap-up")];
    const got = withPendingPrompts(events, [prompt("/help")]);
    expect(got.slice(0, 2)).toEqual(events);
  });
});
