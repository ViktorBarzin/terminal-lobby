/**
 * Attention. When a session deserves the lobby's notice, and when it does not
 * (frontend/term.html:5676-5781, and the output call site at :10384-10392).
 *
 * The lobby is what acts on this, and it is worth naming the three things it
 * does, because none of them is the terminal's to draw: `notify/attention.ts`
 * latches the '● <name>' tab-title prefix for either kind of signal and the
 * favicon's badge for a bell alone, and `SessionView` dots the [Terminal]
 * segment of the view switch for either. The terminal only knows the two
 * things that could be news, and says so.
 *
 * TWO SIGNALS, TWO DIFFERENT RULES. Holding these apart is the whole file:
 *
 *   bell   is reported UNCONDITIONALLY. term.html:5772 is
 *          `term.onBell(() => signalAttention('bell'))`, and there is no
 *          visibility test on that path anywhere: not in `signalAttention`
 *          (:5714-5719 posts upward, and the only `document.hidden` in that
 *          function is the standalone title fallback in its else-if), and not
 *          in the kernel, which never mentions the bell.
 *   output is reported only while nobody can see the terminal, and only ONCE
 *          per hidden period.
 *
 * WHY THE BELL IS NOT GATED HERE, since "you are already looking at it" is a
 * real rule and this is the obvious place to put it. It is the LOBBY's rule,
 * and the lobby's version is WIDER: `notify/attention.ts` latches a signal only
 * while `away`, which is `document.hidden || !document.hasFocus()`. A tab that
 * is visible but unfocused (the lobby open on a second monitor) is away to the
 * lobby and on screen to this module. Gating the bell on hidden here would
 * silence exactly the case the lobby latches for. The net effect that a reader
 * expects still holds, it is just produced one layer up: a ring with the
 * terminal on screen in a focused tab reaches `notify/attention.ts`, which
 * drops it, and `SessionView`, which is already showing the terminal.
 *
 * "NOBODY IS LOOKING" IS BIGGER THAN THE TAB. `document.hidden` is the tab's
 * visibility, but the lobby keeps every visited session MOUNTED and CSS-hides
 * the ones you are not looking at (`store/keepalive.ts`, and
 * `.tl-hidden { display: none !important }` in app.css), and it does the same
 * to the terminal while its text view shows. Then the tab is wide open and the
 * terminal is not on screen, and output arriving then is exactly what should
 * dot the [Terminal] segment. So there are two independent reasons for being
 * hidden, and either one arms the one-shot.
 *
 * THE ONE-SHOT REMEMBERS WHICH REASONS SPENT IT, and that is the part nobody
 * guesses. The lobby only latches its tab badge for a signal that arrives while
 * the tab is away, so a shot burned earlier in a view-hidden period (the attach
 * paint, or the redraw the view switch itself causes) was dropped on arrival
 * and must not silence the first real output of the away period that follows.
 * So a reason for being hidden that was NOT true when the shot was spent opens
 * a NEW period. The reverse does not: the tab coming back while the view stays
 * hidden leaves you still unable to see the terminal, so the last signal did
 * its job and nothing is re-armed (term.html:5745-5756).
 *
 * THE TAB'S VISIBILITY IS AN INPUT, NEVER STATE. This is the one shape decision
 * in the file worth arguing, and it is what keeps the port exact rather than
 * approximately right. term.html's kernel closure holds four things (:5734-5739)
 * and `document.hidden` is not one of them: `attentionHidden()` reads that flag
 * LIVE at every decision (:5740), and so does the re-arm, twice (:5744, :5754).
 * A native module that stored the flag instead, fed by a `visibilitychange`
 * listener, would be a task behind in two places, because the browser flips
 * `document.hidden` and QUEUES the event rather than delivering it:
 *   - an output frame processed inside that window is judged on the old value.
 *     A socket message task queued before the visibilitychange task runs first,
 *     so the page signals and a stored flag says nothing. It then stays silent
 *     for the rest of that hidden period: the `tab` event arriving next finds
 *     nothing latched, so it re-arms nothing, and only more output would signal.
 *   - a `tl-view` message inside the same window re-arms against the old value,
 *     which can leave a spent one-shot armed (or armed one left spent) for the
 *     period that follows.
 * So every decision takes `tabHidden` as an argument, read at the call site the
 * moment the decision is made, and this state holds exactly what the page's
 * closure holds. A tab that BOOTS hidden then needs no seed either, which is
 * why the page never had a boot problem here: its first output frame reads the
 * live flag like every other frame.
 *
 * Everything here is pure: events in, decisions out. Nothing reads a document,
 * a clock or a socket, which is what lets these rules be tested without a
 * browser. The page's version can be reached only by slicing its source out of
 * a 1.5 MB document and running it in a vm, which is what
 * test/term-html.bridge.test.ts does for the cases it names. The differential
 * in test/terminal.attention.test.ts reuses that trick the other way round: it
 * runs the SHIPPED kernel against this module over every walk of up to five
 * steps, with the tab flip and its queued visibilitychange as SEPARATE steps so
 * the window above is inside the search space, so the port is checked rather
 * than taken on trust.
 *
 * WHAT THE COMPONENT STILL OWES, per event and per action. The module decides
 * and the component acts, so a side effect missing from this list is one nobody
 * performs:
 *   bell    xterm's `onBell` (term.html:5772), one event per ring. The page
 *           uses no `bellStyle` and makes no sound, so there is nothing else on
 *           that path to port.
 *   output  ONE event per OUTPUT frame, carrying `document.hidden` read at that
 *           moment. In the native path that is the component's `write`
 *           callback, which attach.ts calls once per output frame and only for
 *           output frames. A title or prefs frame arrives once per connect and
 *           is not news, which is the same reason the echo watch is fed from
 *           the output case alone. Dispatch it BEFORE handing the bytes to
 *           xterm: the page calls `noteHiddenOutput()` at :10388 and writes at
 *           :10391-10392, so a BEL inside that same frame reaches `onBell`
 *           after the output signal, and the two arrive in that order.
 *   tab     a `visibilitychange` listener carrying `document.hidden`, in BOTH
 *           directions, because becoming hidden can open a new period just as
 *           much as becoming visible closes one (:5773-5781). Its only job is
 *           the re-arm. It was new work rather than a line added to a listener
 *           that already existed; TerminalNative.tsx installs it in its mount
 *           body now, and takes it off in `teardown`.
 *   view    `!(mode() === "terminal" && onScreen())`, which is the expression
 *           the iframe branch already passes as TerminalView's `active` prop
 *           (SessionView.tsx:1002) and posts down as `tl-view`
 *           (TerminalView.tsx:266-275). Both halves carry weight: the text view
 *           showing over the terminal, and this session's whole slot being
 *           CSS-hidden behind another session. A Solid effect on `active` fires
 *           on mount, and that first event is the native counterpart of the
 *           lobby re-posting `tl-view` on every attach: it is what tells a
 *           session mounted off screen that nobody is looking. The page starts
 *           from `viewHidden = false` (:5735) and learns the truth the same
 *           way, which is why nothing here is seeded at mount.
 *   signal  hand it up the same path the iframe's does: SessionView's
 *           `onAttention`, which dots the [Terminal] segment and calls
 *           `onFrameAttention(kind, session)`. The component writes no title
 *           and no favicon: those belong to `notify/title.ts` and
 *           `notify/favicon.ts`, and a terminal that painted its own would
 *           fight them. term.html's standalone `'● '` title prefix (:5720-5722)
 *           is the branch for a page with no lobby to tell, and there is no
 *           native terminal outside the lobby.
 *   re-attach  a fresh `initialAttention()`, if the component ever grows one.
 *           Not an event: a lifetime. The page's kernel dies with its document,
 *           so TerminalView navigating the iframe on an args change resets the
 *           latch, the view flag and the spent pair. TerminalNative reads
 *           `props.args` once inside `onMount` and never re-attaches, so there
 *           is nothing to diverge from today. A component that keeps this state
 *           across a re-attach would carry a one-shot spent before it, and
 *           silence the first output frame after it.
 */

