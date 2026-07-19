/**
 * Attention latch/clear (inventory Cat.9, high-risk). Ported from the vanilla
 * frontend's attention system — the lobby-owned tab signal driven by the
 * terminal iframe's `tl-attention` messages (bell / output-while-hidden).
 *
 * Two latches:
 *   - `session` — the '● <name>' title prefix (attention.ts feeds title.ts).
 *   - `bell`    — the favicon 'done' badge (feeds favicon.ts's faviconKind).
 *
 * The load-bearing rule: a signal latches ONLY while the tab is `away` (hidden
 * or unfocused). A visible, focused tab already shows the terminal, so a badge
 * set then could only clear on the NEXT focus event — i.e. stick around. Both
 * latches clear together on the return to visibility/focus.
 *
 * Pure + unit-tested. The caller (notifications.ts) holds this as a signal, calls
 * `applyAttentionSignal` on each iframe message and `clearAttention` on
 * visibility/focus, and repaints title + favicon from the result. NAME_RE anti-
 * spoof lives here so a malformed session name falls back to the active session
 * (never trusted into the title verbatim).
 */
import { NAME_RE } from "../types/lobby";

export interface AttentionState {
  /** the session name latched for the '● <name>' title prefix, or null. */
  session: string | null;
  /** whether a bell has latched the favicon 'done' badge. */
  bell: boolean;
}

export const emptyAttention: AttentionState = { session: null, bell: false };

export interface AttentionSignal {
  /** 'bell' also latches the favicon badge; 'output' only the title prefix. */
  kind: "bell" | "output";
  /** the session the iframe reported (validated here), or null. */
  session: string | null;
  /** document.hidden || !document.hasFocus() when the signal arrived. */
  away: boolean;
  /** the active session, used when the reported name is missing/invalid. */
  activeSession: string | null;
}

/**
 * Fold one iframe attention signal into the latch state. A signal while the tab
 * is NOT away is ignored (returns the same state object). A bell sets the bell
 * latch; both kinds set the session prefix (validated, else active fallback).
 */
export function applyAttentionSignal(
  state: AttentionState,
  signal: AttentionSignal,
): AttentionState {
  if (!signal.away) return state; // latch only while hidden/unfocused
  const name =
    signal.session && NAME_RE.test(signal.session)
      ? signal.session
      : signal.activeSession;
  const nextBell = state.bell || signal.kind === "bell";
  if (state.session === name && state.bell === nextBell) return state; // no-op
  return { session: name, bell: nextBell };
}

/** Clear both latches (visibility/focus return). Identity when already clear. */
export function clearAttention(state: AttentionState): AttentionState {
  if (!state.session && !state.bell) return state;
  return emptyAttention;
}
