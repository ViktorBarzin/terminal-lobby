import { describe, it, expect } from "vitest";
import {
  SseClient,
  probeViaFetch,
  type EventSourceLike,
  type SseClientOptions,
} from "../src/sse/client";
import { eventsUrl } from "../src/lib/config";
import type { Event } from "../src/types/events";

class FakeSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null;
  closed = false;
  private readonly listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** Deliver a named frame (`ready`, `back`, `state`) the way the server does. */
  emit(type: string, data: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

/** Resolve everything queued behind the (async) failure classification. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(probe: () => number | null = () => 200, over: Partial<SseClientOptions> = {}) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const received: Event[] = [];
  const statuses: string[] = [];
  const probes: string[] = [];
  // A hand-cranked clock: staleness is measured in wall time, so the tests
  // advance it explicitly rather than waiting out the real 45s window.
  let nowMs = 1_700_000_000_000;
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
    now: () => nowMs,
    ...over,
  });
  return {
    client,
    sources,
    timers,
    received,
    statuses,
    probes,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const line = (e: Partial<Event> & Pick<Event, "id" | "kind">) =>
  JSON.stringify({ session: "sess", ...e });

describe("SseClient", () => {
  it("connects, delivers parsed events, and tracks the cursor", () => {
    const h = harness();
    h.client.connect();
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]!.url).toBe("/events/sess?rev=1"); // no cursor on first connect

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
    expect(h.sources[1]!.url).toBe("/events/sess?lastEventId=7&rev=1");
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
      // The only timer armed is the re-probe — NOT a backoff retry.
      expect(h.timers).toHaveLength(1);
      expect(h.timers[0]!.ms).toBe(1000);
      expect(h.sources).toHaveLength(1); // no second connection attempt
    });

    // Seen on 0.83.3 (2026-09-29): a session opened within ~1.5s of `claude
    // --resume` 404s because its SessionStart hook has not registered it yet,
    // and a first re-probe 30s out left the Text view on "No messages yet."
    // for 30s. The re-probe now starts at a second and doubles up to the slow
    // interval, so a session that is about to register is picked up at once
    // and a plain shell still settles to one probe per interval.
    it("re-probes soon after the 404 and backs off to the slow interval", async () => {
      const h = harness(() => 404);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();
      for (let i = 0; i < 4; i++) {
        h.timers[h.timers.length - 1]!.fn();
        await flush();
      }
      expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 5000, 5000]);
    });

    it("starts soon again when a stream that was open 404s later", async () => {
      let status = 404;
      const h = harness(() => status);
      h.client.connect();
      h.sources[0]!.onerror?.(null);
      await flush();
      h.timers[h.timers.length - 1]!.fn();
      await flush();
      h.timers[h.timers.length - 1]!.fn(); // 404, 404: now at 4000
      await flush();
      status = 200;
      h.timers[h.timers.length - 1]!.fn();
      await flush();
      h.sources[1]!.onopen?.(null);
      status = 404;
      h.sources[1]!.onerror?.(null);
      await flush();
      expect(h.timers[h.timers.length - 1]!.ms).toBe(1000);
    });

    it("re-probes instead of reconnecting, and stays quiet while absent", async () => {
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
      expect(h.timers.every((t) => t.ms <= 5000)).toBe(true);
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
      h.timers[h.timers.length - 1]!.fn(); // the re-probe fires
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

  // ---- a probe that never answers -----------------------------------------
  // classifyFailure() awaits the probe with the source already closed and no
  // timer armed, so an unbounded probe is a permanent stall: nothing is
  // scheduled and nothing ever will be. A half-open mobile network — the exact
  // case that produces a hung request — also fires no `online`/`visible` event,
  // so instantRetry() is not a way out either.
  describe("a stalled probe", () => {
    /** A request that only ever settles by being aborted. */
    const hangingFetch = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });

    /** Swap in a fetch for one test, always restoring the real one. */
    async function withFetch(fake: unknown, body: () => Promise<void>) {
      const g = globalThis as unknown as { fetch: unknown };
      const orig = g.fetch;
      g.fetch = fake;
      try {
        await body();
      } finally {
        g.fetch = orig;
      }
    }

    it("gives up instead of hanging, reporting the status as unknown", async () => {
      await withFetch(hangingFetch, async () => {
        await expect(probeViaFetch("/events/sess", 20)).resolves.toBeNull();
      });
    });

    it("still reports a real status, releasing the live stream body", async () => {
      let cancelled = false;
      const ok = async () => ({
        status: 200,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      });
      await withFetch(ok, async () => {
        await expect(probeViaFetch("/events/sess", 50)).resolves.toBe(200);
      });
      expect(cancelled).toBe(true); // the EventSource, not the probe, reads events
    });

    it("does not strand the stream: a reconnect is still scheduled", async () => {
      await withFetch(hangingFetch, async () => {
        const h = harness(() => 200, {
          probeStatus: (url) => probeViaFetch(url, 20),
        });
        h.client.connect();
        h.sources[0]!.onerror?.(null);

        await new Promise((r) => setTimeout(r, 80)); // outlast the probe timeout
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0]!.ms).toBe(75); // the normal backoff ladder
        expect(h.statuses[h.statuses.length - 1]).toBe("reconnecting");
      });
    });
  });

  // ---- waking onto a dead-but-open stream ---------------------------------
  // A socket killed while the phone slept, or dropped by a NAT rebind, reports
  // no error to the browser: the EventSource stays "open" and simply never
  // delivers again. `this.source` is therefore non-null, which used to make
  // instantRetry() a no-op on exactly the two signals — tab-visible and
  // network-online — that mark the moment such a socket most likely died.
  describe("waking onto a dead-but-open stream", () => {
    it("leaves a stream that is still delivering alone", () => {
      const h = harness();
      h.client.connect();
      h.sources[0]!.onopen?.(null);
      h.advance(30_000); // inside the stall window — the stream looks alive
      h.client.instantRetry();
      expect(h.sources).toHaveLength(1);
      expect(h.sources[0]!.closed).toBe(false);
    });

    it("drops and rebuilds a source that has gone silent, resuming from the cursor", () => {
      const h = harness();
      h.client.connect();
      h.sources[0]!.onopen?.(null);
      h.sources[0]!.onmessage?.({ data: line({ id: 4, kind: "text", body: "a" }) });

      h.advance(46_000); // past 2× the server's 20s heartbeat
      h.client.instantRetry();

      expect(h.sources[0]!.closed).toBe(true);
      expect(h.sources).toHaveLength(2);
      expect(h.sources[1]!.url).toBe("/events/sess?lastEventId=4&rev=1");
    });

    it("counts any inbound frame as proof of life, even one it discards", () => {
      const h = harness();
      h.client.connect();
      h.advance(40_000);
      h.sources[0]!.onmessage?.({ data: "not json" }); // dropped by the parser…
      h.advance(40_000); // …but the socket delivered it, so the clock restarts
      h.client.instantRetry();
      expect(h.sources).toHaveLength(1);
      expect(h.received).toHaveLength(0);
    });

    it("revalidates when the network comes back online", () => {
      const h = harness();
      h.client.start();
      h.sources[0]!.onopen?.(null);
      h.advance(60_000);

      window.dispatchEvent(new Event("online"));

      expect(h.sources).toHaveLength(2);
      h.client.close();
    });

    it("revalidates when the tab becomes visible again", () => {
      const h = harness();
      h.client.start();
      h.sources[0]!.onopen?.(null);
      h.advance(60_000);

      expect(document.visibilityState).toBe("visible"); // jsdom's default
      document.dispatchEvent(new Event("visibilitychange"));

      expect(h.sources).toHaveLength(2);
      h.client.close();
    });

    it("stays shut once closed, however long it has been silent", () => {
      const h = harness();
      h.client.connect();
      h.client.close();
      h.advance(60_000);
      h.client.instantRetry();
      expect(h.sources).toHaveLength(1);
      expect(h.statuses[h.statuses.length - 1]).toBe("closed");
    });
  });
});

