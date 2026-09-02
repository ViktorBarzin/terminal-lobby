/**
 * The reconnect ladder — the rules frontend/term.html learned the hard way,
 * lifted out of the page so they can be exercised without a socket, a clock or
 * a browser (term.html: `nextRetryDelay`, `scheduleReconnect`, `connect`,
 * `abandonAttempt`, `reconnectAfterDrop`).
 *
 * PURE. State and events in, decisions out. Nothing here owns a timer, a
 * WebSocket, a fetch or a pixel — the component arms the timers this reducer
 * asks for and feeds their results back in. That is what makes the corner
 * cases reachable from a test: a stalled handshake, a phone that suspends
 * mid-attempt, a session killed from another client.
 *
 * The rules, and the failures that produced them:
 *
 *  - BACK OFF FAST — 1s, 2s, 4s, 8s, 16s, capped. tmux reattach makes an
 *    aggressive retry lossless, so trying early costs a request, not a screen.
 *  - RESET ONLY ON PROOF. The attempt counter clears 30s after a connection
 *    opens, never at the moment it opens. A flapping link keeps escalating
 *    instead of hammering ttyd at 1s forever.
 *  - JITTER EVERY RUNG. An outage ends for every client at the same instant,
 *    so an unjittered ladder marches every open terminal, every other tab and
 *    every other phone into the same rungs and stampedes ttyd the moment
 *    service returns. Full jitter in [rung/2, rung] spreads the herd across
 *    the rung — the same rule the SSE client uses (src/sse/client.ts).
 *  - OFFLINE IS A PARK, NOT A RUNG. `navigator.onLine === false` is the
 *    browser saying there is no path; burning a rung a second against it
 *    costs attempts and pill flicker for nothing. Park on a long safety delay
 *    and let the `online` event drive the real retry — SAFETY, not the
 *    ladder, because onLine lies in both directions: behind a captive portal
 *    it reports true, and some platforms never fire `online` at all, so a
 *    parked tab must still be able to wake itself.
 *  - ONE ATTEMPT AT A TIME, and every attempt carries a GENERATION. A /token
 *    response, a session-exists answer or a liveness verdict that lands after
 *    we walked away must not install a socket or arm a competing retry. Each
 *    carries the generation it started under and is dropped once a newer
 *    attempt owns the page.
 *  - A WAKE RESTARTS A STALLED ATTEMPT, not just a pending timer. The attempt
 *    started over a dead path is the one that can only ever time out, and
 *    while it hangs there is no timer at all — so "only while a retry is
 *    pending" made `back online` and `tab visible` no-ops in precisely the
 *    case they exist for. A healthy open socket is left strictly alone.
 *  - NO RESURRECT. After the first successful connect, a close may mean the
 *    session was killed (by this client or another), and reconnecting would
 *    recreate it through `tmux new-session -A`. So a later drop asks whether
 *    the session still exists before it schedules, and a gone session stands
 *    the ladder down for good. The FIRST connection is the create/attach and
 *    is always retried — there is no session to ask about yet.
 *  - A TAP OUTRANKS THE LADDER. Every automatic path here is conservative:
 *    a healthy socket is left alone, a battery suspend is the tab's alone to
 *    lift, and an ended session is never revived. The Reconnect button is
 *    none of those — `reconnect-tapped` starts an attempt from ANY phase,
 *    `ended` included, where it really does recreate the session through
 *    `tmux new-session -A`. Someone pressed it on purpose (term.html's
 *    `tl-conn-retry` branch: "Explicitly tapped, never automatic"), and the
 *    rule it walks through only ever existed to stop the page doing this by
 *    itself.
 *
 * INVARIANT the component may rely on: any reduction that leaves the `waiting`
 * phase emits `cancel-scheduled` first, so the caller never has to work out
 * whether its pending timer is still wanted.
 */

/** The ladder itself. Index = attempts already made since the last stable connection. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

/** The safety park used while the browser reports no network path. */
export const OFFLINE_RETRY_MS = 20000;

/** How long a connection must stay up before it counts as proof and clears the ladder. */
export const STABLE_AFTER_MS = 30000;

