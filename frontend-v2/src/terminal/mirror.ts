/**
 * The compose mirror. A visible textarea kept as a transparent mirror of the
 * pty's current input line, so a phone keyboard's autocorrect, dictation and
 * swipe typing can reach a terminal.
 *
 * WHY IT HAS TO BE A SEPARATE FIELD. xterm's own helper textarea is
 * deliberately hardened on touch devices: `type=password`, autocorrect,
 * autocapitalize and spellcheck all off, because predictive text otherwise
 * commits a suggestion straight into terminal input (xterm #2403, #3600, #675).
 * `TerminalNative.tsx` does that today. With that field hardened, this mirror
 * is the ONLY way a phone or tablet gets autocorrect, dictation or swipe typing
 * into a terminal, and it is for every mobile device rather than one tablet:
 * Gboard on Android is as much the target as iOS QuickType.
 *
 * WHY IT IS PASSIVE, which is the part that is easy to break. The mirror reads
 * its own `.value` and forwards a DELTA. It never rewrites that value while a
 * line is being edited, because clearing the field mid-word is what kills
 * QuickType and Gboard predictions.
 *
 * The hardening at the top is term.html's own argument (:7078-7082) and it is
 * the one that decides this. A SECOND reason this port used to give was false:
 * that the typed character never lands in xterm's field at all. It does. What
 * follows is what the INSTALLED @xterm/xterm 6.0.0 does with that value, read
 * out of `node_modules/@xterm/xterm/src`. Nothing in this module depends on
 * it, and it is written down only so the next reader does not re-derive the
 * wrong version.
 *
 * Most typing never reaches the value: `_keyDown` fires the data event itself
 * and force-cancels the keydown (`cancel(event, true)`,
 * CoreBrowserTerminal.ts:1099), so no insertion follows. Uppercase A-Z is the
 * exception and STAYS in the value: `_keyDown` returns early at :1074 leaving
 * `_keyDownHandled` false, `_keyPress` then calls the UN-forced
 * `this.cancel(ev)` (:1153), and `cancel` prevents nothing unless
 * `options.cancelEvents` or `force` says so (:1321-1328), where `cancelEvents`
 * defaults false (OptionsService.ts:58) and is set nowhere in frontend-v2. IME
 * and emoji-picker text stays for the same reason: `_inputEvent`'s
 * `cancel(ev)` (:1208) is un-forced too, and could not undo an insertion
 * regardless, because xterm listens on `input` (:384), which is not
 * cancelable, and registers no `beforeinput` handler anywhere. That branch is
 * guarded on `(!ev.composed || !this._keyDownSeen)` (:1196), so it is the IME
 * path rather than the typing path. What is left in the value is therefore
 * neither empty nor the input line, and it is wiped on blur (:292), on an ETX
 * or CR keydown (:1087) and after a paste (Clipboard.ts:55). No use to a
 * predictor even if the field were not hardened.
 *
 * The mirror writes the field on three occasions, none of them an ordinary
 * edit, and each comes back as a `set-field` action for the component to
 * perform. Two of the three ride the submit branch of an `edited` event:
 * `line-submitted` (Enter went through, so the pty's line restarts empty and
 * the field empties with it) and `line-restored` (Enter with no socket, so the
 * newline is stripped and the text goes back). Both of those follow the send
 * key, so the line is finished and there is no half-typed word to lose. The
 * third, `out-of-band`, arrives on an event of its own: bytes reached the pty
 * by another route, so the baseline is a lie and the field drops with it.
 *
 * That third one IS cleared mid-word, and often. term.html reaches it from
 * `sendKey` on every soft Esc/Tab/arrow tap (:6822-6831) and from `term.onData`
 * on every raw keystroke in the helper textarea (:8342), and its early-out
 * skips only when the field AND the baseline are both empty (:7268), so a field
 * holding a half-typed word with a live QuickType or Gboard suggestion goes
 * with it. term.html claims no prediction safety there either; its stated
 * reason is desync (:6824-6827), and this port keeps the same trade: a lost
 * suggestion against a baseline that would otherwise be wrong about the pty.
 * Nothing else may touch the field, and `test/terminal.mirror.test.ts` asserts
 * that over every edit shape.
 *
 * Note that `line-submitted` IS a clear, and term.html:7269-7272 is where it
 * comes from. The mechanism survives it: what kills a prediction is clearing
 * mid-word, and a submitted line is a finished sentence. Skipping it would
 * break the mirror instead of hardening it, because a field still holding the
 * submitted text over a baseline the pty has emptied re-sends the whole line on
 * the next keystroke.
 *
 * WHY A DIFF RATHER THAN AN EVENT READING. The DOM fires `input` after the
 * mutation regardless of HOW the text changed: typing, composition updates,
 * autocorrect replacements, suggestion taps, dictation bursts, swipe words,
 * select-all overwrites, shake-to-undo. Diffing two strings is therefore
 * event-shape-agnostic, so the Gboard event-interpretation failures that broke
 * helper-textarea typing cannot reach it, and an unchanged value diffs to
 * nothing, which is what makes a double-send impossible rather than merely
 * unlikely.
 *
 * Ported from frontend/term.html:7077-7509, engine at 7167-7330:
 *   6369-6376  the two seams: `mirrorEmitting` and `mirrorLineReset`
 *   7077-7132  the field and its attribute set. The component mounts it, but
 *              the attributes are `MIRROR_FIELD_ATTRIBUTES` below rather than
 *              a hand-off, because one of them is an OMISSION
 *   7140-7165  autogrow and growAndRefit (the component's job, below)
 *   7167-7204  lastValue, the suppress flag, the grapheme/code-point authority
 *   7205-7226  mirrorCommonPrefix
 *   7227-7259  emit and the three-branch reconcile
 *   7261-7274  mirrorLineReset
 *   7276-7303  the input listener, Enter, and the offline branch
 *   7305-7318  the multiline-paste interception
 *   7320-7327  Backspace against an empty field
 *   8342       the onData hook that turns other paths into an out-of-band reset
 *   8888-8903  the capture-phase document paste handler, and the deferral that
 *              keeps a text paste aimed at this field IN the field
 *
 * V1 constraints, decided end to end in that page and not to be re-litigated
 * without new evidence (term.html:7178-7186): no pty cursor tracking and no
 * arrow repositioning, so a mid-line edit is a delete-to-common-prefix plus a
 * tail retype; composition streams through rather than waiting for
 * compositionend, which would lag the TUI a whole word behind on every Gboard
 * commit; Enter always submits; the field never contains a newline; one line is
 * mirrored, with no draft persistence and no history.
 *
 * Everything here is pure. The component owns the field, the socket, the
 * layout and the toast throttle; this module only decides. What it still owes
 * is listed on each action.
 */

