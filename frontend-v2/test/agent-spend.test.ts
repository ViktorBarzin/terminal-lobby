import { describe, it, expect } from "vitest";
import { agentSpendUrl, appendActAs } from "../src/lib/config";
import {
  capitalizeFirst,
  claudeWindowLabel,
  formatResetsIn,
  formatTokens,
  formatUsd,
  liveWindows,
  sidebarFigure,
  type AgentSpend,
  type CodexWindow,
} from "../src/lib/agent-spend";

/**
 * The arithmetic and wording the spend page is built from, away from the DOM.
 * The page test asserts what a person sees; these pin down the pieces it uses,
 * including the two that are easy to get subtly wrong: a figure under a cent
 * must not read as free, and a window whose reset has passed must not be shown
 * as current.
 */

describe("agentSpendUrl", () => {
  it("rides the tmux-api prefix and names the period", () => {
    expect(agentSpendUrl("today")).toBe("/api/sessions/agent-spend?period=today");
    expect(agentSpendUrl("7d")).toBe("/api/sessions/agent-spend?period=7d");
  });

  it("keeps the act-as target alongside the period, not instead of it", () => {
    // apiUrl appends `?as=` itself in a switched tab; the period is already on
    // the URL by then, so the join has to be an `&`.
    expect(appendActAs(agentSpendUrl("month"), "emo")).toBe(
      "/api/sessions/agent-spend?period=month&as=emo",
    );
  });
});

describe("formatUsd", () => {
  it.each([
    [4.12, "$4.12"],
    [0.329, "$0.33"],
    [19.4, "$19.40"],
    [0, "$0.00"],
    [0.004, "<$0.01"],
  ])("renders %s as %s", (usd, want) => {
    expect(formatUsd(usd)).toBe(want);
  });
});

describe("formatTokens", () => {
  it.each([
    [5, "5"],
    [999, "999"],
    [20529, "21k"],
    [937477, "937k"],
    [1_250_000, "1.3M"],
  ])("renders %s as %s", (n, want) => {
    expect(formatTokens(n)).toBe(want);
  });
});

describe("claudeWindowLabel", () => {
  it.each([
    ["five_hour", "5-hour limit"],
    ["seven_day", "Weekly limit"],
    ["spend_limit", "Spend limit"],
  ])("names %s", (key, want) => {
    expect(claudeWindowLabel(key)).toBe(want);
  });

  it("spells out a window this build has never seen", () => {
    expect(claudeWindowLabel("thirty_day")).toBe("thirty day");
  });
});

describe("capitalizeFirst", () => {
  it("lifts the first letter and leaves the rest of the words alone", () => {
    expect(capitalizeFirst("weekly limit")).toBe("Weekly limit");
    expect(capitalizeFirst("5-hour limit")).toBe("5-hour limit");
    expect(capitalizeFirst("")).toBe("");
  });
});

describe("liveWindows", () => {
  const now = 1_788_730_000_000; // ms

  it("keeps a window whose reset is still ahead", () => {
    const kept = liveWindows([{ resetsAtSec: 1_788_730_052 }], now);
    expect(kept).toHaveLength(1);
  });

  it("drops one whose reset has passed, because that window started over", () => {
    expect(liveWindows([{ resetsAtSec: 1_788_729_000 }], now)).toEqual([]);
  });

  it("keeps a window that named no reset, which cannot be judged", () => {
    expect(liveWindows([{ usedPercent: 3, resetsAtSec: undefined }], now)).toHaveLength(1);
  });

  it("treats an absent list as no windows", () => {
    expect(liveWindows(undefined, now)).toEqual([]);
  });
});

describe("formatResetsIn", () => {
  const now = 1_788_730_000_000;
  const inSecs = (s: number) => Math.floor(now / 1000) + s;

  it.each([
    [30 * 60, "resets in 30m"],
    [2 * 3600, "resets in 2h"],
    [2 * 3600 + 14 * 60, "resets in 2h 14m"],
    [3 * 86400, "resets in 3d"],
  ])("describes %s seconds ahead as %s", (ahead, want) => {
    expect(formatResetsIn(inSecs(ahead), now)).toBe(want);
  });

  it("says nothing when there is no reset, or it has gone", () => {
    expect(formatResetsIn(undefined, now)).toBe("");
    expect(formatResetsIn(inSecs(-60), now)).toBe("");
  });
});

/**
 * The one figure the sidebar footer has room for. It follows the attached
 * session's tool because that is the number the person is currently spending:
 * dollars for Claude Code, which computes them, and the tighter of the two
 * limits for Codex, which reports no dollars at all.
 */
describe("sidebarFigure", () => {
  const now = 1_788_730_000_000;
  const soon = Math.floor(now / 1000) + 3600;
  const gone = Math.floor(now / 1000) - 60;

  const claudeDoc = (costUsd: number): AgentSpend => ({
    period: "today",
    claude: {
      costUsd,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      models: [],
      sessions: [],
    },
  });
  const codexDoc = (windows: CodexWindow[]): AgentSpend => ({
    period: "today",
    codex: { windows, sessions: [] },
  });
  const win = (usedPercent: number, resetsAtSec?: number): CodexWindow => ({
    label: "5-hour limit",
    windowMinutes: 300,
    usedPercent,
    resetsAtSec,
  });

  it("gives a Claude session today's spend, in dollars", () => {
    expect(sidebarFigure("claude", claudeDoc(4.12), now)).toBe("$4.12");
  });

  it("says a fraction of a cent is not nothing", () => {
    expect(sidebarFigure("claude", claudeDoc(0.004), now)).toBe("<$0.01");
  });

  it("gives a Codex session the TIGHTER of its two windows", () => {
    const doc = codexDoc([
      win(4, soon),
      { label: "weekly limit", windowMinutes: 10080, usedPercent: 31, resetsAtSec: soon },
    ]);
    expect(sidebarFigure("codex", doc, now)).toBe("31%");
  });

  it("ignores a Codex window that has already reset", () => {
    const doc = codexDoc([win(80, gone), { ...win(12, soon), label: "weekly limit" }]);
    expect(sidebarFigure("codex", doc, now)).toBe("12%");
  });

  it.each([
    ["a Claude document", claudeDoc(4.12)],
    ["a Codex document", codexDoc([win(31, soon)])],
  ] as const)("shows nothing for a shell session holding %s", (_what, doc) => {
    expect(sidebarFigure("shell", doc, now)).toBe("");
  });

  it("shows nothing when nothing is attached", () => {
    expect(sidebarFigure(undefined, claudeDoc(4.12), now)).toBe("");
  });

  it("shows nothing before the first read, or when that tool has no section", () => {
    expect(sidebarFigure("claude", null, now)).toBe("");
    expect(sidebarFigure("claude", codexDoc([win(31, soon)]), now)).toBe("");
    expect(sidebarFigure("codex", claudeDoc(4.12), now)).toBe("");
  });

  it("shows nothing for a Codex account whose windows have all gone", () => {
    expect(sidebarFigure("codex", codexDoc([win(80, gone)]), now)).toBe("");
    expect(sidebarFigure("codex", codexDoc([]), now)).toBe("");
  });

  it("rounds a percentage rather than carrying its decimal into three characters", () => {
    expect(sidebarFigure("codex", codexDoc([win(2.4, soon)]), now)).toBe("2%");
    expect(sidebarFigure("codex", codexDoc([win(99.6, soon)]), now)).toBe("100%");
  });
});
