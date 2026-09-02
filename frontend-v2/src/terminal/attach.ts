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
    };
    s.onmessage = (ev: MessageEvent) => {
      if (gen !== liveGen) return;
      const frame = decodeServerFrame(ev.data);
      if (frame && frame.type === "output") deps.write(frame.payload);
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

  const onOnline = (): void => dispatch({ type: "network", online: true });
  const onOffline = (): void => dispatch({ type: "network", online: false });
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  dispatch({ type: "start" });

  return {
    send(data: string): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeInput(data));
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
      retryTimer = stableTimer = null;
      detach();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    },
  };
}
