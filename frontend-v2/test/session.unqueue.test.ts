/**
 * Up in the Text view takes back the prompts session-events holds behind the
 * running turn, to edit them (session-events/held.go).
 *
 * `unqueue()` asks for them and resolves to what came back, oldest first. The
 * store lets go of the copies it was still holding for them: they never reached
 * Claude, so no record will ever release them, and kept they would sit in the
 * timeline as ghosts. A Stop's reply carries the same queue, so the field gets
 * what the server took rather than the view's guess.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

type Reply = { status: number; body?: unknown } | "unreachable";

function mount(replies: { unqueue?: Reply; cancel?: Reply }) {
  g.EventSource = class {
    onopen = null;
    onerror = null;
    onmessage = null;
    close(): void {}
    addEventListener(type: string, fn: (ev: { data: string }) => void): void {
      if (type === "ready") fn({ data: "0" });
    }
    removeEventListener(): void {}
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const reply = url.includes("/unqueue")
        ? replies.unqueue
        : url.includes("/cancel/")
          ? replies.cancel
          : undefined;
      if (reply === "unreachable") throw new TypeError("Failed to fetch");
      if (!reply) return { ok: true, status: 204 } as unknown as Response;
      return {
        ok: reply.status < 300,
        status: reply.status,
        json: async () => reply.body,
      } as unknown as Response;
    }),
  );
  const notify = vi.fn();
  let store!: ReturnType<typeof createSessionStore>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSessionStore("s", { notify });
  });
  return { store, dispose, urls, notify };
}

describe("unqueue(): Up takes the held prompts back", () => {
  it("posts to the session's unqueue route and resolves to the queue that came back", async () => {
    const { store, dispose, urls } = mount({
      unqueue: { status: 200, body: { restored: true, queue: ["first", "second"] } },
    });
    await store.send("first");
    await store.send("second");

    expect(await store.unqueue()).toEqual(["first", "second"]);
    expect(urls.some((u) => u.endsWith("/prompt/s/unqueue"))).toBe(true);
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("lets go only of the held copies that came back", async () => {
    const { store, dispose } = mount({
      unqueue: { status: 200, body: { restored: true, queue: ["first"] } },
    });
    await store.send("first");
    await store.send("other");
    await store.unqueue();
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["other"]);
    dispose();
  });

  it.each<[string, Reply]>([
    ["nothing was held", { status: 200, body: { restored: false, queue: [] } }],
    ["the server refused", { status: 500 }],
    ["the reply is not the shape", { status: 200, body: { restored: true } }],
    ["the box is unreachable", "unreachable"],
  ])("resolves to nothing and keeps what it held when %s", async (_, reply) => {
    const { store, dispose } = mount({ unqueue: reply });
    await store.send("first");
    expect(await store.unqueue()).toEqual([]);
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    dispose();
  });
});

describe("interrupt(texts) passes the queue the server took", () => {
  it("returns the server's queue with the result", async () => {
    const { store, dispose } = mount({
      cancel: { status: 200, body: { restored: true, queue: ["from the phone", "first"] } },
    });
    await store.send("first");
    const r = await store.interrupt(["first"]);
    expect(r).toEqual({ restored: true, returned: false, queue: ["from the phone", "first"] });
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });
});
