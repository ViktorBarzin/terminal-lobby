import { onCleanup, onMount, type Component } from "solid-js";
import { ownWhile } from "../lib/ownwhile";
// xterm ships its own stylesheet and WILL NOT LAY OUT WITHOUT IT: the rows get
// no positioning, so the terminal renders as a narrow column of overlapping
// glyphs. It looks like a sizing bug and it is a missing import. Vite folds it
// into the bundle's CSS, so it costs no extra request.
import "@xterm/xterm/css/xterm.css";
import { attach, type Attachment } from "../terminal/attach";
import { toXtermTheme, THEME_LIVE_GLOBAL } from "../terminal/theme";
import type { LadderState } from "../terminal/reconnect";
import type { TerminalReport } from "../diagnostics/status";

/**
 * The terminal, rendered by this app rather than by an iframe.
 *
 * WHY THIS EXISTS. `TerminalView` mounts `frontend/term.html` in a cross-document
 * iframe, so everything the shell wants to know about the terminal — is it
 * connected, what is it retrying, what did the user select — has to cross a
 * postMessage boundary one message type at a time, and everything term.html
 * wants from the shell (theme, prefs, keyboard) has to cross back. This mounts
 * xterm directly, so those become ordinary function calls.
 *
 * WHAT IT IS NOT YET. Paste, the soft keys, the compose mirror, selection and
 * copy, pinch-to-zoom, sixel images and the held-key overlay all still belong to
 * term.html; this attaches, reconnects, resizes and types. It is behind a flag
 * for exactly that reason — it is the connection half of the port, finished and
 * measurable, with the input half still to come.
 *
 * xterm arrives through a dynamic import so it lands in its own content-hashed
 * chunk that a deploy leaves alone unless xterm itself changed (330 KB, 83 KB
 * gzipped; see the note in vite.config.ts).
 */
export const TerminalNative: Component<{
  /** The positional `arg=` query, from lib/terminal-url.ts buildTerminalArgs. */
  args: string;
  /** Phase changes, for the shell's connection badge (ADR-0016). */
  onConn?: (report: TerminalReport) => void;
  /**
   * This client attached read-only and the SERVER agreed. Passed down so the
   * one input choke point in attach.ts can drop a watcher's keystrokes — the
   * page cannot grant itself write access, but it can stop pretending the keys
   * went somewhere.
   */
  watch?: () => boolean;
  /** Hands the caller a way to retry, for the panel's Reconnect button. */
  onReady?: (control: { reconnect: () => void }) => void;
  /**
   * FALSE for a secondary terminal. The window-level bridges below are named
   * globals, so two mounted terminals would fight over them and the soft keys,
   * paste and focus handback would start driving the wrong pty — the same
   * reason TerminalView takes this flag.
   */
  ownsBridges?: boolean;
}> = (props) => {
  let host: HTMLDivElement | undefined;
  let attachment: Attachment | null = null;
  let disposed = false;

  /** The ladder's phase in the vocabulary the status model speaks. */
  const report = (phase: LadderState["phase"], attempt: number): TerminalReport => {
    switch (phase) {
      case "open":
        return { state: "open", attempt: 0 };
      case "suspended":
        return { state: "suspended", attempt: 0 };
      case "ended":
        return { state: "closed", attempt: 0 };
      default:
        // The ladder has no `offline` phase — it carries `online` as a flag and
        // keeps waiting — but term.html reports offline as its own state, and
        // the badge says "Offline" rather than "Reconnecting" for it. Reading
        // the browser here keeps that distinction without adding a phase.
        return typeof navigator !== "undefined" && navigator.onLine === false
          ? { state: "offline", attempt }
          : { state: "connecting", attempt };
    }
  };

  onMount(() => {
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !host) return;

      const term = new Terminal({
        allowProposedApi: true,
        theme: toXtermTheme((name) =>
          getComputedStyle(document.body).getPropertyValue(name).trim(),
        ),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();

      attachment = attach({
        base: "",
        args: props.args,
        write: (bytes) => term.write(bytes),
        size: () => ({ cols: term.cols, rows: term.rows }),
        onPhase: (phase, attempt) => props.onConn?.(report(phase, attempt)),
        watch: () => props.watch?.() === true,
      });
      const a = attachment;
      term.onData((data) => a.send(data));
      props.onReady?.({ reconnect: () => a.reconnect() });

      // The size the pty is told has to follow the size xterm actually reached,
      // and a reflow can change that without the window resizing (the sidebar
      // opening, the soft keyboard arriving).
      const ro = new ResizeObserver(() => {
        fit.fit();
        a.resize();
      });
      ro.observe(host);

      // Theme trigger 2, which the module's header calls out: an OS light/dark
      // flip while the stored theme is "system" re-reads the vars. Trigger 1,
      // an explicit pick, comes through the same global from theme.ts.
      const live = (): void => {
        term.options.theme = toXtermTheme((name) =>
          getComputedStyle(document.body).getPropertyValue(name).trim(),
        );
        term.refresh(0, term.rows - 1);
      };
      const w = window as unknown as Record<string, unknown>;
      const previous = w[THEME_LIVE_GLOBAL];
      w[THEME_LIVE_GLOBAL] = live;

      // THE SAME BRIDGES TerminalView installs, pointing at this terminal
      // instead of at an iframe. Everything upstream — paste, the soft keys, a
      // dropped file, the composer's "send to terminal" — already calls these
      // globals, so the native path inherits all of it without any caller
      // knowing which terminal it is talking to. Each returns a boolean because
      // the callers treat false as "no terminal took this".
      const owns = (): boolean => props.ownsBridges !== false;
      ownWhile(owns, "__tlSendToTerminal", (bytes: string) => {
        a.send(bytes);
        return true;
      });
      ownWhile(owns, "__tlPasteToTerminal", (text: string) => {
        a.send(text);
        return true;
      });
      ownWhile(owns, "__tlFocusTerminal", () => {
        term.focus();
        return true;
      });
      ownWhile(owns, "__tlRefitTerminal", () => {
        fit.fit();
        a.resize();
        return true;
      });

      onCleanup(() => {
        ro.disconnect();
        w[THEME_LIVE_GLOBAL] = previous;
        term.dispose();
      });
    })();
  });

  onCleanup(() => {
    disposed = true;
    attachment?.dispose();
    attachment = null;
    // The frame is gone, so whatever it last said about its socket stops being
    // true — same handover the iframe makes (ADR-0016).
    props.onConn?.({ state: "closed", attempt: 0 });
  });

  return <div class="tl-terminal-native" ref={host} />;
};