/**
 * Ids are per-source: a new transcript under the same session name starts again
 * at 1. A client holding id 5,000 then asks for the gap above 5,000, is answered
 * with nothing — which is exactly what "you are up to date" looks like — and
 * shows the previous conversation for as long as the tab stays open. That is
 * how an answer card stayed docked over a dialog answered in the terminal
 * minutes earlier: the transcript behind it had stopped arriving.
 */
describe("SseClient resync", () => {
  const ready = (over: Record<string, unknown> = {}) => ({ head: 9, epoch: "aaaa", ...over });

  it("starts over when the log it resumes onto is not the one it holds", async () => {
    const resets: number[] = [];
    const h = harness(() => 200, { onReset: () => resets.push(1) });
    h.client.connect();
    h.sources[0]!.emit("ready", ready());
    h.sources[0]!.onmessage?.({ data: line({ id: 5000, kind: "text", body: "old" }) });
    expect(h.client.cursor).toBe(5000);

    h.sources[0]!.onerror?.(null);
    await flush();
    h.timers[0]!.fn();
    // It names the log its ids belong to, so a server that is not that log
    // sends the ready frame without first replaying a gap it would discard.
    expect(h.sources[1]!.url).toBe("/events/sess?lastEventId=5000&epoch=aaaa&rev=1");

    // A different transcript answers: same session name, a log of its own.
    h.sources[1]!.emit("ready", ready({ head: 3, epoch: "bbbb" }));

    expect(resets).toHaveLength(1);
    expect(h.sources[1]!.closed).toBe(true);
    expect(h.client.cursor).toBe(0);
    expect(h.sources[2]!.url).toBe("/events/sess?rev=1"); // the whole window again
  });

  it("starts over when the log comes back shorter than the cursor it holds", async () => {
    const resets: number[] = [];
    const h = harness(() => 200, { onReset: () => resets.push(1) });
    h.client.connect();
    h.sources[0]!.emit("ready", ready());
    h.sources[0]!.onmessage?.({ data: line({ id: 5000, kind: "text", body: "old" }) });

    h.sources[0]!.onerror?.(null);
    await flush();
    h.timers[0]!.fn();
    h.sources[1]!.emit("ready", ready({ head: 340 })); // same epoch, rebuilt log

    expect(resets).toHaveLength(1);
    expect(h.client.cursor).toBe(0);
  });

  // Found live on 2026-09-27: a source that had appended pane readings was
  // dropped while nobody watched and rebuilt over the same transcript. The
  // rebuilt one numbers the transcript's events lower, reports the replayable
  // epoch and a head ABOVE the cursor, and the resume skipped five events. The
  // source now moves its epoch at its first live-only event and says so on
  // the stream; the client adopts it, so the rebuilt source reads as foreign.
  it("adopts an epoch the stream moves, and starts over against the old one", async () => {
    const resets: number[] = [];
    const epochs: string[] = [];
    const h = harness(() => 200, {
      onReset: () => resets.push(1),
      onEpoch: (e) => epochs.push(e),
    });
    h.client.connect();
    h.sources[0]!.emit("ready", ready());
    h.sources[0]!.emit("epoch", { epoch: "a-own" });
    h.sources[0]!.onmessage?.({ data: line({ id: 23, kind: "meta", body: "{}" }) });
    expect(epochs).toEqual(["a-own"]);
    expect(resets, "its own ids are still this source's").toHaveLength(0);

    h.sources[0]!.onerror?.(null);
    await flush();
    h.timers[0]!.fn();
    // The rebuilt source: the replayable epoch, and a longer log.
    h.sources[1]!.emit("ready", ready({ head: 40 }));
    expect(resets).toHaveLength(1);
    expect(h.client.cursor).toBe(0);
  });

  it("keeps its history across an ordinary reconnect", async () => {
    const resets: number[] = [];
    const readies: unknown[] = [];
    const h = harness(() => 200, {
      onReset: () => resets.push(1),
      onReady: (r) => readies.push(r),
    });
    h.client.connect();
    h.sources[0]!.emit("ready", ready({ head: 5000 }));
    h.sources[0]!.onmessage?.({ data: line({ id: 5000, kind: "text", body: "held" }) });

    h.sources[0]!.onerror?.(null);
    await flush();
    h.timers[0]!.fn();
    h.sources[1]!.emit("ready", ready({ head: 5001 }));

    expect(resets).toHaveLength(0);
    expect(h.client.cursor).toBe(5000);
    expect(readies).toHaveLength(2); // both openings were reported as finished
  });

  it("leaves a server that names no log alone", async () => {
    const resets: number[] = [];
    const h = harness(() => 200, { onReset: () => resets.push(1) });
    h.client.connect();
    h.sources[0]!.emit("ready", {}); // the older contract, mid-deploy
    h.sources[0]!.onmessage?.({ data: line({ id: 5000, kind: "text", body: "held" }) });

    h.sources[0]!.onerror?.(null);
    await flush();
    h.timers[0]!.fn();
    h.sources[1]!.emit("ready", {});

    expect(resets).toHaveLength(0);
    expect(h.client.cursor).toBe(5000);
  });
});

