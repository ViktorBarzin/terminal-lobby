import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";
import type { AgentSpend } from "../src/lib/agent-spend";

/**
 * The Agent spend page: what a person opens to answer "what have my agents
 * cost me, and how close am I to a limit".
 *
 * The two tools answer different questions and the page says so. Claude Code
 * computes dollars; a ChatGPT plan reports none, so Codex is windows and
 * tokens. Each section renders only when the server sent it, which is what
 * keeps a Claude-only box from being shown an empty Codex heading.
 *
 * These assert what the page SAYS. The arithmetic behind the figures is the
 * server's, and tmux-api/agentspend_test.go holds it down.
 */

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

const hourFromNow = () => Math.floor(Date.now() / 1000) + 3600;
const hourAgo = () => Math.floor(Date.now() / 1000) - 3600;

const claudeOnly = (): AgentSpend => ({
  period: "today",
  claude: {
    costUsd: 4.12,
    tokens: { input: 58794, output: 12, cacheRead: 27254, cacheCreation: 31538 },
    models: [
      {
        model: "claude-opus-5",
        tokens: { input: 58794, output: 12, cacheRead: 27254, cacheCreation: 31538 },
        costUsd: 4.12,
      },
    ],
    sessions: [
      {
        sessionId: "abc-123",
        session: "kq3m2n8xr7vd",
        model: "claude-opus-5",
        tokens: { input: 58794, output: 12, cacheRead: 27254, cacheCreation: 31538 },
        costUsd: 4.12,
        lastSeenSec: hourAgo(),
      },
    ],
  },
});

const codexOnly = (): AgentSpend => ({
  period: "today",
  codex: {
    plan: "plus",
    windows: [
      { label: "5-hour limit", windowMinutes: 300, usedPercent: 2, resetsAtSec: hourFromNow() },
      { label: "weekly limit", windowMinutes: 10080, usedPercent: 4, resetsAtSec: hourFromNow() },
    ],
    sessions: [
      {
        sessionId: "rollout-9",
        session: "zz9p4b2q6yta",
        model: "gpt-5-codex",
        tokens: {
          input: 20529,
          cachedInput: 12160,
          cacheWriteInput: 0,
          output: 5,
          reasoningOutput: 0,
          total: 937477,
        },
        contextWindow: 258400,
        atSec: hourAgo(),
      },
    ],
  },
});

const both = (): AgentSpend => ({ ...claudeOnly(), ...codexOnly(), period: "today" });

/** Answers every request with one document, and records the URLs asked for. */
function stubSpend(doc: AgentSpend | ((url: string) => AgentSpend)): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = typeof doc === "function" ? doc(url) : doc;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return urls;
}

async function openPanel(titles?: Array<{ name: string; title?: string }>) {
  const utils = render(() => (
    <SettingsPanel
      prefs={fakePrefs()}
      onClose={() => {}}
      initialPage="spend"
      sessionTitles={titles ? () => titles : undefined}
    />
  ));
  await waitFor(() => expect(utils.container.querySelector(".tl-spend")).not.toBeNull());
  return utils;
}

const groups = (c: HTMLElement) =>
  [...c.querySelectorAll(".tl-set-group-title")].map((h) => h.textContent);
const meters = (c: HTMLElement) =>
  [...c.querySelectorAll(".tl-spend-meter")].map((m) => m.textContent ?? "");
const sessionRows = (c: HTMLElement) =>
  [...c.querySelectorAll(".tl-spend-session")].map((r) => r.textContent ?? "");
const periodButtons = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLButtonElement>(".tl-spend-period"),
];
const periodOn = (c: HTMLElement) =>
  periodButtons(c).find((b) => b.getAttribute("aria-checked") === "true")?.textContent;

beforeEach(() => localStorage.removeItem("tl:settings:page"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agent spend — the two sections", () => {
  it("gives each tool its own section when both have reported", async () => {
    stubSpend(both());
    const { container } = await openPanel();
    await waitFor(() => expect(groups(container)).toEqual(["Claude Code", "Codex"]));
  });

  it("leaves the Codex heading out entirely for a Claude-only box", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(groups(container)).toEqual(["Claude Code"]));
    expect(container.textContent).not.toContain("Codex");
  });

  it("leaves the Claude heading out entirely for a Codex-only box", async () => {
    stubSpend(codexOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(groups(container)).toEqual(["Codex"]));
    expect(container.textContent).not.toContain("Claude Code");
  });

  it("says so plainly when neither tool has reported anything", async () => {
    stubSpend({ period: "today" });
    const { container } = await openPanel();
    await waitFor(() => expect(container.textContent).toContain("Nothing has reported yet"));
    expect(groups(container)).toEqual([]);
  });

  it("says what went wrong rather than showing zeroes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const { container } = await openPanel();
    await waitFor(() => expect(container.textContent).toContain("Could not read"));
    expect(container.textContent).not.toContain("$0.00");
  });
});

