/**
 * ttyd wire protocol — every frame this client sends and receives, as bytes.
 *
 * Ported from frontend/term.html, which has driven ttyd in production since the
 * iframe terminal shipped. This module is the whole protocol and nothing else:
 * no socket, no xterm, no DOM, no timers. Bytes in, bytes out, so the byte
 * layout can be pinned by tests instead of by a person watching a terminal.
 *
 * FRAME SHAPE. Every binary frame is one type byte followed by its payload.
 * The type bytes are ASCII digits, and the two directions REUSE THE SAME
 * VALUES for different meanings:
 *
 *   client → server            server → client
 *   0x30 '0'  INPUT            0x30 '0'  OUTPUT
 *   0x31 '1'  RESIZE (JSON)    0x31 '1'  SET_TITLE
 *   0x32 '2'  PAUSE            0x32 '2'  SET_PREFERENCES
 *   0x33 '3'  RESUME
 *
 * So there is no single "message type" enum here, and merging the two tables
 * would be a bug: 0x32 means "stop reading the pty" going out and "here are
 * your preferences" coming in.
 *
 * The one message that is NOT a typed binary frame is the init handshake, sent
 * as JSON text immediately after the socket opens (see `handshakeMessage`).
 *
 * ONE CHOKE POINT FOR PTY-BOUND TEXT. Every string headed for the pty —
 * keystrokes, the compose mirror, soft keys, paste — goes through
 * `decideInput`, which is where WATCH MODE drops it (term.html:8270-8283 puts
 * the same guard in `sendInput` for the same reason: a new input path inherits
 * it instead of having to remember it). Mouse reports do NOT pass through
 * there, matching term.onBinary — see `encodeBinaryInput`.
 *
 * WHAT IS DELIBERATELY NOT HERE. The flow-control accounting that decides WHEN
 * to send PAUSE/RESUME (byte counters, the fail-open watchdog) is client
 * policy, not wire format; this module only builds the two frames. The
 * reconnect ladder, the liveness watchdog and the held-input buffer likewise
 * belong to the component, as does the watch nudge itself: this module says
 * "nudge", and the component owns the toast and the few-seconds throttle that
 * keeps a held-down key from firing one per repeat.
 *
 * One more the component owes, and it is easy to miss because it sits ABOVE the
 * watch guard rather than below it: term.html's sendInput calls
 * cancelScrollMomentum() at :8239, before the `validWatch` return at :8280. So a
 * WATCHER's keystroke still cancels a flick coast even though its bytes are
 * dropped. That is a DOM concern and cannot live here, but a component that
 * wires `decideInput` as its choke point and reads this list will otherwise
 * never learn it. And term.html derives the
 * ttyd origin from its own page path, which is only correct because that page
 * is served at the origin root — the SPA passes an explicit base instead (see
 * `tokenUrl`).
 */

/** Client → server: keystrokes and pasted bytes. */
export const MSG_INPUT = 0x30;
/** Client → server: `{columns, rows}` as JSON. */
export const MSG_RESIZE = 0x31;
/** Client → server: stop reading the pty (our patched ttyd honours it). */
export const MSG_PAUSE = 0x32;
/** Client → server: resume reading the pty. */
export const MSG_RESUME = 0x33;

/** Server → client: terminal output. */
export const MSG_OUTPUT = 0x30;
/** Server → client: window title, one per connect. */
export const MSG_SET_TITLE = 0x31;
/** Server → client: ttyd's JSON preferences. */
export const MSG_SET_PREFS = 0x32;

/**
 * ttyd refuses a socket that does not ask for this subprotocol — the page must
 * open `new WebSocket(url, [WS_SUBPROTOCOL])`, and the connection dies in the
 * handshake without it.
 */
export const WS_SUBPROTOCOL = "tty";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

/**
 * One type byte + payload, in a buffer that holds NOTHING ELSE.
 *
 * Callers send `frame.buffer`, so a view into a larger or pooled buffer would
 * put stray bytes on the wire. Every encoder below goes through here, and the
 * tests assert `byteOffset === 0` and an exactly-sized buffer for each one.
 */
