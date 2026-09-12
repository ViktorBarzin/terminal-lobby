/**
 * The sixth row of the Right now panel — "This machine".
 *
 * The five rows above it are one line each: a dot, a label, a short phrase.
 * This one carries figures, a sentence and an hour of history, and the thing
 * most likely to be broken by a later edit is the part that keeps those two
 * shapes in the same table. So the assertions here are about what the row SAYS
 * rather than about how it is laid out, with two exceptions: the extra block
 * belongs to this row and to no other, and the row grows no repair button.
 *
 * Design: docs/plans/2026-09-12-machine-health-indicator-design.md, "The panel
 * row". Why it is amber at worst and why the sentence carries the depth:
 * docs/adr/0028-stall-time-says-the-box-is-busy.md.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { RightNow } from "../src/components/settings/RightNow";
import {
  SESSION_CHANNELS,
  machineChannel,
  worst,
  type Channel,
  type MachinePoint,
  type MachineReport,
} from "../src/diagnostics/status";
import type { ConnectionControl } from "../src/diagnostics/status-store";

/**
 * A quiet box, as tmux-api reports one. The numbers are this devvm's own
 * ordinary reading, so a fixture that drifts into nonsense is visible.
 */
const reading = (over: Partial<MachineReport> = {}): MachineReport => ({
  state: "working",
  worst: "io",
  cpuPct: 0.4,
  ioPct: 1.2,
  memPct: 0,
  load1: 0.9,
  nproc: 32,
  tier: "fine",
  memAvailableMb: 12920,
  memTotalMb: 32087,
  windowSeconds: 600,
  partialWindow: false,
  source: "psi",
  ...over,
});

/** An hour of the deciding pressure, as fractions of its own amber line. */
const points = (ofLimits: number[]): MachinePoint[] =>
  ofLimits.map((ofLimit, i) => ({
    at: 1_757_670_000 + i * 10,
    res: "io" as const,
    pct: ofLimit * 50,
    ofLimit,
  }));

/**
 * The five client channels healthy, and the machine as the REAL machineChannel
 * makes it. Hand-writing the sixth channel would let this file keep passing
 * after status.ts changed what a reading means.
 */
function channelsFor(report: MachineReport | null): Channel[] {
  const five = SESSION_CHANNELS.filter((id) => id !== "machine").map(
    (id): Channel => ({ id, state: "working", detail: "fine" }),
  );
  return [...five, machineChannel(report)];
}

function control(over: Partial<ConnectionControl> = {}): ConnectionControl {
  const channels = over.channels ?? (() => channelsFor(reading()));
  return {
    channels,
    log: () => [],
    lastCheck: () => ({}),
    checkedAt: () => null,
    checking: () => false,
    bootedAt: Date.now() - 120_000,
    worstNow: () => worst(channels()),
    runCheck: async () => {},
    repairLabel: () => null,
    repair: () => {},
    // The box's facts arrive through this object like every other row's, so a
    // fixture that leaves them out is a panel that cannot read them. Nothing
    // reported is the default, which is what a page sees for its first seconds
    // and for the whole life of one talking to a server too old to send it.
    machine: () => null,
    machineSeries: () => [],
    watchMachine: () => () => {},
    ...over,
  };
}

/** Render the panel around one reading and hand back the machine's row. */
function machineRow(
  report: MachineReport | null,
  series: MachinePoint[] = points([0.1, 0.2, 0.3]),
  over: Partial<ConnectionControl> = {},
): HTMLElement {
  const { container } = render(() => (
    <RightNow
      conn={control({
        channels: () => channelsFor(report),
        machine: () => report,
        machineSeries: () => series,
        ...over,
      })}
    />
  ));
  const row = container.querySelector<HTMLElement>('.tl-rightnow-row[data-channel="machine"]');
  if (!row) throw new Error("no machine row rendered");
  return row;
}

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const figures = (row: HTMLElement): string => text(row.querySelector(".tl-rightnow-figures"));

describe("This machine — a quiet box", () => {
  it("reads Fine and says nothing else about how it feels", () => {
    const row = machineRow(reading());
    expect(row.getAttribute("data-status")).toBe("working");
    expect(text(row.querySelector(".tl-rightnow-detail"))).toContain("Fine");
    expect(row.querySelector(".tl-rightnow-machine-said")).toBeNull();
  });

  it("still shows its figures and its hour, because a healthy box is a reading too", () => {
    const row = machineRow(reading());
    expect(figures(row)).not.toBe("");
    expect(row.querySelector(".tl-spark-svg")).not.toBeNull();
  });
});

