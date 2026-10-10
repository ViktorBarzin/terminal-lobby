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
import { QUEUED_EDITS_KEY } from "../src/store/drafts";

const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Reply = { status: number; body?: unknown } | "unreachable";

function mount(replies: {
  unqueue?: Reply;
  cancel?: Reply;
  cancelQueued?: Reply;
  /** Holds the cancel-queued answer back until it settles. */
  gate?: Promise<unknown>;
}) {
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
  const bodies: (string | undefined)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(typeof init?.body === "string" ? init.body : undefined);
      if (url.includes("/cancel-queued") && replies.gate) await replies.gate;
      const reply = url.includes("/unqueue")
        ? replies.unqueue
        : url.includes("/cancel-queued")
          ? replies.cancelQueued
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
  return { store, dispose, urls, bodies, notify };
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

describe("cancelQueued(text): a ghost cancelled from the Text view", () => {
  it("names the one prompt, lets go of its held copy alone, and resolves true", async () => {
    const { store, dispose, urls, bodies, notify } = mount({
      cancelQueued: { status: 200, body: { restored: true, queue: ["second"] } },
    });
    await store.send("first");
    await store.send("second");
    expect(await store.cancelQueued("second")).toBe(true);
    const at = urls.findIndex((u) => u.endsWith("/prompt/s/cancel-queued"));
    expect(JSON.parse(bodies[at]!)).toEqual({ text: "second" });
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    expect(notify).not.toHaveBeenCalled();
    dispose();
  });

  it.each<[string, Reply]>([
    ["Claude has it already", { status: 200, body: { restored: false, queue: [] } }],
    ["the server refused", { status: 500 }],
    ["the server predates the route", { status: 404 }],
    ["the box is unreachable", "unreachable"],
  ])("resolves false and says so when %s", async (_, reply) => {
    const { store, dispose, notify } = mount({ cancelQueued: reply });
    await store.send("first");
    expect(await store.cancelQueued("first")).toBe(false);
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    expect(notify).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("editQueuedStart(text): a ghost taken out of the queue to edit", () => {
  it("takes it off the server's queue, lets go of its held copy, and opens the edit", async () => {
    const { store, dispose, urls, bodies, notify } = mount({
      cancelQueued: { status: 200, body: { restored: true, queue: ["second"] } },
    });
    await store.send("first");
    await store.send("second");
    expect(await store.editQueuedStart("first")).toBe(true);
    const at = urls.findIndex((u) => u.endsWith("/prompt/s/cancel-queued"));
    expect(JSON.parse(bodies[at]!)).toEqual({ text: "first" });
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["second"]);
    expect(store.editingQueued()).toEqual({ text: "first", draft: "first", status: "ready" });
    expect(notify).not.toHaveBeenCalled();
    dispose();
  });

  it.each<[string, Reply, string]>([
    [
      "Claude has it already",
      { status: 200, body: { restored: false, queue: [] } },
      "Claude already has that message, so it can't be edited",
    ],
    ["the server refused", { status: 500 }, "Couldn't edit the message"],
    ["the box is unreachable", "unreachable", "Couldn't edit the message"],
  ])("opens nothing and says so when %s", async (_, reply, said) => {
    const { store, dispose, notify } = mount({ cancelQueued: reply });
    await store.send("first");
    expect(await store.editQueuedStart("first")).toBe(false);
    expect(store.editingQueued()).toBeNull();
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(said, "error");
    dispose();
  });

  // The form opens at the hold, before the server answers, so the hold's own
  // pointerup can focus it and iOS raises the keyboard. Nothing is stored
  // until the server has let go of it: a reload mid-request must not leave a
  // form for a message the server still holds.
  it("opens the edit at once, and stores it only once the server let go", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { store, dispose } = mount({
      gate,
      cancelQueued: { status: 200, body: { restored: true, queue: [] } },
    });
    const started = store.editQueuedStart("first");
    expect(store.editingQueued()).toEqual({ text: "first", draft: "first", status: "taking" });
    store.setQueuedDraft("first, better");
    expect(localStorage.getItem(QUEUED_EDITS_KEY)).toBeNull();
    open();
    expect(await started).toBe(true);
    expect(store.editingQueued()).toEqual({
      text: "first",
      draft: "first, better",
      status: "ready",
    });
    expect(JSON.parse(localStorage.getItem(QUEUED_EDITS_KEY)!)).toEqual({
      s: { text: "first", draft: "first, better" },
    });
    dispose();
  });

  it("leaves nothing behind for a reload in the middle of the request", () => {
    const gate = new Promise<void>(() => {});
    const first = mount({ gate });
    void first.store.editQueuedStart("first");
    first.store.setQueuedDraft("changed");
    first.dispose();
    const again = mount({});
    expect(again.store.editingQueued()).toBeNull();
    again.dispose();
  });

  it.each<[string, Reply, "refused" | "failed"]>([
    ["Claude has it already", { status: 200, body: { restored: false, queue: [] } }, "refused"],
    ["the box is unreachable", "unreachable", "failed"],
  ])("keeps what was typed when %s", async (_, reply, status) => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { store, dispose, notify } = mount({ gate, cancelQueued: reply });
    const started = store.editQueuedStart("first");
    store.setQueuedDraft("first, better");
    open();
    expect(await started).toBe(false);
    expect(store.editingQueued()).toEqual({ text: "first", draft: "first, better", status });
    expect(notify).toHaveBeenCalledTimes(1);
    // What was typed rides a reload, still offered only as a new message.
    expect(JSON.parse(localStorage.getItem(QUEUED_EDITS_KEY)!)).toEqual({
      s: { text: "first", draft: "first, better", status },
    });
    dispose();
    const again = mount({});
    expect(again.store.editingQueued()).toEqual({ text: "first", draft: "first, better", status });
    again.dispose();
  });

  it("forgets a refused edit nothing was typed into", async () => {
    const { store, dispose } = mount({
      cancelQueued: { status: 200, body: { restored: false, queue: [] } },
    });
    expect(await store.editQueuedStart("first")).toBe(false);
    expect(store.editingQueued()).toBeNull();
    expect(localStorage.getItem(QUEUED_EDITS_KEY)).toBeNull();
    dispose();
  });

  it("opens one edit at a time, and asks the server nothing for a second", async () => {
    const { store, dispose, urls, notify } = mount({
      cancelQueued: { status: 200, body: { restored: true, queue: [] } },
    });
    await store.editQueuedStart("first");
    store.setQueuedDraft("first, better");
    expect(await store.editQueuedStart("second")).toBe(false);
    expect(urls.filter((u) => u.endsWith("/cancel-queued"))).toHaveLength(1);
    expect(store.editingQueued()).toEqual({
      text: "first",
      draft: "first, better",
      status: "ready",
    });
    expect(notify).toHaveBeenCalledWith("Finish the message you're editing first", "error");
    dispose();
  });

  it("keeps the draft across a reload, and forgets it once the edit ends", async () => {
    const first = mount({ cancelQueued: { status: 200, body: { restored: true, queue: [] } } });
    await first.store.editQueuedStart("first");
    first.store.setQueuedDraft("first, better");
    first.dispose();

    const again = mount({});
    expect(again.store.editingQueued()).toEqual({
      text: "first",
      draft: "first, better",
      status: "ready",
    });
    again.store.endQueuedEdit();
    expect(again.store.editingQueued()).toBeNull();
    again.dispose();

    const third = mount({});
    expect(third.store.editingQueued()).toBeNull();
    third.dispose();
  });

  it("still works where localStorage throws", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      const { store, dispose } = mount({
        cancelQueued: { status: 200, body: { restored: true, queue: [] } },
      });
      expect(store.editingQueued()).toBeNull();
      expect(await store.editQueuedStart("first")).toBe(true);
      store.setQueuedDraft("changed");
      expect(store.editingQueued()).toEqual({ text: "first", draft: "changed", status: "ready" });
      store.endQueuedEdit();
      expect(store.editingQueued()).toBeNull();
      dispose();
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
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