function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/**
 * Keystrokes, pasted text, soft-key bytes — anything that arrives as a JS
 * string. The payload is UTF-8, which is what xterm's `onData` produces and
 * what the pty expects.
 *
 * This is the ENCODER, not the choke point: a component that wires
 * `term.onData` straight to it types into a session it is only watching. Go
 * through `decideInput`.
 */
export function encodeInput(data: string): Uint8Array {
  return frame(MSG_INPUT, encoder.encode(data));
}

/** How this client attached. */
export interface InputMode {
  /**
   * WATCH MODE: this client asked to attach read-only ("ro" at arg5) and the
   * server agreed. Only the server's answer belongs here — the flag is a
   * request, resolved downgrade-only by tmux-api, and the page cannot grant
   * itself write access by lying about it.
   */
  watch: boolean;
}

/** What the component does with one pty-bound string. */
export type InputDecision =
  /** Put these bytes on the wire (or hold them, if there is no socket). */
  | { action: "send"; frame: Uint8Array }
  /** Watch mode: nothing goes out, and the person is told why. */
  | { action: "nudge" };

/**
 * The single choke point every pty-bound STRING passes through.
 *
 * WATCH MODE drops the byte here rather than at each input path, because this
 * one place already sees the keyboard, the compose mirror, the soft keys and
 * paste — so one guard covers all of them and a future path inherits it
 * (term.html:8280-8283).
 *
 * This is NOT the security boundary. tmux attached this client with `-r` on
 * the server's say-so and would discard these bytes anyway. What the drop adds
 * is an honest UI: without it a watcher types into a terminal that looks alive
 * and silently eats everything.
 *
 * The drop comes BEFORE any socket check, so a watcher's keystroke is never
 * held for replay either — holding it would promise a replay that read-only
 * attach can never deliver.
 */
export function decideInput(data: string, mode: InputMode): InputDecision {
  if (mode.watch) return { action: "nudge" };
  return { action: "send", frame: encodeInput(data) };
}

/**
 * xterm's `onBinary` string, where each char code IS one byte (0x00-0xff).
 *
 * These bytes must NOT go through TextEncoder. onBinary already carries encoded
 * bytes — mouse reports, and pastes xterm has already turned into bytes — so
 * UTF-8-encoding them again turns every value >= 0x80 into two bytes and
 * desyncs the escape sequence the server is parsing. `encodeInput` and this
 * function produce different frames for the same-looking string, and that
 * difference is the point.
 *
 * NO WATCH GUARD, deliberately, copying term.onBinary (term.html:8362-8370),
 * which has none either: this path carries mouse reports, and a watcher whose
 * clicks stop reaching the pty gets a terminal that ignores the mouse with no
 * nudge to explain it. tmux discards them for a read-only client regardless,
 * so there is nothing to gate. Text goes through `decideInput`; bytes come
 * straight here.
 */
export function encodeBinaryInput(data: string): Uint8Array {
  const payload = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) payload[i] = data.charCodeAt(i) & 0xff;
  return frame(MSG_INPUT, payload);
}

export interface TerminalSize {
  /** `term.cols`. */
  cols: number;
  /** `term.rows`. */
  rows: number;
}

/**
 * RESIZE: cols and rows, and nothing else.
 *
 * It also carried `xpixel`/`ypixel` until sixel was deprecated on 2026-09-04
 * (docs/adr/0004-sixel-images-in-the-terminal.md). Those two fields were read
 * only by fix 1 of devvm/ttyd-local.patch, which came out in the same change,
 * so they would now be numbers no server reads.
 *
 * cols and rows go out AS GIVEN, which is what term.html does in both places
 * it sends a size (`columns: term.cols, rows: term.rows`, :8325 and :10309).
 * The rounding helper that used to wrap them went with the pixel fields: it
 * existed because getBoundingClientRect returns fractions, and xterm's own
 * cols and rows are whole numbers, so there is nothing left for it to round.
 */
