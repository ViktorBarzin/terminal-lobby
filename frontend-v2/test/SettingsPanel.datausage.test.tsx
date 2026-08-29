import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";
import {
  TIER_PREF_STORAGE_KEY,
  TIER_STORAGE_KEY,
  readTierPreference,
  writeTierPreference,
} from "../src/diagnostics/connection";
import {
  NET_LAN,
  NET_UNKNOWN,
  emptyStore,
  foldInto,
  rememberNet,
  resetStore,
  writeStore,
} from "../src/diagnostics/usage";
import {
  NETWORK_STORAGE_KEY,
  resetNetworkState,
  noteNetworkId,
} from "../src/diagnostics/network";

/**
 * The Data used section: what a person on a metered connection reads to answer
 * "is the lobby what ate my allowance", and — since they may be reading it
 * abroad — where those bytes went. Networks are NAMED here, never categorised.
 *
 * These assert what the section says, not how it computes it: the arithmetic
 * has its own tests in usage.test.ts.
 */

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

/** A day with one obvious dominant bucket and one modelled one, all of it on
 *  one network so a single-network reading stays simple. */
function seedUsage(): void {
  writeStore(
    foldInto(
      emptyStore(),
      { app: 5_100_000, term: 900_000, files: 1_200_000, text: 300_000, api: 100_000 },
      new Date(),
      NET_LAN,
    ),
  );
}

/** A day split across two networks: home carried the app code, the operator
 *  carried the terminal. The shape the whole feature exists to make visible. */
function seedTwoNetworks(): void {
  let s = rememberNet(emptyStore(), "as8374", { label: "Polkomtel", cc: "PL" });
  s = foldInto(s, { app: 4_000_000, term: 100_000 }, new Date(), NET_LAN);
  s = foldInto(s, { term: 2_000_000, api: 50_000 }, new Date(), "as8374");
  writeStore(s);
}

/** Put a network in place as if the server had already stamped one. */
function seedNetwork(info: Record<string, string>): void {
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(info));
  resetNetworkState();
}

async function openPanel() {
  const utils = render(() => <SettingsPanel prefs={fakePrefs()} onClose={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector(".tl-settings")).not.toBeNull());
  return utils;
}

const section = (c: HTMLElement) => c.querySelector(".tl-netusage") as HTMLElement | null;

/** The period rows, which scope everything below them. */
const periodRows = (c: HTMLElement) => [
  ...section(c)!.querySelectorAll<HTMLButtonElement>(".tl-netusage-period"),
];
const periodRow = (c: HTMLElement, label: string) =>
  periodRows(c).find((r) => r.textContent?.startsWith(label))!;
/** Rows of whichever breakdown: networks first, then buckets. */
const rows = (c: HTMLElement) =>
  [...section(c)!.querySelectorAll(".tl-netusage-row")].map((r) => r.textContent ?? "");
const netRows = (c: HTMLElement) =>
  [...section(c)!.querySelectorAll(".tl-netusage-row")].slice(0, -5);

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

describe("Data used — the periods", () => {
  it("shows a section even with nothing recorded yet", async () => {
    const { container } = await openPanel();
    expect(section(container)).not.toBeNull();
    expect(section(container)!.textContent).toContain("0 B");
  });

  it("offers today, the last 7 days, both months and the resettable period", async () => {
    seedUsage();
    const { container } = await openPanel();
    const labels = periodRows(container).map((r) =>
      r.querySelector(".tl-netusage-name")?.textContent,
    );
    expect(labels.slice(0, 3)).toEqual(["Today", "Last 7 days", "This month"]);
    expect(labels[4]).toMatch(/^Since/);
    // 5.1 + 0.9 + 1.2 + 0.3 + 0.1 MB
    expect(periodRow(container, "This month").textContent).toContain("7.6 MB");
  });

  it("names the month that last month covers", async () => {
    const { container } = await openPanel();
    const names = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const prev = new Date();
    prev.setDate(1);
    prev.setMonth(prev.getMonth() - 1);
    expect(periodRows(container)[3]!.textContent).toContain(names[prev.getMonth()]!);
  });

  it("starts on this month, and the selection is marked", async () => {
    const { container } = await openPanel();
    const on = periodRows(container).filter((r) => r.getAttribute("aria-checked") === "true");
    expect(on).toHaveLength(1);
    expect(on[0]!.textContent).toContain("This month");
  });
});

describe("Data used — where the bytes went", () => {
  it("names each network rather than categorising it", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    const text = netRows(container)
      .map((r) => r.textContent ?? "")
      .join(" ");
    expect(text).toContain("Home network");
    expect(text).toContain("Polkomtel (PL)");
    // The category is gone on purpose: an operator's name says nothing
    // reliable about whether the link is fixed or mobile.
    expect(section(container)!.textContent).not.toContain("Cellular");
    expect(section(container)!.textContent).not.toContain("WiFi");
  });

  it("lists them largest first with their bytes", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    const first = netRows(container)[0]!.textContent ?? "";
    expect(first).toContain("Home network");
    expect(first).toContain("4.1 MB");
  });

  it("says so plainly when a period carried nothing", async () => {
    const { container } = await openPanel();
    fireEvent.click(periodRow(container, "Today"));
    await waitFor(() =>
      expect(section(container)!.textContent).toContain("Nothing counted in this period yet"),
    );
  });

  it("keeps unattributed bytes as their own row", async () => {
    writeStore(foldInto(emptyStore(), { app: 3_000_000 }, new Date(), NET_UNKNOWN));
    const { container } = await openPanel();
    expect(netRows(container)[0]!.textContent).toContain("Unknown network");
  });
});

