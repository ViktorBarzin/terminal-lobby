/**
 * Foreground OS-notification transitions (inventory Cat.9, high-risk).
 *
 * Ported from the vanilla frontend's `notifyTransitions`: each `/sessions` poll
 * is compared against the previous poll's state map, and a notification fires on
 * a session's transition INTO a notable state. Two edges, deliberately
 * asymmetric (matching the server's pushsender.go so foreground + background
 * push agree):
 *
 *   - running→awaiting  ("<s> needs input")  — also fires when a session is
 *     first SEEN already awaiting (was === undefined), so a backgrounded lobby
 *     that missed the transition still announces; only an awaiting→awaiting
 *     repeat is skipped (the tag would merely re-fire).
 *   - running→done      ("<s> finished")     — STRICTER: only a genuine
 *     running→done turn completion fires. A freshly-seen done session
 *     (was === undefined) and a SessionStart→done never announce.
 *
 * The PER-SESSION away gate (Viktor's "I orchestrate in the lobby, sessions
 * finish, I get the in-app toast but nothing on the desktop" fix): while the tab
 * is focused, only the session you are LOOKING at (the active one) stays quiet —
 * every other session still raises an OS notification. When away (hidden or
 * unfocused) every session notifies.
 *
 * This module is PURE (no Notification/permission/opt-in checks): those are
 * all-or-nothing browser gates the caller applies as an early return, exactly as
 * the vanilla code did (it advanced `prevStates` and THEN checked opt-in). The
 * caller must therefore advance the snapshot (via `snapshotStates`) on EVERY
 * poll regardless of the gates, so opting in later doesn't replay a backlog.
 */

/** The state discriminator per session; "" when no live Claude. */
export type SessionLike = { name: string; state?: string };

/** name → state ("" when none) at a poll. */
export type StateMap = Map<string, string>;

/** One notification to fire. */
export interface Transition {
  session: string;
  kind: "awaiting" | "done";
}

/** Per-poll gate inputs (all pure booleans/values). */
export interface TransitionGate {
  /** document.hidden || !document.hasFocus() at fire time. */
  away: boolean;
  /** the session currently on screen (quiet while focused), or null. */
  activeSession: string | null;
  /** roamed notify.onAwaiting (default true). */
  onAwaiting: boolean;
  /** roamed notify.onDone (default true). */
  onDone: boolean;
}

/** Snapshot the current poll's states — the map to carry into the next call. */
export function snapshotStates(sessions: readonly SessionLike[]): StateMap {
  return new Map(sessions.map((s) => [s.name, s.state || ""]));
}

/**
 * Compute which sessions should raise an OS notification this poll.
 *
 * `prev === null` is the first-poll seed and returns [] (announce nothing —
 * a (re)loaded background tab must not re-declare long-standing states).
 */
export function computeTransitions(
  prev: StateMap | null,
  sessions: readonly SessionLike[],
  gate: TransitionGate,
): Transition[] {
  if (prev === null) return []; // first poll after load seeds quietly
  const out: Transition[] = [];
  for (const s of sessions) {
    const was = prev.get(s.name);
    const cur = s.state || "";
    // Focused + this is the session on screen → the user is watching it happen;
    // no OS notification. Everything else (hidden, unfocused, or a background
    // session while focused) notifies.
    if (!gate.away && gate.activeSession !== null && s.name === gate.activeSession) {
      continue;
    }
    if (cur === "awaiting" && was !== "awaiting") {
      if (gate.onAwaiting) out.push({ session: s.name, kind: "awaiting" });
    } else if (cur === "done" && was === "running") {
      if (gate.onDone) out.push({ session: s.name, kind: "done" });
    }
  }
  return out;
}
