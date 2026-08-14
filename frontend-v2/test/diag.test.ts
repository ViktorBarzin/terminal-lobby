import { describe, it, expect } from "vitest";

/**
 * These tests import frontend/diag.js itself, so what is asserted is the exact
 * module the deploy scripts inline into all three surfaces
 * (docs/adr/0008-client-diagnostics.md). It carries no import or export
 * statements, which is what lets one file be both a classic inlined script and
 * a side-effect ES import here. A separate TypeScript port would drift from the
 * shipped bytes — term.html already carries dangling calls from exactly that
 * kind of drift, and that is the failure this module exists to avoid.
 */
import "../../frontend/diag.js";

interface Batch {
  kind: string;
  client: string;
  build: string;
  events: { name: string; attrs: Record<string, unknown> }[];
}

interface Harness {
  d: any;
  sent: Batch[];
  names: () => string[];
  last: (name: string) => Record<string, unknown> | undefined;
  at: (ms: number) => void;
  store: Map<string, string>;
}

/** Distinct per harness, so two simulated page lives do not mint the same ids
 *  from the same deterministic random sequence. */
let seedBase = 0;

/** `seed` models a second page life on the same browser: localStorage is
 *  already populated before the page starts. */
function harness(over: Record<string, unknown> = {}, seed?: Map<string, string>): Harness {
  const sent: Batch[] = [];
  const store = new Map<string, string>(seed);
  let clock = 0;
  seedBase += 977;
  let seq = seedBase;
  const d = (globalThis as any).tlDiag.create({
    now: () => clock,
    send: (b: Batch) => void sent.push(JSON.parse(JSON.stringify(b))),
    // Deterministic, in [0,1), and distinct per harness.
    random: () => {
      seq = (seq * 1103515245 + 12345) % 2147483648;
      return seq / 2147483648;
    },
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    client: "term",
    role: "terminal",
    session: "worktree",
    build: "abc1234",
    ...over,
  });
  const all = () => sent.flatMap((b) => b.events);
  return {
    d,
    sent,
    store,
    names: () => all().map((e) => e.name),
    last: (name: string) => {
      const hits = all().filter((e) => e.name === name);
      return hits.length ? hits[hits.length - 1].attrs : undefined;
    },
    at: (ms: number) => {
      clock = ms;
      d.tick();
    },
  };
}

describe("rollup windows", () => {
  it("reports a window only when the tab was visible and saw traffic", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.d.onWsSend(12);
    h.at(60_000);

    expect(h.names()).toContain("perf.rollup");
    expect(h.last("perf.rollup")!["tl.win_s"]).toBe(60);
  });

  it("stays quiet through a visible window with no traffic, and heartbeats instead", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(60_000);
    h.at(120_000);

    expect(h.names()).not.toContain("perf.rollup");

    h.at(300_000);
    expect(h.names()).toContain("app.alive");
    expect(h.last("app.alive")!["tl.state"]).toBe("idle");
  });

  it("does not measure while hidden, and says so in the heartbeat", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.setVisible(false);
    h.d.onKeydown(); // arrives while hidden — throttled timers make it noise
    h.at(60_000);

    expect(h.names()).not.toContain("perf.rollup");
    h.at(300_000);
    expect(h.last("app.alive")!["tl.state"]).toBe("hidden");
  });

  it("keeps measuring a visible tab that does not have focus", () => {
    // A terminal rendering a long Claude turn in a background window is a real
    // rendering-performance case; focus is deliberately not part of "active".
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.setFocused(false);
    h.d.onWsRecv(4096);
    h.at(60_000);

    expect(h.names()).toContain("perf.rollup");
  });
});

describe("percentiles", () => {
  it("reports nearest-rank p50, p95 and max", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    for (let i = 1; i <= 100; i++) h.d.onInputLatency(i);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.input.n"]).toBe(100);
    expect(r["tl.input.p50"]).toBe(50);
    expect(r["tl.input.p95"]).toBe(95);
    expect(r["tl.input.max"]).toBe(100);
  });

  it("stays bounded past the sample cap without losing the count", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    for (let i = 0; i < 5000; i++) h.d.onInputLatency(i % 50);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.input.n"]).toBe(5000); // the true count survives
    expect(h.d.sampleCount("input")).toBeLessThanOrEqual(512);
  });

  it("starts each window from empty", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onInputLatency(500);
    h.at(60_000);
    h.d.onInputLatency(5);
    h.at(120_000);

    expect(h.last("perf.rollup")!["tl.input.max"]).toBe(5);
  });
});

