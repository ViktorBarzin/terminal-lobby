/**
 * The terminal's one impure module: it owns the socket, the timers and the
 * xterm instance, and it makes no decisions of its own.
 *
 * Everything it does on an edge — when to retry, how long to wait, whether a
 * late answer still counts, what a keystroke means while the socket is down —
 * it asks a pure module in this directory (reconnect.ts, liveness.ts,
 * battery.ts, held.ts, wire.ts). That split is the whole point of the port:
 * frontend/term.html had these rules interleaved with DOM and socket handling
 * across 8,199 lines, where none of them could be tested without a browser.
 *
 * WHAT IT DELIBERATELY DOES NOT DO YET. Input beyond keystrokes (paste, the
 * soft keys, the compose mirror), selection and copy, pinch-to-zoom, sixel
 * images, and the held-key glyph overlay all stay with term.html until later
 * stages. This attaches, reconnects, resizes and types — enough to run a
 * terminal and to be judged against the iframe on the thing that matters most,
 * which is whether it survives a bad network.
 */

import {
  decideInput,
  decodeServerFrame,
  encodeBinaryInput,
  encodeInput,
  encodeResize,
  handshakeMessage,
  socketUrl,
  tokenFromResponse,
  tokenUrl,
  WS_SUBPROTOCOL,
  type TerminalSize,
} from "./wire";
import {
  initialLadder,
  reduce,
  type LadderAction,
  type LadderEvent,
  type LadderState,
} from "./reconnect";
import {
  backpressureSignal,
  beginProbe,
  decide as decideLiveness,
  idleWatch,
  LIVENESS_DEFAULTS,
  noteTyped,
  probeFrame,
  reachabilitySignal,
  reanchor,
  settleProbe,
  watchSocket,
  type Watch,
} from "./liveness";
import {
  decide as decideBattery,
  HIDDEN_SUSPEND_MS,
  type BatteryState,
} from "./battery";
import { EMPTY_HELD, flush as flushHeld, offer as offerHeld, type HeldState, type HeldVerdict } from "./held";

export interface AttachDeps {
  /**
   * The origin-root prefix ttyd is served under: "" for this deployment. NOT
   * the SPA's own route, which is not the ttyd root — see wire.ts `tokenUrl`.
   */
  base: string;
  /**
   * The positional `arg=` query string from lib/terminal-url.ts
   * `buildTerminalArgs`. Passed whole and used for BOTH `/token` and `/ws`,
   * because a flag on one and not the other attaches a socket the token was not
   * issued for (wire.ts says so at `tokenUrl`).
   */
  args: string;
  /** Where the page is, for ws: vs wss:. Injected so tests need no location. */
  page?: { protocol: string; host: string };
  /** Write server output into the terminal. */
  write(bytes: Uint8Array): void;
  /** The terminal's current size, read at handshake and on every resize. */
  size(): TerminalSize;
  /** Report a phase change so the shell's status badge can show it. */
  onPhase(phase: LadderState["phase"], attempt: number): void;
  /**
   * A socket just opened. ONCE per attach, which `onPhase("open")` is NOT.
   *
   * term.html puts two calls inside `ws.onopen` and on no other path to an
   * open connection: `mirrorLineReset()` at :10293 and
   * `cancelScrollMomentum()` at :10294. Neither is among its other nine
   * `mirrorLineReset` sites (:6828, :7301, :8342, :8922, :8963, :9004, :9126,
   * :9388, :9689), and neither is in `reportConnNow` (:9822-9824). So the page
   * has a once-per-socket signal that this file did not, and a caller that
   * hung such work off the phase instead ran it again on two other routes:
   *
   *   - THE ASK. `reportNow` below calls `deps.onPhase(askedPhase(), …)`
   *     directly, bypassing `dispatch` and its change test, and `askedPhase()`
   *     answers "open" for an open socket. Two things ask: the ADR-0016
   *     panel's Run check (App.tsx:304), and SessionView every time a session
   *     comes back on screen (SessionView.tsx:248, inside an effect gated on
   *     `onScreen()`). The second is the frequent one, since it is ordinary
   *     navigation rather than a deliberate check.
   *   - THE STABILITY PROOF. `dispatch` counts an attempt-count change as a
   *     phase change, and reconnect.ts's `proved-stable` returns `attempts: 0`
   *     with the phase still "open" (:238) where `startAttempt` had bumped it
   *     to 1 (:446). So `onPhase("open")` fires a second time
   *     `STABLE_AFTER_MS` (30 s) after every socket opens.
   *
   * Both of those are correct for a badge, which is what `onPhase` is for.
   * Neither is a new pty input line.
   */
  onAttach?: () => void;
  /**
   * This client attached READ-ONLY and the server agreed. Only the server's
   * answer belongs here: the flag is a request, resolved downgrade-only by
   * tmux-api, and the page cannot grant itself write access by lying.
   */
  watch?: () => boolean;
  /**
   * What is being held for replay changed, or a keystroke was refused. The
   * component draws the glyphs and says why; this file only decides.
   */
  onHeld?: (held: HeldState, verdict: HeldVerdict) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
  makeSocket?: (url: string, protocol: string) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Injected so the watchdog's arithmetic is drivable without a real clock. */
  now?: () => number;
}

