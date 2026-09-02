/**
 * Liveness watchdog for half-open sockets — the decision half, with no clock,
 * no socket and no fetch of its own (frontend/term.html, "liveness watchdog (G2)").
 *
 * THE SIGNATURE MOBILE FAILURE. A page that waits only for `onclose` never
 * learns about a black-holed path, because such a path produces no close:
 * ttyd's `-P 30` keepalive is server→client and the browser hides ping/pong
 * entirely, so a socket whose packets stopped arriving anywhere sits at
 * readyState OPEN forever. The terminal freezes while still looking connected,
 * and no reconnect ladder is running behind it because nothing ever reported a
 * drop. Everything here exists to reach a verdict on that socket.
 *
 * "No inbound data for N seconds" is NOT a usable rule — an idle terminal is
 * legitimately silent for hours — so `lastInboundAt` never produces a verdict
 * on its own here. It only ever satisfies the echo watch. Verdicts come from
 * ACTIVE probing, on two independent signals:
 *
 *  1. Reachability — a same-origin fetch of ttyd's own /token under a hard
 *     deadline. This is the only true round trip available: ttyd answers no
 *     client frame at all (src/protocol.c), so nothing sent over the WebSocket
 *     can ever come back. Judged on TRANSPORT, not on status — any HTTP
 *     response, 500 included, proves the path is alive, so a briefly unhappy
 *     server never costs a reconnect.
 *  2. Backpressure — `bufferedAmount` around a 1-byte no-op frame. The only
 *     deadness signal the socket object itself exposes, and alone it cannot
 *     catch a black hole: bufferedAmount drains as soon as bytes reach the
 *     network layer, and 1 byte per probe would take days to fill the send
 *     buffers a dead TCP connection keeps happily accepting into. It earns its
 *     place for the OTHER stall — a send path already jammed, a large paste
 *     against a crawling uplink — which the fetch would call healthy.
 *
 * Either signal failing `strikes` probes running means the socket can no longer
 * be trusted: the component drops it and hands the drop to the normal ladder,
 * which still consults the session kill-guard.
 *
 * The component owns the timers, the socket and the fetch. It feeds state in
 * and acts on what comes back, which is what makes every rule above testable
 * without a browser, a network or a clock.
 */

/**
 * The socket as the connection status panel names it. Deliberately the panel's
 * three words rather than the four numbers of `WebSocket.readyState`: CLOSING
 * and CLOSED are one thing to a reader, and the whole point of the watchdog is
 * that readyState is the value that lies.
 */
export type SocketState = "connecting" | "open" | "closed";

/** One probe's reading of one signal. */
export type Signal = "alive" | "stalled";

export type LivenessAction = "probe" | "wait" | "declare-dead";

export interface LivenessDecision {
  action: LivenessAction;
  /** Why, in the words the console line uses. */
  reason: string;
  /**
   * For "wait": how long until something could change the answer, so the
   * component can arm one timer instead of polling. `Infinity` while nothing is
   * being watched — a hidden tab, a suspended socket, a socket that is not open.
   */
  dueInMs: number;
}

export interface LivenessConfig {
  /** Cadence between probes. Just inside ttyd's 30s keepalive. */
  probeMs: number;
  /** Hard deadline on the reachability fetch — a reachable origin answers far sooner. */
  fetchTimeoutMs: number;
  /** Grace for one byte to leave the send buffer before backpressure is judged. */
  drainMs: number;
  /** Consecutive failed probes before a live-looking socket is dropped. */
  strikes: number;
  /** How long a keystroke may go unanswered before it is worth probing early. */
  echoGraceMs: number;
}

export const LIVENESS_DEFAULTS: LivenessConfig = {
  probeMs: 25_000,
  fetchTimeoutMs: 6_000,
  drainMs: 2_000,
  strikes: 3, // ~50s before a live-looking socket is dropped
  echoGraceMs: 1_500,
};

/**
 * A bare ttyd INPUT frame ('0') with a ZERO-LENGTH payload. Verified a no-op
 * against ttyd 1.7.7 (src/protocol.c): the INPUT case hands `pty_write` a
 * zero-length pty_buf, so zero bytes reach the pty — and a read-only server
 * drops it one line earlier on `!server->writable`. Anything longer would be
 * typed into whatever sits at the prompt.
 */
export const WS_PROBE_FRAME_BYTE = 0x30;

/** A fresh buffer per call: the caller hands it to `send`, and shares nothing. */
export function probeFrame(): ArrayBuffer {
  return Uint8Array.of(WS_PROBE_FRAME_BYTE).buffer;
}

