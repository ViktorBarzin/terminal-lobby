/**
 * The prompt guard, client half (design doc contract 4).
 *
 * While Claude Code's plan approval is on the pane, session-events refuses a
 * plain `POST /prompt` with 409 `{"applied":false,"reason":"plan-open"}`, since
 * a paste and Enter there would pick a menu row. The store resolves false so
 * the composer keeps the typed text, and says why in words a reader can act
 * on: the approval is up and the message box answers it now. Any other 409
 * keeps the generic "couldn't send" handling.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

type Note = { msg: string; kind: string };

const g = globalThis as unknown as {
  EventSource?: unknown;
  fetch: typeof fetch;
};

const respond = (status: number, body: string, contentType: string): typeof fetch =>
  (async () =>
    new Response(status === 204 ? null : body, {
      status,
      headers: { "Content-Type": contentType },
    })) as unknown as typeof fetch;

async function sendOnce(text: string): Promise<{ ok: boolean; notes: Note[]; pending: number }> {
  const notes: Note[] = [];
  let ok = false;
  let pending = 0;
  await createRoot(async (dispose) => {
    const store = createSessionStore("s", {
      notify: (msg, kind) => notes.push({ msg, kind }),
    });
    ok = await store.send(text);
    pending = store.pendingPrompts().length;
    dispose();
  });
  return { ok, notes, pending };
}

describe("session store: prompt refused while the plan approval is up", () => {
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
      close(): void {}
    };
  });
  afterEach(() => {
    g.EventSource = origES;
    g.fetch = origFetch;
  });

  it("keeps the text and says the message box answers the plan", async () => {
    g.fetch = respond(409, '{"applied":false,"reason":"plan-open"}\n', "application/json");
    const { ok, notes, pending } = await sendOnce("1. do X");
    expect(ok, "a refused prompt must hand its text back").toBe(false);
    expect(pending, "a refused prompt must not show as sent").toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("warning");
    expect(notes[0]?.msg).toMatch(/plan approval is up/i);
    expect(notes[0]?.msg).toMatch(/message box/i);
    expect(notes[0]?.msg).not.toMatch(/couldn't send/i);
  });

  it("treats a plain-text 409 as any other failed send", async () => {
    g.fetch = respond(409, "conflict\n", "text/plain");
    const { ok, notes, pending } = await sendOnce("hi");
    expect(ok).toBe(false);
    expect(pending).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("error");
    expect(notes[0]?.msg).toBe("Couldn't send prompt (HTTP 409)");
  });

  it("treats a 409 with some other reason as any other failed send", async () => {
    g.fetch = respond(409, '{"applied":false,"reason":"busy"}', "application/json");
    const { ok, notes } = await sendOnce("hi");
    expect(ok).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.msg).toBe("Couldn't send prompt (HTTP 409)");
  });

  it("sends normally when the session takes the prompt", async () => {
    g.fetch = respond(204, "", "text/plain");
    const { ok, notes, pending } = await sendOnce("hi");
    expect(ok).toBe(true);
    expect(pending).toBe(1);
    expect(notes).toHaveLength(0);
  });
});
