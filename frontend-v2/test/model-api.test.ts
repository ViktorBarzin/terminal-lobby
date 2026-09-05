import { describe, it, expect, vi } from "vitest";
import { setSessionModel } from "../src/lib/model-api";

const nap = async (): Promise<void> => {};

function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as Response;
}

describe("applying a model choice to a session", () => {
  it("sends the harness and both halves, and hands back what the session reports", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { model: "opus", effort: "max" }));
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "opus",
      effort: "max",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.state).toEqual({ model: "opus", effort: "max" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      tool: "claude",
      model: "opus",
      effort: "max",
    });
  });

  // The reply is what the session reports AFTERWARDS, not an echo. An effort
  // change is refused silently when the environment pins one — measured on this
  // box, CLAUDE_CODE_EFFORT_LEVEL overrides every runtime change and the slider
  // moves anyway — so a caller that trusted its own request would show a level
  // the session is not on.
  it("reports a refusal the session did not announce", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { effort: "max" }));
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "",
      effort: "high",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.state.effort).toBe("max");
  });

  // A session that has not drawn its input yet is a "come back", which is the
  // whole reason the first prompt of a session walks a ladder.
  it("retries a not-ready session and succeeds on a later rung", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, { model: "opus" }));
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "opus",
      effort: "",
      awaitReady: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // A picker cannot open over a turn in flight, and waiting would not help:
  // the answer is for the person to stop the turn.
  it("does not retry a session that is working", async () => {
    const fetchImpl = vi.fn(async () => reply(409));
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "opus",
      effort: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/working/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The driver's own refusal — a model this account is not offered — names what
  // the session DOES list, and that sentence is the whole value of the error.
  it("carries the server's own words for a choice it could not make", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => `"fable" is not offered here — this session lists Default, Sonnet, Opus`,
    }));
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "fable",
      effort: "",
      ladder: [0],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("this session lists");
  });

  it("refuses to send a request that asks for nothing", async () => {
    const fetchImpl = vi.fn();
    const r = await setSessionModel({
      session: "s1",
      harness: "claude",
      model: "",
      effort: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: nap,
    });

    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
