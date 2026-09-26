/**
 * The drill-in's stream: one agent's own transcript, read the way the session's
 * is. History arrives newest first behind a cursor, live events after it, and
 * the reader pages back from the cursor with the same step ladder. It reads
 * through the session's routes, under /events/<session>/agents/<id>.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createAgentStream } from "../src/store/agent-stream";
import type { EventSourceLike } from "../src/sse/client";

interface Fake extends EventSourceLike {
  url: string;
  closed: boolean;
  emit: (type: string, data: unknown) => void;
  message: (data: unknown) => void;
}

function fakeSources(): { sources: Fake[]; create: (url: string) => EventSourceLike } {
  const sources: Fake[] = [];
  const create = (url: string): EventSourceLike => {
    const listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
    const src: Fake = {
      url,
      closed: false,
      onopen: null,
      onerror: null,
      onmessage: null,
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
      },
      close() {
        src.closed = true;
      },
      emit: (type, data) => {
        for (const fn of listeners[type] ?? []) fn({ data: JSON.stringify(data) });
      },
      message: (data) => src.onmessage?.({ data: JSON.stringify(data) }),
    };
    sources.push(src);
    return src;
  };
  return { sources, create };
}

const ev = (id: number, kind = "text", over: Record<string, unknown> = {}) => ({
  id,
  kind,
  session: "demo",
  body: `event ${id}`,
  ...over,
});

/** Frames run when the test says so, as the browser runs them: after the
 *  handler that scheduled one has returned. */
const frames = new Map<number, () => void>();
let nextFrame = 0;
function stubFrames(): void {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => frames.delete(h));
}
function frame(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb();
}

function open(probe: (url: string) => Promise<number | null> = async () => 200) {
  stubFrames();
  const { sources, create } = fakeSources();
  let stream!: ReturnType<typeof createAgentStream>;
  const dispose = createRoot((d) => {
    stream = createAgentStream("demo", "a1b2", { createSource: create, probeStatus: probe });
    return d;
  });
  return { stream, sources, dispose, src: () => sources[sources.length - 1]! };
}

