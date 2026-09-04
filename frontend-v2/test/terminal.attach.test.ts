/**
 * The socket-owning half of the native terminal.
 *
 * `attach` makes no decisions — it carries out what `reconnect.ts` returns — so
 * what is worth pinning here is exactly the wiring that a pure reducer cannot
 * express: that the ladder's actions reach real timers and a real socket, that
 * a superseded attempt cannot speak, and that `/token` failing takes the rung
 * term.html takes rather than opening a socket with no credential.
 *
 * Everything is injected, so this runs with no browser, no network and no
 * clock.
 */
import { describe, it, expect, vi } from "vitest";
import { attach, type AttachDeps, type Attachment } from "../src/terminal/attach";
import { STABLE_AFTER_MS } from "../src/terminal/reconnect";
import { WS_SUBPROTOCOL } from "../src/terminal/wire";

/** A WebSocket that never touches the network and can be driven from a test. */
class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public protocol: string,
  ) {
    FakeSocket.made.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Drive the open handshake the way a real socket would. */
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

interface Harness {
  deps: AttachDeps;
  timers: { fn: () => void; ms: number; id: number }[];
  runTimer: (id?: number) => void;
  phases: string[];
  written: Uint8Array[];
}

function harness(over: Partial<AttachDeps> = {}): Harness {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const phases: string[] = [];
  const written: Uint8Array[] = [];
  let nextId = 1;
  const deps: AttachDeps = {
    base: "",
    args: "arg=demo",
    page: { protocol: "https:", host: "lobby.example" },
    write: (b) => void written.push(b),
    size: () => ({ cols: 80, rows: 24 }),
    onPhase: (p) => void phases.push(p),
    fetch: (async () => ({ json: async () => ({ token: "tok" }) })) as unknown as typeof fetch,
    makeSocket: (url, protocol) => new FakeSocket(url, protocol) as unknown as WebSocket,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    ...over,
  };
  return {
    deps,
    timers,
    phases,
    written,
    runTimer: (id) => {
      const t = id === undefined ? timers.shift() : timers.splice(timers.findIndex((x) => x.id === id), 1)[0];
      t?.fn();
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("attaching a terminal", () => {
  it("asks for a token and opens a socket carrying the SAME args", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({
      fetch: (async (u: string) => {
        seen.push(String(u));
        return { json: async () => ({ token: "tok" }) };
      }) as unknown as typeof fetch,
    });
    const a = attach(h.deps);
    await flush();
    expect(seen).toEqual(["/token?arg=demo"]);
    // A flag on one and not the other attaches a socket the token was not
    // issued for — wire.ts says so at tokenUrl, so it is pinned here.
    expect(FakeSocket.made[0]!.url).toBe("wss://lobby.example/ws?arg=demo");
    expect(FakeSocket.made[0]!.protocol).toBe(WS_SUBPROTOCOL);
    a.dispose();
  });

  it("sends the handshake with the terminal's real size the moment it opens", async () => {
    FakeSocket.made = [];
    const h = harness({ size: () => ({ cols: 132, rows: 43 }) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    expect(JSON.parse(FakeSocket.made[0]!.sent[0] as string)).toEqual({
      AuthToken: "tok",
      columns: 132,
      rows: 43,
    });
    a.dispose();
  });

  it("writes server output through to the terminal", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    // '0' is MSG_OUTPUT; the rest is the payload.
    // An ArrayBuffer, which is what a socket with binaryType="arraybuffer"
    // actually delivers — not a view, which would test a path production
    // never takes.
    s.onmessage?.({ data: new TextEncoder().encode("0hello").buffer } as MessageEvent);
    expect(new TextDecoder().decode(h.written[0])).toBe("hello");
    a.dispose();
  });

  /**
   * The failure term.html's `.catch` handles: a /token that answers JSON `null`
   * (or a 404's HTML body) must NOT become a socket opened with no credential.
   * It takes a rung on the ladder instead.
   */
  it("takes a rung instead of opening a socket when /token does not answer", async () => {
    FakeSocket.made = [];
    const h = harness({
      fetch: (async () => ({ json: async () => null })) as unknown as typeof fetch,
    });
    const a = attach(h.deps);
    await flush();
    expect(FakeSocket.made).toHaveLength(0);
    expect(h.timers.length).toBeGreaterThan(0); // a retry is armed
    a.dispose();
  });

  it("climbs the ladder when a socket drops, and reconnects on the timer", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    FakeSocket.made[0]!.drop();
    // The ladder's first rung, identified by its delay rather than by counting
    // every timer — the liveness watchdog arms one of its own on open, and this
    // test is about the retry.
    const retry = h.timers.find((t) => t.ms > 0 && t.ms <= 2000);
    expect(retry, "a retry is armed on the ladder's first rung").toBeTruthy();
    h.runTimer(retry!.id);
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
    a.dispose();
  });

  /**
   * A socket abandoned mid-handshake still fires its close. Without the
   * generation check that close would knock the attempt that REPLACED it off
   * the ladder — the bug the generation exists for.
   */
  it("ignores a superseded socket's close", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const first = FakeSocket.made[0]!;
    a.reconnect(); // abandons the first attempt and starts another
    await flush();
    expect(FakeSocket.made.length).toBe(2);
    const before = h.timers.length;
    first.drop(); // the abandoned socket speaks up
    expect(h.timers.length).toBe(before); // nothing was scheduled off it
    a.dispose();
  });

  it("reconnects from a phase the automatic ladder would not, because it was tapped", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    expect(a.state().phase).toBe("open");
    a.reconnect();
    await flush();
    expect(FakeSocket.made).toHaveLength(2);
    a.dispose();
  });

  it("does not type into a socket that is not open", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    a.send("ls"); // still CONNECTING
    expect(s.sent).toHaveLength(0);
    s.open();
    a.send("ls");
    expect(s.sent).toHaveLength(2); // the handshake, then the keystroke
    a.dispose();
  });

  it("lets go of every timer and the socket on dispose", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    a.dispose();
    expect(FakeSocket.made[0]!.closed).toBe(true);
    expect(h.timers).toHaveLength(0);
    // and it is inert afterwards: a late drop must not resurrect anything
    FakeSocket.made[0]!.drop();
    expect(h.timers).toHaveLength(0);
  });

  /**
   * The watchdog only judges an OPEN socket, so it starts when one opens and
   * stops when it goes. Without the stop, a probe timer outlives its socket and
   * fires against nothing.
   */
  it("starts the liveness watchdog on open and drops it with the socket", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const beforeOpen = h.timers.length;
    FakeSocket.made[0]!.open();
    const probe = h.timers.find((t) => t.ms >= 20_000);
    expect(probe, "a probe is armed once the socket is open").toBeTruthy();
    expect(h.timers.length).toBeGreaterThan(beforeOpen);
    a.dispose();
    expect(h.timers).toHaveLength(0);
  });

  /**
   * A hidden tab holding a socket keeps the radio warm for nobody, and a tab
   * opened into the BACKGROUND never fires visibilitychange — term.html arms the
   * countdown at boot for exactly that case, so this must too.
   */
  it("arms the battery countdown for a tab that boots hidden", async () => {
    FakeSocket.made = [];
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      const h = harness();
      const a = attach(h.deps);
      await flush();
      const grace = h.timers.find((t) => t.ms === 60_000);
      expect(grace, "the 60s hidden countdown is armed at boot").toBeTruthy();
      a.dispose();
    } finally {
      hidden.mockRestore();
    }
  });

  /**
   * A read-only viewer must not type into someone else's session — and must not
   * have keys HELD either, because a hold is a promise to replay and read-only
   * attach can never deliver it. term.html drops at the top of sendInput, above
   * the branch that would have offered them; this drops at the same place.
   */
  it("drops a watcher's keystrokes without sending or holding them", async () => {
    FakeSocket.made = [];
    const verdicts: string[] = [];
    const h = harness({ watch: () => true, onHeld: (_s, v) => void verdicts.push(v) });
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    const afterHandshake = s.sent.length;
    a.send("rm -rf /");
    expect(s.sent).toHaveLength(afterHandshake); // nothing reached the pty
    expect(verdicts).toEqual(["refused:watching"]);
    a.dispose();
  });

  /**
   * Typing into a gap is the case offline typing exists for: the keystrokes are
   * held, drawn, and replayed when a socket comes back — rather than vanishing
   * into a terminal that looked alive.
   */
  it("holds what was typed while the socket was down, and replays it on reconnect", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const first = FakeSocket.made[0]!;
    first.open();
    first.drop(); // the socket is gone; the ladder is climbing

    a.send("echo hi");
    expect(FakeSocket.made).toHaveLength(1); // nowhere to send it

    const retry = h.timers.find((t) => t.ms > 0 && t.ms <= 2000);
    h.runTimer(retry!.id);
    await flush();
    const second = FakeSocket.made[1]!;
    second.open();
    // Nothing replays on `open` alone: ttyd drops what arrives before the
    // process is spawned, so the hold waits for the first OUTPUT frame, which is
    // the only proof there is a pty to receive it.
    expect(second.sent.slice(1)).toHaveLength(0);

    second.onmessage?.({ data: new TextEncoder().encode("0ready").buffer } as MessageEvent);
    const replayed = second.sent.slice(1).map((b) => new TextDecoder().decode(b as Uint8Array));
    expect(replayed.join("")).toContain("echo hi");
    a.dispose();
  });

  it("reports phase changes so the shell's badge can follow them", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    expect(h.phases).toContain("open");
    a.dispose();
  });
});
/**
 * Mouse reporting, the SECOND pty-bound path (term.html:8361-8370).
 *
 * xterm hands these over on `onBinary` as a string whose char codes ARE the
 * bytes, so the frame carries one byte per char. The UTF-8 encoder behind
 * `send` would turn every value >= 0x80 into two and desync the escape
 * sequence the server is parsing, which is why wire.ts keeps two encoders and
 * why the attachment needs a second method rather than a flag on the first.
 */
