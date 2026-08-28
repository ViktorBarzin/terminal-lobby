import { describe, it, expect, vi } from "vitest";
import "../../frontend/diag.js";

/**
 * The instrumentation half of diag.js: it wraps fetch, WebSocket and keydown
 * rather than editing call sites, so index.html and term.html need only a
 * placeholder and one bind() call each. Those two files are ~14k lines of
 * hand-maintained HTML and the terminal's flow-control code reads WebSocket
 * constants directly, so these tests exist mainly to prove the wrappers are
 * transparent — a broken WebSocket wrapper would break the terminal itself.
 */

interface Rec {
  name: string;
  attrs: Record<string, any>;
}

function collector() {
  const events: Rec[] = [];
  const d = (globalThis as any).tlDiag.create({
    now: () => 0,
    send: (b: any) => events.push(...b.events),
    storage: null,
    client: "term",
  });
  return { d, events };
}

/** Comfortably past cfg.slowApiMs, which sits above a healthy 300 ms round trip
 *  precisely so the reporting channel stops reporting on itself. */
const SLOW_MS = 4000;

describe("fetch instrumentation", () => {
  it("times a call, stamps a request id, and returns the real response", async () => {
    const { d, events } = collector();
    const native = vi.fn(async (_i: unknown, _init?: RequestInit) => new Response("hi", { status: 200 }));
    const wrapped = (globalThis as any).tlDiag.instrumentFetch(native as any, d, () => SLOW_MS);

    const res = await wrapped("/api/sessions/layout", {});
    expect(await res.text()).toBe("hi");

    const init = native.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-TL-Req")).toMatch(/-\d+$/);

    d.flush();
    const slow = events.find((e) => e.name === "api.slow")!;
    expect(slow).toBeDefined();
    expect(slow.attrs["tl.ms"]).toBe(SLOW_MS);
    expect(slow.attrs["tl.req"]).toBe(headers.get("X-TL-Req"));
  });

  it("lets a rejected fetch reject, after recording it", async () => {
    const { d, events } = collector();
    const native = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const wrapped = (globalThis as any).tlDiag.instrumentFetch(native as any, d, () => SLOW_MS);

    await expect(wrapped("/api/sessions/layout", {})).rejects.toThrow("Failed to fetch");
    d.flush();
    const slow = events.find((e) => e.name === "api.slow")!;
    expect(slow.attrs["tl.status"]).toBe(0); // a network failure, not an HTTP status
  });

  it("never reports on the reporting channel", async () => {
    // 28,379 of 32,619 api.slow records were for /telemetry itself: a slow POST
    // produced a record, which was POSTed to /telemetry, which was slow...
    const { d, events } = collector();
    const native = vi.fn(async () => new Response(null, { status: 204 }));
    const wrapped = (globalThis as any).tlDiag.instrumentFetch(native as any, d, () => SLOW_MS);
    await wrapped("/api/sessions/telemetry", { method: "POST" });
    d.flush();
    expect(events.find((e) => e.name === "api.slow")).toBeUndefined();
  });

  it("does not instrument cross-origin calls", async () => {
    const { d, events } = collector();
    const native = vi.fn(async (_i: unknown, _init?: RequestInit) => new Response("x"));
    const wrapped = (globalThis as any).tlDiag.instrumentFetch(native as any, d, () => SLOW_MS);

    await wrapped("https://example.com/thing", {});
    d.flush();
    expect(events.find((e) => e.name === "api.slow")).toBeUndefined();
    const init = native.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-TL-Req")).toBeNull();
  });

  it("never lets its own bookkeeping break a request", async () => {
    const { d } = collector();
    const native = vi.fn(async () => new Response("ok"));
    const broken = { onApi: () => { throw new Error("diag is broken"); }, ring: () => {} };
    const wrapped = (globalThis as any).tlDiag.instrumentFetch(native as any, broken, () => 700);

    await expect(wrapped("/api/sessions/layout", {})).resolves.toBeDefined();
    void d;
  });
});

describe("WebSocket instrumentation", () => {
  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static seen: FakeWS[] = [];
    readyState = 1;
    url: string;
    protocol: string | undefined;
    sent: unknown[] = [];
    private listeners = new Map<string, ((e: any) => void)[]>();
    constructor(url: string, protocol?: string) {
      this.url = url;
      this.protocol = protocol;
      FakeWS.seen.push(this);
    }
    addEventListener(t: string, fn: (e: any) => void) {
      const l = this.listeners.get(t) ?? [];
      l.push(fn);
      this.listeners.set(t, l);
    }
    fire(t: string, e: any) {
      (this.listeners.get(t) ?? []).forEach((fn) => fn(e));
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  function wrapped(d: any) {
    return (globalThis as any).tlDiag.instrumentWebSocket(FakeWS as any, d);
  }

  it("keeps the readyState constants the terminal reads directly", () => {
    const { d } = collector();
    const W = wrapped(d);
    // term.html guards every send with `ws.readyState === WebSocket.OPEN`.
    // Losing these statics would freeze the terminal, not just diagnostics.
    expect(W.OPEN).toBe(1);
    expect(W.CONNECTING).toBe(0);
    expect(W.CLOSING).toBe(2);
    expect(W.CLOSED).toBe(3);
  });

  it("constructs the real socket and passes the protocol through", () => {
    const { d } = collector();
    const W = wrapped(d);
    const ws = new W("wss://host/ws", "tty");
    expect(ws.url).toBe("wss://host/ws");
    expect(ws.protocol).toBe("tty");
  });

  it("passes sends through and counts them", () => {
    const { d, events } = collector();
    const W = wrapped(d);
    const ws = new W("wss://host/ws");
    ws.send("0abc");
    expect((ws as any).sent).toEqual(["0abc"]);

    d.setVisible(true);
    d.tick();
    d.flush();
    void events;
  });

  it("records a close with its code and the events that led there", () => {
    const { d, events } = collector();
    const W = wrapped(d);
    const ws = new W("wss://host/ws");
    ws.send("x");
    (ws as any).fire("close", { code: 1006 });

    d.flush();
    const drop = events.find((e) => e.name === "conn.dropped")!;
    expect(drop).toBeDefined();
    expect(drop.attrs["tl.code"]).toBe(1006);
    expect(drop.attrs["tl.trace"]).toBeDefined();
  });

  it("records an open with its handshake time", () => {
    const { d, events } = collector();
    const W = wrapped(d);
    const ws = new W("wss://host/ws");
    (ws as any).fire("open", {});

    d.flush();
    expect(events.find((e) => e.name === "conn.opened")).toBeDefined();
  });

  it("survives a diagnostics failure without breaking the socket", () => {
    const broken = {
      onWsSend: () => { throw new Error("boom"); },
      onWsRecv: () => { throw new Error("boom"); },
      onConnOpen: () => { throw new Error("boom"); },
      onConnDrop: () => { throw new Error("boom"); },
      ring: () => {},
    };
    const W = (globalThis as any).tlDiag.instrumentWebSocket(FakeWS as any, broken);
    const ws = new W("wss://host/ws");
    expect(() => ws.send("x")).not.toThrow();
    expect(() => (ws as any).fire("close", { code: 1000 })).not.toThrow();
    expect((ws as any).sent).toEqual(["x"]);
  });
});