import { graphemeCount, graphemes } from "./held";

/** One backspace, the only deletion either receiver class understands. */
const DEL = "\x7f";

/**
 * What term.html says when Enter lands with no socket. The wording names the
 * way out of the state, which is the whole point of saying anything, so it is
 * carried here rather than left to the wiring stage to reinvent. held.ts takes
 * the other choice for its refusals because most of those have no message at
 * all; this one has exactly one call site and one sentence.
 */
export const HELD_ENTER_MESSAGE = "Held — reconnect and press Enter to run it";

/**
 * The field's attributes, as term.html sets them (:7115-7120). Carried here
 * rather than left to the wiring stage because one of them is an absence, and
 * getting an absence wrong removes the feature without breaking anything.
 *
 * `autocomplete` IS NOT IN THIS SET AND MUST NOT BE ADDED. term.html records
 * the measurement (:7103-7110, 2026-07-12): on iOS, pronounced in the
 * installed PWA's WKWebView, `autocomplete='off'` also suppresses the
 * QuickType predictive and autocorrect bar. That is a WebKit coupling rather
 * than form-autofill behaviour, and it silently killed suggestions in this
 * exact field. Omitting the attribute restores the spec-neutral default, and
 * 'off' bought nothing anyway: a nameless, form-less textarea has ~nil
 * autofill risk.
 *
 * This set is the OPPOSITE of the helper-textarea hardening in
 * `TerminalNative.tsx`'s `hardenInput`, which is correct where it is. That
 * field is being hardened, and it does set `autocomplete='off'`. Copying that
 * block onto this field is the mistake this constant exists to stop. A `type` attribute
 * is absent for the same class of reason: a textarea has none, and the helper
 * field's `type=password` trick would kill the composition UI this field is
 * for.
 *
 * Three things the component owns that are not attributes: `rows = 1`
 * (:7098), the height autogrow measures from; `placeholder` (:7121); and
 * `style.fontSize = '16px'` (:7122), which is what stops iOS Safari zooming
 * the page when the field takes focus.
 */
export const MIRROR_FIELD_ATTRIBUTES = {
  autocapitalize: "off",
  autocorrect: "on",
  spellcheck: "true",
  inputmode: "text",
  enterkeyhint: "send",
  "aria-label": "Compose text to send to the terminal",
} as const;

