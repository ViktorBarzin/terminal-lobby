/**
 * The machine reading after it has arrived: what the store does with it, and
 * the direct read the Right now panel switches on while someone is watching.
 *
 * The arrival itself — the X-TL-Machine header, the parser, what a malformed
 * value must not do to the call it rode on — is machine.wire.test.ts, and is
 * deliberately not repeated here.
 *
 * Two things these cases are really about. A reading that did not arrive leaves
 * the channel `unknown` and never healthy, which is the invariant the whole
 * status model rests on. And the panel's read is SWITCHED ON: it has to stop
 * when the panel closes and while the tab is hidden, or a phone in a pocket
 * spends twelve requests a minute all day on a number nobody is looking at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStatusStore } from "../src/diagnostics/status-store";
import {
  MACHINE_HEADER,
  MACHINE_POLL_MS,
  currentMachineReport,
  currentMachineSeries,
  fetchMachine,
  listSessions,
  noteMachineHeader,
  putLayout,
  onMachineReport,
  parseMachineReport,
  parseMachineSeries,
  resetMachineState,
  startMachineFastPoll,
} from "../src/lib/lobby-api";
import { apiUrl } from "../src/lib/config";
import type { Channel } from "../src/diagnostics/status";

/** A verdict as tmux-api marshals it (health.go `healthVerdict`). */
const verdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  windowSeconds: 600,
  partialWindow: false,
  source: "psi",
  ...over,
});

const point = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: 1_757_000_000,
  res: "io",
  pct: 1.4,
  ofLimit: 0.028,
  ...over,
});

/**
 * The whole GET /machine body, exactly as the server writes it: a `verdict`
 * key carrying the same bytes X-TL-Machine does, and the hour behind it under
 * `series`. tmux-api/machine.go:90-93 marshals that pair, and
 * tmux-api/health.go:70 documents it. The verdict is nested rather than spread
 * so that one parser and one validator serve both the header and the endpoint.
 */
const machineBody = (
  v: Record<string, unknown> = verdict(),
  series: unknown[] = [point()],
): Record<string, unknown> => ({ verdict: v, series });

const header = (over: Record<string, unknown> = {}): string => JSON.stringify(verdict(over));

const machineRow = (channels: readonly Channel[]): Channel => {
  const row = channels.find((c) => c.id === "machine");
  if (!row) throw new Error("no machine row");
  return row;
};

/** A fetch that answers /machine with `payload`, recording the URLs asked. */
function answering(payload: unknown, ok = true) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    urls.push(String(url));
    return { ok, json: async () => payload } as Response;
  });
  return { fn: fn as unknown as typeof fetch, urls, calls: fn };
}

/** A document whose visibility a test can change, and whose listeners it can
 *  fire and then watch being removed. */
function fakeDoc(visibility: DocumentVisibilityState = "visible") {
  const h: Record<string, () => void> = {};
  const doc = {
    addEventListener: (k: string, fn: () => void) => void (h[k] = fn),
    removeEventListener: (k: string) => void delete h[k],
    visibilityState: visibility,
  };
  return { h, doc };
}

beforeEach(() => {
  resetMachineState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetMachineState();
});

