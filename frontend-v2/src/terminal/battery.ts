/**
 * Battery saver — when to drop the terminal socket, and when to bring it back.
 *
 * ttyd pings its WebSocket every 30s (server `-P`) and streams any pane output.
 * Left open behind a locked screen or a switched-away PWA, that keeps the
 * phone's radio warm for nothing, which is why a mobile PWA drains battery
 * "after" a session. So once a tab has been hidden HIDDEN_SUSPEND_MS the socket
 * comes down, and stays down until the tab is shown again.
 *
 * The suspend is lossless: tmux reattach repaints the live screen on reconnect
 * (the same path a deploy's ttyd restart already exercises), and "awaiting
 * input" alerts still arrive over Web Push while suspended, because the push
 * subscription is server-driven and independent of this socket.
 *
 * The grace is generous on purpose — a brief app-switch must not cost a
 * reconnect flicker; a minute hidden ~always means the phone was put down.
 *
 * Everything here is pure: state and events in, a decision out. The component
 * owns the timer, the socket and the reporting. Extracted from
 * frontend/term.html (suspendForBattery / resumeFromSuspend and the handlers
 * under them).
 *
 * WHAT THE COMPONENT STILL OWES, per action. This list is the only place these
 * survive the extraction — the module decides, the component acts — so a side
 * effect missing here is one nobody performs:
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
 *             (the phone did nothing wrong), discard held input (a suspend
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

/** The single knob. Tune here. */
export const HIDDEN_SUSPEND_MS = 60000;

/**
 * How early a grace callback may fire and still count. Timers are allowed to
 * run a shade early and clocks are coarse; the deadline check exists to reject
 * a STALE callback left over from an EARLIER hidden run, which is off by tens
 * of seconds rather than by one.
 */
export const GRACE_SLACK_MS = 1000;

export type BatteryEvent =
  /**
   * The page was just evaluated. A tab that boots hidden must arm the same
   * countdown: visibilitychange won't fire until it is first shown. Nothing
   * observed that tab becoming hidden either, so the component has no
   * hidden-since to report for the run this arms — see `msHidden`.
   */
  | "boot"
  /** visibilitychange, now hidden. */
  | "hidden"
  /** visibilitychange, now shown. */
  | "visible"
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
   * Milliseconds the tab has been continuously hidden; 0 while visible.
   *
   * `null` when nothing observed the transition, so there is no stamp to
   * measure from. That is a real path, not a defensive one: a tab opened into
   * the background BOOTS hidden, no visibilitychange fires until it is first
   * shown, and term.html:9966 arms the countdown there regardless. Report the
   * elapsed time whenever you hold a stamp — `null` turns off the stale
   * callback check in `act`, so it says "this run was never stamped", not
   * "I couldn't be bothered".
   */
  msHidden: number | null;
  /** The socket is intentionally down, waiting for the tab to be shown. */
  suspended: boolean;
}

export type BatteryAction = "suspend" | "resume" | "nothing";

export interface BatteryDecision {
  action: BatteryAction;
  /**
   * Whether the grace countdown should be running once this decision is
   * applied. The invariant is small enough to state: it runs exactly while a
   * hidden tab still holds a socket. The component arms it only when it is not
   * already running — re-arming on every event would push the deadline out
   * forever on a tab that keeps receiving them.
   */
  grace: boolean;
  /** The reason, for the log line and the report. Empty for `nothing`. */
  why: string;
}

/** The whole policy. Nothing here reads a clock, a socket or the DOM. */
export function decide(state: BatteryState, event: BatteryEvent): BatteryDecision {
  const action = act(state, event);
  const suspended =
    action === "suspend" ? true : action === "resume" ? false : state.suspended;
  return {
    action,
    // A suspended socket has nothing left to count down to, and a visible tab
    // is not on its way anywhere.
    grace: state.hidden && !suspended,
    why: action === "nothing" ? "" : why(action, event),
  };
}

function act(state: BatteryState, event: BatteryEvent): BatteryAction {
  switch (event) {
    case "grace-elapsed":
      // NEVER SUSPEND A VISIBLE TAB. The callback can already be queued when
      // the tab is shown, so clearing the timer misses it — and suspending then
      // closes a healthy socket with nothing left to reopen it, because a
      // visible tab fires no further visibilitychange.
      if (!state.hidden) return "nothing";
      if (state.suspended) return "nothing"; // already down
      // A callback left over from an earlier hidden run is off by a whole grace
      // period, and honouring it would cost the reconnect flicker the grace
      // exists to avoid. This check is ours — term.html suspends on the timer
      // alone (9910-9914) — so it must never be able to veto a run that page
      // WOULD have suspended. An unstamped run is exactly that: the
      // background-tab boot of term.html:9966, where no visibilitychange ever
      // fired to stamp from. Reject it and every grace-elapsed answers
      // `nothing`, the component re-arms, and the socket stays up for the life
      // of the tab — which is the radio-warm drain this module exists to stop.
      if (state.msHidden !== null && state.msHidden + GRACE_SLACK_MS < HIDDEN_SUSPEND_MS) {
        return "nothing";
      }
      return "suspend";

    case "visible":
    case "bfcache-restore":
    case "asked":
      // Only a deliberate suspend is ours to undo. A tab that was never
      // suspended has a socket that is either healthy or already climbing the
      // ladder, and reconnecting it here would destroy the first and duplicate
      // the second. Answering `nothing` the second time is also what makes a
      // doubled restore (visibilitychange AND pageshow, one wake) resume once.
      return state.suspended ? "resume" : "nothing";

    case "hidden":
    case "boot":
      // Hiding costs the socket nothing yet; only the countdown starts.
      return "nothing";

    default: {
      const unhandled: never = event;
      void unhandled;
      return "nothing";
    }
  }
}

function why(action: BatteryAction, event: BatteryEvent): string {
  if (action === "suspend") return `tab hidden ${HIDDEN_SUSPEND_MS}ms`;
  switch (event) {
    case "visible":
      return "tab visible";
    case "bfcache-restore":
      return "bfcache restore";
    case "asked":
      return "asked by the lobby";
    default:
      return "";
  }
}