/**
 * The pty's input line, as this mirror shaped it. term.html's `lastValue`.
 *
 * It is the mirror's claim about what the receiver currently holds, not a copy
 * of the field: the two are equal after every edit the mirror forwarded, and
 * deliberately unequal for the one moment between a submit and the field being
 * cleared.
 */
export interface MirrorState {
  readonly line: string;
}

export const EMPTY_MIRROR: MirrorState = { line: "" };

export type MirrorEvent =
  /**
   * The DOM `input` event on the field, read after the mutation.
   *
   * `caret` is `selectionStart`, and the differ never reads it. That is
   * term.html's V1 constraint rather than an omission: keying the diff on the
   * caret would only pay off with pty cursor tracking, which there is none of,
   * and the Enter rule is stated in terms of it (the whole value submits
   * wherever the caret was). It is carried so both of those stay checkable.
   */
  | { readonly type: "edited"; readonly value: string; readonly caret: number }
  /**
   * `beforeinput` with `inputType === "insertFromPaste"`, carrying `e.data`.
   * The component fires this for that input type only and passes `""` when
   * there is no data to read.
   *
   * WHERE THE FIELD HAS TO LIVE, recorded here because this is the event that
   * breaks if it lives in the wrong place: OUTSIDE the terminal host, the way
   * term.html appends its compose bar to document.body (:7130).
   * `TerminalNative.tsx` registers a paste handler on the host in the CAPTURE
   * phase and preventDefaults plus stopPropagations every paste carrying text,
   * routing it to the pty. A field mounted inside that host would have its
   * paste swallowed before `beforeinput` fired: no native insertion for a
   * single-line paste, and no interception for a multiline one, which is worse
   * than the double-forward the swallow is there to stop. term.html needs the
   * same escape at document level and spells it as an id check (:8892-8903).
   */
  | { readonly type: "paste-intent"; readonly data: string }
  /**
   * `keydown` on the field with `key === "Backspace"`, carrying the field's
   * current value and `e.isComposing`.
   */
  | {
      readonly type: "backspace-at-empty";
      readonly value: string;
      readonly composing: boolean;
    }
  /**
   * Bytes reached the pty from a path that is not this mirror, so the baseline
   * is stale. term.html's `mirrorLineReset`, whose ten call sites are 6828,
   * 7301, 8342, 8922, 8963, 9004, 9126, 9388, 9689 and 10293. Carries the
   * field's current value, which the early-out reads.
   *
   * Nine of the ten are this event; :7301 is the mirror's own submit clear,
   * which is `set-field` with reason `line-submitted` here. WHERE THE OTHER
   * NINE LAND NATIVELY, because the port collapses them:
   *
   *   :8342          `term.onData`, the one place xterm hands bytes over: raw
   *                  typing in the helper textarea, and the echo of the
   *                  mirror's own `send`, which is why that has to be marked.
   *                  Natively that hook is TerminalNative's `term.onData`, and
   *                  keys.ts already decides it: its `mirror-out-of-band`
   *                  action IS this event, gated on `mirrorEmitting`.
   *   :6828, :9388   the soft-key row and the SPA's `tl-input` bridge. Both
   *                  become `__tlSendToTerminal` (TerminalNative's `send`),
   *                  called by `SessionView.tsx:515-521` for the soft keys and
   *                  the Text view's send-to-terminal.
   *   :8922, :8963,  path-sends: three upload paths, the gallery's "Insert
   *   :9004, :9126,  path into terminal", and saved paths. All five are
   *   :9689          `SessionView.tsx:554`, so they arrive through that same
   *                  bridge.
   *   :10293         a fresh socket attach, in `attach.ts`.
   *
   * The bridge is the load-bearing one: it calls the attachment's `send`
   * directly (`attach.ts:612`), so xterm's onData never sees those bytes and
   * the `:8342` hook cannot cover them. One hook there covers seven of
   * term.html's nine sites; without it a soft arrow or Esc tap silently
   * desyncs the field from the pty line it claims to mirror, which is the
   * consequence term.html names at :6824-6827.
   */
  | { readonly type: "out-of-band"; readonly value: string };

/** What the socket's state means for this edit, supplied so this file owns no globals. */
export interface MirrorWorld {
  /**
   * `ws && ws.readyState === WebSocket.OPEN`, read at the moment of the edit.
   * Consulted on the submit branch alone: everywhere else the delta goes to
   * the same send path as a keystroke, and held.ts is what catches it with no
   * socket.
   */
  readonly connected: boolean;
}