export interface Attachment {
  /**
   * Send a keystroke, or any other pty-bound STRING. Watch mode drops it, and
   * a socket that is not open holds it for replay rather than losing it.
   */
  send(data: string): void;
  /**
   * Send what xterm hands over on `onBinary`: a string whose char codes ARE
   * the bytes, which in practice means mouse reports. Separate from `send`
   * because the two frame the payload differently and only one of them is
   * gated by watch mode (wire.ts, `encodeBinaryInput`).
   */
  sendBinary(data: string): void;
  /** Tell the pty the terminal changed size. */
  resize(): void;
  /** The Reconnect button: starts an attempt from any phase, `ended` included. */
  reconnect(): void;
  /**
   * Say what the terminal is doing right now, on demand.
   *
   * `onPhase` fires on a CHANGE (see `dispatch`), so a terminal that has been
   * open for ten minutes has said nothing for ten minutes and a shell asking
   * "what are you doing right now" has nothing to read: the ADR-0016 panel's
   * Run check, and a session view coming back on screen after a hidden
   * terminal went right on working.
   *
   * The answer is DERIVED when asked, not replayed, because the last phase
   * change can be stale in a way that matters: no network path under a socket
   * that still reads OPEN. term.html answers the same question the same way,
   * clearing its dedupe and re-deriving the state (`reportConnNow` and
   * `currentConnState`, :9822-9832).
   */
  reportNow(): void;
  state(): LadderState;
  dispose(): void;
}

/**
 * Open and keep open one ttyd connection.
 *
 * The loop is: an event goes into `reduce`, and every action it returns is
 * carried out here. Nothing in this file decides to retry, and nothing in
 * reconnect.ts touches a socket.
 */
