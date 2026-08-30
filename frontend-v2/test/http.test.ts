import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithDeadline, REQUEST_TIMEOUT_MS } from "../src/lib/http";

describe("fetchWithDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * The reason this exists: a fetch on a half-open connection never settles at
   * all, which is what a phone hands us when the radio drops a socket. Without
   * a deadline the promise hangs, the caller's catch never runs, and the UI is
   * left mid-action with nothing to show.
   */
  it("aborts a request that never settles", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }));
    const p = fetchWithDeadline("/x");
    const settled = vi.fn();
    p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toHaveBeenCalled();
  });

  it("passes a response straight back when it arrives in time", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const res = await fetchWithDeadline("/x");
    expect(res.status).toBe(200);
  });

  it("sends same-origin credentials by default", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 204 });
    });
    await fetchWithDeadline("/x");
    expect(seen?.credentials).toBe("same-origin");
  });

  it("keeps the caller's own init, method and headers included", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 204 });
    });
    await fetchWithDeadline("/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(seen?.method).toBe("POST");
    expect(seen?.body).toBe("{}");
  });

  it("honours a longer deadline when the caller asks for one", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }));
    const settled = vi.fn();
    fetchWithDeadline("/x", {}, 30000).then(settled, settled);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(settled).toHaveBeenCalled();
  });

  // A caller that already has its own AbortController must keep it: the deadline
  // is added to that signal, never substituted for it.
  it("still aborts on the caller's own signal", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }));
    const caller = new AbortController();
    const settled = vi.fn();
    fetchWithDeadline("/x", { signal: caller.signal }).then(settled, settled);
    caller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalled();
  });
});
