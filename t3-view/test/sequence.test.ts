import { describe, expect, it } from "vitest";

import { EventLog, SequenceClock } from "../src/sequence.ts";

const EPOCH_MS = 1_791_800_000_000;

describe("SequenceClock", () => {
  it("starts from the startup time in microseconds, not from 0", () => {
    const clock = new SequenceClock(EPOCH_MS);
    expect(clock.base).toBe(EPOCH_MS * 1000);
    expect(clock.current()).toBe(clock.base);
    expect(Number.isSafeInteger(clock.base)).toBe(true);
  });

  it("hands out increasing sequences", () => {
    const clock = new SequenceClock(EPOCH_MS);
    expect(clock.next()).toBe(clock.base + 1);
    expect(clock.next()).toBe(clock.base + 2);
    expect(clock.current()).toBe(clock.base + 2);
  });

  it("starts every restart above anything the previous run handed out", () => {
    const before = new SequenceClock(EPOCH_MS);
    for (let i = 0; i < 999; i++) before.next();
    const after = new SequenceClock(EPOCH_MS + 1);
    expect(after.base).toBeGreaterThan(before.current());
  });
});

describe("EventLog.resume", () => {
  const make = (capacity = 3) => {
    const clock = new SequenceClock(EPOCH_MS);
    return { clock, log: new EventLog<string>(clock, capacity) };
  };

  it("sends a snapshot to a client that has never synced", () => {
    expect(make().log.resume(0)).toEqual({ kind: "snapshot" });
  });

  it("sends a snapshot to a client whose sequence comes from an earlier run", () => {
    const { clock, log } = make();
    expect(log.resume(clock.base - 1)).toEqual({ kind: "snapshot" });
  });

  it("sends a snapshot to a client ahead of this run", () => {
    const { clock, log } = make();
    log.append("a");
    expect(log.resume(clock.current() + 1)).toEqual({ kind: "snapshot" });
  });

  it("replays nothing to a client that is up to date", () => {
    const { clock, log } = make();
    log.append("a");
    expect(log.resume(clock.current())).toEqual({ kind: "replay", events: [] });
  });

  it("replays what a client missed", () => {
    const { clock, log } = make();
    const first = log.append("a");
    log.append("b");
    log.append("c");
    expect(first).toBe(clock.base + 1);
    expect(log.resume(first)).toEqual({
      kind: "replay",
      events: [
        { sequence: clock.base + 2, event: "b" },
        { sequence: clock.base + 3, event: "c" },
      ],
    });
  });

  it("replays from the start of the run while nothing has been dropped", () => {
    const { clock, log } = make();
    log.append("a");
    expect(log.resume(clock.base)).toEqual({
      kind: "replay",
      events: [{ sequence: clock.base + 1, event: "a" }],
    });
  });

  it("sends a snapshot once the events a client missed have been dropped", () => {
    const { clock, log } = make(2);
    log.append("a");
    log.append("b");
    log.append("c");
    expect(log.resume(clock.base)).toEqual({ kind: "snapshot" });
    expect(log.resume(clock.base + 1)).toEqual({
      kind: "replay",
      events: [
        { sequence: clock.base + 2, event: "b" },
        { sequence: clock.base + 3, event: "c" },
      ],
    });
  });
});
