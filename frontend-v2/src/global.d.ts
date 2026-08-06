/// <reference types="vite/client" />

// Injected by Vite `define` (see vite.config.ts) / vitest define. The build id
// string that replaces the vanilla app's `__TL_BUILD__` token.
declare const __TL_BUILD__: string;

// Globals installed by the pre-paint theme boot script in index.html. The app
// (src/theme/theme.ts) reuses them, exactly as the vanilla app did.
interface Window {
  __tlThemes?: string[];
  __tlApplyTheme?: (theme: string) => void;
  __tlThemeLive?: (theme: string) => void;
  // Set by the mounted TerminalView so the lobby's runAppCommand can post a
  // terminal-document command (gallery.open / terminal.paste / terminal.copy)
  // DOWN to the active iframe. Returns true if a frame was available to receive it.
  __tlForwardToTerminal?: (command: string) => boolean;
  // Set by the mounted TerminalView — the mobile soft-key/compose bridge. Posts
  // raw pty bytes DOWN to the terminal iframe as {type:'tl-input',bytes}. Returns
  // true if a frame was available. frontend/term.html implements the receiver
  // (mirrorLineReset() + sendInput(bytes)) in its terminal-mode message handler,
  // so the bridge is closed end-to-end.
  __tlSendToTerminal?: (bytes: string) => boolean;
  // Set by the mounted SessionView so the lobby's runAppCommand can flip the
  // per-session text/terminal view for a Ctrl/Cmd-J that was pressed INSIDE the
  // terminal iframe (its keydown never reaches this window; term.html forwards
  // it up as a `view.toggle` tl-command). Returns true if a session view was
  // mounted to toggle. Same bridge pattern as __tlForwardToTerminal: the lobby
  // shell owns neither the view mode nor the iframe.
  __tlToggleView?: () => boolean;
  // Set by the mounted TerminalView — asks the terminal iframe to re-fit its
  // xterm after a mobile viewport/keyboard change ({type:'tl-refit'}). Optional
  // bridge message (the ttyd page already refits on its own visualViewport
  // listeners); belt-and-braces for the SPA-driven resize.
  __tlRefitTerminal?: () => boolean;
}