export function encodeResize(size: TerminalSize): Uint8Array {
  const json = JSON.stringify({ columns: size.cols, rows: size.rows });
  return frame(MSG_RESIZE, encoder.encode(json));
}

/** PAUSE — one byte, no payload. Tells our patched ttyd to stop reading the pty. */
export function encodePause(): Uint8Array {
  return frame(MSG_PAUSE, EMPTY);
}

/** RESUME — one byte, no payload. */
export function encodeResume(): Uint8Array {
  return frame(MSG_RESUME, EMPTY);
}

/**
 * The liveness probe: a bare INPUT frame with a ZERO-LENGTH payload.
 *
 * Verified a no-op against ttyd 1.7.7 (protocol.c hands pty_write a zero-length
 * pty_buf, so zero bytes reach the pty; a read-only server drops it one line
 * earlier on !server->writable). One byte longer and the probe would be TYPED
 * into whatever sits at the prompt every 25 seconds, so the length here is the
 * whole safety argument.
 */
export function encodeProbe(): Uint8Array {
  return frame(MSG_INPUT, EMPTY);
}

export interface Handshake {
  /** From `/token`; empty string when the server did not issue one. */
  token: string;
  cols: number;
  rows: number;
}

/**
 * The init message, sent as TEXT the moment the socket opens — the only
 * client → server message with no type byte in front of it.
 *
 * THE PTY IS CREATED AT THIS SIZE. ttyd parses `columns`/`rows` out of this
 * message and hands them to `spawn_process` (ttyd 1.7.7 src/protocol.c:328-349,
 * and :150-154, where they are written onto the process before `pty_spawn`).
 * It is also the only size ttyd will read until that process exists, because
 * `case RESIZE_TERMINAL` opens with `if (pss->process == NULL) break;`
 * (protocol.c:316-317).
 *
 * So the component still owes ONE explicit resize after the FIRST output frame,
 * which is the only proof the process exists. The reason is the dropped frame,
 * NOT a pty that has no size yet: a fit that lands in the gap between open and
 * spawn is discarded, and the pty then keeps the size measured here. Anything
 * that says the pty learns its size only once it exists is describing RESIZE,
 * not the handshake. Until 2026-09-04 that kick was ALSO what taught the pty
 * its pixel size for sixel; that half is gone with ADR-0004.
 *
 * Same field values as term.html:10307-10311, which sends `term.cols` and
 * `term.rows` as they are.
 */
export function handshakeMessage(init: Handshake): string {
  return JSON.stringify({
    AuthToken: init.token,
    columns: init.cols,
    rows: init.rows,
  });
}

/**
 * The token out of `/token`'s JSON body.
 *
 * A body that is an OBJECT WITHOUT a token yields "" and the handshake still
 * goes out — ttyd with no credential configured answers exactly that, and
 * refusing to connect there would break every deployment that does not use a
 * token.
 *
 * A body that is not there at all (JSON `null`, or nothing to read) THROWS,
 * and that throw is load-bearing. term.html reads `tokenData.token || ''`
 * (10245) with no guard in front of it, so a null body raises a TypeError
 * inside the `.then`, lands in the chain's `.catch` (10424-10433) and calls
 * scheduleReconnect() — no socket is ever opened. Answering "" instead would
 * turn a loud, self-healing failure into a socket opened with no credential
 * against an origin that has just told us it is misconfigured. The caller must
 * let this throw, and a rejected `r.json()` (a 404's HTML body) with it, reach
 * the same handler — that is the reconnect ladder's `attempt-failed` at
 * "token".
 *
 * A non-string token also becomes "": term.html would forward whatever truthy
 * value it found, both fail ttyd's check identically, and `Handshake.token` is
 * a string.
 */
export function tokenFromResponse(body: unknown): string {
  if (body === null || body === undefined) {
    throw new TypeError("/token did not answer with a token object");
  }
  const token = (body as { token?: unknown }).token;
  return typeof token === "string" ? token : "";
}

