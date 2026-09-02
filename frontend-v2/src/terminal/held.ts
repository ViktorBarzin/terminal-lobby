/**
 * Held input — what happens to a keystroke that arrives with no socket.
 *
 * A key typed into a dead socket used to vanish outright: the send path
 * early-returned, the pty never saw the byte, and the screen — tmux's last
 * repaint, still on display — looked entirely live. The reported symptom is
 * "the terminal ate my command", usually noticed a whole command later.
 *
 * So the keystroke is HELD instead, and drawn where the cursor is. Buffering is
 * deliberately timid, because replay is the risky part: by the time the socket
 * comes back the pty may be somewhere else entirely (a job finished, a TUI
 * redrew, another client typed), and replaying blind would run keys against a
 * prompt that no longer exists. The queue is small, same-session only, and its
 * permission to press Enter for you expires.
 *
 * This file is the DECISIONS only. Every verdict is a cue for the component —
 * what to draw, what to say — and nothing here touches a terminal, a socket or
 * a clock. What the component still owes, in full:
 *
 * - The overlay: xterm decorations anchored to the cursor cell, re-anchored
 *   when a reflow moves that cell, disposed when there is nothing to draw.
 * - The toast throttle — one message per user, not one per key — and the watch
 *   nudge's own separate throttle, which is SHORTER: WATCH_NUDGE_MS is 4000
 *   (term.html:8303) against heldSay's 5000ms gate (term.html:8226).
 * - The WORDING of the read-only refusal. `offer` returns `refused:watching`,
 *   but "Watching — this device can't type into the session" is the
 *   component's line to say, at most once every few seconds.
 * - The dimmed "replayed, waiting for the pty" window. `flush` ends the hold
 *   as far as this file is concerned; the component keeps the replayed text on
 *   screen, dimmed, until pty output proves the session answered. So its own
 *   "something is still on screen" is `isHolding(state) || dim`, and its Esc
 *   handler discards on `isHolding(state) && !dim`.
 * - Resetting the state to EMPTY_HELD whenever the hold ends without a replay:
 *   Esc, a battery suspend, or the session it belonged to going away.
 *
 * Ported from frontend/term.html (`heldInput`, `offerHeldInput`,
 * `heldGraphemes`), which stays the shipped page until the native xterm
 * component replaces the iframe.
 */

/** How much a hold may carry. A queue that grows without bound is a queue that replays a paste into the wrong prompt. */
export const PENDING_INPUT_MAX_BYTES = 4096;

/**
 * The auto-Enter window.
 *
 * It used to bound the whole hold: past it, everything typed offline was thrown
 * away, which is what every real drop cost — a lift, a tube stop, a corporate
 * proxy mangling the socket. The text now survives any gap, because you can SEE
 * it the whole time. What still expires is permission to press Enter FOR you: a
 * command run against a prompt that has moved on is the part nobody can take
 * back.
 */
export const PENDING_INPUT_TTL_MS = 3000;

/** A paste arrives wrapped; what gets held is the payload, not the wrapper. Anchored, so a half-arrived paste is not unwrapped. */
const BRACKETED_PASTE_RE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

export interface HeldState {
  /** What is held, in the order it was typed. */
  readonly text: string;
  /** The line has been committed with Enter and takes no more typing — only Backspace, which reopens it. */
  readonly enter: boolean;
  /**
   * When the FIRST character of the current hold arrived, as a timestamp from
   * the caller's clock; 0 when nothing is held. The TTL runs from here, not
   * from the latest keystroke, so a long slow line does not keep buying itself
   * a fresh window to auto-Enter in.
   */
  readonly since: number;
  /**
   * A hold is under way: some keystroke was accepted, and nothing has discarded
   * or replayed it since.
   *
   * This is NOT `!!(text || enter)`, and the difference is the whole reason it
   * is stored rather than derived. In term.html the equivalent is `heldShadow`,
   * which becomes an object on the first accepted verdict and goes back to null
   * only in discardHeldInput(). Backspace away every character and it sits at
   * `{text:'', enter:false}` — still truthy, so Esc still discards, the resize
   * handler still re-anchors, and the pill legend still reads "held". Deriving
   * it from the text instead would drop all three the moment the line empties.
   */
  readonly active: boolean;
}

export const EMPTY_HELD: HeldState = { text: "", enter: false, since: 0, active: false };

/**
 * Every verdict `offer` can return. The refusals are distinct because the
 * component says something different for each one — "that key needs the
 * session" and "that is as much as this can hold" are not the same news.
 */
