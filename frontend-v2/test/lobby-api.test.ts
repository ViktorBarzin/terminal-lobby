import { describe, it, expect, vi, afterEach } from "vitest";
import {
  killSession,
  killSessionKeepalive,
  listSessions,
  putLayout,
  restoreSessions,
  withDeadline,
  REQUEST_TIMEOUT_MS,
  RESTORE_TIMEOUT_MS,
} from "../src/lib/lobby-api";
import { apiUrl } from "../src/lib/config";
import { emptyLayout } from "../src/types/lobby";

type FetchArgs = [string, RequestInit];

/**
 * A fetch that never answers on its own: only the request's own signal can end
 * it. That is a half-open connection — the failure mode a mobile radio produces
 * when it drops a socket without an RST, and the one a request with no deadline
 * never recovers from.
 */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // no deadline → hangs forever, which is the bug
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

/** The signal the Nth fetch was issued with. */
function signalOf(f: ReturnType<typeof hangingFetch>, n = 0): AbortSignal {
  const call = f.mock.calls[n] as FetchArgs | undefined;
  if (!call?.[1]?.signal) throw new Error(`fetch call ${n} carried no signal`);
  return call[1].signal;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lobby-api request deadlines", () => {
  it("aborts a request that has not answered within the deadline", async () => {
    vi.useFakeTimers();
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);

    const call = listSessions();
    const failed = call.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(signalOf(f).aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signalOf(f).aborted).toBe(true);
    expect(((await failed) as DOMException).name).toBe("TimeoutError");
  });

  it("puts a deadline on writes too, not just the poll's reads", async () => {
    vi.useFakeTimers();
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);

    const failed = putLayout(emptyLayout()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(signalOf(f).aborted).toBe(true);
    expect(((await failed) as DOMException).name).toBe("TimeoutError");
  });

  it("gives restore the longer deadline its work actually needs", async () => {
    // POST /restore shells out to `tmux-persist restore <user>`, recreating
    // every dead session in the manifest one tmux command at a time. Cutting it
    // off at the ordinary 8s would report a failure for work the server goes on
    // to finish.
    vi.useFakeTimers();
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);

    const failed = restoreSessions().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    expect(signalOf(f).aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS);
    expect(signalOf(f).aborted).toBe(true);
    expect(((await failed) as DOMException).name).toBe("TimeoutError");
  });

  it("keeps sending credentials and the caller's own init", async () => {
    vi.useFakeTimers();
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    void listSessions().catch(() => {});

    const [url, init] = f.mock.calls[0] as FetchArgs;
    expect(url).toBe("/api/sessions/sessions");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });
});

describe("withDeadline", () => {
  it("aborts on its own timeout when there is no caller signal", async () => {
    vi.useFakeTimers();
    const s = withDeadline(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe("TimeoutError");
  });

  it("aborts as soon as the caller's signal does, before the deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const s = withDeadline(1000, caller.signal);

    caller.abort(new Error("caller gave up"));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).message).toBe("caller gave up");

    // and the deadline firing later must not overwrite that reason
    await vi.advanceTimersByTimeAsync(1000);
    expect((s.reason as Error).message).toBe("caller gave up");
  });

  it("still honours the deadline when a caller signal is supplied", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const s = withDeadline(1000, caller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe("TimeoutError");
  });

  it("is already aborted when the caller's signal was aborted up front", () => {
    const caller = new AbortController();
    caller.abort(new Error("gone"));
    const s = withDeadline(1000, caller.signal);
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).message).toBe("gone");
  });
});

/**
 * What a kill answers with, and why it matters: past its eight-second grace
 * window the DELETE has gone out, so undo can only bring the session back by
 * POSTing /restore, and the record inside `resurrect` is the only thing that
 * says which snapshot to ask for (tmux-api session_mutate.go killSession).
 *
 * Every shape that is not a usable record reads null, and none of THOSE throws.
 * The kill has already happened by the time this parses, so failing it would
 * report a session as alive that is gone. A non-2xx status is the one thing
 * that does throw, the 404 included, because that is the caller's decision to
 * make rather than this function's.
 */
describe("the record a kill comes back with", () => {
  function answering(status: number, body?: unknown) {
    const init = { status, headers: { "Content-Type": "application/json" } };
    return vi.fn(() =>
      Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), init)),
    );
  }

  it("reads the snapshot and the name to restore out of it", async () => {
    vi.stubGlobal(
      "fetch",
      answering(200, { resurrect: { snapshot: "20260910T131500", sessions: ["deploy-thing"] } }),
    );
    expect(await killSession("deploy-thing")).toEqual({
      snapshot: "20260910T131500",
      sessions: ["deploy-thing"],
    });
  });

  it.each([
    ["a kill nothing snapshotted", 200, {}],
    ["a record with no snapshot", 200, { resurrect: { sessions: ["x"] } }],
    [
      "a record naming no session",
      200,
      { resurrect: { snapshot: "20260910T131500", sessions: [] } },
    ],
    ["a server that answers something else", 200, { ok: true }],
    ["a server too old to send one", 204, undefined],
  ])("reads %s as nothing to resurrect from", async (_what, status, body) => {
    vi.stubGlobal("fetch", answering(status, body));
    expect(await killSession("deploy-thing")).toBeNull();
  });

  it("throws on a 404, so the caller can tell a kill from a name nothing answers to", async () => {
    // It used to read as an ordinary kill with no record. That hid the case
    // this distinction exists for: tmux-api renames a session as soon as its
    // first title lands (ADR-0022), so a DELETE aimed at the name a stale list
    // still shows 404s while the session runs on. Reporting that as a kill
    // made undoing a create claim success over a live session
    // (store/lobby.ts sendKill, which still drops the local layout entry).
    vi.stubGlobal("fetch", answering(404, { error: "session not found" }));
    await expect(killSession("deploy-thing")).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * The kill that has to outlive the page.
 *
 * A kill inside its grace window still has to land when the tab is closed or
 * reloaded (store/lobby.ts flushKills), and `pagehide` is the last event a
 * browser fires for either. Everything about this call is therefore about the
 * document going away: `keepalive`, so the browser finishes the request after
 * the page is gone; the same URL helper as every other call, so an admin
 * acting as somebody else kills THEIR session rather than their own; and no
 * deadline, since nothing would be left to act on a timeout.
 *
 * Every other test of this path substitutes a fake api method, so none of them
 * would notice a dropped `keepalive` or a hand-built URL.
 */
describe("the kill fired on the way out of the page", () => {
  it("goes to the same URL as an ordinary kill, so `?as=` rides along", () => {
    const f = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", f);

    killSessionKeepalive("deploy thing/2");

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(apiUrl("/sessions/deploy%20thing%2F2"));
    expect(init.method).toBe("DELETE");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("same-origin");
    // No signal: a deadline would abort a request whose whole job is to
    // outlive the document, and nothing is left here to catch the abort.
    expect(init.signal).toBeUndefined();
  });

  it("swallows a browser that refuses the request on unload", () => {
    // Some browsers throw rather than queue when the page is already going.
    // Throwing out of `pagehide` would abandon the kills still in the loop
    // behind this one (store/lobby.ts flushKills).
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Failed to fetch");
      }),
    );

    expect(() => killSessionKeepalive("alpha")).not.toThrow();
  });
});