/**
 * Everything the watchdog remembers about the socket it is currently judging.
 * Plain data, replaced rather than mutated, so a component can hold it in a
 * signal and a test can write one by hand.
 */
export interface Watch {
  /** Consecutive failed probes. Cleared only by a clean probe or a new socket. */
  strikes: number;
  /** A probe is still settling; a second must not overlap it. */
  probeInFlight: boolean;
  /** When the cadence was last anchored; null when the watchdog is not armed. */
  anchorAt: number | null;
  /**
   * When the current unanswered keystroke burst went out; null when there is
   * none — either because nobody is typing, or because the burst already spent
   * its one early probe (see `beginProbe`).
   */
  typedAt: number | null;
  /**
   * A reading is owed NOW, ahead of both the echo watch and the cadence. Set
   * when the tab comes back; cleared by the probe that answers it.
   */
  readingDue: boolean;
}

/** No socket to judge. */
export function idleWatch(): Watch {
  return { strikes: 0, probeInFlight: false, anchorAt: null, typedAt: null, readingDue: false };
}

/**
 * A socket just opened: from here on it has to prove it is alive. It starts
 * with a clean record — the strikes, and any keystroke still waiting for an
 * answer, belonged to the socket that is gone.
 */
export function watchSocket(now: number): Watch {
  return { strikes: 0, probeInFlight: false, anchorAt: now, typedAt: null, readingDue: false };
}

/**
 * The tab came back. Two things happen here, and they are one rule:
 *
 *  1. The cadence is re-anchored WITHOUT touching the strike count — coming
 *     back must not also absolve the socket. A phone glanced at every few
 *     seconds on a dead network would otherwise reset the count on every look
 *     and the watchdog could never reach a verdict, which is the exact case it
 *     exists for. Caught in a browser soak, where four forced probes all logged
 *     "strike 1/3".
 *  2. A reading is taken IMMEDIATELY. Coming back is the moment a socket most
 *     often turns out to have died unannounced while we were away, and waiting
 *     out a full 25s interval on a terminal that is already frozen is 25s of
 *     the user staring at a dead screen the watchdog could have named at once.
 *
 * Both halves are the visibilitychange handler in term.html, which calls
 * `armLivenessProbe()` and then `runLivenessProbe()` on the spot — the only
 * place either is reached outside a fresh socket. Folding them into one call
 * makes it impossible to take the first half without the second.
 */
export function reanchor(watch: Watch, now: number): Watch {
  return { ...watch, anchorAt: now, readingDue: true };
}

/**
 * Is an echo watch running — a keystroke burst still waiting for the pty, whose
 * deadline has not already been spent on a probe? A frame arriving in the same
 * millisecond counts as the answer.
 */
export function echoWatchArmed(watch: Watch, lastInboundAt: number | null): boolean {
  if (watch.typedAt === null) return false;
  return lastInboundAt === null || lastInboundAt < watch.typedAt;
}

/**
 * A keystroke went out. Typing is the cheapest liveness signal there is — bytes
 * went out, so something should come back — and a keystroke that produces
 * NOTHING is the cheapest evidence a socket is black-holed. Without this the
 * watchdog reaches the same verdict up to `strikes × probeMs` later, and every
 * key typed into that gap is lost with the pill still reading connected.
 *
 * One watch per burst, and the watch is ONE-SHOT: a burst that keeps typing
 * keeps the FIRST keystroke's deadline, or a fast typist on a dead socket would
 * push it forward forever. It re-arms on the first keystroke after the watch
 * stands down — which happens when the pty answers, and equally when the early
 * probe it asked for goes out (`beginProbe`). An idle terminal never arms it at
 * all, so the probe cadence — and the battery budget behind it — is untouched.
 */
export function noteTyped(watch: Watch, now: number, lastInboundAt: number | null): Watch {
  if (echoWatchArmed(watch, lastInboundAt)) return watch;
  return { ...watch, typedAt: now };
}

/**
 * A probe is going out: mark it in flight, move the cadence anchor to it, and
 * stand down whatever asked for it.
 *
 * Standing down is the half that matters. term.html's echo watch is a ONE-SHOT
 * timeout whose callback nulls the timer BEFORE it probes, so an unanswered
 * keystroke buys exactly one early probe; the tab-visible reading is a single
 * `runLivenessProbe()` call, not a mode. Without both, an unanswered keystroke
 * — a sudo password, `read -s`, a gpg passphrase, none of which echo anything
 * back — leaves the watchdog answering "probe now" every time it is asked, on a
 * socket that is perfectly healthy.
 *
 * A probe that goes out BEFORE the echo deadline is a cadence probe that merely
 * happened to run first: it leaves the keystroke watch armed, so the burst still
 * gets its early reading. That mirrors term.html, where the `setInterval` probe
 * never touches `echoWatchTimer`.
 */
