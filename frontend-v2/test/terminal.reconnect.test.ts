import { describe, it, expect } from "vitest";
import {
  OFFLINE_RETRY_MS,
  RETRY_DELAYS_MS,
  STABLE_AFTER_MS,
  initialLadder,
  nextRetryDelay,
  reduce,
  wake,
  type LadderAction,
  type LadderEvent,
  type LadderState,
  type Reduction,
} from "../src/terminal/reconnect";

// random() = 0 pins every jittered rung to the bottom of its window, so a
// delay asserted below is exactly rung/2 — 1000 is the 2s rung, 8000 the
// capped 16s one. The jitter itself is tested on its own further down.
const step = (state: LadderState, event: LadderEvent): Reduction =>
  reduce(state, event, { random: () => 0 });

const run = (state: LadderState, ...events: LadderEvent[]): LadderState =>
  events.reduce((s, e) => step(s, e).state, state);

/** Boot, then the socket opens: one attempt spent, nothing proved yet. */
const connected = (): LadderState => run(initialLadder(), { type: "start" }, { type: "opened" });

/** A first attempt that failed, so a rung is armed and its delay is running. */
const waiting = (): LadderState =>
  run(initialLadder(), { type: "start" }, { type: "attempt-failed", gen: 1, at: "token" });

/** The session was killed from another client and the ladder stood down. */
const ended = (): LadderState => {
  const checking = step(connected(), { type: "closed" }).state;
  return step(checking, { type: "session-checked", gen: checking.generation, exists: false }).state;
};

const kinds = (r: Reduction): string[] => r.actions.map((a) => a.type);

function find<K extends LadderAction["type"]>(
  r: Reduction,
  type: K,
): Extract<LadderAction, { type: K }> | undefined {
  return r.actions.find((a): a is Extract<LadderAction, { type: K }> => a.type === type);
}

