/**
 * Settings that belong to THIS BROWSER rather than to the account.
 *
 * The roamed doc (`store/prefs.ts`, `/prefs`) is the right home for anything
 * that should follow you between devices. These two deliberately do not:
 *
 *  - **Flow control** is a kill switch for the terminal's XON/XOFF back-
 *    pressure. It exists to rescue a wedged stream on the machine that is
 *    wedged, so roaming it would carry a local rescue to every device.
 *  - **Clear local data** is an action on this browser's storage.
 *
 * Both keep the plain `tl-` key names the vanilla page used, because the
 * terminal iframe is the reader and it is same-origin: it picks a flip up from
 * a `storage` event, which fires there precisely because ANOTHER window (the
 * lobby) wrote the key.
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
