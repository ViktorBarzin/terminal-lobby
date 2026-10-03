/**
 * The stale watch: a Text view on screen whose stream has stopped delivering,
 * though it still shows rows. The server's heartbeat names its newest event; a
 * client still behind the head a heartbeat ago has missed events, and one that
 * hears no heartbeat at all has a stream that went silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { watchStale, SILENT_AFTER_MS, type HeadInfo } from "../src/telemetry/stale";
import type { TlAttrs } from "../src/telemetry/track";

type Sent = { name: string; attrs: TlAttrs };

function setup() {
  const sent: Sent[] = [];
  const [watching, setWatching] = createSignal(true);
  const [head, setHead] = createSignal<HeadInfo | null>(null);
  const [open, setOpen] = createSignal(true);
  let cursor = 0;
  const dispose = createRoot((d) => {
    watchStale({
      session: "demo",
      watching,
      head,
      cursor: () => cursor,
      open,
      attrs: () => ({ "tl.sse": "open" }),
      track: (name, attrs = {}) => sent.push({ name, attrs }),
    });
    return d;
  });
  const beat = (h: number) => setHead((p) => ({ head: h, prev: p?.head ?? 0, at: Date.now() }));
  return {
    sent,
    beat,
    setWatching,
    setOpen,
    setCursor: (c: number) => {
      cursor = c;
    },
    dispose,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchStale", () => {
  it("says nothing while the client keeps up", () => {
    const h = setup();
    h.setCursor(10);
    h.beat(10);
    h.beat(10);
    h.setCursor(12);
    h.beat(12);
    expect(h.sent).toEqual([]);
    h.dispose();
  });

  it("forgives a head that moved during the last heartbeat", () => {
    const h = setup();
    h.setCursor(10);
    h.beat(10);
    h.beat(14); // 11..14 may still be in flight behind this frame
    expect(h.sent).toEqual([]);
    h.dispose();
  });

  it("reports a client still behind the previous heartbeat's head", () => {
    const h = setup();
    h.setCursor(10);
    h.beat(14);
    h.beat(14);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      name: "text.stale",
      attrs: { "tl.session": "demo", "tl.why": "behind", "tl.gap": 4, "tl.sse": "open" },
    });
    h.dispose();
  });

  it("ends when the client catches up, with how long it was behind", () => {
    const h = setup();
    h.setCursor(10);
    h.beat(14);
    h.beat(14);
    vi.advanceTimersByTime(20_000);
    h.setCursor(14);
    h.beat(14);
    expect(h.sent.map((s) => s.name)).toEqual(["text.stale", "text.stale_ended"]);
    expect(h.sent[1]!.attrs).toMatchObject({ "tl.why": "caught-up", "tl.ms": 20_000 });
    h.dispose();
  });

  it("reports an open stream that hears no heartbeat", () => {
    const h = setup();
    h.beat(3);
    h.setCursor(3);
    vi.advanceTimersByTime(SILENT_AFTER_MS + 5_000);
    expect(h.sent[0]).toMatchObject({ name: "text.stale", attrs: { "tl.why": "silent" } });
    h.dispose();
  });

  it("does not call a stream that is reconnecting silent", () => {
    const h = setup();
    h.setOpen(false);
    vi.advanceTimersByTime(SILENT_AFTER_MS * 3);
    expect(h.sent).toEqual([]);
    h.dispose();
  });

  it("does not judge a view nobody is looking at, and ends a stale one when they leave", () => {
    const h = setup();
    h.setCursor(1);
    h.beat(5);
    h.beat(5);
    h.setWatching(false);
    expect(h.sent.map((s) => s.name)).toEqual(["text.stale", "text.stale_ended"]);
    expect(h.sent[1]!.attrs["tl.why"]).toBe("left");
    h.beat(9);
    h.beat(9);
    vi.advanceTimersByTime(SILENT_AFTER_MS * 3);
    expect(h.sent).toHaveLength(2);
    h.dispose();
  });

  it("reports once per stale stretch", () => {
    const h = setup();
    h.setCursor(1);
    h.beat(5);
    h.beat(5);
    h.beat(6);
    h.beat(7);
    expect(h.sent.map((s) => s.name)).toEqual(["text.stale"]);
    h.dispose();
  });
});