describe("Data used — one selection drives it", () => {
  it("scopes the bars to the selected period", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("This month · all networks");

    fireEvent.click(periodRow(container, "Today"));

    await waitFor(() =>
      expect(section(container)!.textContent).toContain("Today · all networks"),
    );
  });

  it("narrows the bars to a network, and re-sorts them for it", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    expect(rows(container).slice(-5)[0]).toContain("App code"); // 4.0 MB overall

    fireEvent.click(netRows(container).find((r) => r.textContent?.includes("Polkomtel"))!);

    // On that network it is the terminal that costs, which is the point.
    await waitFor(() => expect(rows(container).slice(-5)[0]).toContain("Terminal"));
    expect(section(container)!.textContent).toContain("Polkomtel (PL)");
    expect(rows(container).slice(-5).join(" ")).toContain("2.0 MB");
  });

  it("leaves the period totals alone while the breakdown narrows", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    const before = periodRow(container, "This month").textContent;

    fireEvent.click(netRows(container).find((r) => r.textContent?.includes("Polkomtel"))!);

    await waitFor(() => expect(rows(container).slice(-5)[0]).toContain("Terminal"));
    expect(periodRow(container, "This month").textContent).toBe(before);
  });

  it("clears the network when the same row is tapped again", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    const row = () => netRows(container).find((r) => r.textContent?.includes("Polkomtel"))!;

    fireEvent.click(row());
    await waitFor(() => expect(section(container)!.textContent).toContain("· Polkomtel (PL)"));
    fireEvent.click(row());
    await waitFor(() => expect(section(container)!.textContent).toContain("· all networks"));
  });

  it("drops the network when the period changes, so nothing narrows to a blank", async () => {
    seedTwoNetworks();
    const { container } = await openPanel();
    fireEvent.click(netRows(container).find((r) => r.textContent?.includes("Polkomtel"))!);
    await waitFor(() => expect(section(container)!.textContent).toContain("· Polkomtel (PL)"));

    fireEvent.click(periodRow(container, "Today"));

    await waitFor(() => expect(section(container)!.textContent).toContain("Today · all networks"));
  });
});

describe("Data used — the two resets", () => {
  it("rebaselines the one period and leaves the others standing", async () => {
    seedUsage();
    const { container, getByText } = await openPanel();
    expect(periodRow(container, "This month").textContent).toContain("7.6 MB");

    fireEvent.click(getByText("Reset this period"));

    await waitFor(() => expect(periodRows(container)[4]!.textContent).toContain("0 B"));
    expect(periodRow(container, "This month").textContent).toContain("7.6 MB");
  });

  it("throws away every figure when the counters are reset", async () => {
    seedUsage();
    const { container, getByText } = await openPanel();

    fireEvent.click(getByText("Reset counters"));

    await waitFor(() =>
      expect(periodRow(container, "This month").textContent).not.toContain("7.6 MB"),
    );
    expect(section(container)!.textContent).toContain("0 B");
  });
});

describe("Data used — which network you are on", () => {
  const nameOf = (c: HTMLElement) =>
    c.querySelector(".tl-netusage-netname")?.textContent ?? "";

  it("says it is still checking before anything has answered", async () => {
    const { container } = await openPanel();
    expect(nameOf(container)).toContain("Checking");
  });

  it("names the operator and its registered country", async () => {
    seedNetwork({ net: "as8374", label: "Polkomtel", cc: "PL", source: "asn" });
    const { container } = await openPanel();
    expect(nameOf(container)).toBe("Polkomtel (PL)");
  });

  it("names the house's own network without a country", async () => {
    seedNetwork({ net: "lan", label: "Home network", cc: "", source: "lan" });
    const { container } = await openPanel();
    expect(nameOf(container)).toBe("Home network");
    expect(section(container)!.textContent).toContain("house's own network");
  });

  it("marks an answer nobody has confirmed lately", async () => {
    // A backgrounded tab keeps counting while the poll is parked; the panel
    // says so rather than implying the name still applies.
    seedNetwork({ net: "as8374", label: "Polkomtel", cc: "PL", source: "asn" });
    const { container } = await openPanel();
    expect(section(container)!.textContent).toContain("not confirmed");

    noteNetworkId("as8374");
    await waitFor(() => expect(section(container)!.textContent).toContain("Polkomtel"));
  });

  it("offers no way to categorise it, because there is nothing to categorise", async () => {
    seedNetwork({ net: "as8374", label: "Polkomtel", cc: "PL", source: "asn" });
    const { container } = await openPanel();
    expect(container.querySelector(".tl-netusage-current select")).toBeNull();
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
