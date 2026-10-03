/**
 * The session store's half of streaming (ADR-0036): deltas are held beside the
 * events, never among them, and published in the same frame as the stored
 * event that supersedes them, so the reply never shows twice or not at all.
 * And the `nomod` frame, for a session that started before the mod.
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

/** Frames run when the test says so, so a test can look between two of them. */
let frames: (() => void)[] = [];
const runFrame = (): void => {
  const due = frames;
  frames = [];
  for (const f of due) f();
};

function mount() {
  installEventSource();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let store!: ReturnType<typeof createSessionStore>;
  const dispose = createRoot((d) => {
    store = createSessionStore("demo");
    return d;
  });
  const src = sources[0]!;
  src.emit("ready", { head: 0, epoch: "aaaa" });
  runFrame();
  return { store, src, dispose };
}

const send = (src: Fake, payload: object): void =>
  src.onmessage?.({ data: JSON.stringify(payload) });
const delta = (body: string, over: object = {}) => ({
  id: 0,
  kind: "delta",
  session: "demo",
  turnId: "t1",
  stream: "text",
  block: 1,
  body,
  ...over,
});
const stored = (id: number, kind: Event["kind"], body = ""): Event => ({
  id,
  kind,
  session: "demo",
  body,
});

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("streaming in the session store", () => {
  it("holds the deltas, once per frame, outside the event log", () => {
    const { store, src, dispose } = mount();
    send(src, stored(1, "user", "hi"));
    send(src, delta("Hel"));
    send(src, delta("lo"));
    expect(store.stream().blocks).toEqual([]); // not before the frame
    runFrame();
    expect(store.stream().blocks).toEqual([{ stream: "text", block: 1, body: "Hello" }]);
    expect(store.events.map((e) => e.id)).toEqual([1]);
    dispose();
  });

  it("lets the stored text replace the streamed text in the same frame", () => {
    const { store, src, dispose } = mount();
    send(src, delta("Hello", { stream: "thinking", block: 0 }));
    send(src, delta("Hello there"));
    runFrame();
    send(src, stored(2, "text", "Hello there."));
    runFrame();
    expect(store.events.map((e) => e.kind)).toEqual(["text"]);
    expect(store.stream().blocks.map((b) => b.stream)).toEqual(["thinking"]);
    dispose();
  });

  it("drops everything when the turn ends", () => {
    const { store, src, dispose } = mount();
    send(src, delta("Hello"));
    send(src, stored(3, "turn_end"));
    runFrame();
    expect(store.stream().blocks).toEqual([]);
    dispose();
  });

  it("drops what it held when the connection is lost: deltas are never replayed", async () => {
    const { store, src, dispose } = mount();
    send(src, delta("Hello"));
    runFrame();
    expect(store.stream().blocks).toHaveLength(1);
    // The failure is classified before the client reports it; an unreachable
    // probe reads as a dropped connection.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    src.onerror?.(null);
    await vi.waitFor(() => expect(store.status()).toBe("reconnecting"));
    expect(store.stream().blocks).toEqual([]);
    dispose();
  });

  it("ignores a subagent's deltas", () => {
    const { store, src, dispose } = mount();
    send(src, delta("agent words", { agentId: "a1" }));
    runFrame();
    expect(store.stream().blocks).toEqual([]);
    dispose();
  });
});

describe("the nomod frame in the session store", () => {
  it("says so, and stops waiting for a window that is not coming", () => {
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
    expect(store.opening()).toBe(true);
    sources[0]!.emit("nomod", { restart: "when-idle" });
    expect(store.noMod()).toBe(true);
    expect(store.opening()).toBe(false);

    // The mod connected: the server closes the stream, the client reopens it,
    // and the ordinary exchange ends with `ready`.
    sources[0]!.emit("ready", { head: 4, epoch: "bbbb" });
    expect(store.noMod()).toBe(false);
    dispose();
  });
});

describe("the starting frame in the session store", () => {
  it("says Claude is starting, stops waiting for a window, and clears at ready", () => {
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
    sources[0]!.emit("starting", { waitS: 30 });
    expect(store.starting()).toBe(true);
    expect(store.opening()).toBe(false);
    expect(store.frames().starting).toBe(1);

    sources[0]!.emit("ready", { head: 0, epoch: "cccc" });
    expect(store.starting()).toBe(false);
    dispose();
  });

  it("gives way to the nomod note, and tells an exited Claude apart", () => {
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
    sources[0]!.emit("starting", { waitS: 30 });
    sources[0]!.emit("nomod", { claude: "exited" });
    expect(store.starting()).toBe(false);
    expect(store.noMod()).toBe(true);
    expect(store.claudeExited()).toBe(true);

    sources[0]!.emit("ready", { head: 2, epoch: "dddd" });
    expect(store.claudeExited()).toBe(false);
    dispose();
  });
});

describe("the head frame in the session store", () => {
  it("keeps the last two heads and when the newest arrived", () => {
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
    expect(store.head()).toBeNull();
    sources[0]!.emit("head", { head: 5 });
    expect(store.head()).toMatchObject({ head: 5, prev: 0 });
    sources[0]!.emit("head", { head: 8 });
    expect(store.head()).toMatchObject({ head: 8, prev: 5 });
    expect(typeof store.head()!.at).toBe("number");
    dispose();
  });
});
