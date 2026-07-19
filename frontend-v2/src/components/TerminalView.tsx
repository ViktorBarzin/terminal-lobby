import { type Component } from "solid-js";

/**
 * Terminal mode — the FALLBACK view. FOUNDATION STUB.
 *
 * This will host the existing ttyd iframe: a live pty attach to the SAME tmux
 * session running Claude (not a separate shell — the opposite of T3). It is kept
 * PERMANENTLY MOUNTED (App never unmounts either view; it toggles CSS
 * visibility) so the future ttyd WebSocket + tmux attach + terminal scrollback
 * survive the XOR swap. On becoming visible the real view will refit + push
 * cols/rows to the pty (design: resizeEpoch/rAF).
 *
 * xterm stays EXTERNAL (not bundled) per the deploy decision — this view uses
 * ttyd's own served page via <iframe>, so it imports no xterm here.
 */
export const TerminalView: Component<{ session: string; active: boolean }> = (
  props,
) => {
  return (
    <div class="tl-terminalview">
      <div class="tl-terminal-stub">
        <div class="tl-terminal-stub-inner">
          <div class="tl-terminal-stub-badge">TERMINAL · fallback</div>
          <p>
            Live ttyd/xterm attach to <code>{props.session}</code> mounts here.
          </p>
          <p class="tl-muted">
            Placeholder — the ttyd iframe (same tmux session, verbatim-ported
            terminal subsystem) is wired in pillar&nbsp;#2 / phase&nbsp;P2. This
            view stays mounted across swaps so the WebSocket never drops.
          </p>
        </div>
      </div>
      {/*
        Real wiring (P2), documented here so the swap/refit contract is explicit:
          <iframe class="tl-ttyd" src={ttydUrl(props.session)} title="terminal" />
        + on props.active flip: rAF → fit → send cols/rows to the tmux pty.
      */}
    </div>
  );
};