describe("the machine as the sixth provider", () => {
  it("starts unknown, because nothing has reported yet", () => {
    const store = createStatusStore();
    expect(machineRow(store.channels())).toMatchObject({
      state: "unknown",
      detail: "not reporting",
    });
    store.dispose();
  });

  it("takes a reading pushed straight in, like the other five channels", () => {
    const store = createStatusStore();
    store.setMachine({
      state: "degraded",
      worst: "cpu",
      cpuPct: 22,
      ioPct: 0,
      memPct: 0,
      load1: 40,
      nproc: 32,
      tier: "very-busy",
      memAvailableMb: 9_000,
      memTotalMb: 23_000,
      windowSeconds: 600,
      partialWindow: false,
      source: "psi",
    });
    expect(machineRow(store.channels())).toMatchObject({
      state: "degraded",
      detail: "the processor is busy",
      tier: "very-busy",
    });
    expect(store.machine()?.cpuPct).toBe(22);
    store.dispose();
  });

  /**
   * THE ONE CASE WORTH READING TWICE. Busy and very-busy share a state and
   * share a phrase: while IO is the worst resource both rows say "waiting on
   * the disk" and both are amber. The tier is the only thing that separates
   * them, and the tier is what picks the sentence at the top of the panel —
   * "may feel slow" against "is slow right now".
   *
   * So a store that decides "nothing changed" from the state and the words
   * alone silently drops the escalation, and the panel goes on offering the
   * gentler sentence through a sustained grind. It is invisible in every other
   * test because every other channel's states already carry their own depth.
   */
  it("notices a tier change that does not change a single word of the row", () => {
    const store = createStatusStore();
    noteMachineHeader(header({ state: "degraded", tier: "busy", worst: "io", ioPct: 61 }));
    noteMachineHeader(header({ state: "degraded", tier: "very-busy", worst: "io", ioPct: 140 }));
    expect(machineRow(store.channels()).tier).toBe("very-busy");
    store.dispose();
  });

  /**
   * The reading rides a poll that may well have answered before this store was
   * built. Without the seed the row would sit at "not reporting" until the next
   * one, five seconds later, on an answer already in hand.
   */
  it("starts from a reading that arrived before it existed", () => {
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));
    const store = createStatusStore();
    expect(machineRow(store.channels()).state).toBe("degraded");
    store.dispose();
  });

  it("logs the machine falling out of working, like any other channel", () => {
    const store = createStatusStore();
    noteMachineHeader(header({ state: "working", tier: "fine" }));
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));
    expect(store.log().filter((e) => e.id === "machine")).toMatchObject([
      { from: "unknown", to: "working" },
      { from: "working", to: "degraded" },
    ]);
    store.dispose();
  });

  /** The five pushed channels have nothing to release. This one subscribes, so
   *  a store nobody disposed would go on repainting after its page was gone. */
  it("stops listening once disposed", () => {
    const store = createStatusStore();
    store.dispose();
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));
    expect(machineRow(store.channels()).state).toBe("unknown");
  });
});

