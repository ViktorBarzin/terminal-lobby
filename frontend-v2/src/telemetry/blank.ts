/**
 * The blank watch: a Text view on screen with no rows, reported as an event.
 *
 * Viktor reported on 2026-10-03 that the Text view showed nothing for most
 * sessions on his iPhone while the terminal worked, and nothing in the journal
 * said so. `text.first_paint` fires `count: 0` whenever its 2.5 s hold timer
 * runs out, including for streams that were never asked to open, so most of
 * its zero counts are noise. This one fires only when a person is looking at
 * an empty view (CONTEXT.md "Blank"), once per visit, and carries what the
 * caller knows about the stream so the event names its own cause.
 *
 * `drawn` is read from the DOM, which announces nothing, so it is re-read on a
 * timer as well as tracked: that is the reading that tells "nothing arrived"
 * from "it arrived and was never drawn".
 */
import { createEffect, onCleanup, untrack, type Accessor } from "solid-js";
import type { TlAttrs, TlEvent } from "./track";

/** What decides a blank's cause. */
export interface BlankFacts {
  tool: string;
  sse: string;
  starting: boolean;
  noMod: boolean;
  exited: boolean;
  /** `ready` frames received: the server has said where the opening window ends. */
  ready: number;
  /** Events the store holds. */
  events: number;
}

export type BlankCause =
  | "shell"
  | "no-stream"
  | "exited"
  | "nomod"
  | "starting"
  | "not-drawn"
  | "empty"
  | "not-arrived";

/**
 * Why a view is blank, as one field (tl.cause). The first five are expected:
 * the view says so on screen. `empty` is a conversation with nothing in it
 * yet. `not-drawn` (events held, none on screen) and `not-arrived` (no window
 * yet) are the ones to look at.
 */
export function blankCause(f: BlankFacts): BlankCause {
  if (f.tool === "shell") return "shell";
  if (f.sse === "no-transcript") return "no-stream";
  if (f.noMod) return f.exited ? "exited" : "nomod";
  if (f.starting) return "starting";
  if (f.events > 0) return "not-drawn";
  if (f.ready > 0) return "empty";
  return "not-arrived";
}

/** How long a view may sit empty on screen before it counts as blank. */
export const BLANK_AFTER_MS = 2000;

/** How often a reported blank re-reads the row count to see it end. */
const RECHECK_MS = 1000;

export type BlankEnd = "rows" | "left" | "closed";

export interface BlankWatch {
  session: string;
  /** The Text view is on screen and the page is visible. */
  watching: Accessor<boolean>;
  /** Rows drawn in the view. Need not be reactive. */
  drawn: Accessor<number>;
  /** The stream has been closed for the last time. */
  closed: Accessor<boolean>;
  /** Read when the blank is reported: the stream's state, frame counts, page context. */
  attrs: () => TlAttrs;
  track: (name: TlEvent, attrs?: TlAttrs) => void;
}

export function watchBlank(w: BlankWatch): void {
  /** When the current visit began; 0 outside one. */
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let reported = false;

  const stopTimers = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (recheck !== undefined) clearInterval(recheck);
    timer = undefined;
    recheck = undefined;
  };

  const end = (why: BlankEnd): void => {
    stopTimers();
    if (reported) {
      w.track("text.blank_ended", {
        "tl.session": w.session,
        "tl.why": why,
        "tl.ms": Date.now() - since,
      });
    }
    reported = false;
    since = 0;
  };

  const report = (): void => {
    timer = undefined;
    if (untrack(w.drawn) > 0) return; // drawn in time: this visit was never blank
    reported = true;
    untrack(() =>
      w.track("text.blank", {
        ...w.attrs(),
        "tl.session": w.session,
        "tl.ms": Date.now() - since,
      }),
    );
    recheck = setInterval(() => {
      if (untrack(w.drawn) > 0) end("rows");
    }, RECHECK_MS);
  };

  createEffect(() => {
    const watching = w.watching();
    const closed = w.closed();
    const drawn = w.drawn();
    if (!watching || closed) {
      if (since !== 0) end(!watching ? "left" : "closed");
      return;
    }
    if (since === 0) {
      if (drawn > 0) return;
      since = Date.now();
      timer = setTimeout(report, BLANK_AFTER_MS);
      return;
    }
    if (reported && drawn > 0) end("rows");
  });

  onCleanup(() => {
    if (since !== 0) end("left");
  });
}