/**
 * What the lobby is being told about. The same two words the `tl-attention`
 * message carries, so the wiring hands this straight to `onFrameAttention`.
 *
 * The lobby does treat them differently, which is why one signal is not enough:
 * a bell latches the favicon badge as well as the title prefix, output latches
 * the title prefix alone (`notify/attention.ts`, `applyAttentionSignal`).
 */
export type AttentionKind = "bell" | "output";

/**
 * Exactly what term.html's kernel closure holds (:5734-5739). The tab's
 * visibility is deliberately absent: see the header. Four booleans, so a
 * component can keep this in a signal and compare by identity.
 */
export interface AttentionState {
  /**
   * The terminal is not the thing on screen, though the tab may be: the lobby
   * is showing its text view, or another session entirely. term.html learns
   * this from the lobby's `tl-view` message because a CSS-hidden frame's own
   * `document.hidden` stays false.
   */
  readonly viewHidden: boolean;
  /**
   * The one output signal this hidden period was allowed has been sent.
   * term.html's `hiddenOutputSignaled`. A latch and not a counter: ten frames
   * behind a hidden view are one piece of news.
   */
  readonly latched: boolean;
  /**
   * Which reasons for being hidden were true when the shot was spent. Read only
   * while `latched`, and written only by the output that sets it, so the pair
   * left behind after a re-arm is never looked at (which is why term.html does
   * not clear them either).
   */
  readonly spentTabHidden: boolean;
  readonly spentViewHidden: boolean;
}

