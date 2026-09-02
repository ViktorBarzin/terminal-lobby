/**
 * The probes' REQUESTS, not just their verdicts.
 *
 * These exist because a probe that asks the wrong URL still returns a
 * confident-looking row. The session-list probe shipped building its URL from
 * API_BASE by hand, which is EMPTY unless a `?api=` override is present — the
 * service prefix lives in apiUrl — so it asked for `/health` at the site root,
 * got a 404, and reported "the API is not answering" on a healthy box. Every
 * unit test passed, because they all injected a fetch that answered whatever it
 * was asked.
 *
 * So: assert the path, not only the outcome.
 */
import { describe, it, expect } from "vitest";
import { buildProbes } from "../src/diagnostics/probes";
import { runCheck } from "../src/diagnostics/check";
import type { CheckOutcome } from "../src/diagnostics/check";
import type { ProbeDeps } from "../src/diagnostics/probes";

/**
 * The one row a single-probe check must produce. Asserting the count here is
 * what lets the cases below be about the row's CONTENTS — destructuring gave
 * them a `CheckOutcome | undefined` and every field access was unchecked.
 */
const onlyRow = (rows: CheckOutcome[]): CheckOutcome => {
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/** A fetch that records what it was asked for and answers 200. */
function recordingFetch(ok = true) {
  const urls: string[] = [];
  const f = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify([]), { status: ok ? 200 : 503 }),
    );
  }) as unknown as typeof fetch;
  return { f, urls };
}

const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
  askTerminal: async () => ({ state: "open", attempt: 0 }),
  transcriptStatus: () => "open",
  sessionsReport: () => ({ failures: 0, lastOkMs: 1_000, downMs: null }),
  updateReady: () => false,
  ...over,
});

describe("what the probes actually request", () => {
  it("asks for health under the API prefix, not at the site root", async () => {
    const { f, urls } = recordingFetch();
    const probes = buildProbes(deps({ fetch: f }));
    await runCheck(
      probes.filter((p) => p.id === "sessions"),
      () => {},
    );
    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    // The exact prefix is apiUrl's business; what matters is that the probe
    // went through it rather than hand-rolling a root-relative path.
    expect(url).not.toBe("/health");
    expect(url).toMatch(/\/health$/);
    expect(url.length).toBeGreaterThan("/health".length);
  });

  it("reports the API as down when health does not answer", async () => {
    const { f } = recordingFetch(false);
    const probes = buildProbes(deps({ fetch: f }));
    const row = onlyRow(
      await runCheck(
        probes.filter((p) => p.id === "sessions"),
        () => {},
      ),
    );
    expect(row.state).toBe("down");
    expect(row.detail).toBe("the API is not answering");
  });

  it("keeps the poll's own verdict when the API is answering", async () => {
    const { f } = recordingFetch();
    const probes = buildProbes(deps({ fetch: f }));
    const row = onlyRow(
      await runCheck(
        probes.filter((p) => p.id === "sessions"),
        () => {},
      ),
    );
    expect(row.state).toBe("working");
  });

  /**
   * A failing poll against a healthy API is a different problem from an API
   * that is down, and the row has to say which — otherwise "it stopped
   * refreshing" points at the wrong half of the system.
   */
  it("separates a stuck tab from a down API", async () => {
    const { f } = recordingFetch();
    const probes = buildProbes(
      deps({
        fetch: f,
        sessionsReport: () => ({ failures: 9, lastOkMs: 120_000, downMs: 120_000 }),
      }),
    );
    const row = onlyRow(
      await runCheck(
        probes.filter((p) => p.id === "sessions"),
        () => {},
      ),
    );
    expect(row.detail).toContain("but the API is answering");
  });

  /** Push is read, never sent: /push/test fans out to every device someone
   *  owns, and a check that buzzes a phone in a pocket stops being run. */
  it("never asks the push test endpoint", async () => {
    const { f, urls } = recordingFetch();
    const probes = buildProbes(deps({ fetch: f }));
    await runCheck(probes, () => {}, { timeoutMs: 50 });
    expect(urls.some((u) => u.includes("push/test"))).toBe(false);
  });
});
