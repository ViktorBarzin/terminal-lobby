import { describe, expect, it } from "vitest";
import {
  contextState,
  contextSummary,
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

  it("takes the NEWEST reading, since a session may hold several", () => {
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

/**
 * Found live on 2026-09-27: the sheet had no context line in an ordinary
 * session, only after someone ran /context, while the session's own status
 * line showed 5% and then 9%. The CLI's status line works its figure out from
 * the last request's usage over the model's window, rounded
 * (input + cache writes + cache reads), so the sheet does the same from the
 * turn_end's usage, with the window the caller knows for the model.
 */
describe("contextState from the last turn's usage", () => {
  const usage = { input_tokens: 9, cache_creation_input_tokens: 40_012, cache_read_input_tokens: 80_479, output_tokens: 31 };

  it("reads the context off the turn that settled last when nobody ran /context", () => {
    const got = contextState(
      [ev({ kind: "user", body: "hi" }), ev({ kind: "turn_end", usage })],
      null,
      { model: "claude-opus-5-5", window: 1_000_000 },
    );
    expect(got?.reading).toEqual({
      model: "claude-opus-5-5",
      usedTokens: 120_500,
      maxTokens: 1_000_000,
      percent: 12,
    });
    expect(got?.turnsAgo).toBe(0);
  });

  it("draws nothing from usage when the model's window is not known", () => {
    expect(contextState([ev({ kind: "turn_end", usage })], null, { model: "gpt-5" })).toBeNull();
  });

  it("keeps a /context reading newer than the last turn", () => {
    const got = contextState(
      [ev({ kind: "turn_end", usage }), ev({ kind: "meta", meta: "context", context: reading() })],
      null,
      { model: "claude-opus-5", window: 1_000_000 },
    );
    expect(got?.reading.usedTokens).toBe(65_200);
  });

  it("prefers the turn's usage over an older /context reading, on its window", () => {
    const got = contextState(
      [
        ev({ kind: "meta", meta: "context", context: reading({ maxTokens: 400_000 }) }),
        ev({ kind: "turn_end", usage }),
      ],
      null,
      { model: "claude-opus-5" },
    );
    expect(got?.reading.usedTokens).toBe(120_500);
    expect(got?.reading.maxTokens).toBe(400_000);
    expect(got?.turnsAgo).toBe(0);
  });

  it("leaves a subagent's turn out, since its context is not the session's", () => {
    const got = contextState(
      [ev({ kind: "turn_end", usage, sidechain: true })],
      null,
      { model: "claude-opus-5-5", window: 1_000_000 },
    );
    expect(got).toBeNull();
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
    expect(percentFull(reading({ percent: 0, usedTokens: 500_000, maxTokens: 1_000_000 }))).toBe(
      50,
    );
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

/**
 * The model sheet shows context as one quiet line, "Context 42% used" (the T3
 * pass, 2026-09-27). The breakdown panel went with the dial; the numbers
 * behind the percentage, and how old the reading is, stay in the line's title.
 */
describe("contextSummary", () => {
  it("says the tokens, the model and the reading's age", () => {
    expect(contextSummary({ reading: reading(), turnsAgo: 0 })).toBe(
      "65.2k of 1m tokens on claude-opus-5, read just now",
    );
  });

  it("leaves the model out when the reading did not name one", () => {
    expect(contextSummary({ reading: reading({ model: "" }), turnsAgo: 3 })).toBe(
      "65.2k of 1m tokens, read 3 turns ago",
    );
  });
});
