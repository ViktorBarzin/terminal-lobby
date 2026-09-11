import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRACE_SLACK_MS,
  HIDDEN_SUSPEND_MS,
  OFFSCREEN_SUSPEND_MS,
  decide,
  graceFor,
  isAway,
  type BatteryAction,
  type BatteryEvent,
  type BatteryState,
} from "../src/terminal/battery";

/**
 * The battery saver's rules, as they were paid for in frontend/term.html, plus
 * the one input the lobby added on 2026-09-11. Each test below is one rule; a
 * port that drops or inverts one fails here rather than on someone's phone.
 *
 * The page had one away input, `document.hidden`, because it was one terminal
 * per page and a hidden page meant a hidden terminal. The lobby keeps every
 * visited session mounted at once, so "is anyone reading THIS session" is two
 * questions (docs/plans/2026-09-11-client-cpu-parking-design.md). Everything
 * the page's rules said about the hidden tab still has to hold for the second
 * one, which is why the cases below come in pairs.
 *
 * A third input, `!document.hasFocus()`, was built and taken back out the same
 * day. The cases that pinned it are gone with it rather than rewritten: what
 * they described was a condition that no longer exists, and battery.ts carries
 * the reckoning for why it went.
 */

/** Nobody away: a visible tab with this session on screen. */
const present = (over: Partial<BatteryState> = {}): BatteryState => ({
  hidden: false,
  offScreen: false,
  msAway: 0,
  suspended: false,
  ...over,
});

const hidden = (msAway: number | null, suspended = false): BatteryState =>
  present({ hidden: true, msAway, suspended });

/** Another SESSION in front, in a tab that is visible. */
const offScreen = (msAway: number | null, suspended = false): BatteryState =>
  present({ offScreen: true, msAway, suspended });

/**
 * A tab opened into the background: hidden, with no visibilitychange behind it
 * and so nothing to measure a hidden-since from.
 */
const bootedHidden = (suspended = false): BatteryState => hidden(null, suspended);

const visible = (suspended = false): BatteryState => present({ suspended });

describe("the grace before a suspend", () => {
  /**
   * The whole point of the 60s wait: a brief app-switch — glance at a message,
   * scan a QR code — must not cost a reconnect flicker on the way back.
   */
  it("does not take the socket down the moment the tab is hidden", () => {
    expect(decide(hidden(0), "hidden").action).toBe("nothing");
  });

  it("starts counting the moment the tab is hidden", () => {
    expect(decide(hidden(0), "hidden").grace).toBe(true);
  });

  it("suspends once the tab has been hidden for the full grace", () => {
    const d = decide(hidden(HIDDEN_SUSPEND_MS), "grace-elapsed");
    expect(d.action).toBe("suspend");
    expect(d.why).toBe(`tab hidden ${HIDDEN_SUSPEND_MS}ms`);
  });

  /**
   * A callback left over from an EARLIER hidden run — hide, show, hide again —
   * would otherwise suspend seconds into the new grace and hand back the
   * flicker the grace exists to prevent.
   */
  it("ignores a countdown that fires a whole grace period early", () => {
    const d = decide(hidden(1000), "grace-elapsed");
    expect(d.action).toBe("nothing");
    expect(d.grace).toBe(true); // still hidden, still counting
  });

  /**
   * Timers may run a shade early and clocks are coarse. The deadline check is
   * there to reject stale callbacks, not to police the millisecond, so a
   * callback that lands just inside the deadline must still suspend.
   */
  it("suspends on a countdown that fires a hair early", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS - GRACE_SLACK_MS), "grace-elapsed").action).toBe(
      "suspend",
    );
    expect(decide(hidden(HIDDEN_SUSPEND_MS - GRACE_SLACK_MS - 1), "grace-elapsed").action).toBe(
      "nothing",
    );
  });

  /**
   * `graceFor` keys off the off-screen input alone, so a hidden tab keeps the
   * full minute even though a shorter half-minute row exists beside it. Handing
   * a locked phone the shorter one would charge a reconnect for the half minute
   * the tab spent face down, which is what the minute was tuned to buy off.
   */
  it("waits the tab's full minute, not the shorter off-screen half", () => {
    expect(decide(hidden(OFFSCREEN_SUSPEND_MS), "grace-elapsed").action).toBe("nothing");
    expect(decide(hidden(HIDDEN_SUSPEND_MS), "grace-elapsed").action).toBe("suspend");
  });

  it("stops counting once the socket is down", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS), "grace-elapsed").grace).toBe(false);
  });

  it("does not suspend a socket that is already suspended", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 10, true), "grace-elapsed").action).toBe("nothing");
  });

  /**
   * A page opened into a background tab arms the same countdown by itself:
   * visibilitychange will not fire until the tab is first shown, so booting
   * hidden is the one moment nothing else will start the clock.
   */
  it("arms the countdown on a page that boots into a background tab", () => {
    const d = decide(hidden(0), "boot");
    expect(d.action).toBe("nothing");
    expect(d.grace).toBe(true);
  });

  it("runs no countdown on a page that boots visible", () => {
    const d = decide(visible(), "boot");
    expect(d.action).toBe("nothing");
    expect(d.grace).toBe(false);
  });
});