/**
 * A terminal that has just mounted, with nothing signalled yet.
 *
 * Takes no seed, and wants none. term.html boots `viewHidden = false` (:5735)
 * and learns the truth from the lobby's first `tl-view`, which the lobby
 * re-posts on every attach (TerminalView.tsx:266-275); the native counterpart
 * is a Solid effect on `active`, which fires on mount. The tab's visibility is
 * not stored at all, so a tab that boots hidden and fires no visibilitychange
 * still signals: its first output frame carries the live flag.
 */
export function initialAttention(): AttentionState {
  return {
    viewHidden: false,
    latched: false,
    spentTabHidden: false,
    spentViewHidden: false,
  };
}

export type AttentionEvent =
  /**
   * xterm's parser saw BEL (term.html:5772, `term.onBell`). The only event that
   * needs no visibility at all, because this signal is never gated.
   */
  | { type: "bell" }
  /**
   * One frame of pty output arrived, carrying `document.hidden` as read at that
   * moment. The CONTENT is never inspected, here or in the page: the fact that
   * something happened is the whole signal. This is the hot path, one event per
   * frame, which is why the answer is a couple of boolean reads.
   */
  | { type: "output"; tabHidden: boolean }
  /**
   * The `visibilitychange` listener ran, and `document.hidden` now reads this.
   * Fed in both directions; its only job is the re-arm (:5773-5781).
   */
  | { type: "tab"; tabHidden: boolean }
  /**
   * The terminal view came on or off screen: the text view showing over it, or
   * this session's slot being CSS-hidden behind another. term.html's
   * `setViewHidden` (:5758-5761), fed by the lobby's `tl-view` message. Carries
   * the tab flag too, because the re-arm this runs reads it live in the page.
   */
  | { type: "view"; viewHidden: boolean; tabHidden: boolean };

export type AttentionAction =
  /**
   * Tell the lobby this session wants notice. The only thing this module ever
   * asks for, and it asks at most once per event.
   */
  { type: "signal"; kind: AttentionKind; why: string };

export interface AttentionReduction {
  /** Identical to the state passed in whenever nothing moved, so a caller can compare by identity. */
  readonly state: AttentionState;
  readonly actions: readonly AttentionAction[];
}