describe("sending a mouse report", () => {
  /** The bytes `onBinary` means its string to be read as: one per char. */
  const wireBytes = (s: string): number[] =>
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

  const SGR_PRESS = "\x1b[<0;10;5M";

  /** xterm's DEFAULT encoding: CSI M, then the button and both coords plus 32. */
  const x10 = (button: number, col: number, row: number): string =>
    "\x1b[M" + String.fromCharCode(button + 32, col + 32, row + 32);

  /**
   * Real reports, from the encodings xterm can produce: its CoreMouseService
   * builds DEFAULT, SGR and SGR_PIXELS, and all three start with ESC. DEFAULT
   * is the high-byte case, because a click past column 95 carries a byte
   * >= 0x80 (past 223 xterm drops the report rather than encoding it). The last
   * row is not a report at all, only the boundary bytes, since which of the two
   * encoders ran is what is being pinned.
   */
  const REPORTS: [string, string][] = [
    ["a DEFAULT click at column 200, row 120", x10(0, 200, 120)],
    ["an SGR press", SGR_PRESS],
    ["an SGR wheel notch", "\x1b[<64;20;7M"],
    ["a payload of boundary bytes", String.fromCharCode(0x1b, 0x00, 0x7f, 0x80, 0xff)],
  ];

  it.each(REPORTS)("puts %s on the wire byte for byte", async (_what, report) => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    const before = s.sent.length; // the init handshake
    a.sendBinary(report);
    expect(s.sent).toHaveLength(before + 1);
    // 0x30 is MSG_INPUT; every byte after it is one char of the report.
    const frame = s.sent[before] as Uint8Array;
    expect(Array.from(frame)).toEqual([0x30, ...wireBytes(report)]);
    // The length alone catches the UTF-8 mistake, which `encodeInput` would
    // make on every char >= 0x80.
    expect(frame.length).toBe(report.length + 1);
    a.dispose();
  });

  /**
   * A socket that is not open takes the route `send` takes: the chunk goes to
   * the same hold, and the verdict goes to the component. term.html:8365-8367
   * calls the very `offerHeldInput` that sendInput calls, commented "same
   * contract as sendInput", and term-html.bridge.test.ts pins that both paths
   * reach it, each having had its own bare `if (!OPEN) return` once.
   *
   * Neither verdict queues anything. A report is not holdable, because it
   * starts with ESC and only the session can resolve a control byte, which is
   * also why the hold's UTF-8 replay never sees these bytes.
   */
  it.each([
    ["nothing has ever connected", false, "refused:no-session"],
    ["the socket dropped after one open", true, "refused:key"],
  ] as [string, boolean, string][])(
    "offers a report to the hold and sends nothing when %s",
    async (_what, openFirst, verdict) => {
      FakeSocket.made = [];
      const verdicts: string[] = [];
      const queued: string[] = [];
      const h = harness({
        onHeld: (state, v) => {
          queued.push(state.text);
          verdicts.push(v);
        },
      });
      const a = attach(h.deps);
      await flush();
      const s = FakeSocket.made[0]!;
      if (openFirst) {
        s.open();
        s.drop();
      }
      const before = s.sent.length;
      a.sendBinary(SGR_PRESS);
      expect(s.sent).toHaveLength(before);
      expect(verdicts).toEqual([verdict]);
      expect(queued).toEqual([""]); // nothing is waiting to be replayed
      a.dispose();
    },
  );

  /**
   * NO watch guard on this path, deliberately, copying term.onBinary
   * (term.html:8361-8370), which has none where sendInput does. tmux discards a
   * read-only client's reports anyway, and a watcher whose clicks stopped
   * reaching the pty would get a terminal that ignores the mouse with nothing
   * to explain it. wire.ts says so at `encodeBinaryInput`; this pins that the
   * attachment did not put one back around it.
   */
  it("sends a watcher's report, where the same watcher's keystroke is dropped", async () => {
    FakeSocket.made = [];
    const verdicts: string[] = [];
    const h = harness({ watch: () => true, onHeld: (_s, v) => void verdicts.push(v) });
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    const before = s.sent.length;
    a.send("rm -rf /");
    a.sendBinary(SGR_PRESS);
    expect(s.sent).toHaveLength(before + 1); // the report, and only the report
    expect(Array.from(s.sent[before] as Uint8Array)).toEqual([0x30, ...wireBytes(SGR_PRESS)]);
    expect(verdicts).toEqual(["refused:watching"]); // the keystroke, and only it
    a.dispose();
  });

  /**
   * The one delta from the page, pinned so it is not mistaken for parity. A
   * watcher's report on a DEAD socket reaches the shared hold, which checks the
   * watch gate first (held.ts, `HeldGates.watching`), so the verdict is
   * `refused:watching`. term.html reaches `refused:key` there instead, because
   * validWatch is tested in sendInput and not in onBinary. Both refuse, nothing
   * goes out either way, and no byte on the wire differs.
   */
  it("refuses a watcher's report on a dead socket as watch mode, not as a key", async () => {
    FakeSocket.made = [];
    const verdicts: string[] = [];
    const h = harness({ watch: () => true, onHeld: (_s, v) => void verdicts.push(v) });
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    s.drop();
    const before = s.sent.length;
    a.sendBinary(SGR_PRESS);
    expect(s.sent).toHaveLength(before);
    expect(verdicts).toEqual(["refused:watching"]);
    a.dispose();
  });

  /**
   * The binary path does not arm the echo watch. `sendInput` ends with
   * armEchoWatch() (term.html:8298) and term.onBinary has no equivalent
   * (term.html:8361-8370). A drag or a wheel spin is a burst of reports the pty
   * need not answer at all, so arming one per report would ask the watchdog for
   * probes the socket has not earned.
   *
   * Visible in the timer the watchdog arms next. An unanswered keystroke pulls
   * the next probe in to `echoGraceMs` after it (1500, so 1400 left at +100ms);
   * the cadence alone leaves it at `probeMs` from the open (25000, so 24900).
   */
  it.each([
    ["a keystroke", 1_400, (a: Attachment) => a.send("x")],
    ["a mouse report", 24_900, (a: Attachment) => a.sendBinary(SGR_PRESS)],
  ] as [string, number, (a: Attachment) => void][])(
    "%s leaves the next probe %i ms out",
    async (_what, dueInMs, act) => {
      FakeSocket.made = [];
      let now = 1_000;
      const h = harness({ now: () => now });
      const a = attach(h.deps);
      await flush();
      FakeSocket.made[0]!.open();
      const cadence = h.timers.find((t) => t.ms === 25_000);
      expect(cadence, "the cadence probe is armed on open").toBeTruthy();
      act(a);
      now += 100;
      h.runTimer(cadence!.id); // the watchdog re-reads and re-arms
      expect(h.timers.map((t) => t.ms)).toContain(dueInMs);
      a.dispose();
    },
  );
});
/**
 * `navigator.onLine === false`, the browser saying there is no path.
 *
 * An own property shadowing jsdom's prototype getter, deleted again by the
 * restore it returns: `onLine` is defined on Navigator.prototype, so assigning
 * to it does nothing.
 */
