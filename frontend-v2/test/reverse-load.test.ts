import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { eventsUrl, earlierUrl } from "../src/lib/config";
import {
  SseClient,
  type EventSourceLike,
  type SseClientOptions,
} from "../src/sse/client";
import {
  createSessionStore,
  mergeById,
  EARLIER_STEPS_BYTES,
  JUMP_STEP_BYTES,
} from "../src/store/session";
import type { Event } from "../src/types/events";

class FakeSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null;
  listeners: Record<string, (ev: { data: string }) => void> = {};
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.listeners[type] = fn;
  }
  close() {
    this.closed = true;
  }
  /** Deliver a named frame the way the server writes it. */
  emit(type: string, data: unknown) {
    this.listeners[type]?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

const ev = (id: number, over: Partial<Event> = {}): Event => ({
  id,
  kind: "text",
  session: "sess",
  body: `e${id}`,
  ...over,
});

const frame = (e: Event) => JSON.stringify(e);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the URL contract -------------------------------------------------------

describe("the reverse open is asked for explicitly", () => {
  it("flags a fresh open so an older server keeps its old behaviour", () => {
    expect(eventsUrl("sess", 0)).toContain("rev=1");
  });

  it("still carries the resume cursor, and still asks for the reverse open", () => {
    const u = eventsUrl("sess", 42);
    expect(u).toContain("lastEventId=42");
    expect(u).toContain("rev=1");
  });

  it("asks /earlier in bytes", () => {
    expect(earlierUrl("sess", 90, 40000)).toContain("before=90");
    expect(earlierUrl("sess", 90, 40000)).toContain("bytes=40000");
  });
});

// ---- the client routes the new frames --------------------------------------

function client(over: Partial<SseClientOptions> = {}) {
  const sources: FakeSource[] = [];
  const backfill: Event[] = [];
  const live: Event[] = [];
  const states: unknown[] = [];
  const readies: unknown[] = [];
  const c = new SseClient({
    session: "sess",
    url: eventsUrl,
    onEvent: (e) => live.push(e),
    onBackfill: (e) => backfill.push(e),
    onState: (s) => states.push(s),
    onReady: (r) => readies.push(r),
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    probeStatus: async () => 200,
    ...over,
  });
  c.start();
  return { c, sources, backfill, live, states, readies };
}

describe("SseClient", () => {
  it("routes backfill frames without the ascending dedup that would drop them", () => {
    const h = client();
    const s = h.sources[0]!;
    // Newest first — exactly the order the server writes them.
    s.emit("back", frame(ev(9)));
    s.emit("back", frame(ev(8)));
    s.emit("back", frame(ev(7)));
    expect(h.backfill.map((e) => e.id)).toEqual([9, 8, 7]);
    expect(h.live).toHaveLength(0);
  });

  it("takes its resume cursor from the NEWEST backfill frame", () => {
    const h = client();
    const s = h.sources[0]!;
    s.emit("back", frame(ev(9)));
    s.emit("back", frame(ev(8)));
    expect(h.c.cursor).toBe(9);
    // ...so a reconnect asks for the gap above 9, not a fresh backfill.
    h.c.close();
    expect(eventsUrl("sess", h.c.cursor)).toContain("lastEventId=9");
  });

  it("hands the state frame and the ready cursor to its owner", () => {
    const h = client();
    const s = h.sources[0]!;
    s.emit("state", { at: 9, mode: "bypassPermissions", queue: [], prompts: ["hi"] });
    s.emit("ready", { cursor: 4 });
    expect(h.states[0]).toMatchObject({ mode: "bypassPermissions" });
    expect(h.readies[0]).toMatchObject({ cursor: 4 });
  });

  it("keeps dedup on the LIVE lane, where ids only ever rise", () => {
    const h = client();
    const s = h.sources[0]!;
    s.onmessage!({ data: frame(ev(5)) });
    s.onmessage!({ data: frame(ev(4)) }); // a replayed duplicate
    s.onmessage!({ data: frame(ev(6)) });
    expect(h.live.map((e) => e.id)).toEqual([5, 6]);
  });
});

// ---- the store ---------------------------------------------------------------

/**
 * The store's stream is the real SseClient over a stubbed global EventSource —
 * the same shape as session.batching.test.ts, so the two agree about what a
 * fake source owes the client.
 */
class FakeES {
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  listeners: Record<string, (ev: { data: string }) => void> = {};
  constructor(public url: string) {
    made.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.listeners[type] = fn;
  }
  removeEventListener() {}
  close() {}
  emit(type: string, data: unknown) {
    this.listeners[type]?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }
}

let made: FakeES[] = [];
let frames: Array<() => void> = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

beforeEach(() => {
  made = [];
  frames = [];
  g.EventSource = FakeES;
  // Own the frame so a flush happens exactly when the test says so.
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
});
afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

/** Run every scheduled flush, then let promises settle. */
const settle = async () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
  await new Promise((r) => setTimeout(r, 0));
};

