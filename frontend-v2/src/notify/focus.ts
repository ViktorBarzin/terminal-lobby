/**
 * What this device is looking at, told to the server.
 *
 * The push sender's job is to tell you about work you cannot see, so it needs to
 * know what you CAN see. It used to infer that from tmux's client_activity —
 * "someone typed into this session in the last minute" — which reads an ATTACH
 * as typing, because tmux stamps client_activity when a client is created and
 * only moves it on a real key. The lobby keeps every session you visit mounted
 * for a day (store/keepalive.ts), each holding an attached tmux client, so
 * opening the app minted a fresh false keystroke on all of them at once. Over
 * the four days to 2026-09-06 that held 118 pushes — every held push in the
 * window — four of them while Viktor was asleep. Hence Viktor, 2026-09-06: "I
 * stopped receiving mobile notifications if the app is open. I want to still
 * receive them but only for sessions that I'm not focused on right now."
 *
 * So the page says it outright. The report is PER DEVICE, keyed by this
 * browser's push endpoint, and the server suppresses only for the device that
 * sent it: a desktop watching a session does not silence the phone in your
 * pocket, because you may well walk away from the desk.
 *
 * This module is pure — deciding WHAT to say and WHETHER to say it again. The
 * request lives in pwa/push.ts `reportFocus`, and notifications.ts drives both.
 */

/**
 * How often a standing report is refreshed. Comfortably inside the server's
 * 90-second focusTTL (tmux-api pushfocus.go), so an ordinary slow tick never
 * reads as "looked away", while a page that dies mid-look starts notifying
 * again within a minute and a half.
 */
export const FOCUS_HEARTBEAT_MS = 45_000;

/**
 * How often the reporter wakes to CONSIDER re-sending. Not the report interval —
 * `shouldReport` decides that — this is how finely the heartbeat is chopped, and
 * it must stay well under it or a refresh lands late. It also covers the one
 * case with no event to hang off: a page left open on one session for hours.
 */
export const FOCUS_TICK_MS = 15_000;

/** Everything the answer depends on, read once so the decision stays pure. */
export interface FocusWorld {
  /** !document.hidden */
  visible: boolean;
  /** document.hasFocus() — a visible but unfocused window is not being read. */
  focused: boolean;
  /** the session on screen, or null for the lobby list. */
  selected: string | null;
}

/**
 * What to report. `""` means "showing no session", which silences nothing — the
 * honest answer for the lobby list, a backgrounded tab, and a window sitting
 * behind another one.
 */
export function focusedSession(world: FocusWorld): string {
  if (!world.visible || !world.focused) return "";
  return world.selected ?? "";
}

/** The last report this device made. */
export interface FocusReport {
  session: string;
  /** epoch ms when it was sent. */
  at: number;
}

/**
 * Whether to send again.
 *
 * A change always goes out at once — including a change TO `""`, which is how
 * looking away is announced rather than waited out. A standing report is
 * refreshed on the heartbeat so it does not go stale under the server's TTL.
 *
 * `""` is never heartbeated: an absent record and a `""` record mean the same
 * thing to the server, so a backgrounded tab has nothing to keep saying (and
 * browsers throttle its timers anyway).
 */
export function shouldReport(
  prev: FocusReport | null,
  next: string,
  now: number,
  heartbeatMs: number = FOCUS_HEARTBEAT_MS,
): boolean {
  if (prev === null) return next !== "";
  if (prev.session !== next) return true;
  return next !== "" && now - prev.at >= heartbeatMs;
}
