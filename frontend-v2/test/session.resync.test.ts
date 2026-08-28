/**
 * The held transcript belongs to a log, and the log can be replaced underneath
 * a reader: a new Claude in the same tmux window writes a new transcript, and
 * its ids start again at 1. The stream says so on its `ready` frame; the store
 * has to let go of what it holds rather than paint the new conversation under
 * the old one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import type { Event } from "../src/types/events";

type Fake = {
  url: string;
  onmessage: ((e: { data: string }) => void) | null;
  emit: (type: string, data: unknown) => void;
  onerror: ((e: unknown) => void) | null;
};
const sources: Fake[] = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    private readonly listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
    constructor(public url: string) {
      sources.push(this as unknown as Fake);
    }
    close(): void {}
    addEventListener(type: string, fn: (ev: { data: string }) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string, data: unknown): void {
      for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
    }
    removeEventListener(): void {}
  };
}

const ev = (id: number, body: string): string =>
  JSON.stringify({ id, kind: "text", session: "demo", body } satisfies Event);

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("a session whose log is replaced", () => {
  it("drops the conversation it was holding", async () => {
    installEventSource();
    // The store coalesces arrivals into one write per frame; run the frame now
    // so the test reads the store rather than the scheduler.
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
    let store!: ReturnType<typeof createSessionStore>;
    const dispose = createRoot((d) => {
      store = createSessionStore("demo");
      return d;
    });

    sources[0]!.emit("ready", { head: 0, epoch: "aaaa" });
    sources[0]!.onmessage?.({ data: ev(5000, "the old conversation") });
    await tick();
    expect(store.events.map((e) => e.body)).toEqual(["the old conversation"]);

    // The stream comes back on a different transcript.
    sources[0]!.onerror?.(null);
    await tick();
    const next = sources[sources.length - 1]!;
    next.emit("ready", { head: 2, epoch: "bbbb" });
    await tick();

    expect(store.events).toHaveLength(0);
    expect(store.opening()).toBe(true); // waiting on the new window, not empty

    const fresh = sources[sources.length - 1]!;
    fresh.emit("ready", { head: 1, epoch: "bbbb" });
    fresh.onmessage?.({ data: ev(1, "the new conversation") });
    await tick();
    expect(store.events.map((e) => e.body)).toEqual(["the new conversation"]);

    dispose();
  });
});
