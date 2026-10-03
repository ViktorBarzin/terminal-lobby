/**
 * The blank watch (CONTEXT.md "Blank"): a Text view on screen for two seconds
 * with no rows reports itself once per visit, with whatever the caller says
 * about the stream, and reports again when the blank ends and why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { watchBlank, BLANK_AFTER_MS } from "../src/telemetry/blank";
import type { TlAttrs } from "../src/telemetry/track";

type Sent = { name: string; attrs: TlAttrs };

function setup(initial: { watching?: boolean; drawn?: number; closed?: boolean } = {}) {
  const sent: Sent[] = [];
  const [watching, setWatching] = createSignal(initial.watching ?? true);
  const [drawn, setDrawn] = createSignal(initial.drawn ?? 0);
  const [closed, setClosed] = createSignal(initial.closed ?? false);
  const dispose = createRoot((d) => {
    watchBlank({
      session: "demo",
      watching,
      drawn,
      closed,
      attrs: () => ({ "tl.sse": "open", "tl.f_back": 0 }),
      track: (name, attrs = {}) => sent.push({ name, attrs }),
    });
    return d;
  });
  return { sent, setWatching, setDrawn, setClosed, dispose };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchBlank", () => {
  it("reports a view that stays empty on screen for two seconds", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS - 1);
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.name).toBe("text.blank");
    expect(h.sent[0]!.attrs).toMatchObject({
      "tl.session": "demo",
      "tl.ms": BLANK_AFTER_MS,
      "tl.sse": "open",
      "tl.f_back": 0,
    });
    h.dispose();
  });

  it("says nothing when rows arrive in time", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS / 2);
    h.setDrawn(3);
    vi.advanceTimersByTime(BLANK_AFTER_MS * 5);
    expect(h.sent).toEqual([]);
    h.dispose();
  });

  it("says nothing about a view nobody is looking at", () => {
    const h = setup({ watching: false });
    vi.advanceTimersByTime(BLANK_AFTER_MS * 5);
    expect(h.sent).toEqual([]);
    h.dispose();
  });

  it("reports the end when rows arrive, with the whole blank's length", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS + 3000);
    h.setDrawn(1);
    expect(h.sent.map((s) => s.name)).toEqual(["text.blank", "text.blank_ended"]);
    expect(h.sent[1]!.attrs).toMatchObject({
      "tl.session": "demo",
      "tl.why": "rows",
      "tl.ms": BLANK_AFTER_MS + 3000,
    });
    h.dispose();
  });

  it("reports the end when the person leaves", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    h.setWatching(false);
    expect(h.sent[1]).toMatchObject({ name: "text.blank_ended", attrs: { "tl.why": "left" } });
    h.dispose();
  });

  it("reports the end when the stream closes for good", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    h.setClosed(true);
    expect(h.sent[1]).toMatchObject({ name: "text.blank_ended", attrs: { "tl.why": "closed" } });
    h.dispose();
  });

  it("reports the end when the view goes away mid-blank", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    h.dispose();
    expect(h.sent[1]).toMatchObject({ name: "text.blank_ended", attrs: { "tl.why": "left" } });
  });

  it("counts a second visit as a second blank", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    h.setWatching(false);
    h.setWatching(true);
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    expect(h.sent.map((s) => s.name)).toEqual(["text.blank", "text.blank_ended", "text.blank"]);
    h.dispose();
  });

  it("reports once per visit however long it lasts", () => {
    const h = setup();
    vi.advanceTimersByTime(BLANK_AFTER_MS * 30);
    expect(h.sent.map((s) => s.name)).toEqual(["text.blank"]);
    h.dispose();
  });
});

/**
 * The view draws rows progressively, so what is on screen is read from the
 * DOM, which is not reactive. The watch re-reads it rather than waiting to be
 * told: this is the case that separates "nothing arrived" from "it arrived and
 * was never drawn".
 */
describe("watchBlank over a count nothing announces", () => {
  it("reports and ends against a plain getter", () => {
    const sent: Sent[] = [];
    let drawn = 0;
    const dispose = createRoot((d) => {
      watchBlank({
        session: "demo",
        watching: () => true,
        drawn: () => drawn,
        closed: () => false,
        attrs: () => ({}),
        track: (name, attrs = {}) => sent.push({ name, attrs }),
      });
      return d;
    });
    vi.advanceTimersByTime(BLANK_AFTER_MS);
    expect(sent.map((s) => s.name)).toEqual(["text.blank"]);
    drawn = 4;
    vi.advanceTimersByTime(1000);
    expect(sent.map((s) => s.name)).toEqual(["text.blank", "text.blank_ended"]);
    expect(sent[1]!.attrs["tl.why"]).toBe("rows");
    dispose();
  });

  it("does not report rows drawn before the two seconds are up", () => {
    const sent: Sent[] = [];
    let drawn = 0;
    const dispose = createRoot((d) => {
      watchBlank({
        session: "demo",
        watching: () => true,
        drawn: () => drawn,
        closed: () => false,
        attrs: () => ({}),
        track: (name, attrs = {}) => sent.push({ name, attrs }),
      });
      return d;
    });
    vi.advanceTimersByTime(BLANK_AFTER_MS / 2);
    drawn = 2;
    vi.advanceTimersByTime(BLANK_AFTER_MS * 5);
    expect(sent).toEqual([]);
    dispose();
  });
});
