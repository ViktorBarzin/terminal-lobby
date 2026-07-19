import { createSignal, type Accessor } from "solid-js";
import {
  altLabel as altLabelFor,
  KB_KEY,
  matchesAppChord as matchesAppChordPure,
  normalizeKeybindings,
  resolveAlways,
  resolveBindings,
  type KbDoc,
  type ResolvedBinding,
} from "./bindings.logic";
import type { ChordEventLike } from "./chords.logic";

/**
 * The keybinding ENGINE — the DOM glue around the pure bindings.logic layer
 * (feature-inventory Cat.2 "Keybinding engine"). A faithful port of the vanilla
 * frontend/index.html `tlKb` object (index.html:3303-3553): it owns the
 * `tl:keybindings:v1` document (per-browser localStorage, cross-window `storage`
 * sync), installs exactly ONE capture-phase window `keydown` that
 * `preventDefault()`s only on an exact chord match while enabled and runs the
 * command, plus the Alt tracker legs (keyup + window blur) that drive the
 * Alt-hold badge overlay.
 *
 * It does NOT stopPropagation — in the vanilla app the same event still had to
 * reach xterm's merged handler; here the terminal is a cross-document iframe so
 * lobby keydowns never reach it anyway, but the non-stopping posture is kept so
 * other capture-phase listeners (the "/"/"?" help opener, the view-toggle) still
 * see non-chord keys.
 */
export interface KeybindingEngine {
  /** the opt-in gate (reactive; drives the Settings toggle + Alt badges). */
  enabled: Accessor<boolean>;
  setEnabled: (on: boolean) => void;
  /** true once Alt has been held ~100ms while enabled (badge overlay trigger). */
  altActive: Accessor<boolean>;
  /** platform-localized modifier label ("Option" on Mac, else "Alt"). */
  altLabel: string;
  isMac: boolean;
  /** the shared match decision point (exposed for parity / future xterm merge). */
  matchesAppChord: (e: ChordEventLike) => ResolvedBinding | null;
  /** feed the terminal iframe's Alt state up (tl-kb-alt), for the badge overlay. */
  setFrameAlt: (down: boolean) => void;
  /** wire the context + command runner, then install the window listeners. */
  init: (opts: {
    getContext: () => Record<string, boolean>;
    runCommand: (cmd: string) => void;
  }) => void;
  dispose: () => void;
}

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

function readKbDoc(): KbDoc {
  try {
    return normalizeKeybindings(JSON.parse(lsGet(KB_KEY) ?? "null"));
  } catch {
    return normalizeKeybindings(null);
  }
}

function detectMac(): boolean {
  try {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform || navigator.platform || "";
    return /mac/i.test(p);
  } catch {
    return false;
  }
}

export function createKeybindingEngine(): KeybindingEngine {
  const isMac = detectMac();
  let doc = readKbDoc();
  const [enabled, setEnabledSig] = createSignal(doc.enabled);
  let resolvedDefaults = resolveBindings(doc.overrides);
  const resolvedAlways = resolveAlways();

  let getContextFn: (() => Record<string, boolean>) | null = null;
  let runCommandFn: ((cmd: string) => void) | null = null;

  function refresh(): void {
    doc = readKbDoc();
    resolvedDefaults = resolveBindings(doc.overrides);
    setEnabledSig(doc.enabled);
  }

  function matchesAppChord(e: ChordEventLike): ResolvedBinding | null {
    return matchesAppChordPure(e, {
      enabled: enabled(),
      resolvedDefaults,
      resolvedAlways,
      ctx: getContextFn ? getContextFn() : {},
    });
  }

  // ---- Alt-hold badge tracker (syncAltBadges port) ------------------------
  let lobbyAltDown = false;
  let frameAltDown = false;
  let altTimer: ReturnType<typeof setTimeout> | undefined;
  let altOn = false;
  const [altActive, setAltActive] = createSignal(false);

  function syncAlt(): void {
    const want = enabled() && (lobbyAltDown || frameAltDown);
    if (want) {
      if (altOn || altTimer) return;
      altTimer = setTimeout(() => {
        altTimer = undefined;
        if (enabled() && (lobbyAltDown || frameAltDown)) {
          altOn = true;
          setAltActive(true);
        }
      }, 100);
    } else {
      if (altTimer) {
        clearTimeout(altTimer);
        altTimer = undefined;
      }
      if (altOn) {
        altOn = false;
        setAltActive(false);
      }
    }
  }

  function trackAlt(e: KeyboardEvent): void {
    if (!enabled()) {
      lobbyAltDown = false;
      syncAlt();
      return;
    }
    if (e.key === "Alt") lobbyAltDown = e.type === "keydown";
    else lobbyAltDown = !!e.altKey;
    syncAlt();
  }
  function setFrameAlt(down: boolean): void {
    frameAltDown = down;
    syncAlt();
  }

  // ---- window listeners ---------------------------------------------------
  const onKeydown = (e: KeyboardEvent): void => {
    trackAlt(e);
    const b = matchesAppChord(e);
    if (!b) return;
    e.preventDefault(); // ONLY on an exact chord match while enabled/in-context
    runCommandFn?.(b.command);
  };
  const onKeyup = (e: KeyboardEvent): void => trackAlt(e);
  const onBlur = (): void => {
    lobbyAltDown = false;
    frameAltDown = false;
    syncAlt();
  };
  const onStorage = (e: StorageEvent): void => {
    if (e.key === KB_KEY) refresh();
  };

  let installed = false;
  function init(opts: {
    getContext: () => Record<string, boolean>;
    runCommand: (cmd: string) => void;
  }): void {
    getContextFn = opts.getContext;
    runCommandFn = opts.runCommand;
    if (installed || typeof window === "undefined") return;
    installed = true;
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("keyup", onKeyup, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("storage", onStorage);
  }

  function setEnabled(on: boolean): void {
    const next: KbDoc = { enabled: !!on, overrides: doc.overrides };
    lsSet(KB_KEY, JSON.stringify(next));
    refresh();
    syncAlt(); // a disable must drop any live badges
  }

  function dispose(): void {
    if (altTimer) clearTimeout(altTimer);
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("storage", onStorage);
  }

  return {
    enabled,
    setEnabled,
    altActive,
    altLabel: altLabelFor(isMac),
    isMac,
    matchesAppChord,
    setFrameAlt,
    init,
    dispose,
  };
}