describe("This machine — the numbers", () => {
  it("names each figure in words rather than in field names", () => {
    const shown = figures(machineRow(reading()));
    expect(shown).toContain("Processor");
    expect(shown).toContain("Disk");
    expect(shown).toContain("Memory");
    expect(shown).toContain("Load");
    // The wire's own names are the one thing a reader holding a slow terminal
    // cannot act on, and they are what a careless edit reaches for first.
    expect(shown).not.toMatch(/cpuPct|ioPct|memPct|load1|nproc|avg10|ofLimit/);
  });

  it.each([
    ["the processor's stall rate", 0.4, "0.4%"],
    ["a rate at the line", 50, "50%"],
    ["a rate worth one decimal", 1.2, "1.2%"],
    // Zero is the reading 97% of the time on this box and has to look like
    // zero, while a rate too small to write is not the same as no stall at all.
    ["nothing at all", 0, "0%"],
    ["a rate too small to write out", 0.03, "<0.1%"],
  ])("prints %s as %s", (_what, cpuPct, want) => {
    expect(figures(machineRow(reading({ cpuPct })))).toContain(want);
  });

  it("prints the load against the cores it is spread over", () => {
    // 0.9 on a 32-core box is nearly idle, and the figure means nothing
    // without the second half.
    expect(figures(machineRow(reading()))).toContain("0.9 of 32");
  });

  it("prints memory headroom in the units the box itself reports", () => {
    expect(figures(machineRow(reading()))).toContain("12.6 of 31.3 GB");
  });

  it("says how long a window the rates were taken over", () => {
    // Without it, "Processor 0.4%" could be read as how busy the processor is
    // rather than as the share of ten minutes it spent stalled.
    const row = machineRow(reading());
    expect(text(row.querySelector(".tl-rightnow-machine-window"))).toBe(
      "Stalled in the last 10 minutes",
    );
  });

  /**
   * A rate over a window shorter than ten minutes is not the rate the
   * thresholds were calibrated against, and the panel is the only place that
   * can say so. Silence here would present the first minutes after a restart as
   * an ordinary reading.
   */
  it("says when the window is shorter than the one the thresholds were set for", () => {
    const row = machineRow(reading({ windowSeconds: 180, partialWindow: true }));
    const note = text(row.querySelector(".tl-rightnow-machine-note"));
    expect(note).toContain("last 3 minutes");
    expect(note).toContain("all the history there is");
    expect(note).toContain("measured over ten");
    // The short caption stands down while the note is saying the same thing at
    // length, so the row does not state its window twice.
    expect(row.querySelector(".tl-rightnow-machine-window")).toBeNull();
  });
});

describe("This machine — the sentence, said once", () => {
  /**
   * The tier's sentence is what this feature is for, and it has two places it
   * could live. `verdict()` prints it at the top of the panel whenever the
   * machine is the only channel complaining, which is the common case, since a
   * busy box breaks nobody's socket. The row printing it as well put the same
   * words on screen twice, seven rows apart.
   *
   * So the row says it exactly where the headline stops: these two cases are
   * the whole rule, and the second is the one that matters, because it is the
   * case a reader learns nothing from otherwise.
   */
  it.each(["busy", "very-busy"] as const)(
    "leaves the sentence to the headline at %s, while the machine is the only complaint",
    (tier) => {
      const row = machineRow(reading({ state: "degraded", tier, worst: "io" }));
      expect(row.getAttribute("data-status")).toBe("degraded");
      expect(row.querySelector(".tl-rightnow-machine-said")).toBeNull();
      // The short phrase is still the row's job, and still names the resource.
      expect(text(row.querySelector(".tl-rightnow-detail"))).toContain("disk");
    },
  );

  /**
   * The dot is amber for a brush past a threshold and for a sustained grind
   * alike, and the sentence is the only thing that separates them (ADR-0028).
   * With a second channel complaining the headline becomes a count, so without
   * this the distinction would vanish from the panel exactly when the panel has
   * the most to explain.
   */
  it.each([
    ["busy", "Typing and commands may feel slow. The machine is busy."],
    ["very-busy", "Typing and commands are slow right now. The machine is very busy."],
  ] as const)("says it on the row at %s once something else is complaining too", (tier, said) => {
    const row = machineRow(reading({ state: "degraded", tier, worst: "io" }), undefined, {
      channels: () => [
        ...SESSION_CHANNELS.filter((id) => id !== "machine" && id !== "terminal").map(
          (id): Channel => ({ id, state: "working", detail: "fine" }),
        ),
        { id: "terminal", state: "degraded", detail: "reconnecting" },
        machineChannel(reading({ state: "degraded", tier, worst: "io" })),
      ],
    });
    expect(text(row.querySelector(".tl-rightnow-machine-said"))).toBe(said);
  });

  /** A quiet box has no sentence anywhere, whatever else is wrong. */
  it("says nothing on a healthy row beside a broken one", () => {
    const row = machineRow(reading(), undefined, {
      channels: () => [
        ...SESSION_CHANNELS.filter((id) => id !== "machine" && id !== "terminal").map(
          (id): Channel => ({ id, state: "working", detail: "fine" }),
        ),
        { id: "terminal", state: "down", detail: "not connected" },
        machineChannel(reading()),
      ],
    });
    expect(row.querySelector(".tl-rightnow-machine-said")).toBeNull();
  });

  /** Amber at worst (ADR-0028). Red on this row would claim the box is
   *  unreachable, which it plainly is not — the reading came from it. */
  it("never paints the row red, whatever the reading claims", () => {
    const row = machineRow(reading({ state: "down", tier: "very-busy", worst: "io" }));
    expect(row.getAttribute("data-status")).toBe("degraded");
  });
});

