/**
 * Warming the xterm chunk — the SCHEDULE, which is the whole of the decision.
 *
 * `TerminalNative` imports `@xterm/xterm` and `@xterm/addon-fit` lazily, and the
 * chunk that comes back is 329,698 B raw, 82,870 B gzipped. The first terminal
 * open of a page load waits for it: measured 413 to 841 ms on 2026-09-11
 * (ADR-0026). Warming it after first paint at idle priority removes that wait
 * without putting 82 KB in front of the session list, which is the screen a
 * 400 kbps link needs first.
 *
 * What the import itself does is the module loader's business — asserting on a
 * real fetch here would be testing vite. So every test below fakes the idle
 * callback and asks one question: when does the load get asked for, and when
 * does it not.
 */
import { describe, it, expect, vi } from "vitest";
import {
  PREFETCH_FALLBACK_MS,
  PREFETCH_IDLE_TIMEOUT_MS,
  createChunkPrefetch,
  type IdleRequest,
} from "../src/lib/prefetch";

/** A requestIdleCallback that never fires on its own, so the test says when. */
function fakeIdle(): { calls: Array<{ run: () => void; timeout: number }>; idle: IdleRequest } {
  const calls: Array<{ run: () => void; timeout: number }> = [];
  const idle: IdleRequest = (run, opts) => {
    calls.push({ run, timeout: opts.timeout });
    return calls.length;
  };
  return { calls, idle };
}

/** A setTimeout that never fires on its own, for the browsers with no idle callback. */
function fakeTimer(): {
  timers: Array<{ run: () => void; ms: number }>;
  delay: (run: () => void, ms: number) => void;
} {
  const timers: Array<{ run: () => void; ms: number }> = [];
  return { timers, delay: (run, ms) => void timers.push({ run, ms }) };
}

describe("xterm chunk prefetch", () => {
  it("schedules the load instead of running it, and runs it when idle comes", () => {
    const { calls, idle } = fakeIdle();
    const load = vi.fn(async () => undefined);

    const started = createChunkPrefetch({ load, idle, coarsePointer: () => false }).start();

    expect(started).toBe(true);
    // The point of the whole exercise: nothing is fetched on the boot path.
    expect(load).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeout).toBe(PREFETCH_IDLE_TIMEOUT_MS);

    calls[0]?.run();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timer where the browser has no idle callback", () => {
    // Safari has none, and Safari is the browser most likely to be on the slow
    // link this warm exists for.
    const { timers, delay } = fakeTimer();
    const load = vi.fn(async () => undefined);

    const started = createChunkPrefetch({
      load,
      idle: undefined,
      delay,
      coarsePointer: () => false,
    }).start();

    expect(started).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(PREFETCH_FALLBACK_MS);

    timers[0]?.run();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an idle callback", true],
    ["a timer", false],
  ])("schedules nothing on a coarse pointer, with %s available", (_name, hasIdle) => {
    // A phone has no hover to pair the warm with, and the same 82 KB competes
    // with a slower, often metered link. It keeps today's behaviour: the chunk
    // arrives when a terminal is actually opened.
    const { calls, idle } = fakeIdle();
    const { timers, delay } = fakeTimer();
    const load = vi.fn(async () => undefined);

    const started = createChunkPrefetch({
      load,
      idle: hasIdle ? idle : undefined,
      delay,
      coarsePointer: () => true,
    }).start();

    expect(started).toBe(false);
    expect(calls).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("warms once, however many times it is asked", () => {
    // The chunk is in the module cache after the first load, so a second fetch
    // would be free and pointless. A second SCHEDULE is neither.
    const { calls, idle } = fakeIdle();
    const load = vi.fn(async () => undefined);
    const prefetch = createChunkPrefetch({ load, idle, coarsePointer: () => false });

    expect(prefetch.start()).toBe(true);
    expect(prefetch.start()).toBe(false);
    expect(prefetch.start()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("swallows a chunk that fails to arrive", async () => {
    // An optimisation may not become a source of unhandled rejections. The open
    // that needs the chunk asks for it again and reports its own failure.
    const { calls, idle } = fakeIdle();
    const load = vi.fn(() => Promise.reject(new Error("offline")));

    createChunkPrefetch({ load, idle, coarsePointer: () => false }).start();
    calls[0]?.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
