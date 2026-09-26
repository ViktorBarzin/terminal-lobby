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

  // The stream is the only way a picture reference reaches the page, so a
  // field parseEvent does not copy is a picture that never draws. Found by the
  // 2026-09-26 desktop check: the bubble kept `[Image #2]` and every Read row
  // had no thumbnail, while the route answered 200.
  it("keeps the picture references a pasted prompt carries", () => {
    const e = parseEvent(
      JSON.stringify({
        id: 40,
        kind: "user",
        session: "s",
        body: "[Image #2] what colour?",
        images: [{ n: 0, mediaType: "image/png", bytes: 9842, paste: 2 }],
        record: "60122def-7776-4e6a-aac9-4ae3db3c37d0",
      }),
    );
    expect(e?.images).toEqual([{ n: 0, mediaType: "image/png", bytes: 9842, paste: 2 }]);
    expect(e?.record).toBe("60122def-7776-4e6a-aac9-4ae3db3c37d0");
  });

  it("keeps a tool result's image blocks and screenshot files", () => {
    const e = parseEvent(
      JSON.stringify({
        id: 30,
        kind: "tool_result",
        session: "s",
        toolId: "toolu_1",
        images: [{ n: 0 }, { n: 2, mediaType: "image/jpeg" }],
        files: ["/home/wizard/shots/a.png"],
      }),
    );
    expect(e?.images).toEqual([{ n: 0 }, { n: 2, mediaType: "image/jpeg" }]);
    expect(e?.files).toEqual(["/home/wizard/shots/a.png"]);
  });

  it("drops picture references it cannot use", () => {
    const e = parseEvent(
      JSON.stringify({
        id: 30,
        kind: "tool_result",
        session: "s",
        images: [{ n: "0" }, null, { n: 1, mediaType: 7, bytes: "x", paste: "2", junk: true }],
        files: ["/a.png", 3, null],
        record: 12,
      }),
    );
    expect(e?.images).toEqual([{ n: 1 }]);
    expect(e?.files).toEqual(["/a.png"]);
    expect(e && "record" in e).toBe(false);
    const none = parseEvent(
      JSON.stringify({ id: 1, kind: "user", session: "s", images: "no", files: {} }),
    );
    expect(none && ("images" in none || "files" in none)).toBe(false);
  });

  it("keeps the agent a subagent's event belongs to", () => {
    const e = parseEvent(
      JSON.stringify({ id: 3, kind: "text", session: "s", sidechain: true, agentId: "a1b2" }),
    );
    expect(e).toEqual({ id: 3, kind: "text", session: "s", sidechain: true, agentId: "a1b2" });
    // Anything that is not a name is dropped, not carried.
    expect(parseEvent(JSON.stringify({ id: 4, kind: "text", session: "s", agentId: 7 }))).toEqual({
      id: 4,
      kind: "text",
      session: "s",
    });
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
