import {
  createSignal,
  onCleanup,
  For,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import {
  applyMods,
  consumeSoftMods,
  idleMods,
  revertArmed,
  tapMod,
  DOUBLE_TAP_MS,
  type ModName,
  type ModState,
  type SoftMods,
} from "../mobile/softmods";
import { keyBytes, type KeyName } from "../mobile/keybytes";

/**
 * Mobile soft-key toolbar (design pillar #2 — Mobile/Touch), ported from the
 * vanilla frontend/index.html `#soft-keys` (~10869-11421). Coarse-pointer only;
 * the parent mounts it and reserves a REAL CSS height via `body.has-soft-keys`
 * so the surface above it shrinks (FitAddon-honest for the terminal iframe).
 *
 * Two tiers (IR.3 layout):
 *   - always-visible `.sk-line` = the primary row (Esc ⇧Tab · arrows) + the
 *     pinned ⋯ overflow toggle + the pinned ⌨ keyboard-dismiss, both direct
 *     children so they can never scroll out of reach;
 *   - `.sk-extra` overflow tier (⋯-toggled) = Tab · Ctrl · Alt / glyphs / Copy ·
 *     Paste.
 *
 * Byte contract: pre-baked bytes (keybytes.ts) run through `applyMods` (the
 * armed/latched Ctrl/Alt remap) then the injected `send` sink, then
 * `consumeSoftMods` drops one-shot modifiers. The sink is where the parent
 * routes bytes — to the terminal iframe (postMessage bridge) or the composer.
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
const KEY_ROW_EXPANDED_KEY = "tl:input.keyRowExpanded:v1";

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / no storage */
  }
}

export interface SoftKeysProps {
  /** Byte sink — receives the FINAL bytes (modifier remap already applied). */
  send: (bytes: string) => void;
  /** Copy delegate (server-side touch copy / selection copy lives in the parent). */
  onCopy?: () => void;
  /** Paste delegate (image-aware paste lives in the parent). */
  onPaste?: () => void;
  /** Dismiss the soft keyboard (blur the focused input). Pinned ⌨ + row key. */
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
  const [mods, setMods] = createSignal<SoftMods>(idleMods());
  const [expanded, setExpanded] = createSignal(
    lsGet(KEY_ROW_EXPANDED_KEY) === "1",
  );

  // ---- modifier machine (tri-state + 400ms double-tap auto-revert) --------
  const modTimers: Record<ModName, ReturnType<typeof setTimeout> | undefined> = {
    ctrl: undefined,
    alt: undefined,
  };
  const onTapMod = (name: ModName) => {
    if (modTimers[name]) clearTimeout(modTimers[name]);
    const next = tapMod(mods(), name);
    setMods(next);
    if (next[name] === "armed") {
      // Auto-revert to idle if no second tap latches within the window.
      modTimers[name] = setTimeout(() => {
        setMods(revertArmed(mods(), name));
      }, DOUBLE_TAP_MS);
    }
  };
  onCleanup(() => {
    if (modTimers.ctrl) clearTimeout(modTimers.ctrl);
    if (modTimers.alt) clearTimeout(modTimers.alt);
  });

  // ---- send a pre-baked key: applyMods → sink → consume -------------------
  const sendKey = (name: KeyName) => {
    const raw = keyBytes(name);
    props.send(applyMods(raw, mods()));
    setMods(consumeSoftMods(mods()));
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

  // ---- tap-commit travel guard (shared by key + modifier buttons) --------
  // A non-repeat key/modifier fires on pointerUP only when the SAME pointer
  // travelled < 10px, so a horizontal row-scroll that happens to start on a
  // button never misfires it. preventDefault on pointerdown keeps focus on the
  // active input (else the soft keyboard collapses between keystrokes).
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
    const cls = def.narrow ? "sk-narrow" : undefined;

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

  // A modifier button reflects armed/latched from the signal (data-mod so tests
  // and CSS can find it). Tap-commit toggles the tri-state (no focus change, no
  // repeat) so a scroll starting on Ctrl/Alt never arms it accidentally.
  const modButton = (name: ModName, label: string): JSX.Element => {
    const state = (): ModState => mods()[name];
    const h = tapCommit(() => onTapMod(name));
    return (
      <button
        type="button"
        class="sk-mod"
        data-mod={name}
        aria-label={`${label} modifier`}
        aria-pressed={state() !== "idle"}
        classList={{ armed: state() === "armed", latched: state() === "latched" }}
        onPointerDown={h.onPointerDown}
        onPointerUp={h.onPointerUp}
        onPointerCancel={h.onPointerCancel}
        onPointerLeave={h.onPointerLeave}
      >
        {label}
      </button>
    );
  };

  const glyphButton = (label: string, bytes: KeyName): JSX.Element =>
    keyButton({ label, bytes, narrow: true });

  const toggleExpanded = () => {
    const next = !expanded();
    setExpanded(next);
    lsSet(KEY_ROW_EXPANDED_KEY, next ? "1" : "0");
  };

  const primaryKeys: KeyDef[] = [
    { label: "Esc", bytes: "esc", ariaLabel: "Escape" },
    { label: "⇧Tab", bytes: "backTab", ariaLabel: "Shift+Tab (back-tab)" },
  ];
  const arrowKeys: KeyDef[] = [
    { label: "↑", bytes: "up", ariaLabel: "Up arrow", repeat: true, narrow: true },
    { label: "↓", bytes: "down", ariaLabel: "Down arrow", repeat: true, narrow: true },
    { label: "←", bytes: "left", ariaLabel: "Left arrow", repeat: true, narrow: true },
    { label: "→", bytes: "right", ariaLabel: "Right arrow", repeat: true, narrow: true },
  ];

  return (
    <div
      id="soft-keys"
      role="toolbar"
      aria-label="Terminal keys"
      classList={{ expanded: expanded() }}
    >
      {/* Overflow tier — ⋯-toggled, stacked ABOVE the always-visible line. */}
      <div class="sk-row sk-extra">
        <div class="sk-group">
          {keyButton({ label: "Tab", bytes: "tab", repeat: true })}
          {modButton("ctrl", "Ctrl")}
          {modButton("alt", "Alt")}
        </div>
        <div class="sk-sep" />
        <div class="sk-group">
          <button
            type="button"
            aria-label="Copy"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => props.onCopy?.()}
          >
            Copy
          </button>
          <button
            type="button"
            aria-label="Paste"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => props.onPaste?.()}
          >
            Paste
          </button>
        </div>
        <div class="sk-sep" />
        <div class="sk-group">
          {glyphButton("/", "slash")}
          {glyphButton("-", "dash")}
          {glyphButton("|", "pipe")}
          {glyphButton("`", "backtick")}
        </div>
      </div>

      {/* Always-visible line: scrolling primary row + pinned ⋯ + pinned ⌨. */}
      <div class="sk-line">
        <div class="sk-row sk-primary">
          <div class="sk-group">
            <For each={primaryKeys}>{(k) => keyButton(k)}</For>
          </div>
          <div class="sk-group">
            <For each={arrowKeys}>{(k) => keyButton(k)}</For>
          </div>
        </div>
        <button
          type="button"
          class="sk-narrow sk-more"
          aria-label="More keys"
          aria-pressed={expanded()}
          classList={{ armed: expanded() }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={toggleExpanded}
        >
          ⋯
        </button>
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
