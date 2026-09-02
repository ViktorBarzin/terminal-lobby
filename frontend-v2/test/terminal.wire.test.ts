import { describe, it, expect } from "vitest";
import {
  MSG_INPUT,
  MSG_OUTPUT,
  MSG_PAUSE,
  MSG_RESIZE,
  MSG_RESUME,
  MSG_SET_PREFS,
  MSG_SET_TITLE,
  WS_SUBPROTOCOL,
  decideInput,
  decodeServerFrame,
  encodeBinaryInput,
  encodeInput,
  encodePause,
  encodeProbe,
  encodeResize,
  encodeResume,
  handshakeMessage,
  socketUrl,
  tokenFromResponse,
  tokenUrl,
  wsScheme,
} from "../src/terminal/wire";

const bytes = (frame: Uint8Array): number[] => Array.from(frame);
const text = (frame: Uint8Array): string => new TextDecoder().decode(frame.subarray(1));

describe("input frames", () => {
  it("prefixes a keystroke with '0' and sends the rest as UTF-8", () => {
    expect(bytes(encodeInput("ls\r"))).toEqual([0x30, 0x6c, 0x73, 0x0d]);
  });

  it("encodes non-ASCII typing as UTF-8, which is what the pty reads", () => {
    expect(bytes(encodeInput("é"))).toEqual([0x30, 0xc3, 0xa9]);
    expect(bytes(encodeInput("→"))).toEqual([0x30, 0xe2, 0x86, 0x92]);
  });

  /**
   * xterm's onBinary hands over BYTES already, dressed as a string. Running
   * them through TextEncoder turns every value >= 0x80 into two bytes, which
   * desyncs whatever escape sequence the server is mid-way through parsing —
   * an X10 mouse report past column 95 being the everyday case.
   */
  it("passes onBinary bytes through untouched, one char to one byte", () => {
    expect(bytes(encodeBinaryInput("é"))).toEqual([0x30, 0xe9]);
    expect(bytes(encodeBinaryInput("\x1b[M ÀÀ"))).toEqual([
      0x30, 0x1b, 0x5b, 0x4d, 0x20, 0xc0, 0xc0,
    ]);
  });

  it("keeps a NUL, a DEL and a 0xff in a binary payload", () => {
    expect(bytes(encodeBinaryInput("\u0000\u007f\u00ff"))).toEqual([0x30, 0x00, 0x7f, 0xff]);
  });

  it("gives the same-looking string different bytes on the two input paths", () => {
    expect(encodeInput("é").length).toBe(3);
    expect(encodeBinaryInput("é").length).toBe(2);
  });

  /**
   * Callers send `frame.buffer`. A view into a pooled or larger buffer would
   * put the neighbouring bytes on the wire behind the caller's back, so every
   * encoder must own its buffer outright.
   */
  it("hands the socket a buffer that holds the frame and nothing else", () => {
    for (const frame of [
      encodeInput("hello"),
      encodeBinaryInput("ÿþ"),
      encodeResize({ cols: 80, rows: 24 }),
      encodePause(),
      encodeResume(),
      encodeProbe(),
    ]) {
      expect(frame.byteOffset).toBe(0);
      expect(frame.buffer.byteLength).toBe(frame.length);
    }
  });
});

describe("the liveness probe", () => {
  /**
   * The probe fires every 25s down a live socket. It is a no-op only because
   * its payload is empty — ttyd 1.7.7 hands pty_write a zero-length buffer, so
   * zero bytes reach the pty. One byte more and the watchdog would be typing
   * into whatever sits at the prompt.
   */
  it("is exactly one byte, so nothing is ever typed at the prompt", () => {
    expect(bytes(encodeProbe())).toEqual([0x30]);
  });

  it("is an INPUT frame with a zero-length payload", () => {
    expect(bytes(encodeProbe())).toEqual(bytes(encodeInput("")));
  });

  /** A shared constant would let one caller's scribble ride out on every later probe. */
  it("returns a fresh array each call, so one caller cannot poison the next probe", () => {
    const first = encodeProbe();
    first[0] = 0x39;
    expect(bytes(encodeProbe())).toEqual([0x30]);
  });
});