/** Nothing to ask for. */
const QUIET = (state: AttentionState): AttentionReduction => ({ state, actions: [] });

/**
 * Is anybody looking at this terminal?
 *
 * term.html's `attentionHidden()` (:5740). Either reason is enough, and neither
 * outranks the other. The tab half is an argument rather than a field for the
 * reason the header gives: the page reads it live, at every decision.
 */
export function isHidden(state: AttentionState, tabHidden: boolean): boolean {
  return tabHidden || state.viewHidden;
}

/** The whole policy. Nothing here reads a document, a clock or a socket. */
export function reduce(state: AttentionState, event: AttentionEvent): AttentionReduction {
  switch (event.type) {
    case "bell":
      // Ungated, and it neither reads nor writes the output one-shot. The
      // header says why at length; the short version is that the lobby's own
      // "away" test is wider than this module's "hidden" and would be
      // second-guessed by a gate here.
      return {
        state,
        actions: [{ type: "signal", kind: "bell", why: "the pty rang the bell" }],
      };

    case "output": {
      // `if (!attentionHidden() || hiddenOutputSignaled) return;`
      // (term.html:5765). Two booleans per output frame, which is what keeps
      // this affordable on the hot path.
      if (!isHidden(state, event.tabHidden) || state.latched) return QUIET(state);
      return {
        state: {
          ...state,
          latched: true,
          // Stamped from the reasons true RIGHT NOW, so a reason that becomes
          // true later can tell that it was not one of these and open a new
          // period. The tab half comes off the event because the page stamps it
          // from a live read too (:5767).
          spentTabHidden: event.tabHidden,
          spentViewHidden: state.viewHidden,
        },
        actions: [
          { type: "signal", kind: "output", why: whyOutput(event.tabHidden, state.viewHidden) },
        ],
      };
    }

    // Both visibility events end in the same re-arm the page runs, and the page
    // runs it unconditionally: from the listener whatever direction the tab
    // moved (:5776), and from `setViewHidden` even when the value it was handed
    // is the one already there (:5759-5760). So neither event may skip it. What
    // IS skipped is the write of an unchanged view flag, which keeps the state
    // object identical for a caller comparing by identity.
    case "tab":
      return QUIET(rearm(state, event.tabHidden));

    case "view":
      return QUIET(
        rearm(
          state.viewHidden === event.viewHidden
            ? state
            : { ...state, viewHidden: event.viewHidden },
          event.tabHidden,
        ),
      );

    default: {
      const unhandled: never = event;
      void unhandled;
      return QUIET(state);
    }
  }
}

/**
 * Whether the one-shot goes back on the hook, given what is hidden now
 * (term.html:5741-5757, `rearmHiddenOutput`).
 *
 * Called after every visibility change, in both directions, and the page calls
 * it nowhere else. An unchanged pair of flags is NOT a no-op here, which is the
 * thing to notice: the tab flag arrives fresh on every event, so a `tl-view`
 * repeating the value it already had can still find that the tab went away
 * since the shot was spent, and open a new period on that alone. The page
 * behaves the same way for the same reason.
 */
function rearm(state: AttentionState, tabHidden: boolean): AttentionState {
  if (!state.latched) return state; // nothing has been spent
  // Fully back on screen: the period is over.
  if (!isHidden(state, tabHidden)) return { ...state, latched: false };
  // Still hidden, but hidden for a reason that was NOT true when the shot was
  // spent. That opens a new period, because the spent signal was one the lobby
  // could not use: see the header.
  if ((tabHidden && !state.spentTabHidden) || (state.viewHidden && !state.spentViewHidden)) {
    return { ...state, latched: false };
  }
  return state;
}

/** The reason, for the log line. term.html logs nothing here; the native path can. */
function whyOutput(tabHidden: boolean, viewHidden: boolean): string {
  if (tabHidden && viewHidden) return "output while the tab was away over a hidden view";
  if (tabHidden) return "output while the tab was away";
  return "output while the terminal view was hidden";
}