/**
 * The agent panel's frame (design step 2 puts it on the wire): a named
 * `agents` event carrying the whole set. It arrives after `state` on every
 * open and again on change, and it is not part of the id space, so nothing
 * about it touches the cursor.
 */
describe("the agents frame", () => {
  const frame = {
    at: 1_790_000_000_000,
    agents: [{ id: "a1", description: "Find prior art", state: "running", tool: "Read" }],
    workflows: [],
  };

  it("hands the parsed set to onAgents", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onAgents: (a) => got.push(a) });
    h.client.connect();
    h.sources[0]!.emit("agents", frame);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ at: 1_790_000_000_000, agents: [{ id: "a1", tool: "Read" }] });
  });

  it("leaves the cursor alone", () => {
    const h = harness(() => 200, { onAgents: () => {} });
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: line({ id: 7, kind: "text", body: "a" }) });
    h.sources[0]!.emit("agents", frame);
    expect(h.client.cursor).toBe(7);
  });

  it("drops a frame that is not a set", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onAgents: (a) => got.push(a) });
    h.client.connect();
    h.sources[0]!.emit("agents", 42);
    h.sources[0]!.emit("agents", [frame]);
    expect(got).toEqual([]);
  });

  it("counts the frame as proof the stream is alive", () => {
    const h = harness(() => 200, { onAgents: () => {}, stallTimeoutMs: 1000 });
    h.client.connect();
    h.advance(5000);
    h.sources[0]!.emit("agents", frame);
    // A wake signal right after it trusts the stream rather than rebuilding it.
    h.client.instantRetry();
    expect(h.sources).toHaveLength(1);
  });
});

