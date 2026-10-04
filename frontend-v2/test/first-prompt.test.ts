/**
 * Delivering the first prompt of a session created a moment ago.
 *
 * The behaviour under test is the one measured against Claude Code 2.1.260 on
 * 2026-09-04 and written up in src/lib/first-prompt.ts: a session that tmux has
 * created is REACHABLE seconds before Claude is READY, POST /prompt answers 204
 * either way, and text injected into the gap is gone with no error anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import {
  deliverFirstPrompt,
  firstPromptDelivery,
  FIRST_PROMPT_LADDER,
  PI_FIRST_PROMPT_LADDER,
  watchHidden,
} from "../src/lib/first-prompt";

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
    expect(c.waited).toEqual([0, 1600, 3000]);
  });

  // session-events holds a first prompt until its Claude says hello, past the
  // browser's own deadline, and a retry carrying the same id joins the attempt
  // already waiting. So a request the browser gave up on after a long hold is
  // asked again AT ONCE: a gap there is time the prompt could already have been
  // in (docs/plans/2026-10-04-warm-slot-at-send-design.md).
  it("asks again at once after a request the server was holding", async () => {
    let t = 0;
    const statuses = [503, 204];
    let i = 0;
    const fetchImpl = (async () => {
      t += 8000; // the browser's deadline ran out on a held request
      return new Response(null, { status: statuses[i++] ?? 204 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    expect(await deliver({ fetchImpl, ...c, awaitReady: true, now: () => t })).toBe(true);
    expect(c.waited).toEqual([0, 0]);
  });

  it("still waits its rung after a quick not-yet", async () => {
    const t = 0;
    const f = scripted([503, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, awaitReady: true, now: () => t })).toBe(true);
    expect(c.waited).toEqual([0, 1600]);
  });

  // The composer reports Send to Accepted on this clock, with how long the
  // server waited for the hello, which tells a booted slot from a booting one.
  it("says when the last line was accepted, and how long the server waited for Claude", async () => {
    let t = 100;
    const fetchImpl = (async () => {
      t += 640;
      return new Response(null, { status: 204, headers: { "X-Tl-Hello-Wait-Ms": "3120" } });
    }) as unknown as typeof fetch;
    const c = fastClock();
    const seen: { ms: number; helloWaitMs: number | null }[] = [];
    await deliver({
      fetchImpl,
      ...c,
      awaitReady: true,
      now: () => t,
      sentAt: 0,
      onAccepted: (a) => seen.push(a),
    });
    expect(seen).toEqual([{ ms: 740, helloWaitMs: 3120 }]);
  });

  it("says the wait is unknown when the server did not say", async () => {
    const f = scripted([204]);
    const c = fastClock();
    const seen: { ms: number; helloWaitMs: number | null }[] = [];
    await deliver({ ...f, ...c, now: () => 50, sentAt: 0, onAccepted: (a) => seen.push(a) });
    expect(seen).toEqual([{ ms: 50, helloWaitMs: null }]);
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
    expect(c.waited).toEqual([0, 250]);
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

  // Deployed review round 4 (2026-09-28): the first prompt in an untrusted
  // git repository met Claude's folder-trust dialog, picked "No, exit", and
  // the session died. The server now refuses it with a reason, and the reason
  // reaches the caller so it can say where to answer.
  it("gives up at once on a refusal, and names its reason", async () => {
    const fetchImpl = (async () =>
      new Response('{"applied":false,"reason":"trust-open"}\n', {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const c = fastClock();
    const reasons: string[] = [];
    expect(await deliver({ fetchImpl, ...c, onRefused: (r) => reasons.push(r) })).toBe(false);
    expect(reasons).toEqual(["trust-open"]);
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

  it("tries at once, and leaves the waiting to the server", () => {
    // The first rung was 700ms, from when nothing could hold a request for a
    // session that did not exist yet. session-events now holds it (up to 4s)
    // until the session can take it, so for a warm slot that 700ms was most of
    // the time to Accepted (measured 2026-10-03, median 0.9s).
    expect(FIRST_PROMPT_LADDER).toEqual([0, 1600, 3000, 6000]);
  });

  it("tells the server how long ago Send was pressed, on the last line only", async () => {
    // session-events times the first prompt from the Send press to Accepted
    // and to Shown (prompt.landed); it measures everything after the request
    // arrives, and this is the part before.
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: bodies.length === 2 ? 503 : 204 });
    }) as unknown as typeof fetch;
    let t = 1000;
    const c = fastClock();
    await deliver({
      fetchImpl,
      sleep: async (ms) => {
        t += ms;
        await c.sleep(ms);
      },
      lines: ["/model sonnet", "do the thing"],
      awaitReady: true,
      sentAt: 900,
      now: () => t,
      hidden: () => true,
    });
    expect(bodies[0]).not.toHaveProperty("sinceSendMs");
    // The last line's first try was refused; the try that landed says the
    // time as of its own request.
    expect(bodies[1]).toMatchObject({ text: "do the thing", sinceSendMs: 350, hidden: true });
    expect(bodies[2]).toMatchObject({ text: "do the thing", sinceSendMs: 1950, hidden: true });
  });

  it("names each line once, and keeps the name across its retries", async () => {
    // session-events sends each request id once (promptonce.go), so a retry
    // after the browser gave up on a slow answer cannot make a second prompt.
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: bodies.length === 2 ? 503 : 204 });
    }) as unknown as typeof fetch;
    await deliver({ fetchImpl, ...fastClock(), lines: ["/model sonnet", "do the thing"] });
    const ids = bodies.map((b) => b.id);
    expect(ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))).toBe(
      true,
    );
    expect(ids[1]).toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("says nothing about Send when it was not told when that was", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deliver({ fetchImpl, ...fastClock(), awaitReady: true });
    expect(bodies[0]).not.toHaveProperty("sinceSendMs");
    expect(bodies[0]).not.toHaveProperty("hidden");
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

/**
 * Which harness the prompt is for. The server's readiness wait reads a
 * different thing off each pane: Claude's `❯`, and for pi the `π - ` title pi
 * sets once startup and any trust question are over. So a pi session's first
 * prompt names the harness, and a Claude one leaves the field out, which is
 * what the server has always read as Claude.
 */
