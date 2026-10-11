import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "../src/lib/browser-stream";
import { createPresence, DRAFT_THROTTLE_MS } from "../src/store/presence";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe("createPresence", () => {
  let sockets: FakeSocket[];
  /** The n-th socket opened, which the test expects to exist. */
  const sock = (n: number): FakeSocket => {
    const s = sockets[n];
    if (!s) throw new Error(`no socket ${n}`);
    return s;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => vi.useRealTimers());

  const setup = (owner?: string) => {
    const [active, setActive] = createSignal(true);
    let dispose = () => {};
    const p = createRoot((d) => {
      dispose = d;
      return createPresence({
        session: () => "main",
        owner,
        active,
        socket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        now: () => Date.now(),
      });
    });
    return { p, setActive, dispose };
  };

  it("connects to the session's presence socket, naming a foreign owner", () => {
    const { dispose } = setup("alice");
    expect(sockets).toHaveLength(1);
    expect(sock(0).url).toMatch(/^ws:.*\/events\/main\/presence\?owner=alice$/);
    dispose();
    expect(sock(0).closed).toBe(true);
  });

  it("reads the room, this tab's id and the senders", () => {
    const { p, dispose } = setup();
    const s = sock(0);
    s.open();
    s.frame({ t: "hello", id: "me1" });
    s.frame({ t: "senders", senders: [{ text: "a", at: 1, user: "emo", name: "emo" }] });
    s.frame({ t: "room", now: Date.now() + 5000, people: [{ id: "me1", user: "wizard", name: "w", mode: "rw" }] });
    expect(p.myId()).toBe("me1");
    expect(p.people()).toHaveLength(1);
    expect(p.senders()).toHaveLength(1);
    s.frame({ t: "senders", senders: [{ text: "b", at: 2, user: "wizard", name: "w" }] });
    expect(p.senders().map((r) => r.text)).toEqual(["a", "b"]);
    // The server is 5 s ahead; its clock is what drafts are timed on.
    expect(p.serverNow() - Date.now()).toBe(5000);
    dispose();
  });

  it("throttles drafts, always sends the newest, and clears at once", () => {
    const { p, dispose } = setup();
    const s = sock(0);
    s.open();
    s.frame({ t: "hello", id: "me1" });
    p.setDraft("h");
    p.setDraft("he");
    p.setDraft("hel");
    expect(s.sent.map((m) => JSON.parse(m).text)).toEqual(["h"]);
    vi.advanceTimersByTime(DRAFT_THROTTLE_MS);
    expect(s.sent.map((m) => JSON.parse(m).text)).toEqual(["h", "hel"]);
    vi.advanceTimersByTime(DRAFT_THROTTLE_MS * 2);
    p.setDraft("");
    expect(JSON.parse(s.sent.at(-1) ?? "{}").text).toBe("");
    dispose();
  });

  it("reconnects after a drop and republishes the draft", () => {
    const { p, dispose } = setup();
    sock(0).open();
    sock(0).frame({ t: "hello", id: "a" });
    p.setDraft("half a thought");
    sock(0).close();
    expect(p.people()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sock(1).open();
    sock(1).frame({ t: "hello", id: "b" });
    expect(sock(1).sent.map((m) => JSON.parse(m).text)).toEqual(["half a thought"]);
    dispose();
  });

  it("disconnects while the session is off screen", () => {
    const { setActive, dispose } = setup();
    sock(0).open();
    setActive(false);
    expect(sock(0).closed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
    setActive(true);
    expect(sockets).toHaveLength(2);
    dispose();
  });
});