describe("nextRetryDelay", () => {
  it("climbs 1s → 2s → 4s → 8s → 16s, one rung per attempt already made", () => {
    const ceiling = (attempts: number) => nextRetryDelay(attempts, { random: () => 1 });
    expect([0, 1, 2, 3, 4].map(ceiling)).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  /**
   * The cap is the whole point of a ladder: a server that is down for an hour
   * must not push the delay to an hour, or the terminal will not come back
   * for one after service returns.
   */
  it("caps at the top rung however long the outage runs", () => {
    const ceiling = (attempts: number) => nextRetryDelay(attempts, { random: () => 1 });
    expect(ceiling(5)).toBe(16000);
    expect(ceiling(50)).toBe(16000);
    expect(ceiling(5000)).toBe(16000);
  });

  /**
   * An outage ends for every client at the same instant. Without jitter every
   * open terminal, tab and phone marches into the same rungs and hits ttyd
   * together the moment service returns.
   */
  it("jitters a rung across [rung/2, rung] rather than firing on the rung itself", () => {
    expect(nextRetryDelay(1, { random: () => 0 })).toBe(1000);
    expect(nextRetryDelay(1, { random: () => 0.5 })).toBe(1500);
    expect(nextRetryDelay(1, { random: () => 0.999 })).toBeCloseTo(1999, 0);
  });

  it("puts two clients on the same rung at different moments", () => {
    const a = nextRetryDelay(4, { random: () => 0.1 });
    const b = nextRetryDelay(4, { random: () => 0.9 });
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect(d).toBeGreaterThanOrEqual(8000);
      expect(d).toBeLessThanOrEqual(16000);
    }
  });

  /**
   * navigator.onLine === false is the browser saying there is no path. Burning
   * a rung a second against it spends attempts and pill flicker for nothing —
   * park instead, and let the `online` event drive the real retry.
   */
  it("parks on the offline safety delay instead of taking a rung", () => {
    expect(nextRetryDelay(0, { online: false, random: () => 0 })).toBe(OFFLINE_RETRY_MS);
    expect(nextRetryDelay(4, { online: false, random: () => 1 })).toBe(OFFLINE_RETRY_MS);
  });

  it("does not jitter the park, and never consults random for it", () => {
    let calls = 0;
    const delay = nextRetryDelay(2, {
      online: false,
      random: () => {
        calls += 1;
        return 0.5;
      },
    });
    expect(delay).toBe(OFFLINE_RETRY_MS);
    expect(calls).toBe(0);
  });

  it("parks for longer than the deepest rung, so it is a brake and not a step", () => {
    expect(OFFLINE_RETRY_MS).toBeGreaterThan(Math.max(...RETRY_DELAYS_MS));
  });

  /**
   * A negative or NaN counter would index off the ladder, and `undefined / 2`
   * is NaN — which setTimeout treats as 0, turning the backoff into a hot loop
   * against a server that is already struggling.
   */
  it("clamps a nonsense attempt count instead of producing a zero delay", () => {
    for (const attempts of [-1, -99, Number.NaN]) {
      const delay = nextRetryDelay(attempts, { random: () => 0 });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(500);
    }
  });
});

describe("the ladder", () => {
  it("boots straight into attempt 1", () => {
    const r = step(initialLadder(), { type: "start" });
    expect(kinds(r)).toEqual(["connect"]);
    expect(find(r, "connect")).toMatchObject({ attempt: 1, gen: 1 });
    expect(r.state.phase).toBe("connecting");
  });

  it("climbs a rung for every attempt that fails, then holds at the cap", () => {
    const delays: number[] = [];
    let state = initialLadder();
    for (let i = 0; i < 5; i += 1) {
      state = step(state, { type: "start" }).state;
      const failed = step(state, { type: "attempt-failed", gen: state.generation, at: "token" });
      delays.push(find(failed, "schedule")?.delayMs ?? -1);
      state = failed.state;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  /**
   * The counter is attempts ALREADY STARTED, so the boot connect has spent one
   * before anything failed. The 1s rung is therefore not where a fresh page
   * begins — it belongs to a connection that proved stable and then dropped.
   */
  it("starts a fresh page's first retry on the 2s rung, not the 1s one", () => {
    const booted = run(initialLadder(), { type: "start" });
    const r = step(booted, { type: "attempt-failed", gen: booted.generation, at: "token" });
    expect(find(r, "schedule")?.delayMs).toBe(1000); // floor of the 2s rung
  });

  it("shows the waiting attempt under the number that attempt will run as", () => {
    const armed = step(waiting(), { type: "network", online: false });
    expect(find(armed, "schedule")?.attempt).toBe(2);
    const started = step(armed.state, { type: "start" });
    expect(find(started, "connect")?.attempt).toBe(2);
  });

  /** One pending attempt at a time — a second close must not stack a second rung. */
  it("does not arm a second rung while one is already running down", () => {
    expect(kinds(step(waiting(), { type: "closed" }))).toEqual([]);
  });
});

describe("the 30s stability proof", () => {
  it("arms the proof on open, carrying the generation that opened", () => {
    const r = step(run(initialLadder(), { type: "start" }), { type: "opened" });
    expect(kinds(r)).toEqual(["clear-stable", "arm-stable"]);
    expect(find(r, "arm-stable")).toMatchObject({ delayMs: STABLE_AFTER_MS, gen: 1 });
  });

  /**
   * Opening is not proof. Clearing the ladder here is what turns a flapping
   * link into a 1s hammer: every re-drop would restart at the bottom rung.
   */
  it("does not clear the ladder at the moment a connection opens", () => {
    expect(connected().attempts).toBe(1);
  });

  it("clears the ladder only once the connection has survived the proof", () => {
    const open = connected();
    const proved = step(open, { type: "proved-stable", gen: open.generation });
    expect(proved.state.attempts).toBe(0);
    expect(proved.actions).toEqual([]);
  });

  it("keeps the escalated delay when a connection re-drops before it proves stable", () => {
    let state = connected(); // attempt 1 spent
    for (const _ of [1, 2]) {
      const dropped = step(state, { type: "closed" });
      state = step(dropped.state, {
        type: "session-checked",
        gen: dropped.state.generation,
        exists: true,
      }).state;
      state = run(state, { type: "start" }, { type: "opened" });
    }
    const dropped = step(state, { type: "closed" });
    const armed = step(dropped.state, {
      type: "session-checked",
      gen: dropped.state.generation,
      exists: true,
    });
    expect(state.attempts).toBe(3);
    expect(find(armed, "schedule")?.delayMs).toBe(4000); // the 8s rung, not the 1s one
  });

  it("returns to the bottom rung after a connection that did prove stable", () => {
    const open = connected();
    const proved = step(open, { type: "proved-stable", gen: open.generation }).state;
    const dropped = step(proved, { type: "closed" });
    const armed = step(dropped.state, {
      type: "session-checked",
      gen: dropped.state.generation,
      exists: true,
    });
    expect(find(armed, "schedule")?.delayMs).toBe(500); // floor of the 1s rung
  });

  /**
   * term.html's liveness kill detaches the socket's handlers, so the onclose
   * that would have cleared the proof timer never runs. A proof left armed
   * from a connection nobody owns any more would clear the ladder mid-climb.
   */
  it("ignores a proof that lands after the connection is already gone", () => {
    const open = connected();
    const checking = step(open, { type: "closed" }).state;
    const late = step(checking, { type: "proved-stable", gen: open.generation });
    expect(late.state.attempts).toBe(1);
  });

  it("ignores a proof armed by a generation that has since been superseded", () => {
    const open = connected();
    const resumed = run(open, { type: "suspend" }, { type: "resume" }, { type: "opened" });
    const stale = step(resumed, { type: "proved-stable", gen: open.generation });
    expect(stale.state.attempts).toBe(2);
    const current = step(resumed, { type: "proved-stable", gen: resumed.generation });
    expect(current.state.attempts).toBe(0);
  });
});

describe("no resurrect", () => {
  /**
   * The first connection is the create/attach: there is no session to ask
   * about yet, and asking would be answered "no" — stranding a page that never
   * managed to connect at all.
   */
  it("retries a first connection without asking whether the session exists", () => {
    const booted = run(initialLadder(), { type: "start" });
    const r = step(booted, { type: "closed" });
    expect(kinds(r)).toEqual(["clear-stable", "schedule"]);
    expect(r.state.phase).toBe("waiting");
  });

  /**
   * After one successful connect a close may mean the session was killed from
   * another client, and reconnecting would recreate it via `tmux new-session -A`.
   */
  it("asks whether the session survived before retrying a later drop", () => {
    const r = step(connected(), { type: "closed" });
    expect(kinds(r)).toEqual(["clear-stable", "check-session"]);
    expect(find(r, "check-session")).toMatchObject({ gen: 1, attempt: 2 });
    expect(r.state.phase).toBe("checking");
  });

  it("resumes the ladder when the session is still there", () => {
    const checking = step(connected(), { type: "closed" }).state;
    const r = step(checking, { type: "session-checked", gen: checking.generation, exists: true });
    expect(kinds(r)).toEqual(["schedule"]);
    expect(r.state.phase).toBe("waiting");
  });

  it("stands the ladder down for good when the session is gone", () => {
    const checking = step(connected(), { type: "closed" }).state;
    const r = step(checking, { type: "session-checked", gen: checking.generation, exists: false });
    expect(kinds(r)).toEqual(["stand-down"]);
    expect(find(r, "stand-down")).toMatchObject({ reason: "session-ended" });
    expect(r.state.phase).toBe("ended");
  });

  /**
   * Every AUTOMATIC path, that is. The Reconnect button is the one deliberate
   * exception and has a block of its own below.
   */
  it("does nothing that would revive a session it already reported ended", () => {
    const dead = ended();
    for (const event of [
      { type: "start" },
      { type: "retry-now" },
      { type: "network", online: true },
      { type: "closed" },
      { type: "presumed-dead", gen: dead.generation },
    ] satisfies LadderEvent[]) {
      expect(kinds(step(dead, event))).toEqual([]);
    }
    expect(kinds(wake(dead, "tab visible", { random: () => 0 }))).toEqual([]);
  });

  /**
   * A suspend is the one way back in: term.html suspends on a hidden tab
   * whatever the ladder was doing, and every resume calls connect() — so a
   * tab hidden after "Session ended." would recreate the killed session when
   * it came back. An ended ladder therefore has nothing to suspend.
   */
  it("refuses to suspend an ended session, which a resume would then recreate", () => {
    const r = step(ended(), { type: "suspend" });
    expect(kinds(r)).toEqual([]);
    expect(r.state.phase).toBe("ended");
  });
});

describe("generations", () => {
  /**
   * The aborted attempt's own rejection arrives after the wake already
   * restarted it. Acting on it would arm a second rung against a single drop.
   */
  it("drops a token failure belonging to the attempt a wake already replaced", () => {
    const stalled = run(initialLadder(), { type: "start" }); // gen 1
    const restarted = step(stalled, { type: "retry-now", why: "back online" }).state; // gen 2
    expect(kinds(step(restarted, { type: "attempt-failed", gen: 1, at: "token" }))).toEqual([]);
    expect(
      kinds(step(restarted, { type: "attempt-failed", gen: restarted.generation, at: "token" })),
    ).toEqual(["schedule"]);
  });

  /**
   * A handshake deadline fires against a socket still in CONNECTING, which
   * fires neither onerror nor onclose — nothing else will ever tear it down,
   * so it has to be abandoned before the next rung is armed.
   */
  it("abandons a socket stuck mid-handshake before arming the next rung", () => {
    const stalled = run(initialLadder(), { type: "start" });
    const r = step(stalled, { type: "attempt-failed", gen: stalled.generation, at: "handshake" });
    expect(kinds(r)).toEqual(["abandon", "schedule"]);
    expect(r.state.generation).toBe(stalled.generation + 1);
  });

  it("leaves a settled token failure to the next connect to clean up", () => {
    const stalled = run(initialLadder(), { type: "start" });
    const r = step(stalled, { type: "attempt-failed", gen: stalled.generation, at: "token" });
    expect(kinds(r)).toEqual(["schedule"]);
    expect(r.state.generation).toBe(stalled.generation);
  });

  /**
   * The watchdog's socket still reports OPEN, so nothing will ever close it.
   * Bumping the generation as it goes is what keeps its queued callbacks from
   * landing later and arming a ladder beside the one this drop starts.
   */
  it("treats a socket the watchdog gave up on exactly like a real drop", () => {
    const open = connected();
    const r = step(open, { type: "presumed-dead", gen: open.generation });
    expect(kinds(r)).toEqual(["abandon", "clear-stable", "check-session"]);
    expect(r.state.generation).toBe(open.generation + 1);
    expect(find(r, "check-session")?.gen).toBe(open.generation + 1);
    expect(r.state.phase).toBe("checking");
  });

  it("has no verdict to act on when the watchdog fires without an open socket", () => {
    const armed = waiting();
    expect(kinds(step(armed, { type: "presumed-dead", gen: armed.generation }))).toEqual([]);
  });

  /**
   * The probe captures its generation at the top (term.html:10080) and checks
   * it again after its Promise.all (10102: `if (gen !== connGen) return; // the
   * socket was replaced while we waited`) because it easily outlives the socket
   * it was judging — a drop, an existence check, a rung and a fresh open all
   * fit inside one probe's fetch-plus-drain window. By then `phase === "open"`
   * is true again, so the phase alone cannot tell the dead socket from the
   * healthy one that replaced it, and the stale verdict kills the healthy one.
   */
  it("ignores a liveness verdict about a socket that has since been replaced", () => {
    const first = connected(); // gen 1 — the socket the probe is judging
    const checking = step(first, { type: "closed" }).state;
    const armed = step(checking, {
      type: "session-checked",
      gen: checking.generation,
      exists: true,
    }).state;
    const reopened = run(armed, { type: "start" }, { type: "opened" }); // gen 2 — healthy
    expect(reopened.phase).toBe("open");
    expect(reopened.generation).toBe(first.generation + 1);

    expect(kinds(step(reopened, { type: "presumed-dead", gen: first.generation }))).toEqual([]);
    // The verdict about the socket that IS current still lands.
    expect(kinds(step(reopened, { type: "presumed-dead", gen: reopened.generation }))).toEqual([
      "abandon",
      "clear-stable",
      "check-session",
    ]);
  });

  /** The same race, one tap wide: the button replaces the socket mid-probe. */
  it("ignores a liveness verdict for a socket the Reconnect button replaced", () => {
    const open = connected();
    const reopened = run(
      open,
      { type: "reconnect-tapped", why: "asked by the lobby" },
      { type: "opened" },
    );
    expect(reopened.phase).toBe("open");
    expect(kinds(step(reopened, { type: "presumed-dead", gen: open.generation }))).toEqual([]);
  });

  /**
   * The check outlives the connection it was asked about: a suspend and resume
   * started a fresh attempt that owns the page. Honouring the late answer
   * would either stand a live ladder down or arm a competing rung.
   */
  it("ignores a session answer that a suspend and resume have overtaken", () => {
    const checking = step(connected(), { type: "closed" }).state;
    const restarted = run(checking, { type: "suspend" }, { type: "resume" });
    const late = step(restarted, {
      type: "session-checked",
      gen: checking.generation,
      exists: false,
    });
    expect(kinds(late)).toEqual([]);
    expect(late.state.phase).toBe("connecting");
  });

  /**
   * Two existence checks can be outstanding at once — a slow one on a
   * struggling network, and a second drop after a suspend and resume. Only the
   * generation tells them apart, and the older answer describes a session
   * state that is already two attempts out of date.
   */
  it("answers to the newer of two existence checks in flight", () => {
    const first = step(connected(), { type: "closed" }).state; // check A, gen 1
    const second = step(run(first, { type: "suspend" }, { type: "resume" }), {
      type: "closed",
    }).state; // check B, gen 3
    expect(second.phase).toBe("checking");
    expect(kinds(step(second, { type: "session-checked", gen: first.generation, exists: false })))
      .toEqual([]);
    expect(
      kinds(step(second, { type: "session-checked", gen: second.generation, exists: true })),
    ).toEqual(["schedule"]);
  });

  /**
   * `connect` abandons whatever the previous attempt owned on its own. A
   * second bump alongside it would invalidate the generation the caller is
   * about to stamp that attempt's callbacks with.
   */
  it("never asks for an abandon in the same breath as a connect", () => {
    for (const state of Object.values(everyState())) {
      for (const event of everyEventFor(state)) {
        const k = kinds(step(state, event));
        expect(k.includes("connect") && k.includes("abandon")).toBe(false);
      }
    }
  });
});

describe("bringing a retry forward", () => {
  it("fires an armed rung immediately instead of waiting it out", () => {
    const r = step(waiting(), { type: "retry-now", why: "tab visible" });
    expect(kinds(r)).toEqual(["cancel-scheduled", "connect"]);
  });

  /**
   * The half that used to be missing. Over a dead path the attempt can only
   * time out, and while it hangs there is no timer at all — so a wake gated on
   * "a retry is pending" did nothing at exactly the moment it was wanted.
   */
  it("restarts an attempt stalled over a dead path, which owns no timer", () => {
    const stalled = run(initialLadder(), { type: "start" });
    const r = step(stalled, { type: "retry-now", why: "back online" });
    expect(kinds(r)).toEqual(["connect"]);
    expect(r.state.generation).toBe(stalled.generation + 1);
  });

  it("leaves a healthy open socket strictly alone", () => {
    expect(kinds(step(connected(), { type: "retry-now", why: "tab visible" }))).toEqual([]);
  });

  /** The check has its own deadline, and its answer is what owns the ladder. */
  it("does not start a second attempt while the session check is in flight", () => {
    const checking = step(connected(), { type: "closed" }).state;
    expect(kinds(step(checking, { type: "retry-now", why: "tab visible" }))).toEqual([]);
  });

  it("costs a rung rather than restarting the ladder at the bottom", () => {
    const jumped = step(waiting(), { type: "retry-now" }).state;
    expect(jumped.attempts).toBe(2);
    const failed = step(jumped, { type: "attempt-failed", gen: jumped.generation, at: "token" });
    expect(find(failed, "schedule")?.delayMs).toBe(2000); // the 4s rung, still climbing
  });
});

/**
 * term.html's `tl-conn-retry` branch: `if (!resumeFromSuspend('asked by the
 * lobby')) { clearTimeout(retryTimer); retryTimer = null; connect(); }` — an
 * unconditional connect(), commented "Explicitly tapped, never automatic".
 * Every phase below is one `retry-now` deliberately refuses, so a component
 * wiring the button to `retry-now` (or to its own connect()) would either do
 * nothing or desync the counter, the generation and the phase.
 */
describe("the Reconnect button", () => {
  const tap = (state: LadderState): Reduction =>
    step(state, { type: "reconnect-tapped", why: "asked by the lobby" });

  /**
   * The one that matters. After "Session ended." a tap really does recreate the
   * session through `tmux new-session -A` — that is the button's job. The
   * no-resurrect rule stops the PAGE reviving a killed session by itself; it
   * was never meant to stop the person who pressed the button.
   */
  it("resurrects a session the ladder already reported ended", () => {
    const dead = ended();
    const r = tap(dead);
    expect(kinds(r)).toEqual(["connect"]);
    expect(r.state.phase).toBe("connecting");
    expect(find(r, "connect")).toMatchObject({
      attempt: dead.attempts + 1,
      gen: dead.generation + 1,
    });
  });

  it("tears a healthy open socket down and opens a fresh one", () => {
    const open = connected();
    const r = tap(open);
    expect(kinds(r)).toEqual(["clear-stable", "connect"]);
    expect(r.state.phase).toBe("connecting");
    // The bump is what keeps the replaced socket's own callbacks from landing.
    expect(r.state.generation).toBe(open.generation + 1);
  });

  /**
   * connect()'s abandonAttempt() bumps connGen, so the answer to the check this
   * tap interrupted describes a connection nobody is waiting on any more.
   * Honouring it would stand the fresh attempt down or arm a rung beside it.
   */
  it("starts over from a session check, and drops the answer it interrupted", () => {
    const checking = step(connected(), { type: "closed" }).state;
    const r = tap(checking);
    expect(kinds(r)).toEqual(["connect"]);
    const late = step(r.state, {
      type: "session-checked",
      gen: checking.generation,
      exists: false,
    });
    expect(kinds(late)).toEqual([]);
    expect(late.state.phase).toBe("connecting");
  });

  /** The handler tries `resumeFromSuspend` first, and that is what lifts the hold. */
  it("lifts a battery suspend a tab that never came back would still be holding", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    const r = tap(suspended);
    expect(kinds(r)).toEqual(["connect"]);
    expect(r.state.phase).toBe("connecting");
  });

  it("brings an armed rung forward rather than opening a second socket beside it", () => {
    expect(kinds(tap(waiting()))).toEqual(["cancel-scheduled", "connect"]);
  });

  it("connects a page that has not tried anything yet", () => {
    const r = tap(initialLadder());
    expect(kinds(r)).toEqual(["connect"]);
    expect(find(r, "connect")).toMatchObject({ attempt: 1, gen: 1 });
  });

  /**
   * "one rung off the ladder rather than opening a second socket": a tap spends
   * an attempt like any other, so leaning on the button escalates the backoff
   * instead of resetting it to the bottom.
   */
  it("costs a rung rather than restarting the ladder at the bottom", () => {
    const tapped = tap(connected()).state;
    expect(tapped.attempts).toBe(2);
    const failed = step(tapped, { type: "attempt-failed", gen: tapped.generation, at: "token" });
    expect(find(failed, "schedule")?.delayMs).toBe(2000); // the 4s rung, still climbing
  });

  it("starts exactly one attempt from every phase there is", () => {
    for (const [name, state] of Object.entries(everyState())) {
      const r = tap(state);
      expect(kinds(r).filter((k) => k === "connect"), name).toHaveLength(1);
      expect(r.state.phase, name).toBe("connecting");
      expect(r.state.generation, name).toBe(state.generation + 1);
      expect(r.state.attempts, name).toBe(state.attempts + 1);
    }
  });
});

describe("the network coming and going", () => {
  /**
   * Going offline at the bottom of the ladder used to keep firing a doomed
   * attempt every second until the ladder climbed out of it.
   */
  it("re-parks an armed rung on the offline delay the moment the path drops", () => {
    const r = step(waiting(), { type: "network", online: false });
    expect(kinds(r)).toEqual(["cancel-scheduled", "schedule"]);
    expect(find(r, "schedule")).toMatchObject({ delayMs: OFFLINE_RETRY_MS, attempt: 2 });
    expect(r.state.phase).toBe("waiting");
  });

  /** onLine lies in both directions, so an attempt already running is left to answer for itself. */
  it("lets an in-flight attempt run when the browser says the path is gone", () => {
    const stalled = run(initialLadder(), { type: "start" });
    const r = step(stalled, { type: "network", online: false });
    expect(kinds(r)).toEqual([]);
    expect(r.state.phase).toBe("connecting");
    expect(r.state.online).toBe(false);
  });

  it("parks a drop that happens while the browser is already offline", () => {
    const offline = step(connected(), { type: "network", online: false }).state;
    const checking = step(offline, { type: "closed" }).state;
    const armed = step(checking, {
      type: "session-checked",
      gen: checking.generation,
      exists: true,
    });
    expect(find(armed, "schedule")?.delayMs).toBe(OFFLINE_RETRY_MS);
  });

  it("retries the instant the network returns rather than serving out the park", () => {
    const parked = step(waiting(), { type: "network", online: false }).state;
    const r = step(parked, { type: "network", online: true });
    expect(kinds(r)).toEqual(["cancel-scheduled", "connect"]);
    expect(r.state.online).toBe(true);
  });

  it("does not disturb an open socket when the network flaps", () => {
    const open = connected();
    const flapped = step(open, { type: "network", online: false });
    expect(kinds(flapped)).toEqual([]);
    expect(kinds(step(flapped.state, { type: "network", online: true }))).toEqual([]);
  });
});

describe("the battery saver", () => {
  it("tears the connection down and stands the ladder down when the tab stays hidden", () => {
    const r = step(connected(), { type: "suspend" });
    expect(kinds(r)).toEqual(["clear-stable", "abandon", "stand-down"]);
    expect(find(r, "stand-down")).toMatchObject({ reason: "suspended" });
    expect(r.state.phase).toBe("suspended");
  });

  it("drops a pending rung when it suspends, so nothing fires behind a locked screen", () => {
    expect(kinds(step(waiting(), { type: "suspend" }))).toEqual([
      "cancel-scheduled",
      "clear-stable",
      "abandon",
      "stand-down",
    ]);
  });

  /** The hidden-grace timer can fire once more after the tab is already shown or suspended. */
  it("suspends only once", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    expect(kinds(step(suspended, { type: "suspend" }))).toEqual([]);
  });

  /** Deliberate teardown: the tab coming back is what reconnects it, not the ladder. */
  it("arms nothing when the socket it closed on purpose reports closed", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    expect(kinds(step(suspended, { type: "closed" }))).toEqual([]);
  });

  it("reuses the ladder on resume rather than restarting it at the bottom rung", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    const r = step(suspended, { type: "resume", why: "tab visible" });
    expect(kinds(r)).toEqual(["connect"]);
    expect(find(r, "connect")?.attempt).toBe(2);
    const failed = step(r.state, { type: "attempt-failed", gen: r.state.generation, at: "token" });
    expect(find(failed, "schedule")?.delayMs).toBe(2000); // the 4s rung, not the 1s one
  });

  /** A bfcache restore fires on a page that was never suspended too. */
  it("ignores a resume on a tab that was never put down", () => {
    expect(kinds(step(connected(), { type: "resume", why: "bfcache restore" }))).toEqual([]);
    expect(kinds(step(waiting(), { type: "resume", why: "bfcache restore" }))).toEqual([]);
  });

  /**
   * A suspended ladder has neither a timer nor an attempt, so the wake has to
   * try the resume first — `retry-now` alone would leave a hidden-then-shown
   * tab dark for as long as it stayed open.
   */
  it("wakes a suspended tab, and falls through to an instant retry when none was suspended", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    expect(kinds(wake(suspended, "tab visible", { random: () => 0 }))).toEqual(["connect"]);
    expect(kinds(wake(waiting(), "tab visible", { random: () => 0 }))).toEqual([
      "cancel-scheduled",
      "connect",
    ]);
    expect(kinds(wake(connected(), "tab visible", { random: () => 0 }))).toEqual([]);
  });

  /**
   * `back online` is retry-now alone, and a suspended ladder owns no timer and
   * no attempt — so the network returning cannot lift a battery suspend. Only
   * the tab coming back does.
   */
  it("stays down when the network returns behind a locked screen", () => {
    const suspended = step(connected(), { type: "suspend" }).state;
    expect(kinds(step(suspended, { type: "network", online: true }))).toEqual([]);
    expect(kinds(step(suspended, { type: "retry-now", why: "back online" }))).toEqual([]);
    expect(kinds(step(suspended, { type: "start" }))).toEqual([]);
  });
});

