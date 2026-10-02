/**
 * The reply as it is written: `delta` frames the mod forwards from Claude
 * Code's `turn.step`, held per content block until the stored row that
 * supersedes them arrives (ADR-0036).
 */
import { describe, it, expect } from "vitest";
import {
  NO_STREAM,
  afterEvent,
  applyDelta,
  sameShape,
  streamBody,
  streamEvents,
  streamId,
  withStreaming,
  type StreamState,
} from "../src/store/stream";
import type { Event, StreamDelta } from "../src/types/events";

const delta = (body: string, over: Partial<StreamDelta> = {}): StreamDelta => ({
  kind: "delta",
  session: "s",
  turnId: "t1",
  stream: "text",
  block: 0,
  body,
  ...over,
});

const event = (kind: Event["kind"], over: Partial<Event> = {}): Event => ({
  id: 10,
  kind,
  session: "s",
  ...over,
});

const fold = (...ds: StreamDelta[]): StreamState => ds.reduce(applyDelta, NO_STREAM);

describe("applyDelta", () => {
  it("appends each delta to its block", () => {
    const s = fold(delta("Hello"), delta(", "), delta("world"));
    expect(s.turnId).toBe("t1");
    expect(s.blocks).toEqual([{ stream: "text", block: 0, body: "Hello, world" }]);
  });

  it("keeps thinking and text apart, in block order", () => {
    const s = fold(
      delta("weighing", { stream: "thinking", block: 0 }),
      delta("The answer", { block: 1 }),
      delta(" it", { stream: "thinking", block: 0 }),
      delta(" is 4.", { block: 1 }),
    );
    expect(s.blocks).toEqual([
      { stream: "thinking", block: 0, body: "weighing it" },
      { stream: "text", block: 1, body: "The answer is 4." },
    ]);
  });

  it("places a block by its index even when it arrives first", () => {
    const s = fold(delta("b", { block: 2 }), delta("a", { stream: "thinking", block: 1 }));
    expect(s.blocks.map((b) => b.block)).toEqual([1, 2]);
  });

  it("starts again when a new turn begins", () => {
    const s = fold(delta("old"), delta("new", { turnId: "t2" }));
    expect(s).toEqual({ turnId: "t2", blocks: [{ stream: "text", block: 0, body: "new" }] });
  });

  it("ignores a subagent's deltas", () => {
    const s = fold(delta("main"), delta(" agent", { agentId: "a1" }));
    expect(s.blocks[0]!.body).toBe("main");
    expect(applyDelta(NO_STREAM, delta("x", { agentId: "a1" }))).toBe(NO_STREAM);
  });

  it("ignores an empty delta without allocating", () => {
    const s = fold(delta("a"));
    expect(applyDelta(s, delta(""))).toBe(s);
  });
});

describe("afterEvent", () => {
  const both = fold(delta("hmm", { stream: "thinking", block: 0 }), delta("Answer", { block: 1 }));

  it("drops the streamed text once the stored text lands", () => {
    expect(afterEvent(both, event("text")).blocks).toEqual([
      { stream: "thinking", block: 0, body: "hmm" },
    ]);
  });

  it("drops the streamed thinking once the stored thinking lands", () => {
    expect(afterEvent(both, event("thinking")).blocks).toEqual([
      { stream: "text", block: 1, body: "Answer" },
    ]);
  });

  it("drops everything on a tool call: the response's blocks are over", () => {
    expect(afterEvent(both, event("tool_use")).blocks).toEqual([]);
  });

  it("drops everything when the turn ends", () => {
    expect(afterEvent(both, event("turn_end", { turnId: "t1" }))).toBe(NO_STREAM);
    // The stored log's turn ids need not be the mod's: a main-thread turn end
    // closes the one open turn either way.
    expect(afterEvent(both, event("turn_end"))).toBe(NO_STREAM);
  });

  it("leaves the stream alone for a subagent's records", () => {
    expect(afterEvent(both, event("text", { agentId: "a1" }))).toBe(both);
    expect(afterEvent(both, event("text", { sidechain: true }))).toBe(both);
    expect(afterEvent(both, event("turn_end", { agentId: "a1" }))).toBe(both);
  });

  it("returns the state itself when nothing changes", () => {
    expect(afterEvent(both, event("user"))).toBe(both);
    expect(afterEvent(NO_STREAM, event("text"))).toBe(NO_STREAM);
  });
});

describe("streamEvents / withStreaming", () => {
  const s = fold(delta("hmm", { stream: "thinking", block: 0 }), delta("Answer", { block: 1 }));

  it("stands one event in for each block, marked as streaming", () => {
    const out = streamEvents(s, "s");
    expect(out.map((e) => [e.kind, e.streaming])).toEqual([
      ["thinking", true],
      ["text", true],
    ]);
    // Ids are stable per block, so a growing block keeps its row.
    expect(out[1]!.id).toBe(streamId({ stream: "text", block: 1 }));
    expect(out.every((e) => e.id < 0 && e.turnId === undefined)).toBe(true);
  });

  it("appends them after the stored events, and is a no-op with nothing streaming", () => {
    const events = [event("user", { id: 1, body: "q" })];
    expect(withStreaming(events, NO_STREAM)).toBe(events);
    const out = withStreaming(events, s);
    expect(out.map((e) => e.kind)).toEqual(["user", "thinking", "text"]);
  });

  it("reads a block's body back by its stand-in id", () => {
    expect(streamBody(s, streamId({ stream: "text", block: 1 }))).toBe("Answer");
    expect(streamBody(s, streamId({ stream: "text", block: 7 }))).toBe("");
  });

  it("never collides with a pending prompt's negative id", () => {
    expect(streamId({ stream: "text", block: 0 })).toBeLessThan(-1_000_000);
    expect(streamId({ stream: "text", block: 0 })).not.toBe(
      streamId({ stream: "thinking", block: 0 }),
    );
  });
});

describe("sameShape", () => {
  it("ignores body growth and sees a new block", () => {
    const a = fold(delta("Hel"));
    const b = applyDelta(a, delta("lo"));
    expect(sameShape(a, b)).toBe(true);
    expect(sameShape(b, applyDelta(b, delta("x", { block: 1 })))).toBe(false);
    expect(sameShape(b, NO_STREAM)).toBe(false);
  });
});
