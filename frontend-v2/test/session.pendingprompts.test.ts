/**
 * The store shows a prompt immediately and lets go when the transcript has it.
 *
 * Measured on a live session 2026-08-18: the POST returns in ~23ms and the tail
 * delivers in ~50ms, but the CLI takes 620-680ms to write its own record —
 * 1.2s on a first turn, and unbounded when the prompt is queued behind a
 * running turn. Holding it is what makes Send feel immediate; letting go
 * cleanly is what keeps the prompt from appearing twice.
 *
 * The two are let go by DIFFERENT rules, which is the part worth pinning:
 * prose is always recorded, so any prompt recorded after it is it — whatever
 * the CLI did to the text on the way in (it trims trailing whitespace). A
 * slash command may never be recorded at all, so only its own text releases it.
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

function mount(ok = true) {
  installEventSource();
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 409 }) as unknown as Response),
  );
  let store!: ReturnType<typeof createSessionStore>;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSessionStore("s");
  });
  const deliver = async (...lines: string[]) => {
    for (const l of lines) sources[0]!.onmessage?.({ data: l });
    frames.splice(0).forEach((f) => f());
    await tick();
  };
  return { store, dispose, deliver };
}

describe("a prompt appears as soon as it is sent", () => {
  it("is held the moment the send is accepted", async () => {
    const { store, dispose } = mount();
    await store.send("deploy the api");
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["deploy the api"]);
    dispose();
  });

  it("is not held when the send was refused", async () => {
    // 409 = a turn is already running. Nothing ran, so nothing to show.
    const { store, dispose } = mount(false);
    await store.send("deploy the api");
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("holds several, in order", async () => {
    const { store, dispose } = mount();
    await store.send("first");
    await store.send("second");
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["first", "second"]);
    dispose();
  });
});

describe("letting go once the transcript has it", () => {
  it("drops prose when the record arrives", async () => {
    const { store, dispose, deliver } = mount();
    await store.send("deploy the api");
    await deliver(userEvent(1, "deploy the api"));
    expect(store.events.length).toBe(1);
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("drops prose even when the CLI changed the text", async () => {
    // Measured: the CLI trims trailing whitespace. Anything else it might do
    // is covered by the same rule — a prompt recorded after ours is ours.
    const { store, dispose, deliver } = mount();
    await store.send("deploy the api   ");
    await deliver(userEvent(1, "something else entirely"));
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("drops a slash command when the transcript says the same thing", async () => {
    // The CLI records it as markup; sessionio unwraps that back to the command.
    const { store, dispose, deliver } = mount();
    await store.send("/wrap-up");
    await deliver(userEvent(1, "/wrap-up"));
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("does NOT let a later prompt sweep away a command", async () => {
    // /help is never recorded. If a later prompt released it, the only account
    // of the command would vanish the next time anything was sent.
    const { store, dispose, deliver } = mount();
    await store.send("/help");
    await store.send("deploy the api");
    await deliver(userEvent(1, "deploy the api"));
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["/help"]);
    dispose();
  });

  it("accounts for one prompt per record, oldest first", async () => {
    // Two sent in quick succession queue behind each other, and their records
    // land one at a time. The first must not clear both.
    const { store, dispose, deliver } = mount();
    await store.send("first");
    await store.send("second");
    await deliver(userEvent(1, "something the CLI rewrote"));
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["second"]);
    await deliver(userEvent(2, "and the other one"));
    expect(store.pendingPrompts()).toEqual([]);
    dispose();
  });

  it("keeps a prompt sent AFTER the record it did not cause", async () => {
    // The transcript catching up on older traffic must not clear something
    // sent since.
    const { store, dispose, deliver } = mount();
    await deliver(userEvent(5, "an earlier message"));
    await store.send("sent after that");
    await deliver(userEvent(3, "an even older one arriving late"));
    expect(store.pendingPrompts().map((p) => p.text)).toEqual(["sent after that"]);
    dispose();
  });
});