describe("This machine — the hour behind it", () => {
  it("draws a point for every sample it was given", () => {
    const row = machineRow(reading(), points([0.1, 0.4, 0.2, 0.9]));
    const drawn = row.querySelector(".tl-spark-line")?.getAttribute("points")?.trim().split(/\s+/);
    expect(drawn).toHaveLength(4);
  });

  /**
   * `ofLimit` is each reading divided by its OWN resource's threshold, so 1.0
   * is the amber line for all three and one line can carry the worst of them.
   * Drawing `pct` instead would put IO's 50% line and CPU's 10% line on the
   * same axis, where the same height would mean two different things.
   */
  it("rules the chart at the amber line, which is 1.0 in these units", () => {
    const row = machineRow(reading(), points([0.1, 0.2]));
    const rule = row.querySelector(".tl-spark-threshold");
    expect(rule).not.toBeNull();
    // A series well under the line still has to show the line, or the chart
    // cannot say how far under it the box is.
    expect(Number(rule?.getAttribute("y1"))).toBe(3);
  });

  it("labels the chart, since a line has no text of its own", () => {
    const label = machineRow(reading()).querySelector(".tl-spark-svg")?.getAttribute("aria-label");
    expect(label).toContain("hour");
  });

  it("says it has nothing rather than drawing an empty hour", () => {
    // The ring buffer empties whenever tmux-api restarts, which is one of the
    // moments someone is most likely to be looking.
    const row = machineRow(reading(), []);
    expect(text(row.querySelector(".tl-spark-empty"))).toBe("No readings yet");
  });
});

describe("This machine — a kernel with no pressure to read", () => {
  const fallback = (over: Partial<MachineReport> = {}) =>
    machineRow(reading({ source: "load", worst: "load", ...over }));

  it("says in words that it is reading load average instead of stall", () => {
    expect(text(fallback().querySelector(".tl-rightnow-machine-note"))).toContain("load average");
  });

  /** Three stall percentages from a kernel that measures none would read as
   *  "nothing is stalling", which is a claim this path cannot make. */
  it("shows no stall figures at all", () => {
    const shown = figures(fallback());
    expect(shown).not.toContain("Processor");
    expect(shown).not.toContain("Disk");
    expect(shown).not.toContain("%");
  });

  it("still shows what it IS reading", () => {
    const shown = figures(fallback());
    expect(shown).toContain("0.9 of 32");
    expect(shown).toContain("12.6 of 31.3 GB");
  });

  it("stays as quiet as the PSI row when the load says the box is busy", () => {
    const row = fallback({ state: "degraded", tier: "busy" });
    expect(row.querySelector(".tl-rightnow-machine-said")).toBeNull();
  });
});

