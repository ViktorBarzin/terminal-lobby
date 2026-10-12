import { createEffect, createSignal, on, onCleanup, Show, untrack, type Component } from "solid-js";
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
} from "../t3/embed.logic";
import { t3FrameClaims, type FrameClaims } from "../t3/frame-claim";

/**
 * What the shell hands a session view so it can offer the T3 view: whether
 * the caller is an admin (from /whoami), where the T3 view is served, and the
 * lobby's live chords for the frame to hand back. `origin` is null where no
 * T3 view is configured (a dev server with no `?t3view=`), which offers none.
 */
export interface T3Wiring {
  admin: () => boolean;
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
 * went off screen, or back to Text) unmounts the frame rather than keeping it
 * hidden, so a kept session costs nothing in T3.
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
}> = (props) => {
  const claims = props.claims ?? t3FrameClaims;
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
            <T3Frame
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
 * The frame itself, and the lobby's side of the postMessage contract.
 *
 * Its URL is fixed when it mounts: changing an iframe's `src` reloads the
 * whole T3 client, so a later thread change goes by `tl-open` instead.
 */
const T3Frame: Component<{
  origin: string;
  threadId: () => string;
  chords: () => readonly FrameChord[];
  prefer: () => boolean;
  onFocus: (() => void) | undefined;
  onFollow: ((target: RouteSession) => boolean) | undefined;
}> = (props) => {
  let frame: HTMLIFrameElement | undefined;
  const [ready, setReady] = createSignal(false);
  const src = untrack(() =>
    t3FrameUrl({
      origin: props.origin,
      environmentId: loadEnvironmentId(props.origin),
      threadId: props.threadId(),
    }),
  );

  /** Post to the frame, only ever to its own origin. */
  const post = (m: HostMessage): void => {
    frame?.contentWindow?.postMessage(m, props.origin);
  };
  const sendChords = (): void => post({ type: "tl-bindings", v: 1, chords: [...props.chords()] });

  /**
   * Make this session's tile the focused one, and say whether it now is.
   *
   * In a workspace the lobby moves tile focus on a capture pointerdown in its
   * own document, and a press inside a cross-origin frame never reaches it.
   * The keybinding engine acts on the selected session, so without this a
   * chord typed in the frame of tile A ran against tile B.
   */
  const takeFocus = (): boolean => {
    if (!props.prefer()) props.onFocus?.();
    return props.prefer();
  };
  // Keyboard focus moving into the frame blurs the lobby's window, with the
  // frame as the document's active element.
  const onBlur = (): void => {
    if (frame && document.activeElement === frame) takeFocus();
  };
  window.addEventListener("blur", onBlur);
  onCleanup(() => window.removeEventListener("blur", onBlur));

  const onMessage = (e: MessageEvent): void => {
    // Both: the origin says whose page it is, the source says it is OUR
    // frame rather than another window of the same origin.
    if (!frame || e.origin !== props.origin || e.source !== frame.contentWindow) return;
    const m = parseFrameMessage(e.data);
    if (!m) return;
    if (m.type === "tl-key") {
      // Only a chord the lobby asked for: the frame is another origin's page.
      if (!keyInChords(m, props.chords())) return;
      // A chord acts on the selected session: drop it rather than run it
      // against another tile's session.
      if (!takeFocus()) return;
      // Dispatched on the frame element, so the lobby's window and document
      // listeners (the keybinding engine, the dock's Ctrl/Cmd+J, the help
      // overlay's Escape) see it as a key pressed on this pane.
      frame.dispatchEvent(new KeyboardEvent("keydown", replayInit(m)));
      return;
    }
    if (m.type === "tl-route") {
      // The lobby's header, keepalive and every forwarded chord follow this
      // host's session, so the frame cannot be left showing another one.
      // A route that is no thread (a new thread's draft) stays put.
      if (m.threadId === null) return;
      const own = props.threadId();
      if (m.session?.key === own) return;
      if (m.session && props.onFollow?.(m.session)) return;
      post({ type: "tl-open", v: 1, threadId: own });
      return;
    }
    if (loadEnvironmentId(props.origin) !== m.environmentId) {
      saveEnvironmentId(props.origin, m.environmentId);
    }
    setReady(true);
    sendChords();
    const want = props.threadId();
    if (m.threadId !== want) post({ type: "tl-open", v: 1, threadId: want });
  };
  window.addEventListener("message", onMessage);
  onCleanup(() => window.removeEventListener("message", onMessage));

  // A changed binding (Settings, another tab) reaches a frame already up.
  createEffect(
    on(
      props.chords,
      () => {
        if (ready()) sendChords();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      props.threadId,
      (threadId) => {
        if (ready()) post({ type: "tl-open", v: 1, threadId });
      },
      { defer: true },
    ),
  );

  return (
    <iframe
      ref={frame}
      class="tl-t3-frame"
      src={src}
      title="T3 view"
      allow={t3FrameAllow(props.origin, window.location.hostname)}
    />
  );
};
