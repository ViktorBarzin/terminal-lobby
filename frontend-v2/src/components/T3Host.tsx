import { createEffect, on, onCleanup, onMount, Show, type Component } from "solid-js";
import type { FrameChord, RouteSession } from "../t3/embed.logic";
import { t3FrameClaims, type FrameClaims } from "../t3/frame-claim";
import { t3FrameKeeper, type FrameKeeper } from "../t3/frame-keeper";

/**
 * What the shell hands a session view so it can offer the T3 view: whether
 * the caller is signed in as themselves (from /whoami), where the T3 view is
 * served, and the lobby's live chords for the frame to hand back. `origin` is
 * null where no T3 view is configured (a dev server with no `?t3view=`),
 * which offers none.
 */
export interface T3Wiring {
  /** /whoami has answered and names no act-as. False until it lands. */
  self: () => boolean;
  origin: string | null;
  chords: () => readonly FrameChord[];
  /** Move the lobby to the caller's own session the frame went to, in the T3
   *  view; false when the lobby has no such session to move to. */
  follow?: (target: RouteSession) => boolean;
}

/**
 * The T3 view in a session's pane: T3 Code's own web client, framed from its
 * own origin (ADR-0044). The message contract is t3-view/EMBED.md.
 *
 * ONE FRAME PER TAB. Every host that would show the frame claims it
 * (t3/frame-claim.ts) and only the holder draws it; the others say where it
 * is and offer to bring it over. A host that stops wanting it (its session
 * went off screen, or back to Text) gives the frame back to the keeper
 * (t3/frame-keeper.ts), which parks it booted where it can, so the next
 * session to show T3 gets it at once, and drops it where it cannot.
 */
export const T3Host: Component<{
  /** this session's keepalive key: fixed for the host's life. */
  claimKey: string;
  /** the session is on screen in the T3 view, and not a preload. */
  want: () => boolean;
  /** this is the focused tile: it takes the frame when this turns true. */
  prefer: () => boolean;
  /** focus this session's tile (select the session). A press inside the
   *  frame never reaches the lobby's own pointerdown, so the frame asks. */
  onFocus?: () => void;
  /** the frame went to another session's thread (T3's palette, a new
   *  thread): move the lobby there, or say false to send the frame back. */
  onFollow?: (target: RouteSession) => boolean;
  /** the T3 thread id (t3ThreadId), null for a session T3 does not serve. */
  threadId: () => string | null;
  origin: string;
  chords: () => readonly FrameChord[];
  /** the claims to share; the tab's own by default. Tests bring their own. */
  claims?: FrameClaims;
  /** the frame keeper to borrow from; the tab's own by default. */
  keeper?: FrameKeeper;
}> = (props) => {
  const claims = props.claims ?? t3FrameClaims;
  const keeper = props.keeper ?? t3FrameKeeper;
  const key = props.claimKey;

  // `on` untracks the body, so a claim (which reads and writes the claims
  // signal) cannot re-run the effect and take the frame back from a later ask.
  createEffect(
    on(props.want, (want) => {
      if (want) claims.claim(key);
      else claims.release(key);
    }),
  );
  createEffect(
    on(
      () => props.want() && props.prefer(),
      (take) => {
        if (take) claims.claim(key);
      },
    ),
  );
  onCleanup(() => claims.release(key));

  const owns = () => props.want() && claims.owner() === key;

  return (
    <div class="tl-t3-host">
      <Show
        when={props.threadId()}
        fallback={
          <div class="tl-t3-note">
            <p>The T3 view shows your own Claude sessions.</p>
          </div>
        }
      >
        {(thread) => (
          <Show
            when={owns()}
            fallback={
              <Show when={props.want()}>
                <div class="tl-t3-note tl-t3-elsewhere">
                  <p>The T3 view is open in another tile.</p>
                  <button type="button" class="tl-t3-here" onClick={() => claims.claim(key)}>
                    Show it here
                  </button>
                </div>
              </Show>
            }
          >
            <T3Slot
              keeper={keeper}
              claimKey={key}
              origin={props.origin}
              threadId={thread}
              chords={props.chords}
              prefer={props.prefer}
              onFocus={props.onFocus}
              onFollow={props.onFollow}
            />
          </Show>
        )}
      </Show>
    </div>
  );
};

/**
 * Where the frame sits while this session holds it. The keeper moves the
 * frame in when this mounts and takes it back when this goes, which is
 * before the pane leaves the page, so a kept frame is never torn down with it.
 */
const T3Slot: Component<{
  keeper: FrameKeeper;
  claimKey: string;
  origin: string;
  threadId: () => string;
  chords: () => readonly FrameChord[];
  prefer: () => boolean;
  onFocus: (() => void) | undefined;
  onFollow: ((target: RouteSession) => boolean) | undefined;
}> = (props) => {
  let slot: HTMLDivElement | undefined;
  const key = props.claimKey;
  onMount(() => {
    if (!slot) return;
    props.keeper.show(slot, {
      key,
      origin: props.origin,
      threadId: () => props.threadId(),
      chords: () => props.chords(),
      prefer: () => props.prefer(),
      onFocus: () => props.onFocus?.(),
      onFollow: (target) => props.onFollow?.(target) ?? false,
    });
  });
  onCleanup(() => props.keeper.hide(key));

  // A changed binding (Settings, another tab) reaches a frame already up.
  createEffect(on(props.chords, () => props.keeper.rebind(key), { defer: true }));
  createEffect(on(props.threadId, () => props.keeper.open(key), { defer: true }));

  return <div ref={slot} class="tl-t3-slot" />;
};

/** Run `start` once the browser is idle, and return a cancel. */
function whenIdle(start: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(start, { timeout: 5000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(start, 2000);
  return () => window.clearTimeout(id);
}

/**
 * The park: where the tab's one T3 frame boots before anyone asks for it, and
 * waits between uses, hidden and out of the tab order. App mounts it on a
 * desktop that can keep a frame (t3/frame-keeper.ts `canKeepFrame`), for a
 * caller acting as themselves.
 *
 * It boots once the browser is idle, so the lobby's own start (the session
 * list, the terminal attach) goes first.
 */
export const T3Park: Component<{
  origin: string;
  chords: () => readonly FrameChord[];
  keeper?: FrameKeeper;
  /** when to boot; once the browser is idle by default. Returns a cancel. */
  defer?: (start: () => void) => () => void;
}> = (props) => {
  const keeper = props.keeper ?? t3FrameKeeper;
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const cancel = (props.defer ?? whenIdle)(() => {
      if (el) keeper.park({ el, origin: props.origin, chords: props.chords });
    });
    onCleanup(() => {
      cancel();
      keeper.park(null);
    });
  });
  return <div ref={el} class="tl-t3-park" aria-hidden="true" inert />;
};