describe("the direct read the panel switches on", () => {
  it("asks tmux-api through the API prefix, never the site root", async () => {
    const { fn, urls } = answering(machineBody());
    const { doc } = fakeDoc();
    const stop = startMachineFastPoll({ fetch: fn, doc });
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    stop();
    // API_BASE alone is EMPTY unless `?api=` is present — the service prefix
    // lives in apiUrl. Built by hand this asks the SITE root, 404s, and reports
    // a healthy box as not reporting, which is the bug the /health probe
    // shipped with once already (probes.ts's own header records it).
    expect(urls[0]).toBe(apiUrl("/machine"));
    expect(urls[0]).not.toBe("/machine");
  });

  /**
   * THE SHAPE THE SERVER ACTUALLY SENDS. `handleMachine` writes
   * `{"verdict": {…}, "series": […]}` (tmux-api/machine.go:90-93), documented
   * at tmux-api/health.go:70, with the verdict nested so that the header and
   * the endpoint share one parser.
   *
   * A client that reads the verdict's fields off the envelope instead finds no
   * `state` there, drops the whole reading, and answers null — so the panel's
   * poll and Run check both report "not reporting" against a healthy box that
   * is answering them correctly. Nothing else catches it: every other test in
   * this file and in machine.wire.test.ts hands the parser a body of its own.
   */
  it("reads the body tmux-api actually sends", async () => {
    const { fn } = answering(machineBody(verdict({ state: "degraded", tier: "busy", worst: "io" })));
    const got = await fetchMachine(fn);
    expect(got).toMatchObject({ state: "degraded", tier: "busy", worst: "io" });
  });

  it("asks at once, keeps asking, and stops when the panel closes", async () => {
    vi.useFakeTimers();
    const { fn, calls } = answering(machineBody());
    const { doc } = fakeDoc();

    const stop = startMachineFastPoll({ fetch: fn, doc });
    await vi.advanceTimersByTimeAsync(0);
    // Straight away rather than one interval later: the sparkline would
    // otherwise be empty for the first seconds of every visit, which is most
    // visits.
    expect(calls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS);
    expect(calls).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS * 3);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("unregisters its visibility listener when the panel closes", () => {
    const { fn } = answering(machineBody());
    const { h, doc } = fakeDoc();
    const stop = startMachineFastPoll({ fetch: fn, doc });
    expect(Object.keys(h)).toContain("visibilitychange");
    stop();
    expect(Object.keys(h)).toHaveLength(0);
  });

  /**
   * The session poll parks entirely while the tab is hidden (store/lobby.ts),
   * and this one has even less excuse to keep running: it exists only for the
   * moment somebody is watching a number move.
   */
  it("parks while the tab is hidden and asks again on the way back", async () => {
    vi.useFakeTimers();
    const { fn, calls } = answering(machineBody());
    const { h, doc } = fakeDoc();

    const stop = startMachineFastPoll({ fetch: fn, doc });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveBeenCalledTimes(1);

    doc.visibilityState = "hidden";
    h.visibilitychange?.();
    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS * 4);
    expect(calls).toHaveBeenCalledTimes(1);

    doc.visibilityState = "visible";
    h.visibilitychange?.();
    await vi.advanceTimersByTimeAsync(0);
    // Immediately, not at the next tick: what is on screen is as old as the
    // time the tab spent in a pocket.
    expect(calls).toHaveBeenCalledTimes(2);
    stop();
  });

  /**
   * Armed off the answer rather than on an interval. setInterval keeps firing
   * into a request that has not come back, so a link slow enough to overrun the
   * period builds a queue of reads that all land together — which is
   * store/lobby.ts's reasoning about its own poll.
   */
  it("never starts a second read while one is still out", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => new Promise<Response>(() => {}));
    const { doc } = fakeDoc();
    const stop = startMachineFastPoll({ fetch: fn as unknown as typeof fetch, doc });
    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS * 3);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("puts the fresh reading on the channel", async () => {
    const { fn } = answering(
      machineBody(verdict({ state: "degraded", tier: "very-busy", worst: "memory", memPct: 22 })),
    );
    const { doc } = fakeDoc();
    const store = createStatusStore();
    const stop = startMachineFastPoll({ fetch: fn, doc });
    await vi.waitFor(() =>
      expect(machineRow(store.channels())).toMatchObject({
        state: "degraded",
        detail: "low on memory",
        tier: "very-busy",
      }),
    );
    stop();
    store.dispose();
  });

  /**
   * A direct read that failed is not news about the box, so it must not blank a
   * reading the header already delivered. The row would otherwise flicker to
   * "not reporting" and back every few seconds on a page whose session poll is
   * perfectly healthy.
   */
  it.each([
    ["a body that is not a reading", { ok: true, payload: { hello: "world" } }],
    ["a verdict this model has no rule for", { ok: true, payload: machineBody(verdict({ state: "sideways" })) }],
    ["a 404 from a server older than the endpoint", { ok: false, payload: machineBody() }],
  ])("keeps the last good reading when /machine answers %s", async (_what, c) => {
    const { fn, calls } = answering(c.payload, c.ok);
    const { doc } = fakeDoc();
    const store = createStatusStore();
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));

    const stop = startMachineFastPoll({ fetch: fn, doc });
    await vi.waitFor(() => expect(calls).toHaveBeenCalled());
    stop();
    expect(machineRow(store.channels()).state).toBe("degraded");
    store.dispose();
  });

  it("keeps the last good reading when /machine does not answer at all", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("offline")));
    const { doc } = fakeDoc();
    const store = createStatusStore();
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));

    const stop = startMachineFastPoll({ fetch: fn as unknown as typeof fetch, doc });
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    stop();
    expect(machineRow(store.channels()).state).toBe("degraded");
    store.dispose();
  });
});

describe("the hour behind the sparkline", () => {
  /**
   * A point drawn from junk is worse than a missing point: the line is the part
   * of the row a reader takes in without reading it, so a zero invented from a
   * malformed entry says "the box was fine then" about a moment nobody
   * measured. After a restart the line is short, and short is the honest shape.
   */
  it.each([
    ["a resource nothing in the model declares", point({ res: "gpu" })],
    ["no resource at all", { at: 1, pct: 1, ofLimit: 1 }],
    ["null", null],
    ["a bare number", 7],
    ["a string", "busy"],
  ])("drops %s rather than drawing it as zero", (_what, bad) => {
    expect(parseMachineSeries([point(), bad])).toHaveLength(1);
  });

  it("reads a figure that arrived unusable as zero rather than NaN", () => {
    const [p] = parseMachineSeries([point({ at: "soon", pct: null, ofLimit: undefined })]);
    expect(p).toMatchObject({ at: 0, pct: 0, ofLimit: 0, res: "io" });
  });

  it.each([
    ["not an array", { at: 1 }],
    ["absent", undefined],
    ["null", null],
  ])("reads a series that is %s as an empty hour, not as a failure", (_what, raw) => {
    expect(parseMachineSeries(raw)).toEqual([]);
  });

  it("arrives with the endpoint, since no header could carry it", async () => {
    const { fn } = answering(
      machineBody(verdict(), [point(), point({ at: 1_757_000_010, res: "cpu", pct: 12, ofLimit: 1.2 })]),
    );
    await fetchMachine(fn);
    expect(currentMachineSeries()).toHaveLength(2);
    expect(currentMachineSeries()[1]).toMatchObject({ res: "cpu", ofLimit: 1.2 });
  });

  it("is not touched by a header, which has no series to give", async () => {
    const { fn } = answering(machineBody());
    await fetchMachine(fn);
    noteMachineHeader(header({ state: "degraded", tier: "busy" }));
    expect(currentMachineSeries()).toHaveLength(1);
    expect(currentMachineReport()?.state).toBe("degraded");
  });
});

