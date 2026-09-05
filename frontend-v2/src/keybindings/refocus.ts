/**
 * Hand the keyboard back to the terminal after a lobby overlay closes.
 *
 * The command palette and the shortcuts help are rendered by the shell, outside
 * the terminal, so dismissing one leaves `document.activeElement` on `<body>`
 * and every following keystroke reaches nothing, the pty included. The palette
 * already declared this contract (`PaletteEnv.refocus`) and nobody had anything
 * to fulfil it with, because the focus mechanism belonged to whichever
 * component held the terminal.
 *
 * `window.__tlFocusTerminal` is what fulfils it, and this is the one call site
 * everything else uses. It was a cross-document bridge when the terminal was an
 * iframe; TerminalNative publishes it now, through `ownWhile` so that only the
 * primary terminal claims the name (TerminalNative.tsx:3231). It survived the
 * de-iframe work while `__tlForwardToTerminal` did not, because focus is a
 * question every overlay asks from anywhere in the shell, where forwarding keys
 * had exactly one caller and became a prop.
 *
 * Safe to call at any time: no session selected, or the TEXT view holding the
 * keyboard, both return false and change nothing.
 */
export function refocusTerminal(): boolean {
  if (typeof window === "undefined") return false;
  const focus = window.__tlFocusTerminal;
  return typeof focus === "function" ? !!focus() : false;
}