export function beginProbe(
  watch: Watch,
  now: number,
  config: LivenessConfig = LIVENESS_DEFAULTS,
): Watch {
  const echoSpent = watch.typedAt !== null && watch.typedAt + config.echoGraceMs <= now;
  return {
    ...watch,
    probeInFlight: true,
    anchorAt: now,
    readingDue: false,
    typedAt: echoSpent ? null : watch.typedAt,
  };
}

/** What one probe learned, once both signals have settled. */
export interface ProbeOutcome {
  reachability: Signal;
  backpressure: Signal;
  /**
   * True when the socket was replaced while the probe was in flight — the
   * reading is about a socket nobody is watching any more.
   */
  superseded?: boolean;
  /**
   * Whether the tab stayed visible for the whole probe. A tab that hid
   * mid-probe had its timers and fetches throttled, so the reading is evidence
   * of nothing and yields no verdict in EITHER direction — it neither strikes
   * the socket nor clears the strikes it already carries.
   */
  stillVisible?: boolean;
}

/**
 * Fold one probe's outcome into the record.
 *
 * The in-flight flag is cleared on every path, discarded verdicts included: a
 * probe whose reading is thrown away must not wedge the watchdog into never
 * probing again.
 */
export function settleProbe(
  watch: Watch,
  outcome: ProbeOutcome,
  config: LivenessConfig = LIVENESS_DEFAULTS,
  now?: number,
): Watch {
  // A settling probe CONSUMES both pending requests, which is what term.html
  // does by having `runLivenessProbe()` return early on `livenessBusy`
  // (term.html:10075) — the request is a single call, not a mode that survives.
  //
  // `readingDue`: a tab-return request that outlived the probe fired a second
  // probe the instant the first landed, reachable by alt-tabbing away and back
  // during the 2-6s a probe takes, on every 25s cadence.
  //
  // `typedAt`: term.html's echo watch is a ONE-SHOT timer that fires on its own
  // deadline whether or not a probe is running, and its probe call is swallowed
  // by the same busy guard — so a burst whose deadline elapses mid-probe loses
  // its early reading rather than banking it. Spending it here needs `now`;
  // without it the deadline is left for beginProbe to spend, which is the old
  // behaviour and one extra probe per burst.
  const echoElapsed =
    now !== undefined && watch.typedAt !== null && watch.typedAt + config.echoGraceMs <= now;
  const settled: Watch = {
    ...watch,
    probeInFlight: false,
    readingDue: false,
    typedAt: echoElapsed ? null : watch.typedAt,
  };
  if (outcome.superseded) return settled;
  if (outcome.stillVisible === false) return settled;
  // One strike per probe, never two: a path that fails both signals at once is
  // still one failed probe, and counting it twice would drop the socket a third
  // sooner than `strikes` promises.
  if (outcome.reachability === "stalled" || outcome.backpressure === "stalled") {
    return { ...settled, strikes: Math.min(settled.strikes + 1, config.strikes) };
  }
  return { ...settled, strikes: 0 };
}

/**
 * `send()` threw. There is nothing left to wait for, so it is a strike on its
 * own — and the probe never reached the in-flight state.
 */
export function noteSendFailure(watch: Watch, config: LivenessConfig = LIVENESS_DEFAULTS): Watch {
  return {
    ...watch,
    probeInFlight: false,
    strikes: Math.min(watch.strikes + 1, config.strikes),
  };
}

/** Signal 1: judged on TRANSPORT, not on status. A 500 proves the path is alive. */
export function reachabilitySignal(result: { responded: boolean; status?: number }): Signal {
  return result.responded ? "alive" : "stalled";
}

/**
 * Signal 2: did the 1-byte frame leave the send buffer? `<=` and not `<`
 * because `before` is read BEFORE the byte is queued — a buffer back at its old
 * level is a buffer that drained.
 */
export function backpressureSignal(bufferedBefore: number, bufferedAfter: number): Signal {
  return bufferedAfter <= bufferedBefore ? "alive" : "stalled";
}

