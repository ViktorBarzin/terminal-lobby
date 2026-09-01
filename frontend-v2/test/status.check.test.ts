import { describe, it, expect, vi } from "vitest";
import { CHECK_TIMEOUT_MS, runCheck, type CheckProbe, type CheckOutcome } from "../src/diagnostics/check";
import type { Channel, ChannelId } from "../src/diagnostics/status";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function probe(
  id: ChannelId,
  ms: number,
  result: Partial<Channel> = {},
  over: Partial<CheckProbe> = {},
): CheckProbe {
  return {
    id,
    run: async () => {
      await sleep(ms);
      return { id, state: "working", detail: "ok", ...result } as Channel;
    },
    ...over,
  };
}

describe("run check", () => {
  /**
   * The button gets pressed on a bad link, which is when serialising the probes
   * would cost 20-25s and people stop waiting. Parallel means the whole check
   * costs the slowest row, not the sum.
   */
  it("runs every probe at once, not one after another", async () => {
    const started = Date.now();
    await runCheck([probe("terminal", 60), probe("sessions", 60), probe("build", 60)], () => {});
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("hands back each row the moment it lands, in the order they land", async () => {
    const seen: ChannelId[] = [];
    await runCheck(
      [probe("terminal", 80), probe("sessions", 10), probe("build", 40)],
      (r) => void seen.push(r.id),
    );
    expect(seen).toEqual(["sessions", "build", "terminal"]);
  });

  it("returns the finished rows in row order, whatever order they landed in", async () => {
    const out = await runCheck(
      [probe("build", 5), probe("terminal", 40), probe("sessions", 20)],
      () => {},
    );
    expect(out.map((r) => r.id)).toEqual(["terminal", "sessions", "build"]);
  });

  it("times each row, so a slow-but-working channel is visible as slow", async () => {
    const [row] = await runCheck([probe("sessions", 40)], () => {});
    expect(row.ms).toBeGreaterThanOrEqual(30);
    expect(row.ms).toBeLessThan(500);
  });

  /**
   * The signature of a half-open mobile network is a request that never
   * settles. One row hanging must not hold the other four, or the panel becomes
   * the second thing that hangs on a link the user already came here about.
   */
  it("caps a hanging probe and keeps the rest", async () => {
    const hang: CheckProbe = { id: "terminal", run: () => new Promise<Channel>(() => {}) };
    const out = await runCheck([hang, probe("sessions", 10)], () => {}, { timeoutMs: 60 });
    expect(out.find((r) => r.id === "terminal")).toMatchObject({
      state: "down",
      detail: "timed out",
    });
    expect(out.find((r) => r.id === "sessions")?.state).toBe("working");
  });

  it("lets a probe say a timeout means it is not reporting, not broken", async () => {
    const hang: CheckProbe = {
      id: "terminal",
      timeoutState: "unknown",
      timeoutDetail: "not reporting",
      run: () => new Promise<Channel>(() => {}),
    };
    const [row] = await runCheck([hang], () => {}, { timeoutMs: 30 });
    expect(row.state).toBe("unknown");
    expect(row.detail).toBe("not reporting");
  });

  it("aborts a probe it gave up on, so nothing keeps running behind the panel", async () => {
    let aborted = false;
    const hang: CheckProbe = {
      id: "sessions",
      run: (signal) =>
        new Promise<Channel>(() => {
          signal.addEventListener("abort", () => void (aborted = true));
        }),
    };
    await runCheck([hang], () => {}, { timeoutMs: 30 });
    expect(aborted).toBe(true);
  });

  it("turns a thrown probe into a row rather than losing the whole check", async () => {
    const boom: CheckProbe = {
      id: "notifications",
      run: () => Promise.reject(new Error("nope")),
    };
    const out = await runCheck([boom, probe("build", 5)], () => {});
    expect(out.find((r) => r.id === "notifications")).toMatchObject({
      state: "down",
      detail: "nope",
    });
    expect(out).toHaveLength(2);
  });

  it("reports a probe that rejects with something that is not an Error", async () => {
    const boom: CheckProbe = { id: "build", run: () => Promise.reject("weird") };
    const [row] = await runCheck([boom], () => {});
    expect(row.state).toBe("down");
    expect(row.detail).toBeTruthy();
  });

  it("caps at five seconds by default, which is what the SSE probe already uses", () => {
    expect(CHECK_TIMEOUT_MS).toBe(5000);
  });

  it("is a no-op on an empty probe list", async () => {
    const onResult = vi.fn();
    expect(await runCheck([], onResult)).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("what a finished check says", () => {
  it("carries enough for one telemetry record", async () => {
    const out: CheckOutcome[] = await runCheck(
      [probe("terminal", 5), probe("build", 5, { state: "degraded", detail: "update ready" })],
      () => {},
    );
    expect(out.map((r) => `${r.id}=${r.state}`)).toEqual(["terminal=working", "build=degraded"]);
  });
});
