/**
 * The store stands in for a slash command until the transcript accounts for it.
 *
 * Measured on a live CLI 2026-08-18: /wrap-up, /model, /compact and /login are
 * written to the transcript; /help, /context and /status are not written at
 * all. Waiting for a record that never comes is why a command could run and
 * leave the chat blank (Viktor's report the same day) — and standing in for one
 * that DOES come, without ever letting go, would put the command in twice.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";
import type { Event } from "../src/types/events";

type Fake = { onmessage: ((e: { data: string }) => void) | null };
const sources: Fake[] = [];
const g = globalThis as unknown as { EventSource?: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(public url: string) {
      sources.push(this as unknown as Fake);
    }
    close(): void {}
    addEventListener(): void {}
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

/** Mount a store with fetch stubbed to accept every prompt. */
function mount(): { store: ReturnType<typeof createSessionStore>; dispose: () => void; run: () => void } {
  installEventSource();
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response));
  let store!: ReturnType<typeof createSessionStore>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSessionStore("s");
  });
  return { store, dispose, run: () => frames.splice(0).forEach((f) => f()) };
}

describe("a command the transcript never mentions", () => {
  it("is held, so the chat is not blank after it ran", async () => {
    const { store, dispose } = mount();
    await store.send("/help");
    expect(store.sentCommands().map((c) => c.text)).toEqual(["/help"]);
    dispose();
  });

  it("is not held for ordinary prose, which the transcript always records", async () => {
    const { store, dispose } = mount();
    await store.send("deploy the thing");
    expect(store.sentCommands()).toEqual([]);
    dispose();
  });

  it("is not held when the send was refused", async () => {
    installEventSource();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409 }) as unknown as Response));
    let store!: ReturnType<typeof createSessionStore>;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      store = createSessionStore("s");
    });
    await store.send("/help");
    expect(store.sentCommands()).toEqual([]);
    dispose();
  });
});

describe("a command the transcript does mention", () => {
  it("is let go once the record arrives, so it is not shown twice", async () => {
    const { store, dispose, run } = mount();
    await store.send("/wrap-up");
    expect(store.sentCommands()).toHaveLength(1);

    // The CLI writes it as markup; sessionio unwraps that to the command line,
    // so what arrives here is exactly what was sent.
    sources[0]!.onmessage?.({ data: userEvent(1, "/wrap-up") });
    run();
    await tick();

    expect(store.events.length).toBe(1);
    expect(store.sentCommands()).toEqual([]);
    dispose();
  });

  it("keeps holding a different command that has not arrived", async () => {
    const { store, dispose, run } = mount();
    await store.send("/wrap-up");
    await store.send("/help");
    sources[0]!.onmessage?.({ data: userEvent(1, "/wrap-up") });
    run();
    await tick();
    expect(store.sentCommands().map((c) => c.text)).toEqual(["/help"]);
    dispose();
  });

  it("is let go despite whitespace differences", async () => {
    const { store, dispose, run } = mount();
    await store.send("/doc-tone  docs/plan.md");
    sources[0]!.onmessage?.({ data: userEvent(1, "/doc-tone docs/plan.md") });
    run();
    await tick();
    expect(store.sentCommands()).toEqual([]);
    dispose();
  });
});