describe("the harness the first prompt names", () => {
  function recorder() {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  }

  it("says pi, and asks for the wait, for a pi session", async () => {
    const r = recorder();
    const c = fastClock();
    expect(await deliver({ ...r, ...c, awaitReady: true, tool: "pi" })).toBe(true);
    expect(r.bodies).toEqual([
      { text: "do the thing", awaitReady: true, tool: "pi", id: expect.any(String) },
    ]);
  });

  it("leaves the field out when no harness is named", async () => {
    const r = recorder();
    const c = fastClock();
    expect(await deliver({ ...r, ...c, awaitReady: true })).toBe(true);
    expect(r.bodies[0]).toEqual({ text: "do the thing", awaitReady: true, id: expect.any(String) });
    expect("tool" in r.bodies[0]!).toBe(false);
  });

  // Pi never gets the blind last rung. Text typed before pi owns the terminal
  // is echoed by the tty, whose line discipline turns Enter into a line feed,
  // and pi's editor reads a line feed as a new line: the prompt lands unsent
  // in pi's input box. Seen live on 2026-09-26, with pi taking 49s to start on
  // a loaded box, past the 23s the Claude ladder spends.
  it("keeps the wait, and names pi, on every rung of pi's own ladder", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      n += 1;
      return new Response(null, { status: n < PI_FIRST_PROMPT_LADDER.length ? 503 : 204 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    expect(await deliver({ fetchImpl, ...c, awaitReady: true, tool: "pi" })).toBe(true);
    expect(c.waited).toEqual([...PI_FIRST_PROMPT_LADDER]);
    expect(bodies.map((b) => b.tool)).toEqual(PI_FIRST_PROMPT_LADDER.map(() => "pi"));
    expect(bodies.map((b) => b.awaitReady)).toEqual(PI_FIRST_PROMPT_LADDER.map(() => true));
  });

  it("gives up rather than type into a pi that never became ready", async () => {
    const f = scripted([503]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, awaitReady: true, tool: "pi" })).toBe(false);
    expect(f.waited.every((w) => w)).toBe(true);
  });

  it("gives pi's ladder room for a slow start, beyond Claude's", () => {
    const total = (l: readonly number[]) => l.reduce((a, b) => a + b, 0);
    expect(total(PI_FIRST_PROMPT_LADDER)).toBeGreaterThanOrEqual(60_000);
    expect(PI_FIRST_PROMPT_LADDER.slice(0, FIRST_PROMPT_LADDER.length)).toEqual([
      ...FIRST_PROMPT_LADDER,
    ]);
  });

  // Deployed review round 1 (2026-09-28): a Codex session started from the
  // new-session box got its words on codex's input line and never submitted,
  // because the prompt went out blind 700 ms in and the Enter was lost while
  // codex started. The server now waits for codex's input line too.
  it("asks Claude, pi and Codex to wait, and nothing else", () => {
    expect(firstPromptDelivery("claude")).toEqual({ awaitReady: true });
    expect(firstPromptDelivery("pi")).toEqual({ awaitReady: true, tool: "pi" });
    expect(firstPromptDelivery("codex")).toEqual({ awaitReady: true, tool: "codex" });
    // A command that is not a harness has nothing to wait for.
    expect(firstPromptDelivery(null)).toEqual({ awaitReady: false });
  });

  // Codex draws a menu with the same › as its input line, and a blind prompt
  // plus Enter picks the menu's highlighted row, so it keeps the wait on every
  // rung and gives up into the composer instead.
  it("keeps the wait, and names codex, on every rung for a codex session", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    expect(await deliver({ fetchImpl, ...c, awaitReady: true, tool: "codex" })).toBe(false);
    expect(bodies.map((b) => b.tool)).toEqual(FIRST_PROMPT_LADDER.map(() => "codex"));
    expect(bodies.map((b) => b.awaitReady)).toEqual(FIRST_PROMPT_LADDER.map(() => true));
  });
});

describe("watchHidden", () => {
  /** A document whose visibility the test sets. */
  function page(state: DocumentVisibilityState) {
    const doc = new EventTarget() as Document & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(doc, "visibilityState", { get: () => state, configurable: true });
    return {
      doc,
      set(next: DocumentVisibilityState) {
        state = next;
        doc.dispatchEvent(new Event("visibilitychange"));
      },
    };
  }

  it("remembers that the page hid, even once it is back", () => {
    const p = page("visible");
    const w = watchHidden(p.doc);
    expect(w.hidden()).toBe(false);
    p.set("hidden");
    p.set("visible");
    expect(w.hidden()).toBe(true);
  });

  it("counts a page already hidden when the watch starts", () => {
    expect(watchHidden(page("hidden").doc).hidden()).toBe(true);
  });

  it("stops listening when stopped", () => {
    const p = page("visible");
    const w = watchHidden(p.doc);
    w.stop();
    p.set("hidden");
    expect(w.hidden()).toBe(false);
  });
});
