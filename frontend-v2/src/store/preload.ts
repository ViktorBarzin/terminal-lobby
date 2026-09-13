/**
 * Which session a hover has already attached, before the click.
 *
 * `keepalive.ts` solved the SECOND open of a session by never unmounting one
 * you have visited. This is the same idea fired 250 ms earlier, for a session
 * nobody has opened yet. Measured on the deployed build on 2026-09-11, a warm
 * first open costs 779 ms from the click, and 627 ms of that lands AFTER the
 * WebSocket opens: ttyd forking `devvm/tmux-attach.sh`, tmux attaching, and the
 * redraw. Preloading JavaScript cannot touch that, so a hover has to make the
 * real attach (ADR-0026).
 *
 * What a preload costs while it sits there is what a kept session costs minus
 * the transcript: one ttyd WebSocket, one attached tmux client and one xterm
 * buffer. No `/events` stream and no `watchPanes` subscriber, because only
 * `TerminalNative` is mounted. The attach carries tmux's ignore-size flag, so
 * it cannot move the session's window, and it is excluded from the driven mark,
 * so hovering down the sidebar does not restamp every card's `@last_drive`.
 *
 * THIS MODULE DECIDES; IT DOES NOT ACT. It opens no socket, mounts nothing and
 * reads no DOM. The pointer questions it cannot answer on its own arrive as
 * injected functions (`isCoarsePointer`, `alreadyOpen`, `me`), and every timer
 * goes through `schedule`, so the whole policy is testable without a tab and
 * without waiting.
 *
 * TWO THINGS ARE LOAD-BEARING:
 *
 *   - The value `preloaded()` returns is a STABLE object for as long as one
 *     session holds the slot. The caller hangs a hidden `TerminalNative` off
 *     it, and a fresh object for the same session would tear that terminal
 *     down and rebuild it — the exact 627 ms this module exists to avoid. Only
 *     a fill and a drop change the reference.
 *   - A LANDED preload survives the pointer leaving; one still IN FLIGHT does
 *     not. Hover, glance away, click is a common mouse path, so dropping a
 *     preload on `mouseleave` would throw away the work most of the time.
 *     ADR-0026 records that this assumption is untested.
 *
 * The 250 ms dwell and the 60 s TTL are starting values, not measurements.
 * Revisiting them means measuring again; nothing here reports a hit rate.
 */
import { createSignal, type Accessor } from "solid-js";
import { keyOf, type Selected } from "./keepalive";

/** How long the pointer rests on a card before anything goes out. */
export const DWELL_MS = 250;

/** How long a filled slot is held before it is dropped unopened. */
export const SLOT_TTL_MS = 60_000;

/**
 * Run `fn` after `ms` and hand back the cancel for it.
 *
 * A cancel rather than a handle on purpose: `ReturnType<typeof setTimeout>`
 * differs between the browser and node typings, and a test fake should not have
 * to satisfy either.
 */
export type Schedule = (fn: () => void, ms: number) => () => void;

/**
 * The session the preload slot is holding. Created once when the slot is
 * filled, then never replaced while that session holds it.
 */
export interface PreloadSlot {
  /** identity across owners: `owner\0name`, the same key `keepalive` uses. */
  readonly key: string;
  readonly name: string;
  readonly owner?: string;
  /** epoch ms the slot was filled. The TTL runs from here, not from landing. */
  readonly filledAt: number;
}

export interface PreloadOptions {
  /**
   * Is the primary pointer coarse? A coarse pointer has no hover, so a phone or
   * a tablet preloads nothing at all. Read live (`createCoarsePointer`), not
   * once at boot: a 2-in-1 crosses this query.
   */
  isCoarsePointer: () => boolean;
  /**
   * Is this session already mounted or on screen? Kept sessions are already
   * attached, and the selected one is the view. Wire it to `keepalive`'s list
   * plus the current selection.
   */
  alreadyOpen: (sel: Selected) => boolean;
  /**
   * The current OS user, `""` before `/whoami` answers. Own sessions only: a
   * foreign attach runs tmux-api's `/internal/attach` authorization on every
   * connection, which is a round trip, a `sudo` and an audit line per card the
   * pointer crosses. Unknown owner while whoami is out therefore preloads
   * nothing, which is the fail-closed direction.
   */
  me: () => string;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable scheduler (tests). Default `setTimeout`/`clearTimeout`. */
  schedule?: Schedule;
  /** Dwell before a hover attaches anything. Default `DWELL_MS`. */
  dwellMs?: number;
  /** How long a filled slot is held. Default `SLOT_TTL_MS`. */
  ttlMs?: number;
}