/**
 * The mod streams the reply as it is written (ADR-0036): `delta` payloads on
 * the live lane with no `id:` line. They are not events, never move the
 * cursor, and must not be swallowed by the id dedup (their id is 0).
 */
describe("delta frames", () => {
  const delta = {
    id: 0,
    kind: "delta",
    session: "sess",
    turnId: "t7",
    stream: "text",
    block: 1,
    body: "one to a few words",
    at: 1_790_900_000_000,
  };

  it("hands a delta to onDelta and leaves the cursor alone", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onDelta: (d) => got.push(d) });
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: line({ id: 7, kind: "text", body: "a" }) });
    h.sources[0]!.onmessage?.({ data: JSON.stringify(delta) });
    expect(got).toEqual([
      {
        kind: "delta",
        session: "sess",
        turnId: "t7",
        stream: "text",
        block: 1,
        body: "one to a few words",
        at: 1_790_900_000_000,
      },
    ]);
    expect(h.received.map((e) => e.id)).toEqual([7]);
    expect(h.client.cursor).toBe(7);
  });

  // sessionio's Event marks `block` omitempty, so block 0 has no field.
  it("reads a delta with no block as the response's first block", () => {
    const got: { block: number }[] = [];
    const h = harness(() => 200, { onDelta: (d) => got.push(d) });
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: JSON.stringify({ ...delta, block: undefined }) });
    expect(got.map((d) => d.block)).toEqual([0]);
  });

  it("drops a delta for a stream it does not know", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onDelta: (d) => got.push(d) });
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: JSON.stringify({ ...delta, stream: "tool" }) });
    h.sources[0]!.onmessage?.({ data: JSON.stringify({ ...delta, block: "1" }) });
    expect(got).toEqual([]);
  });
});

