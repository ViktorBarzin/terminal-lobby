import { describe, expect, it } from "vitest";

import {
  parseLobbyEvent,
  parseReadyFrame,
  parseSessionState,
  SseParser,
} from "../src/lobby/wire.ts";

describe("SseParser", () => {
  it("splits named frames, ids and default message frames", () => {
    const parser = new SseParser();
    const frames = parser.feed(
      'event: state\ndata: {"at":1}\n\nid: 18\ndata: {"id":18}\n\ndata: {"kind":"delta"}\n\n',
    );
    expect(frames).toEqual([
      { event: "state", data: '{"at":1}' },
      { event: "message", data: '{"id":18}', id: "18" },
      { event: "message", data: '{"kind":"delta"}' },
    ]);
  });

  it("holds a frame split across chunks until its blank line", () => {
    const parser = new SseParser();
    expect(parser.feed("event: rea")).toEqual([]);
    expect(parser.feed('dy\ndata: {"head":3')).toEqual([]);
    expect(parser.feed("}\n\n")).toEqual([{ event: "ready", data: '{"head":3}' }]);
  });

  it("ignores comments and joins multi-line data", () => {
    const parser = new SseParser();
    expect(parser.feed(": hb\n\ndata: a\ndata: b\n\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("accepts CRLF line endings", () => {
    const parser = new SseParser();
    expect(parser.feed("event: nomod\r\ndata: {}\r\n\r\n")).toEqual([
      { event: "nomod", data: "{}" },
    ]);
  });
});

describe("parseLobbyEvent", () => {
  it("reads a stored event with its optional fields", () => {
    const event = parseLobbyEvent(
      '{"id":19,"kind":"tool_use","session":"s","turnId":"t2","body":"{}","tool":"Bash","toolId":"toolu_1","at":5}',
    );
    expect(event).toEqual({
      id: 19,
      kind: "tool_use",
      session: "s",
      turnId: "t2",
      body: "{}",
      tool: "Bash",
      toolId: "toolu_1",
      at: 5,
    });
  });

  it("reads a delta, which carries id 0 and a stream", () => {
    const event = parseLobbyEvent(
      '{"id":0,"kind":"delta","session":"s","turnId":"t2","body":"Hi","stream":"text","block":1}',
    );
    expect(event).toMatchObject({ kind: "delta", stream: "text", block: 1, body: "Hi" });
  });

  it("refuses anything that is not an event", () => {
    expect(parseLobbyEvent("not json")).toBeUndefined();
    expect(parseLobbyEvent('{"kind":"text"}')).toBeUndefined();
    expect(parseLobbyEvent("[1]")).toBeUndefined();
  });
});

describe("frames", () => {
  it("reads the session state, defaulting missing lists", () => {
    expect(parseSessionState('{"at":17,"mode":"manual","model":{"model":"m"}}')).toEqual({
      at: 17,
      mode: "manual",
      model: { model: "m" },
      queue: [],
      prompts: [],
    });
  });

  it("reads the ready frame", () => {
    expect(parseReadyFrame('{"cursor":0,"head":17,"epoch":"e1"}')).toEqual({
      cursor: 0,
      head: 17,
      epoch: "e1",
    });
    expect(parseReadyFrame('{"head":3}')).toEqual({ head: 3 });
  });
});