describe("quiet-gated echo sampling", () => {
  it("takes a sample when the terminal was output-idle and one key went out", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000); // 1s of no output — gate is open
    h.d.onKeydown();
    h.d.onWsSend(1);
    h.at(1022);
    h.d.onWsRecv(1);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.echo.n"]).toBe(1);
    expect(r["tl.echo.p50"]).toBe(22);
  });

  it("refuses to sample when output was already flowing", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000);
    h.d.onWsRecv(4096); // Claude is mid-turn
    h.at(1100); // only 100ms of quiet — under the 300ms gate
    h.d.onKeydown();
    h.d.onWsSend(1);
    h.at(1120);
    h.d.onWsRecv(1);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.echo.n"] ?? 0).toBe(0);
  });

  it("counts an unmatched keystroke rather than inventing a latency", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000);
    h.d.onKeydown();
    h.d.onWsSend(1);
    h.at(4000); // past the 2000ms match deadline, nothing came back
    h.d.onWsRecv(1);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.echo.n"] ?? 0).toBe(0);
    expect(r["tl.echo.unmatched"]).toBe(1);
  });

  it("does not pair a second keystroke that went out before the echo", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000);
    h.d.onKeydown();
    h.d.onWsSend(1);
    h.at(1005);
    h.d.onKeydown(); // typing fast — this pair is ambiguous
    h.d.onWsSend(1);
    h.at(1030);
    h.d.onWsRecv(1);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.echo.n"] ?? 0).toBe(0);
  });
});

describe("stalls", () => {
  it("reports input that produced no output past the threshold", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000);
    h.d.onWsSend(1);
    h.at(5000);

    expect(h.names()).toContain("term.stall");
    expect(h.last("term.stall")!["tl.ms"]).toBeGreaterThanOrEqual(3000);
  });

  it("does not report a stall when output came back", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.at(1000);
    h.d.onWsSend(1);
    h.at(1200);
    h.d.onWsRecv(1);
    h.at(5000);

    expect(h.names()).not.toContain("term.stall");
  });
});

describe("the flight recorder", () => {
  it("attaches the most recent raw events to an incident", () => {
    const h = harness();
    h.d.boot();
    for (let i = 0; i < 50; i++) h.d.ring({ e: "key", i });
    h.d.incident("selection", {});

    const trace = h.last("diag.incident")!["tl.trace"] as { i: number }[];
    expect(trace).toHaveLength(30);
    expect(trace[trace.length - 1].i).toBe(49); // newest survives
    expect(trace[0].i).toBe(20);
  });

  it("stamps each ring entry with a relative time", () => {
    const h = harness();
    h.d.boot();
    h.at(1000);
    h.d.ring({ e: "key" });
    h.d.incident("stall", {});

    const trace = h.last("diag.incident")!["tl.trace"] as { t: number }[];
    expect(trace[0].t).toBe(1000);
  });

  it("carries the trace on a dropped connection too", () => {
    const h = harness();
    h.d.boot();
    h.d.ring({ e: "ws.send" });
    h.d.onConnDrop({ code: 1006, upS: 842, downMs: 2100 });

    expect(h.last("conn.dropped")!["tl.code"]).toBe(1006);
    expect(h.last("conn.dropped")!["tl.trace"]).toBeDefined();
  });
});

describe("exceptions", () => {
  it("records message, source and stack", () => {
    const h = harness();
    h.d.boot();
    h.d.onException(
      {
        message: "tlTrack is not defined",
        source: "term.html",
        line: 4737,
        col: 17,
        stack: "tlConfirmBoot@term.html:4737",
      },
      "onerror",
    );
    h.at(60_000); // exceptions are deduped across the window, so they go out at its close

    const e = h.last("app.exception")!;
    expect(e["tl.msg"]).toContain("tlTrack is not defined");
    expect(e["tl.src"]).toBe("term.html:4737:17");
    expect(e["tl.stack"]).toContain("tlConfirmBoot");
    expect(e["tl.kind"]).toBe("onerror");
  });

  it("collapses a looping error into one record with a count", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    for (let i = 0; i < 400; i++) {
      h.d.onException({ message: "boom", source: "a.js", line: 1, col: 1, stack: "f@a.js:1" }, "onerror");
    }
    h.at(60_000);

    const raised = h.names().filter((n) => n === "app.exception");
    expect(raised).toHaveLength(1);
    expect(h.last("app.exception")!["tl.n"]).toBe(400);
  });

  it("keeps distinct errors distinct", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onException({ message: "boom", source: "a.js", line: 1, col: 1, stack: "f@a.js:1" }, "onerror");
    h.d.onException({ message: "other", source: "b.js", line: 2, col: 1, stack: "g@b.js:2" }, "rejection");
    h.at(60_000);

    expect(h.names().filter((n) => n === "app.exception")).toHaveLength(2);
  });
});

describe("liveness and death", () => {
  it("clears its sentinel on a clean close", () => {
    const h = harness();
    h.d.boot();
    expect(h.store.has("tl_live")).toBe(true);
    h.d.close();
    expect(h.store.has("tl_live")).toBe(false);
  });

  it("reports the previous page life when the sentinel outlived it", () => {
    const first = harness();
    first.d.boot();
    first.at(120_000);
    // no close() — the tab was killed

    const second = harness({}, first.store);
    second.d.boot();

    expect(second.names()).toContain("app.died");
    expect(second.last("app.died")!["tl.prev_tab"]).toBeDefined();
    expect(second.last("app.died")!["tl.alive_s"]).toBeGreaterThan(0);
  });

  it("says nothing about death after a clean previous close", () => {
    const first = harness();
    first.d.boot();
    first.d.close();

    const second = harness({}, first.store);
    second.d.boot();

    expect(second.names()).not.toContain("app.died");
  });
});