/**
 * THE SECOND AWAY INPUT, and the only one that is per-session. The lobby mounts
 * a terminal for every session visited and CSS-hides all but one, so fourteen
 * of fifteen terminals are off screen in a tab that is perfectly visible.
 * Nothing in the page this module came from could express that, because the
 * page was one terminal.
 */
describe("the session nobody is looking at", () => {
  it("does not take the socket down the moment the session goes off screen", () => {
    const d = decide(offScreen(0), "off-screen");
    expect(d.action).toBe("nothing");
    expect(d.grace).toBe(true);
  });

  /**
   * Half the tab's grace, which is what makes flicking between two sessions
   * free: 30s is longer than any look-and-go, and short enough that a pointer
   * run down the sidebar does not leave a trail of live sockets behind it.
   */
  it("suspends after half the tab's grace", () => {
    const d = decide(offScreen(OFFSCREEN_SUSPEND_MS), "grace-elapsed");
    expect(d.action).toBe("suspend");
    expect(d.why).toBe(`off screen ${OFFSCREEN_SUSPEND_MS}ms`);
  });

  it("does not suspend a session that flicked away and is still inside the grace", () => {
    expect(
      decide(offScreen(OFFSCREEN_SUSPEND_MS - GRACE_SLACK_MS - 1), "grace-elapsed").action,
    ).toBe("nothing");
  });

  it("suspends on a countdown that fires a hair early", () => {
    expect(decide(offScreen(OFFSCREEN_SUSPEND_MS - GRACE_SLACK_MS), "grace-elapsed").action).toBe(
      "suspend",
    );
  });

  it("comes back when the session is on screen again", () => {
    const d = decide(present({ suspended: true }), "on-screen");
    expect(d.action).toBe("resume");
    expect(d.why).toBe("session on screen");
  });

  /**
   * A session pre-mounted behind the one being read boots off screen, and no
   * transition follows to start its clock. The same hole the background-tab
   * boot leaves, for the same reason.
   */
  it("arms the countdown on a session that boots off screen", () => {
    expect(decide(offScreen(0), "boot").grace).toBe(true);
  });
});

/**
 * The grace is not a constant any more, so which one applies is its own rule.
 * The shortest one among the conditions holding wins, because each row of the
 * design's table earns a suspend on its own: a session that has been off screen
 * for 30s has earned it whether or not the tab is also hidden, and waiting the
 * longer minute there would park a MORE away session LATER.
 */
