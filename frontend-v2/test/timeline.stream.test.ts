/**
 * A reply still being written, in the row derivation (ADR-0036). The stream's
 * stand-ins become ordinary message and thinking rows marked `streaming`, at
 * the end of the open turn, and the live group says nothing generic beside
 * them: the growing reply is itself what shows the turn is moving.
 */
import { describe, it, expect } from "vitest";
import {
  deriveRows,
  liveGroupState,
  liveRow,
  type TimelineRow,
} from "../src/components/timeline.logic";
import { NO_STREAM, applyDelta, streamId, withStreaming } from "../src/store/stream";
import type { Event, StreamDelta } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const delta = (body: string, over: Partial<StreamDelta> = {}): StreamDelta => ({
  kind: "delta",
  session: "s",
  turnId: "t1",
  stream: "text",
  block: 0,
  body,
  ...over,
});

const drawn = (rows: TimelineRow[]) => rows.filter((r) => r.kind !== "working");

const prompt = ev({ id: 1, kind: "user", body: "What is 2+2?", at: 1_000 });

describe("streaming rows", () => {
  it("draws the streamed text as the open turn's last message", () => {
    const s = applyDelta(NO_STREAM, delta("It is"));
    const rows = deriveRows(withStreaming([prompt], s));
    const last = drawn(rows).at(-1)!;
    expect(last).toMatchObject({
      kind: "message",
      streaming: true,
      key: `msg-${streamId({ stream: "text", block: 0 })}`,
    });
    // Still one open turn: the stand-in joined the prompt's turn.
    expect(rows.filter((r) => r.kind === "user")).toHaveLength(1);
    expect(liveRow(rows)).toBeDefined();
  });

  it("keeps the row's key while the block grows", () => {
    const a = applyDelta(NO_STREAM, delta("It"));
    const b = applyDelta(a, delta(" is 4."));
    const keyOf = (rows: TimelineRow[]) => drawn(rows).at(-1)!.key;
    expect(keyOf(deriveRows(withStreaming([prompt], a)))).toBe(
      keyOf(deriveRows(withStreaming([prompt], b))),
    );
  });

  it("joins a turn whose stored events carry the server's own turn id", () => {
    const events = [ev({ ...prompt, turnId: "srv-9" })];
    const rows = deriveRows(withStreaming(events, applyDelta(NO_STREAM, delta("x"))));
    expect(drawn(rows).map((r) => r.turnKey)).toEqual(["srv-9", "srv-9"]);
  });
});

describe("the live group beside a streaming reply", () => {
  it("says the turn is streaming text, which draws no generic row", () => {
    const rows = deriveRows(withStreaming([prompt], applyDelta(NO_STREAM, delta("It is"))));
    const state = liveGroupState({ live: liveRow(rows), last: drawn(rows).at(-1) });
    expect(state).toMatchObject({ kind: "working", streaming: "text" });
  });

  it("says the turn is thinking while thinking streams on its own", () => {
    const s = applyDelta(NO_STREAM, delta("Let me see", { stream: "thinking" }));
    const rows = deriveRows(withStreaming([prompt], s));
    expect(drawn(rows).at(-1)).toMatchObject({ kind: "thinking", streaming: true });
    const state = liveGroupState({ live: liveRow(rows), last: drawn(rows).at(-1) });
    expect(state).toMatchObject({ kind: "working", streaming: "thinking" });
  });

  it("lets the running group say Claude is thinking between calls", () => {
    const events = [
      prompt,
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Bash",
        toolId: "b1",
        body: JSON.stringify({ command: "ls" }),
        at: 2_000,
      }),
      ev({ id: 3, kind: "tool_result", toolId: "b1", body: "a\nb", at: 3_000 }),
    ];
    const s = applyDelta(NO_STREAM, delta("Two files", { stream: "thinking" }));
    const rows = deriveRows(withStreaming(events, s));
    const last = drawn(rows).at(-1)!;
    expect(last.kind).toBe("work-group");
    const state = liveGroupState({ live: liveRow(rows), last });
    expect(state).toMatchObject({ kind: "working", streaming: "thinking", groupKey: last.key });
  });

  it("is unchanged once the stored reply has replaced the stream", () => {
    const events = [prompt, ev({ id: 2, kind: "text", body: "It is 4.", at: 2_000 })];
    const rows = deriveRows(events);
    const state = liveGroupState({ live: liveRow(rows), last: drawn(rows).at(-1) });
    expect(state).toEqual({ kind: "working", done: 0, since: 1_000 });
  });
});

// A background agent finishing makes the main thread reply with no prompt to
// open its turn, so the reply streams while the last turn on screen is one that
// already ended. Joining that turn drew the words inside its settled group
// ("Ran 1 agent, wrote 1 reply"), then the stored row opened a turn of its own
// and they jumped there, with a working row flashing between (2026-10-03).
describe("a reply streamed after the turn ended", () => {
  const settled = [
    ev({ id: 1, kind: "user", body: "launch it", turnId: "t1", at: 1_000 }),
    ev({ id: 2, kind: "tool_use", tool: "Agent", toolId: "a1", body: "{}", turnId: "t1" }),
    ev({ id: 3, kind: "tool_result", toolId: "a1", body: "launched", turnId: "t1" }),
    ev({ id: 4, kind: "text", body: "LAUNCHED", turnId: "t1" }),
    ev({ id: 5, kind: "turn_end", turnId: "t1" }),
    ev({ id: 6, kind: "state", body: 'Agent "probe" finished', turnId: "t1" }),
  ];
  const ofTurn = (rows: TimelineRow[], key: string) =>
    JSON.stringify(rows.filter((r) => r.kind !== "working" && r.turnKey === key));

  it("opens a turn of its own instead of joining the ended one", () => {
    const before = deriveRows(settled);
    const streaming = deriveRows(withStreaming(settled, applyDelta(NO_STREAM, delta("DONE"))));
    expect(ofTurn(streaming, "t1")).toBe(ofTurn(before, "t1"));
    const last = drawn(streaming).at(-1)!;
    expect(last).toMatchObject({ kind: "message", streaming: true });
    expect(last.turnKey).not.toBe("t1");
  });

  it("leaves the ended turn alone when the stored reply lands", () => {
    const before = deriveRows(settled);
    const stored = [
      ...settled,
      ev({ id: 7, kind: "text", body: "DONE", turnId: "t2" }),
      ev({ id: 8, kind: "turn_end", turnId: "t2" }),
    ];
    expect(ofTurn(deriveRows(stored), "t1")).toBe(ofTurn(before, "t1"));
  });

  it("still joins an open turn whose last event is a subagent's", () => {
    const open = [
      ev({ id: 1, kind: "user", body: "go", turnId: "t1" }),
      ev({ id: 2, kind: "turn_end", turnId: "t0" }),
      ev({ id: 3, kind: "text", body: "inner", turnId: "t1", sidechain: true, agentId: "x" }),
    ].filter((e) => e.id !== 2);
    const rows = deriveRows(withStreaming(open, applyDelta(NO_STREAM, delta("main"))));
    expect(drawn(rows).at(-1)!.turnKey).toBe("t1");
  });
});
