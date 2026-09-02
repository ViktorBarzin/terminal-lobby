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
  decodeServerFrame,
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
  /** Injected in tests. */
  fetch?: typeof fetch;
  makeSocket?: (url: string, protocol: string) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Injected so the watchdog's arithmetic is drivable without a real clock. */
  now?: () => number;
}

export interface Attachment {
  /** Send a keystroke. Dropped when the socket is not open — held-key handling
   *  arrives with the input stage. */
  send(data: string): void;
  /** Tell the pty the terminal changed size. */
  resize(): void;
  /** The Reconnect button: starts an attempt from any phase, `ended` included. */
  reconnect(): void;
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

  const dispatch = (event: LadderEvent): void => {
    if (disposed) return;
    const { state: next, actions } = reduce(state, event);
    const phaseChanged = next.phase !== state.phase || next.attempts !== state.attempts;
    state = next;
    for (const action of actions) perform(action);
    if (phaseChanged) deps.onPhase(state.phase, state.attempts);
  };

  function perform(action: LadderAction): void {
    switch (action.type) {
      case "cancel-scheduled":
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = null;
        return;
      case "schedule":
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
        void openSocket(action.gen);
        return;
      case "check-session":
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
      dispatch({ type: "opened" });
      // The watchdog only ever judges an OPEN socket, so it starts here and is
      // anchored to this moment rather than to the attempt that preceded it.
      watch = watchSocket(clock());
      void tickLiveness();
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

  dispatch({ type: "start" });

  return {
    send(data: string): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeInput(data));
      // A keystroke that produces no output within the grace is worth probing
      // early — the cheapest evidence a socket has stopped carrying anything.
      watch = noteTyped(watch, clock(), lastInboundAt);
    },
    resize(): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeResize(deps.size()));
    },
    reconnect(): void {
      dispatch({ type: "reconnect-tapped", why: "asked by the lobby" });
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