describe("which grace applies", () => {
  it("is half a minute off screen and a full minute for the window-wide ones", () => {
    expect(OFFSCREEN_SUSPEND_MS).toBe(30000);
    expect(HIDDEN_SUSPEND_MS).toBe(60000);
  });

  it("takes the shortest grace among the conditions holding", () => {
    expect(graceFor(offScreen(0))).toBe(OFFSCREEN_SUSPEND_MS);
    expect(graceFor(hidden(0))).toBe(HIDDEN_SUSPEND_MS);
    expect(graceFor(present({ hidden: true, offScreen: true }))).toBe(OFFSCREEN_SUSPEND_MS);
  });

  it("suspends an off-screen session in a hidden tab on the shorter clock", () => {
    const s = present({ hidden: true, offScreen: true, msAway: OFFSCREEN_SUSPEND_MS });
    const d = decide(s, "grace-elapsed");
    expect(d.action).toBe("suspend");
    expect(d.why).toBe(`tab hidden + off screen ${OFFSCREEN_SUSPEND_MS}ms`);
  });

  it("hands the component the grace to arm, and nothing to arm when present", () => {
    expect(decide(offScreen(0), "off-screen").graceMs).toBe(OFFSCREEN_SUSPEND_MS);
    expect(decide(hidden(0), "hidden").graceMs).toBe(HIDDEN_SUSPEND_MS);
    expect(decide(visible(), "visible").graceMs).toBe(0);
    // A suspended socket has nothing left to count down to.
    expect(decide(hidden(HIDDEN_SUSPEND_MS), "grace-elapsed").graceMs).toBe(0);
  });

  it("names each away condition, and nothing when both are clear", () => {
    expect(isAway(present())).toBe(false);
    expect(isAway(hidden(0))).toBe(true);
    expect(isAway(offScreen(0))).toBe(true);
  });
});

describe("the tab that booted hidden", () => {
  /**
   * The one run nothing can stamp. term.html:9966 arms the countdown straight
   * from the load — `if (document.hidden) hiddenSuspendTimer =
   * setTimeout(suspendForBattery, HIDDEN_SUSPEND_MS)` — and suspendForBattery
   * checks no clock at all. A staleness rule that reads "no stamp" as "far too
   * early" turns the guard against the very tab it was written for.
   */
  it("suspends a countdown that no visibilitychange was there to stamp", () => {
    const d = decide(bootedHidden(), "grace-elapsed");
    expect(d.action).toBe("suspend");
    expect(d.why).toBe(`tab hidden ${HIDDEN_SUSPEND_MS}ms`);
  });

  /** The same hole, on the input that did not exist then. */
  it("suspends an unstamped run on a session that booted off screen", () => {
    expect(decide(offScreen(null), "grace-elapsed").action).toBe("suspend");
  });

  /**
   * The failure the rule above prevents, driven the way the component runs it:
   * decide, apply, re-arm while `grace` holds. Answering `nothing` here is not
   * a one-off miss — the state never changes, so the next countdown lands on
   * the same answer, forever, and the socket this module exists to drop is
   * held open for the life of the tab.
   */
  it("does not re-arm its countdown forever without ever suspending", () => {
    let suspended = false;
    let armed = false;
    const step = (event: BatteryEvent): BatteryAction => {
      const d = decide(bootedHidden(suspended), event);
      if (d.action === "suspend") suspended = true;
      if (d.action === "resume") suspended = false;
      armed = d.grace;
      return d.action;
    };

    expect(step("boot")).toBe("nothing");
    expect(armed).toBe(true); // nothing else will start this clock

    expect(step("grace-elapsed")).toBe("suspend");
    expect(suspended).toBe(true);
    expect(armed).toBe(false); // a down socket has nothing to count down to

    // And it stays down: the countdown is not re-armed behind it.
    expect(step("grace-elapsed")).toBe("nothing");
    expect(armed).toBe(false);
  });

  /**
   * Waking it is the ordinary path — the stamp is missing, not the state.
   */
  it("resumes a boot-hidden suspend when the tab is finally shown", () => {
    expect(decide(visible(true), "visible").action).toBe("resume");
  });

  /**
   * The stale-callback rule still holds wherever a stamp exists, which is
   * every run a visibilitychange started. Losing that would hand back the
   * flicker on hide → show → hide.
   */
  it("still rejects an early countdown on a run that was stamped", () => {
    expect(decide(hidden(0), "grace-elapsed").action).toBe("nothing");
    expect(decide(hidden(2000), "grace-elapsed").action).toBe("nothing");
  });
});

