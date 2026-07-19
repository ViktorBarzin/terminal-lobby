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
}
