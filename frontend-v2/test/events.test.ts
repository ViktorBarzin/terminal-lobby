import { describe, it, expect } from "vitest";
import { parseEvent } from "../src/types/events";

describe("parseEvent", () => {
  it("parses a full event, keeping only known fields", () => {
    const e = parseEvent(
      JSON.stringify({
        id: 42,
        kind: "tool_use",
        session: "demo",
        turnId: "t1",
        tool: "Bash",
        toolId: "tu_1",
        body: '{"command":"ls"}',
        isError: false,
        at: 1_700_000_000_000,
        junk: "ignored",
      }),
    );
    expect(e).toEqual({
      id: 42,
      kind: "tool_use",
      session: "demo",
      turnId: "t1",
      tool: "Bash",
      toolId: "tu_1",
      body: '{"command":"ls"}',
      isError: false,
      at: 1_700_000_000_000,
    });
  });

  it("rejects malformed / non-conforming payloads", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent(JSON.stringify({ id: "x", kind: "text", session: "s" }))).toBeNull();
    expect(parseEvent(JSON.stringify({ id: 1, kind: "nope", session: "s" }))).toBeNull();
    expect(parseEvent(JSON.stringify({ id: 1, kind: "text" }))).toBeNull(); // no session
  });

  it("accepts a minimal event", () => {
    expect(parseEvent(JSON.stringify({ id: 1, kind: "turn_end", session: "s" }))).toEqual({
      id: 1,
      kind: "turn_end",
      session: "s",
    });
  });
});