export interface PreloadStore {
  /**
   * The session to keep a hidden terminal mounted for, or null. Reactive, and
   * reference-stable while one session holds the slot.
   */
  preloaded: Accessor<PreloadSlot | null>;
  /** The pointer arrived on a card. Starts the dwell; sends nothing yet. */
  hoverEnter(sel: Selected): void;
  /**
   * The pointer left a card. Cancels that card's dwell, and aborts its preload
   * if the attach has not landed. A landed preload stays.
   */
  hoverLeave(sel: Selected): void;
  /** The preload's attach is up and drawn. Only then does it survive a leave. */
  markLanded(sel: Selected): void;
  /**
   * The preload's attach will not happen, or has stopped: the socket errored,
   * the session died between the poll and the dwell (a `pre` attach never
   * creates one), or the join this mount resolved turns out to be one a hover
   * is not allowed to make. Drops the slot so nothing waits out the TTL
   * holding a terminal that is not there.
   *
   * UNLIKE `hoverLeave`, THIS DROPS A LANDED PRELOAD TOO, and both callers
   * need that. A socket reports `closed` after it reported `open` whenever it
   * drops later, and the read-only check is a reactive effect whose answer can
   * change after the terminal has drawn — a read-only attach calls PinGrid,
   * and the pin stands for as long as that client stays attached, so "give
   * the slot back" has to work at any point in its life, not only while the
   * attach is in flight.
   */
  markFailed(sel: Selected): void;
  /**
   * The user committed to a session. Returns true when that session WAS the
   * slot: the caller keeps the mount it already has and promotes the client
   * (`refresh-client -f '!ignore-size'`) instead of attaching a second time.
   * True whether or not the attach landed — it is the same socket either way.
   *
   * Selecting any other session leaves the slot alone; only a replacement, a
   * failure or the TTL empties it.
   */
  select(sel: Selected | null): boolean;
  /** Drop the slot and disarm every timer. */
  dispose(): void;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function createPreloadStore(opts: PreloadOptions): PreloadStore {
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? defaultSchedule;
  const dwellMs = opts.dwellMs ?? DWELL_MS;
  const ttlMs = opts.ttlMs ?? SLOT_TTL_MS;

  const [preloaded, setPreloaded] = createSignal<PreloadSlot | null>(null);
  /**
   * The published slot, mirrored outside the signal. Every decision below reads
   * this one instead of calling `preloaded()`, so a caller that happens to
   * invoke `hoverEnter` from inside an effect does not subscribe that effect to
   * the slot.
   */
  let slot: PreloadSlot | null = null;
  /** The dwell in progress: the card the pointer is resting on. */
  let dwell: { key: string; cancel: () => void } | null = null;
  /** Cancels the TTL of whatever is in the slot. */
  let ttl: (() => void) | null = null;
  /** Has the slot's attach reported itself up? */
  let landed = false;

  const mine = (sel: Selected): boolean => !sel.owner || sel.owner === opts.me();

  /** Everything that has to be true before a card is worth attaching. */
  const eligible = (sel: Selected): boolean =>
    !opts.isCoarsePointer() && mine(sel) && !opts.alreadyOpen(sel);

  function cancelDwell(): void {
    dwell?.cancel();
    dwell = null;
  }

  function publish(next: PreloadSlot | null): void {
    slot = next;
    setPreloaded(next);
  }

  function clearSlot(): void {
    ttl?.();
    ttl = null;
    landed = false;
    if (slot !== null) publish(null);
  }

  function fill(sel: Selected): void {
    ttl?.();
    landed = false;
    ttl = schedule(() => {
      ttl = null;
      clearSlot();
    }, ttlMs);
    publish({ key: keyOf(sel), name: sel.name, owner: sel.owner, filledAt: now() });
  }

  function hoverEnter(sel: Selected): void {
    const key = keyOf(sel);
    // The pointer moved on. A fast sweep delivers enter before leave, so the
    // dwell left behind is dropped here rather than being allowed to fire.
    if (dwell && dwell.key !== key) cancelDwell();
    // Already ours. Resting on it again neither refills it nor extends its TTL.
    if (slot?.key === key) return;
    if (dwell) return; // still dwelling on this same card
    if (!eligible(sel)) return;
    dwell = {
      key,
      cancel: schedule(() => {
        dwell = null;
        // 250 ms is long enough for the answer to change: the user may have
        // opened it, or the pointer may have turned coarse.
        if (eligible(sel)) fill(sel);
      }, dwellMs),
    };
  }

  function hoverLeave(sel: Selected): void {
    const key = keyOf(sel);
    if (dwell?.key === key) cancelDwell();
    if (slot?.key === key && !landed) clearSlot();
  }

  function markLanded(sel: Selected): void {
    if (slot?.key === keyOf(sel)) landed = true;
  }

  function markFailed(sel: Selected): void {
    if (slot?.key === keyOf(sel)) clearSlot();
  }

  function select(sel: Selected | null): boolean {
    if (!sel) return false;
    const key = keyOf(sel);
    // Clicked inside the dwell: the real open is happening, so the speculative
    // one never goes out.
    if (dwell?.key === key) cancelDwell();
    if (slot?.key !== key) return false;
    clearSlot();
    return true;
  }

  function dispose(): void {
    cancelDwell();
    clearSlot();
  }

  return {
    preloaded,
    hoverEnter,
    hoverLeave,
    markLanded,
    markFailed,
    select,
    dispose,
  };
}
