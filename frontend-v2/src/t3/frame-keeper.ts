/**
 * The tab's one T3 frame, kept alive between uses (t3 view design, the
 * 0.126 preload).
 *
 * Booting T3's web client costs seconds: its scripts, its WebSocket, its
 * snapshot. A frame that is already up changes thread by `tl-open` and costs
 * nothing. So on a desktop the lobby boots the frame once, early, in a hidden
 * park (components/T3Host.tsx `T3Park`), and every session that shows the T3
 * view borrows it: the frame MOVES into that session's pane and back to the
 * park when the pane lets it go.
 *
 * Moving an iframe in the page normally reloads it. `Element.moveBefore`
 * (Chromium 133 and later) moves it with its document intact, so the frame is
 * kept only where that exists. Elsewhere, and on a phone where a hidden T3
 * client would cost memory and battery for nothing, there is no park: the
 * frame is made when a pane shows it and dropped when the pane lets it go, as
 * it was before.
 *
 * Which pane gets the frame is t3/frame-claim.ts's question; this module only
 * puts the frame where it is told and speaks the message contract
 * (t3-view/EMBED.md) for whichever session holds it.
 */

import {
  keyInChords,
  loadEnvironmentId,
  parseFrameMessage,
  replayInit,
  saveEnvironmentId,
  t3FrameAllow,
  t3FrameUrl,
  type FrameChord,
  type HostMessage,
  type RouteSession,
} from "./embed.logic";

/** The session the frame is showing, and the lobby's side of it. */
export interface FrameBinding {
  /** the session's claim key (t3/frame-claim.ts). */
  key: string;
  origin: string;
  threadId: () => string;
  chords: () => readonly FrameChord[];
  /** this session's tile is the focused one. */
  prefer: () => boolean;
  /** focus this session's tile. */
  onFocus?: () => void;
  /** the frame went to another session's thread: move the lobby there, or
   *  say false to send the frame back. */
  onFollow?: (target: RouteSession) => boolean;
}

export interface FrameKeeper {
  /** Put the frame in `slot`, showing `b`'s thread. Boots one when there is
   *  none, or when the one there is serves another origin. */
  show: (slot: HTMLElement, b: FrameBinding) => void;
  /** `key`'s pane is letting the frame go: park it, or drop it with no park.
   *  A key that does not hold the frame is a no-op. */
  hide: (key: string) => void;
  /** The holder's thread changed. */
  open: (key: string) => void;
  /** The holder's chords changed. */
  rebind: (key: string) => void;
  /** Offer a park and boot the frame in it, or take the park away (null),
   *  which drops a frame parked there. Without moveBefore there is no park. */
  park: (
    p: { el: HTMLElement; origin: string; chords: () => readonly FrameChord[] } | null,
  ) => void;
  /** The frame element, for tests. */
  frame: () => HTMLIFrameElement | null;
}

/** Move `node` to the end of `parent` with its document intact, or say false
 *  where the browser cannot. */
export type FrameMove = (parent: HTMLElement, node: HTMLIFrameElement) => boolean;

type MoveBefore = (node: Node, child: Node | null) => void;

/** Element.moveBefore where the browser has it. Read at call time, so a test
 *  can provide it. */
const moveBefore: FrameMove = (parent, node) => {
  const mb = (parent as HTMLElement & { moveBefore?: MoveBefore }).moveBefore;
  if (typeof mb !== "function" || !node.isConnected) return false;
  try {
    mb.call(parent, node, null);
    return true;
  } catch {
    return false;
  }
};

/** Whether this browser can keep a frame across moves. */
export function canKeepFrame(): boolean {
  return typeof Element !== "undefined" && "moveBefore" in Element.prototype;
}

