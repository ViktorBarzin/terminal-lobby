/**
 * Arriving events are coalesced into one store write per frame.
 *
 * Appending each on its own made opening a session quadratic: every append
 * re-ran the transcript→rows derivation over the whole array. Measured on a real
 * 1,383-event window, deriving once costs 10ms and deriving per event costs
 * 2,644ms.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createEffect } from "solid-js";
import { createSessionStore } from "../src/store/session";
import type { Event } from "../src/types/events";

type Fake = { onmessage: ((e: { data: string }) => void) | null; onopen: ((e: unknown) => void) | null };
const sources: Fake[] = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(public url: string) {
      sources.push(this as unknown as Fake);
    }
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
}

const ev = (id: number): string =>
  JSON.stringify({ id, kind: "text", session: "bench", body: `line ${id}` } satisfies Event);

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("the transcript stream", () => {
  it("writes once per frame, not once per event", async () => {
    installEventSource();
    // Control the frame so the test is deterministic.
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });

    const tick = () => new Promise((r) => setTimeout(r, 0));
    let derivations = 0;
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("bench");
      createEffect(() => {
        // Reading the array is what a derivation over it would do.
        void store.events.length;
        derivations++;
      });
    });
    await tick(); // the effect's first run

    const src = sources[0]!;
    for (let i = 1; i <= 200; i++) src.onmessage?.({ data: ev(i) });

    // Nothing has landed yet: the frame has not run.
    expect(store.events.length).toBe(0);
    const before = derivations;

    frames.forEach((f) => f());
    await tick();

    expect(store.events.length).toBe(200);
    // One notification for the whole burst — not 200.
    expect(derivations - before).toBe(1);
    dispose();
  });

  it("keeps every event, in order", async () => {
    installEventSource();
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });

    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const store = createSessionStore("bench");
        const src = sources[0]!;
        for (let i = 1; i <= 50; i++) src.onmessage?.({ data: ev(i) });
        frames.forEach((f) => f());
        for (let i = 51; i <= 60; i++) src.onmessage?.({ data: ev(i) });
        frames.forEach((f) => f());

        expect(store.events.map((e) => e.id)).toEqual(
          Array.from({ length: 60 }, (_, i) => i + 1),
        );
        dispose();
        done();
      });
    });
  });

  // A view closed right after the replay would otherwise show a timeline
  // missing whatever was still buffered.
  it("delivers what is buffered when the stream closes", async () => {
    installEventSource();
    vi.stubGlobal("requestAnimationFrame", () => 1);

    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const store = createSessionStore("bench");
        const src = sources[0]!;
        for (let i = 1; i <= 5; i++) src.onmessage?.({ data: ev(i) });
        expect(store.events.length).toBe(0);
        store.close();
        expect(store.events.length).toBe(5);
        dispose();
        done();
      });
    });
  });
});
