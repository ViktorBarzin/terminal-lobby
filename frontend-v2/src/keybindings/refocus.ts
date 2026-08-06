/**
 * Hand the keyboard back to the terminal after a lobby overlay closes.
 *
 * The command palette and the shortcuts help are rendered by the shell, OUTSIDE
 * the terminal iframe, so dismissing one leaves `document.activeElement` on
 * `<body>` and every following keystroke reaches nothing — the pty included.
 * The palette already declared this contract (`PaletteEnv.refocus`); nobody had
 * anything to fulfil it with, because the iframe and its focus mechanism live
 * in TerminalView. That component publishes `window.__tlFocusTerminal` while it
 * is mounted (same bridge pattern as `__tlForwardToTerminal`), and this is the
 * one call site everything else uses.
 *
 * Safe to call at any time: no session selected, or the TEXT view holding the
 * keyboard, both return false and change nothing.
 */
export function refocusTerminal(): boolean {
  if (typeof window === "undefined") return false;
  const focus = window.__tlFocusTerminal;
  return typeof focus === "function" ? !!focus() : false;
}
