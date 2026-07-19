import { describe, it, expect } from "vitest";
import { SseClient, type EventSourceLike } from "../src/sse/client";
import { eventsUrl } from "../src/lib/config";
import type { Event } from "../src/types/events";

class FakeSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const received: Event[] = [];
  const statuses: string[] = [];
  const client = new SseClient({
    session: "sess",
    url: eventsUrl,
    onEvent: (e) => received.push(e),
    onStatus: (s) => statuses.push(s),
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    setTimer: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as never,
    clearTimer: () => {},
    random: () => 0.5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  });
  return { client, sources, timers, received, statuses };
}

const line = (e: Partial<Event> & Pick<Event, "id" | "kind">) =>
  JSON.stringify({ session: "sess", ...e });

describe("SseClient", () => {
  it("connects, delivers parsed events, and tracks the cursor", () => {
    const h = harness();
    h.client.connect();
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]!.url).toBe("/events/sess"); // no cursor on first connect

    h.sources[0]!.onopen?.(null);
    h.sources[0]!.onmessage?.({ data: line({ id: 1, kind: "text", body: "a" }) });
    h.sources[0]!.onmessage?.({ data: line({ id: 2, kind: "text", body: "b" }) });

    expect(h.received.map((e) => e.id)).toEqual([1, 2]);
    expect(h.client.cursor).toBe(2);
    expect(h.statuses).toContain("open");
  });

  it("dedupes events at or below the cursor", () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: line({ id: 5, kind: "text", body: "x" }) });
    h.sources[0]!.onmessage?.({ data: line({ id: 3, kind: "text", body: "stale" }) });
    h.sources[0]!.onmessage?.({ data: line({ id: 5, kind: "text", body: "dup" }) });
    expect(h.received.map((e) => e.id)).toEqual([5]);
  });

  it("ignores malformed frames without throwing", () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: "not json" });
    h.sources[0]!.onmessage?.({ data: JSON.stringify({ id: "x", kind: "text" }) });
    expect(h.received).toHaveLength(0);
  });

  it("reconnects with backoff after an error, resuming from the cursor", () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: line({ id: 7, kind: "text", body: "z" }) });

    // error → schedules a reconnect timer, source closed, status reconnecting
    h.sources[0]!.onerror?.(null);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.timers).toHaveLength(1);
    // full-jitter with random()=0.5 on base 100 → 100/2 + 0.5*50 = 75ms
    expect(h.timers[0]!.ms).toBe(75);
    expect(h.statuses).toContain("reconnecting");

    // fire the timer → new source, URL carries the resume cursor
    h.timers[0]!.fn();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1]!.url).toBe("/events/sess?lastEventId=7");
  });

  it("instantRetry reconnects immediately and does not double-open", () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onerror?.(null); // now waiting on a backoff timer
    h.client.instantRetry();
    expect(h.sources).toHaveLength(2); // reconnected now, not via the timer

    // already connected → instantRetry is a no-op
    h.client.instantRetry();
    expect(h.sources).toHaveLength(2);
  });

  it("stops reconnecting after close()", () => {
    const h = harness();
    h.client.connect();
    h.client.close();
    h.sources[0]!.onerror?.(null);
    expect(h.timers).toHaveLength(0);
    expect(h.statuses[h.statuses.length - 1]).toBe("closed");
  });
});
