/**
 * What is actually still waiting in Claude's queue.
 *
 * Viktor's session showed three queued messages with an empty queue
 * (2026-08-18): his own message, which had been answered, and two background
 * task notifications consumed minutes earlier. The list was built from the
 * queue's ARRIVALS alone, on the belief that the transcript never reports a
 * departure — it does, three different ways. Counted across 141 transcripts on
 * this box: enqueue 1261, remove 841, dequeue 393, popAll 13.
 */
import { describe, it, expect } from "vitest";
import { queuedPrompts, withoutQueued } from "../src/components/timeline.logic";
import type { PendingPrompt } from "../src/logic/compose.logic";
import type { Event, MetaKind } from "../src/types/events";

let next = 1;
const meta = (kind: MetaKind, body = ""): Event =>
  ({ id: next++, kind: "meta", meta: kind, body, session: "s" }) as Event;
const user = (body: string): Event => ({ id: next++, kind: "user", body, session: "s" }) as Event;

describe("the queue, replayed from its own operations", () => {
  it("shows what was enqueued and not yet taken", () => {
    expect(queuedPrompts([meta("queued", "first"), meta("queued", "second")])).toEqual([
      "first",
      "second",
    ]);
  });

  it("drops the one a remove names", () => {
    // The pairing the CLI writes: same content, seconds later.
    expect(
      queuedPrompts([meta("queued", "first"), meta("queued", "second"), meta("unqueued", "first")]),
    ).toEqual(["second"]);
  });

  it("drops the head on a dequeue, which names nothing", () => {
    expect(
      queuedPrompts([meta("queued", "first"), meta("queued", "second"), meta("dequeued")]),
    ).toEqual(["second"]);
  });

  it("empties on popAll", () => {
    expect(
      queuedPrompts([
        meta("queued", "first"),
        meta("queued", "second"),
        meta("queue-cleared", "first"),
      ]),
    ).toEqual([]);
  });

  it("comes back to empty over a full round trip", () => {
    // Exactly the shape of Viktor's session: four in, four out.
    const events: Event[] = [];
    for (const t of ["a", "b", "c", "d"]) events.push(meta("queued", t));
    for (const t of ["a", "b", "c", "d"]) events.push(meta("unqueued", t));
    expect(queuedPrompts(events)).toEqual([]);
  });

  it("survives a removal for something it never saw enqueued", () => {
    // The window shows the last 20 turns, so an older enqueue is simply absent.
    // Under-reporting is the safe direction for a list claiming work is waiting.
    expect(queuedPrompts([meta("unqueued", "from before the window")])).toEqual([]);
    expect(queuedPrompts([meta("dequeued")])).toEqual([]);
  });

  it("keeps the order they were queued in", () => {
    expect(
      queuedPrompts([
        meta("queued", "one"),
        meta("queued", "two"),
        meta("queued", "three"),
        meta("unqueued", "two"),
      ]),
    ).toEqual(["one", "three"]);
  });

  it("ignores the ordinary conversation around it", () => {
    expect(
      queuedPrompts([user("something said"), meta("queued", "waiting"), user("something else")]),
    ).toEqual(["waiting"]);
  });
});

describe("the harness's own notices", () => {
  it("does not call a background task notification a queued message", () => {
    // Two of the three Viktor saw were these: the harness telling Claude a
    // background job finished. Nobody queued it and nobody is waiting on it,
    // and it renders as a wall of XML.
    const notice =
      "<task-notification>\n<task-id>bds2sa23b</task-id>\n<tool-use-id>toolu_01X8</tool-use-id>";
    expect(queuedPrompts([meta("queued", notice), meta("queued", "a real one")])).toEqual([
      "a real one",
    ]);
  });

  it("drops a system reminder too", () => {
    expect(queuedPrompts([meta("queued", "<system-reminder>context</system-reminder>")])).toEqual(
      [],
    );
  });

  it("keeps a message that merely mentions one", () => {
    expect(queuedPrompts([meta("queued", "what is a <task-notification> anyway")])).toEqual([
      "what is a <task-notification> anyway",
    ]);
  });
});

/**
 * One message, drawn once.
 *
 * A prompt sent mid-turn shows at once as a pending bubble (withPendingPrompts)
 * and a moment later the CLI records it as queued, which the timeline draws as
 * a dashed ghost bubble at its end. Both are the same message, so the pending
 * one steps aside for the ghost (spec risk R6, 2026-09-24).
 */
describe("a pending prompt Claude has already queued", () => {
  const pending = (id: number, text: string): PendingPrompt => ({
    id: -id,
    text,
    at: id,
    command: false,
    afterId: 0,
  });

  it("is left out, since the queue draws it as a ghost", () => {
    const sent = [pending(1, "also check the phone"), pending(2, "and the tablet")];
    expect(withoutQueued(sent, ["also check the phone"]).map((p) => p.text)).toEqual([
      "and the tablet",
    ]);
  });

  it("matches on the trimmed text, as the queue records it", () => {
    expect(withoutQueued([pending(1, "  spaced out \n")], ["spaced out"])).toEqual([]);
  });

  // Two identical prompts with one of them queued are still two messages.
  it("lets one queued entry account for one prompt only", () => {
    const sent = [pending(1, "again"), pending(2, "again")];
    expect(withoutQueued(sent, ["again"]).map((p) => p.id)).toEqual([-2]);
  });

  it("returns the same list when nothing is queued, so the fold is reused", () => {
    const sent = [pending(1, "x")];
    expect(withoutQueued(sent, [])).toBe(sent);
  });
});
