/**
 * The lobby's end of a session browser's viewer stream (lib/browser-stream.ts):
 * it connects only while somebody can see the picture, never wakes a frozen
 * browser for a card, follows the tab it is pointed at, and keeps a card's last
 * frame in memory after the stream closes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createBrowserStream,
  keptFrame,
  type BrowserStream,
  type WebSocketLike,
} from "../src/lib/browser-stream";

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  /** The server side. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  host(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const hello = (state: "live" | "frozen") => ({
  t: "hello",
  state,
  tabs: [{ id: "t1", url: "https://example.com/", title: "Example" }],
  agentTab: "t1",
  control: { holder: null, since: null, lapseAt: null },
  viewport: { w: 1280, h: 800 },
});

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

function mount(opts: {
  active: () => boolean;
  wake: boolean;
  tab?: () => string | null;
  keep?: string;
  owner?: string;
}): { stream: BrowserStream; dispose: () => void } {
  let stream!: BrowserStream;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    stream = createBrowserStream({
      session: "work",
      owner: opts.owner,
      active: opts.active,
      tab: opts.tab,
      wake: opts.wake,
      keep: opts.keep,
      socket: (url) => new FakeSocket(url),
    });
  });
  return { stream, dispose };
}

describe("the browser stream", () => {
  it("does not connect until it is active, and asks the session's own route", () => {
    const [active, setActive] = createSignal(false);
    const { dispose } = mount({ active, wake: true, owner: "emo" });
    expect(FakeSocket.all).toHaveLength(0);
    setActive(true);
    expect(FakeSocket.all).toHaveLength(1);
    const url = new URL(FakeSocket.all[0]!.url);
    expect(url.protocol).toMatch(/^wss?:$/);
    expect(url.pathname).toBe("/browser/work/stream");
    expect(url.searchParams.get("owner")).toBe("emo");
    dispose();
  });

  it("subscribes to the agent's tab once the host says hello, and shows its frames", () => {
    const { stream, dispose } = mount({ active: () => true, wake: true });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("live"));
    expect(ws.sent).toEqual([{ t: "subscribe", tab: null }]);
    expect(stream.tabs()).toHaveLength(1);
    expect(stream.agentTab()).toBe("t1");
    ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    expect(stream.frame()).toEqual({
      tab: "t1",
      src: "data:image/jpeg;base64,AAAA",
      w: 1280,
      h: 800,
    });
    dispose();
  });

  it("leaves a frozen browser asleep when it may not wake it, and subscribes once it is live", () => {
    const { stream, dispose } = mount({ active: () => true, wake: false });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("frozen"));
    expect(ws.sent).toEqual([]);
    expect(stream.state()).toBe("frozen");
    ws.host({ t: "state", state: "live" });
    expect(ws.sent).toEqual([{ t: "subscribe", tab: null }]);
    dispose();
  });

  it("wakes a frozen browser when it may (the panel)", () => {
    const { dispose } = mount({ active: () => true, wake: true });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("frozen"));
    expect(ws.sent).toEqual([{ t: "subscribe", tab: null }]);
    dispose();
  });

  it("follows the tab it is pointed at", () => {
    const [tab, setTab] = createSignal<string | null>(null);
    const { dispose } = mount({ active: () => true, wake: true, tab });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("live"));
    setTab("t2");
    expect(ws.sent.at(-1)).toEqual({ t: "subscribe", tab: "t2" });
    dispose();
  });

  it("stops the frames at once when it goes inactive, and lets the socket go a little later", () => {
    vi.useFakeTimers();
    const [active, setActive] = createSignal(true);
    const { dispose } = mount({ active, wake: true });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("live"));
    setActive(false);
    expect(ws.sent.at(-1)).toEqual({ t: "unsubscribe" });
    expect(ws.closed).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(ws.closed).toBe(true);
    dispose();
  });

  it("reconnects after a drop while active, and stops for good once the browser closed", () => {
    vi.useFakeTimers();
    const { stream, dispose } = mount({ active: () => true, wake: true });
    const first = FakeSocket.all[0]!;
    first.open();
    first.host(hello("live"));
    first.drop();
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1]!;
    second.open();
    second.host({ t: "state", state: "closed" });
    second.drop();
    expect(stream.state()).toBe("closed");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    dispose();
  });

  it("keeps the newest frame under its key after the stream is gone", () => {
    const { dispose } = mount({ active: () => true, wake: false, keep: "work|browser:run1" });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.host(hello("live"));
    ws.host({ t: "frame", tab: "t1", jpeg: "BBBB", w: 640, h: 400 });
    dispose();
    expect(keptFrame("work|browser:run1")?.src).toBe("data:image/jpeg;base64,BBBB");
    expect(keptFrame("work|browser:other")).toBeUndefined();
  });

  it("drops what it cannot send, and lines it cannot read", () => {
    const { stream, dispose } = mount({ active: () => true, wake: true });
    const ws = FakeSocket.all[0]!;
    stream.send({ t: "takeControl" }); // not open yet
    expect(ws.sent).toEqual([]);
    ws.open();
    ws.onmessage?.({ data: "not json" });
    ws.host({ t: "nonsense" });
    ws.host({ t: "control", holder: "viktor", since: 1, lapseAt: 2 });
    expect(stream.control()).toEqual({ holder: "viktor", since: 1, lapseAt: 2 });
    dispose();
  });
});
