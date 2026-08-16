import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Component,
} from "solid-js";
import { terminalUrl } from "../lib/terminal-url";
import { isBuildStale } from "../deploy/healer.logic";
import { track } from "../telemetry/track";

/**
 * Terminal mode — the live ttyd attach (design pillar #2 fallback view). An
 * iframe pointed at the ttyd-served /term.html page (TERMINAL_BASE, NOT "/" —
 * "/" is this SPA, so the iframe would recurse) for the current session via the
 * positional `?arg=` contract (terminal-url.ts). xterm stays EXTERNAL: term.html
 * mounts it (from a CDN), so nothing here imports xterm.
 *
 * Contract, ported from the vanilla frontend/index.html:
 *  - PERMANENTLY MOUNTED. The XOR view switch only toggles CSS visibility
 *    (SessionView), never unmounts — so the ttyd WebSocket + tmux attach +
 *    scrollback survive the Cmd/Ctrl-J swap.
 *  - Navigation goes through `contentWindow.location.replace(url)`, NOT `src`:
 *    it swaps the framed document without adding a joint-history entry (the
 *    history-leak fix), and it does not reflect into `src` (we track currentUrl).
 *  - An INSTANT `#frame-cover` (themed panel) hides the reload flash; it fades
 *    out on the terminal's `tl-terminal-ready` postMessage, or a 1800ms fallback
 *    (outliving the terminal's own 1500ms reveal cap) for slow/errored attaches.
 *  - LAZY attach: an existing session is attached only once the Terminal view
 *    has actually been shown. Attaching resizes the tmux WINDOW to whatever this
 *    iframe measures — ttyd's INIT handshake serialises the construction-default
 *    cols/rows and that sizes the pty at spawn — so an eager attach silently
 *    reflowed a real 200x50 client down to 80x24 just because a card was
 *    clicked. `creating` opts back in for the one case that needs it: a session
 *    the app is bringing into being, whose tmux is born by this very attach.
 *    Once attached we never detach — the CSS-hidden frame keeps its WebSocket.
 *    Laziness is also what makes Watch mode's toggle useful: it can be set from
 *    the session bar BEFORE the first attach, so a phone opening a session the
 *    desktop is driving never claims the grid even momentarily.
 *  - WATCH MODE (`watch`): attaches read-only via arg5. Toggling it re-navigates,
 *    because a tmux client's read-only-ness is fixed when it attaches.
 *  - Live theme: window.__tlThemeLive posts `{type:'tl-theme',name}` into the
 *    frame and reloads it if no `tl-theme-ack` arrives within 1000ms.
 *  - Live prefs: window.__tlPrefsLive posts `{type:'tl-prefs',prefs}` +
 *    `{type:'tl-font-size',size}` (no ack, no navigation) so a settings change
 *    reaches the attached terminal without dropping its WebSocket.
 *  - Focus handback: window.__tlFocusTerminal focuses the frame and posts
 *    `{type:'tl-focus'}` so a closing lobby overlay returns the keyboard to the
 *    pty. Declines while the text view is active.
 */