function fetchReturning(body: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an agent's own stream", () => {
  it("opens the agent's transcript under the session's own routes", () => {
    const { src, dispose } = open();
    expect(src().url).toBe("/events/demo/agents/a1b2?rev=1");
    dispose();
  });

  it("puts history arriving newest first in order, then live events after it", () => {
    const { stream, src, dispose } = open();
    expect(stream.opening()).toBe(true);
    for (const id of [3, 2, 1]) src().emit("back", ev(id));
    frame();
    expect(stream.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(stream.opening()).toBe(false);

    src().emit("ready", { cursor: 0, head: 3, epoch: "e1" });
    src().message(ev(4, "tool_use", { tool: "Read", toolId: "t4" }));
    src().message(ev(5));
    frame();
    expect(stream.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    dispose();
  });

  it("holds each event once", () => {
    const { stream, src, dispose } = open();
    src().emit("back", ev(2));
    frame();
    src().emit("back", ev(2));
    src().emit("back", ev(1));
    frame();
    expect(stream.events.map((e) => e.id)).toEqual([1, 2]);
    dispose();
  });

  it("says whether anything sits behind the cursor once the opening is over", () => {
    const { stream, src, dispose } = open();
    src().emit("back", ev(9));
    src().emit("ready", { cursor: 5, head: 9, epoch: "e1" });
    expect(stream.hasEarlier()).toBe(true);
    expect(stream.opening()).toBe(false);
    dispose();

    const small = open();
    small.src().emit("back", ev(1));
    small.src().emit("ready", { cursor: 0, head: 1, epoch: "e1" });
    expect(small.stream.hasEarlier()).toBe(false);
    small.dispose();
  });

  it("is not opening once the server says an empty transcript is complete", () => {
    const { stream, src, dispose } = open();
    src().emit("ready", { cursor: 0, head: 0, epoch: "e1" });
    expect(stream.opening()).toBe(false);
    expect(stream.events).toHaveLength(0);
    dispose();
  });
});

describe("paging back through an agent", () => {
  it("asks from the server's cursor, one rung of the ladder further each time", async () => {
    const { stream, src, dispose } = open();
    src().emit("back", ev(9));
    src().emit("ready", { cursor: 5, head: 9, epoch: "e1" });

    const fetch = fetchReturning({ events: [ev(3), ev(4)], cursor: 3 });
    expect(await stream.loadEarlier()).toBe(2);
    expect(fetch.mock.calls[0]![0]).toBe("/events/demo/agents/a1b2/earlier?before=5&bytes=40000");
    expect(stream.events.map((e) => e.id)).toEqual([3, 4, 9]);
    expect(stream.hasEarlier()).toBe(true);

    const next = fetchReturning({ events: [ev(1), ev(2)], cursor: 0 });
    expect(await stream.loadEarlier()).toBe(2);
    expect(next.mock.calls[0]![0]).toBe("/events/demo/agents/a1b2/earlier?before=3&bytes=80000");
    expect(stream.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 9]);
    expect(stream.hasEarlier()).toBe(false);
    dispose();
  });

  it("stops at the start of the agent without asking", async () => {
    const { stream, src, dispose } = open();
    src().emit("back", ev(1));
    src().emit("ready", { cursor: 0, head: 1, epoch: "e1" });
    const fetch = fetchReturning({ events: [], cursor: 0 });
    expect(await stream.loadEarlier()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    dispose();
  });
});

describe("a capped tool result", () => {
  it("comes in full from the agent's own file", async () => {
    const { stream, dispose } = open();
    const fetch = fetchReturning({ body: "all 4,000 lines" });
    expect(await stream.fullResult("toolu_7")).toBe("all 4,000 lines");
    expect(fetch.mock.calls[0]![0]).toBe("/events/demo/agents/a1b2/result/toolu_7");
    dispose();
  });

  it("says so when the agent's file no longer holds it", async () => {
    const notify = vi.fn();
    stubFrames();
    const { create } = fakeSources();
    let stream!: ReturnType<typeof createAgentStream>;
    const dispose = createRoot((d) => {
      stream = createAgentStream("demo", "a1b2", { createSource: create, notify });
      return d;
    });
    fetchReturning("no such result", 404);
    expect(await stream.fullResult("toolu_7")).toBeNull();
    expect(notify).toHaveBeenCalledWith("That output is no longer in the transcript", "warning");
    dispose();
  });
});

describe("an agent the session does not have", () => {
  it("reports it, rather than retrying or waiting for ever", async () => {
    const { stream, src, dispose } = open(async () => 404);
    src().onerror?.({});
    await vi.waitFor(() => expect(stream.status()).toBe("no-transcript"));
    expect(stream.opening()).toBe(false);
    dispose();
  });
});

describe("parking", () => {
  it("closes the stream and resumes it from the newest event held", () => {
    const { stream, sources, src, dispose } = open();
    src().emit("back", ev(2));
    src().emit("back", ev(1));
    src().emit("ready", { cursor: 0, head: 2, epoch: "e1" });
    src().message(ev(3));

    stream.park();
    expect(sources[0]!.closed).toBe(true);
    stream.unpark();
    expect(sources).toHaveLength(2);
    expect(src().url).toBe("/events/demo/agents/a1b2?lastEventId=3&rev=1");
    expect(stream.events.map((e) => e.id)).toEqual([1, 2, 3]);
    dispose();
  });

  it("closes for good when its owner goes", () => {
    const { sources, dispose } = open();
    dispose();
    expect(sources[0]!.closed).toBe(true);
  });
});

describe("a stream that comes back on a different log", () => {
  it("lets go of what it held and reads the new one from the start", () => {
    const { stream, src, dispose } = open();
    src().emit("back", ev(7));
    src().emit("ready", { cursor: 0, head: 7, epoch: "e1" });
    expect(stream.events.map((e) => e.id)).toEqual([7]);

    // Same agent id, a different file behind it: the ids start again at 1.
    src().emit("ready", { head: 2, epoch: "e2" });
    expect(stream.events).toHaveLength(0);
    expect(stream.opening()).toBe(true);
    dispose();
  });
});