describe("correlation", () => {
  it("stamps every record with the ids that stitch a tab together", () => {
    const h = harness({ parent: "8e21b7d4" });
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.tab"]).toBeTruthy();
    expect(r["tl.parent"]).toBe("8e21b7d4");
    expect(r["tl.device"]).toBeTruthy();
    expect(r["tl.session"]).toBe("worktree");
    expect(r["tl.role"]).toBe("terminal");
  });

  it("keeps the device id across page lives but mints a new tab id", () => {
    const first = harness();
    first.d.boot();
    const second = harness({}, first.store);
    second.d.boot();

    expect(second.d.ids().device).toBe(first.d.ids().device);
    expect(second.d.ids().tab).not.toBe(first.d.ids().tab);
  });

  it("counts connections within a page life", () => {
    const h = harness();
    h.d.boot();
    h.d.onConnOpen({ tokenMs: 12, handshakeMs: 30 });
    h.d.onConnOpen({ tokenMs: 9, handshakeMs: 25 });

    expect(h.last("conn.opened")!["tl.conn"]).toBe(2);
  });
});

describe("never breaking the page", () => {
  it("swallows a transport that throws", () => {
    const h = harness({
      send: () => {
        throw new Error("intake is down");
      },
    });
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    expect(() => h.at(60_000)).not.toThrow();
  });

  it("drops the batch rather than retrying into a growing buffer", () => {
    let fail = true;
    const seen: Batch[] = [];
    const h = harness({
      send: (b: Batch) => {
        if (fail) throw new Error("down");
        seen.push(JSON.parse(JSON.stringify(b)));
      },
    });
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.at(60_000);
    fail = false;
    h.d.onKeydown();
    h.at(120_000);

    expect(seen).toHaveLength(1);
    expect(seen[0].events).toHaveLength(1); // the failed batch is gone, not replayed
  });

  it("bounds the buffer when the transport never drains", () => {
    const h = harness({
      send: () => {
        throw new Error("down");
      },
    });
    h.d.boot();
    for (let i = 0; i < 5000; i++) {
      h.d.onException({ message: "e" + i, source: "a.js", line: i, col: 1, stack: "f" }, "onerror");
    }
    expect(h.d.buffered()).toBeLessThanOrEqual(200);
  });

  it("survives malformed measurement input", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    expect(() => {
      h.d.onInputLatency(NaN);
      h.d.onInputLatency(Infinity);
      h.d.onInputLatency(-1);
      h.d.onException(null, "onerror");
      h.d.ring(null);
      h.d.incident("k", null);
      h.at(60_000);
    }).not.toThrow();
  });
});

describe("opt-out", () => {
  it("sends nothing at all when disabled", () => {
    const h = harness({ enabled: false });
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.d.onException({ message: "boom", source: "a.js", line: 1, col: 1, stack: "f" }, "onerror");
    h.at(60_000);
    h.at(300_000);
    h.d.close();

    expect(h.sent).toHaveLength(0);
  });

  it("writes no sentinel when disabled, so it cannot report a death either", () => {
    const h = harness({ enabled: false });
    h.d.boot();
    expect(h.store.size).toBe(0);
  });
});

describe("batch shape", () => {
  it("labels the channel so the intake routes it to diagnostics", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.at(60_000);

    expect(h.sent[0].kind).toBe("diag");
    expect(h.sent[0].client).toBe("term");
    expect(h.sent[0].build).toBe("abc1234");
  });

  it("flushes what it has on close", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onKeydown();
    h.at(30_000); // mid-window
    h.d.close();

    const r = h.last("perf.rollup");
    expect(r).toBeDefined();
    expect(r!["tl.partial"]).toBe(true);
  });
});

describe("api timing", () => {
  it("rolls up per-endpoint duration and errors", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onApi("/layout", 10, 200);
    h.d.onApi("/layout", 30, 200);
    h.d.onApi("/layout", 20, 500);
    h.at(60_000);

    const r = h.last("perf.rollup")!;
    expect(r["tl.api.n"]).toBe(3);
    expect(r["tl.api.err"]).toBe(1);
    expect(r["tl.api.max"]).toBe(30);
  });

  it("raises a slow call on its own, with the request id that joins it server-side", () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.onApi("/layout", 812, 200, "f3a91c02-17");

    const s = h.last("api.slow")!;
    expect(s["tl.ep"]).toBe("/layout");
    expect(s["tl.ms"]).toBe(812);
    expect(s["tl.req"]).toBe("f3a91c02-17");
  });
});
