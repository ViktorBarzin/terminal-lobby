/**
 * A send that asks the server to wait for Claude's input line.
 *
 * Used by a Send that woke a suspended session (store/wake-send.ts):
 * `claude --resume` takes 1.7-3.1 s to draw its input, and session-events
 * holds an `awaitReady` prompt for up to 4 s before answering 503. A slow
 * resume can outlast one hold, so a 503 is tried again, a bounded number of
 * times, before the text goes back to the field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

const g = globalThis as unknown as { fetch: typeof fetch };
const orig = g.fetch;
afterEach(() => {
  g.fetch = orig;
});

function script(statuses: number[]) {
  const bodies: unknown[] = [];
  g.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const status = statuses.shift() ?? 204;
    return new Response(status === 204 ? null : "not ready", { status });
  }) as unknown as typeof fetch;
  return bodies;
}

async function send(text: string, awaitReady: boolean) {
  const notes: string[] = [];
  let ok = false;
  let pending = 0;
  await createRoot(async (dispose) => {
    const store = createSessionStore("s", { notify: (msg) => notes.push(msg) });
    ok = await store.send(text, { awaitReady });
    pending = store.pendingPrompts().length;
    dispose();
  });
  return { ok, notes, pending };
}

describe("send with awaitReady", () => {
  it("asks the server to wait, and tries again while it answers 503", async () => {
    const bodies = script([503, 503, 204]);
    const r = await send("kiwi", true);
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(1);
    expect(r.notes).toEqual([]);
    expect(bodies).toEqual([
      { text: "kiwi", awaitReady: true },
      { text: "kiwi", awaitReady: true },
      { text: "kiwi", awaitReady: true },
    ]);
  });

  it("gives the text back after a bounded number of tries", async () => {
    const bodies = script([503, 503, 503, 503, 503, 503]);
    const r = await send("kiwi", true);
    expect(r.ok).toBe(false);
    expect(r.pending).toBe(0);
    expect(bodies.length).toBe(3);
    expect(r.notes).toHaveLength(1);
  });

  it("does not retry a plain send", async () => {
    const bodies = script([503]);
    const r = await send("kiwi", false);
    expect(r.ok).toBe(false);
    expect(bodies).toEqual([{ text: "kiwi" }]);
  });
});
