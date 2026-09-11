/**
 * Battery saver — when to drop the terminal socket, and when to bring it back.
 *
 * ttyd pings its WebSocket every 30s (server `-P`) and streams any pane output.
 * Left open behind a locked screen or a switched-away PWA, that keeps the
 * phone's radio warm for nothing, which is why a mobile PWA drains battery
 * "after" a session. So once nobody has been reading a terminal for its grace
 * the socket comes down, and stays down until someone is reading it again.
 *
 * "NOBODY IS READING THIS" IS THREE QUESTIONS, not one. It was one when this
 * came out of frontend/term.html, because that page was a single terminal and
 * `document.hidden` therefore answered the whole of it. The lobby is not: it
 * mounts a terminal for every session visited and CSS-hides all but one
 * (store/keepalive.ts), and it runs on a desktop where a window can sit visible
 * behind an editor for hours. Both of those read `document.hidden === false`,
 * so on that input alone fourteen of fifteen terminals never park and the whole
 * window never parks while another app is in front. The plan this widening
 * comes from is docs/plans/2026-09-11-client-cpu-parking-design.md; away is now
 * the OR of two inputs, and coming back is the AND:
 *
 *   tab hidden          document.hidden     60s   (the page's own, unchanged)
 *   session off screen  the on-screen prop  30s
 *
 * A THIRD input, `document.hasFocus()`, was built and then removed on Viktor's
 * call the same day. It parked exactly one terminal that off-screen does not
 * already cover, the one being read, and `term.onBell` fires only from socket
 * bytes — so a minute after alt-tabbing, a ring at the session in front of you
 * raised no '● <name>' title prefix. A lobby left visible on a second monitor
 * is open precisely to be noticed, so the trade went the other way. Off screen
 * still parks the other fourteen at 30s, and a hidden tab parks everything.
 *
 * The suspend is lossless: tmux reattach repaints the live screen on reconnect
 * (the same path a deploy's ttyd restart already exercises), and "awaiting
 * input" alerts still arrive over Web Push while suspended, because the push
 * subscription is server-driven and independent of this socket.
 *
 * The grace is generous on purpose — a brief app-switch must not cost a
 * reconnect flicker; a minute hidden ~always means the phone was put down. The
 * off-screen half-minute is shorter because its transition is cheaper to make
 * by accident: flicking between two sessions, or running a pointer down the
 * sidebar once the hover preload lands, should cost nothing either way.
 *
 * Everything here is pure: state and events in, a decision out. The component
 * owns the timer, the socket and the reporting. Extracted from
 * frontend/term.html (suspendForBattery / resumeFromSuspend and the handlers
 * under them).
 *
 * WHAT THE COMPONENT STILL OWES, per action. This list is the only place these
 * survive the extraction — the module decides, the component acts — so a side
 * effect missing here is one nobody performs. It was written when a hidden tab
 * was the only way to reach `suspend`; every line of it holds unchanged for a
 * window that lost focus and for a session that went off screen, and those two
 * fire far more often than a hidden tab ever did, so an owed effect that was
 * merely rare before is now routine:
 *   suspend — drop any pending reconnect (`retryTimer`), cancel the pending
 *             30s stability proof (`stableTimer`, term.html:9914). That proof
 *             is what resets the retry ladder to rung 0; left armed it fires
 *             behind a deliberately-down socket, and the next real drop starts
 *             hammering at the 1s rung instead of holding the rung it had
 *             climbed to. The ladder in reconnect.ts emits `clear-stable` on
 *             its own `suspend` event, so routing this decision there settles
 *             it. Then hide the pill AND clear its `dropped` class
 *             (term.html:9919) — that is the fault-red drop flash, and a
 *             suspend that only hides the pill leaves it painted as a fault for
 *             whatever shows it next. Report `suspended` rather than a fault
 *             (the phone did nothing wrong, and neither did a person who simply
 *             looked at another session), discard held input (a suspend
 *             outlives the replay window by design), and tear down through the
 *             shared abandon path so a /token fetch in flight or a socket still
 *             in CONNECTING is abandoned too, not just an already-open socket.
 *   resume  — connect() through the normal ladder. It detaches any prior
 *             socket, so a doubled restore cannot leave two live sockets.
 *   while suspended — onclose must not reconnect, the liveness probe stays off
 *             (a hidden tab's timers are throttled hard enough to manufacture
 *             false strikes), held input is refused, and a token fetch that
 *             lands late must not open a socket.
 *
 * `nothing` means "battery saver has nothing to do", NOT "do nothing at all":
 * on `visible` the component still brings a pending reconnect forward, and on
 * `asked` it still connects. Both belong to the reconnect ladder, not here.
 */

/**
 * The grace for the two WINDOW-WIDE conditions, and the page's original knob.
 * Tune here.
 */
export const HIDDEN_SUSPEND_MS = 60000;