describe("the resize frame", () => {
  it("prefixes '1' and carries columns, rows and pixels as JSON", () => {
    const frame = encodeResize({ cols: 80, rows: 24, xpixel: 640, ypixel: 384 });
    expect(frame[0]).toBe(0x31);
    expect(text(frame)).toBe('{"columns":80,"rows":24,"xpixel":640,"ypixel":384}');
  });

  /**
   * tmux re-emits sixel only to clients whose pty reports a pixel size (it
   * reads it via TIOCGWINSZ alone); a zero-pixel pty gets a "SIXEL IMAGE
   * (WxH)" text placeholder instead of the picture. Dropping the fields when
   * nothing can be measured means the pty never learns them at all, so 0 goes
   * out instead.
   */
  it("always sends the pixel fields, even when nothing could be measured", () => {
    const parsed = JSON.parse(text(encodeResize({ cols: 100, rows: 30 })));
    expect(parsed).toEqual({ columns: 100, rows: 30, xpixel: 0, ypixel: 0 });
  });

  it("rounds a fractional rect to whole pixels", () => {
    const parsed = JSON.parse(
      text(encodeResize({ cols: 80, rows: 24, xpixel: 640.4, ypixel: 383.6 })),
    );
    expect(parsed.xpixel).toBe(640);
    expect(parsed.ypixel).toBe(384);
  });

  /** JSON.stringify turns NaN into null, and a null is not a size ttyd can read. */
  it("turns an unmeasurable pixel size into 0 rather than null", () => {
    const parsed = JSON.parse(text(encodeResize({ cols: 80, rows: 24, xpixel: NaN })));
    expect(parsed.xpixel).toBe(0);
    expect(parsed.ypixel).toBe(0);
  });

  it("does not use the input frame's type byte", () => {
    expect(encodeResize({ cols: 80, rows: 24 })[0]).not.toBe(MSG_INPUT);
  });
});

describe("flow-control frames", () => {
  it("pauses with a lone '2' and resumes with a lone '3'", () => {
    expect(bytes(encodePause())).toEqual([0x32]);
    expect(bytes(encodeResume())).toEqual([0x33]);
  });

  /**
   * Swapping these strangles the stream: the client would tell the server to
   * stop reading the pty exactly when its write queue had drained, and the
   * only thing that would release it is the fail-open watchdog, 4s later,
   * every time.
   */
  it("never sends the same byte for pause and for resume", () => {
    expect(bytes(encodePause())).not.toEqual(bytes(encodeResume()));
    expect(encodePause().length).toBe(1);
    expect(encodeResume().length).toBe(1);
  });
});

describe("the two directions reuse the same type bytes", () => {
  /**
   * This is why there is no single message-type enum. A shared table would
   * quietly make PAUSE and SET_PREFERENCES the same thing, and the first
   * refactor that "deduplicated" them would send preferences to the server.
   */
  it("means '2' is PAUSE going out and SET_PREFS coming in", () => {
    expect(MSG_PAUSE).toBe(MSG_SET_PREFS);
    expect(MSG_RESIZE).toBe(MSG_SET_TITLE);
    expect(MSG_INPUT).toBe(MSG_OUTPUT);
  });

  it("leaves RESUME with no server-side meaning at all", () => {
    expect([MSG_OUTPUT, MSG_SET_TITLE, MSG_SET_PREFS]).not.toContain(MSG_RESUME);
  });
});

describe("the init handshake", () => {
  it("is JSON text carrying the token and the size", () => {
    expect(handshakeMessage({ token: "abc123", cols: 80, rows: 24 })).toBe(
      '{"AuthToken":"abc123","columns":80,"rows":24}',
    );
  });

  /** Every other client message starts with a type byte; this one starts with '{'. */
  it("carries no type byte in front of it", () => {
    const msg = handshakeMessage({ token: "t", cols: 80, rows: 24 });
    expect(msg.charCodeAt(0)).toBe(0x7b);
    expect(typeof msg).toBe("string");
  });

  /**
   * The handshake has no pixel fields and ttyd drops RESIZE messages that
   * arrive before the process is spawned. That pair is the whole reason the
   * component must send one explicit resize after the first OUTPUT frame — if
   * this ever changes, that kick can go.
   */
  it("tells ttyd nothing about pixels, which is why a resize kick is needed", () => {
    const parsed = JSON.parse(handshakeMessage({ token: "t", cols: 80, rows: 24 }));
    expect(Object.keys(parsed)).toEqual(["AuthToken", "columns", "rows"]);
  });

  it("still handshakes when the server issued no token", () => {
    expect(handshakeMessage({ token: tokenFromResponse({}), cols: 80, rows: 24 })).toBe(
      '{"AuthToken":"","columns":80,"rows":24}',
    );
  });

  it("reads the token out of the /token body, and empty out of a body without one", () => {
    expect(tokenFromResponse({ token: "abc" })).toBe("abc");
    expect(tokenFromResponse({})).toBe("");
    expect(tokenFromResponse({ token: null })).toBe("");
    expect(tokenFromResponse({ token: 123 })).toBe("");
    // ttyd's own answer shapes end here; a primitive body is what a proxy
    // returns, and term.html reads .token off it just the same — undefined.
    expect(tokenFromResponse("not json")).toBe("");
    expect(tokenFromResponse(7)).toBe("");
  });

  /**
   * The failure this prevents: /token answering `null` (or nothing at all)
   * becoming a SUCCESSFUL empty-token handshake. term.html has no guard in
   * front of `tokenData.token` — the read raises a TypeError, the chain's
   * .catch calls scheduleReconnect(), and no socket is ever opened. Swallowing
   * it into "" opens an uncredentialled socket against an origin that has just
   * said it is misconfigured, and the ladder never learns the attempt failed.
   */
  it("fails the whole attempt when /token answers with no object at all", () => {
    expect(() => tokenFromResponse(null)).toThrow(TypeError);
    expect(() => tokenFromResponse(undefined)).toThrow(TypeError);
  });

  /**
   * The two bodies look alike from a distance and mean opposite things: {} is
   * "this deployment has no token", null is "this is not the /token endpoint".
   */
  it("separates a tokenless deployment from a /token that answered nothing", () => {
    expect(handshakeMessage({ token: tokenFromResponse({}), cols: 80, rows: 24 })).toContain(
      '"AuthToken":""',
    );
    expect(() => handshakeMessage({ token: tokenFromResponse(null), cols: 80, rows: 24 })).toThrow();
  });
});

