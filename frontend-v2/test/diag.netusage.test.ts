import { describe, it, expect } from "vitest";
import "../../frontend/diag.js";
import {
  CLIPBOARD_PREFIX,
  FILE_API_PREFIX,
  SKILLS_API_PREFIX,
  TMUX_API_PREFIX,
} from "../src/lib/config";

/**
 * Byte accounting in the shared measurement core (docs/adr/0008-client-
 * diagnostics.md, plus the Data used feature built on it).
 *
 * The point of these tests is that a number shown to a person as "data used"
 * means bytes that crossed the link. Three buckets read transferSize, which is
 * already post-compression. Two carry streams the server compresses and the
 * browser inflates before anything can observe them, so they are modelled by
 * compressing the same bytes the same way — that model is what most of this
 * file exercises.
 *
 * Nothing here pins compressor output to an exact byte count: a deflate
 * implementation is free to differ across engine versions. What is asserted is
 * the relationships that have to hold for the number to be honest.
 */

interface Batch {
  events: { name: string; attrs: Record<string, any> }[];
}

interface Harness {
  d: any;
  windows: Record<string, number>[];
  last: (name: string) => Record<string, any> | undefined;
  names: () => string[];
  at: (ms: number) => void;
}

let seedBase = 5_000;

function harness(over: Record<string, unknown> = {}): Harness {
  const sent: Batch[] = [];
  const windows: Record<string, number>[] = [];
  const store = new Map<string, string>();
  let clock = 0;
  seedBase += 977;
  let seq = seedBase;
  const d = (globalThis as any).tlDiag.create({
    now: () => clock,
    send: (b: Batch) => void sent.push(JSON.parse(JSON.stringify(b))),
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
    build: "abc1234",
    onWindow: (t: Record<string, number>) => void windows.push(t),
    ...over,
  });
  const all = () => sent.flatMap((b) => b.events);
  return {
    d,
    windows,
    names: () => all().map((e) => e.name),
    last: (name) => {
      const hits = all().filter((e) => e.name === name);
      const latest = hits[hits.length - 1];
      return latest ? latest.attrs : undefined;
    },
    at: (ms) => {
      clock = ms;
      d.tick();
    },
  };
}

/** Bytes that deflate hard, the way a redrawn terminal screen does. */
const repetitive = (n: number) =>
  new TextEncoder().encode("\x1b[H the same row, drawn again\n".repeat(n));

/** Bytes that do not, so the mirror has something to fail to compress. */
function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = s & 0xff;
  }
  return out;
}

const active = (h: Harness) => {
  h.d.boot();
  h.d.setVisible(true);
};