export type MirrorAction =
  /**
   * Put these bytes on the wire, through `term.input(bytes, true)` so they pass
   * xterm's own onData and reach the existing soft-modifier remap and send
   * path. No new socket route. Passing that remap is deliberate rather than
   * incidental, and it is why an armed Ctrl also remaps the mirror's first
   * character, which term.html records as a limitation of typing prose here
   * (:7428-7437): chords want terminal focus. The component must mark the call as the
   * mirror's own (term.html's `mirrorEmitting`, :7234-7235) so its onData hook
   * does not read the mirror's echo as an out-of-band reset.
   *
   * One action is one `term.input` call, so a run of them is a run of frames.
   * The order and the grouping are both load-bearing: a submit sends its delta
   * and its carriage return as two frames, and a correction sends its
   * backspaces and its retype as one.
   */
  | { readonly kind: "send"; readonly bytes: string }
  /**
   * Hand the whole block to `term.paste(text)`, which brackets it. NOT marked
   * as the mirror's own: this paste's onData traffic is what resets the
   * baseline, and marking it would swallow that (term.html:7309-7310).
   */
  | { readonly kind: "paste"; readonly text: string }
  /** `consumeSoftMods()`, before the paste, or an armed Ctrl remaps its first character. */
  | { readonly kind: "disarm-soft-mods" }
  /** `preventDefault()` on the `beforeinput`, so the block never enters the one-line field. */
  | { readonly kind: "swallow-edit" }
  /**
   * Write the field. The only three occasions: two after the send key, where
   * nothing is in flight to lose, and `out-of-band`, which can and does land
   * mid-word. See the passivity note in the header before adding a fourth,
   * and read the out-of-band trade there before treating any of them as free.
   *
   * Two duties come with it. Apply it without letting it re-enter `reduce` as
   * an `edited` event (term.html's `suppress` flag, :7188, :7269-7271), and
   * re-measure the field afterwards: a programmatic `.value` assignment fires
   * no `input` event, so the component's own autogrow listener never runs for
   * it (which is why term.html calls growAndRefit by hand at :7273 and :7296).
   */
  | {
      readonly kind: "set-field";
      readonly value: string;
      readonly reason: "line-submitted" | "line-restored" | "out-of-band";
    }
  /**
   * Tell the person. The component owns the throttle, which is heldSay's one
   * message every 5000ms (term.html:8191-8195), shared with the held-input
   * messages so a drop does not say two things at once.
   */
  | { readonly kind: "say"; readonly message: string };

export interface MirrorReduction {
  /** Identical to the state passed in whenever the baseline did not move, so a caller can compare by identity. */
  readonly state: MirrorState;
  /** In the order the component must perform them. Empty when there is nothing to do. */
  readonly actions: readonly MirrorAction[];
}

const NOTHING: readonly MirrorAction[] = [];

/** Code points, which is what readline and canonical mode delete one of per DEL. */
function codepointCount(s: string): number {
  return Array.from(s).length;
}

/**
 * An emptied baseline, keeping the identity of one that was already empty so
 * the contract on `MirrorReduction.state` holds on both reset paths. fit.ts
 * does the same for its debt.
 */
function emptied(state: MirrorState): MirrorState {
  return state.line === "" ? state : EMPTY_MIRROR;
}

/**
 * The common prefix of the old and new values, in code units, snapped out of a
 * split surrogate pair and back onto a grapheme boundary of `a` (the old value)
 * so the deletion suffix is countable in whole units. term.html:7205-7226.
 *
 * Both snaps only ever LOWER the prefix, which costs a few more bytes and can
 * never produce a wrong line.
 *
 * The grapheme snap runs unconditionally here where term.html guards it on the
 * segmenter existing. It is the same result either way: without a segmenter
 * `graphemes` splits by code point, and the surrogate step above has already
 * put `p` on a code-point boundary, so snapping to one is a no-op.
 *
 * The walk below breaks at the same point term.html's does (:7220), and what
 * it walks is the cost difference. `graphemes` CONSTRUCTS AN `Intl.Segmenter`
 * PER CALL (held.ts:205-212) and materializes the whole segment array before
 * the loop starts, where term.html's mirror engine builds one segmenter for
 * the page's life (:7198-7200) and iterates it lazily. A mid-line correction
 * that shares a prefix pays for two constructions per keystroke, the walk
 * below and the `graphemeCount(del)` in `diff`, against term.html's zero. A
 * plain append pays for none: the `p < a.length` skip below and the empty
 * `del` in `diff` keep the common case off the segmenter entirely.
 *
 * That is accepted rather than overlooked. held.ts is the single grapheme
 * authority in this codebase, the strings are bounded by one terminal line,
 * and held.ts's own ancestor in term.html constructs per call too
 * (`heldGraphemes`, :8123-8129); only the mirror engine hoists one. If a
 * phone ever shows it, one module-level segmenter in held.ts fixes every
 * caller at once.
 */
