/**
 * Stop with prompts queued mid-turn asks the server to hand them back
 * (item 8 of the T3 pass, docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * CLI 2.1.283 submits every queued prompt as the next turn when it is
 * interrupted (measured 2026-09-27), so `interrupt(texts)` names them in the
 * cancel body and session-events pops them off Claude's queue before the C-c.
 * The reply says whether they came off. Only then does the store let go of the
 * prompts it was still holding for them: the transcript will never record them
 * now, and kept, they would come back as sent bubbles once the queue emptied.
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

type Call = { url: string; body?: string };

function mount(cancelReply: { status: number; body?: unknown }) {
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
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/cancel/")) {
        return {
          ok: cancelReply.status < 300,
          status: cancelReply.status,
          json: async () => cancelReply.body,
        } as unknown as Response;
      }
      return { ok: true, status: 204 } as unknown as Response;
    }),
  );
  let store!: ReturnType<typeof createSessionStore>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSessionStore("s");
  });
  const cancels = () => calls.filter((c) => c.url.includes("/cancel/"));
  return { store, dispose, cancels };
}

describe("interrupt(texts): Stop that hands the queue back", () => {
  it("names the queued prompts, and lets go of the ones it held when they came back", async () => {
    const { store, dispose, cancels } = mount({ status: 200, body: { restored: true } });
    await store.send("first");
    await store.send("second");
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first", "second"]);

    const r = await store.interrupt(["first", "second"]);

    expect(r).toEqual({ restored: true, returned: false });
    expect(JSON.parse(cancels()[0]!.body!)).toEqual({ restoreQueue: ["first", "second"] });
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("keeps holding them when the server says the queue stayed, since they will run", async () => {
    const { store, dispose } = mount({ status: 200, body: { restored: false } });
    await store.send("first");
    expect(await store.interrupt(["first"])).toEqual({ restored: false, returned: false });
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    dispose();
  });

  it("sends the bare cancel it always did when nothing is queued", async () => {
    const { store, dispose, cancels } = mount({ status: 204 });
    expect(await store.interrupt()).toEqual({ restored: false, returned: false });
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0]!.body).toBeUndefined();
    dispose();
  });

  it("reports nothing restored when the cancel failed", async () => {
    const { store, dispose } = mount({ status: 502 });
    await store.send("first");
    expect(await store.interrupt(["first"])).toEqual({ restored: false, returned: false });
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first"]);
    dispose();
  });

  // A Stop before Claude wrote anything puts the prompt back on the pane's
  // input line (CLI 2.1.283, measured 2026-09-28). Named as returnPrompt, the
  // server takes it off that line and says so, and the store lets go of the
  // copy it was holding: the prompt is back in the field, not sent.
  it("names the prompt a Stop can take back, and lets go of it once it came back", async () => {
    const { store, dispose, cancels } = mount({
      status: 200,
      body: { restored: false, returned: true },
    });
    await store.send("Write a long story");
    const r = await store.interrupt(undefined, "Write a long story");
    expect(r).toEqual({ restored: false, returned: true });
    expect(JSON.parse(cancels()[0]!.body!)).toEqual({ returnPrompt: "Write a long story" });
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("keeps holding the prompt when it did not come back", async () => {
    const { store, dispose } = mount({ status: 200, body: { restored: false } });
    await store.send("Write a long story");
    expect(await store.interrupt(undefined, "Write a long story")).toEqual({
      restored: false,
      returned: false,
    });
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["Write a long story"]);
    dispose();
  });
});