function noNetworkPath(): () => void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  return () => void Reflect.deleteProperty(navigator, "onLine");
}

/**
 * Answering "what are you doing right now" (term.html:9822-9832).
 *
 * `onPhase` fires on a CHANGE, which is what keeps the badge from repainting
 * on every probe, and it means a terminal that has been open for ten minutes
 * has said nothing for ten minutes. The ADR-0016 panel's Run check and a
 * session view coming back on screen both ask on demand instead.
 *
 * The page answers by clearing its dedupe and asking `currentConnState()` for
 * the state FRESH, so the answer is derived rather than replayed, and the first
 * two things it derives from are the battery pause (:9827) and
 * `navigator.onLine` (:9828), both ahead of the socket (:9829).
 *
 * The reading must not repair what it measures: the broken state a person came
 * to look at has to still be there afterwards (ADR-0016, "The check reads; the
 * repairs are separate taps"), so what this does NOT do is as much of the
 * contract as what it reports.
 */
describe("reporting the current phase on demand", () => {
  it("re-fires onPhase even though nothing changed", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p, n) => void seen.push(`${p}:${n}`) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    expect(seen).toEqual(["connecting:1", "open:1"]);
    a.reportNow();
    expect(seen).toEqual(["connecting:1", "open:1", "open:1"]);
    a.dispose();
  });

  /**
   * THE NUMBER THE BADGE SHOWS is the attempt the pending retry WILL run, not
   * the count of attempts already started. term.html paints `connAttempts + 1`
   * in `scheduleReconnect` (:9877) and in `reconnectAfterDrop` (:10155), and
   * `connect()` increments the counter before painting it (:10231-10232), so
   * the number holds still when the attempt it names starts. Reporting the
   * counter instead reads one behind for the whole wait and then steps 1 to 2
   * at the moment the timer fires.
   */
  it("carries the attempt the pending retry will run, and holds it", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p, n) => void seen.push(`${p}:${n}`) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    FakeSocket.made[0]!.drop();
    seen.length = 0;
    a.reportNow();
    expect(seen).toEqual(["waiting:2"]); // the wait (term.html:10155)
    const retry = h.timers.find((t) => t.ms > 0 && t.ms <= 2000);
    h.runTimer(retry!.id);
    await flush();
    seen.length = 0;
    a.reportNow();
    expect(seen).toEqual(["connecting:2"]); // the same attempt, now running
    a.dispose();
  });

  /**
   * THE FROZEN TERMINAL, which is the case ADR-0016 exists for. A wifi drop
   * flips `navigator.onLine` at once while the socket stays readyState OPEN
   * until the watchdog gives up, which liveness.ts puts at ~50s
   * (`strikes: 3`, `probeMs: 25_000`). Nothing in that window changes phase, so
   * the change path is silent and the ask is the only thing that can answer.
   *
   * term.html answers offline there, because `currentConnState` tests
   * `navigator.onLine === false` at :9828 BEFORE `ws.readyState === OPEN` at
   * :9829. The status model's `offline` is derived by the shell, which reads the
   * browser itself for every phase that is not open, suspended or ended
   * (TerminalNative.tsx, `report`), so what this file has to get right is that
   * the answer is not `open`.
   */
  it("does not answer open while the browser says there is no path", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p, n) => void seen.push(`${p}:${n}`) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    const restore = noNetworkPath();
    try {
      window.dispatchEvent(new Event("offline")); // the wifi drop
      seen.length = 0;
      a.reportNow();
      expect(seen).toEqual(["connecting:1"]);
      // And the reading changed nothing: the socket is still open and the
      // ladder is still on the phase it was in.
      expect(a.state().phase).toBe("open");
      expect(FakeSocket.made).toHaveLength(1);
      expect(FakeSocket.made[0]!.closed).toBe(false);
    } finally {
      restore();
      a.dispose();
    }
  });

  /**
   * Derived from the browser, not from the ladder's mirror of it. Some
   * platforms never fire `online`/`offline` at all (reconnect.ts, "OFFLINE IS A
   * PARK, NOT A RUNG"), so a ladder whose `online` still reads true must not
   * make the ask answer open.
   */
  it("reads the browser even when no offline event ever arrived", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p, n) => void seen.push(`${p}:${n}`) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    const restore = noNetworkPath();
    try {
      seen.length = 0;
      a.reportNow();
      expect(a.state().online).toBe(true); // nothing told the ladder
      expect(seen).toEqual(["connecting:1"]);
    } finally {
      restore();
      a.dispose();
    }
  });

  /**
   * ORDER, which is the whole of term.html:9827-9828: the battery pause is
   * tested before the network. A phone put down with the wifi off is paused,
   * and the status model paints a deliberate pause as working ("paused to save
   * battery", ADR-0016) where offline is down.
   */
  it("answers suspended, not offline, for a paused tab with no network path", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    let now = 1_000;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const restore = noNetworkPath();
    try {
      const h = harness({ now: () => now, onPhase: (p, n) => void seen.push(`${p}:${n}`) });
      const a = attach(h.deps);
      await flush();
      const grace = h.timers.find((t) => t.ms === 60_000);
      now += 60_000;
      h.runTimer(grace!.id); // the tab has been hidden long enough
      expect(a.state().phase).toBe("suspended");
      seen.length = 0;
      a.reportNow();
      expect(seen).toEqual(["suspended:1"]);
      a.dispose();
    } finally {
      restore();
      hidden.mockRestore();
    }
  });

  /**
   * A wait goes out as a wait, because it already answers offline: the shell
   * reads the browser for every phase that is not open, suspended or ended
   * (TerminalNative.tsx, `report`), so only `open` needs replacing and only
   * `open` is replaced. The two answers agree on the state a person is shown,
   * which is the same one term.html gives when :9828 short-circuits the socket
   * test below it.
   *
   * The attempt number rides along either way, which is how the badge shows a
   * climbing ladder (`reportConn(currentConnState(), connAttemptShown)`,
   * :9824).
   */
  it("hands a wait to the shell as a wait, no-path or not", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p, n) => void seen.push(`${p}:${n}`) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    FakeSocket.made[0]!.drop();
    const restore = noNetworkPath();
    try {
      seen.length = 0;
      a.reportNow();
      expect(seen).toEqual(["waiting:2"]);
    } finally {
      restore();
      a.dispose();
    }
  });

  it("opens nothing, sends nothing and closes nothing", async () => {
    FakeSocket.made = [];
    const h = harness();
    const a = attach(h.deps);
    await flush();
    const s = FakeSocket.made[0]!;
    s.open();
    const sent = s.sent.length;
    const timers = h.timers.length;
    a.reportNow();
    expect(FakeSocket.made).toHaveLength(1);
    expect(s.sent).toHaveLength(sent);
    expect(s.closed).toBe(false);
    expect(h.timers).toHaveLength(timers);
    a.dispose();
  });

  /**
   * A disposed attachment has already handed the shell its `closed`
   * (TerminalNative's onCleanup), so re-reporting the phase it died in would
   * contradict that handover and leave the badge describing a terminal that is
   * gone. `dispatch` bails on `disposed` for the same reason.
   */
  it("stays silent once disposed", async () => {
    FakeSocket.made = [];
    const seen: string[] = [];
    const h = harness({ onPhase: (p) => void seen.push(p) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    a.dispose();
    seen.length = 0;
    a.reportNow();
    expect(seen).toEqual([]);
  });
});