/**
 * The invariant the component leans on: it can execute an action list top to
 * bottom without ever asking itself whether its pending timer is still wanted.
 */
describe("an armed rung is always cancelled before anything replaces it", () => {
  it("holds for every event a waiting ladder can receive", () => {
    const armed = waiting();
    expect(armed.phase).toBe("waiting");
    for (const event of everyEventFor(armed)) {
      const r = step(armed, event);
      if (r.actions.length === 0) continue;
      expect(r.actions[0]?.type, `first action for ${event.type}`).toBe("cancel-scheduled");
    }
  });

  it("never asks to cancel a rung that was never armed", () => {
    for (const [name, state] of Object.entries(everyState())) {
      if (state.phase === "waiting") continue;
      for (const event of everyEventFor(state)) {
        expect(kinds(step(state, event)), `${name} / ${event.type}`).not.toContain(
          "cancel-scheduled",
        );
      }
    }
  });
});

function everyState(): Record<string, LadderState> {
  return {
    idle: initialLadder(),
    connecting: run(initialLadder(), { type: "start" }),
    open: connected(),
    waiting: waiting(),
    checking: step(connected(), { type: "closed" }).state,
    suspended: step(connected(), { type: "suspend" }).state,
    ended: ended(),
  };
}

/** Every event shape, stamped with the generation the given state is on. */
function everyEventFor(state: LadderState): LadderEvent[] {
  const gen = state.generation;
  return [
    { type: "start" },
    { type: "opened" },
    { type: "proved-stable", gen },
    { type: "closed" },
    { type: "presumed-dead", gen },
    { type: "attempt-failed", gen, at: "token" },
    { type: "attempt-failed", gen, at: "handshake" },
    { type: "session-checked", gen, exists: true },
    { type: "session-checked", gen, exists: false },
    { type: "network", online: true },
    { type: "network", online: false },
    { type: "retry-now", why: "tab visible" },
    { type: "reconnect-tapped", why: "asked by the lobby" },
    { type: "suspend" },
    { type: "resume", why: "tab visible" },
  ];
}
