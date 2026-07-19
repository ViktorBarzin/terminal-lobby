/**
 * One-shot(armed) / double-tap(latched) soft modifier machine — the pure logic
 * behind the mobile toolbar's Ctrl / Alt keys, ported from the vanilla
 * frontend/index.html (`softMods` + `tapMod` + `consumeSoftMods`, ~10869-10947,
 * and the `term.onData` remap wrapper ~12331-12354).
 *
 * A physical Ctrl/Alt does not exist on a phone soft keyboard, so the toolbar
 * fakes them with a tri-state per modifier:
 *
 *   idle → (tap) → armed → (tap within the double-tap window) → latched
 *          armed → (window elapses) → idle          [revertArmed, timer-driven]
 *          latched → (tap) → idle
 *
 * `armed` applies to exactly ONE following key then drops (one-shot);
 * `latched` sticks until tapped off (caps-lock style). `consumeSoftMods` is
 * called after every normal key: it drops `armed` back to idle and leaves
 * `latched` alone. `applyMods` performs the byte remap (Ctrl → C0 control char,
 * Alt → ESC-prefix) on the first char of an input string.
 *
 * All functions are PURE (no timers, no DOM): the 400ms auto-revert is a UI
 * concern the component drives with a real setTimeout calling `revertArmed`.
 * This split keeps the whole state machine unit-testable.
 */

export type ModState = "idle" | "armed" | "latched";
export type ModName = "ctrl" | "alt";

export interface SoftMods {
  ctrl: ModState;
  alt: ModState;
}

/** The double-tap window (ms): a second tap inside it latches; else armed reverts. */
export const DOUBLE_TAP_MS = 400;

/** A fresh, all-idle modifier set. */
export function idleMods(): SoftMods {
  return { ctrl: "idle", alt: "idle" };
}

/** True when the modifier will affect the next key (armed OR latched). */
export function modActive(s: ModState): boolean {
  return s !== "idle";
}

/**
 * Advance one modifier through the tap cycle:
 *   idle → armed, armed → latched, latched → idle.
 * Returns a NEW SoftMods (the input is not mutated).
 */
export function tapMod(mods: SoftMods, name: ModName): SoftMods {
  const cur = mods[name];
  const next: ModState =
    cur === "idle" ? "armed" : cur === "armed" ? "latched" : "idle";
  return { ...mods, [name]: next };
}

/**
 * The double-tap timer body: if the modifier is STILL armed when the window
 * elapses, drop it back to idle; a latch or a clear that happened first is left
 * untouched. Pure so the timer's effect is testable without waiting.
 */
export function revertArmed(mods: SoftMods, name: ModName): SoftMods {
  return mods[name] === "armed" ? { ...mods, [name]: "idle" } : mods;
}

/**
 * Called after a normal key is sent: consume ONE-SHOT (armed → idle) modifiers,
 * leave latched ones sticky. Returns a new SoftMods.
 */
export function consumeSoftMods(mods: SoftMods): SoftMods {
  const drop = (s: ModState): ModState => (s === "armed" ? "idle" : s);
  return { ctrl: drop(mods.ctrl), alt: drop(mods.alt) };
}

/**
 * Remap the FIRST character of `data` for the active modifiers, exactly like the
 * vanilla onData wrapper:
 *   - Ctrl active + first char is an ASCII letter → C0 control (`& 0x1f`)
 *     (e.g. Ctrl + "c" → 0x03 = ^C / SIGINT).
 *   - Alt active → prefix the (possibly Ctrl-mapped) first char with ESC (\x1b),
 *     the xterm/tmux meta convention.
 * Only the first char is transformed; the rest of `data` is appended verbatim.
 * No active modifier (or empty input) → `data` returned unchanged.
 */
export function applyMods(data: string, mods: SoftMods): string {
  if (!data) return data;
  const ctrlActive = mods.ctrl !== "idle";
  const altActive = mods.alt !== "idle";
  if (!ctrlActive && !altActive) return data;

  const first = data.charAt(0);
  const rest = data.slice(1);
  let mapped = first;
  if (ctrlActive && /^[a-zA-Z]$/.test(first)) {
    mapped = String.fromCharCode(first.toLowerCase().charCodeAt(0) & 0x1f);
  }
  if (altActive) mapped = "\x1b" + mapped;
  return mapped + rest;
}