function store() {
  let s!: ReturnType<typeof createSessionStore>;
  const dispose = createRoot((d) => {
    s = createSessionStore("sess");
    return d;
  });
  return { store: s, src: () => made[0]!, dispose };
}

describe("the store", () => {
  it("paints on the first history frame rather than waiting for the window", async () => {
    const h = store();
    expect(h.store.opening()).toBe(true);
    h.src().emit("back", frame(ev(9)));
    await settle();
    expect(h.store.opening()).toBe(false);
    expect(h.store.events.map((e) => e.id)).toEqual([9]);
    h.dispose();
  });

  it("keeps events ascending however they arrive", async () => {
    const h = store();
    h.src().emit("back", frame(ev(9)));
    h.src().emit("back", frame(ev(8)));
    h.src().emit("back", frame(ev(7)));
    await settle();
    h.src().onmessage!({ data: frame(ev(10)) });
    await settle();
    expect(h.store.events.map((e) => e.id)).toEqual([7, 8, 9, 10]);
    h.dispose();
  });

  it("drops a history frame it already holds", async () => {
    const h = store();
    h.src().emit("back", frame(ev(9)));
    h.src().emit("back", frame(ev(9)));
    await settle();
    expect(h.store.events.map((e) => e.id)).toEqual([9]);
    h.dispose();
  });

  it("seeds mode, context, queue and prompt history from the state frame", async () => {
    const h = store();
    h.src().emit("state", {
      at: 9,
      mode: "bypassPermissions",
      context: { usedTokens: 65200, maxTokens: 1000000, percent: 7 },
      contextTurnsAgo: 2,
      queue: ["waiting"],
      prompts: ["older", "newer"],
    });
    await settle();
    expect(h.store.state()?.mode).toBe("bypassPermissions");
    expect(h.store.state()?.queue).toEqual(["waiting"]);
    expect(h.store.state()?.prompts).toEqual(["older", "newer"]);
    expect(h.store.state()?.context?.usedTokens).toBe(65200);
    h.dispose();
  });

  it("takes the paging cursor from ready, not from the oldest event held", async () => {
    const h = store();
    // A split turn's prompt rides along from BELOW the cursor: id 3 is older
    // than the cut at 7, so paging from events[0] would skip 4..6 for good.
    h.src().emit("back", frame(ev(9)));
    h.src().emit("back", frame(ev(7)));
    h.src().emit("back", frame(ev(3), { kind: "user" }));
    h.src().emit("ready", { cursor: 7 });
    await settle();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(u);
      return { ok: true, json: async () => ({ events: [], cursor: 0 }) };
    });
    await h.store.loadEarlier();
    expect(calls[0]).toContain("before=7");
    h.dispose();
  });

  it("stops offering history once the cursor reaches the start", async () => {
    const h = store();
    h.src().emit("ready", { cursor: 0 });
    await settle();
    expect(h.store.hasEarlier()).toBe(false);
    h.dispose();
  });

  it("grows the step while a reader keeps paging back", async () => {
    const h = store();
    h.src().emit("ready", { cursor: 50 });
    await settle();
    const asked: number[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      asked.push(Number(new URL(u, "http://x").searchParams.get("bytes")));
      const n = asked.length;
      return { ok: true, json: async () => ({ events: [ev(50 - n)], cursor: 40 - n * 10 }) };
    });
    await h.store.loadEarlier();
    await h.store.loadEarlier();
    await h.store.loadEarlier();
    expect(asked).toHaveLength(3);
    expect(asked[1]).toBeGreaterThan(asked[0]!);
    expect(asked[2]).toBeGreaterThan(asked[1]!);
    h.dispose();
  });

  it("does not climb the ladder for a jump, which names its own step", async () => {
    const h = store();
    h.src().emit("ready", { cursor: 50 });
    await settle();
    const asked: number[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      asked.push(Number(new URL(u, "http://x").searchParams.get("bytes")));
      const n = asked.length;
      return { ok: true, json: async () => ({ events: [ev(50 - n)], cursor: 40 - n * 10 }) };
    });
    await h.store.loadEarlier(JUMP_STEP_BYTES);
    await h.store.loadEarlier(JUMP_STEP_BYTES);
    await h.store.loadEarlier();
    expect(asked[0]).toBe(JUMP_STEP_BYTES);
    expect(asked[2]).toBe(EARLIER_STEPS_BYTES[0]);
    h.dispose();
  });

  it("still paints against a server that replays forward and only sends ready", async () => {
    const h = store();
    // No `back` frames at all: the pre-2026-08-28 contract.
    h.src().onmessage!({ data: frame(ev(1)) });
    h.src().onmessage!({ data: frame(ev(2)) });
    await settle();
    expect(h.store.opening()).toBe(true); // held, as it was before
    h.src().emit("ready", "2");
    await settle();
    expect(h.store.opening()).toBe(false);
    expect(h.store.events.map((e) => e.id)).toEqual([1, 2]);
    h.dispose();
  });
});

