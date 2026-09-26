/**
 * Asking the server to put a session in a permission mode.
 *
 * Wire contract 1 (2026-09-24): one POST to the EXISTING /model/{session}
 * route, body {"mode": id}, and the server walks Shift+Tab one stop at a time
 * until the pane shows the mode. A new path prefix would have needed an infra
 * change, because the IngressRoute allow-lists session-events routes one by
 * one. The reply is {applied, reason?, mode, presses}, and `mode` is what the
 * pane showed at the end whether or not the walk got there.
 */
import { describe, it, expect, vi } from "vitest";
import { setSessionMode } from "../src/lib/mode-api";

function reply(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as Response;
}

describe("setSessionMode", () => {
  it("posts only the mode to the session's model route and hands back the reply", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { applied: true, mode: "plan", presses: 2 }));
    const r = await setSessionMode({
      session: "k7m2q9x4tp0v",
      mode: "plan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, reply: { applied: true, mode: "plan", presses: 2 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/model\/k7m2q9x4tp0v$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ mode: "plan" });
  });

  // A walk that stopped short is an ANSWER, not a failure: it says which mode
  // the pane is on now, and the dial shows that.
  it("returns a refusal as a reply, with the mode the pane is on", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, { applied: false, reason: "unavailable", mode: "manual", presses: 5 }),
    );
    const r = await setSessionMode({
      session: "s",
      mode: "auto",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({
      ok: true,
      reply: { applied: false, reason: "unavailable", mode: "manual", presses: 5 },
    });
  });

  it("reads a refusal the server sent with an error status the same way", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(409, { applied: false, reason: "dialog-open", mode: "plan", presses: 0 }),
    );
    const r = await setSessionMode({
      session: "s",
      mode: "manual",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok && r.reply.reason).toBe("dialog-open");
  });

  it("passes on the server's own words when it could not answer", async () => {
    const fetchImpl = vi.fn(async () => reply(502, "tmux: no such session\n"));
    const r = await setSessionMode({
      session: "s",
      mode: "plan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: "tmux: no such session" });
  });

  it("says what failed when the server sent nothing to read", async () => {
    const fetchImpl = vi.fn(async () => reply(500, ""));
    const r = await setSessionMode({
      session: "s",
      mode: "plan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/500/);
  });

  // A route the ingress does not carry answers 200 with the SPA's own
  // index.html (frontend-v2/README.md). That is not something to put in a
  // toast, word for word.
  it("does not quote a page of HTML back at the reader", async () => {
    const fetchImpl = vi.fn(async () => reply(200, "<!doctype html><html><head>"));
    const r = await setSessionMode({
      session: "s",
      mode: "plan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).not.toMatch(/</);
  });

  // No retry ladder. A request that timed out may still have walked, and a
  // second walk from a start nobody read is a guess about the pane.
  it("never tries again, whatever went wrong", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await setSessionMode({
      session: "s",
      mode: "plan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/reach the session/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