describe("bucket classification", () => {
  const bucketFor = (p: string) => (globalThis as any).tlDiag.bucketFor(p);

  it.each<[string, string]>([
    ["/", "app"],
    ["/index.html", "app"],
    ["/term.html", "app"],
    ["/build-id", "app"],
    ["/term-build-id", "app"],
    ["/fonts/inter.woff2", "app"],
    ["/sw.js", "app"],
    ["/manifest.webmanifest", "app"],
    ["/icon-192.png", "app"],
    ["/events/design-t3", "text"],
    ["/earlier/design-t3", "text"],
    ["/files/read?path=/home/wizard/x.md", "files"],
    ["/files/list?dir=/home/wizard", "files"],
    ["/files/write", "files"],
    ["/clipboard/img/design-t3/paste.png", "files"],
    ["/clipboard/img/design-t3/paste.webp", "files"],
    ["/clipboard/upload", "files"],
    ["/clipboard/list?session=design-t3", "api"],
    ["/api/sessions/layout", "api"],
    ["/api/sessions/telemetry", "api"],
    ["/skills", "api"],
    ["/skills/view?owner=wizard", "api"],
  ])("puts %s in the %s bucket", (path, bucket) => {
    expect(bucketFor(path)).toBe(bucket);
  });

  it("falls back to api for a path it does not recognise", () => {
    expect(bucketFor("/something/new")).toBe("api");
  });

  /**
   * diag.js is shared verbatim with the two vanilla surfaces and has no module
   * system, so it cannot import these. This is what keeps the copy honest: the
   * first version of bucketFor tested "/api/files/", a path the app never
   * requests, which left the Files & images bucket reading zero for ever while
   * image previews were counted as App code.
   */
  it("classifies the prefixes config.ts actually exports", () => {
    expect(bucketFor(`${FILE_API_PREFIX}/read`)).toBe("files");
    expect(bucketFor(`${CLIPBOARD_PREFIX}/img/s/a.png`)).toBe("files");
    expect(bucketFor(`${CLIPBOARD_PREFIX}/upload`)).toBe("files");
    expect(bucketFor(`${SKILLS_API_PREFIX}`)).toBe("api");
    expect(bucketFor(`${TMUX_API_PREFIX}/layout`)).toBe("api");
  });

  it("never puts an image behind a known prefix in the app bucket", () => {
    // The extension rule exists for the page's own assets. An image served by
    // a service has to lose to that service's prefix, or a gallery browse
    // silently inflates App code.
    for (const ext of [".png", ".svg", ".webp", ".jpg", ".css", ".js"]) {
      expect(bucketFor(`${CLIPBOARD_PREFIX}/img/s/a${ext}`)).toBe("files");
      expect(bucketFor(`${FILE_API_PREFIX}/read?path=/x${ext}`)).toBe("files");
    }
  });

  it("classifies on the path alone, ignoring query and origin", () => {
    expect(bucketFor("/term.html?session=design-t3&arg=x")).toBe("app");
    expect(bucketFor("https://terminal.viktorbarzin.me/events/f1")).toBe("text");
  });
});

describe("measured buckets — transferSize", () => {
  it("adds a resource's wire bytes to its bucket", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/term.html", 465_003);
    h.d.onResource("/api/sessions/layout", 4_120);
    h.at(60_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.app_b"]).toBe(465_003);
    expect(r["tl.net.api_b"]).toBe(4_120);
  });

  it("sums several resources into one bucket", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/files/read", 1_000);
    h.d.onResource("/files/list", 250);
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.files_b"]).toBe(1_250);
  });

  it("counts a cache hit as nothing, because no bytes moved", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/term.html", 0);
    h.d.onKeydown(); // so the window still reports
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.app_b"]).toBeUndefined();
  });

  it("ignores a resource whose size the browser would not disclose", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/api/sessions/layout", undefined);
    h.d.onResource("/api/sessions/layout", -1);
    h.d.onKeydown();
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.api_b"]).toBeUndefined();
  });

  it("starts each window from zero", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/term.html", 1_000);
    h.at(60_000);
    await h.d.settled();
    h.d.onResource("/term.html", 7);
    h.at(120_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.app_b"]).toBe(7);
  });
});