export interface LivenessInput {
  now: number;
  /** When the last frame arrived from the server; null if none ever has. */
  lastInboundAt: number | null;
  socketState: SocketState;
  /** Whether the tab is visible (`!document.hidden`). */
  visible: boolean;
  /** Whether the battery saver is deliberately holding the socket down. */
  batterySuspended: boolean;
  watch: Watch;
  config?: LivenessConfig;
}

const waiting = (reason: string, dueInMs = Infinity): LivenessDecision => ({
  action: "wait",
  reason,
  dueInMs,
});

/**
 * The whole watchdog in one pure call: probe now, wait, or stop trusting this
 * socket. Safe to call as often as the component likes — it reads state and
 * answers; it decides nothing about when it is next asked.
 */
export function decide(input: LivenessInput): LivenessDecision {
  const config = input.config ?? LIVENESS_DEFAULTS;
  const { watch, now } = input;

  // Only an OPEN socket is probed. One still CONNECTING has its own handshake
  // deadline and a closed one has the reconnect ladder; probing either would be
  // a second voice arguing with the one that owns it.
  if (input.socketState !== "open") {
    return waiting(`the socket is ${input.socketState}; the ladder owns it`);
  }

  // A verdict already reached stands. Checked ahead of the visibility gates on
  // purpose: the strikes were earned while the tab was visible, and hiding the
  // tab a moment later must not launder a socket that failed every probe it was
  // given.
  if (watch.strikes >= config.strikes) {
    return {
      action: "declare-dead",
      reason: `socket presumed dead — ${watch.strikes} failed probes running`,
      dueInMs: 0,
    };
  }

  // A suspended socket is down on purpose, and a hidden tab is the battery
  // saver's business: its timers and fetches are throttled hard enough to
  // manufacture false strikes, so no probe goes out and no verdict is reached.
  if (input.batterySuspended) return waiting("the battery saver is holding the socket down");
  if (!input.visible) return waiting("the tab is hidden; throttling would manufacture strikes");

  if (watch.probeInFlight) {
    return waiting("a probe is still settling", remainingMs(watch, now, config));
  }

  if (watch.anchorAt === null) return waiting("the watchdog is not armed");

  // The tab just came back, and a socket that died while the phone was in a
  // pocket is discovered here or 25s from now. Ahead of the echo watch and the
  // cadence both, because this reading is already overdue.
  //
  // A request made while a probe was already settling is consumed by that probe
  // (see settleProbe). An earlier revision kept it, reasoning that the probe's
  // verdict would be discarded as not-still-visible and the return would be left
  // with no reading at all. That was wrong about term.html, which samples
  // `document.hidden` only at settle (term.html:10102): for the sequence
  // visible-probe, hide, return, settle it is visible at settle and DOES count
  // that probe. The premise came from this module's own stricter `stillVisible`
  // contract, not from the page.
  if (watch.readingDue) {
    return {
      action: "probe",
      reason: "the tab came back; a socket can die unannounced while away",
      dueInMs: 0,
    };
  }

  // The echo watch runs ahead of the cadence: a keystroke that went out and
  // produced nothing is worth a probe now rather than up to a full interval
  // later. It can only bring a probe FORWARD — silence never convicts on its
  // own, because an idle terminal is legitimately silent for hours.
  const echoDue = echoWatchArmed(watch, input.lastInboundAt)
    ? (watch.typedAt as number) + config.echoGraceMs - now
    : Infinity;
  if (echoDue <= 0) return { action: "probe", reason: "a keystroke went unanswered", dueInMs: 0 };

  const cadenceDue = remainingMs(watch, now, config);
  if (cadenceDue <= 0) return { action: "probe", reason: "the probe cadence came due", dueInMs: 0 };

  return waiting("nothing to check yet", Math.min(cadenceDue, echoDue));
}

function remainingMs(watch: Watch, now: number, config: LivenessConfig): number {
  if (watch.anchorAt === null) return Infinity;
  return watch.anchorAt + config.probeMs - now;
}

/**
 * What the connection status panel should be told, given the socket's own state
 * and the watchdog's latest decision.
 *
 * Both halves matter. A socket carrying one or two strikes is still reported
 * `open`: it may well recover on the next probe, and painting suspicion would
 * make the panel cry wolf at every crowded-wifi hiccup. Once the watchdog
 * declares death the panel reads `closed` even though readyState still says
 * OPEN — that gap between the two IS the failure this module exists to catch,
 * and the panel sides with the watchdog.
 */
export function livenessSocketState(
  socketState: SocketState,
  decision: LivenessDecision,
): SocketState {
  return decision.action === "declare-dead" ? "closed" : socketState;
}