describe("mergeById", () => {
  it("interleaves by id and never duplicates one", () => {
    expect(mergeById([ev(2), ev(5)], [ev(1), ev(5), ev(9)]).map((e) => e.id)).toEqual([1, 2, 5, 9]);
  });
  it("returns the held list untouched when nothing arrived", () => {
    const held = [ev(1)];
    expect(mergeById(held, [])).toBe(held);
  });
});

// ---- the derivations that used to scan the window --------------------------

import { currentMode, queuedPrompts, promptHistory } from "../src/components/timeline.logic";
import { contextState } from "../src/components/context.logic";
import type { SessionState } from "../src/types/events";

const seed = (over: Partial<SessionState> = {}): SessionState => ({
  at: 100,
  queue: [],
  prompts: [],
  ...over,
});

const meta = (id: number, m: string, body?: string): Event => ({
  id,
  kind: "meta",
  session: "sess",
  meta: m as Event["meta"],
  ...(body !== undefined ? { body } : {}),
});

describe("session state seeds what a window cannot hold", () => {
  it("takes the mode from the frame when no row carries one", () => {
    expect(currentMode([], seed({ mode: "bypassPermissions" }))).toBe("bypassPermissions");
  });

  it("lets a mode change AFTER the frame win", () => {
    const rows = [meta(140, "permission-mode", "acceptEdits")];
    expect(currentMode(rows, seed({ mode: "bypassPermissions" }))).toBe("acceptEdits");
  });

  it("ignores rows the frame already accounts for", () => {
    // id 40 is inside the backfill AND below `at`: folding it again would
    // re-apply history the server already folded.
    const rows = [meta(40, "permission-mode", "default")];
    expect(currentMode(rows, seed({ mode: "bypassPermissions" }))).toBe("bypassPermissions");
  });

  it("keeps the queue correct when the enqueue is older than the window", () => {
    // The case a window gets WRONG rather than short: the server folded
    // ["a","b"] over the whole log; only the dequeue is in the window.
    const rows = [meta(140, "dequeued")];
    expect(queuedPrompts(rows, seed({ queue: ["a", "b"] }))).toEqual(["b"]);
  });

  it("still filters the harness's own injected notices out of a seeded queue", () => {
    const q = queuedPrompts([], seed({ queue: ["<task-notification> done", "real"] }));
    expect(q).toEqual(["real"]);
  });

  it("gives the composer its history back", () => {
    const rows: Event[] = [{ id: 140, kind: "user", session: "sess", body: "newest" }];
    expect(promptHistory(rows, seed({ prompts: ["one", "two"] }))).toEqual(["one", "two", "newest"]);
  });

  it("shows a context reading taken before the window, aged by what followed", () => {
    const rows: Event[] = [
      { id: 140, kind: "turn_end", session: "sess" },
      { id: 150, kind: "turn_end", session: "sess" },
    ];
    const st = contextState(
      rows,
      seed({ context: { usedTokens: 65200, maxTokens: 1000000, percent: 7 }, contextTurnsAgo: 3 }),
    );
    expect(st?.reading.usedTokens).toBe(65200);
    expect(st?.turnsAgo).toBe(5);
  });

  it("prefers a reading somebody took after the frame", () => {
    const rows: Event[] = [
      {
        id: 140,
        kind: "meta",
        session: "sess",
        meta: "context",
        context: { usedTokens: 90000, maxTokens: 1000000, percent: 9 },
      },
      { id: 150, kind: "turn_end", session: "sess" },
    ];
    const st = contextState(rows, seed({ context: { usedTokens: 65200, maxTokens: 1000000, percent: 7 }, contextTurnsAgo: 3 }));
    expect(st?.reading.usedTokens).toBe(90000);
    expect(st?.turnsAgo).toBe(1);
  });

  it("behaves exactly as before when there is no frame", () => {
    const rows = [meta(3, "permission-mode", "plan")];
    expect(currentMode(rows)).toBe("plan");
    expect(queuedPrompts([meta(1, "queued", "x")])).toEqual(["x"]);
    expect(promptHistory([{ id: 1, kind: "user", session: "s", body: "hi" }])).toEqual(["hi"]);
  });
});
