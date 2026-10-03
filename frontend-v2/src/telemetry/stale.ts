/**
 * The stale watch: a Text view on screen whose stream has stopped delivering,
 * though it still shows rows.
 *
 * `text.blank` sees only a view with no rows. A view that shows the
 * conversation as it was and stops moving while Claude carries on in the
 * terminal is the other half of "the Text view shows nothing new", and it has
 * happened before: an SSE id belongs to one log, so a rebuilt log once froze a
 * reader silently (2026-08-28).
 *
 * "Claude is running and nothing arrived" cannot tell this apart from a long
 * tool call or a long think, during which nothing streams either. So the
 * server's heartbeat names the newest event it holds (session-events sse.go),
 * and the client compares: still behind the head of the PREVIOUS heartbeat
 * means events exist that never arrived (the newest head may be in flight
 * behind its own frame). An open stream that hears no heartbeat at all has
 * gone silent.
 */
import { createEffect, onCleanup, untrack, type Accessor } from "solid-js";
import type { TlAttrs, TlEvent } from "./track";

/** The last two heartbeat heads and when the newest arrived. */
export interface HeadInfo {
  head: number;
  prev: number;
  at: number;
}

/** Heartbeats come every 20 s (session-events -heartbeat); two and a half missed. */
export const SILENT_AFTER_MS = 50_000;

/** How often the silence check runs. */
const CHECK_MS = 5_000;

export type StaleEnd = "caught-up" | "left";

export interface StaleWatch {
  session: string;
  /** The Text view is on screen and the page is visible. */
  watching: Accessor<boolean>;
  head: Accessor<HeadInfo | null>;
  /** The newest event id the client holds. Need not be reactive. */
  cursor: () => number;
  /** The stream is open, rather than connecting or reconnecting. */
  open: Accessor<boolean>;
  /** Read when the stale view is reported. */
  attrs: () => TlAttrs;
  track: (name: TlEvent, attrs?: TlAttrs) => void;
}

export function watchStale(w: StaleWatch): void {
  /** When the current stale stretch began; 0 outside one. */
  let since = 0;
  /** When this visit began, which stands in for a heartbeat not yet heard. */
  let visitAt = 0;

  const report = (why: "behind" | "silent", extra: TlAttrs): void => {
    if (since !== 0) return;
    since = Date.now();
    untrack(() =>
      w.track("text.stale", { ...w.attrs(), ...extra, "tl.session": w.session, "tl.why": why }),
    );
  };

  const end = (why: StaleEnd): void => {
    if (since === 0) return;
    w.track("text.stale_ended", {
      "tl.session": w.session,
      "tl.why": why,
      "tl.ms": Date.now() - since,
    });
    since = 0;
  };

  createEffect(() => {
    if (!w.watching()) {
      end("left");
      visitAt = 0;
      return;
    }
    if (visitAt === 0) visitAt = Date.now();
    const h = w.head();
    if (!h) return;
    const cursor = untrack(w.cursor);
    if (cursor >= h.head) {
      end("caught-up");
      return;
    }
    if (h.prev > 0 && cursor < h.prev) report("behind", { "tl.gap": h.prev - cursor });
  });

  const timer = setInterval(() => {
    if (!untrack(w.watching) || !untrack(w.open)) return;
    const last = untrack(w.head)?.at ?? 0;
    const quietFor = Date.now() - Math.max(last, visitAt);
    if (quietFor >= SILENT_AFTER_MS) report("silent", { "tl.quiet_ms": quietFor });
  }, CHECK_MS);

  onCleanup(() => {
    clearInterval(timer);
    end("left");
  });
}