export function commonPrefix(a: string, b: string): number {
  let p = 0;
  const m = Math.min(a.length, b.length);
  while (p < m && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0) {
    const c = a.charCodeAt(p - 1);
    // A prefix ending between a high and a low surrogate leaves half a
    // character on each side, which is not a thing anybody typed.
    if (c >= 0xd800 && c <= 0xdbff) p--;
  }
  // A prefix that IS the whole old value needs no snapping, and skipping the
  // walk keeps plain appending, the common case, off the segmenter.
  if (p > 0 && p < a.length) {
    let floor = 0;
    let end = 0;
    for (const g of graphemes(a)) {
      end += g.length;
      if (end > p) break;
      floor = end;
    }
    p = floor;
  }
  return p;
}

/**
 * The differ. term.html's `reconcile` (:7237-7259), three branches, keyed on
 * the one thing the two receiver classes disagree about.
 *
 * Claude Code's composer deletes one GRAPHEME per DEL; readline and kernel
 * canonical mode delete one CODE POINT. Both measured through the real
 * ws/ttyd/tmux stack (term.html:7187-7196). They only disagree where a grapheme
 * spans more than one code point, so:
 *
 *  1. nothing deleted: stream the insertion.
 *  2. the counts agree, which is all plain text: one DEL per code point, then
 *     retype the tail. The backspaces and the retype go in ONE frame, because
 *     term.html builds one string and hands it to one emit().
 *  3. the counts disagree (emoji, ZWJ, a combining mark): delete past empty by
 *     the code-point count of the WHOLE old line, which over-deletes on the
 *     grapheme receiver and is a verified no-op there, then retype the whole
 *     line. Over-deleting from a known state sidesteps the disagreement instead
 *     of guessing which receiver is listening.
 */
function diff(state: MirrorState, cur: string): MirrorReduction {
  // The double-send guard, and it is structural rather than a check: any event
  // that re-fires with the value already on screen lands here.
  if (cur === state.line) return { state, actions: NOTHING };

  const p = commonPrefix(state.line, cur);
  const del = state.line.slice(p);
  const ins = cur.slice(p);

  let bytes: string;
  if (!del) {
    bytes = ins;
  } else if (graphemeCount(del) === codepointCount(del)) {
    bytes = DEL.repeat(codepointCount(del)) + ins;
  } else {
    bytes = DEL.repeat(codepointCount(state.line)) + cur;
  }

  // `bytes` is never empty on this path: the values differ, so either the
  // insertion or the deletion is non-empty, and the equal case returned above.
  return { state: { line: cur }, actions: [{ kind: "send", bytes }] };
}