describe("the guard on a visible tab", () => {
  /**
   * The incident this rule is made of: the countdown's callback can already be
   * queued when the tab is shown, so clearing the timer misses it. Suspending
   * then closes a HEALTHY socket, and a visible tab fires no further
   * visibilitychange — nothing is left to reopen it, and the terminal is frozen
   * until the user reloads.
   *
   * Widened with the question: the callback has to find NOBODY reading, not
   * merely a hidden tab, so a session back on screen is guarded the same way a
   * shown tab is.
   */
  it("never suspends a terminal someone is reading, even when its countdown fires", () => {
    expect(decide(visible(), "grace-elapsed").action).toBe("nothing");
  });

  it("never suspends one however long it was away before", () => {
    const late = present({ msAway: HIDDEN_SUSPEND_MS * 100 });
    expect(decide(late, "grace-elapsed").action).toBe("nothing");
  });

  it("leaves no countdown running while someone is reading", () => {
    const events: BatteryEvent[] = ["visible", "on-screen", "grace-elapsed", "boot", "asked"];
    for (const e of events) {
      expect(decide(visible(), e).grace, e).toBe(false);
    }
  });
});

describe("coming back", () => {
  it("reconnects when the tab is shown again", () => {
    const d = decide(visible(true), "visible");
    expect(d.action).toBe("resume");
    expect(d.why).toBe("tab visible");
  });

  /**
   * A tab that was never suspended holds a socket that is either healthy or
   * already climbing the reconnect ladder. Resuming it here would drop the
   * first and duplicate the second; the visible handler's own retryNow is what
   * brings a pending attempt forward.
   */
  it("does not reconnect a tab that was never suspended", () => {
    expect(decide(visible(), "visible").action).toBe("nothing");
  });

  /**
   * THE RULE THAT MAKES TWO INPUTS SAFE. Away is the OR of them, so coming back
   * is the AND: one condition clearing while the other still holds must leave
   * the socket down. Resuming on the first of two would put a live socket on a
   * session nobody can see, which is the whole cost this pass was written to
   * remove.
   */
  it("stays down while the other condition still holds", () => {
    // The tab is shown, but this session is behind another session.
    expect(decide(present({ offScreen: true, suspended: true }), "visible").action).toBe("nothing");
    // The session is on screen, in a tab that is still hidden.
    expect(decide(present({ hidden: true, suspended: true }), "on-screen").action).toBe("nothing");
  });

  it("keeps counting down the condition that is left", () => {
    const d = decide(present({ offScreen: true, suspended: true }), "visible");
    expect(d.grace).toBe(false); // still suspended, nothing to count
  });

  it("comes back when the last of the two clears", () => {
    expect(decide(present({ suspended: true }), "on-screen").action).toBe("resume");
    expect(decide(present({ suspended: true }), "visible").action).toBe("resume");
  });

  /**
   * iOS standalone returns the page frozen rather than reloaded, and its
   * visibilitychange can be unreliable — a persisted pageshow is the belt to
   * that suspender. Without it a phone unlocked into the PWA sits on a dead
   * socket with no event left to wake it.
   */
  it("wakes a suspend from a bfcache restore", () => {
    const d = decide(visible(true), "bfcache-restore");
    expect(d.action).toBe("resume");
    expect(d.why).toBe("bfcache restore");
  });

  /**
   * Both events fire on one wake. The second must decide nothing, or the
   * component connects twice for a single restore.
   */
  it("resumes once when visibilitychange and pageshow both fire on one wake", () => {
    const first = decide(visible(true), "visible");
    expect(first.action).toBe("resume");
    // The component applied it, so the socket is no longer suspended.
    expect(decide(visible(false), "bfcache-restore").action).toBe("nothing");
  });

  it("resumes when the lobby's Reconnect button asks", () => {
    const d = decide(visible(true), "asked");
    expect(d.action).toBe("resume");
    expect(d.why).toBe("asked by the lobby");
  });

  /**
   * Reconnect on a tab that is merely disconnected is the ladder's job, not
   * ours — the module says nothing so the component takes a rung off the
   * ladder instead of opening a second socket beside the first.
   */
  it("leaves an ordinary Reconnect to the ladder", () => {
    expect(decide(visible(), "asked").action).toBe("nothing");
  });

  /**
   * Resuming a still-away terminal (an unreliable pageshow, or the lobby
   * asking while the phone is away) must restart the countdown. Otherwise the
   * socket is back up with no clock on it and no transition coming, and the
   * battery saver is defeated until the next away cycle.
   *
   * These two events answer for a person, not for a condition, which is why
   * they resume where `visible` and `on-screen` would not: a tap on Reconnect
   * means "give me this socket now", and an iOS restore has no reliable
   * condition to read at all.
   */
  it("starts the countdown again when a still-away terminal resumes", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 2, true), "bfcache-restore").grace).toBe(true);
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 2, false), "asked").grace).toBe(true);
    expect(decide(offScreen(OFFSCREEN_SUSPEND_MS * 2, true), "asked").grace).toBe(true);
  });

  /**
   * And it arms the WHOLE grace rather than whatever is left of a run that has
   * already overrun it: the socket only just came back, so the clock on it is
   * new. `graceMs` is the length to arm, not the remainder.
   */
  it("hands back a full grace for a resume that leaves the terminal away", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 2, true), "asked").graceMs).toBe(HIDDEN_SUSPEND_MS);
    expect(decide(offScreen(OFFSCREEN_SUSPEND_MS * 9, true), "asked").graceMs).toBe(
      OFFSCREEN_SUSPEND_MS,
    );
  });

  it("says nothing about why when it decides nothing", () => {
    expect(decide(visible(), "visible").why).toBe("");
    expect(decide(hidden(0), "hidden").why).toBe("");
    expect(decide(offScreen(0), "off-screen").why).toBe("");
  });
});