/**
 * The ride itself — the delivery design the whole feature rests on. The reading
 * is stamped on whichever request landed last, in the one place every lobby
 * call passes through, which is what lets the sixth channel cost no request of
 * its own in the common case.
 *
 * Exercised through a real `listSessions()` rather than by calling the sink
 * directly, because the wiring is the part that can go missing: a parser nobody
 * feeds passes every test of its own and reports "not reporting" forever in the
 * browser.
 */
describe("riding the request the app was making anyway", () => {
  /** A /sessions answer carrying whatever header value it is given, or none. */
  const sessionsFetch = (value?: string) =>
    vi.fn(() =>
      Promise.resolve(
        new Response("[]", { headers: value === undefined ? {} : { [MACHINE_HEADER]: value } }),
      ),
    );

  it("takes the verdict off an ordinary session poll", async () => {
    vi.stubGlobal("fetch", sessionsFetch(header({ state: "degraded", tier: "busy", worst: "io" })));
    const store = createStatusStore();

    await listSessions();

    expect(machineRow(store.channels())).toMatchObject({
      state: "degraded",
      detail: "waiting on the disk",
      tier: "busy",
    });
    store.dispose();
  });

  /**
   * The header is read in `req`, not at the /sessions call site, so the
   * freshest answer comes from whichever request happened last. The session
   * poll is the one that dominates in practice, but a layout write on a page
   * nobody is polling is just as good a ride, and reading it only off the poll
   * would go stale on exactly the screens that make other calls.
   */
  it("reads it off any call, not only the one that polls", async () => {
    vi.stubGlobal(
      "fetch",
      sessionsFetch(header({ state: "degraded", tier: "very-busy", worst: "cpu" })),
    );
    const store = createStatusStore();

    await putLayout({ projects: [], ungrouped: [] } as never);

    expect(machineRow(store.channels())).toMatchObject({ state: "degraded", tier: "very-busy" });
    store.dispose();
  });

  it("leaves the channel unknown when no header came back at all", async () => {
    vi.stubGlobal("fetch", sessionsFetch());
    const store = createStatusStore();

    await listSessions();

    expect(currentMachineReport()).toBeNull();
    expect(machineRow(store.channels()).state).toBe("unknown");
    store.dispose();
  });

  /**
   * A server mid-deploy, a proxy that rewrote the value, a client older than
   * the shape it is reading. None of those is worth an exception thrown out of
   * the call that fetches the session list — a header about how busy the box is
   * must never become the reason the list fails to load.
   */
  it.each([
    ["not JSON at all", "very busy"],
    ["truncated JSON", '{"state":"degra'],
    ["a bare number", "42"],
    ["an array", "[]"],
    ["a JSON null", "null"],
    ["JSON that is not a verdict", '{"hello":"world"}'],
  ])("leaves the channel unknown on a header that is %s, and still loads", async (_what, value) => {
    vi.stubGlobal("fetch", sessionsFetch(value));
    const store = createStatusStore();

    await expect(listSessions()).resolves.toEqual([]);

    expect(machineRow(store.channels()).state).toBe("unknown");
    store.dispose();
  });

  /**
   * Silence is not news about the box. Most responses in the life of a tab
   * carry no header — every call to a service that is not tmux-api, every
   * answer from one too old to stamp it — and blanking the row on each would
   * flicker a good reading to "not reporting" and back every few seconds.
   */
  it("keeps the last good reading when a later response carries none", async () => {
    vi.stubGlobal("fetch", sessionsFetch(header({ state: "degraded", tier: "busy" })));
    await listSessions();
    vi.stubGlobal("fetch", sessionsFetch());
    await listSessions();
    expect(currentMachineReport()?.state).toBe("degraded");
  });
});

