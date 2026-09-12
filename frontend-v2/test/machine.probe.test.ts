/**
 * The sixth probe — what Run check does about the machine row.
 *
 * It is the cheapest of the six and the only one whose silence must not be
 * read as a fault. Five channels answer over a connection, so no answer in five
 * seconds is evidence that the connection is broken. The machine is not a
 * connection: an unanswered /machine says the reading did not arrive, and the
 * row that reports how busy the box is has no way to be red (ADR-0027). If the
 * API really is unreachable, the session-list row is already saying so on its
 * own line, which is the accurate statement.
 *
 * The other half of the reason this probe exists is motion. A row that sits
 * still while five others refresh reads as broken, whatever it says.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildProbes, type ProbeDeps } from "../src/diagnostics/probes";
import { runCheck, type CheckOutcome } from "../src/diagnostics/check";
import { createStatusStore } from "../src/diagnostics/status-store";
// The wire lives with the code that receives it: the reading exists only
// because of an HTTP response, so its parser and its module state sit beside
// the client that makes the requests. status-store consumes parsed reports and
// never learns that one of its six channels arrives on a header.
import {
  currentMachineReport,
  currentMachineSeries,
  resetMachineState,
} from "../src/lib/lobby-api";
import { apiUrl } from "../src/lib/config";
import type { Channel } from "../src/diagnostics/status";

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "working",
  tier: "fine",
  worst: "io",
  cpuPct: 0.21,
  ioPct: 1.4,
  memPct: 0,
  load1: 1.9,
  nproc: 32,
  memAvailableMb: 12_000,
  memTotalMb: 23_000,
  source: "psi",
  windowSeconds: 600,
  partialWindow: false,
  ...over,
});

const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
  askTerminal: async () => ({ state: "open", attempt: 0 }),
  transcriptStatus: () => "open",
  sessionsReport: () => ({ failures: 0, lastOkMs: 1_000, downMs: null }),
  updateReady: () => false,
  ...over,
});

/** Run only the machine probe and hand back its one row. */
async function runMachineProbe(
  f: typeof fetch,
  opts: { timeoutMs?: number } = {},
): Promise<CheckOutcome> {
  const probes = buildProbes(deps({ fetch: f }));
  const rows = await runCheck(
    probes.filter((p) => p.id === "machine"),
    () => {},
    opts,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** A fetch that answers /machine with `payload` and records the URLs asked. */
function answering(payload: unknown, ok = true) {
  const urls: string[] = [];
  const f = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: ok ? 200 : 503 }),
    );
  }) as unknown as typeof fetch;
  return { f, urls };
}

beforeEach(() => {
  resetMachineState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the machine probe", () => {
  it("is one of the six a check runs", () => {
    expect(buildProbes(deps()).map((p) => p.id)).toContain("machine");
  });

  it("asks for the reading under the API prefix, not at the site root", async () => {
    const { f, urls } = answering({ verdict: wire(), series: [] });
    await runMachineProbe(f);
    // API_BASE alone is EMPTY unless `?api=` is present — the service prefix
    // lives in apiUrl. The /health probe shipped with this built by hand once,
    // asked the site root, 404'd, and reported a healthy box as unreachable.
    expect(urls).toEqual([apiUrl("/machine")]);
  });

  it("reports the fresh reading as the row", async () => {
    const { f } = answering({
      verdict: wire({ state: "degraded", tier: "very-busy", worst: "cpu", cpuPct: 41 }),
      series: [],
    });
    expect(await runMachineProbe(f)).toMatchObject({
      id: "machine",
      state: "degraded",
      detail: "the processor is busy",
    });
  });

  /**
   * The tier is the only thing separating "may feel slow" from "is slow right
   * now", and both wear the same state and the same words. A check that
   * dropped it downgraded the sentence of a box in real trouble, on the one
   * screen a person opened to find out how much trouble it was in.
   */
  it("carries the tier through the check, so the sentence does not soften", async () => {
    const { f } = answering({
      verdict: wire({ state: "degraded", tier: "very-busy", worst: "io", ioPct: 140 }),
      series: [],
    });
    const store = createStatusStore();
    await store.check(buildProbes(deps({ fetch: f })).filter((p) => p.id === "machine"));
    const row = store.channels().find((c) => c.id === "machine");
    expect(row).toMatchObject({ state: "degraded", tier: "very-busy" });
  });

  /**
   * Motion is half the point. The row's numbers and its hour come from the
   * feed, not from the check's own verdict, so a probe that returned a state
   * and published nothing would leave the figures frozen while the five rows
   * above them refreshed.
   */
  it("refreshes the figures and the hour the panel draws", async () => {
    const points = [{ at: 1_757_000_000, res: "cpu", pct: 41, ofLimit: 4.1 }];
    const { f } = answering({ verdict: wire({ cpuPct: 41 }), series: points });
    await runMachineProbe(f);
    expect(currentMachineReport()?.cpuPct).toBe(41);
    expect(currentMachineSeries()).toHaveLength(1);
  });

  it("leaves the row not reporting when the reading does not arrive in time", async () => {
    // A fetch that never settles: the half-open connection a mobile radio
    // produces when it drops a socket without an RST.
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const row = await runMachineProbe(hang, { timeoutMs: 20 });
    expect(row).toMatchObject({ state: "unknown", detail: "not reporting" });
  });

  it.each([
    ["the endpoint errors", () => Promise.resolve(new Response("nope", { status: 503 }))],
    ["the request fails outright", () => Promise.reject(new Error("offline"))],
    ["the body is not a reading", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    [
      "the verdict is one the model does not declare",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ verdict: wire({ state: "melting" }) }), { status: 200 }),
        ),
    ],
  ])("leaves the row not reporting, never down, when %s", async (_what, answer) => {
    const row = await runMachineProbe(answer as unknown as typeof fetch);
    expect(row).toMatchObject({ state: "unknown", detail: "not reporting" });
  });

  /**
   * The five channels that answer over a connection keep the old meaning: no
   * answer is a fault. Only the machine's silence is soft, and this is the case
   * that would catch a `timeoutState` applied to the wrong probe.
   */
  it("does not soften any other probe's silence", async () => {
    const probes = buildProbes(deps({ fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch }));
    const rows = await runCheck(
      probes.filter((p) => p.id === "sessions" || p.id === "machine"),
      () => {},
      { timeoutMs: 20 },
    );
    const byId = (id: string): Channel | undefined =>
      rows.find((r) => r.id === id) as Channel | undefined;
    expect(byId("sessions")).toMatchObject({ state: "down", detail: "timed out" });
    expect(byId("machine")).toMatchObject({ state: "unknown", detail: "not reporting" });
  });
});
