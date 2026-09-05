/// <reference types="vite/client" />

// Injected by Vite `define` (see vite.config.ts) / vitest define. The build id
// string that replaces the vanilla app's `__TL_BUILD__` token.
declare const __TL_BUILD__: string;

// Globals installed by the pre-paint theme boot script in index.html. The app
// (src/theme/theme.ts) reuses them, exactly as the vanilla app did.
//
// The rest are the TERMINAL BRIDGES. They are window globals rather than props
// because the terminal was a separate document until 2026-09-05 and a name was
// the only thing both sides could hold. TerminalNative owns them now
// (`ownWhile`, so the terminal ON SCREEN holds them rather than whichever
// mounted last), and each returns a boolean because callers read false as "no
// terminal took this". A lever passed through `onReady` is the shape to reach
// for when a new one is needed; these stay globals because the callers that
// reach them — the viewport sync, the paste routine, the overlays' focus
// handback — sit above the mounted session and hold no reference to it.
interface Window {
  __tlThemes?: string[];
  __tlApplyTheme?: (theme: string) => void;
  __tlThemeLive?: (theme: string) => void;
  // Set by the mounted TerminalNative — the mobile soft-key/compose bridge.
  // Sends raw pty bytes, through the same choke point a keystroke takes, so a
  // soft arrow cancels a flick coast and resets the compose mirror.
  __tlSendToTerminal?: (bytes: string) => boolean;

  // Clipboard TEXT the lobby has already read, for `term.paste()` (bracketed +
  // \r\n-normalized). The lobby reads because the async clipboard is gated on
  // document focus, which is not the terminal's when a lobby control was
  // clicked — see clipboard/paste.ts.
  __tlPasteToTerminal?: (text: string) => boolean;

  // Run the whole lobby-side paste (read the clipboard here, then send text
  // down / upload an image). Registered by the mounted SessionView so the
  // command palette and the Paste chord share the button's routine.
  __tlDoPaste?: () => boolean;
  // Set by the mounted SessionView so the lobby's runAppCommand can flip the
  // per-session text/terminal view. The palette and the Shortcuts sheet both
  // run `view.toggle` by name, and neither knows which session is mounted.
  // Returns true if a session view was mounted to toggle.
  __tlToggleView?: () => boolean;
  // Set by the mounted MessagesTimeline — scrolls to an event by id and flashes
  // its row, for jumping to a search hit. False when no row with that id is in
  // the DOM yet, which is how the caller knows to load earlier turns (or to
  // wait for the progressive mount to reach it). Same bridge pattern as
  // __tlToggleView: the timeline owns its scroller, and nothing above it does.
  __tlScrollToEvent?: (id: number) => boolean;
  // Set by the mounted SessionView while the text view is up — opens the
  // find-in-session overlay. False when no text view is mounted to search.
  __tlOpenFind?: () => boolean;
  // Set by the mounted TerminalNative — re-fits xterm after a mobile
  // viewport/keyboard change. Driven by mobile/viewport.ts, which measures the
  // window the terminal cannot measure for itself.
  __tlRefitTerminal?: () => boolean;
  /** Publish the soft-keyboard height (px) into the terminal. */
  __tlKeyboardOffset?: (px: number) => boolean;
  // Set by the mounted TerminalNative — hands keyboard focus BACK to the
  // terminal after a lobby overlay (command palette, shortcuts help) closes.
  // Those overlays take focus off the terminal, so dismissing one leaves focus
  // on <body> and the pty deaf until the user clicks. Returns false when the
  // TEXT view owns the keyboard — the terminal must never steal focus from the
  // composer.
  __tlFocusTerminal?: () => boolean;
  // The live prefs bridge, the sibling of __tlThemeLive. store/prefs.ts calls
  // it after persisting a change so the attached terminal applies the new font
  // size immediately instead of at its next mount.
  //
  // NOTHING INSTALLS IT TODAY. TerminalView owned it and was deleted with the
  // page it framed; TerminalNative has not picked it up, so A− and A+ write
  // tl-font-size and the terminal keeps its size until it remounts. Declared
  // rather than removed because the sender is already here and correct, and the
  // gap is one `ownWhile` on the receiving side.
  __tlPrefsLive?: (prefs: { fontSize: number }) => boolean;
  // Set by the mounted SessionView — attach stored files to the TEXT view's
  // composer tray from outside it (design 2026-08-17 decision 14). The 🖼 gallery
  // is a lobby overlay and the tray belongs to the composer, so the two have no
  // handle on each other; same bridge pattern as __tlDoPaste. Returns false when
  // no text-view composer is mounted to receive them.
  __tlAttachToComposer?: (
    items: { path: string; name: string; kind: "image" | "doc" }[],
  ) => boolean;
}
