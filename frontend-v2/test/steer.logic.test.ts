import { describe, it, expect } from "vitest";
import type { AgentInfo, Event } from "../src/types/events";
import {
  steerNote,
  unreadSteers,
  withSteers,
  type PendingSteer,
} from "../src/components/steer.logic";
import { deriveRows, type UserRow } from "../src/components/timeline.logic";

const agent = (over: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id: "a1", state: "running", workflowId: "", steerable: true, ...over }) as AgentInfo;

describe("steerNote", () => {
  it("lets a steerable agent be messaged", () => {
    expect(steerNote(agent())).toBeUndefined();
  });
  it("says why an agent cannot be messaged, in a reason the field can show", () => {
    expect(steerNote(agent({ steerable: false, steerNote: "finished" }))).toMatch(/^Finished: /);
    expect(steerNote(agent({ steerable: false, steerNote: "workflow" }))).toMatch(/^Read-only: /);
    expect(steerNote(agent({ steerable: false, steerNote: "old-mod" }))).toMatch(/^Restart: /);
  });
  it("never offers to send to an agent it knows nothing about", () => {
    expect(steerNote(undefined)).toMatch(/^Finished: /);
    expect(steerNote(agent({ steerable: undefined }))).toBeDefined();
  });
});

let seq = 0;
const ev = (e: Partial<Event> & { kind: Event["kind"] }): Event => ({
  id: ++seq,
  session: "s",
  turnId: "t1",
  ...e,
});
const pending = (id: number, text: string): PendingSteer => ({ id, agent: "a1", text, at: 1 });

describe("waiting bubbles", () => {
  it("draws a message as waiting until the agent's stream shows it", () => {
    const sent = [pending(-1, "stop now")];
    const seen = new Map<number, number>();
    const before = [ev({ kind: "user", body: "count to five" })];
    expect(unreadSteers(before, sent, seen)).toEqual(sent);
    const rows = deriveRows(withSteers(before, unreadSteers(before, sent, seen)), { fold: false });
    const last = rows.filter((r): r is UserRow => r.kind === "user").at(-1)!;
    expect(last).toMatchObject({ body: "stop now", sending: true, steer: true });

    const after = [...before, ev({ kind: "user", body: "stop now", steer: true, turnId: "t2" })];
    expect(unreadSteers(after, sent, seen)).toEqual([]);
  });

  it("does not take an earlier message with the same words for the new one", () => {
    const first = ev({ kind: "user", body: "again", steer: true });
    const seen = new Map<number, number>();
    const sent = [pending(-2, "again")];
    expect(unreadSteers([first], sent, seen)).toEqual(sent);
    expect(
      unreadSteers([first, ev({ kind: "user", body: "again", steer: true })], sent, seen),
    ).toEqual([]);
  });

  it("only clears on the person's own message, not a prompt with the same words", () => {
    const seen = new Map<number, number>();
    const sent = [pending(-3, "hello")];
    unreadSteers([], sent, seen);
    expect(unreadSteers([ev({ kind: "user", body: "hello" })], sent, seen)).toEqual(sent);
  });
});
