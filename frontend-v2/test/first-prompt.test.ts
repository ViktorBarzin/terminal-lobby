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
  claudeIsUp,
  deliverFirstPrompt,
  CLAUDE_TITLE_GLYPHS,
  FIRST_PROMPT_LADDER,
} from "../src/lib/first-prompt";

/** A fetch that answers each call from a script, recording the bodies sent. */
function scripted(statuses: readonly number[]) {
  const sent: string[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).text as string);
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 204;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, calls: () => i };
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
    settleMs: 750,
    gapMs: 250,
    ...o,
  });

describe("claudeIsUp", () => {
  it("accepts every glyph Claude Code uses for that position", () => {
    for (const g of [...CLAUDE_TITLE_GLYPHS]) {
      expect(claudeIsUp(`${g} Claude Code`)).toBe(true);
    }
  });

  it("rejects what the pane title reads before Claude has drawn anything", () => {
    // Measured through a real boot: the shell's leftover title stands for the
    // first ~1.4s, and it is the exact window where an injected prompt is lost.
    expect(claudeIsUp("devvm")).toBe(false);
    expect(claudeIsUp("wizard@devvm: ~/code")).toBe(false);
    expect(claudeIsUp("")).toBe(false);
    expect(claudeIsUp(undefined)).toBe(false);
  });

  it("wants the glyph at the HEAD, not anywhere in the line", () => {
    expect(claudeIsUp("Fixing the · separator")).toBe(false);
    expect(claudeIsUp("* Claude Code")).toBe(false);
  });
});

describe("deliverFirstPrompt", () => {
  it("waits for Claude before sending, not just for tmux", async () => {
    // The whole point: rung 1 finds a reachable session whose Claude is still
    // booting. Sending there would return 204 and deliver nothing.
    const f = scripted([204]);
    const c = fastClock();
    let up = false;
    const done = deliver({
      ...f,
      sleep: async (ms) => {
        await c.sleep(ms);
        if (c.waited.filter((w) => FIRST_PROMPT_LADDER.includes(w)).length >= 3) up = true;
      },
      ready: () => up,
    });
    expect(await done).toBe(true);
    expect(f.sent).toEqual(["do the thing"]);
    // Three rungs went by unsent, and the settle ran once before the send.
    expect(c.waited).toEqual([700, 1600, 3000, 750]);
  });

  it("settles once, however many lines follow", async () => {
    const f = scripted([204, 204]);
    const c = fastClock();
    expect(
      await deliver({ ...f, ...c, lines: ["/model sonnet", "do the thing"], ready: () => true }),
    ).toBe(true);
    expect(f.sent).toEqual(["/model sonnet", "do the thing"]);
    // rung, settle, then the gap between the two lines — no second settle.
    expect(c.waited).toEqual([700, 750, 250]);
  });

  it("resumes at the line that did not land, never re-sending one that did", async () => {
    // 204 for the model line, then a 502 for the prompt, then 204. The model
    // line must not go twice: it would be a second visible command in the pane.
    const f = scripted([204, 502, 204]);
    const c = fastClock();
    expect(
      await deliver({ ...f, ...c, lines: ["/model sonnet", "do the thing"], ready: () => true }),
    ).toBe(true);
    expect(f.sent).toEqual(["/model sonnet", "do the thing", "do the thing"]);
  });

  it("treats 502 as not-yet, which is what a missing session actually answers", async () => {
    // session-events runs no registry lookup on POST /prompt, so a session tmux
    // cannot find fails inside `tmux send-keys` and surfaces as a bad gateway.
    const f = scripted([502, 502, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, ready: () => true })).toBe(true);
    expect(f.calls()).toBe(3);
  });

  it("treats a 404 as not-yet too, for a proxy that answers before the route", async () => {
    const f = scripted([404, 204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, ready: () => true })).toBe(true);
    expect(f.calls()).toBe(2);
  });

  it("gives up at once on a status that will not get better", async () => {
    const f = scripted([403]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, ready: () => true })).toBe(false);
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
    expect(await deliver({ fetchImpl, ...c, ready: () => true })).toBe(true);
    expect(calls).toBe(2);
  });

  it("sends on the last rung even if the gate never opened", async () => {
    // CLAUDE_CODE_DISABLE_TERMINAL_TITLE means no title is ever written, so the
    // glyph never arrives. The gate is there to deliver EARLY; the ladder
    // running out is the backstop, and by then Claude has had 11s to boot.
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, ready: () => false })).toBe(true);
    expect(f.sent).toEqual(["do the thing"]);
    expect(c.waited).toEqual([...FIRST_PROMPT_LADDER, 750]);
  });

  it("reports failure when every rung is spent unreachable", async () => {
    const f = scripted([502]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, ready: () => true })).toBe(false);
    expect(f.calls()).toBe(FIRST_PROMPT_LADDER.length);
  });

  it("sends nothing, and succeeds, when there is nothing to send", async () => {
    // An empty box is a real instruction: it makes a session and asks nothing.
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, lines: ["", ""], ready: () => true })).toBe(true);
    expect(f.calls()).toBe(0);
    expect(c.waited).toEqual([]);
  });

  it("drops empty lines from between real ones", async () => {
    // `modelCommandFor("default")` is null and arrives here as "".
    const f = scripted([204]);
    const c = fastClock();
    expect(await deliver({ ...f, ...c, lines: ["", "do the thing"], ready: () => true })).toBe(
      true,
    );
    expect(f.sent).toEqual(["do the thing"]);
  });

  it("addresses the session by id, url-encoded", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = fastClock();
    await deliver({ fetchImpl, ...c, session: "k7m2q9x4tp0z", ready: () => true });
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
      settleMs: 0,
      gapMs: 0,
      ready: () => true,
      fetchImpl: f.fetchImpl,
    }).then(spy);
    expect(spy).not.toHaveBeenCalled();
    await p;
    expect(spy).toHaveBeenCalledWith(true);
  });
});