export type ServerFrame =
  | { type: "output"; payload: Uint8Array }
  | { type: "title"; title: string }
  | { type: "prefs"; prefs: unknown; raw: string }
  | { type: "unknown"; code: number; payload: Uint8Array };

/**
 * Decode one `message` event payload, or null for anything that is not a frame
 * we can read.
 *
 * Null covers three cases that all mean "ignore this, do not touch the
 * terminal": an empty frame, a text frame (ttyd sends none), and a Blob — which
 * is what arrives if the component forgets `binaryType = "arraybuffer"`. That
 * last one is silent and total: every frame decodes to null and the terminal
 * stays blank behind a healthy-looking socket.
 *
 * An unrecognised type byte comes back as `unknown` rather than as output.
 * Writing an unknown frame's payload to xterm would paint whatever control
 * bytes a future ttyd invented straight onto the screen.
 */
export function decodeServerFrame(data: unknown): ServerFrame | null {
  let view: Uint8Array;
  // Branded rather than `instanceof`: an ArrayBuffer built in another realm —
  // a test environment, a second document — fails `instanceof` and would fall
  // through to `return null`, which is the silent-and-total failure this
  // function's own contract warns about two paragraphs up. A browser page has
  // one realm and would never hit it; a test asserting the REAL socket payload
  // shape does, and a test that has to avoid the production path is not
  // testing the production path.
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    view = new Uint8Array(data as ArrayBuffer);
  } else if (ArrayBuffer.isView(data)) {
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }

  const code = view.length > 0 ? view[0] : undefined;
  if (code === undefined) return null;

  // slice, not subarray: the payload outlives this call. The flow-control path
  // hands it to term.write and reads it again from a completion callback, so it
  // must not be a window onto a buffer someone else may reuse.
  const payload = view.slice(1);

  switch (code) {
    case MSG_OUTPUT:
      return { type: "output", payload };
    case MSG_SET_TITLE:
      // ttyd sends one per connect, carrying '<command> (<hostname>)'. The
      // client deliberately does NOT apply it: the page already set the
      // meaningful 'tmux: <user>/<session>' title, and letting the frame win
      // replaces a name a person chose with a generic one.
      return { type: "title", title: decoder.decode(payload) };
    case MSG_SET_PREFS: {
      const raw = decoder.decode(payload);
      let prefs: unknown = null;
      try {
        prefs = JSON.parse(raw);
      } catch {
        // Informational only, so malformed JSON is not worth failing over — a
        // throw here would abort the message handler for a frame the client
        // does nothing with but log.
        prefs = null;
      }
      return { type: "prefs", prefs, raw };
    }
    default:
      return { type: "unknown", code, payload };
  }
}

/**
 * `/token` and `/ws` sit at the ttyd origin ROOT, and both carry the SAME
 * positional `arg=` query — the one built by `lib/terminal-url.ts`
 * (`buildTerminalArgs`), which owns that contract. Pass `args` without a
 * leading '?', exactly as that function returns it. Both endpoints must get the
 * identical string: an owner or a watch flag on /ws but not on /token attaches
 * a socket the token was not issued for.
 *
 * `base` is the origin-root prefix: "" for a normal deployment, "/sub" for a
 * genuine sub-path one. term.html derives it from its own pathname because it
 * is itself served at the root; an SPA route ("/session/foo") is not the ttyd
 * root, so the base is passed in rather than guessed.
 */
export function tokenUrl(base: string, args: string): string {
  return base + "/token?" + args;
}

/** ws: for http:, wss: for https: — a mismatch is blocked as mixed content. */
export function wsScheme(pageProtocol: string): string {
  return pageProtocol === "https:" ? "wss:" : "ws:";
}

/** The socket URL, carrying the same args as `/token`. */
export function socketUrl(
  page: { protocol: string; host: string },
  base: string,
  args: string,
): string {
  return wsScheme(page.protocol) + "//" + page.host + base + "/ws?" + args;
}
