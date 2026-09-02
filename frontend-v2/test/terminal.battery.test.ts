import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRACE_SLACK_MS,
  HIDDEN_SUSPEND_MS,
  decide,
  type BatteryAction,
  type BatteryEvent,
  type BatteryState,
} from "../src/terminal/battery";

/**
 * The battery saver's rules, as they were paid for in frontend/term.html. Each
 * test below is one rule that page's comments record; a port that drops or
 * inverts one fails here rather than on someone's phone.
 */

const hidden = (msHidden: number | null, suspended = false): BatteryState => ({
  hidden: true,
  msHidden,
  suspended,
});

/**
 * A tab opened into the background: hidden, with no visibilitychange behind it
 * and so nothing to measure a hidden-since from.
 */
const bootedHidden = (suspended = false): BatteryState => hidden(null, suspended);

const visible = (suspended = false): BatteryState => ({
  hidden: false,
  msHidden: 0,
  suspended,
});

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
   */
  it("never suspends a visible tab, even when its countdown fires", () => {
    expect(decide(visible(), "grace-elapsed").action).toBe("nothing");
  });

  it("never suspends a visible tab however long it was hidden before", () => {
    const late: BatteryState = { hidden: false, msHidden: HIDDEN_SUSPEND_MS * 100, suspended: false };
    expect(decide(late, "grace-elapsed").action).toBe("nothing");
  });

  it("leaves no countdown running while the tab is visible", () => {
    for (const e of ["visible", "grace-elapsed", "boot", "asked"] as BatteryEvent[]) {
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
   * Resuming a still-hidden tab (an unreliable pageshow, or the lobby asking
   * while the phone is away) must restart the countdown. Otherwise the socket
   * is back up with no clock on it and no visibilitychange coming, and the
   * battery saver is defeated until the next hide/show cycle.
   */
  it("starts the countdown again when a still-hidden tab resumes", () => {
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 2, true), "bfcache-restore").grace).toBe(true);
    expect(decide(hidden(HIDDEN_SUSPEND_MS * 2, false), "asked").grace).toBe(true);
  });

  it("says nothing about why when it decides nothing", () => {
    expect(decide(visible(), "visible").why).toBe("");
    expect(decide(hidden(0), "hidden").why).toBe("");
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

    expect(step({ hidden: false, msHidden: 0 }, "boot")).toBe("nothing");
    expect(grace).toBe(false);

    // Screen locked.
    expect(step({ hidden: true, msHidden: 0 }, "hidden")).toBe("nothing");
    expect(grace).toBe(true);

    // Glanced at it 20s later, then locked again: no suspend, no flicker.
    expect(step({ hidden: false, msHidden: 0 }, "visible")).toBe("nothing");
    expect(grace).toBe(false);
    expect(step({ hidden: true, msHidden: 0 }, "hidden")).toBe("nothing");

    // A callback queued by the first hide lands 2s into the second: too early.
    expect(step({ hidden: true, msHidden: 2000 }, "grace-elapsed")).toBe("nothing");
    expect(suspended).toBe(false);
    expect(grace).toBe(true);

    // Put down properly this time.
    expect(step({ hidden: true, msHidden: HIDDEN_SUSPEND_MS }, "grace-elapsed")).toBe("suspend");
    expect(grace).toBe(false);

    // Picked up: one resume, whichever of the two wake events lands first.
    expect(step({ hidden: false, msHidden: 0 }, "visible")).toBe("resume");
    expect(step({ hidden: false, msHidden: 0 }, "bfcache-restore")).toBe("nothing");
    expect(suspended).toBe(false);
    expect(grace).toBe(false);
  });
});

describe("parity with the page it came from", () => {
  const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
  const html = (): string => readFileSync(TERM_HTML, "utf8");

  /** term.html's suspendForBattery, body and all, read out of the page. */
  const suspendForBattery = (): string => {
    const src = html();
    const start = src.indexOf("function suspendForBattery()");
    const end = src.indexOf("function resumeFromSuspend(", start);
    expect(start, "suspendForBattery in term.html").toBeGreaterThan(-1);
    expect(end, "resumeFromSuspend after it").toBeGreaterThan(start);
    return src.slice(start, end);
  };

  /**
   * One knob, tuned once, in two places until term.html retires. A port that
   * quietly halved the grace would double the reconnects on every phone.
   */
  it("uses the grace period term.html ships", () => {
    const m = /const HIDDEN_SUSPEND_MS = (\d+);/.exec(html());
    expect(m?.[1], "HIDDEN_SUSPEND_MS in term.html").toBeTruthy();
    expect(Number(m?.[1])).toBe(HIDDEN_SUSPEND_MS);
  });

  /**
   * The visible-tab guard is the one rule whose absence is invisible in
   * testing and expensive in the field. If term.html ever loses it, this fails
   * loudly enough to check whether the reason applies here too.
   */
  it("still finds the visible-tab guard in the page it was extracted from", () => {
    expect(html()).toContain("if (!document.hidden || batterySuspended) return;");
  });

  /**
   * The boot-hidden countdown, in the page's own words. It is the reason the
   * `boot` event exists, and the reason an unstamped run has to be honoured:
   * this line arms a countdown that no visibilitychange will ever stamp.
   */
  it("still arms the countdown at load on a page that boots hidden", () => {
    expect(html()).toContain(
      "if (document.hidden) hiddenSuspendTimer = setTimeout(suspendForBattery, HIDDEN_SUSPEND_MS);",
    );
  });

  /**
   * The page suspends on the strength of the timer alone — its only guard is
   * the visible-tab one. So the staleness check this module adds is a
   * divergence, and a run term.html would have suspended must still suspend
   * here.
   */
  it("weighs no clock of its own between the countdown and the suspend", () => {
    const body = suspendForBattery();
    expect(body).toContain("if (!document.hidden || batterySuspended) return;");
    expect(body).not.toMatch(/Date\.now\(\)|performance\.now\(\)|hiddenSince|msHidden/);
  });

  /**
   * Both of these are suspend-time work with no other home: the ladder's 30s
   * stability proof would otherwise fire behind a socket that is down on
   * purpose and reset the retry ladder to rung 0, and `dropped` is the pill's
   * fault-red drop flash, which a suspend must not leave painted on.
   */
  it("still cancels the stability proof and clears the drop flash as it suspends", () => {
    const body = suspendForBattery();
    expect(body).toContain("clearTimeout(stableTimer)");
    expect(body).toContain("connPill.classList.remove('dropped')");
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
});
