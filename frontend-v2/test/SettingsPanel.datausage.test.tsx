import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";
import {
  TIER_PREF_STORAGE_KEY,
  readTierPreference,
  writeTierPreference,
} from "../src/diagnostics/connection";
import { emptyStore, foldInto, writeStore, resetStore } from "../src/diagnostics/usage";

/**
 * The Data used section: what a person on a metered connection reads to answer
 * "is the lobby what ate my allowance", and where they reach the experience
 * control for this device's link.
 *
 * These assert what the section says, not how it computes it — the arithmetic
 * has its own tests in usage.test.ts.
 */

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

/** A day with one obvious dominant bucket and one modelled one. */
function seedUsage(): void {
  writeStore(
    foldInto(
      emptyStore(),
      { app: 5_100_000, term: 900_000, files: 1_200_000, text: 300_000, api: 100_000 },
      new Date(),
    ),
  );
}

async function openPanel() {
  const utils = render(() => <SettingsPanel prefs={fakePrefs()} onClose={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector(".tl-settings")).not.toBeNull());
  return utils;
}

const section = (c: HTMLElement) => c.querySelector(".tl-netusage") as HTMLElement | null;

beforeEach(() => {
  resetStore();
  localStorage.removeItem(TIER_PREF_STORAGE_KEY);
});

describe("Data used — the totals", () => {
  it("shows a section even with nothing recorded yet", async () => {
    const { container } = await openPanel();
    expect(section(container)).not.toBeNull();
    expect(section(container)!.textContent).toContain("0 B");
  });

  it("reports today, the last 7 days, this month and last month", async () => {
    seedUsage();
    const { container } = await openPanel();
    const text = section(container)!.textContent ?? "";

    expect(text).toContain("Today");
    expect(text).toContain("Last 7 days");
    expect(text).toContain("This month");
    expect(text).toContain("Last month");
    // 5.1 + 0.9 + 1.2 + 0.3 + 0.1 MB
    expect(text).toContain("7.6 MB");
  });

  it("names the month that last month covers", async () => {
    const { container } = await openPanel();
    const names = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const prev = new Date();
    prev.setDate(1);
    prev.setMonth(prev.getMonth() - 1);
    expect(section(container)!.textContent).toContain(names[prev.getMonth()]!);
  });
});

describe("Data used — the breakdown", () => {
  it("lists every bucket, largest first", async () => {
    seedUsage();
    const { container } = await openPanel();
    const rows = [...section(container)!.querySelectorAll(".tl-netusage-row")];
    expect(rows.length).toBe(5);
    expect(rows[0]!.textContent).toContain("App code");
    expect(rows[0]!.textContent).toContain("5.1 MB");
  });

  it("marks the modelled buckets and leaves the measured ones plain", async () => {
    seedUsage();
    const { container } = await openPanel();
    const rows = [...section(container)!.querySelectorAll(".tl-netusage-row")];
    const marked = rows
      .filter((r) => r.querySelector(".tl-netusage-approx"))
      .map((r) => r.textContent ?? "");

    expect(marked.length).toBe(2);
    expect(marked.join(" ")).toContain("Terminal");
    expect(marked.join(" ")).toContain("Text view");
    expect(marked.join(" ")).not.toContain("App code");
  });

  it("explains why two of them are modelled", async () => {
    seedUsage();
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("Compressed streams");
  });

  it("scales the bars to the largest bucket", async () => {
    seedUsage();
    const { container } = await openPanel();
    const width = (label: string) => {
      const row = [...section(container)!.querySelectorAll(".tl-netusage-row")].find((r) =>
        r.querySelector(".tl-netusage-name")?.textContent?.startsWith(label),
      );
      return parseFloat(row!.querySelector<HTMLElement>(".tl-netusage-bar span")!.style.width);
    };
    expect(width("App code")).toBe(100); // the largest sets the scale
    expect(width("Terminal")).toBeCloseTo((900_000 / 5_100_000) * 100, 1);
    expect(width("API")).toBeCloseTo((100_000 / 5_100_000) * 100, 1);
  });

  it("draws no bar at all when nothing has been recorded", async () => {
    const { container } = await openPanel();
    const bars = [...section(container)!.querySelectorAll<HTMLElement>(".tl-netusage-bar span")];
    expect(bars.every((b) => b.style.width === "0%")).toBe(true);
  });
});

describe("Data used — resetting", () => {
  it("zeroes the counters in place", async () => {
    seedUsage();
    const { container, getByText } = await openPanel();
    expect(section(container)!.textContent).toContain("7.6 MB");

    fireEvent.click(getByText("Reset counters"));

    await waitFor(() => expect(section(container)!.textContent).not.toContain("7.6 MB"));
    expect(section(container)!.textContent).toContain("0 B");
  });
});

describe("Data used — the experience control", () => {
  it("offers auto, full and slow", async () => {
    const { container } = await openPanel();
    const labels = [...container.querySelectorAll(".tl-netusage-tier label")].map(
      (l) => l.textContent?.trim(),
    );
    expect(labels).toEqual(["Auto", "Full", "Light"]);
  });

  it("starts on auto when nothing is pinned", async () => {
    const { container } = await openPanel();
    const checked = container.querySelector<HTMLInputElement>(
      ".tl-netusage-tier input:checked",
    );
    expect(checked?.value).toBe("auto");
  });

  it("reflects a pin that is already set", async () => {
    writeTierPreference("slow");
    const { container } = await openPanel();
    expect(
      container.querySelector<HTMLInputElement>(".tl-netusage-tier input:checked")?.value,
    ).toBe("slow");
  });

  it("writes the pin when one is chosen", async () => {
    const { container } = await openPanel();
    const full = [
      ...container.querySelectorAll<HTMLInputElement>(".tl-netusage-tier input"),
    ].find((i) => i.value === "full")!;

    fireEvent.click(full);

    await waitFor(() => expect(readTierPreference()).toBe("full"));
  });

  it("clears the pin when auto is chosen again", async () => {
    writeTierPreference("slow");
    const { container } = await openPanel();
    const auto = [
      ...container.querySelectorAll<HTMLInputElement>(".tl-netusage-tier input"),
    ].find((i) => i.value === "auto")!;

    fireEvent.click(auto);

    await waitFor(() => expect(readTierPreference()).toBe("auto"));
  });
});
