/**
 * The prompt guard, client half (design doc contract 4).
 *
 * While Claude Code's plan approval is on the pane, session-events refuses a
 * plain `POST /prompt` with 409 `{"applied":false,"reason":"plan-open"}`, since
 * a paste and Enter there would pick a menu row. The store resolves false so
 * the composer keeps the typed text, and says why in words a reader can act
 * on: answer the card, and the message comes back after. Since the T3 pass the
 * card takes the composer's place, so the Quiet line copy ("The message box
 * answers it now", "Send again to answer it from the card") pointed at a box
 * and a Send that were gone (deployed review round 1, 2026-09-28). Any other
 * 409 keeps the generic "couldn't send" handling.
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

  it("keeps the text and says to answer the plan on the card", async () => {
    g.fetch = respond(409, '{"applied":false,"reason":"plan-open"}\n', "application/json");
    const { ok, notes, pending } = await sendOnce("1. do X");
    expect(ok, "a refused prompt must hand its text back").toBe(false);
    expect(pending, "a refused prompt must not show as sent").toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("warning");
    expect(notes[0]?.msg).toBe(
      "The plan approval is up. Answer it on the card, and your message comes back after.",
    );
    expect(notes[0]?.msg).not.toMatch(/couldn't send/i);
  });

  it("keeps the text and says Claude is asking to use a tool", async () => {
    // A tool permission prompt refuses a prompt the same way (2026-09-27).
    g.fetch = respond(409, '{"applied":false,"reason":"permission-open"}\n', "application/json");
    const { ok, notes, pending } = await sendOnce("actually, don't");
    expect(ok).toBe(false);
    expect(pending).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("warning");
    expect(notes[0]?.msg).toBe(
      "Claude is asking to use a tool. Answer it on the card, and your message comes back after.",
    );
  });

  it("keeps the text and says Claude is asking a question", async () => {
    // A question refuses a prompt too (2026-09-27): the prompt's Enter
    // would pick the highlighted option and lose the words.
    g.fetch = respond(409, '{"applied":false,"reason":"question-open"}\n', "application/json");
    const { ok, notes, pending } = await sendOnce("my queued follow-up note");
    expect(ok).toBe(false);
    expect(pending).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("warning");
    expect(notes[0]?.msg).toBe(
      "Claude is asking a question. Answer it on the card, and your message comes back after.",
    );
  });

  it("keeps the text and says to answer the session's menu in the Terminal", async () => {
    // A codex menu refuses a prompt (deployed review round 2, 2026-09-28):
    // the Enter picked "2. Cancel" on codex's startup menu and codex quit.
    g.fetch = respond(409, '{"applied":false,"reason":"menu-open"}\n', "application/json");
    const { ok, notes, pending } = await sendOnce("say hello in one word");
    expect(ok).toBe(false);
    expect(pending).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("warning");
    expect(notes[0]?.msg).toBe(
      "The session is showing a menu. Answer it in the Terminal, then send again.",
    );
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