export type HeldVerdict =
  /** Appended to the hold. */
  | "held"
  /** Backspace removed one grapheme. */
  | "popped"
  /** Enter committed the line; it now waits for the socket. */
  | "closed"
  /** Backspace took the Enter back off a committed line. */
  | "reopened"
  /** This client attached read-only. It may not type, so it may not hold either. */
  | "refused:watching"
  /** Nothing has ever connected, so there is no session to replay INTO. */
  | "refused:no-session"
  /** The socket is down on purpose while the tab is away. */
  | "refused:suspended"
  /** Backspace or Enter with an empty hold. */
  | "refused:nothing-held"
  /** The line is committed; typing into it is refused until Backspace reopens it. */
  | "refused:closed"
  /** A control key. Only the session can resolve it. */
  | "refused:key"
  /** The byte budget would be exceeded. */
  | "refused:full";

/** What the socket's state means for a keystroke, supplied by the caller so this file owns no globals. */
export interface HeldGates {
  /**
   * This client attached read-only (`arg=ro`, tmux `-r`).
   *
   * Not the security boundary — tmux-api resolves read-only downgrade-only and
   * the server discards a watcher's bytes regardless. It is here because a hold
   * is a PROMISE to replay, and a watcher's keys are never going to be written
   * to that session. term.html drops them at the top of sendInput, before the
   * branch that would have offered them, so they are never drawn and never
   * queued.
   */
  watching: boolean;
  /** False until a socket has opened at least once in this page's life. */
  hasConnectedOnce: boolean;
  /** True while the battery saver deliberately holds the socket down. */
  suspended: boolean;
  /** The caller's clock, used only to stamp the first character of a hold. */
  now: number;
}

export interface OfferResult {
  /** Unchanged — the identical object — for every refusal. */
  state: HeldState;
  verdict: HeldVerdict;
}

/** What a flush did with the hold. `null` means there was nothing to replay. */
export type FlushOutcome = null | "typed" | "ran" | "held-enter";

export interface FlushResult {
  /** Always empty: a flush either replays the hold or discards it, never keeps it. */
  state: HeldState;
  /** Chunks to put on the wire, in order. The text and the Enter go as separate writes, as the page sends them. */
  sends: string[];
  outcome: FlushOutcome;
  /** How old the hold was when the Enter was dropped, for the component's log line. Null unless the outcome is `held-enter`. */
  droppedEnterAfterMs: number | null;
}

/**
 * UTF-8 length without a TextEncoder, so this stays sliceable and testable
 * outside a browser. A surrogate PAIR costs four bytes and consumes both code
 * units; counting each half as three would let a paste of emoji past the
 * budget it was measured against.
 */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Holdable = what a pty would echo back as glyphs, and nothing else.
 *
 * C0/C1 controls and DEL are out: Tab, the arrows, Ctrl-R and friends are all
 * resolved BY the session, so holding one would put something on screen that
 * the session never produced. An empty chunk is not holdable either — there is
 * no glyph to draw for it.
 */
export function isHoldable(s: string): boolean {
  if (!s) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return false;
  }
  return true;
}

/** The payload of a bracketed paste, or the chunk itself when it is not one. */
export function unwrapPaste(data: string): string {
  const paste = BRACKETED_PASTE_RE.exec(data);
  return paste ? paste[1]! : data;
}

/**
 * Split into user-perceived characters. The overlay draws one cell per
 * grapheme, and Backspace deletes one, so a ZWJ family emoji is one thing on
 * screen and one thing to delete.
 */
export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (seg) => seg.segment,
    );
  }
  return [...text];
}

/** How many cells the overlay draws for this text. */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/**
 * Delete a whole grapheme: chopping a code unit off an emoji leaves a lone
 * surrogate, which is not a character anyone typed. Without a segmenter the
 * fallback still steps over a surrogate pair as one unit for the same reason.
 */
export function popGrapheme(s: string): string {
  if (!s) return "";
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
    const last = segs[segs.length - 1];
    return s.slice(0, last ? last.index : 0);
  }
  const c = s.charCodeAt(s.length - 2);
  return s.slice(0, s.length - (c >= 0xd800 && c <= 0xdbff ? 2 : 1));
}

/**
 * Whether there is a hold to discard, re-anchor or report.
 *
 * The three questions this answers are the three that read bare `heldShadow`
 * truthiness in term.html: Esc discards a hold and swallows the key, a reflow
 * re-derives the anchor cell, and the pill legend explains itself as "held".
 * All three keep saying yes on an emptied line, because the person is still
 * mid-edit: they backspaced their command away and the next thing they press is
 * as likely to be Esc as another letter.
 *
 * `hasGlyphs` is the other question and takes the other answer — see there.
 */
