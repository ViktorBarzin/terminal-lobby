import { describe, expect, it } from "vitest";
import {
  breakdown,
  contextState,
  contextTone,
  formatTokens,
  percentFull,
  readingAge,
} from "../src/components/context.logic";
import type { ContextReading, Event } from "../src/types/events";

let nextId = 1;
function ev(e: Partial<Event>): Event {
  return { id: nextId++, kind: "text", session: "demo", ...e } as Event;
}

function reading(over: Partial<ContextReading> = {}): ContextReading {
  return {
    model: "claude-opus-5",
    usedTokens: 65_200,
    maxTokens: 1_000_000,
    percent: 7,
    categories: [
      { name: "System prompt", tokens: 3_500, percent: 0.4 },
      { name: "MCP tools (deferred)", tokens: 95_300, percent: 9.5 },
      { name: "Messages", tokens: 25_800, percent: 2.6 },
      { name: "Free space", tokens: 934_800, percent: 93.5 },
    ],
    ...over,
  };
}

describe("contextState", () => {
  it("is null when the session has no reading", () => {
    expect(contextState([ev({ kind: "text", body: "hi" })])).toBeNull();
  });

  it("takes the NEWEST reading, since the server refreshes each settled turn", () => {
    const got = contextState([
      ev({ kind: "meta", meta: "context", context: reading({ usedTokens: 10_000 }) }),
      ev({ kind: "turn_end" }),
      ev({ kind: "meta", meta: "context", context: reading({ usedTokens: 90_000 }) }),
    ]);
    expect(got?.reading.usedTokens).toBe(90_000);
  });

  it("counts settled turns since the reading, so the chip can say how stale it is", () => {
    const got = contextState([
      ev({ kind: "meta", meta: "context", context: reading() }),
      ev({ kind: "turn_end" }),
      ev({ kind: "text", body: "work" }),
      ev({ kind: "turn_end" }),
    ]);
    expect(got?.turnsAgo).toBe(2);
  });

  it("is current when nothing has settled since", () => {
    const got = contextState([
      ev({ kind: "turn_end" }),
      ev({ kind: "meta", meta: "context", context: reading() }),
    ]);
    expect(got?.turnsAgo).toBe(0);
  });

  it("ignores a meta event that carries no reading", () => {
    expect(contextState([ev({ kind: "meta", meta: "context" })])).toBeNull();
  });
});

describe("formatTokens", () => {
  // The chip should read the way the pane reads, so the two never look like
  // they disagree.
  it.each([
    [0, "0"],
    [71, "71"],
    [3_500, "3.5k"],
    [18_000, "18k"],
    [65_200, "65.2k"],
    [934_800, "934.8k"],
    [1_000_000, "1m"],
    [1_200_000, "1.2m"],
  ])("formats %i as %s", (n, want) => {
    expect(formatTokens(n)).toBe(want);
  });
});

describe("percentFull", () => {
  it("uses the percentage the CLI published", () => {
    expect(percentFull(reading({ percent: 7 }))).toBe(7);
  });

  it("falls back to the ratio when the CLI published no percentage", () => {
    expect(percentFull(reading({ percent: 0, usedTokens: 500_000, maxTokens: 1_000_000 }))).toBe(50);
  });

  // A session that has begun is never shown as 0% — that reads as "no session".
  it("floors a started session at 1%", () => {
    expect(percentFull(reading({ percent: 0, usedTokens: 100, maxTokens: 1_000_000 }))).toBe(1);
    expect(percentFull(reading({ percent: 0.4 }))).toBe(1);
  });

  it("is 0 when nothing is known", () => {
    expect(percentFull(reading({ percent: 0, usedTokens: 0, maxTokens: 0 }))).toBe(0);
  });
});

describe("contextTone", () => {
  it.each([
    [7, "ok"],
    [69, "ok"],
    [70, "warn"],
    [89, "warn"],
    [90, "full"],
    [99, "full"],
  ])("reads %i%% as %s", (percent, want) => {
    expect(contextTone(reading({ percent }))).toBe(want);
  });
});

describe("readingAge", () => {
  it.each([
    [0, "just now"],
    [1, "1 turn ago"],
    [4, "4 turns ago"],
  ])("describes %i turns as %s", (n, want) => {
    expect(readingAge(n)).toBe(want);
  });
});

describe("breakdown", () => {
  it("drops Free space, which is just the meter inverted", () => {
    expect(breakdown(reading())!.map((c) => c.name)).not.toContain("Free space");
  });

  it("sorts largest first, so what is eating the context is at the top", () => {
    expect(breakdown(reading())!.map((c) => c.name)).toEqual([
      "MCP tools (deferred)",
      "Messages",
      "System prompt",
    ]);
  });

  it("drops empty categories rather than listing zeroes", () => {
    const got = breakdown(
      reading({ categories: [{ name: "Custom agents", tokens: 0, percent: 0 }] }),
    );
    expect(got).toEqual([]);
  });

  it("survives a reading with no category table", () => {
    expect(breakdown(reading({ categories: undefined }))).toEqual([]);
  });
});
