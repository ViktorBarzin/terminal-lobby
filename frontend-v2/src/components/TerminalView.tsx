import { createEffect, onCleanup, onMount, untrack, type Component } from "solid-js";
import { terminalUrl } from "../lib/terminal-url";

/**
 * Terminal mode — the live ttyd attach (design pillar #2 fallback view). An
 * iframe pointed at the patched ttyd `-I` page for the current session via the
 * positional `?arg=` contract (terminal-url.ts). xterm stays EXTERNAL: ttyd
 * serves the terminal page, so nothing here imports xterm.
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
 *  - Eager attach on mount: a NEW session's tmux is born only once the iframe's
 *    WebSocket reaches ttyd, so we must navigate even while text mode is showing.
 *  - Live theme: window.__tlThemeLive posts `{type:'tl-theme',name}` into the
 *    frame and reloads it if no `tl-theme-ack` arrives within 1000ms.
 */
export const TerminalView: Component<{
  session: string;
  owner?: string;
  active: boolean;
  /** current roamed newCommand, read ONCE at attach (never re-navigates live). */
  newCommand?: () => string;
  /** a chord fired inside the terminal iframe, forwarded up (tl-command). */
  onFrameCommand?: (command: string) => void;
  /** the terminal iframe's Alt-hold state, forwarded up (tl-kb-alt). */
  onFrameAlt?: (down: boolean) => void;
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

  // Attach (and re-attach if the session/owner target changes). newCommand is
  // read UNTRACKED: it only shapes a NEW session's command, and a pref change
  // must never re-navigate a live terminal (that would drop the WebSocket).
  createEffect(() => {
    const session = props.session;
    const owner = props.owner;
    const url = untrack(() =>
      terminalUrl(session, {
        cmd: props.newCommand?.(),
        owner: owner || undefined,
      }),
    );
    if (url !== currentUrl) navigate(url);
  });

  // Focus the terminal when it becomes the active view. Focus the frame window
  // AND post tl-focus so the terminal page's own handler focuses xterm's input.
  createEffect(() => {
    if (!props.active) return;
    requestAnimationFrame(() => {
      try {
        iframe?.contentWindow?.focus();
      } catch {
        /* cross-frame focus blocked */
      }
      postToFrame({ type: "tl-focus" });
    });
  });

  const onMessage = (e: MessageEvent): void => {
    if (origin() && e.origin !== origin()) return;
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d = e.data as { type?: string; command?: unknown; alt?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "tl-terminal-ready") {
      hideCover();
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
    }
  };

  // Forward a terminal-document command DOWN to the iframe (gallery/paste).
  const forwardToFrame = (command: string): boolean => {
    postToFrame({ type: "tl-command", command });
    return true;
  };
  let prevForward: ((c: string) => boolean) | undefined;

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
  onMount(() => {
    window.addEventListener("message", onMessage);
    if (typeof window !== "undefined") {
      prevThemeLive = window.__tlThemeLive;
      window.__tlThemeLive = onThemeLive;
      prevForward = window.__tlForwardToTerminal;
      window.__tlForwardToTerminal = forwardToFrame;
    }
  });
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    if (coverTimer) clearTimeout(coverTimer);
    if (themeAckTimer) clearTimeout(themeAckTimer);
    if (typeof window !== "undefined" && window.__tlThemeLive === onThemeLive) {
      window.__tlThemeLive = prevThemeLive;
    }
    if (typeof window !== "undefined" && window.__tlForwardToTerminal === forwardToFrame) {
      window.__tlForwardToTerminal = prevForward;
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