describe("a phone put down and picked up again", () => {
  /**
   * The whole cycle end to end, since the rules only earn their keep in
   * sequence: each step feeds the previous decision's outcome back in, the way
   * the component will.
   */
  it("suspends once, resumes once, and leaves the countdown where it belongs", () => {
    let suspended = false;
    let grace = false;
    const step = (state: Omit<BatteryState, "suspended">, event: BatteryEvent) => {
      const d = decide({ ...state, suspended }, event);
      if (d.action === "suspend") suspended = true;
      if (d.action === "resume") suspended = false;
      grace = d.grace;
      return d.action;
    };
    const at = (over: Partial<BatteryState>): Omit<BatteryState, "suspended"> => {
      const { suspended: _ignored, ...rest } = present(over);
      return rest;
    };

    expect(step(at({}), "boot")).toBe("nothing");
    expect(grace).toBe(false);

    // Screen locked.
    expect(step(at({ hidden: true }), "hidden")).toBe("nothing");
    expect(grace).toBe(true);

    // Glanced at it 20s later, then locked again: no suspend, no flicker.
    expect(step(at({}), "visible")).toBe("nothing");
    expect(grace).toBe(false);
    expect(step(at({ hidden: true }), "hidden")).toBe("nothing");

    // A callback queued by the first hide lands 2s into the second: too early.
    expect(step(at({ hidden: true, msAway: 2000 }), "grace-elapsed")).toBe("nothing");
    expect(suspended).toBe(false);
    expect(grace).toBe(true);

    // Put down properly this time.
    expect(step(at({ hidden: true, msAway: HIDDEN_SUSPEND_MS }), "grace-elapsed")).toBe("suspend");
    expect(grace).toBe(false);

    // Picked up: one resume, whichever of the two wake events lands first.
    expect(step(at({}), "visible")).toBe("resume");
    expect(step(at({}), "bfcache-restore")).toBe("nothing");
    expect(suspended).toBe(false);
    expect(grace).toBe(false);
  });
});

/**
 * The day the design was written for: the lobby open all day, sessions visited
 * one after another, the tab pushed into the background half the time.
 */
