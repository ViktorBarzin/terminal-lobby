import { describe, it, expect, vi } from "vitest";
import { createTracker, MAX_BUFFER } from "../src/telemetry/track";

describe("createTracker", () => {
  it("batches events and posts them on flush", async () => {
    const posts: unknown[] = [];
    const t = createTracker({ post: async (b) => void posts.push(b), autoFlush: false });

    t.track("session.selected", { "tl.session": "worktree" });
    t.track("palette.action", { "tl.key": "session.kill" });
    expect(posts).toHaveLength(0); // nothing leaves until a flush

    await t.flush();
    expect(posts).toHaveLength(1);
    const batch = posts[0] as { client: string; events: { name: string }[] };
    expect(batch.client).toBe("lobby-v2");
    expect(batch.events.map((e) => e.name)).toEqual(["session.selected", "palette.action"]);
    t.dispose();
  });

  it("does not post an empty batch", async () => {
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false });
    await t.flush();
    expect(post).not.toHaveBeenCalled();
    t.dispose();
  });

  // Telemetry must never surface as a broken app: a failing intake is dropped
  // silently, and the buffer is cleared so a dead endpoint cannot grow it
  // without bound.
  it("swallows post failures and drops the batch", async () => {
    const t = createTracker({
      post: async () => {
        throw new Error("network down");
      },
      autoFlush: false,
    });
    t.track("app.error", { "tl.kind": "test" });
    await expect(t.flush()).resolves.toBeUndefined();

    const posts: unknown[] = [];
    const t2 = createTracker({ post: async (b) => void posts.push(b), autoFlush: false });
    t2.track("app.loaded", {});
    await t2.flush();
    await t2.flush(); // nothing left over from the first flush
    expect(posts).toHaveLength(1);
    t.dispose();
    t2.dispose();
  });

  it("caps the buffer, keeping the newest events", async () => {
    const posts: { events: { attrs: Record<string, unknown> }[] }[] = [];
    const t = createTracker({ post: async (b) => void posts.push(b as never), autoFlush: false });
    for (let i = 0; i < MAX_BUFFER + 10; i++) t.track("palette.action", { "tl.key": String(i) });
    await t.flush();
    const evs = posts[0]!.events;
    expect(evs).toHaveLength(MAX_BUFFER);
    expect(evs[evs.length - 1]!.attrs["tl.key"]).toBe(String(MAX_BUFFER + 9));
    t.dispose();
  });

  it("flushes on an interval once auto-flush is on", async () => {
    vi.useFakeTimers();
    const post = vi.fn(async () => {});
    const t = createTracker({ post, flushMs: 5000 });
    t.track("view.switched", { "tl.to": "terminal" });
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(post).toHaveBeenCalledTimes(1);
    t.dispose();
    vi.useRealTimers();
  });

  // A tab being closed is exactly when the last events matter, and a normal
  // fetch is killed mid-flight — so the final flush goes out via sendBeacon.
  it("uses sendBeacon when the page is going away", () => {
    const beacon = vi.fn(() => true);
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false, beacon });
    t.track("session.detached", { "tl.session": "x" });
    t.flushSync();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    const [, body] = beacon.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(body).events[0].name).toBe("session.detached");
    t.dispose();
  });

  it("is a no-op after dispose", async () => {
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false });
    t.dispose();
    t.track("app.loaded", {});
    await t.flush();
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * The device dimension (2026-09-06).
 *
 * Every notification event was attributed to a USER and nothing else. Viktor
 * has more than one device, so a `notify.stash_written` from his phone and a
 * `notify.stash_read` from his laptop looked like one chain, and the two could
 * not be told apart in the journal at all. Stamping the installation id on the
 * batcher rather than at each call site means no event can be added later that
 * forgets it.
 */
describe("createTracker stamps the device", () => {
  const DEVICE = "0123456789abcdef0123456789abcdef";

  const flushOne = async (fill: (t: ReturnType<typeof createTracker>) => void) => {
    const posts: { events: { name: string; attrs: Record<string, unknown> }[] }[] = [];
    const t = createTracker({
      post: async (b) => void posts.push(b as never),
      autoFlush: false,
      deviceId: () => DEVICE,
    });
    fill(t);
    await t.flush();
    t.dispose();
    return posts[0]!.events;
  };

  it("puts tl.device on every event in the batch", async () => {
    const evs = await flushOne((t) => {
      t.track("app.loaded", {});
      t.track("notify.stash_read", { "tl.reason": "acted" });
    });
    expect(evs.map((e) => e.attrs["tl.device"])).toEqual([DEVICE, DEVICE]);
  });

  it("keeps the attributes the call site passed", async () => {
    const [ev] = await flushOne((t) => t.track("session.selected", { "tl.session": "abc123" }));
    expect(ev!.attrs).toEqual({ "tl.session": "abc123", "tl.device": DEVICE });
  });

  // The attribute names the device that emitted the event, so it has to be the
  // batcher's answer and not a call site's. A caller passing one is a bug, and
  // a bug that silently wins would make the dimension untrustworthy everywhere.
  it("wins over a tl.device a call site tried to set", async () => {
    const [ev] = await flushOne((t) =>
      t.track("app.error", { "tl.kind": "test", "tl.device": "somebody-elses-device" }),
    );
    expect(ev!.attrs["tl.device"]).toBe(DEVICE);
  });

  // sendBeacon carries the last events a tab ever emits. Those are the ones a
  // pagehide-at-tap investigation reads, so they need the dimension too.
  it("stamps the beacon batch as well", () => {
    const beacon = vi.fn(() => true);
    const t = createTracker({ autoFlush: false, beacon, deviceId: () => DEVICE });
    t.track("notify.clicked", { "tl.session": "abc123" });
    t.flushSync();
    const [, body] = beacon.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(body).events[0].attrs["tl.device"]).toBe(DEVICE);
    t.dispose();
  });

  // A blocked or empty store must cost the dimension, never an event: telemetry
  // is not allowed to throw into a call site (see the module header).
  it("still records the event when the id cannot be read", async () => {
    const posts: { events: { name: string; attrs: Record<string, unknown> }[] }[] = [];
    const t = createTracker({
      post: async (b) => void posts.push(b as never),
      autoFlush: false,
      deviceId: () => {
        throw new Error("storage blocked");
      },
    });
    t.track("app.loaded", {});
    await t.flush();
    expect(posts[0]!.events[0]!.name).toBe("app.loaded");
    expect(posts[0]!.events[0]!.attrs["tl.device"]).toBeUndefined();
    t.dispose();
  });
});

/**
 * notify.tap is emitted by sw.js, not by this batcher (a worker cannot reach
 * it), but the name lives in the union so the TypeScript catalog and the Go one
 * can be diffed by docs.truth.test.ts. The branch values are the contract with
 * the click handler.
 */
describe("notify.tap", () => {
  it("is a name the union accepts, with a branch attribute", async () => {
    const posts: { events: { name: string; attrs: Record<string, unknown> }[] }[] = [];
    const t = createTracker({ post: async (b) => void posts.push(b as never), autoFlush: false });
    t.track("notify.tap", { "tl.session": "abc123", "tl.kind": "acked", "tl.count": 1 });
    await t.flush();
    expect(posts[0]!.events[0]!.name).toBe("notify.tap");
    expect(posts[0]!.events[0]!.attrs["tl.kind"]).toBe("acked");
    t.dispose();
  });
});
