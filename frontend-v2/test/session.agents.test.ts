/**
 * The session store keeps the newest `agents` frame for the text view's panel.
 *
 * One set at a time: each frame is the whole set, so the newest replaces
 * whatever was held. It is stamped with how far the server's clock is ahead of
 * this device's, because every elapsed figure the panel draws is a difference
 * against a server timestamp. A replaced log drops it with everything else.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

type Fake = {
  onmessage: ((e: { data: string }) => void) | null;
  emit: (type: string, data: unknown) => void;
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

const T0 = 1_790_000_000_000;
const frame = (ids: string[]) => ({
  at: T0,
  agents: ids.map((id) => ({ id, state: "running" })),
  workflows: [],
});

function open(): { store: ReturnType<typeof createSessionStore>; dispose: () => void } {
  installEventSource();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 1;
  });
  let store!: ReturnType<typeof createSessionStore>;
  const dispose = createRoot((d) => {
    store = createSessionStore("demo");
    return d;
  });
  return { store, dispose };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the store's agent set", () => {
  it("holds nothing until the server sends a set", () => {
    const { store, dispose } = open();
    expect(store.agents()).toBeNull();
    dispose();
  });

  it("keeps the newest set, with the server clock's lead over this one", () => {
    const { store, dispose } = open();
    vi.spyOn(Date, "now").mockReturnValue(T0 - 3000);
    sources[0]!.emit("agents", frame(["a1"]));
    expect(store.agents()?.set.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(store.agents()?.skew).toBe(3000);

    sources[0]!.emit("agents", frame(["a1", "a2"]));
    expect(store.agents()?.set.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    dispose();
  });

  it("lets it go when the stream comes back on a different log", () => {
    const { store, dispose } = open();
    sources[0]!.emit("ready", { head: 0, epoch: "aaaa" });
    sources[0]!.onmessage?.({
      data: JSON.stringify({ id: 50, kind: "text", session: "demo", body: "old" }),
    });
    sources[0]!.emit("agents", frame(["a1"]));
    expect(store.agents()).not.toBeNull();

    // A new Claude in the same window: a new transcript, so a new session
    // directory, and the agents held belong to the conversation that ended.
    sources[0]!.emit("ready", { head: 3, epoch: "bbbb" });
    expect(store.agents()).toBeNull();
    dispose();
  });
});
