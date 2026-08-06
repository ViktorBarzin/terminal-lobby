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

/** Resolve everything queued behind the (async) failure classification. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(probe: () => number | null = () => 200) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const received: Event[] = [];
  const statuses: string[] = [];
  const probes: string[] = [];
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
    probeStatus: async (url) => {
      probes.push(url);
      return probe();
    },
    setTimer: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as never,
    clearTimer: () => {},
    random: () => 0.5,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    probeIntervalMs: 5000,
  });
  return { client, sources, timers, received, statuses, probes };
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

  it("reconnects with backoff after an error, resuming from the cursor", async () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: line({ id: 7, kind: "text", body: "z" }) });

    // error → schedules a reconnect timer, source closed, status reconnecting
    h.sources[0]!.onerror?.(null);
    await flush();
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

  it("instantRetry reconnects immediately and does not double-open", async () => {
    const h = harness();
    h.client.connect();
    h.sources[0]!.onerror?.(null); // failure is being classified
    h.client.instantRetry();
    expect(h.sources).toHaveLength(2); // reconnected now, not via the timer

    // already connected → instantRetry is a no-op, and the in-flight
    // classification must not open a THIRD source behind its back.
    h.client.instantRetry();
    await flush();
    expect(h.sources).toHaveLength(2);
  });

  it("stops reconnecting after close()", async () => {
    const h = harness();
    h.client.connect();
    h.client.close();
    h.sources[0]!.onerror?.(null);
    await flush();
    expect(h.timers).toHaveLength(0);
    expect(h.probes).toHaveLength(0);
    expect(h.statuses[h.statuses.length - 1]).toBe("closed");
  });

  // ---- a session with no Claude transcript --------------------------------
  // session-events answers `404 session not registered` for a tmux session no
  // Claude ever ran in (main.go). That is not a transient failure: retrying it
  // on the reconnect ladder hammers the endpoint forever while the badge reads
  // RECONNECTING — a connection-FAILURE indicator standing in for "there is
  // nothing to stream here".
  describe("no-transcript sessions", () => {
    it("stops the retry ladder when the stream 404s and says so", async () => {
      const h = harness(() => 404);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();

      expect(h.statuses).not.toContain("reconnecting");
      expect(h.statuses[h.statuses.length - 1]).toBe("no-transcript");
      // The only timer armed is the slow re-probe — NOT a backoff retry.
      expect(h.timers).toHaveLength(1);
      expect(h.timers[0]!.ms).toBe(5000);
      expect(h.sources).toHaveLength(1); // no second connection attempt
    });

    it("re-probes slowly instead of reconnecting, and stays quiet while absent", async () => {
      const h = harness(() => 404);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();

      // Three re-probe cycles: still one source, one probe per cycle.
      for (let i = 0; i < 3; i++) {
        h.timers[h.timers.length - 1]!.fn();
        await flush();
      }
      expect(h.sources).toHaveLength(1);
      expect(h.probes).toHaveLength(4); // the classification + 3 re-probes
      expect(h.timers.every((t) => t.ms === 5000)).toBe(true);
      expect(h.statuses[h.statuses.length - 1]).toBe("no-transcript");
    });

    it("picks the stream up when the session registers later", async () => {
      let status = 404;
      const h = harness(() => status);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();
      expect(h.statuses[h.statuses.length - 1]).toBe("no-transcript");

      // The session registers with session-events (POST /hooks/session-start).
      status = 200;
      h.timers[h.timers.length - 1]!.fn(); // the slow re-probe fires
      await flush();

      expect(h.sources).toHaveLength(2);
      h.sources[1]!.onopen?.(null);
      h.sources[1]!.onmessage?.({ data: line({ id: 1, kind: "text", body: "hi" }) });
      expect(h.received.map((e) => e.body)).toEqual(["hi"]);
      expect(h.statuses[h.statuses.length - 1]).toBe("open");
    });

    it("keeps the fast backoff ladder for failures that are not a 404", async () => {
      for (const probe of [() => 502, () => null]) {
        const h = harness(probe);
        h.client.connect();
        h.sources[0]!.onerror?.(null);
        await flush();

        expect(h.statuses[h.statuses.length - 1]).toBe("reconnecting");
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0]!.ms).toBe(75); // base 100, full jitter, random()=0.5
      }
    });

    it("leaves no-transcript as soon as a reconnect succeeds", async () => {
      let status = 404;
      const h = harness(() => status);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();

      status = 200;
      h.timers[h.timers.length - 1]!.fn();
      await flush();
      h.sources[1]!.onopen?.(null);
      expect(h.statuses[h.statuses.length - 1]).toBe("open");

      // …and goes back to no-transcript if the transcript disappears again.
      status = 404;
      h.sources[1]!.onerror?.(null);
      await flush();
      expect(h.statuses[h.statuses.length - 1]).toBe("no-transcript");
    });
  });
});