describe("modelled buckets — the deflate mirror", () => {
  it("reports far fewer wire bytes than were received, for compressible output", async () => {
    const h = harness();
    active(h);
    const data = repetitive(400);
    h.d.onWsRecv(data.byteLength, data);
    h.at(60_000);
    await h.d.settled();
    h.at(120_000); // the rotation's result lands in the next window
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.term_b"]).toBeGreaterThan(0);
    expect(r["tl.net.term_b"]).toBeLessThan(data.byteLength / 5);
  });

  it("compresses repetitive output harder than random bytes", async () => {
    const run = async (data: Uint8Array) => {
      const h = harness();
      active(h);
      h.d.onWsRecv(data.byteLength, data);
      h.at(60_000);
      await h.d.settled();
      h.at(120_000);
      await h.d.settled();
      return h.last("perf.rollup")!["tl.net.term_b"] as number;
    };
    const n = 20_000;
    expect(await run(repetitive(700))).toBeLessThan(await run(random(n)));
  });

  it("carries the decompressed input that produced the estimate, so the ratio is checkable", async () => {
    const h = harness();
    active(h);
    const data = repetitive(400);
    h.d.onWsRecv(data.byteLength, data);
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.term_in_b"]).toBe(data.byteLength);
    expect(r["tl.net.term_in_b"] / r["tl.net.term_b"]).toBeGreaterThan(5);
  });

  it("keeps tl.ws.in_b as the decompressed figure it has always been", async () => {
    const h = harness();
    active(h);
    const data = repetitive(100);
    h.d.onWsRecv(data.byteLength, data);
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.ws.in_b"]).toBe(data.byteLength);
  });

  it("accumulates across rotations rather than restarting", async () => {
    const h = harness();
    active(h);
    let total = 0;
    for (let win = 1; win <= 3; win++) {
      const data = repetitive(300);
      h.d.onWsRecv(data.byteLength, data);
      h.at(win * 60_000);
      await h.d.settled();
      total += (h.windows[h.windows.length - 1]?.term as number) ?? 0;
    }
    h.at(4 * 60_000);
    await h.d.settled();
    total += (h.windows[h.windows.length - 1]?.term as number) ?? 0;

    expect(total).toBeGreaterThan(0);
  });

  it("models the Text view's stream the same way", async () => {
    const h = harness();
    active(h);
    const data = JSON.stringify({ turn: "a".repeat(400) });
    for (let i = 0; i < 50; i++) {
      h.d.onSseMessage({ type: "back", data, lastEventId: String(i) });
    }
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.text_b"]).toBeGreaterThan(0);
    expect(r["tl.net.text_b"]).toBeLessThan(data.length * 50);
  });

  it("counts the framing the server compressed and the browser stripped", async () => {
    // session-events writes `id: N\nevent: back\ndata: <json>\n\n`; the browser
    // hands over only the data. The mirror is fed the line form, so the input
    // it reports is what the server actually compressed.
    const h = harness();
    active(h);
    h.d.onSseMessage({ type: "back", data: "xy", lastEventId: "7" });
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    // "id: 7\n" + "event: back\n" + "data: xy\n\n"
    expect(h.last("perf.rollup")!["tl.net.text_in_b"]).toBe(6 + 12 + 10);
  });

  it("omits the event line for an unnamed event, as the wire does", async () => {
    const h = harness();
    active(h);
    h.d.onSseMessage({ type: "message", data: "xy", lastEventId: "7" });
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.text_in_b"]).toBe(6 + 10);
  });

  it("charges per message, because permessage-deflate flushes per message", async () => {
    // The same bytes split into many messages really do cost more on the wire:
    // each one ends a deflate block early. A CompressionStream has no flush
    // API and would price both identically, so the mirror adds the difference.
    const run = async (chunks: Uint8Array[]) => {
      const h = harness();
      active(h);
      for (const c of chunks) h.d.onWsRecv(c.byteLength, c);
      h.at(60_000);
      await h.d.settled();
      h.at(120_000);
      await h.d.settled();
      return h.last("perf.rollup")!["tl.net.term_b"] as number;
    };
    const whole = repetitive(600);
    const split: Uint8Array[] = [];
    for (let i = 0; i < whole.length; i += 300) split.push(whole.subarray(i, i + 300));

    const asOne = await run([whole]);
    const asMany = await run(split);
    expect(split.length).toBeGreaterThan(20);
    expect(asMany).toBeGreaterThan(asOne);
  });

  it("does not also count the SSE stream's resource entry", async () => {
    // A closed EventSource DOES produce a resource entry, and the client closes
    // and reconnects itself on every error — so one arrives per reconnect. The
    // stream is already mirrored event by event; counting both charges it twice.
    const h = harness();
    active(h);
    h.d.onSseMessage({ type: "back", data: "hello" });
    h.d.onResource("/events/design-t3", 5_470);
    h.d.onResource("/earlier/design-t3", 1_200); // an ordinary fetch: DOES count
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.text_b"]).toBe(1_200);
  });

  it("survives a payload it cannot mirror without losing the window", async () => {
    const h = harness();
    active(h);
    h.d.onWsRecv(10, { not: "bytes" });
    h.d.onResource("/term.html", 1_234);
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.app_b"]).toBe(1_234);
  });
});