export const TerminalView: Component<{
  session: string;
  owner?: string;
  active: boolean;
  /** TRUE only while the app is CREATING this session: it has no tmux session
   *  yet, so the attach is what brings it into being and cannot wait for the
   *  Terminal view. Every other session attaches lazily. */
  creating?: boolean;
  /** arg3 — the owning project's base directory, read ONCE at attach. `tmux -A`
   *  ignores -c on a live session, so sending it every time is harmless. */
  dir?: string;
  /** arg5 — Watch mode: attach read-only so this client never drives the session
   *  and never moves its grid. Changing it RE-attaches (read-only is fixed when
   *  a tmux client attaches), which is why it is a tracked dependency below. */
  watch?: boolean;
  /** current roamed newCommand — the command for a session this view is CREATING
   *  (arg2). Ignored on a re-attach (read ONCE, never re-navigates live). */
  newCommand?: () => string;
  /** a chord fired inside the terminal iframe, forwarded up (tl-command). */
  onFrameCommand?: (command: string) => void;
  /** the terminal iframe's Alt-hold state, forwarded up (tl-kb-alt). */
  onFrameAlt?: (down: boolean) => void;
  /** the terminal iframe's attention signal (bell / output-while-hidden). The
   *  lobby owns the tab title+favicon, so it decides what to badge. */
  onFrameAttention?: (kind: "bell" | "output", session: string | null) => void;
  /** the terminal iframe's `tl-build-stale` signal (inventory Cat.10): its own
   *  reconnect heal saw a new build. TOP-owned reload — the iframe NEVER reloads
   *  itself, it hands the reload UP to the lobby, which owns the single reload. */
  onFrameBuildStale?: () => void;
}> = (props) => {
  let iframe: HTMLIFrameElement | undefined;
  let cover: HTMLDivElement | undefined;
  let coverTimer: ReturnType<typeof setTimeout> | undefined;
  let themeAckTimer: ReturnType<typeof setTimeout> | undefined;
  let currentUrl = "";

  const origin = () =>
    typeof location !== "undefined" ? location.origin : "";

  const postToFrame = (msg: unknown): void => {
    try {
      iframe?.contentWindow?.postMessage(msg, origin());
    } catch {
      /* detached/foreign contentWindow */
    }
  };

  const showCover = (): void => {
    if (coverTimer) clearTimeout(coverTimer);
    if (cover) {
      cover.style.transition = "none";
      cover.style.opacity = "1";
    }
    coverTimer = setTimeout(hideCover, 1800);
  };
  const hideCover = (): void => {
    if (coverTimer) clearTimeout(coverTimer);
    if (cover) {
      cover.style.transition = "opacity 200ms ease";
      cover.style.opacity = "0";
    }
  };

  const navigate = (url: string): void => {
    currentUrl = url;
    if (url && url !== "about:blank") showCover();
    else hideCover();
    try {
      // location.replace: swap the framed doc without a joint-history entry.
      iframe?.contentWindow?.location.replace(url);
    } catch {
      // Detached/foreign contentWindow — degraded fallback (one history entry,
      // never a dead iframe).
      if (iframe) iframe.src = url;
    }
  };

  // One-way latch: the terminal may attach once it has been asked for (the view
  // was shown) or once it is the only thing that can create the session. It
  // never un-latches — the attach outlives every swap back to the text view.
  const [attachAllowed, setAttachAllowed] = createSignal(false);
  createEffect(() => {
    if (props.active || props.creating) setAttachAllowed(true);
  });

  // Attach (and re-attach if the session/owner/watch target changes). newCommand
  // is read UNTRACKED: it only shapes a NEW session's command, and a pref change
  // must never re-navigate a live terminal (that would drop the WebSocket).
  //
  // `watch` IS tracked, and re-navigating is the point: read-only is a property
  // of the tmux client, fixed when it attaches, so changing it means attaching
  // again. The cover hides the reload and tmux keeps the scrollback, so the
  // visible cost is one flash.
  createEffect(() => {
    const session = props.session;
    const owner = props.owner;
    const watch = props.watch;
    if (!attachAllowed()) return;
    const url = untrack(() =>
      terminalUrl(session, {
        // arg2 (command) is a CREATE-only concern. On a RE-attach it must be the
        // inert placeholder: an existing session you `exit` is resurrected by
        // ttyd's `new-session -A` reconnect, and carrying the live create-dropdown
        // pref here made it come back as whatever the dropdown then said.
        cmd: props.creating ? props.newCommand?.() : undefined,
        dir: props.dir || undefined,
        owner: owner || undefined,
        watch,
      }),
    );
    if (url !== currentUrl) navigate(url);
  });

  // Tell the terminal page whether its view is on screen. Both views stay
  // mounted, so while text mode shows this iframe is merely CSS-hidden — inside
  // it `document.hidden` is false and its output-attention signal never fires,
  // which is why the [Terminal] segment's activity dot could never light. Re-sent
  // on every (re)attach because a freshly loaded document boots up assuming it
  // is visible.
  const postViewState = (): void => {
    postToFrame({ type: "tl-view", hidden: !props.active });
  };
  createEffect(() => postViewState());

  // Focus the frame window AND post tl-focus so the terminal page's own handler
  // focuses xterm's input. Declines while the TEXT view is showing: the composer
  // owns the keyboard there, and this iframe is CSS-hidden anyway.
  const focusFrame = (): boolean => {
    if (!props.active) return false;
    // Don't yank focus from a lobby text field the user is in — the inline
    // rename box is the case that bites: selecting-then-double-clicking a card
    // opens it, and this on-activate auto-focus fires a frame later, steals the
    // box's focus, and its onBlur={endRename} tears the rename down the instant
    // it appeared. A genuine overlay-close handback runs with nothing lobby-side
    // focused, so this only ever declines the unwanted steal.
    const ae =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    if (
      ae &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
    ) {
      return false;
    }
    try {
      iframe?.contentWindow?.focus();
    } catch {
      /* cross-frame focus blocked */
    }
    postToFrame({ type: "tl-focus" });
    return true;
  };

  // Focus the terminal when it becomes the active view.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => void focusFrame());
  });

  const onMessage = (e: MessageEvent): void => {
    if (origin() && e.origin !== origin()) return;
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d = e.data as
      | { type?: string; command?: unknown; alt?: unknown; kind?: unknown; session?: unknown }
      | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "tl-terminal-ready") {
      hideCover();
      postViewState(); // the fresh document assumes it is visible
    } else if (d.type === "tl-theme-ack") {
      if (themeAckTimer) clearTimeout(themeAckTimer);
    } else if (d.type === "tl-command") {
      // A chord fired inside the terminal (focus in xterm) — the lobby owns the
      // sidebar/palette, so route it up to runAppCommand.
      if (typeof d.command === "string") props.onFrameCommand?.(d.command);
    } else if (d.type === "tl-kb-alt") {
      // The iframe's Alt tracker drives the lobby's Alt-hold badge overlay
      // (its keydowns never reach this window).
      props.onFrameAlt?.(!!d.alt);
    } else if (d.type === "tl-attention") {
      // BEL or output-while-hidden inside the terminal — the lobby owns the tab
      // title+favicon (this frame's title/icon are invisible), so forward it up.
      // Origin + source are already validated above (anti-spoof).
      const kind = d.kind === "bell" ? "bell" : "output";
      const session = typeof d.session === "string" ? d.session : null;
      props.onFrameAttention?.(kind, session);
    } else if (isBuildStale(d)) {
      // The terminal saw a new build on its reconnect heal and handed the reload
      // UP (it never reloads itself). Origin + source were validated above.
      props.onFrameBuildStale?.();
    }
  };

  // Forward a terminal-document command DOWN to the iframe (gallery/paste).
  const forwardToFrame = (command: string): boolean => {
    postToFrame({ type: "tl-command", command });
    return true;
  };
  let prevForward: ((c: string) => boolean) | undefined;

  // ---- mobile soft-key / compose bridge (design pillar #2 — Mobile) --------
  // The SPA-side sender of the raw-byte bridge: the mobile soft-key toolbar and
  // the terminal-target compose bar forward pty bytes DOWN to the terminal
  // iframe (frontend/term.html, TERMINAL_BASE). BRIDGE CONTRACT the term page
  // implements to complete the round-trip:
  //   window 'message', origin-scoped to location.origin, source === parent:
  //     {type:'tl-input',  bytes:string}  -> mirrorLineReset() + sendInput(bytes)
  //     {type:'tl-refit'}                  -> refit()  (re-fit xterm)
  //     {type:'tl-view',   hidden:boolean} -> setViewHidden() (attention kernel)
  // term.html handles all four (tl-input / tl-refit / tl-view / tl-command
  // 'terminal.copy') in its terminal-mode message handler, closing the bridge
  // end-to-end.
  const sendBytesToFrame = (bytes: string): boolean => {
    if (!iframe?.contentWindow) return false;
    postToFrame({ type: "tl-input", bytes });
    return true;
  };
  let prevSendBytes: ((b: string) => boolean) | undefined;
  // Clipboard TEXT the lobby has already read, handed to the terminal page's
  // term.paste(). Separate from tl-input on purpose: term.paste brackets the
  // paste and normalizes \r\n, so a multiline paste cannot execute
  // line-by-line the way raw bytes would. The lobby does the reading because
  // the async clipboard is gated on document focus, which the frame does not
  // have when a lobby control was clicked (clipboard/paste.ts).
  const pasteToFrame = (text: string): boolean => {
    if (!iframe?.contentWindow) return false;
    postToFrame({ type: "tl-paste", text });
    return true;
  };
  let prevPaste: ((t: string) => boolean) | undefined;
  const refitFrame = (): boolean => {
    if (!iframe?.contentWindow) return false;
    postToFrame({ type: "tl-refit" });
    return true;
  };
  let prevRefit: (() => boolean) | undefined;

  // Live prefs bridge — store/prefs.ts calls window.__tlPrefsLive after it has
  // PERSISTED a change. The v2 rewrite carried the theme half of the bridge and
  // dropped this one, so "Terminal font size" moved a readout and a localStorage
  // key and nothing else: the receiver (term.html's tl-prefs -> applyTermPrefs
  // -> fit, tl-font-size -> applyFontSize) has been waiting for a sender all
  // along. Both messages go out, like the vanilla lobby's: tl-prefs is the
  // current contract, tl-font-size keeps a pre-2.6 frame in step. No ACK and no
  // navigation — the WebSocket must survive a font step.
  const onPrefsLive = (prefs: { fontSize: number }): boolean => {
    if (!iframe?.contentWindow) return false;
    postToFrame({ type: "tl-prefs", prefs });
    postToFrame({ type: "tl-font-size", size: prefs.fontSize });
    return true;
  };
  let prevPrefsLive: ((p: { fontSize: number }) => boolean) | undefined;

  // Live theme bridge — theme.ts calls window.__tlThemeLive on every switch.
  const onThemeLive = (name: string): void => {
    postToFrame({ type: "tl-theme", name });
    if (themeAckTimer) clearTimeout(themeAckTimer);
    themeAckTimer = setTimeout(() => {
      // No ack (stale build / still loading): reload to pick up the new theme.
      if (currentUrl && currentUrl !== "about:blank") navigate(currentUrl);
    }, 1000);
  };

  let prevThemeLive: ((t: string) => void) | undefined;
  let prevFocus: (() => boolean) | undefined;
  onMount(() => {
    window.addEventListener("message", onMessage);
    if (typeof window !== "undefined") {
      prevThemeLive = window.__tlThemeLive;
      window.__tlThemeLive = onThemeLive;
      prevForward = window.__tlForwardToTerminal;
      window.__tlForwardToTerminal = forwardToFrame;
      prevSendBytes = window.__tlSendToTerminal;
      window.__tlSendToTerminal = sendBytesToFrame;
      prevPaste = window.__tlPasteToTerminal;
      window.__tlPasteToTerminal = pasteToFrame;
      prevRefit = window.__tlRefitTerminal;
      window.__tlRefitTerminal = refitFrame;
      prevFocus = window.__tlFocusTerminal;
      window.__tlFocusTerminal = focusFrame;
      prevPrefsLive = window.__tlPrefsLive;
      window.__tlPrefsLive = onPrefsLive;
    }
  });
  onCleanup(() => {
    // Only a terminal that actually attached can detach — a lazily-mounted view
    // that never reached ttyd must not fake the other half of the
    // session.attached/detached pair (ADR-0006).
    if (untrack(attachAllowed)) {
      track("session.detached", { "tl.session": untrack(() => props.session) });
    }
    window.removeEventListener("message", onMessage);
    if (coverTimer) clearTimeout(coverTimer);
    if (themeAckTimer) clearTimeout(themeAckTimer);
    if (typeof window !== "undefined" && window.__tlThemeLive === onThemeLive) {
      window.__tlThemeLive = prevThemeLive;
    }
    if (typeof window !== "undefined" && window.__tlForwardToTerminal === forwardToFrame) {
      window.__tlForwardToTerminal = prevForward;
    }
    if (typeof window !== "undefined" && window.__tlSendToTerminal === sendBytesToFrame) {
      window.__tlSendToTerminal = prevSendBytes;
    }
    if (typeof window !== "undefined" && window.__tlPasteToTerminal === pasteToFrame) {
      window.__tlPasteToTerminal = prevPaste;
    }
    if (typeof window !== "undefined" && window.__tlRefitTerminal === refitFrame) {
      window.__tlRefitTerminal = prevRefit;
    }
    if (typeof window !== "undefined" && window.__tlFocusTerminal === focusFrame) {
      window.__tlFocusTerminal = prevFocus;
    }
    if (typeof window !== "undefined" && window.__tlPrefsLive === onPrefsLive) {
      window.__tlPrefsLive = prevPrefsLive;
    }
  });

  return (
    <div class="tl-terminalview">
      <iframe
        ref={iframe}
        class="tl-ttyd"
        referrerpolicy="same-origin"
        allow="clipboard-read; clipboard-write"
        title={`terminal: ${props.session}`}
        onLoad={() => props.onFrameAlt?.(false)}
      />
      <div ref={cover} class="tl-frame-cover" aria-hidden="true" />
    </div>
  );
};
