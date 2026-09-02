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
import { attach, type AttachDeps } from "../src/terminal/attach";
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