describe("the window handed to the store", () => {
  it("reports every bucket the window saw", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/term.html", 100);
    h.d.onResource("/files/read", 20);
    h.at(60_000);
    await h.d.settled();

    expect(h.windows.length).toBeGreaterThan(0);
    const w = h.windows[h.windows.length - 1]!;
    expect(w.app).toBe(100);
    expect(w.files).toBe(20);
  });

  it("still reports while the tab is hidden, because bytes still moved", async () => {
    const h = harness();
    h.d.boot();
    h.d.setVisible(true);
    h.d.setVisible(false);
    h.d.onResource("/term.html", 4_096);
    h.at(60_000);
    await h.d.settled();

    // No rollup: ADR-0008 does not measure latency in a hidden tab.
    expect(h.names()).not.toContain("perf.rollup");
    // But the download was real, so the counter has to see it.
    const w = h.windows[h.windows.length - 1];
    expect(w?.app).toBe(4_096);
  });

  it("keeps counting when diagnostics are switched off, and sends nothing", async () => {
    // The toggle is consent to SEND. Someone who has just turned telemetry off
    // is the person most likely to want to know what the app is costing them.
    const h = harness({ enabled: false });
    active(h);
    h.d.onResource("/term.html", 465_003);
    h.at(60_000);
    await h.d.settled();

    expect(h.names()).toEqual([]);
    expect(h.windows[h.windows.length - 1]?.app).toBe(465_003);
  });

  it("does not call back for a window in which nothing moved", async () => {
    const h = harness();
    active(h);
    h.at(60_000);
    await h.d.settled();

    expect(h.windows.length).toBe(0);
  });
});

describe("an idle tab stays idle", () => {
  it("emits no rollup and keeps heartbeating when nothing moved", async () => {
    // Closing a CompressionStream that received nothing still emits two bytes.
    // Treated as output, that would mark traffic on every rotation: a visible
    // but idle tab would emit perf.rollup for ever, app.alive would never fire
    // again, and the panel would show Terminal and Text view bytes on a device
    // that opened neither. The lobby surface has no ttyd socket at all, so its
    // terminal mirror rotates empty every single minute.
    const h = harness();
    active(h);
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();
    h.at(180_000);
    await h.d.settled();

    expect(h.names()).not.toContain("perf.rollup");
    expect(h.windows).toEqual([]);

    h.at(300_000);
    await h.d.settled();
    expect(h.names()).toContain("app.alive");
  });

  it("reports nothing for the modelled buckets on a tab that only fetched", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/api/sessions/layout", 900);
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.term_b"]).toBeUndefined();
    expect(r["tl.net.text_b"]).toBeUndefined();
  });
});