export interface DelayOptions {
  /** `navigator.onLine`. False parks on the safety delay instead of a rung. */
  online?: boolean;
  /** Injected for tests; the jitter is the only randomness in this module. */
  random?: () => number;
}

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * `attempts` is the count of connects already STARTED since the last stable
 * connection, which is why the bottom rung is not where a fresh page begins:
 * the boot connect makes it 1, so its first failure waits on the 2s rung. The
 * 1s rung belongs to a connection that proved stable and then dropped, which
 * is the case worth retrying hardest.
 */
export function nextRetryDelay(attempts: number, opts: DelayOptions = {}): number {
  const { online = true, random = Math.random } = opts;
  // Not jittered, and deliberately: this is a parking brake rather than a
  // rung. What normally ends it is the `online` event, not this timer.
  if (!online) return OFFLINE_RETRY_MS;
  const rung = rungFor(attempts);
  return rung / 2 + random() * (rung / 2);
}

function rungFor(attempts: number): number {
  // Clamped rather than trusted. A negative or NaN counter would index off the
  // end of the ladder, and `undefined / 2` is NaN — a delay setTimeout treats
  // as zero, i.e. the ladder inverted into a hot loop.
  const safe = Math.trunc(attempts) || 0;
  const index = Math.min(Math.max(safe, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? OFFLINE_RETRY_MS;
}

export type LadderPhase =
  /** Nothing has been tried yet. */
  | "idle"
  /** An attempt is in flight: the token fetch, or a socket still in CONNECTING. */
  | "connecting"
  /** A socket is open. The ladder is NOT cleared until it proves stable. */
  | "open"
  /** A retry is armed and its delay is running down. */
  | "waiting"
  /** A drop happened and we are asking whether the session still exists. */
  | "checking"
  /** The battery saver holds the socket down until the tab is shown again. */
  | "suspended"
  /** The session is gone. No timer, no attempt, and nothing here revives it. */
  | "ended";

export interface LadderState {
  readonly phase: LadderPhase;
  /** connects STARTED since the last stable connection. Also the pill's number. */
  readonly attempts: number;
  /** Bumped whenever an attempt is superseded or abandoned; stamps async work. */
  readonly generation: number;
  /** False until the first socket opens — the create/attach that is always retried. */
  readonly hasConnectedOnce: boolean;
  /** `navigator.onLine`, mirrored here so the delay rule stays pure. */
  readonly online: boolean;
}

export function initialLadder(opts: { online?: boolean } = {}): LadderState {
  return {
    phase: "idle",
    attempts: 0,
    generation: 0,
    hasConnectedOnce: false,
    online: opts.online ?? true,
  };
}

export type LadderEvent =
  /** The page booted, or a scheduled rung came due. */
  | { type: "start" }
  /** The socket opened. */
  | { type: "opened" }
  /** The 30s proof timer fired, carrying the generation it was armed under. */
  | { type: "proved-stable"; gen: number }
  /** The socket closed on its own. */
  | { type: "closed" }
  /**
   * The liveness watchdog gave up on a socket that still looked OPEN, carrying
   * the generation the probe started under — the socket it was judging may
   * already have been replaced by another that is also open.
   */
  | { type: "presumed-dead"; gen: number }
  /** An attempt died before it opened: the token hop, or the handshake deadline. */
  | { type: "attempt-failed"; gen: number; at: "token" | "handshake" }
  /** The answer to `check-session`. */
  | { type: "session-checked"; gen: number; exists: boolean }
  /** `navigator.onLine` changed. */
  | { type: "network"; online: boolean }
  /** Tab shown or network returned: bring a pending or stalled attempt forward. */
  | { type: "retry-now"; why?: string }
  /**
   * The Reconnect button. Explicitly tapped, never automatic — the one event
   * that starts an attempt from any phase at all, `ended` included.
   */
  | { type: "reconnect-tapped"; why?: string }
  /** The tab has been hidden long enough that the socket is not worth the radio. */
  | { type: "suspend" }
  /** Tab shown again, or a bfcache restore. Only meaningful while suspended. */
  | { type: "resume"; why?: string };

export type LadderAction =
  /** Start an attempt now. Implies tearing down whatever the last one owned. */
  | { type: "connect"; attempt: number; gen: number }
  /** Arm a retry this many ms out. `attempt` is the number that attempt will carry. */
  | { type: "schedule"; delayMs: number; attempt: number }
  /** Drop the armed retry. Always precedes whatever replaces it. */
  | { type: "cancel-scheduled" }
  /** Detach and close the current attempt without letting its callbacks act. */
  | { type: "abandon" }
  /** Start the 30s proof. `gen` comes back on `proved-stable`. */
  | { type: "arm-stable"; delayMs: number; gen: number }
  | { type: "clear-stable" }
  /** Ask whether the session survived. The answer arrives as `session-checked`. */
  | { type: "check-session"; gen: number; attempt: number }
  /** Stop. Nothing is pending, and nothing here will start it again. */
  | { type: "stand-down"; reason: "session-ended" | "suspended" };

export interface Reduction {
  readonly state: LadderState;
  readonly actions: readonly LadderAction[];
}

export interface ReduceOptions {
  random?: () => number;
}

const NOTHING = (state: LadderState): Reduction => ({ state, actions: [] });

export function reduce(
  state: LadderState,
  event: LadderEvent,
  opts: ReduceOptions = {},
): Reduction {
  const random = opts.random ?? Math.random;

  switch (event.type) {
    case "start":
      // A suspended ladder is down on purpose; the tab coming back is what
      // reconnects it. A stood-down one has no session left to attach to.
      if (state.phase === "suspended" || state.phase === "ended") return NOTHING(state);
      return startAttempt(state);

    case "opened": {
      if (state.phase === "suspended" || state.phase === "ended") return NOTHING(state);
      // The counter deliberately survives an open: the connection has not
      // earned anything yet. `hasConnectedOnce` as it stood BEFORE this event
      // is what tells the component whether this was a reconnect (and so
      // whether to re-check the build) — read it off the state you passed in.
      const next: LadderState = { ...state, phase: "open", hasConnectedOnce: true };
      const actions = leavingWaiting(state);
      actions.push({ type: "clear-stable" });
      actions.push({ type: "arm-stable", delayMs: STABLE_AFTER_MS, gen: state.generation });
      return { state: next, actions };
    }

    case "proved-stable":
      // Only a connection that is STILL the current one may clear the ladder.
      // Without the generation check, a proof armed by an attempt we have
      // since walked away from would reset the counter mid-climb and send the
      // next drop back to hammering at 1s.
      if (state.phase !== "open" || event.gen !== state.generation) return NOTHING(state);
      return { state: { ...state, attempts: 0 }, actions: [] };

    case "closed":
      // Suspended: the battery saver closed us on purpose, so stay down.
      // Waiting: a rung is already armed, and one pending attempt is the rule.
      if (state.phase === "suspended" || state.phase === "ended" || state.phase === "waiting") {
        return NOTHING(state);
      }
      return afterDrop(state, random, [{ type: "clear-stable" }]);

    case "presumed-dead": {
      // The watchdog's socket still says OPEN, so nothing else will ever close
      // it. Abandoning first bumps the generation, which is what stops the
      // dead socket's own callbacks from landing later and arming a second
      // ladder; from there it is the same kill-guard as a real close.
      //
      // The verdict is about ONE socket, and the phase cannot tell that socket
      // from a newer one that replaced it and is also open (term.html:10102,
      // between the probe's Promise.all and livenessFailed: `if (gen !==
      // connGen) return; // the socket was replaced while we waited`). A probe
      // started before a drop-and-reconnect outlives it easily: its fetch and
      // its drain timer both settle long after the ladder has climbed a rung
      // and opened something healthy. Without the generation, that verdict
      // tears the healthy socket down.
      if (state.phase !== "open" || event.gen !== state.generation) return NOTHING(state);
      const abandoned: LadderState = { ...state, generation: state.generation + 1 };
      return afterDrop(abandoned, random, [{ type: "abandon" }, { type: "clear-stable" }]);
    }

    case "attempt-failed": {
      // Aborted by us — a wake, a suspend or a fresh connect got here first —
      // so the attempt that superseded this one owns the ladder. Acting on
      // both would arm two rungs against a single drop.
      if (event.gen !== state.generation || state.phase !== "connecting") return NOTHING(state);
      if (event.at === "token") return schedule(state, random);
      // A handshake deadline fires against a socket still in CONNECTING, and
      // nothing else will ever close it: it has to be torn down here, before a
      // new rung is armed.
      const abandoned: LadderState = { ...state, generation: state.generation + 1 };
      const armed = schedule(abandoned, random);
      return { state: armed.state, actions: [{ type: "abandon" }, ...armed.actions] };
    }

    case "session-checked":
      // A resume or an instant retry can start a fresh attempt while this
      // check is in flight; that attempt owns the page, and this answer is
      // about a connection nobody is waiting on any more.
      if (event.gen !== state.generation || state.phase !== "checking") return NOTHING(state);
      if (event.exists) return schedule(state, random);
      return {
        state: { ...state, phase: "ended" },
        actions: [{ type: "stand-down", reason: "session-ended" }],
      };

    case "network": {
      const next: LadderState = { ...state, online: event.online };
      if (event.online) return retryNow(next);
      // A rung armed while the browser still believed it was online is
      // re-parked on the long safety delay. Otherwise going offline at the
      // bottom of the ladder keeps firing a doomed attempt every second until
      // the ladder climbs out of it.
      if (next.phase === "waiting") return schedule(next, random, { replace: true });
      // An attempt already in flight is left to run out its own deadlines —
      // onLine can be wrong, and the component only has to recolour.
      return { state: next, actions: [] };
    }

    case "retry-now":
      return retryNow(state);

    case "reconnect-tapped": {
      // term.html:9333 — `if (!resumeFromSuspend('asked by the lobby')) {
      // clearTimeout(retryTimer); retryTimer = null; connect(); }`. That is an
      // unconditional connect() from every phase, and the phases it reaches
      // that `retry-now` refuses are the point of the button: from `open` it
      // tears the socket down and opens a fresh one, from `checking` the
      // generation bump drops the answer the old connection was waiting for,
      // and from `ended` it resurrects the session through
      // `tmux new-session -A`. The no-resurrect rule exists to stop the page
      // doing that unasked, not to stop the person who asked.
      //
      // From `suspended` this IS `resumeFromSuspend`: the same next rung, and
      // the phase leaving `suspended` is what lifts the battery hold — which
      // is why one event covers both halves of that handler.
      const started = startAttempt(state);
      if (state.phase !== "open") return started;
      // A DELIBERATE divergence from term.html, and the reason is not the one
      // it is tempting to give: term.html's stable timer is NOT made inert by
      // the generation bump. It is armed as a bare
      // `setTimeout(() => { connAttempts = 0 }, 30000)` (term.html:10300-10301),
      // carries no generation and no guard, and abandonAttempt() never clears
      // it — so on the page a Reconnect tap from a healthy socket really does
      // zero the ladder ~30s later.
      //
      // Clearing it here keeps the ladder climbing, which agrees with the
      // generation guard on `proved-stable` in this module and with term.html's
      // own "takes one rung off the ladder" comment in the tl-conn-retry branch.
      // Recorded rather than silently matched, because the page's behaviour on
      // this path looks like an oversight and a reader deserves both readings.
      return { state: started.state, actions: [{ type: "clear-stable" }, ...started.actions] };
    }

    case "suspend":
      // Idempotent: the hidden-grace timer can fire once more after the tab is
      // already shown, or after a suspend already happened.
      if (state.phase === "suspended") return NOTHING(state);
      // A stood-down ladder has no socket to save, and — the reason this
      // branch exists — a later resume would connect() to a session that was
      // deliberately killed, recreating it through `tmux new-session -A`.
      if (state.phase === "ended") return NOTHING(state);
      return {
        state: { ...state, phase: "suspended" },
        actions: [
          ...leavingWaiting(state),
          { type: "clear-stable" },
          { type: "abandon" },
          { type: "stand-down", reason: "suspended" },
        ],
      };

    case "resume":
      // A bfcache restore on a page that was never suspended is a no-op, which
      // is what lets the visibility handler try `resume` first and fall through
      // to `retry-now` (see `wake`).
      if (state.phase !== "suspended") return NOTHING(state);
      // The ladder is REUSED, not restarted: a resume takes the next rung.
      return startAttempt(state);
  }
}

/**
 * Tab shown: resume a suspended socket, else bring a pending or stalled
 * attempt forward. Both halves in one call because the page has to try them in
 * this order — a suspended ladder has neither a timer nor an attempt, so
 * `retry-now` alone would leave a hidden-then-shown tab dark forever.
 *
 * `back online` is deliberately NOT this: it is `retry-now` alone, so the
 * network returning cannot wake a socket the battery saver put down.
 */
export function wake(state: LadderState, why?: string, opts: ReduceOptions = {}): Reduction {
  const resumed = reduce(state, { type: "resume", why }, opts);
  if (resumed.actions.length > 0) return resumed;
  return reduce(state, { type: "retry-now", why }, opts);
}

function retryNow(state: LadderState): Reduction {
  // A pending rung is brought forward — a hidden tab throttles timers and a
  // dead network fails fast, so when either recovers, waiting out a 16s rung
  // is pure delay.
  // An attempt in flight is abandoned and restarted, which is the half that
  // used to be missing: over a dead path the attempt can only time out, and
  // while it hangs there is no timer, so the wake did nothing at exactly the
  // moment it was wanted. `connect` tears the stale one down, so this still
  // cannot leave two live sockets.
  if (state.phase === "waiting" || state.phase === "connecting") return startAttempt(state);
  // Everything else is left strictly alone: a healthy socket, a battery
  // suspend only the tab may lift, a stood-down session that must never be
  // resurrected, and a session check that is already bounded by its own
  // deadline and whose answer owns the ladder.
  return NOTHING(state);
}

/** What to do once a connection is gone — shared by a real close and the watchdog. */
function afterDrop(
  state: LadderState,
  random: () => number,
  prefix: LadderAction[],
): Reduction {
  // The first connection is the create/attach: always retry it, and do not ask
  // whether the session exists — it does not yet, so the question can only be
  // answered "no", which would strand a page that never managed to connect.
  if (!state.hasConnectedOnce) {
    const armed = schedule(state, random);
    return { state: armed.state, actions: [...prefix, ...armed.actions] };
  }
  return {
    state: { ...state, phase: "checking" },
    actions: [
      ...prefix,
      // The pill keeps showing the attempt this will become: the existence
      // check can itself take a moment on a struggling network.
      { type: "check-session", gen: state.generation, attempt: state.attempts + 1 },
    ],
  };
}

function schedule(
  state: LadderState,
  random: () => number,
  opts: { replace?: boolean } = {},
): Reduction {
  // A suspended ladder arms nothing, and a stood-down one has nothing to arm.
  if (state.phase === "suspended" || state.phase === "ended") return NOTHING(state);
  // One pending attempt at a time. `replace` is the offline re-park, the one
  // caller allowed to swap an armed rung for the safety delay.
  if (state.phase === "waiting" && !opts.replace) return NOTHING(state);
  const actions: LadderAction[] = leavingWaiting(state);
  actions.push({
    type: "schedule",
    delayMs: nextRetryDelay(state.attempts, { online: state.online, random }),
    // The attempt this timer will run — one ahead of the counter, because the
    // counter only moves when the attempt actually starts.
    attempt: state.attempts + 1,
  });
  return { state: { ...state, phase: "waiting" }, actions };
}

function startAttempt(state: LadderState): Reduction {
  const attempts = state.attempts + 1;
  // One bump, here. `connect` already abandons whatever the previous attempt
  // owned, so emitting `abandon` alongside it would bump twice and invalidate
  // the generation the caller is about to stamp its callbacks with.
  const generation = state.generation + 1;
  return {
    state: { ...state, phase: "connecting", attempts, generation },
    actions: [...leavingWaiting(state), { type: "connect", attempt: attempts, gen: generation }],
  };
}

function leavingWaiting(state: LadderState): LadderAction[] {
  return state.phase === "waiting" ? [{ type: "cancel-scheduled" }] : [];
}