describe("This machine — what it must not do", () => {
  /**
   * There is no action a person can take about a busy machine, so the row must
   * not grow a button offering one — even from a control that would answer for
   * every channel (ADR-0028).
   */
  it("grows no repair button", () => {
    const row = machineRow(reading({ state: "degraded", tier: "busy" }), points([0.1]), {
      repairLabel: () => "Reconnect",
    });
    expect(row.querySelector(".tl-rightnow-fix")).toBeNull();
  });

  it("leaves the other five rows one line each", () => {
    const { container } = render(() => (
      <RightNow conn={control({ machine: () => reading(), machineSeries: () => points([0.1]) })} />
    ));
    const blocks = container.querySelectorAll(".tl-rightnow-machine");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.closest(".tl-rightnow-row")?.getAttribute("data-channel")).toBe("machine");
  });

  it("says nothing at all when the box has not reported", () => {
    const row = machineRow(null);
    expect(row.getAttribute("data-status")).toBe("unknown");
    expect(text(row.querySelector(".tl-rightnow-detail"))).toContain("not reporting");
    expect(row.querySelector(".tl-rightnow-machine")).toBeNull();
  });

  /** The reading tmux-api produces before its first sample carries zeroes.
   *  Printing them would be three measurements that were never taken. */
  it("prints no figures from a reading that has taken no sample", () => {
    const row = machineRow(
      reading({ state: "unknown", source: "unknown", windowSeconds: 0, partialWindow: true }),
    );
    expect(row.querySelector(".tl-rightnow-machine")).toBeNull();
  });

  /**
   * And the reading ten seconds later, which is the one a restart actually
   * shows. tmux-api has taken ONE sample by then: the source is already "psi",
   * so the guard above lets it through, but a rate needs two samples and there
   * is no second one to subtract yet. `windowSeconds` is 0 and the three
   * percentages beside it are zeroes nobody measured — checked against a live
   * tmux-api on 2026-09-12, which answered `{"state":"unknown","source":"psi",
   * "cpuPct":0,"ioPct":0,"memPct":0,"windowSeconds":0}` two seconds after start
   * while the box was stalling on IO at 65%.
   */
  it("prints no figures from a reading with no window behind it", () => {
    const row = machineRow(
      reading({
        state: "unknown",
        source: "psi",
        cpuPct: 0,
        ioPct: 0,
        memPct: 0,
        windowSeconds: 0,
        partialWindow: true,
      }),
    );
    expect(row.querySelector(".tl-rightnow-machine")).toBeNull();
  });

  /** The load path has no window either, and there its figures are the whole
   *  reading. Reading `windowSeconds` without asking which path this is would
   *  blank the fallback row permanently. */
  it("still draws the fallback row, which has no window by construction", () => {
    const row = machineRow(reading({ source: "load", worst: "load", windowSeconds: 0 }));
    expect(row.querySelector(".tl-rightnow-machine")).not.toBeNull();
    expect(figures(row)).toContain("Load");
  });

  it("is absent, not broken, when nobody hands the panel a reading", () => {
    // A store that has heard nothing yet, and any server too old to send the
    // header at all.
    const { container } = render(() => <RightNow conn={control({ channels: () => [] })} />);
    expect(container.querySelectorAll(".tl-rightnow-row")).toHaveLength(SESSION_CHANNELS.length);
    expect(container.querySelector(".tl-rightnow-machine")).toBeNull();
  });
});

describe("This machine — while the panel is open", () => {
  /**
   * The reading normally rides the session-list poll, which is enough to
   * colour a dot and too slow for a figure somebody is watching move. This
   * panel is the only place anybody is watching, so it asks for its own while
   * it is open.
   *
   * Stopping is the half that has to be pinned. A watch left running behind a
   * closed panel spends a request every few seconds on a page nobody is
   * reading it from, and nothing on screen would ever show it.
   */
  it("watches the machine while it is open, and stops when it closes", () => {
    const stop = vi.fn();
    const watchMachine = vi.fn(() => stop);
    const { unmount } = render(() => <RightNow conn={control({ watchMachine })} />);
    expect(watchMachine).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  /** Watching is a READ. The panel's standing rule is that opening it changes
   *  nothing about the connections it describes, and asking the box how busy
   *  it is does not touch the state its reader came to look at. */
  it("repairs nothing and checks nothing by being opened", () => {
    const repair = vi.fn();
    const runCheck = vi.fn(async () => {});
    render(() => <RightNow conn={control({ repair, runCheck })} />);
    expect(repair).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });
});