export function createFrameKeeper(move: FrameMove = moveBefore): FrameKeeper {
  let frame: HTMLIFrameElement | null = null;
  let frameOrigin = "";
  let ready = false;
  let binding: FrameBinding | null = null;
  let parked: { el: HTMLElement; origin: string; chords: () => readonly FrameChord[] } | null =
    null;

  /** Post to the frame, only ever to its own origin. */
  const post = (m: HostMessage): void => {
    frame?.contentWindow?.postMessage(m, frameOrigin);
  };
  const chords = (): readonly FrameChord[] => binding?.chords() ?? parked?.chords() ?? [];
  const sendChords = (): void => post({ type: "tl-bindings", v: 1, chords: [...chords()] });
  const openBound = (): void => {
    if (binding) post({ type: "tl-open", v: 1, threadId: binding.threadId() });
  };

  /**
   * Make the holder's tile the focused one, and say whether it now is.
   *
   * In a workspace the lobby moves tile focus on a capture pointerdown in its
   * own document, and a press inside a cross-origin frame never reaches it.
   * The keybinding engine acts on the selected session, so without this a
   * chord typed in the frame of tile A ran against tile B.
   */
  const takeFocus = (b: FrameBinding): boolean => {
    if (!b.prefer()) b.onFocus?.();
    return b.prefer();
  };
  // Keyboard focus moving into the frame blurs the lobby's window, with the
  // frame as the document's active element.
  const onBlur = (): void => {
    if (binding && frame && document.activeElement === frame) takeFocus(binding);
  };

  const onMessage = (e: MessageEvent): void => {
    // Both: the origin says whose page it is, the source says it is OUR
    // frame rather than another window of the same origin.
    if (!frame || e.origin !== frameOrigin || e.source !== frame.contentWindow) return;
    const m = parseFrameMessage(e.data);
    if (!m) return;
    if (m.type === "tl-key") {
      // A parked frame has nobody to act for.
      if (!binding) return;
      // Only a chord the lobby asked for: the frame is another origin's page.
      if (!keyInChords(m, binding.chords())) return;
      // A chord acts on the selected session: drop it rather than run it
      // against another tile's session.
      if (!takeFocus(binding)) return;
      // Dispatched on the frame element, so the lobby's window and document
      // listeners (the keybinding engine, the dock's Ctrl/Cmd+J, the help
      // overlay's Escape) see it as a key pressed on this pane.
      frame.dispatchEvent(new KeyboardEvent("keydown", replayInit(m)));
      return;
    }
    if (m.type === "tl-route") {
      if (!binding) return;
      // The lobby's header, keepalive and every forwarded chord follow the
      // holder's session, so the frame cannot be left showing another one.
      // A route that is no thread (a new thread's draft) stays put.
      if (m.threadId === null) return;
      const own = binding.threadId();
      if (m.session?.key === own) return;
      if (m.session && binding.onFollow?.(m.session)) return;
      post({ type: "tl-open", v: 1, threadId: own });
      return;
    }
    if (loadEnvironmentId(frameOrigin) !== m.environmentId) {
      saveEnvironmentId(frameOrigin, m.environmentId);
    }
    ready = true;
    sendChords();
    if (binding && m.threadId !== binding.threadId()) openBound();
  };

  const drop = (): void => {
    if (!frame) return;
    frame.remove();
    frame = null;
    ready = false;
    window.removeEventListener("message", onMessage);
    window.removeEventListener("blur", onBlur);
  };

  /**
   * Boot a frame in `parent`. Its URL is fixed here: changing an iframe's
   * `src` reloads the whole T3 client, so a later thread goes by `tl-open`.
   */
  const boot = (parent: HTMLElement, origin: string, threadId: string | null): void => {
    drop();
    const f = document.createElement("iframe");
    f.className = "tl-t3-frame";
    f.title = "T3 view";
    const allow = t3FrameAllow(origin, window.location.hostname);
    if (allow) f.setAttribute("allow", allow);
    f.src = t3FrameUrl({ origin, environmentId: loadEnvironmentId(origin), threadId });
    frame = f;
    frameOrigin = origin;
    ready = false;
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    parent.appendChild(f);
  };

  return {
    show(slot, b) {
      binding = b;
      if (frame && frameOrigin === b.origin) {
        if (frame.parentElement === slot) return;
        if (move(slot, frame)) {
          // Already up: it says nothing again, so it goes to the thread and
          // learns the chords now. Not yet up: tl-ready will do both.
          if (ready) {
            sendChords();
            openBound();
          }
          return;
        }
      }
      boot(slot, b.origin, b.threadId());
    },
    hide(key) {
      if (binding?.key !== key) return;
      binding = null;
      if (frame && parked && frameOrigin === parked.origin && move(parked.el, frame)) return;
      drop();
    },
    open(key) {
      if (binding?.key === key && ready) openBound();
    },
    rebind(key) {
      if (binding?.key === key && ready) sendChords();
    },
    park(p) {
      if (!p) {
        if (frame && parked && frame.parentElement === parked.el) drop();
        parked = null;
        return;
      }
      parked = p;
      if (!frame) boot(p.el, p.origin, null);
    },
    frame: () => frame,
  };
}

/** The tab's one keeper, shared by every session's T3 host and the park. */
export const t3FrameKeeper: FrameKeeper = createFrameKeeper();
