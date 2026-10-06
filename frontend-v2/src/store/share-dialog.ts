import { createSignal } from "solid-js";

/**
 * Which session the Share dialog is open for, or null while it is closed.
 *
 * Held here rather than in the card that opens it because a card does not
 * survive a rename: the session list is reconciled by name, and the rename
 * that lands seconds after a create (ADR-0022) remounts the row. A dialog
 * owned by the row would vanish with it, taking a freshly minted URL that
 * cannot be shown again. App mounts the dialog once, and it finds its session
 * by tmux's id, which a rename keeps.
 */
export interface ShareTarget {
  /** tmux's session id ($12). Absent from a server that predates it. */
  id?: string;
  /** The name when the dialog opened; the fallback when there is no id. */
  name: string;
}

const [target, setTarget] = createSignal<ShareTarget | null>(null);

export const shareTarget = target;

export function openShare(t: ShareTarget): void {
  setTarget(t);
}

export function closeShare(): void {
  setTarget(null);
}