describe("subscribers", () => {
  /** Everything the row prints beside the graph has to survive the wire. A
   *  field quietly dropped in the parser reads on screen as a figure that is
   *  simply missing rather than as a bug. */
  it("carries every figure the panel prints beside the row", () => {
    noteMachineHeader(
      header({ cpuPct: 12.5, ioPct: 61, memPct: 2, load1: 30.25, memAvailableMb: 4_096 }),
    );
    expect(currentMachineReport()).toMatchObject({
      cpuPct: 12.5,
      ioPct: 61,
      memPct: 2,
      load1: 30.25,
      memAvailableMb: 4_096,
    });
  });

  /** A header that did not parse is not a reading, so it must not wake anyone.
   *  Notifying with null would push every subscriber back to "not reporting" on
   *  one malformed response, discarding a good reading from a second ago. */
  it("are not told about a header that did not parse", () => {
    const seen: number[] = [];
    onMachineReport(() => void seen.push(1));
    noteMachineHeader("{{{");
    noteMachineHeader(null);
    expect(seen).toEqual([]);
  });

  it("hear every reading, and stop on unsubscribe", () => {
    const seen: (number | undefined)[] = [];
    const off = onMachineReport((r) => void seen.push(r?.load1));

    noteMachineHeader(header({ load1: 1 }));
    noteMachineHeader(header({ load1: 2 }));
    off();
    noteMachineHeader(header({ load1: 3 }));

    expect(seen).toEqual([1, 2]);
  });

  it("keep hearing when one of them throws", () => {
    const seen: number[] = [];
    onMachineReport(() => {
      throw new Error("a panel mid-teardown");
    });
    onMachineReport((r) => void seen.push(r?.load1 ?? -1));

    expect(() => noteMachineHeader(header({ load1: 7 }))).not.toThrow();
    expect(seen).toEqual([7]);
  });
});

describe("what the parser accepts", () => {
  it.each([
    ["a number", 3],
    ["a string", "working"],
    ["null", null],
    ["an array of verdicts", [verdict()]],
    ["an object with no state", { tier: "busy" }],
    ["a state this model has no rule for", verdict({ state: "sideways" })],
  ])("refuses %s", (_what, raw) => {
    expect(parseMachineReport(raw)).toBeNull();
  });

  /**
   * tmux-api spells the no-PSI path "fallback" and the pure model declares
   * "load". The row's own words branch on it — "Fine" against "Fine, by load
   * average" — so both spellings have to land on the same reading rather than
   * one of them falling through to "unknown".
   */
  it.each(["load", "fallback"])("reads the no-PSI source spelled %s", (source) => {
    expect(parseMachineReport(verdict({ source, worst: "load" }))?.source).toBe("load");
  });

  it("reads a source it has no rule for as no reading at all", () => {
    expect(parseMachineReport(verdict({ source: "ebpf" }))?.source).toBe("unknown");
  });

  it.each([
    ["null", null],
    ["a string", "12.5"],
    ["missing", undefined],
  ])("shows a figure that arrived as %s as zero rather than NaN", (_what, bad) => {
    expect(parseMachineReport(verdict({ cpuPct: bad }))?.cpuPct).toBe(0);
  });

  /** The panel divides load1 by it, and an Infinity where a number belongs is
   *  the sort of thing a reader remembers. */
  it.each([0, -4, undefined])("floors nproc at one core when it arrives as %s", (nproc) => {
    expect(parseMachineReport(verdict({ nproc }))?.nproc).toBe(1);
  });

  /** A verdict that reached degraded without saying how busy gets the quieter
   *  of the two sentences, which is all the threshold it crossed supports. */
  it("reads an unusable tier as the quieter sentence the state can support", () => {
    expect(parseMachineReport(verdict({ tier: "catastrophic", state: "degraded" }))?.tier).toBe("busy");
    expect(parseMachineReport(verdict({ tier: "catastrophic", state: "working" }))?.tier).toBe("fine");
  });

  /**
   * Only an explicit `false` claims a full ten-minute window. Anything else —
   * a field a server has not grown yet, a null — leaves the reading marked
   * partial, which is the direction that cannot overstate what was measured.
   */
  it.each([
    [false, false],
    [true, true],
    [undefined, true],
    ["no", true],
  ])("reads partialWindow %s as %s", (raw, expected) => {
    expect(parseMachineReport(verdict({ partialWindow: raw }))?.partialWindow).toBe(expected);
  });
});

describe("the header name", () => {
  /** Spelled out rather than compared to itself: the two copies of this string,
   *  here and in tmux-api, are the whole contract, and a rename on one side
   *  stops the feature silently on the other. */
  it("is the one tmux-api stamps", () => {
    expect(MACHINE_HEADER).toBe("X-TL-Machine");
  });
});
