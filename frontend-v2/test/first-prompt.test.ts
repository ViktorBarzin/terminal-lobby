/**
 * Delivering the first prompt of a session created a moment ago.
 *
 * The behaviour under test is the one measured against Claude Code 2.1.260 on
 * 2026-09-04 and written up in src/lib/first-prompt.ts: a session that tmux has
 * created is REACHABLE seconds before Claude is READY, POST /prompt answers 204
 * either way, and text injected into the gap is gone with no error anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import { deliverFirstPrompt, FIRST_PROMPT_LADDER } from "../src/lib/first-prompt";

/** A fetch that answers each call from a script, recording what was sent. */
function scripted(statuses: readonly number[]) {
  const sent: string[] = [];
  const waited: boolean[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string; awaitReady: boolean };
    sent.push(body.text);
    waited.push(body.awaitReady);
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 204;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, waited, calls: () => i };
}

/** Every wait resolves at once, and every duration is recorded in order. */
function fastClock() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
}

const deliver = (
  o: Partial<Parameters<typeof deliverFirstPrompt>[0]> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  },
) =>
  deliverFirstPrompt({
    session: "k7m2q9x4tp0z",
    lines: ["do the thing"],
    gapMs: 250,
    ...o,
  });

describe("deliverFirstPrompt", () => {
  it("asks the server to wait for the pane, rather than guessing from here", async () => {
    // The whole point. Nothing about a pane's input line reaches the browser,
    // so the wait is asked for and session-events answers 503 until the pane
    // can take the text. Two rungs of "not yet", then it lands.
    const f = scripted([503, 503, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, awaitReady: true })).toBe(true);
    expect(f.sent).toEqual(["do the thing", "do the thing", "do the thing"]);
    expect(f.waited).toEqual([true, true, true]);
    expect(c.waited).toEqual([700, 1600, 3000]);
  });

  it("does not ask a command that draws no prompt to wait for one", async () => {
    // The check watches for Claude's `❯`. Asking where nothing will draw one
    // would spend every rung waiting and then give up with the text unsent.
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c })).toBe(true);
    expect(f.waited).toEqual([false]);
  });

  it("waits between two lines but does not wait twice for the pane", async () => {
    const f = scripted([204, 204]);
    const c = fastClock();
    expect(
      await deliver({ ...f, ...c, lines: ["/model sonnet", "do the thing"], awaitReady: true }),
    ).toBe(true);
    expect(f.sent).toEqual(["/model sonnet", "do the thing"]);
    // One rung, then the gap between the two lines.
    expect(c.waited).toEqual([700, 250]);
  });

  it("resumes at the line that did not land, never re-sending one that did", async () => {
    // 204 for the model line, then a 502 for the prompt, then 204. The model
    // line must not go twice: it would be a second visible command in the pane.
    const f = scripted([204, 502, 204]);
    const c = fastClock();
    expect(
      await deliver({ ...f, ...c, lines: ["/model sonnet", "do the thing"], awaitReady: true }),
    ).toBe(true);
    expect(f.sent).toEqual(["/model sonnet", "do the thing", "do the thing"]);
  });

  it("treats 502 as not-yet, which is what a missing session actually answers", async () => {
    // session-events runs no registry lookup on POST /prompt, so a session tmux
    // cannot find fails inside `tmux send-keys` and surfaces as a bad gateway.
    const f = scripted([502, 502, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c })).toBe(true);
    expect(f.calls()).toBe(3);
  });

  it("treats a 404 as not-yet too, for a proxy that answers before the route", async () => {
    const f = scripted([404, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c })).toBe(true);
    expect(f.calls()).toBe(2);
  });

  it("gives up at once on a status that will not get better", async () => {
    const f = scripted([403]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c })).toBe(false);
    expect(f.calls()).toBe(1);
  });

  it("retries a thrown fetch, which is a blip rather than a refusal", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    expect(await deliver({ fetchImpl, ...c })).toBe(true);
    expect(calls).toBe(2);
  });

  it("stops asking for the wait on the last rung, so the text still goes", async () => {
    // A pane that has not drawn a prompt in 11s is one that never will — a
    // Claude that crashed at launch. Better sent there than dropped.
    const f = scripted([503, 503, 503, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, awaitReady: true })).toBe(true);
    expect(f.waited).toEqual([true, true, true, false]);
    expect(c.waited).toEqual([...FIRST_PROMPT_LADDER]);
  });

  it("reports failure when every rung is spent unreachable", async () => {
    const f = scripted([502]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c })).toBe(false);
    expect(f.calls()).toBe(FIRST_PROMPT_LADDER.length);
  });

  it("sends nothing, and succeeds, when there is nothing to send", async () => {
    // An empty box is a real instruction: it makes a session and asks nothing.
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, lines: ["", ""] })).toBe(true);
    expect(f.calls()).toBe(0);
    expect(c.waited).toEqual([]);
  });

  it("drops empty lines from between real ones", async () => {
    // `modelCommandFor("default")` is null and arrives here as "".
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, lines: ["", "do the thing"] })).toBe(true);
    expect(f.sent).toEqual(["do the thing"]);
  });

  it("addresses the session by id, url-encoded", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    await deliver({ fetchImpl, ...c, session: "k7m2q9x4tp0z" });
    expect(seen[0]).toContain("/prompt/k7m2q9x4tp0z");
  });

  it("uses the ladder stampTitleWhenAlive already uses", () => {
    expect(FIRST_PROMPT_LADDER).toEqual([700, 1600, 3000, 6000]);
  });

  it("does not hold the caller while it waits", async () => {
    // Real timers, one rung, so the promise is genuinely pending afterwards.
    const f = scripted([204]);
    const spy = vi.fn();
    const p = deliverFirstPrompt({
      session: "abc",
      lines: ["hi"],
      ladder: [5],
      gapMs: 0,
      fetchImpl: f.fetchImpl,
    }).then(spy);
    expect(spy).not.toHaveBeenCalled();
    await p;
    expect(spy).toHaveBeenCalledWith(true);
  });
});
