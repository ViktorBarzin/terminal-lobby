/**
 * tl.cause on text.blank: one field that says why a view is blank, so telling
 * the expected blanks from the broken ones is a one-line query.
 */
import { describe, it, expect } from "vitest";
import { blankCause, type BlankFacts } from "../src/telemetry/blank";

const base: BlankFacts = {
  tool: "claude",
  sse: "open",
  starting: false,
  noMod: false,
  exited: false,
  ready: 0,
  events: 0,
};

describe("blankCause", () => {
  it.each<[string, Partial<BlankFacts>, string]>([
    ["a plain shell", { tool: "shell", sse: "no-transcript" }, "shell"],
    ["any other session with no stream", { tool: "codex", sse: "no-transcript" }, "no-stream"],
    ["a Claude that exited", { noMod: true, exited: true }, "exited"],
    ["a Claude from before the mod", { noMod: true }, "nomod"],
    ["a Claude still starting", { starting: true }, "starting"],
    ["events held but none drawn", { events: 12, ready: 1 }, "not-drawn"],
    ["a window that came back empty", { ready: 1 }, "empty"],
    ["nothing arrived yet", {}, "not-arrived"],
    ["nothing arrived on a stream still connecting", { sse: "connecting" }, "not-arrived"],
  ])("%s", (_, over, want) => {
    expect(blankCause({ ...base, ...over })).toBe(want);
  });
});