/**
 * The grace for a session that is merely behind another one, in a window that
 * is visible and focused.
 *
 * Half the window-wide grace, and the one number in this file with no page
 * behind it. Two sessions flicked between take well under 30s to come back to,
 * so the common gesture costs nothing; a session genuinely left behind is
 * parked twice as fast as the tab would park it, which is what makes keeping
 * fifteen mounts affordable.
 */
export const OFFSCREEN_SUSPEND_MS = 30000;

/**
 * How early a grace callback may fire and still count. Timers are allowed to
 * run a shade early and clocks are coarse; the deadline check exists to reject
 * a STALE callback left over from an EARLIER away run, which is off by tens
 * of seconds rather than by one.
 */
export const GRACE_SLACK_MS = 1000;

export type BatteryEvent =
  /**
   * The page was just evaluated. A terminal that boots away must arm the same
   * countdown: no transition will fire until the condition it booted into
   * CHANGES. A tab opened into the background is the page's own case; a session
   * pre-mounted behind the one being read is the lobby's second of it. Nothing
   * observed either of those becoming away either, so the component has no
   * away-since to report for the run this arms — see `msAway`.
   */
  | "boot"
  /** visibilitychange, now hidden. */
  | "hidden"
  /** visibilitychange, now shown. */
  | "visible"
  /** This session's slot went behind another session's. */
  | "off-screen"
  /** ...and came back to the front. */
  | "on-screen"
  /** The countdown the component armed has fired. */
  | "grace-elapsed"
  /**
   * `pageshow` with `persisted` true, and only that. On iOS standalone the page
   * returns frozen rather than reloaded and its visibilitychange can be
   * unreliable, so this is the belt to visibilitychange's suspenders. A pageshow
   * that is not persisted is a fresh load — that is `boot`.
   */
  | "bfcache-restore"
  /**
   * The lobby's Reconnect button. Routed through here so a suspend resumes
   * instead of opening a second socket alongside the suspended one.
   */
  | "asked";

/** The world as of the event. */
export interface BatteryState {
  /** `document.hidden`. */
  hidden: boolean;
  /**
   * Nobody can see THIS session's slot, whichever of its two views is showing.
   * The negation of the on-screen prop the component is passed; deliberately
   * NOT "the terminal view is the one showing", because a session read in text
   * view still sends to this pty from its composer and still has to switch
   * views instantly.
   */
  offScreen: boolean;
  /**
   * Milliseconds the terminal has been continuously away; 0 while someone is
   * reading it. One stamp for the whole away RUN, not one per condition: a run
   * begins when the first condition takes hold and ends when the last one
   * clears.
   *
   * `null` when nothing observed the transition, so there is no stamp to
   * measure from. That is a real path, not a defensive one: a tab opened into
   * the background BOOTS hidden, no visibilitychange fires until it is first
   * shown, and term.html:9966 arms the countdown there regardless. The lobby
   * adds one more boot with the same hole, a session mounted behind the one
   * being read. Report the elapsed time whenever
   * you hold a stamp — `null` turns off the stale callback check in `act`, so
   * it says "this run was never stamped", not "I couldn't be bothered".
   */
  msAway: number | null;
  /** The socket is intentionally down, waiting for someone to read this. */
  suspended: boolean;
}

export type BatteryAction = "suspend" | "resume" | "nothing";

export interface BatteryDecision {
  action: BatteryAction;
  /**
   * Whether the grace countdown should be running once this decision is
   * applied. The invariant is small enough to state: it runs exactly while an
   * away terminal still holds a socket. The component arms it only when it is
   * not already running — re-arming on every event would push the deadline out
   * forever on a terminal that keeps receiving them, and with three inputs
   * feeding this instead of one there are three times as many to receive.
   */
  grace: boolean;
  /**
   * How long that countdown is, in milliseconds. The LENGTH to arm, not what
   * remains of a run already under way, because the component arms a fresh
   * countdown only at the start of an away run or straight after a resume, and
   * in both cases the clock on it is new. 0 when `grace` is false.
   */
  graceMs: number;
  /** The reason, for the log line and the report. Empty for `nothing`. */
  why: string;
}

/**
 * Is nobody reading this terminal? The OR of the two inputs, and the whole of
 * what "away" means.
 *
 * Exported because the component needs the same answer to know when to drop the
 * away stamp, and a second copy of this expression there would be a second
 * place for the question to drift.
 */
export function isAway(state: BatteryState): boolean {
  return state.hidden || state.offScreen;
}

/**
 * The grace that applies right now: the SHORTEST among the conditions holding.
 *
 * Each row of the design's table earns a suspend on its own, so a session that
 * has been off screen for 30s has earned it whether or not the tab is also
 * hidden. Taking the longer grace when a second condition joins would park a
 * MORE away terminal LATER.
 *
 * Off screen is the only 30s row, which is why this reads as one test rather
 * than a fold over the table. A third input with its own grace would want the
 * fold; two do not.
 *
 * With nobody away there is nothing to count, and the window-wide minute is the
 * honest answer to a question that is not being asked.
 */
