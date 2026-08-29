import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import {
  PREF_DEFAULTS,
  type Prefs,
  type PrefsPatch,
  type PrefsStore,
} from "../src/store/prefs";
import {
  TIER_PREF_STORAGE_KEY,
  readTierPreference,
  writeTierPreference,
} from "../src/diagnostics/connection";
import { emptyStore, foldInto, writeStore, resetStore } from "../src/diagnostics/usage";
import { TIER_STORAGE_KEY } from "../src/diagnostics/connection";
import {
  NETWORK_STORAGE_KEY,
  resetNetworkState,
  setNetworkOverrides,
} from "../src/diagnostics/network";

/**
 * The Data used section: what a person on a metered connection reads to answer
 * "is the lobby what ate my allowance", and where they reach the experience
 * control for this device's link.
 *
 * These assert what the section says, not how it computes it — the arithmetic
 * has its own tests in usage.test.ts.
 */

function fakePrefs(patches: PrefsPatch[] = []): PrefsStore {
  const [prefs, setPrefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return {
    prefs,
    // The real store also hands the corrections to the network module, which is
    // what makes a tap show up on the row that was tapped.
    setPref(patch: PrefsPatch) {
      patches.push(patch);
      if (patch.netKinds) {
        setPrefs((p) => ({ ...p, netKinds: patch.netKinds! }));
        setNetworkOverrides(patch.netKinds);
      }
    },
    setFontSize() {},
    async bootSync() {},
    dispose() {},
  };
}

/** A day with one obvious dominant bucket and one modelled one, all of it on
 *  WiFi so a single-network reading stays simple. */
function seedUsage(): void {
  writeStore(
    foldInto(
      emptyStore(),
      { app: 5_100_000, term: 900_000, files: 1_200_000, text: 300_000, api: 100_000 },
      new Date(),
      "wifi",
    ),
  );
}

/** A day split across both links: WiFi carried the app code, cellular carried
 *  the terminal. The shape the whole feature exists to make visible. */
function seedTwoNetworks(): void {
  let s = foldInto(emptyStore(), { app: 4_000_000, term: 100_000 }, new Date(), "wifi");
  s = foldInto(s, { term: 2_000_000, api: 50_000 }, new Date(), "cell");
  writeStore(s);
}

/** Put a network in place as if /netinfo had already answered. */
function seedNetwork(info: Record<string, string>): void {
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(info));
  resetNetworkState();
}

async function openPanel(patches: PrefsPatch[] = []) {
  const utils = render(() => <SettingsPanel prefs={fakePrefs(patches)} onClose={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector(".tl-settings")).not.toBeNull());
  return utils;
}

const section = (c: HTMLElement) => c.querySelector(".tl-netusage") as HTMLElement | null;

beforeEach(() => {
  resetStore();
  resetNetworkState();
  localStorage.removeItem(TIER_PREF_STORAGE_KEY);
  localStorage.removeItem(TIER_STORAGE_KEY);
  localStorage.removeItem(NETWORK_STORAGE_KEY);
  // The panel asks the server which network this is the moment it opens.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no server in this test");
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

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

describe("Data used — what Auto measured", () => {
  /**
   * The pin says what you asked for; this says what the link actually did.
   * Without it "why is my app in light mode?" has no answer on the screen
   * that put it there.
   */
  it("reports the stored verdict", async () => {
    localStorage.setItem(TIER_STORAGE_KEY, "slow");
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("Last measured: light");
  });

  it("names a full link as full", async () => {
    localStorage.setItem(TIER_STORAGE_KEY, "full");
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("Last measured: full");
  });

  it("says so plainly when nothing has been measured yet", async () => {
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("not measured yet");
  });
});

/**
 * The network split — what someone opens this panel for while roaming. Two
 * questions: how much of the month went over cellular, and what ate it.
 */
describe("Data used — WiFi against cellular", () => {
  const cells = (c: HTMLElement, label: string): string[] => {
    const row = [...section(c)!.querySelectorAll("tbody tr")].find((r) =>
      r.querySelector("th")?.textContent?.startsWith(label),
    );
    return [...row!.querySelectorAll("td")].map((td) => td.textContent ?? "");
  };

  it("heads the columns with the total and the two links", async () => {
    const { container } = await openPanel();
    const heads = [...section(container)!.querySelectorAll("thead th")].map((h) =>
      h.textContent?.trim(),
    );
    expect(heads).toEqual(["Period", "Total", "WiFi", "Cellular"]);
  });

  it("puts each period's bytes in the column they crossed", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    // 4.1 MB on WiFi, 2.05 MB on cellular — which formats as 2.0, since 2.05
    // has no exact binary form and rounds down.
    expect(cells(container, "Today")).toEqual(["6.2 MB", "4.1 MB", "2.0 MB"]);
    expect(cells(container, "This month")).toEqual(["6.2 MB", "4.1 MB", "2.0 MB"]);
  });

  it("keeps unattributed bytes in the total and out of both columns", async () => {
    // What every counter written before this feature existed looks like.
    writeStore(foldInto(emptyStore(), { app: 3_000_000 }, new Date()));
    const { container } = await openPanel();
    expect(cells(container, "Today")).toEqual(["3.0 MB", "0 B", "0 B"]);
    expect(section(container)!.textContent).toContain("in neither column");
  });

  it("says nothing about unattributed bytes when there are none", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    expect(section(container)!.textContent).not.toContain("in neither column");
  });
});