export function attach(deps: AttachDeps): Attachment {
  const f = deps.fetch ?? fetch.bind(globalThis);
  const mkSocket =
    deps.makeSocket ?? ((url: string, protocol: string) => new WebSocket(url, protocol));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = deps.clearTimer ?? ((id: number) => clearTimeout(id));
  const clock = deps.now ?? (() => Date.now());
  const watching = (): boolean => deps.watch?.() === true;

  let state: LadderState = initialLadder({
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  });
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let stableTimer: number | null = null;
  let disposed = false;
  /**
   * The generation the LIVE socket belongs to. Every handler checks it before
   * acting: a socket abandoned mid-handshake still fires its close, and without
   * this that close would knock the attempt that replaced it off the ladder.
   */
  let liveGen = -1;
  /**
   * The attempt number the badge shows, which is NOT `state.attempts` while a
   * retry is pending.
   *
   * term.html paints `connAttempts + 1` in `scheduleReconnect` (:9877) and in
   * `reconnectAfterDrop` (:10155), which is the attempt the pending timer will
   * run, and `connect()` increments the counter before painting it
   * (:10231-10232), so the number holds still when the attempt it names
   * starts. `state.attempts` counts attempts already STARTED, so it agrees
   * during a connect and reads one behind for the whole wait in between.
   *
   * The ladder already works it out: `connect`, `schedule` and `check-session`
   * each carry the number to show, and those three are where this moves.
   */
  let attemptShown = 0;

  const dispatch = (event: LadderEvent): void => {
    if (disposed) return;
    const { state: next, actions } = reduce(state, event);
    const phaseChanged = next.phase !== state.phase || next.attempts !== state.attempts;
    state = next;
    for (const action of actions) perform(action);
    if (phaseChanged) deps.onPhase(state.phase, attemptShown);
  };

  /**
   * What the ask answers, derived when asked rather than replayed.
   *
   * term.html's `reportConnNow` clears the dedupe and then asks
   * `currentConnState()` for the state fresh. The two tests it makes before it
   * looks at the socket are the ones this follows, in that order: the battery
   * pause at :9827, then `navigator.onLine === false` at :9828.
   *
   * onLine ahead of the socket is the part that changes an answer. A wifi drop
   * flips onLine at once while the socket stays OPEN until the watchdog gives
   * up, which liveness.ts puts at ~50s (`strikes: 3`, `probeMs: 25_000`).
   * Nothing in that window changes phase, and it is the frozen terminal
   * ADR-0016 was built to explain. Replaying `open` there is the one answer
   * the panel must not give.
   *
   * The socket test at :9829 is the `open` phase itself: `opened` and `closed`
   * are dispatched from the socket's own handlers, so the phase is what this
   * file knows about readyState.
   */
  const askedPhase = (): LadderState["phase"] => {
    // The phone did nothing wrong and the next visibility change brings it
    // back, so a deliberate pause outranks the network. The status model is
    // where that verdict lives: diagnostics/status.ts maps "suspended" to
    // working, "paused to save battery", and its comment there gives the
    // reason, that painting a fault the app caused deliberately misreports a
    // phone behaving as designed.
    if (state.phase === "suspended") return "suspended";
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // The ladder has no `offline` phase: onLine false parks it and it keeps
      // waiting (reconnect.ts, "OFFLINE IS A PARK, NOT A RUNG"). The status
      // model does have one, and the shell derives it by reading the browser
      // for every phase that is not open, suspended or ended
      // (TerminalNative.tsx, `report`), so every other phase already answers
      // offline and goes out unchanged. `open` is the one that cannot: it is
      // read as health, so while there is no path it is replaced by the value
      // that mapping does read the browser for.
      //
      // term.html's onLine test outranks its 'closed' too (:9828 before the
      // hasConnectedOnce arm at :9831). `ended` is left out of this because
      // nothing produces it yet. `check-session` above answers `exists: true`
      // until the session-ended screen lands, and a branch no test can reach
      // is a claim nothing exercises.
      return state.phase === "open" ? "connecting" : state.phase;
    }
    return state.phase;
  };

  function perform(action: LadderAction): void {
    switch (action.type) {
      case "cancel-scheduled":
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = null;
        return;
      case "schedule":
        // term.html:9877, `paintConnPill(connAttempts + 1)` in
        // scheduleReconnect. The badge names the attempt this timer will run.
        attemptShown = action.attempt;
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = setTimer(() => {
          retryTimer = null;
          dispatch({ type: "start" });
        }, action.delayMs);
        return;
      case "abandon":
        detach();
        return;
      case "clear-stable":
        if (stableTimer !== null) clearTimer(stableTimer);
        stableTimer = null;
        return;
      case "arm-stable": {
        if (stableTimer !== null) clearTimer(stableTimer);
        const gen = action.gen;
        stableTimer = setTimer(() => {
          stableTimer = null;
          dispatch({ type: "proved-stable", gen });
        }, action.delayMs);
        return;
      }
      case "connect":
        // term.html:10231-10232, `connAttempts++; paintConnPill(connAttempts)`.
        // The counter moves as the attempt starts, which is why the number a
        // pending wait was already showing does not change when it runs.
        attemptShown = action.attempt;
        void openSocket(action.gen);
        return;
      case "check-session":
        // term.html:10155 paints before the existence check, which can itself
        // take a moment on a struggling network.
        attemptShown = action.attempt;
        // Deferred with the session-ended screen; until then a closed socket
        // simply retries, which is term.html's behaviour for a session that is
        // still there and the safe direction for one that is not.
        dispatch({ type: "session-checked", gen: action.gen, exists: true });
        return;
      case "stand-down":
        detach();
        return;
    }
  }

  /** Drop the current socket without letting its handlers reach the ladder. */
  function detach(): void {
    if (probeTimer !== null) clearTimer(probeTimer);
    probeTimer = null;
    watch = idleWatch();
    const s = socket;
    socket = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    try {
      s.close();
    } catch {
      /* already closing */
    }
  }

  async function openSocket(gen: number): Promise<void> {
    detach();
    liveGen = gen;
    let token: string;
    try {
      const res = await f(tokenUrl(deps.base, deps.args), { credentials: "same-origin" });
      // Both the rejected parse (a 404's HTML body) and the throw inside
      // tokenFromResponse (a JSON `null`) land here, which is term.html's
      // behaviour: no socket is opened and the ladder takes the next rung.
      token = tokenFromResponse(await res.json());
    } catch {
      if (gen === liveGen) dispatch({ type: "attempt-failed", gen, at: "token" });
      return;
    }
    if (disposed || gen !== liveGen) return;

    const page =
      deps.page ??
      (typeof location !== "undefined"
        ? { protocol: location.protocol, host: location.host }
        : { protocol: "https:", host: "localhost" });
    const url = socketUrl(page, deps.base, deps.args);
    let s: WebSocket;
    try {
      s = mkSocket(url, WS_SUBPROTOCOL);
    } catch {
      dispatch({ type: "attempt-failed", gen, at: "handshake" });
      return;
    }
    s.binaryType = "arraybuffer";
    socket = s;

    s.onopen = () => {
      if (gen !== liveGen) return;
      const size = deps.size();
      s.send(handshakeMessage({ token, cols: size.cols, rows: size.rows }));
      // BEFORE the phase goes out, which is term.html's order: :10293-10294 sit
      // above `reportConn('open', 0)` at :10296. It matters for the offline-Enter
      // flow, where the mirror's baseline has to be dropped before the hold is
      // replayed, and the replay is downstream of this whole handler.
      deps.onAttach?.();
      dispatch({ type: "opened" });
      // The watchdog only ever judges an OPEN socket, so it starts here and is
      // anchored to this moment rather than to the attempt that preceded it.
      watch = watchSocket(clock());
      void tickLiveness();
      // The replay does NOT go out here. ttyd drops what arrives before the
      // process is spawned, and the socket being open is not that proof — the
      // first OUTPUT frame is, which is the same reason wire.ts says the
      // explicit resize waits for it. Flushing on `open` silently lost
      // everything typed into the gap, which is the one thing the hold exists to
      // prevent (caught by typing into a dead socket and watching it not come
      // back).
      spawned = false;
    };
    s.onmessage = (ev: MessageEvent) => {
      if (gen !== liveGen) return;
      const frame = decodeServerFrame(ev.data);
      if (!frame) return;
      // Only an OUTPUT frame proves the pty answered. The title and prefs frames
      // arrive once per connect and would clear an echo watch the pty never
      // satisfied — term.html calls noteEchoSeen from the output case alone.
      if (frame.type === "output") {
        lastInboundAt = clock();
        deps.write(frame.payload);
        if (!spawned) {
          spawned = true;
          // Now there is a process to receive it. The text goes however old it
          // is — it has been on screen the whole time — while a committed Enter
          // only goes inside the window where the prompt is still the one it was
          // typed at.
          if (held.text) {
            const replay = flushHeld(held, clock());
            held = replay.state;
            for (const chunk of replay.sends) s.send(encodeInput(chunk));
            deps.onHeld?.(held, "held");
          }
          // NOT how the pty first learns its size: it was spawned at the
          // handshake size (wire.ts, `handshakeMessage`, which carries the
          // ttyd citations in full). This is here because a RESIZE arriving
          // before the process exists is dropped (`case RESIZE_TERMINAL: if
          // (pss->process == NULL) break;`, ttyd 1.7.7 src/protocol.c:316-317),
          // so a fit that lands between open and spawn is lost, and sending
          // once there IS a process to receive it is what covers that.
          try {
            s.send(encodeResize(deps.size()));
          } catch {
            /* the socket went between the frame and this; the ladder has it */
          }
        }
      }
    };
    s.onerror = () => {
      /* a close always follows; the ladder reacts to that */
    };
    s.onclose = () => {
      if (gen !== liveGen) return;
      socket = null;
      dispatch({ type: "closed" });
    };
  }

  // ---- the liveness watchdog ----------------------------------------------
  // A black-holed socket stays readyState OPEN forever, so nothing arrives to
  // react to. liveness.ts decides; this arms one timer for whatever it says is
  // next, and runs the two independent probes when it asks for a reading.
  let watch: Watch = idleWatch();
  let lastInboundAt: number | null = null;
  /** Typed while the socket was down, waiting for one to come back. */
  let held: HeldState = EMPTY_HELD;
  /** Has THIS socket produced output yet — the only proof ttyd spawned a pty. */
  let spawned = false;
  let probeTimer: number | null = null;

  const armProbe = (dueInMs: number): void => {
    if (probeTimer !== null) clearTimer(probeTimer);
    probeTimer = null;
    if (!Number.isFinite(dueInMs)) return; // nothing is being watched
    probeTimer = setTimer(() => {
      probeTimer = null;
      void tickLiveness();
    }, Math.max(0, dueInMs));
  };

  async function tickLiveness(): Promise<void> {
    if (disposed) return;
    const s = socket;
    const decision = decideLiveness({
      now: clock(),
      lastInboundAt,
      socketState:
        !s || s.readyState !== WebSocket.OPEN
          ? "closed"
          : "open",
      visible: typeof document === "undefined" ? true : !document.hidden,
      batterySuspended: state.phase === "suspended",
      watch,
    });

    if (decision.action === "declare-dead") {
      watch = idleWatch();
      dispatch({ type: "presumed-dead", gen: liveGen });
      return;
    }
    if (decision.action === "wait") {
      armProbe(decision.dueInMs);
      return;
    }

    // A reading, on two signals that fail independently: can the origin still
    // answer at all, and does a byte actually leave this socket's buffer.
    const gen = liveGen;
    watch = beginProbe(watch, clock());
    const before = s ? s.bufferedAmount : 0;
    let responded = false;
    let status: number | undefined;
    try {
      const res = await f(tokenUrl(deps.base, deps.args), {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(LIVENESS_DEFAULTS.fetchTimeoutMs),
      });
      responded = true;
      status = res.status;
    } catch {
      responded = false;
    }
    try {
      s?.send(probeFrame());
    } catch {
      /* the drain check below reads the same failure as backpressure */
    }
    await new Promise((r) => setTimer(() => r(undefined), LIVENESS_DEFAULTS.drainMs));
    if (disposed) return;
    const after = socket ? socket.bufferedAmount : before;

    watch = settleProbe(
      watch,
      {
        reachability: reachabilitySignal({ responded, status }),
        backpressure: backpressureSignal(before, after),
        // The socket this probe was judging may already have been replaced.
        superseded: gen !== liveGen,
        stillVisible: typeof document === "undefined" ? true : !document.hidden,
      },
      LIVENESS_DEFAULTS,
      clock(),
    );
    void tickLiveness();
  }

  // ---- the battery saver ---------------------------------------------------
  // A hidden tab holding a socket keeps the radio warm for nobody. battery.ts
  // decides; this owns the countdown and the visibility listeners.
  let hiddenSince: number | null = null;
  let graceTimer: number | null = null;

  const batteryState = (): BatteryState => ({
    hidden: typeof document === "undefined" ? false : document.hidden,
    msHidden: hiddenSince === null ? null : clock() - hiddenSince,
    suspended: state.phase === "suspended",
  });

  const onBattery = (event: Parameters<typeof decideBattery>[1]): void => {
    const { action } = decideBattery(batteryState(), event);
    if (action === "suspend") dispatch({ type: "suspend" });
    else if (action === "resume") dispatch({ type: "resume", why: String(event) });
  };

  const armGrace = (): void => {
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = setTimer(() => {
      graceTimer = null;
      onBattery("grace-elapsed");
    }, HIDDEN_SUSPEND_MS);
  };

  const onVisibility = (): void => {
    const hidden = typeof document !== "undefined" && document.hidden;
    if (hidden) {
      hiddenSince = clock();
      armGrace();
      onBattery("hidden");
      return;
    }
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = null;
    hiddenSince = null;
    onBattery("visible");
    // Coming back is when a socket most often turns out to have died while we
    // were away, so the watchdog re-anchors AND takes a reading now rather than
    // waiting out a full interval on a terminal that is already frozen.
    watch = reanchor(watch, clock());
    void tickLiveness();
  };

  const onOnline = (): void => dispatch({ type: "network", online: true });
  const onOffline = (): void => dispatch({ type: "network", online: false });
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    // A tab opened into the background boots hidden and no visibilitychange
    // ever fires for it, so the countdown has to be armed here too.
    if (typeof document !== "undefined" && document.hidden) {
      hiddenSince = clock();
      armGrace();
      onBattery("boot");
    }
  }

  /**
   * Offer a chunk to the hold and tell the component what came back.
   *
   * Both send paths share it, because term.onBinary calls the same
   * `offerHeldInput` that sendInput calls, commented "same contract as
   * sendInput" (term.html:8366). Each of those two had its own bare
   * `if (!OPEN) return` once, and fixing one while leaving the other still ate
   * input, which is what term-html.bridge.test.ts pins.
   */
  const offerToHold = (data: string): void => {
    const result = offerHeld(held, data, {
      watching: watching(),
      hasConnectedOnce: state.hasConnectedOnce,
      suspended: state.phase === "suspended",
      now: clock(),
    });
    held = result.state;
    deps.onHeld?.(held, result.verdict);
  };

  dispatch({ type: "start" });

  return {
    send(data: string): void {
      // ONE choke point for every pty-bound string, which is what lets the
      // watch-mode drop cover the keyboard, paste, the soft keys and the compose
      // mirror at once — and what makes a future input path inherit it.
      const decision = decideInput(data, { watch: watching() });
      if (decision.action === "nudge") {
        deps.onHeld?.(held, "refused:watching");
        return;
      }
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        // No socket: the keystroke is held rather than lost, and the component
        // draws it so the person can see their typing is still there.
        offerToHold(data);
        return;
      }
      socket.send(decision.frame);
      // A keystroke that produces no output within the grace is worth probing
      // early — the cheapest evidence a socket has stopped carrying anything.
      watch = noteTyped(watch, clock(), lastInboundAt);
    },
    /**
     * A mouse report, or anything else xterm hands over on `onBinary`: a string
     * whose char codes ARE the bytes. This mirrors term.html:8361-8370, and it
     * differs from `send` in three ways, each of them deliberate.
     *
     * ONE BYTE PER CHAR. `encodeBinaryInput`, never `encodeInput`: these bytes
     * are already encoded, so running them through UTF-8 turns every value
     * >= 0x80 into two and desyncs the escape sequence the server is parsing.
     * wire.ts says it at `encodeBinaryInput`.
     *
     * NO WATCH GUARD, so no `decideInput` call here. term.onBinary has none
     * either: tmux discards a read-only client's reports regardless, and a
     * watcher whose clicks stopped arriving would get a terminal that ignores
     * the mouse with no nudge to explain it.
     *
     * NO ECHO WATCH. sendInput ends with armEchoWatch() (term.html:8298) and
     * onBinary has no equivalent, so a drag or a wheel spin, which the pty need
     * not answer at all, does not ask the watchdog for probes the socket has
     * not earned.
     *
     * What it does share is the socket-state and held-input rules, which is
     * what term.html:8366 means by "same contract as sendInput". The hold
     * refuses a report rather than queueing it, because `isHoldable` rejects
     * the ESC every report starts with, and that is also why the hold's UTF-8
     * replay never sees these bytes.
     *
     * ONE DELTA from the page, and it changes no byte on the wire. The shared
     * hold checks the watch gate first (held.ts, `HeldGates.watching`), so a
     * WATCHER's report on a dead socket comes back `refused:watching`, where
     * term.html reaches whatever its socket gates or `heldIsPrintable` say
     * because validWatch is tested in sendInput and not in onBinary. Both
     * refuse and neither sends; only the verdict the component reports differs.
     */
    sendBinary(data: string): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        offerToHold(data);
        return;
      }
      socket.send(encodeBinaryInput(data));
    },
    resize(): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeResize(deps.size()));
    },
    reconnect(): void {
      dispatch({ type: "reconnect-tapped", why: "asked by the lobby" });
    },
    /**
     * The answer goes out through the SAME callback the change path uses, so
     * the shell has one place to read it, which is what term.html does with
     * `reportConn` rather than composing a second message (:9822-9824).
     *
     * The answer itself is derived here and CAN differ from the last
     * volunteered one, which is the point. term.html takes its state fresh
     * from `currentConnState()` inside that same function, and the case where
     * the two disagree is the one worth asking about (`askedPhase`).
     *
     * It reads; it does not repair. Reading is not the line ADR-0016 draws,
     * since term.html's own ask reads `ws.readyState` and `navigator.onLine`
     * (:9828-9829). The line is that the broken state a person came to look at
     * has to still be there afterwards ("The check reads; the repairs are
     * separate taps"). So this opens nothing, sends nothing, closes nothing and
     * arms no timer, and the tests hold it to that.
     *
     * Silent once disposed, as `dispatch` is. The component has already handed
     * the shell its `closed` by then, and re-reporting the phase this died in
     * would leave the badge describing a terminal that is gone.
     */
    reportNow(): void {
      if (disposed) return;
      deps.onPhase(askedPhase(), attemptShown);
    },
    state: () => state,
    dispose(): void {
      disposed = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      if (stableTimer !== null) clearTimer(stableTimer);
      if (probeTimer !== null) clearTimer(probeTimer);
      if (graceTimer !== null) clearTimer(graceTimer);
      retryTimer = stableTimer = probeTimer = graceTimer = null;
      detach();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
  };
}