export function graceFor(state: BatteryState): number {
  return state.offScreen ? OFFSCREEN_SUSPEND_MS : HIDDEN_SUSPEND_MS;
}

/** The whole policy. Nothing here reads a clock, a socket or the DOM. */
export function decide(state: BatteryState, event: BatteryEvent): BatteryDecision {
  const action = act(state, event);
  const suspended =
    action === "suspend" ? true : action === "resume" ? false : state.suspended;
  // A suspended socket has nothing left to count down to, and a terminal
  // someone is reading is not on its way anywhere.
  const grace = isAway(state) && !suspended;
  return {
    action,
    grace,
    graceMs: grace ? graceFor(state) : 0,
    why: action === "nothing" ? "" : why(action, event, state),
  };
}

function act(state: BatteryState, event: BatteryEvent): BatteryAction {
  switch (event) {
    case "grace-elapsed":
      // NEVER SUSPEND A TERMINAL SOMEONE IS READING. The callback can already
      // be queued when the last away condition clears, so clearing the timer
      // misses it — and suspending then closes a healthy socket with nothing
      // left to reopen it, because a terminal already on screen in a shown tab
      // fires neither of the two events that would.
      if (!isAway(state)) return "nothing";
      if (state.suspended) return "nothing"; // already down
      // A callback left over from an earlier away run is off by a whole grace
      // period, and honouring it would cost the reconnect flicker the grace
      // exists to avoid. This check is ours — term.html suspends on the timer
      // alone (9910-9914) — so it must never be able to veto a run that page
      // WOULD have suspended. An unstamped run is exactly that: the
      // background-tab boot of term.html:9966, where no visibilitychange ever
      // fired to stamp from. Reject it and every grace-elapsed answers
      // `nothing`, the component re-arms, and the socket stays up for the life
      // of the tab — which is the radio-warm drain this module exists to stop.
      //
      // Measured against the grace that applies NOW rather than the one armed,
      // which can differ when a second condition joined an away run already
      // under way. The direction that costs is rejecting a real callback, and
      // that only ever delays a suspend by one more grace; accepting one early
      // needs the current grace to be the short one, and an off-screen session
      // 29s in has earned the suspend on its own row anyway.
      if (state.msAway !== null && state.msAway + GRACE_SLACK_MS < graceFor(state)) {
        return "nothing";
      }
      return "suspend";

    case "visible":
    case "on-screen":
      // ONE CONDITION CLEARED IS NOT EVERYONE BACK. Away is the OR of two, so
      // coming back is the AND: a tab shown onto a session that is still behind
      // another session leaves a live socket on a terminal nobody can see,
      // which is the cost this module was widened to remove.
      //
      // Only a deliberate suspend is ours to undo. A terminal that was never
      // suspended has a socket that is either healthy or already climbing the
      // ladder, and reconnecting it here would destroy the first and duplicate
      // the second. Answering `nothing` the second time is also what makes a
      // doubled restore (visibilitychange AND pageshow, one wake) resume once.
      return state.suspended && !isAway(state) ? "resume" : "nothing";

    case "bfcache-restore":
    case "asked":
      // These two answer for a PERSON rather than for a condition, which is why
      // they resume where the three above would not. A tap on Reconnect means
      // "give me this socket now", and an iOS bfcache restore has no reliable
      // condition to read at all, since visibilitychange is the very thing it
      // is the belt to. Both leave `grace` true if the terminal is still away, so the
      // countdown starts over rather than the socket coming back unclocked.
      return state.suspended ? "resume" : "nothing";

    case "hidden":
    case "off-screen":
    case "boot":
      // Going away costs the socket nothing yet; only the countdown starts.
      return "nothing";

    default: {
      const unhandled: never = event;
      void unhandled;
      return "nothing";
    }
  }
}

function why(action: BatteryAction, event: BatteryEvent, state: BatteryState): string {
  if (action === "suspend") {
    // Every condition holding, not just the one whose event got here: a
    // grace-elapsed carries no condition of its own, and a log line saying
    // which of the two were true is the difference between reading a park as
    // expected and reading it as a bug.
    const reasons: string[] = [];
    if (state.hidden) reasons.push("tab hidden");
    if (state.offScreen) reasons.push("off screen");
    return `${reasons.join(" + ")} ${graceFor(state)}ms`;
  }
  switch (event) {
    case "visible":
      return "tab visible";
    case "on-screen":
      return "session on screen";
    case "bfcache-restore":
      return "bfcache restore";
    case "asked":
      return "asked by the lobby";
    default:
      return "";
  }
}
