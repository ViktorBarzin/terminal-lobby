import { createEffect } from "solid-js";

/**
 * Messages typed at a session that is still waking up.
 *
 * Clicking a suspended row asks tmux-api to respawn its pane with `claude
 * --resume <uuid>`. That takes 1.7s on an empty transcript and 3.1s on a 24MB
 * one, and the 5-second session poll is what finally reports the session live
 * — so for a few seconds the composer is on screen over a frozen scrollback
 * that looks exactly like a live session. A prompt posted in that window goes
 * to session-events, which injects it into a pane with no claude in it, and it
 * is gone. Nothing errors.
 *
 * So it is HELD here instead, and sent when the poll says the session is back.
 *
 * WHOLE MESSAGES, NEVER KEYSTROKES. `terminal/held.ts` holds individual bytes
 * for a dropped socket and deliberately has nothing to do with this: a raw key
 * replayed into a shell that has moved on runs against a prompt nobody typed
 * at, which is the failure that file's TTL exists to bound. A message is one
 * thing a person wrote, on purpose, and either it lands whole or it is still
 * here.
 *
 * MODULE STATE, NOT A STORE. Two things read it — the send path and the flush
 * effect — and they are in the same component but built at different moments,
 * so threading an instance between them would mean a context for a Map. It is
 * not persisted: a message held here has left the composer (and with it the
 * localStorage draft), so a tab closed during the two seconds a resume takes
 * loses it. That window is small enough to accept and small enough to state.
 */

/**
 * How many messages one session may have waiting.
 *
 * A resume is seconds, so reaching this means something is wrong — a resume
 * that never landed, a person pasting a script into a dead session — and a
 * queue that grew without bound would eventually replay a wall of prompts into
 * a session that woke up minutes ago. The oldest goes.
 */
export const MAX_HELD_PER_SESSION = 8;

const held = new Map<string, string[]>();

/** Keep this message until the session can take it. */
export function holdForSuspended(session: string, text: string): void {
  if (!text.trim()) return;
  const q = held.get(session) ?? [];
  q.push(text);
  while (q.length > MAX_HELD_PER_SESSION) q.shift();
  held.set(session, q);
}

/** What is waiting for this session, oldest first. */
export function heldFor(session: string): readonly string[] {
  return held.get(session) ?? [];
}

/** Hand the messages over and forget them. */
export function releaseHeld(session: string): readonly string[] {
  const q = held.get(session) ?? [];
  held.delete(session);
  return q;
}

/** Throw away what a session will never receive — it was killed, or the person
 *  took it back. */
export function dropHeld(session: string): void {
  held.delete(session);
}

/** Put messages back at the FRONT: a flush that stopped part-way owes the rest
 *  their place in the order they were written in. */
function returnHeld(session: string, texts: readonly string[]): void {
  if (texts.length === 0) return;
  const q = held.get(session) ?? [];
  held.set(session, [...texts, ...q].slice(-MAX_HELD_PER_SESSION));
}

/**
 * Move a rename's worth of held messages to the name the session now has.
 *
 * INSURANCE rather than a live path with today's caller: `SessionView` reads
 * `props.session` once at mount, and a renamed session arrives as a new view
 * under a new key. It is here because the accessor in
 * {@link FlushWhenAwakeOptions} says a name may change, and a helper that
 * quietly dropped somebody's writing when it did would be worse than five
 * lines — tmux-api does rename a session out from under whoever is holding its
 * name (ADR-0022).
 */
function carryHeld(from: string, to: string): void {
  const q = held.get(from);
  if (!q || from === to) return;
  held.delete(from);
  held.set(to, [...q, ...(held.get(to) ?? [])].slice(-MAX_HELD_PER_SESSION));
}

/** Forget everything (tests). */
export function resetHeld(): void {
  held.clear();
}

/**
 * Send what was held, in the order it was written.
 *
 * STOPS ON THE FIRST REFUSAL and puts the rest back. `send` resolves false for
 * a prompt the session would not take (5xx, unreachable) and has already said
 * so in a toast; sending the next one after that would be shouting into the
 * same hole, and dropping them would lose a person's writing silently. They
 * stay held, which is the only answer that keeps the text.
 */
async function flushHeld(session: string, send: (text: string) => Promise<boolean>): Promise<void> {
  const queued = releaseHeld(session);
  for (let i = 0; i < queued.length; i++) {
    const ok = await send(queued[i]!);
    if (!ok) {
      returnHeld(session, queued.slice(i));
      return;
    }
  }
}

export interface FlushWhenAwakeOptions {
  /** The session this view is showing. Read reactively: tmux-api renames a
   *  session out from under whoever is holding its name (ADR-0022), and
   *  anything held under the old one travels with it. */
  session: () => string;
  /** True while the session has no claude process to talk to. */
  suspended: () => boolean;
  /** The ordinary send path — `store.send`, POST /prompt. */
  send: (text: string) => Promise<boolean>;
}

/**
 * Flush this view's held messages when its session stops being suspended.
 *
 * The EDGE, not the state: a view mounted on a live session flushes nothing
 * (there is nothing held, and a flush on mount would replay whatever a
 * previous view left behind at a moment nobody asked for). The seed is the
 * value at call time, so the first effect run is never an edge.
 */
export function flushHeldWhenAwake(opts: FlushWhenAwakeOptions): void {
  createEffect<{ name: string; suspended: boolean }>(
    (prev) => {
      const name = opts.session();
      const now = opts.suspended();
      if (prev.name !== name) carryHeld(prev.name, name);
      if (prev.suspended && !now) void flushHeld(name, opts.send);
      return { name, suspended: now };
    },
    { name: opts.session(), suspended: opts.suspended() },
  );
}
