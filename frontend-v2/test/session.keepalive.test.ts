/**
 * A send outlives the page that made it.
 *
 * Found in deployed review round 2 (2026-09-28): a send to a suspended session
 * is held server-side while Claude wakes, 5-6 s in all. A reload inside that
 * window (a pull to refresh, or a home-screen app reopened) aborted the POST,
 * the store read the abort as a failure, and the composer put the words back
 * into its field and the draft store just before the page went. The server had
 * the prompt anyway: Claude answered it, and the words sat in the field with
 * Send armed to send them a second time. A keepalive request carries on to
 * the server after the page unloads. Chromium still rejects the page's promise
 * for it, so the words are kept out of the field by lib/leaving.ts
 * (PromptField.test.tsx). Browsers cap keepalive bodies at 64 KiB, so a
 * larger paste goes as an ordinary request.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createSessionStore } from "../src/store/session";

const g = globalThis as unknown as { fetch: typeof fetch };
const orig = g.fetch;
afterEach(() => {
  g.fetch = orig;
});

async function keepaliveOf(text: string, awaitReady = false): Promise<boolean | undefined> {
  let seen: boolean | undefined;
  g.fetch = (async (_url: string, init?: RequestInit) => {
    seen = init?.keepalive;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  await createRoot(async (dispose) => {
    const store = createSessionStore("s");
    await store.send(text, { awaitReady });
    dispose();
  });
  return seen;
}

describe("a prompt's request", () => {
  it("is kept alive past an unload", async () => {
    expect(await keepaliveOf("Reload test: reply with the single word mango.")).toBe(true);
    expect(await keepaliveOf("wake and send", true)).toBe(true);
  });

  it("goes as an ordinary request when it is too big to keep alive", async () => {
    expect(await keepaliveOf("x".repeat(70_000))).toBeFalsy();
  });
});
