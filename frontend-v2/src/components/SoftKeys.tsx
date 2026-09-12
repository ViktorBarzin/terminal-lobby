import { onCleanup, For, Show, type Component, type JSX } from "solid-js";
import { keyBytes, type KeyName } from "../mobile/keybytes";
import { CopyIcon, ClipboardIcon } from "./Icons";
import { track } from "../telemetry/track";

/**
 * Mobile soft-key toolbar (design pillar #2 — Mobile/Touch), ported from the
 * vanilla frontend/index.html `#soft-keys` (~10869-11421). Coarse-pointer only;
 * the parent mounts it and reserves a REAL CSS height via `body.has-soft-keys`
 * so the surface above it shrinks by a real height, which is what lets the
 * terminal's FitAddon measure a true box.
 *
 * ONE ROW (2026-09-06). It was two tiers — a primary line plus a ⋯-toggled
 * overflow tier — and the second tier cost a permanent strip of screen above
 * the keyboard. What survived the flatten is what 28 days of `terminal.softkey`
 * telemetry says gets pressed, 1,121 taps:
 *
 *   ↓ 702 · ← 228 · ↑ 90 · Tab 71 · Esc 13 · → 11 · Paste ~11 · Copy 6
 *
 * and what came out, with the reason each one earned:
 *
 *   - `/` `-` `|` `` ` `` — zero taps in 28 days. The system soft keyboard has
 *     all four, one shift away.
 *   - Ctrl and Alt — Ctrl was a NO-OP. `applyMods` only ever saw this
 *     toolbar's own pre-baked bytes, none of which begin with an ASCII letter,
 *     and `TerminalNative` holds `keyState.mods = null` on every device, so a
 *     letter typed on the system keyboard was never remapped either. Ctrl+C
 *     from a phone has never worked here. The machine itself (`mobile/softmods`)
 *     stays: `terminal/keys.ts` reduces through it and is the place that would
 *     wire it up for real.
 *   - ⇧Tab — 6 taps, and the permission-mode cycle it existed for has its own
 *     chip in the Text view's composer, which presses BTab server-side.
 *   - ⋯ — nothing left to hide behind it.
 *
 * Copy and Paste stayed and moved into the row as icons: 17 taps a month is
 * rare, but on a phone in terminal mode this row is the ONLY route to either
 * (the header's Paste button is `!coarse()`, desktop-only).
 *
 * The row is [scrolling keys] + [pinned ⌨]. The dismiss key is a direct child
 * of `.sk-line` rather than of the scroller, so it can never scroll out of
 * reach on a narrow screen. Measured at 390px: 334px of keys against 336px of
 * room, so nothing scrolls on a phone that size and a narrower one degrades to
 * the edge-faded scroll the row already had.
 *
 * Byte contract: pre-baked bytes (keybytes.ts) go straight to the injected
 * `send` sink. That is where the parent routes them: to the pty via
 * SessionView's `sendBytesToPty`, which calls the `window.__tlSendToTerminal`
 * bridge TerminalNative owns. It was a postMessage into the terminal iframe
 * until 2026-09-05.
 *
 * Wiring disciplines ported verbatim:
 *   - preventDefault on pointerdown for EVERY key (keep focus on the input so
 *     the soft keyboard does not collapse between keystrokes);
 *   - non-repeat keys fire on TAP-COMMIT (pointerup within a 10px travel gate)
 *     so a horizontal row-scroll never misfires a key;
 *   - repeat keys (arrows + Tab) fire on pointerdown then re-fire every 60ms
 *     after a 500ms hold, until up/cancel/leave.
 */

const TAP_COMMIT_MAX_TRAVEL_PX = 10;
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 60;

/**
 * The toolbar element that currently owns `--sk-h`, or null while no row is
 * publishing one.
 *
 * MODULE-LEVEL BECAUSE THE THING BEING OWNED IS. `--sk-h` is one CSS custom
 * property on `documentElement`, and every row that mounts writes it. The
 * property is a STRING and carries no identity of its own, so `lib/ownwhile.ts`'s
 * trick — "restore the previous value only if the handle is still MY value" —
 * cannot be played on it: two rows 44px tall write the same eight characters and
 * neither can tell its own write from the other's. So the identity lives beside
 * the property instead, and it is the element of whichever row claimed it last.
 *
 * WHY A ROW CAN LOSE A RACE IT DOES NOT KNOW IT IS IN. A coarse pointer wider
 * than 720px — a landscape tablet at 1024x768 — sits inside `coarse()` and
 * outside `flip()` (mobile/pointer.ts), so it gets the split view AND this row.
 * `SessionView` mounts the row for the FOCUSED tile only, so moving focus from
 * tile A to tile B unmounts A's row and mounts B's in one update. Which of the
 * two runs first is the order of `App.tsx`'s append-only `<For each={mounted()}>`
 * slot list, not the order focus moved: when B's slot was created EARLIER than
 * A's, B's mount runs first and A's cleanup runs last. A cleanup that wrote
 * "0px" unconditionally then left the page believing there is no soft-key row
 * while B's is on screen — the views above gave the keyboard's room back and
 * their bottom rows slid under a toolbar that is still there.
 *
 * Gating the row on focus (2026-09-12) moved that bug rather than closing it:
 * before, three visible tiles meant three rows and closing any one of them
 * zeroed the property for the other two; after, one row at a time, and every
 * focus change is the same unconditional zero landing last.
 *
 * `mobile/viewport.ts:278` is the other writer and needs no part in this. It
 * measures `document.getElementById("soft-keys")` on every viewport event, so it
 * reads whatever row is actually in the document and converges on its own.
 */