describe("Agent spend — the Claude section", () => {
  it("leads with the spend for the period", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    await waitFor(() =>
      expect(container.querySelector(".tl-spend-figure")?.textContent).toContain("$4.12"),
    );
  });

  it("shows a window bar only when the seat reported one", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(container.querySelector(".tl-spend-figure")).not.toBeNull());
    // An enterprise seat carries no rate_limits, which is this box.
    expect(meters(container)).toEqual([]);
  });

  it("names the windows a Pro seat does report", async () => {
    const doc = claudeOnly();
    doc.claude!.windows = [
      { name: "five_hour", usedPercent: 41, resetsAtSec: hourFromNow() },
      { name: "seven_day", usedPercent: 12, resetsAtSec: hourFromNow() },
    ];
    stubSpend(doc);
    const { container } = await openPanel();
    await waitFor(() => expect(meters(container)).toHaveLength(2));
    expect(meters(container)[0]).toContain("5-hour limit");
    expect(meters(container)[0]).toContain("41%");
    expect(meters(container)[1]).toContain("Weekly limit");
  });

  it("drops a window whose reset has already passed", async () => {
    const doc = claudeOnly();
    doc.claude!.windows = [
      { name: "five_hour", usedPercent: 99, resetsAtSec: hourAgo() },
      { name: "seven_day", usedPercent: 12, resetsAtSec: hourFromNow() },
    ];
    stubSpend(doc);
    const { container } = await openPanel();
    // That reading describes a window that has since started over, so showing
    // it as current would report a limit the account is nowhere near.
    await waitFor(() => expect(meters(container)).toHaveLength(1));
    expect(meters(container)[0]).toContain("Weekly limit");
    expect(container.textContent).not.toContain("99%");
  });

  it("lists what each conversation cost", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(sessionRows(container)).toHaveLength(1));
    const row = sessionRows(container)[0]!;
    expect(row).toContain("$4.12");
    expect(row).toContain("claude-opus-5");
  });

  it("shows the title of a session it can name, and the id when it cannot", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel([{ name: "kq3m2n8xr7vd", title: "Spend panel" }]);
    await waitFor(() => expect(sessionRows(container)[0]).toContain("Spend panel"));
    cleanup();

    stubSpend(claudeOnly());
    const second = await openPanel();
    await waitFor(() => expect(sessionRows(second.container)[0]).toContain("kq3m2n8xr7vd"));
  });
});

describe("Agent spend — the Codex section", () => {
  it("uses OpenAI's own words for the two windows", async () => {
    stubSpend(codexOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(meters(container)).toHaveLength(2));
    expect(meters(container)[0]).toContain("5-hour limit");
    expect(meters(container)[1]).toContain("Weekly limit");
  });

  it("drops a Codex window whose reset has passed", async () => {
    const doc = codexOnly();
    doc.codex!.windows = [
      { label: "5-hour limit", windowMinutes: 300, usedPercent: 88, resetsAtSec: hourAgo() },
      {
        label: "weekly limit",
        windowMinutes: 10080,
        usedPercent: 4,
        resetsAtSec: hourFromNow(),
      },
    ];
    stubSpend(doc);
    const { container } = await openPanel();
    await waitFor(() => expect(meters(container)).toHaveLength(1));
    expect(container.textContent).not.toContain("88%");
  });

  it("names the plan", async () => {
    stubSpend(codexOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(container.textContent).toContain("Plus"));
  });

  it("shows a credit balance only when the account has one", async () => {
    stubSpend(codexOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(container.textContent).toContain("Plus"));
    expect(container.textContent).not.toContain("Credits");
    cleanup();

    const withCredits = codexOnly();
    withCredits.codex!.credits = { unlimited: false, balance: "12.50" };
    stubSpend(withCredits);
    const second = await openPanel();
    await waitFor(() => expect(second.container.textContent).toContain("Credits"));
    expect(second.container.textContent).toContain("12.50");
  });

  it("counts tokens and quotes no dollars, because the plan reports none", async () => {
    stubSpend(codexOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(sessionRows(container)).toHaveLength(1));
    const row = sessionRows(container)[0]!;
    expect(row).toContain("937k");
    expect(row).toContain("gpt-5-codex");
    expect(row).not.toContain("$");
  });
});

