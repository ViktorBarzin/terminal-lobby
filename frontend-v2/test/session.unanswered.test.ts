/**
 * A prompt whose request got no answer may still have landed.
 *
 * Reported by Viktor on 2026-10-31: offline on a phone, a send failed and the
 * words came back into the composer, but back online the message had been
 * sent, so the field held words Claude already had. A dropped connection or a
 * request past its deadline says nothing about whether the server took the
 * prompt: the radio can lose the response after the request went out. So the
 * store keeps watching for it, and when the transcript records it (or the
 * server lists it as queued) the composer is told it landed after all
 * (lib/unanswered.ts). A refusal the server answered is not watched: it
 * said no.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import { takeUnanswered } from "../src/lib/unanswered";
import type { Event, SessionState } from "../src/types/events";

type Listener = (ev: { data: string }) => void;
type Fake = { onmessage: Listener | null; named: Map<string, Listener> };
const sources: Fake[] = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: Listener | null = null;
    named = new Map<string, Listener>();
    constructor(public url: string) {
      sources.push(this as unknown as Fake);
    }
    close(): void {}
    addEventListener(type: string, fn: Listener): void {
      if (type === "ready") fn({ data: "0" });
      this.named.set(type, fn);
    }
    removeEventListener(): void {}
  };
}

const userEvent = (id: number, body: string): string =>
  JSON.stringify({ id, kind: "user", session: "s", body } satisfies Event);

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

function mount(fetchImpl: () => Promise<Response>) {
  installEventSource();
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const notes: Array<[string, string]> = [];
  let store!: ReturnType<typeof createSessionStore>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSessionStore("s", { notify: (m, k) => notes.push([m, k]) });
  });
  const deliver = async (...lines: string[]) => {
    for (const l of lines) sources[0]!.onmessage?.({ data: l });
    frames.splice(0).forEach((f) => f());
    await tick();
  };
  const state = async (queue: string[]) => {
    const st: SessionState = { at: Date.now(), queue, prompts: [] };
    sources[0]!.named.get("state")?.({ data: JSON.stringify(st) });
    await tick();
  };
  return { store, dispose, deliver, state, notes };
}

const offline = () => Promise.reject(new TypeError("Load failed"));

/** Whether `p` has settled yet. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await tick();
  return done;
}

describe("a send whose request got no answer", () => {
  it("reports landing when the transcript records it after all", async () => {
    const m = mount(offline);
    await m.deliver(userEvent(1, "earlier prompt"));
    expect(await m.store.send("reply with mango")).toBe(false);
    const late = takeUnanswered("reply with mango");
    expect(late).toBeDefined();
    expect(await settled(late!)).toBe(false);

    await m.deliver(userEvent(2, "reply with mango"));
    expect(await settled(late!)).toBe(true);
    expect(m.notes.at(-1)?.[1]).toBe("info");
    m.dispose();
  });

  it("reports landing when the server lists it as queued behind a turn", async () => {
    const m = mount(offline);
    await m.deliver(userEvent(1, "earlier prompt"));
    expect(await m.store.send("and then the tests")).toBe(false);
    const late = takeUnanswered("and then the tests")!;
    await m.state(["and then the tests"]);
    expect(await settled(late)).toBe(true);
    m.dispose();
  });

  it("is not matched by the same words recorded before it was sent", async () => {
    const m = mount(offline);
    await m.deliver(userEvent(1, "continue"));
    expect(await m.store.send("continue")).toBe(false);
    const late = takeUnanswered("continue")!;
    await m.deliver(userEvent(1, "continue"));
    expect(await settled(late)).toBe(false);
    m.dispose();
  });

  it("counts as sent when its record arrived before the request failed", async () => {
    let fail!: (e: unknown) => void;
    const m = mount(() => new Promise<Response>((_, reject) => (fail = reject)));
    await m.deliver(userEvent(1, "earlier prompt"));
    const sending = m.store.send("reply with kiwi");
    await m.deliver(userEvent(2, "reply with kiwi"));
    fail(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await sending).toBe(true);
    expect(takeUnanswered("reply with kiwi")).toBeUndefined();
    expect(m.notes).toEqual([]);
    m.dispose();
  });

  // Found verifying the fix on 2026-10-31: the stream resynced between the
  // failure and the record (the server named a log shorter than the ids held),
  // the store started over, and the record arrived with ids that no longer
  // compare. A resync can happen on any reconnect, which is when this matters.
  it("still reports landing when the stream starts over before the record", async () => {
    const m = mount(offline);
    await m.deliver(userEvent(7, "earlier prompt"));
    const sentAt = Date.now();
    expect(await m.store.send("reply with plum")).toBe(false);
    const late = takeUnanswered("reply with plum")!;
    sources[0]!.named.get("ready")?.({ data: JSON.stringify({ head: 1 }) });
    expect(sources.length).toBe(2);
    const at = (id: number, body: string, when: number): string =>
      JSON.stringify({ id, kind: "user", session: "s", body, at: when } satisfies Event);
    // The same words from long before do not count.
    sources[1]!.onmessage?.({ data: at(1, "reply with plum", sentAt - 3_600_000) });
    await m.deliver();
    expect(await settled(late)).toBe(false);
    sources[1]!.onmessage?.({ data: at(2, "reply with plum", sentAt + 500) });
    await m.deliver();
    expect(await settled(late)).toBe(true);
    m.dispose();
  });

  it("is not watched when the server answered with a refusal", async () => {
    const m = mount(async () => new Response(null, { status: 502 }));
    expect(await m.store.send("reply with pear")).toBe(false);
    expect(takeUnanswered("reply with pear")).toBeUndefined();
    m.dispose();
  });
});
