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
  // terminal-document command (gallery.open / terminal.paste) DOWN to the active
  // iframe. Returns true if a frame was available to receive it.
  __tlForwardToTerminal?: (command: string) => boolean;
  // Set by the mounted TerminalView — the mobile soft-key/compose bridge. Posts
  // raw pty bytes DOWN to the terminal iframe as {type:'tl-input',bytes}. Returns
  // true if a frame was available. The ttyd page must implement the receiver
  // (see the bridge contract in TerminalView) — until it does, this is a no-op
  // on the iframe side (SPA sender is complete + tested).
  __tlSendToTerminal?: (bytes: string) => boolean;
  // Set by the mounted TerminalView — asks the terminal iframe to re-fit its
  // xterm after a mobile viewport/keyboard change ({type:'tl-refit'}). Optional
  // bridge message (the ttyd page already refits on its own visualViewport
  // listeners); belt-and-braces for the SPA-driven resize.
  __tlRefitTerminal?: () => boolean;
}