describe("Agent spend — the clock keeps running", () => {
  it("drops a window that resets while the panel is open", async () => {
    vi.useFakeTimers();
    try {
      const doc = codexOnly();
      doc.codex!.windows = [
        {
          label: "5-hour limit",
          windowMinutes: 300,
          usedPercent: 92,
          resetsAtSec: Math.floor(Date.now() / 1000) + 240,
        },
      ];
      stubSpend(doc);
      const { container } = render(() => (
        <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="spend" />
      ));
      await vi.waitFor(() => expect(meters(container)).toHaveLength(1));
      expect(meters(container)[0]).toContain("92%");

      // Nobody touches the panel; the window simply resets under it. Reporting
      // 92% of a limit the account has since been let off is the reading this
      // filter exists to stop.
      vi.advanceTimersByTime(90 * 60_000);
      await vi.waitFor(() => expect(meters(container)).toHaveLength(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the reset down as time passes", async () => {
    vi.useFakeTimers();
    try {
      const doc = codexOnly();
      doc.codex!.windows = [
        {
          label: "weekly limit",
          windowMinutes: 10080,
          usedPercent: 30,
          resetsAtSec: Math.floor(Date.now() / 1000) + 3 * 3600,
        },
      ];
      stubSpend(doc);
      const { container } = render(() => (
        <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="spend" />
      ));
      await vi.waitFor(() => expect(meters(container)[0]).toContain("resets in 3h"));
      vi.advanceTimersByTime(2 * 3600_000);
      await vi.waitFor(() => expect(meters(container)[0]).toContain("resets in 1h"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Agent spend — the period", () => {
  it("offers the four periods and starts on today", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    expect(periodButtons(container).map((b) => b.textContent)).toEqual([
      "Today",
      "7 days",
      "This month",
      "All time",
    ]);
    expect(periodOn(container)).toBe("Today");
  });

  it("asks the server for the period that was picked", async () => {
    const urls = stubSpend((url) =>
      url.includes("period=7d")
        ? { period: "7d", claude: { ...claudeOnly().claude!, costUsd: 19.4 } }
        : claudeOnly(),
    );
    const { container } = await openPanel();
    await waitFor(() => expect(urls[0]).toContain("period=today"));
    expect(urls[0]).toContain("/api/sessions/agent-spend");

    fireEvent.click(periodButtons(container).find((b) => b.textContent === "7 days")!);

    await waitFor(() =>
      expect(container.querySelector(".tl-spend-figure")?.textContent).toContain("$19.40"),
    );
    expect(urls.at(-1)).toContain("period=7d");
    expect(periodOn(container)).toBe("7 days");
  });

  it("ignores a slow answer for a period that is no longer selected", async () => {
    // All time walks every day row on the server and Today reads one, so the
    // two can land out of order. The figure has to match the period that is
    // checked, whichever response arrives last.
    const pending: Array<{ url: string; send: (doc: AgentSpend) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            pending.push({
              url: String(input),
              send: (doc) =>
                resolve(
                  new Response(JSON.stringify(doc), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  }),
                ),
            });
          }),
      ),
    );

    const { container } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="spend" />
    ));
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.send(claudeOnly());
    await waitFor(() =>
      expect(container.querySelector(".tl-spend-figure")?.textContent).toContain("$4.12"),
    );

    fireEvent.click(periodButtons(container).find((b) => b.textContent === "All time")!);
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.click(periodButtons(container).find((b) => b.textContent === "Today")!);
    await waitFor(() => expect(pending).toHaveLength(3));

    // Today answers first, All time afterwards.
    pending[2]!.send({ period: "today", claude: { ...claudeOnly().claude!, costUsd: 4.12 } });
    await waitFor(() =>
      expect(container.querySelector(".tl-spend-figure")?.textContent).toContain("$4.12"),
    );
    pending[1]!.send({ period: "all", claude: { ...claudeOnly().claude!, costUsd: 912.5 } });
    await new Promise((r) => setTimeout(r, 0));

    expect(periodOn(container)).toBe("Today");
    expect(container.querySelector(".tl-spend-figure")?.textContent).toContain("$4.12");
    expect(container.textContent).not.toContain("912.50");
  });
});

describe("Agent spend — how exact the figures are", () => {
  it("marks the token totals as approximate and says why", async () => {
    stubSpend(claudeOnly());
    const { container } = await openPanel();
    await waitFor(() => expect(container.querySelector(".tl-spend-figure")).not.toBeNull());
    // The dollars are Claude Code's own arithmetic. The tokens are not: a
    // compaction takes the context down, and the store rolls up differences.
    const figure = container.querySelector(".tl-spend-figure")!;
    expect(figure.querySelector(".tl-netusage-approx")).not.toBeNull();
    expect(container.textContent).toContain("Token counts are approximate");
    expect(figure.textContent).toContain("$4.12");
  });
});