/**
 * ONCE PER ATTACH, which is a different question from the phase.
 *
 * term.html has two calls inside `ws.onopen` and on no other path to an open
 * connection: `mirrorLineReset()` at :10293 and `cancelScrollMomentum()` at
 * :10294. Neither is among its other nine `mirrorLineReset` sites, and neither
 * is in `reportConnNow` (:9822-9824). `onPhase("open")` cannot stand in for
 * that signal, and the two routes below are why: a caller that hung the mirror
 * reset off the phase blanked the compose field on a session view coming back
 * on screen, and again 30 seconds after every connect.
 */
describe("the once-per-attach signal (term.html:10293-10294)", () => {
  it("fires once when the socket opens", async () => {
    FakeSocket.made = [];
    let attaches = 0;
    const h = harness({ onAttach: () => void attaches++ });
    const a = attach(h.deps);
    await flush();
    expect(attaches).toBe(0); // connecting is not attached
    FakeSocket.made[0]!.open();
    expect(attaches).toBe(1);
    a.dispose();
  });

  /**
   * BEFORE the phase goes out, which is term.html's order: :10293-10294 sit
   * above `reportConn('open', 0)` at :10296. The mirror's baseline has to drop
   * before anything downstream acts on the new connection.
   */
  it("fires ahead of the open phase", async () => {
    FakeSocket.made = [];
    const order: string[] = [];
    const h = harness({
      onAttach: () => void order.push("attach"),
      onPhase: (p) => void order.push(`phase:${p}`),
    });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    expect(order).toEqual(["phase:connecting", "attach", "phase:open"]);
    a.dispose();
  });

  /**
   * AN ASK IS NOT AN ATTACH. `reportNow` calls `deps.onPhase` directly, and
   * `askedPhase()` answers "open" for an open socket, so the phase repeats
   * while the socket is the same one. SessionView asks every time a session
   * comes back on screen, so this is the frequent route.
   */
  it("says nothing on an ask", async () => {
    FakeSocket.made = [];
    let attaches = 0;
    const seen: string[] = [];
    const h = harness({ onAttach: () => void attaches++, onPhase: (p) => void seen.push(p) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    seen.length = 0;
    a.reportNow();
    a.reportNow();
    expect(seen).toEqual(["open", "open"]); // the badge still gets its answer
    expect(attaches).toBe(1);
    a.dispose();
  });

  /**
   * NOR IS THE STABILITY PROOF. `dispatch` counts an attempt-count change as a
   * phase change, and reconnect.ts's `proved-stable` returns `attempts: 0`
   * (:238) with the phase still "open" where `startAttempt` had bumped it to 1
   * (:446). So the phase repeats `STABLE_AFTER_MS` after every connect, on a
   * socket nobody touched.
   */
  it("says nothing when the connection proves stable", async () => {
    FakeSocket.made = [];
    let attaches = 0;
    const seen: string[] = [];
    const h = harness({ onAttach: () => void attaches++, onPhase: (p) => void seen.push(p) });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    seen.length = 0;
    const proof = h.timers.find((t) => t.ms === STABLE_AFTER_MS);
    if (!proof) throw new Error("no stability timer was armed");
    h.runTimer(proof.id);
    expect(seen).toEqual(["open"]); // the repeat this test exists to distinguish
    expect(attaches).toBe(1);
    a.dispose();
  });

  /** A reconnect IS an attach: a new socket means a new pty input line. */
  it("fires again for the socket a retry opens", async () => {
    FakeSocket.made = [];
    let attaches = 0;
    const h = harness({ onAttach: () => void attaches++ });
    const a = attach(h.deps);
    await flush();
    FakeSocket.made[0]!.open();
    FakeSocket.made[0]!.drop();
    const retry = h.timers.find((t) => t.ms > 0 && t.ms <= 2000);
    if (!retry) throw new Error("no retry was scheduled");
    h.runTimer(retry.id);
    await flush();
    FakeSocket.made[1]!.open();
    expect(attaches).toBe(2);
    a.dispose();
  });
});