/**
 * A Claude session that started before the mod has no event stream yet: the
 * server says so with a `nomod` frame instead of history, holds the stream
 * open, and closes it once the mod connects.
 */
describe("the nomod frame", () => {
  it("hands the restart policy to onNoMod", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onNoMod: (n) => got.push(n) });
    h.client.connect();
    h.sources[0]!.emit("nomod", { restart: "when-idle" });
    expect(got).toEqual([{ restart: "when-idle" }]);
  });

  it("reads a frame with no usable payload as no policy", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onNoMod: (n) => got.push(n) });
    h.client.connect();
    h.sources[0]!.emit("nomod", "x");
    expect(got).toEqual([{}]);
  });
});

/**
 * A new session's Claude takes seconds to reach the lobby. The server holds the
 * stream open with a `starting` frame instead of answering 404, and ends it at
 * the hello (session-events/nomod.go).
 */
describe("the starting frame", () => {
  it("hands its wait to onStarting", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onStarting: (s) => got.push(s) });
    h.client.connect();
    h.sources[0]!.emit("starting", { waitS: 30 });
    expect(got).toEqual([{ waitS: 30 }]);
  });

  it("passes on that Claude has exited", () => {
    const got: unknown[] = [];
    const h = harness(() => 200, { onNoMod: (n) => got.push(n) });
    h.client.connect();
    h.sources[0]!.emit("nomod", { claude: "exited" });
    expect(got).toEqual([{ claude: "exited" }]);
  });
});

/**
 * What the stream has delivered, by frame, for the blank telemetry: it is what
 * tells "nothing arrived" from "it arrived and was not drawn".
 */
describe("frame counts", () => {
  it("counts each kind of frame and each error", async () => {
    const h = harness(() => 200);
    h.client.connect();
    const s = h.sources[0]!;
    s.emit("state", { mode: "default" });
    s.emit("back", { id: 2, kind: "user", session: "sess" });
    s.emit("back", { id: 1, kind: "user", session: "sess" });
    s.emit("ready", { head: 2, epoch: "aaaa" });
    s.onmessage?.({ data: JSON.stringify({ id: 3, kind: "text", session: "sess" }) });
    s.onerror?.({});
    await Promise.resolve();
    expect(h.client.frames()).toMatchObject({ state: 1, back: 2, ready: 1, live: 1, errors: 1 });
  });
});

/**
 * The heartbeat names the newest event the server holds (session-events
 * sse.go), which is what lets the view tell a quiet session from a stream that
 * stopped delivering (telemetry/stale.ts).
 */
describe("the head frame", () => {
  it("hands the server's head to onHead and counts it", () => {
    const got: number[] = [];
    const h = harness(() => 200, { onHead: (n) => got.push(n) });
    h.client.connect();
    h.sources[0]!.emit("head", { head: 42 });
    h.sources[0]!.emit("head", { nope: 1 });
    expect(got).toEqual([42]);
    expect(h.client.frames().head).toBe(2);
  });

  it("reports the cursor it holds", () => {
    const h = harness(() => 200);
    h.client.connect();
    h.sources[0]!.onmessage?.({ data: JSON.stringify({ id: 9, kind: "text", session: "sess" }) });
    expect(h.client.cursor).toBe(9);
  });
});