let publisher: Element | null = null;

export interface SoftKeysProps {
  /** Byte sink — receives the pre-baked bytes. */
  send: (bytes: string) => void;
  /** Copy delegate (server-side touch copy / selection copy lives in the parent). */
  onCopy?: () => void;
  /** Paste delegate (image-aware paste lives in the parent). */
  onPaste?: () => void;
  /** Dismiss the soft keyboard (blur the focused input). Pinned ⌨. */
  onDismissKeyboard?: () => void;
  /** Whether hold-to-repeat is enabled (roamed gestures.keyRepeat). Default on. */
  keyRepeat?: () => boolean;
}

interface KeyDef {
  label: string;
  bytes?: KeyName; // pre-baked byte key
  ariaLabel?: string;
  repeat?: boolean;
  narrow?: boolean;
}

export const SoftKeys: Component<SoftKeysProps> = (props) => {
  // ---- send a pre-baked key ----------------------------------------------
  const sendKey = (name: KeyName) => {
    track("terminal.softkey", { "tl.key": name });
    props.send(keyBytes(name));
  };

  // ---- hold-to-repeat (single slot) --------------------------------------
  let repeatDelay: ReturnType<typeof setTimeout> | undefined;
  let repeatTick: ReturnType<typeof setInterval> | undefined;
  const stopRepeat = () => {
    if (repeatDelay) clearTimeout(repeatDelay);
    if (repeatTick) clearInterval(repeatTick);
    repeatDelay = repeatTick = undefined;
  };
  const startRepeat = (fire: () => void) => {
    stopRepeat();
    if (props.keyRepeat && !props.keyRepeat()) return;
    repeatDelay = setTimeout(() => {
      repeatTick = setInterval(fire, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };
  onCleanup(stopRepeat);

  // ---- tap-commit travel guard -------------------------------------------
  // A non-repeat key fires on pointerUP only when the SAME pointer travelled
  // < 10px, so a horizontal row-scroll that happens to start on a button never
  // misfires it. preventDefault on pointerdown keeps focus on the active input
  // (else the soft keyboard collapses between keystrokes).
  const tapCommit = (fire: () => void) => {
    let pending: { id: number; x: number; y: number } | null = null;
    return {
      onPointerDown: (e: PointerEvent) => {
        e.preventDefault();
        pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
      },
      onPointerUp: (e: PointerEvent) => {
        if (!pending || e.pointerId !== pending.id) return;
        const travel = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
        pending = null;
        if (travel >= TAP_COMMIT_MAX_TRAVEL_PX) return; // a swipe, not a tap
        fire();
      },
      onPointerCancel: () => (pending = null),
      onPointerLeave: () => (pending = null),
    };
  };

  // ---- key button (tap-commit vs down-fire) ------------------------------
  const keyButton = (def: KeyDef): JSX.Element => {
    const fire = () => sendKey(def.bytes as KeyName);
    const cls = def.narrow ? "sk-narrow" : "sk-word";

    if (def.repeat) {
      // Repeat keys keep the down-fire path: initial send at pointerdown, then
      // re-fire while held (hold-to-repeat needs the immediate first send).
      return (
        <button
          type="button"
          class={cls}
          aria-label={def.ariaLabel}
          onPointerDown={(e) => {
            e.preventDefault();
            fire();
            startRepeat(fire);
          }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
        >
          {def.label}
        </button>
      );
    }
    const h = tapCommit(fire);
    return (
      <button
        type="button"
        class={cls}
        aria-label={def.ariaLabel}
        onPointerDown={h.onPointerDown}
        onPointerUp={h.onPointerUp}
        onPointerCancel={h.onPointerCancel}
        onPointerLeave={h.onPointerLeave}
      >
        {def.label}
      </button>
    );
  };

  // Tab leads. It is the most-tapped key that is not an arrow (71 taps against
  // Esc's 13 over the 28 days that decided this row), so it gets the end of the
  // row a thumb reaches first (Viktor, 2026-09-06).
  const primaryKeys: KeyDef[] = [
    { label: "Tab", bytes: "tab", ariaLabel: "Tab", repeat: true },
    { label: "Esc", bytes: "esc", ariaLabel: "Escape" },
  ];
  const arrowKeys: KeyDef[] = [
    { label: "↑", bytes: "up", ariaLabel: "Up arrow", repeat: true, narrow: true },
    { label: "↓", bytes: "down", ariaLabel: "Down arrow", repeat: true, narrow: true },
    { label: "←", bytes: "left", ariaLabel: "Left arrow", repeat: true, narrow: true },
    { label: "→", bytes: "right", ariaLabel: "Right arrow", repeat: true, narrow: true },
  ];

  /**
   * Publish this toolbar's live height as `--sk-h`, which is how much room the
   * views above it reserve (app.css, `body.has-soft-keys .tl-views`).
   *
   * A ResizeObserver rather than the viewport listeners alone: the row changes
   * height without any window resize behind it — it re-wraps when a longer
   * label renders, and the text-scale setting moves it. viewport.ts writes the
   * same property from window/visualViewport events, which seeds it before this
   * mounts and zeroes it after; both read the same element, so they agree. On
   * cleanup the toolbar is gone, so the space it was reserving goes back to the
   * views.
   *
   * EVERY WRITE AFTER THE FIRST ONE IS GATED ON STILL BEING {@link publisher},
   * which is what makes two rows overlapping for a tick harmless whichever way
   * round they run. Read the docblock on that variable for the measured case.
   * Three rules, and they are not the same rule:
   *
   *   - the CLAIM is unconditional. The newest row on screen is the one the
   *     keyboard is typing under, so it takes the property from whatever held
   *     it. A claim that deferred to the incumbent would leave the incoming
   *     tile's row unpublished for as long as the outgoing one lingers.
   *   - a RESIZE only lands while we still hold it. A superseded row keeps its
   *     observer until the disposal it is racing reaches it, and a re-wrap in
   *     that window would push a dead row's height over the live one's.
   *   - the RELEASE only lands while we still hold it. This is the bug: the
   *     unconditional "0px" was the loser's, and it arrived last.
   *
   * The cleanup is also registered BEFORE the ResizeObserver branch rather than
   * inside it, which fixes a second thing in the same four lines: the early
   * return for a browser without ResizeObserver used to skip the cleanup
   * entirely, so on a pre-2020 Safari an unmounted row left its height reserved
   * with nothing on screen holding it.
   */
  const measure = (el: HTMLDivElement): void => {
    const root = document.documentElement.style;
    const write = (): void => {
      if (publisher !== el) return; // superseded: the live row owns the value
      root.setProperty("--sk-h", el.offsetHeight + "px");
    };
    publisher = el;
    write();
    onCleanup(() => {
      if (publisher !== el) return; // a newer row has it — leave it alone
      publisher = null;
      root.setProperty("--sk-h", "0px");
    });
    if (typeof ResizeObserver !== "function") return; // older Safari: seed only
    const ro = new ResizeObserver(write);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  return (
    <div id="soft-keys" ref={measure} role="toolbar" aria-label="Terminal keys">
      <div class="sk-line">
        <div class="sk-row sk-primary">
          <div class="sk-group">
            <For each={primaryKeys}>{(k) => keyButton(k)}</For>
          </div>
          <div class="sk-group">
            <For each={arrowKeys}>{(k) => keyButton(k)}</For>
          </div>
          {/* The two clipboard keys carry a caption under the icon. Every other
              key on the row says what it is on its face; a bare rectangle-on-a-
              rectangle does not, and Viktor read the Copy icon as needing a
              selection first (2026-09-06). The caption sits inside the 38px
              button, so the row does not grow. */}
          <div class="sk-group">
            <button
              type="button"
              class="sk-narrow sk-capped"
              // Named for what it does with no selection, which on touch is
              // always: a drag scrolls the terminal by design, so there is
              // never a range, and runCopy falls back to the visible screen.
              aria-label="Copy the visible screen"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                track("terminal.copied", { "tl.kind": "softkey" });
                props.onCopy?.();
              }}
            >
              <CopyIcon size={16} />
              <span class="sk-cap">Copy</span>
            </button>
            <button
              type="button"
              class="sk-narrow sk-capped"
              aria-label="Paste"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                // No terminal.pasted here: the paste routine emits that itself,
                // once it has actually read something, and a paste_failed when
                // the browser refuses. Recording success on the TAP made a
                // refused paste indistinguishable from a completed one — which
                // is exactly the signal this bug needed.
                props.onPaste?.();
              }}
            >
              <ClipboardIcon size={16} />
              <span class="sk-cap">Paste</span>
            </button>
          </div>
        </div>
        <Show when={props.onDismissKeyboard}>
          <button
            type="button"
            class="sk-narrow sk-dismiss"
            aria-label="Dismiss keyboard"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => props.onDismissKeyboard?.()}
          >
            ⌨
          </button>
        </Show>
      </div>
    </div>
  );
};
