import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

/**
 * The session control channel (prompt/cancel/permission) swallows failures so
 * the SSE read path never breaks — but it now ALSO surfaces them via `notify`.
 * These tests stub a minimal global EventSource (jsdom has none) so the store
 * constructs, and a global fetch to drive each failure mode.
 */
type Note = { msg: string; kind: string };

const g = globalThis as unknown as {
  EventSource?: unknown;
  fetch: typeof fetch;
};

/** minimal Response-like stub returning a fixed ok/status. */
const respondWith = (ok: boolean, status: number): typeof fetch =>
  (async () => ({ ok, status })) as unknown as typeof fetch;
const rejectWith = (): typeof fetch =>
  (async () => {
    throw new Error("neterr");
  }) as unknown as typeof fetch;

describe("session store — control-channel error toasts", () => {
  let origES: unknown;
  let origFetch: typeof fetch;
  beforeEach(() => {
    origES = g.EventSource;
    origFetch = g.fetch;
    g.EventSource = class {
      onopen: unknown = null;
      onerror: unknown = null;
      onmessage: unknown = null;
      constructor(public url: string) {}
      close() {}
    };
  });
  afterEach(() => {
    g.EventSource = origES;
    g.fetch = origFetch;
  });

  // 502 rather than 409. session-events removed the turn gate on 2026-08-15 —
  // a mid-turn send queues in Claude now — so 409 is a status this endpoint can
  // no longer answer, and a test asserting a toast for it was pinning a message
  // no user could ever see. 502 ("inject failed") is what a real failure looks
  // like, and it takes the generic arm.
  it("toasts an error when a prompt send fails (502 from the injector)", async () => {
    g.fetch = respondWith(false, 502);
    const notes: Note[] = [];
    await createRoot(async (dispose) => {
      const store = createSessionStore("s", {
        notify: (msg, kind) => notes.push({ msg, kind }),
      });
      await store.send("hi");
      dispose();
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("error");
    expect(notes[0]?.msg).toMatch(/couldn't send prompt/i);
  });

  it("toasts on a network failure during send (read path still intact)", async () => {
    g.fetch = rejectWith();
    const notes: Note[] = [];
    await createRoot(async (dispose) => {
      const store = createSessionStore("s", {
        notify: (msg, kind) => notes.push({ msg, kind }),
      });
      // Never throws; resolves false so the composer can keep the typed text.
      await expect(store.send("hi")).resolves.toBe(false);
      dispose();
    });
    expect(notes.some((n) => n.kind === "error")).toBe(true);
  });

  it("toasts when a permission resolve fails and returns false", async () => {
    g.fetch = respondWith(false, 500);
    const notes: Note[] = [];
    await createRoot(async (dispose) => {
      const store = createSessionStore("s", {
        notify: (msg, kind) => notes.push({ msg, kind }),
      });
      const ok = await store.resolvePermission("r1", "allow");
      expect(ok).toBe(false);
      dispose();
    });
    expect(notes.some((n) => /permission/i.test(n.msg))).toBe(true);
  });

  it("stays silent when notify is not provided", async () => {
    g.fetch = respondWith(false, 502);
    await createRoot(async (dispose) => {
      const store = createSessionStore("s");
      await expect(store.send("hi")).resolves.toBe(false);
      dispose();
    });
  });
});