describe("a day at the lobby", () => {
  it("parks the session you left and brings back the one you return to", () => {
    let suspended = false;
    let grace = false;
    let graceMs = 0;
    const step = (state: Omit<BatteryState, "suspended">, event: BatteryEvent) => {
      const d = decide({ ...state, suspended }, event);
      if (d.action === "suspend") suspended = true;
      if (d.action === "resume") suspended = false;
      grace = d.grace;
      graceMs = d.graceMs;
      return d.action;
    };
    const at = (over: Partial<BatteryState>): Omit<BatteryState, "suspended"> => {
      const { suspended: _ignored, ...rest } = present(over);
      return rest;
    };

    // Reading this session, window in front. Nothing to count.
    expect(step(at({}), "boot")).toBe("nothing");
    expect(grace).toBe(false);

    // Switch to another session. Half a minute on the clock, not a full one.
    expect(step(at({ offScreen: true }), "off-screen")).toBe("nothing");
    expect(grace).toBe(true);
    expect(graceMs).toBe(OFFSCREEN_SUSPEND_MS);

    // Back within the grace: nothing was ever dropped, so nothing reconnects.
    expect(step(at({}), "on-screen")).toBe("nothing");
    expect(grace).toBe(false);

    // Away for real this time, and the tab goes to the background on the way.
    expect(step(at({ offScreen: true }), "off-screen")).toBe("nothing");
    expect(step(at({ offScreen: true, hidden: true, msAway: 5000 }), "hidden")).toBe("nothing");
    expect(
      step(at({ offScreen: true, hidden: true, msAway: OFFSCREEN_SUSPEND_MS }), "grace-elapsed"),
    ).toBe("suspend");
    expect(grace).toBe(false);

    // Coming back to the tab is not coming back to THIS session.
    expect(step(at({ offScreen: true }), "visible")).toBe("nothing");
    expect(suspended).toBe(true);

    // Opening it is.
    expect(step(at({}), "on-screen")).toBe("resume");
    expect(suspended).toBe(false);
    expect(grace).toBe(false);
  });
});

/**
 * The knobs, as literals.
 *
 * HIDDEN_SUSPEND_MS lived in two places until 2026-09-05 — here and in the page
 * this module was ported from — and five cases in this file read that page to
 * keep them equal: the grace period, the visible-tab guard, the boot-hidden
 * countdown, the absence of a second clock inside `suspendForBattery`, and the
 * two pieces of suspend-time cleanup. There is one implementation now, so the
 * value is pinned rather than compared, and the rules those cases described are
 * asserted above as this module's own behaviour.
 */
describe("the grace period", () => {
  it("is the minute the page was tuned to", () => {
    // term.html:9785, `const HIDDEN_SUSPEND_MS = 60000;`. A port that quietly
    // halved it would double the reconnects on every phone.
    expect(HIDDEN_SUSPEND_MS).toBe(60000);
  });

  /**
   * The off-screen half has no page behind it: it is the design's own number,
   * picked so that flicking between two sessions costs nothing. Halving it
   * again would start charging for a look-and-go.
   */
  it("is half that for a session merely behind another", () => {
    expect(OFFSCREEN_SUSPEND_MS).toBe(30000);
  });
});

describe("the contract handed to the component", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/battery.ts"), "utf8");
  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("`nothing` means", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * A pure module decides; the component performs. So this comment is the only
   * carrier for a side effect term.html performs and `decide` cannot — an
   * omission here is the behaviour being dropped, not a doc nit. `stableTimer`
   * is not covered by "drop any pending reconnect", which is `retryTimer`:
   * they are two timers with two jobs, and term.html:9913-9914 clears both.
   */
  it("names the stability proof the suspend has to cancel", () => {
    expect(owes()).toContain("stableTimer");
  });

  /**
   * term.html:9919 removes `dropped` on the way down. A component built from
   * this list alone hides a pill that is still styled as a fault, and the next
   * thing to show it shows the drop flash for a suspend nobody's phone caused.
   */
  it("names the drop-flash class the suspend has to clear", () => {
    expect(owes()).toContain("dropped");
  });

  /**
   * The list was written when a suspend could only follow a hidden tab. Every
   * item on it has to hold for the trigger added since, and the one most easily
   * missed is the stability proof: an off-screen suspend that leaves
   * `stableTimer` armed resets the retry ladder behind a deliberately-down
   * socket exactly as a hidden-tab one would, and now it can happen fifteen
   * times over in a tab nobody has even switched away from.
   */
  it("says the list covers every away trigger, not just the hidden tab", () => {
    expect(owes()).toContain("off screen");
  });
});
