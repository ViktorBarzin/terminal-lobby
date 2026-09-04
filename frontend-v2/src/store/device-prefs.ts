/**
 * Settings that belong to THIS BROWSER rather than to the account.
 *
 * The roamed doc (`store/prefs.ts`, `/prefs`) is the right home for anything
 * that should follow you between devices. These three deliberately do not:
 *
 *  - **Flow control** is a kill switch for the terminal's XON/XOFF back-
 *    pressure. It exists to rescue a wedged stream on the machine that is
 *    wedged, so roaming it would carry a local rescue to every device.
 *  - **The gestures master kill** is the same shape for touch and wheel
 *    gestures, and rescues the device it is set on for the same reason.
 *  - **Clear local data** is an action on this browser's storage.
 *
 * The two kill switches keep the plain `tl-` key names the vanilla page used,
 * because the terminal iframe is a reader too and it is same-origin: it picks a
 * flip up from a `storage` event, which fires there precisely because ANOTHER
 * window (the lobby) wrote the key.
 */

import { PREFS_PATH } from "../lib/config";
import { apiUrl } from "../lib/config";
import { PREF_DEFAULTS, composeDoc } from "./prefs";

/** Terminal flow control (XON/XOFF back-pressure). "off" disables it here. */
export const FLOW_KILL_KEY = "tl-flow-control";

/** True unless this browser has explicitly turned flow control off. Matches
 *  term.html's own test (`!== 'off'`), so any other value reads as enabled. */
export function flowControlWanted(): boolean {
  try {
    return localStorage.getItem(FLOW_KILL_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setFlowControlEnabled(on: boolean): void {
  try {
    // Re-enabling removes the key rather than writing "on": the reader only
    // looks for "off", so a leftover value would work but would leave the
    // stored state describing something nobody reads.
    if (on) localStorage.removeItem(FLOW_KILL_KEY);
    else localStorage.setItem(FLOW_KILL_KEY, "off");
  } catch {
    /* private mode — the setting simply does not stick */
  }
}

/**
 * The Wave-5 gestures master kill: `"off"` in this browser turns off every
 * touch and wheel gesture built on top of it.
 *
 * term.html gives it the same posture as flow control in as many words
 * (:3078-3086): a plain per-browser key where anything other than `"off"`,
 * unset included, means enabled, so it can rescue a device with no redeploy and
 * even with the prefs machinery broken. That is what keeps it out of the roamed
 * doc. The per-feature opt-outs under `tl:prefs:v1` `gestures.*` are checked IN
 * ADDITION to this one, never instead of it.
 *
 * There is no setter, because nothing writes this key. term.html only reads it
 * (`gesturesEnabled`, :3163-3166) and watches for another window changing it
 * (:7585-7586); a person sets it by hand when a gesture is misbehaving.
 *
 * READ IT FRESH at every use, never cached. term.html's `wheelSmoothOn`
 * (:6203-6205) calls its own `gesturesEnabled` from inside the wheel handler on
 * every event (:6238), so a flip takes effect on the next wheel without a
 * reload, and `terminal/wheel.ts` asks for its `smoothOn` on every wheel for
 * the same reason.
 *
 * One path deliberately does not consult it: the one-finger touch scroller
 * (`terminal/touchscroll.ts` says so at length), because a finger has no other
 * way to scroll a terminal. term.html gates the desktop smooth wheel (:6204)
 * and the multi-touch registry (:6425) and nothing in that path.
 */
export const GESTURES_KILL_KEY = "tl-gestures";

export function gesturesEnabled(): boolean {
  try {
    return localStorage.getItem(GESTURES_KILL_KEY) !== "off";
  } catch {
    // A browser that refuses storage keeps its gestures rather than losing
    // them, which is the answer term.html's own `catch` gives.
    return true;
  }
}

/** Every localStorage prefix this app owns. Anything else on the origin is
 *  somebody else's and is left alone. */
const OWNED_PREFIXES = ["tl:", "tl-", "tmux-"];

export interface ClearLocalDataOptions {
  /** Also PUT the default doc to /prefs, resetting the account's roamed
   *  settings on every other device too. */
  alsoRoamed: boolean;
  /** Injected in tests; defaults to a real reload. */
  reload?: () => void;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
  /** Called when the roamed reset fails; the local wipe still proceeds. */
  onError?: (message: string) => void;
}

/**
 * Wipe this browser's terminal-lobby storage and reload.
 *
 * The roamed half is attempted FIRST and its failure is non-fatal: the local
 * wipe is the part the user asked for and the part we can guarantee, so a
 * server that is down must not leave them with neither.
 *
 * tmux sessions are untouched — this is browser storage only.
 */
export async function clearLocalData(opts: ClearLocalDataOptions): Promise<void> {
  const reload =
    opts.reload ?? (() => window.location.replace(window.location.pathname));

  if (opts.alsoRoamed) {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    try {
      // The DEFAULTS, not {}. An empty document would leave the account with no
      // stored settings at all, and the next device to adopt it would get
      // whatever its own local doc happened to hold rather than a clean slate.
      const resp = await doFetch(apiUrl(PREFS_PATH), {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(composeDoc({}, PREF_DEFAULTS)),
      });
      if (!resp.ok) throw new Error("HTTP error");
    } catch (e) {
      opts.onError?.(
        `Could not reset roamed settings (${
          e instanceof Error ? e.message : "failed"
        }) — clearing this browser only`,
      );
    }
  }

  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && OWNED_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* keep going: one failed key must not strand the rest */
      }
    }
  } catch {
    /* storage unavailable */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ditto */
  }
  reload();
}