describe("watch mode", () => {
  const watching = { watch: true };
  const driving = { watch: false };

  it("puts a keystroke on the wire when this client is driving the session", () => {
    const decision = decideInput("ls\r", driving);
    expect(decision.action).toBe("send");
    expect(bytes((decision as { frame: Uint8Array }).frame)).toEqual(bytes(encodeInput("ls\r")));
  });

  /**
   * The failure this prevents: a component wiring term.onData -> encodeInput ->
   * ws.send, which types into a session it only asked to watch. tmux attached
   * this client with -r and discards the bytes, so the visible symptom is a
   * terminal that looks alive and silently eats everything typed into it.
   */
  it("drops a watcher's keystroke instead of encoding it", () => {
    expect(decideInput("ls\r", watching)).toEqual({ action: "nudge" });
  });

  /**
   * term.html drops at sendInput rather than at each input path precisely so a
   * path added later inherits the guard. These are the four that exist today.
   */
  it("drops every path that reaches the pty, not just the keyboard", () => {
    for (const data of [
      "a", // raw keystroke
      "\u043a\u043b\u044e\u0447", // the compose mirror, committing an IME word
      "\x1b[A", // a soft key
      "\x1b[200~git push\x1b[201~", // a bracketed paste
    ]) {
      expect(decideInput(data, watching).action).toBe("nudge");
    }
  });

  /**
   * The drop sits in front of the socket check in term.html, so a watcher's
   * keystroke is never handed to the held-input buffer: holding it would
   * promise a replay that a read-only attach can never deliver. The decision
   * takes no socket state at all, which is how that ordering is enforced here.
   */
  it("decides on the attach alone, so nothing is held for a replay that cannot happen", () => {
    expect(decideInput("x", watching)).toEqual(decideInput("x", { watch: true }));
    expect(decideInput.length).toBe(2);
  });

  /**
   * Deliberate asymmetry, copied from term.onBinary (term.html:8362-8370),
   * which has no watch check: this path carries mouse reports, and gating it
   * would leave a watcher with a terminal that ignores the mouse and no nudge
   * to explain why. tmux discards them for a read-only client anyway.
   */
  it("still encodes mouse reports while watching, because onBinary has no guard", () => {
    expect(bytes(encodeBinaryInput("\x1b[M !!"))).toEqual([
      0x30, 0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21,
    ]);
    expect(encodeBinaryInput.length).toBe(1);
  });
});

