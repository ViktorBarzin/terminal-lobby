import { describe, it, expect } from "vitest";
import { ORIGIN_AUTO_CONTINUATION, parseEvent } from "../src/types/events";

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

  it("keeps origin and plan on the record that opens a conversation after a clear", () => {
    // sessionio sets both on ONE user event, the first record of the
    // conversation the plan approval started by clearing the context. Body
    // keeps the CLI's whole "Implement the following plan: ..." text.
    const e = parseEvent(
      JSON.stringify({
        id: 7,
        kind: "user",
        session: "s",
        body: "Implement the following plan:\n\n# Plan\n1. Do it.",
        origin: "auto-continuation",
        plan: "# Plan\n1. Do it.",
      }),
    );
    expect(e?.origin).toBe(ORIGIN_AUTO_CONTINUATION);
    expect(e?.plan).toBe("# Plan\n1. Do it.");
    expect(e?.body).toContain("Implement the following plan");
  });

  it("drops an origin or plan that is not a string", () => {
    const e = parseEvent(
      JSON.stringify({
        id: 8,
        kind: "user",
        session: "s",
        origin: { kind: "auto-continuation" },
        plan: 3,
      }),
    );
    expect(e).toEqual({ id: 8, kind: "user", session: "s" });
  });
});
