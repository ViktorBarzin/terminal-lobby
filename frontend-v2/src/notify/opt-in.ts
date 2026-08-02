
import { track } from "../telemetry/track";/**
 * Per-browser notification opt-in (inventory Cat.9). The bell toggle is the ONLY
 * place OS-notification permission is requested; this is the local flag it
 * persists. Deliberately per-BROWSER (localStorage `tl:notify:v1`, the same key
 * the vanilla app uses) not roamed: enabling notifications is a per-device
 * decision (you may want them on your laptop but not a shared box), and it is
 * gated by that device's OS permission anyway.
 */
export const NOTIFY_KEY = "tl:notify:v1";

export function notifyOptedIn(): boolean {
  try {
    return typeof localStorage !== "undefined" &&
      localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotifyOptIn(on: boolean): void {
  track("notify.opt_in", { "tl.to": on });
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
  } catch {
    /* private mode / no storage */
  }
}
