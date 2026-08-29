/**
 * tl.nav.load, and why it was 0 in every record ever collected.
 *
 * The boot context is built before the page has finished loading, so
 * loadEventEnd is legitimately 0 there and the value is re-emitted once `load`
 * lands. That re-emit shipped and did nothing: 22 of 22 records over three hours
 * still read 0, because `loadEventEnd` is only filled in AFTER the load event
 * has finished dispatching — reading it from inside a load listener returns 0,
 * and the guard against 0 then bailed every time. It looked like a working fix
 * from the outside, which is the part worth a test.
 *
 * This models exactly that: the navigation entry reports 0 while `load` is
 * dispatching and a real value once the task queue turns over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const DIAG = resolve(__dirname, "../..", "frontend/diag.js");

describe("the late navigation context", () => {
  it("reads loadEventEnd after the load event, not during it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    // Before `load`, loadEventEnd is 0 — which is why the boot context cannot
    // carry it and the re-emit exists at all.
    let phase: "before" | "dispatching" | "after" = "before";
    const loadHandlers: Array<() => void> = [];

    const navEntry = {
      responseStart: 100,
      responseEnd: 900,
      domContentLoadedEventEnd: 950,
      transferSize: 120_000,
      duration: 0,
      // The browser's actual behaviour: unset until the load event is over.
      get loadEventEnd() {
        return phase === "after" ? 1_200 : 0;
      },
    };

    const ctx: Record<string, unknown> = {
      performance: {
        now: () => 0,
        getEntriesByType: (t: string) => (t === "navigation" ? [navEntry] : []),
      },
      navigator: { userAgent: "test", sendBeacon: undefined },
      document: { addEventListener() {}, visibilityState: "visible", hidden: false },
      location: { pathname: "/", search: "", origin: "http://x" },
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval: () => {},
      fetch: async (_u: string, init?: { body?: string }) => {
        if (init?.body) {
          for (const rec of JSON.parse(init.body).events ?? []) sent.push(rec);
        }
        return { ok: true, status: 204, text: async () => "" };
      },
      window: {
        addEventListener: (type: string, fn: () => void) => {
          if (type === "load") loadHandlers.push(fn);
        },
        removeEventListener() {},
      },
    };
    ctx.globalThis = ctx;
    ctx.self = ctx;
    (ctx.window as Record<string, unknown>).performance = ctx.performance;

    runInNewContext(readFileSync(DIAG, "utf8"), ctx);
    const core = (ctx as { tlDiag: { bind(o: Record<string, unknown>): unknown } }).tlDiag;
    core.bind({ url: "/t", client: "lobby-v2", role: "lobby", build: "test", enabled: true });

    expect(
      loadHandlers.length,
      "a load listener must be registered while loadEventEnd is 0",
    ).toBeGreaterThan(0);

    // Fire load the way a browser does: during dispatch the value is still 0,
    // and it only appears once the event has finished.
    phase = "dispatching";
    for (const fn of loadHandlers) fn();
    phase = "after";
    // …and let the task the handler scheduled run.
    await new Promise((r) => setTimeout(r, 5));

    const late = sent.filter(
      (e) => (e as { attrs?: Record<string, unknown> }).attrs?.["tl.nav.load"],
    );
    expect(late.length, "no record carried a load time").toBeGreaterThan(0);
    const attrs = (late.at(-1) as { attrs: Record<string, unknown> }).attrs;
    expect(attrs["tl.nav.load"]).toBe(1_200);
    // The throughput the connection tier would read from the same load, so a
    // threshold chosen from a dozen samples keeps being checkable.
    expect(attrs["tl.nav.bps"]).toBeCloseTo(150, 0);
  });
});