describe("Data used — filtering the breakdown", () => {
  const pick = (c: HTMLElement, value: string) =>
    fireEvent.click(
      [...c.querySelectorAll<HTMLInputElement>(".tl-netusage-filter input")].find(
        (i) => i.value === value,
      )!,
    );
  const rows = (c: HTMLElement) =>
    [...section(c)!.querySelectorAll(".tl-netusage-row")].map((r) => r.textContent ?? "");

  it("offers all, WiFi and cellular, starting on all", async () => {
    const { container } = await openPanel();
    const labels = [...container.querySelectorAll(".tl-netusage-filter label")].map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toEqual(["All", "WiFi", "Cellular"]);
    expect(
      container.querySelector<HTMLInputElement>(".tl-netusage-filter input:checked")?.value,
    ).toBe("all");
  });

  it("narrows the bars to one link, and re-sorts them for it", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    expect(rows(container)[0]).toContain("App code"); // 4.0 MB dominates overall

    pick(container, "cell");

    // On cellular it is the terminal that costs, which is the point of asking.
    await waitFor(() => expect(rows(container)[0]).toContain("Terminal"));
    expect(rows(container)[0]).toContain("2.0 MB");
    expect(rows(container).join(" ")).toContain("App code");
    expect(rows(container).find((r) => r.includes("App code"))).toContain("0 B");
  });

  it("leaves the period totals alone while the breakdown narrows", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    const before = section(container)!.querySelector("tbody tr")!.textContent;

    pick(container, "wifi");

    await waitFor(() =>
      expect(section(container)!.querySelector(".tl-netusage-row")!.textContent).toContain(
        "App code",
      ),
    );
    expect(section(container)!.querySelector("tbody tr")!.textContent).toBe(before);
  });
});

describe("Data used — which network you are on", () => {
  const nameOf = (c: HTMLElement) =>
    c.querySelector(".tl-netusage-netname")?.textContent ?? "";
  const kindSelect = (c: HTMLElement) =>
    c.querySelector<HTMLSelectElement>(".tl-netusage-current select")!;

  it("says it is still checking before the server has answered", async () => {
    const { container } = await openPanel();
    expect(nameOf(container)).toContain("Checking");
    expect(kindSelect(container).disabled).toBe(true);
  });

  it("names the operator and the country, which is how roaming shows", async () => {
    seedNetwork({ net: "as64501", kind: "unknown", label: "Example Telecom Ltd", cc: "BG", source: "asn" });
    const { container } = await openPanel();
    expect(nameOf(container)).toBe("Example Telecom Ltd (BG)");
  });

  it("says a network on this house's own wire is certain", async () => {
    seedNetwork({ net: "lan", kind: "wifi", label: "Home network", cc: "", source: "lan" });
    const { container } = await openPanel();
    expect(nameOf(container)).toBe("Home network");
    expect(kindSelect(container).value).toBe("wifi");
    expect(section(container)!.textContent).toContain("certain");
  });

  it("offers 'not set' only while the kind is unknown", async () => {
    seedNetwork({ net: "as64501", kind: "unknown", label: "A1", cc: "BG", source: "asn" });
    const { container } = await openPanel();
    const values = [...kindSelect(container).options].map((o) => o.value);
    expect(values).toEqual(["unknown", "wifi", "cell"]);
    expect(kindSelect(container).value).toBe("unknown");
  });

  it("records a correction against the network, so it roams and it sticks", async () => {
    seedNetwork({ net: "as64501", kind: "unknown", label: "A1", cc: "BG", source: "asn" });
    const patches: PrefsPatch[] = [];
    const { container } = await openPanel(patches);

    const select = kindSelect(container);
    select.value = "cell";
    fireEvent.change(select);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.netKinds).toEqual({ as64501: "cell" });
    // Once corrected there is nothing left to un-set, so the placeholder goes.
    await waitFor(() =>
      expect([...kindSelect(container).options].map((o) => o.value)).toEqual(["wifi", "cell"]),
    );
    expect(kindSelect(container).value).toBe("cell");
  });

  it("keeps corrections for other networks when one is set", async () => {
    seedNetwork({ net: "as64501", kind: "unknown", label: "A1", cc: "BG", source: "asn" });
    setNetworkOverrides({ as12576: "cell" });
    const patches: PrefsPatch[] = [];
    const { container } = await openPanel(patches);

    const select = kindSelect(container);
    select.value = "wifi";
    fireEvent.change(select);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.netKinds).toEqual({ as12576: "cell", as64501: "wifi" });
  });
});