describe("the EventSource wrapper", () => {
  /** A stand-in with the surface the wrapper touches. */
  class FakeES {
    listeners: Record<string, ((e: unknown) => void)[]> = {};
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(public url: string) {}
    addEventListener(type: string, fn: (e: unknown) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    fire(type: string, data: string): void {
      for (const fn of this.listeners[type] ?? []) fn({ type, data, lastEventId: "1" });
    }
  }

  it("mirrors named events, not just unnamed ones", () => {
    // session-events sends `event: state`, `event: back` and `event: ready`.
    // A "message" listener never sees any of them.
    const seen: unknown[] = [];
    const Wrapped = (globalThis as any).tlDiag.instrumentEventSource(FakeES, {
      onSseMessage: (e: unknown) => seen.push(e),
    });
    const es = new Wrapped("/events/s1") as unknown as FakeES;
    es.addEventListener("back", () => {}); // what the app subscribes to
    es.fire("back", "payload");

    expect(seen.length).toBe(1);
    expect((seen[0] as { type: string }).type).toBe("back");
  });

  it("still delivers the page's own listener", () => {
    const app: string[] = [];
    const Wrapped = (globalThis as any).tlDiag.instrumentEventSource(FakeES, {
      onSseMessage: () => {},
    });
    const es = new Wrapped("/events/s1") as unknown as FakeES;
    es.addEventListener("state", (e) => app.push((e as { data: string }).data));
    es.fire("state", "snapshot");

    expect(app).toEqual(["snapshot"]);
  });

  it("subscribes once per event type however often the page does", () => {
    const seen: unknown[] = [];
    const Wrapped = (globalThis as any).tlDiag.instrumentEventSource(FakeES, {
      onSseMessage: (e: unknown) => seen.push(e),
    });
    const es = new Wrapped("/events/s1") as unknown as FakeES;
    es.addEventListener("back", () => {});
    es.addEventListener("back", () => {});
    es.fire("back", "x");

    expect(seen.length).toBe(1);
  });

  it("does not mirror open and error, which carry no payload", () => {
    const seen: unknown[] = [];
    const Wrapped = (globalThis as any).tlDiag.instrumentEventSource(FakeES, {
      onSseMessage: (e: unknown) => seen.push(e),
    });
    const es = new Wrapped("/events/s1") as unknown as FakeES;
    es.addEventListener("error", () => {});
    es.fire("error", "");

    expect(seen).toEqual([]);
  });
});

describe("the bucket vocabulary is shared", () => {
  it("matches the store's, which is declared separately in TypeScript", async () => {
    // diag.js measures and usage.ts persists; each declares the five buckets in
    // its own language. A bucket present in only one is silently dropped on the
    // floor by addWindow, so the two lists are pinned together here.
    const { BUCKETS } = await import("../src/diagnostics/usage");
    expect([...(globalThis as any).tlDiag.NET_BUCKETS].sort()).toEqual([...BUCKETS].sort());
  });
});

describe("when the edge strips compression", () => {
  /**
   * terminal.viktorbarzin.me is Cloudflare-proxied and Cloudflare appears to
   * strip permessage-deflate, while a LAN client resolves past it by
   * split-horizon DNS and keeps compression. So the client on mobile data —
   * the one this whole feature exists for — may be the one running
   * uncompressed. Modelling compression that did not happen would under-report
   * it by more than a factor of ten.
   */
  it("counts what arrived, because that is what crossed the link", async () => {
    const h = harness();
    active(h);
    h.d.onWsExtensions(""); // no extension negotiated
    const data = repetitive(400);
    h.d.onWsRecv(data.byteLength, data);
    h.at(60_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.term_deflate"]).toBe(false);
    // Not the ~14x smaller figure a mirror would have produced.
    expect(r["tl.net.term_b"]).toBeGreaterThanOrEqual(data.byteLength);
  });

  it("models it when compression WAS negotiated", async () => {
    const h = harness();
    active(h);
    h.d.onWsExtensions("permessage-deflate");
    const data = repetitive(400);
    h.d.onWsRecv(data.byteLength, data);
    h.at(60_000);
    await h.d.settled();
    h.at(120_000);
    await h.d.settled();

    const r = h.last("perf.rollup")!;
    expect(r["tl.net.term_deflate"]).toBe(true);
    expect(r["tl.net.term_b"]).toBeLessThan(data.byteLength / 5);
  });

  it("says nothing about deflate before a socket has opened", async () => {
    const h = harness();
    active(h);
    h.d.onResource("/term.html", 500);
    h.at(60_000);
    await h.d.settled();

    expect(h.last("perf.rollup")!["tl.net.term_deflate"]).toBeUndefined();
  });

  it("reads the negotiated extensions off the socket at open", () => {
    const seen: string[] = [];
    class FakeWS {
      static OPEN = 1;
      extensions = "permessage-deflate; client_max_window_bits=15";
      listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor(public url: string) {}
      addEventListener(t: string, fn: (e: unknown) => void) {
        (this.listeners[t] ??= []).push(fn);
      }
      send() {}
      fire(t: string) {
        for (const fn of this.listeners[t] ?? []) fn({});
      }
    }
    const Wrapped = (globalThis as any).tlDiag.instrumentWebSocket(FakeWS, {
      onConnOpen: () => {},
      onWsExtensions: (e: string) => seen.push(e),
      onWsRecv: () => {},
      onWsSend: () => {},
      onConnDrop: () => {},
    });
    const ws = new Wrapped("wss://x/ws") as unknown as FakeWS;
    ws.fire("open");

    expect(seen).toEqual(["permessage-deflate; client_max_window_bits=15"]);
  });
});