describe("decoding what the server sends", () => {
  const buffer = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer;

  it("reads an output frame as its payload, without the type byte", () => {
    const frame = decodeServerFrame(buffer(0x30, 0x68, 0x69));
    expect(frame).toEqual({ type: "output", payload: Uint8Array.from([0x68, 0x69]) });
  });

  /**
   * Flow control hands the payload to term.write and reads it again from a
   * completion callback that may run much later. A subarray onto the socket's
   * buffer would let a reused buffer rewrite output that is still queued.
   */
  it("copies the payload, so a reused buffer cannot rewrite it afterwards", () => {
    const backing = new ArrayBuffer(4);
    const src = new Uint8Array(backing);
    src.set([0x30, 1, 2, 3]);
    const frame = decodeServerFrame(backing);
    src[1] = 9;
    expect(frame?.type).toBe("output");
    expect(bytes((frame as { payload: Uint8Array }).payload)).toEqual([1, 2, 3]);
  });

  it("reads a view's own window, not its neighbours", () => {
    const backing = Uint8Array.from([0xff, 0x30, 0x41, 0x42, 0xff]);
    const frame = decodeServerFrame(backing.subarray(1, 4));
    expect(frame).toEqual({ type: "output", payload: Uint8Array.from([0x41, 0x42]) });
  });

  it("ignores an empty frame rather than reading a type byte that is not there", () => {
    expect(decodeServerFrame(new ArrayBuffer(0))).toBeNull();
  });

  /**
   * A component that forgets `binaryType = "arraybuffer"` gets Blobs, and the
   * failure is silent and total: every frame decodes to null and the terminal
   * stays blank behind a socket that looks perfectly healthy.
   */
  it("ignores anything that is not binary, so a Blob never reaches the terminal", () => {
    expect(decodeServerFrame("0hello")).toBeNull();
    expect(decodeServerFrame(new Blob(["0hello"]))).toBeNull();
    expect(decodeServerFrame(null)).toBeNull();
    expect(decodeServerFrame(undefined)).toBeNull();
    expect(decodeServerFrame({ data: "0hi" })).toBeNull();
  });

  it("decodes the title frame's UTF-8 text", () => {
    const frame = decodeServerFrame(buffer(0x31, 0x74, 0x6d, 0x75, 0x78, 0xc3, 0xa9));
    expect(frame).toEqual({ type: "title", title: "tmuxé" });
  });

  it("parses the preferences frame's JSON", () => {
    const payload = Array.from(new TextEncoder().encode('{"fontSize":13}'));
    expect(decodeServerFrame(buffer(0x32, ...payload))).toEqual({
      type: "prefs",
      prefs: { fontSize: 13 },
      raw: '{"fontSize":13}',
    });
  });

  /**
   * The shipped handler wraps JSON.parse in a catch because prefs are only
   * logged. A throw here would abort the message handler for a frame nothing
   * depends on.
   */
  it("survives a malformed preferences frame instead of throwing", () => {
    const payload = Array.from(new TextEncoder().encode("{not json"));
    expect(() => decodeServerFrame(buffer(0x32, ...payload))).not.toThrow();
    expect(decodeServerFrame(buffer(0x32, ...payload))).toEqual({
      type: "prefs",
      prefs: null,
      raw: "{not json",
    });
  });

  /**
   * Treating an unrecognised frame as output would paint whatever control
   * bytes a future ttyd invented straight onto the screen.
   */
  it("reports an unknown type byte as unknown, not as output", () => {
    const frame = decodeServerFrame(buffer(0x39, 0x41));
    expect(frame).toEqual({ type: "unknown", code: 0x39, payload: Uint8Array.from([0x41]) });
    expect(frame?.type).not.toBe("output");
  });

  /** The direction collision, seen from both ends: '0' out is input, '0' back is output. */
  it("reads back an INPUT frame's own bytes as an OUTPUT payload", () => {
    const frame = decodeServerFrame(encodeInput("echo hi").buffer);
    expect(frame?.type).toBe("output");
    expect(new TextDecoder().decode((frame as { payload: Uint8Array }).payload)).toBe("echo hi");
  });
});

describe("the ttyd endpoints", () => {
  const args = "arg=demo&arg=default&arg=default&arg=bob";

  it("asks for the tty subprotocol, which ttyd requires", () => {
    expect(WS_SUBPROTOCOL).toBe("tty");
  });

  /**
   * /token issues the credential for the socket that follows, so a difference
   * between the two queries attaches a socket the token was not issued for —
   * on a shared attach that is somebody else's session.
   */
  it("gives /token and /ws the identical argument string", () => {
    expect(tokenUrl("", args)).toBe("/token?" + args);
    expect(socketUrl({ protocol: "https:", host: "tl.example" }, "", args)).toBe(
      "wss://tl.example/ws?" + args,
    );
  });

  it("upgrades to wss on an https page and stays ws on http", () => {
    expect(wsScheme("https:")).toBe("wss:");
    expect(wsScheme("http:")).toBe("ws:");
    expect(socketUrl({ protocol: "http:", host: "localhost:7681" }, "", args)).toBe(
      "ws://localhost:7681/ws?" + args,
    );
  });

  it("keeps a sub-path base in front of both endpoints", () => {
    expect(tokenUrl("/sub", args)).toBe("/sub/token?" + args);
    expect(socketUrl({ protocol: "https:", host: "tl.example" }, "/sub", args)).toBe(
      "wss://tl.example/sub/ws?" + args,
    );
  });
});