/** The whole mirror. Nothing here touches the DOM, xterm, a socket or a clock. */
export function reduce(
  state: MirrorState,
  event: MirrorEvent,
  world: MirrorWorld,
): MirrorReduction {
  switch (event.type) {
    case "edited":
      return onEdited(state, event.value, world);

    case "paste-intent":
      // Multiline only. A single-line paste falls through, inserts natively
      // and streams like typing, which is what keeps the field showing the
      // line. That fall-through is why term.html's document-level handler
      // defers a text paste aimed at this field (:8892-8903, an id check): its
      // own handler is capture-phase at document (:8888, :8945) and
      // preventDefaults every text paste, so without the deferral the text
      // would reach the pty through term.paste while the field's insertion
      // never happened: no `input` event, nothing diffed, and the field
      // blanked by the reset that paste's own onData traffic fires. The paste
      // would arrive once and the mirror would stop showing the line, which is
      // what term.html means at :8896-8898.
      if (!event.data || !event.data.includes("\n")) {
        return { state, actions: NOTHING };
      }
      return {
        state,
        actions: [
          { kind: "swallow-edit" },
          { kind: "disarm-soft-mods" },
          { kind: "paste", text: event.data },
        ],
      };

    case "backspace-at-empty":
      // Transparent erase. An out-of-band reset can leave the pty holding a
      // line the mirror does not, and an empty field is all the person can
      // see, so Backspace there is aimed pty-side. The baseline stays where it
      // is whatever it holds, exactly as term.html leaves lastValue untouched
      // at :7325-7327: the guard reads the FIELD, and this DEL is aimed at
      // text the mirror never tracked. With text in the field the ordinary
      // differ owns the deletion, and emitting here as well would delete
      // twice; an IME owns its own backspaces mid-composition.
      if (event.value !== "" || event.composing) return { state, actions: NOTHING };
      return { state, actions: [{ kind: "send", bytes: DEL }] };

    case "out-of-band":
      // No emission: the pty already has the bytes. The early-out reads the
      // field as well as the baseline, and it is about cost rather than
      // correctness. Raw typing in the helper textarea fires this once per
      // keystroke through onData, and re-clearing an already-empty field would
      // force a re-measure and a tmux refit on every one (term.html:7268).
      //
      // The clear itself is NOT free, which is the one thing to know before
      // wiring a new source to this event: it is the only field write that can
      // land mid-word, taking a live suggestion with it. term.html accepts
      // that for a baseline that would otherwise be wrong (:6824-6827), and so
      // does this port.
      if (!event.value && !state.line) return { state, actions: NOTHING };
      return {
        state: emptied(state),
        actions: [{ kind: "set-field", value: "", reason: "out-of-band" }],
      };

    default: {
      const unhandled: never = event;
      void unhandled;
      return { state, actions: NOTHING };
    }
  }
}

/**
 * One field edit. term.html:7276-7303.
 *
 * A newline in the value IS the submit: the soft keyboard's `send` key inserts
 * one, and there is no key event to read for it. `enterkeyhint` is fixed at
 * `send` for that reason, so Enter always submits and the field never holds a
 * newline.
 */
function onEdited(state: MirrorState, value: string, world: MirrorWorld): MirrorReduction {
  if (!value.includes("\n")) return diff(state, value);

  // Every newline, not just the first, and the whole value regardless of where
  // the caret was: a mid-string Enter must not split the line. Terminal
  // semantics, proven necessary end to end (term.html:7279-7285).
  const line = value.replace(/\n/g, "");
  const reconciled = diff(state, line);

  if (!world.connected) {
    // The pty never saw any of it. Offline the text is sitting in a hold (see
    // held.ts), so clearing the field here would take the line away from under
    // it and leave an empty box with no way back. Strip the newline, keep the
    // text where the person can see it, and say why (term.html:7286-7299).
    //
    // The Enter the message asks for is Enter over an EMPTY field, not this
    // one. A reattach resets the mirror early in ws.onopen (term.html:10293)
    // and replays the hold 49 lines later (:10342), so the reset always lands
    // first; and the flush writes to ws.send directly (:8243-8250), bypassing
    // onData and therefore this module, so the pty comes back holding a line
    // whose baseline says empty.
    // That is the state `backspace-at-empty` exists for, and it is inherited
    // from term.html rather than introduced here. The test file walks the
    // whole sequence.
    return {
      state: reconciled.state,
      actions: [
        ...reconciled.actions,
        { kind: "set-field", value: reconciled.state.line, reason: "line-restored" },
        { kind: "say", message: HELD_ENTER_MESSAGE },
      ],
    };
  }

  // The carriage return is its own frame, as term.html sends it: a separate
  // emit(), so a separate write. Frame boundaries are observable to whatever is
  // reading the pty, and no evidence says these two are safe to merge, so the
  // grouping is preserved rather than reasoned about.
  //
  // Then the field and the baseline both drop, because the pty's input line
  // restarts empty. This is the ONE clear the mechanism needs and the one that
  // costs nothing: a submitted line is a finished sentence, so no prediction is
  // in flight to lose. Leaving the text with an empty baseline would re-send
  // the whole line on the next keystroke; leaving the text AND the baseline
  // would show a line the pty no longer has.
  //
  // The clear goes out unconditionally where term.html routes it through
  // mirrorLineReset, whose early-out reads the field (:7268, called at :7301).
  // That early-out cannot fire on this path: the value that triggered the
  // submit still holds the newline that triggered it, so the field is
  // non-empty by construction. Same behaviour, one fewer read.
  return {
    state: emptied(reconciled.state),
    actions: [
      ...reconciled.actions,
      { kind: "send", bytes: "\r" },
      { kind: "set-field", value: "", reason: "line-submitted" },
    ],
  };
}
