/**
 * At most ONE T3 frame in the tab (t3 view design, challenger change 16).
 *
 * The lobby keeps every session you visit mounted for a day
 * (store/keepalive.ts) and shows several at once in a workspace. A T3 frame
 * per mounted session would be a whole T3 client, its WebSocket and its
 * IndexedDB cache for every session ever opened in T3. So the frame goes to
 * one session at a time: each host that would show it asks for it, the most
 * recent ask holds it, and a host that stops wanting it (off screen, back to
 * Text) gives it up, which hands it back to the previous asker if that one
 * still wants it.
 */

import { createSignal, type Accessor } from "solid-js";

export interface FrameClaims {
  /** the key holding the frame, or null when nobody wants it. */
  owner: Accessor<string | null>;
  /** ask for the frame; the latest ask holds it. Asking again moves the key
   *  to the front. */
  claim: (key: string) => void;
  /** stop wanting it. A key that never asked is a no-op. */
  release: (key: string) => void;
}

export function createFrameClaims(): FrameClaims {
  // Oldest ask first; the owner is the last entry.
  const [asks, setAsks] = createSignal<readonly string[]>([]);
  return {
    owner: () => {
      const a = asks();
      return a.length ? a[a.length - 1]! : null;
    },
    claim: (key) => {
      const a = asks();
      if (a[a.length - 1] === key) return;
      setAsks([...a.filter((k) => k !== key), key]);
    },
    release: (key) => {
      const a = asks();
      if (a.includes(key)) setAsks(a.filter((k) => k !== key));
    },
  };
}

/** The tab's one set of claims, shared by every session's T3 host. */
export const t3FrameClaims: FrameClaims = createFrameClaims();