export function isHolding(state: HeldState): boolean {
  return state.active;
}

/**
 * Whether the overlay has anything to draw.
 *
 * heldRender's own local test, and it is deliberately narrower than
 * `isHolding`: a hold emptied by Backspace draws no cells and no caret, so the
 * overlay is disposed while the hold itself stays alive underneath.
 */
export function hasGlyphs(state: HeldState): boolean {
  return !!(state.text || state.enter);
}

/**
 * Classify one pty-bound chunk against the current hold.
 *
 * Order matters throughout, and each step below is a rule someone hit:
 *
 * - Watch mode comes before everything, including the socket gates, because it
 *   is the one refusal that does not depend on the socket at all: term.html
 *   drops a watcher's byte at the very top of sendInput, so it reaches neither
 *   the wire nor this file. Holding for a watcher would draw glyphs for a
 *   session they are not permitted to write to, then try to flush them into it.
 * - The two socket gates come next, so a keystroke before the first connection
 *   or during a deliberate suspend is refused rather than queued for a session
 *   that will never receive it.
 * - Backspace is tested BEFORE the "line is closed" refusal, because an Enter
 *   typed by reflex must not be a dead end you cannot edit out of.
 * - Backspace with an empty hold is refused rather than swallowed: the cell to
 *   the left belongs to tmux, and this overlay never touches those. readline
 *   would refuse to delete past its line start anyway, so blanking one would
 *   show a deletion that never happens.
 * - The byte budget is checked against the WHOLE chunk. A paste is held
 *   entirely or not at all; half a pasted command is worse than none.
 *
 * Refusals return the state object untouched, so a caller can compare by
 * identity and skip a repaint.
 */
export function offer(state: HeldState, data: string, gates: HeldGates): OfferResult {
  if (gates.watching) return { state, verdict: "refused:watching" };
  if (!gates.hasConnectedOnce) return { state, verdict: "refused:no-session" };
  if (gates.suspended) return { state, verdict: "refused:suspended" };

  if (data === "\x7f" || data === "\b") {
    if (state.enter) {
      return { state: { ...state, enter: false, active: true }, verdict: "reopened" };
    }
    if (!state.text) return { state, verdict: "refused:nothing-held" };
    const text = popGrapheme(state.text);
    // Emptied by Backspace: forget when it started, so the next character
    // begins a fresh TTL rather than inheriting the old line's age. The hold
    // itself stays active — an empty line is still a line being edited.
    return {
      state: { text, enter: false, since: text ? state.since : 0, active: true },
      verdict: "popped",
    };
  }

  if (state.enter) return { state, verdict: "refused:closed" };

  if (data === "\r" || data === "\n") {
    if (!state.text) return { state, verdict: "refused:nothing-held" };
    return { state: { ...state, enter: true, active: true }, verdict: "closed" };
  }

  const text = unwrapPaste(data);
  if (!isHoldable(text)) return { state, verdict: "refused:key" };
  if (byteLength(state.text) + byteLength(text) > PENDING_INPUT_MAX_BYTES) {
    return { state, verdict: "refused:full" };
  }
  return {
    state: {
      text: state.text + text,
      enter: false,
      since: state.text ? state.since : gates.now,
      active: true,
    },
    verdict: "held",
  };
}

/**
 * Replay, once a socket is back.
 *
 * The text goes however old it is — it has been on screen the whole time, so
 * dropping it now would be the disappearing act this whole mechanism exists to
 * stop. The Enter only goes inside the window where the prompt is still the one
 * you typed at; past that it is dropped and the line waits on the prompt for a
 * person to commit it.
 *
 * A flush ends the hold: the state comes back EMPTY_HELD and `isHolding` goes
 * false with it. What stays on screen after this is the component's dimmed copy
 * of the replayed text, waiting for the pty to answer, and the component owns
 * both that copy and the moment it goes away.
 */
export function flush(state: HeldState, now: number): FlushResult {
  if (!state.text) {
    return { state: EMPTY_HELD, sends: [], outcome: null, droppedEnterAfterMs: null };
  }
  const age = now - state.since;
  if (!state.enter) {
    return { state: EMPTY_HELD, sends: [state.text], outcome: "typed", droppedEnterAfterMs: null };
  }
  if (age <= PENDING_INPUT_TTL_MS) {
    return {
      state: EMPTY_HELD,
      sends: [state.text, "\r"],
      outcome: "ran",
      droppedEnterAfterMs: null,
    };
  }
  return {
    state: EMPTY_HELD,
    sends: [state.text],
    outcome: "held-enter",
    droppedEnterAfterMs: age,
  };
}
