/**
 * The app's `--terminal-*` CSS custom properties -> an xterm ITheme.
 *
 * Extracted from term.html's `readTerminalTheme()` (the only producer of
 * xterm's `theme` option, at both the constructor and the live-retheme path),
 * with the DOM lifted out: this module takes a reader of CSS custom
 * properties and returns the object. The component owns
 * `getComputedStyle(document.body)`; nothing here touches a document, so the
 * rules below are testable without one.
 *
 * Three wiring facts the component must honour, because they are not visible
 * from inside this module:
 *
 *  - Read against `document.body`, not the terminal element. The scrollbar
 *    tokens are declared on `body` and flipped as a group by the light theme
 *    classes (`body.theme-ink`, `body.theme-t3-light`,
 *    `body.theme-catppuccin-latte`), so a reader anchored anywhere else only
 *    works by inheritance.
 *  - Re-theming live is `term.options.theme = ...` followed by
 *    `term.refresh(0, term.rows - 1)`. That is a pure repaint: selection,
 *    scroll position and mouse semantics survive it, which is the whole
 *    reason the iframe no longer reloads on a theme switch.
 *  - Publish that re-read as `window.__tlThemeLive`, and keep it published for
 *    as long as the terminal is mounted. It is the only door to the terminal
 *    for BOTH re-theme triggers (`TERMINAL_RETHEME_TRIGGERS` below names them;
 *    term.html funnels the two into one `liveRetheme()`, 9302-9309):
 *
 *      1. an explicit pick — `setTheme()` in src/theme/theme.ts, once it has
 *         persisted the choice and swapped the body class (inside the iframe
 *         term.html reaches the same place from its `tl-theme` message branch,
 *         9355-9360);
 *      2. an OS light/dark flip while the stored theme is `'system'` — the
 *         pre-paint boot script's `prefers-color-scheme` listener swaps the
 *         body class itself and then calls the global (term.html:2004-2008,
 *         the SPA shell ships its own copy at frontend-v2/index.html:163-176 —
 *         reformatted, comment-free, and WITHOUT term.html's
 *         `else if (/[?&]arg=/.test(location.search)) location.reload()`
 *         fallback, which is why trigger 2 has no other route in).
 *
 *    Trigger 2 has no other route in: that listener is inline in the shell,
 *    runs before any application code, and its only handle on the terminal is
 *    the global's name. Serve the picker alone and an OS flip re-themes the
 *    whole chrome while the terminal keeps the outgoing palette, with nothing
 *    to report it. Both callers pass a theme name that this path ignores — the
 *    re-read takes whatever is on `body` at call time — which is why each swaps
 *    the body class BEFORE calling; reversing the two repaints the palette the
 *    document is leaving.
 */

/**
 * The slice of xterm's `ITheme` this app sets. Declared structurally rather
 * than imported so the module stays free of the 330 KB xterm chunk — it is
 * assignable to `ITheme`, which has every one of these as an optional string.
 */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
}

/** Reads one CSS custom property. `CSSStyleDeclaration.getPropertyValue` fits. */
export type CssVarReader = (name: string) => string | null | undefined;

/**
 * One ITheme key, the custom properties it reads in order of preference, and
 * the value used when every one of them is absent.
 *
 * `vars` is a chain rather than a single name because `cursorAccent` needs
 * two steps: it is the colour xterm paints the glyph UNDER the block cursor,
 * so it has to invert to the terminal's own background. A theme that declares
 * no accent must still land on its own `--terminal-bg` — falling straight
 * through to the hard default would paint slate's near-black under the cursor
 * on a light theme, which is an invisible character.
 */
export interface TerminalThemeRule {
  readonly key: keyof XtermTheme;
  readonly vars: readonly string[];
  readonly fallback: string;
}

/**
 * The mapping, as data.
 *
 * Fallbacks are the slate palette (the app default), so a document with no
 * theme class still gets a coherent dark terminal rather than xterm's own
 * defaults. The 16 ANSI slots are the T3-seeded dark set slate ships.
 */
export const TERMINAL_THEME_RULES: readonly TerminalThemeRule[] = [
  { key: "background", vars: ["--terminal-bg"], fallback: "#0d1117" },
  { key: "foreground", vars: ["--terminal-fg"], fallback: "#e6e8eb" },
  { key: "cursor", vars: ["--terminal-cursor"], fallback: "#4493f8" },
  {
    key: "cursorAccent",
    vars: ["--terminal-cursor-accent", "--terminal-bg"],
    fallback: "#0d1117",
  },
  {
    key: "selectionBackground",
    vars: ["--terminal-selection"],
    fallback: "rgba(68,147,248,0.22)",
  },
  { key: "black", vars: ["--terminal-ansi-black"], fallback: "#161b22" },
  { key: "red", vars: ["--terminal-ansi-red"], fallback: "#ff7a8e" },
  { key: "green", vars: ["--terminal-ansi-green"], fallback: "#86e795" },
  { key: "yellow", vars: ["--terminal-ansi-yellow"], fallback: "#f4cd72" },
  { key: "blue", vars: ["--terminal-ansi-blue"], fallback: "#89beff" },
  { key: "magenta", vars: ["--terminal-ansi-magenta"], fallback: "#d0b0ff" },
  { key: "cyan", vars: ["--terminal-ansi-cyan"], fallback: "#7ce8ed" },
  { key: "white", vars: ["--terminal-ansi-white"], fallback: "#d2dae6" },
  { key: "brightBlack", vars: ["--terminal-ansi-bright-black"], fallback: "#6e7888" },
  { key: "brightRed", vars: ["--terminal-ansi-bright-red"], fallback: "#ffa8b4" },
  { key: "brightGreen", vars: ["--terminal-ansi-bright-green"], fallback: "#b0f5ba" },
  { key: "brightYellow", vars: ["--terminal-ansi-bright-yellow"], fallback: "#ffe095" },
  { key: "brightBlue", vars: ["--terminal-ansi-bright-blue"], fallback: "#aed2ff" },
  { key: "brightMagenta", vars: ["--terminal-ansi-bright-magenta"], fallback: "#e5cbff" },
  { key: "brightCyan", vars: ["--terminal-ansi-bright-cyan"], fallback: "#a7f4f7" },
  { key: "brightWhite", vars: ["--terminal-ansi-bright-white"], fallback: "#f4f7fc" },
  // Scrollbar slider colours (Task 1.10). These read the LOBBY chrome tokens,
  // not any --terminal-* token, and they are live rather than decorative:
  // xterm 6.0's VS Code-derived overlay scrollbar (.xterm-scrollable-element)
  // paints itself from them. On 5.5.0 the keys did not exist in ITheme and
  // unknown keys were never read, which is why a copy of this mapping can drop
  // them and nothing fails until someone looks at the scrollbar.
  //
  // The terminal's scrollbar is themed HERE and never in CSS: styling any
  // ::-webkit-scrollbar pseudo on .xterm-viewport flips it to custom rendering
  // and can change the width xterm measured at open(), which moves the grid.
  {
    key: "scrollbarSliderBackground",
    vars: ["--scrollbar-thumb"],
    fallback: "rgba(255,255,255,0.1)",
  },
  {
    key: "scrollbarSliderHoverBackground",
    vars: ["--scrollbar-thumb-hover"],
    fallback: "rgba(255,255,255,0.18)",
  },
  {
    key: "scrollbarSliderActiveBackground",
    vars: ["--scrollbar-thumb-active"],
    fallback: "rgba(255,255,255,0.22)",
  },
];

/** Every custom property the mapping reads, deduped, in rule order. */
export const TERMINAL_THEME_VARS: readonly string[] = Array.from(
  new Set(TERMINAL_THEME_RULES.flatMap((r) => r.vars)),
);

/**
 * Absent from the stylesheet, `getPropertyValue` returns `""`; present, it can
 * return the declaration's leading space with it (`" #0d1117"`). Trim first,
 * then treat empty as absent — an untrimmed value is truthy, so it would skip
 * the fallback and hand xterm a colour string it cannot parse.
 */
function firstSet(read: CssVarReader, vars: readonly string[], fallback: string): string {
  for (const name of vars) {
    const value = (read(name) ?? "").trim();
    if (value) return value;
  }
  return fallback;
}

/** The effective xterm ITheme for whatever element the reader resolves against. */
export function toXtermTheme(read: CssVarReader): XtermTheme {
  const theme = {} as XtermTheme;
  for (const rule of TERMINAL_THEME_RULES) {
    theme[rule.key] = firstSet(read, rule.vars, rule.fallback);
  }
  return theme;
}

/** The same mapping over a plain bag of values, for tests and non-DOM callers. */
export function xtermThemeFromVars(vars: Readonly<Record<string, string>>): XtermTheme {
  return toXtermTheme((name) => vars[name]);
}

/** What an unstyled document yields: slate, in full. */
export const TERMINAL_THEME_FALLBACK: XtermTheme = toXtermTheme(() => "");

/**
 * The global name the component publishes the live re-read under. Both triggers
 * below call it by this exact string — one of them from a script inline in the
 * shell HTML, which cannot import anything — so the name is a wire format, not
 * an implementation detail, and renaming it unwires that caller in silence.
 */
export const THEME_LIVE_GLOBAL = "__tlThemeLive";

/** One reason the terminal's palette has to be re-read from the body. */
export interface RethemeTrigger {
  readonly id: "theme-pick" | "os-scheme-flip";
  /** What calls `window[THEME_LIVE_GLOBAL]`, after swapping the body class. */
  readonly caller: string;
  /** The condition under which that caller fires. */
  readonly when: string;
}

/**
 * Both triggers, as data, because the second one is the one that gets lost.
 *
 * The picker path is self-announcing — somebody clicks a swatch and something
 * changes in front of them — so a component wired for it alone looks finished.
 * The OS-flip path fires with nobody in the app at all (the system went dark at
 * sunset), and it fails silently and by halves: chrome on the new theme, the
 * terminal still on the old one, no error raised anywhere.
 */
export const TERMINAL_RETHEME_TRIGGERS: readonly RethemeTrigger[] = [
  {
    id: "theme-pick",
    caller: "setTheme() in src/theme/theme.ts",
    when: "the user picks a theme — including a re-click of the active swatch, which is how a failed localStorage write gets repaired",
  },
  {
    id: "os-scheme-flip",
    caller:
      "the pre-paint boot script's prefers-color-scheme listener, inline in frontend-v2/index.html",
    when: "the OS flips light/dark while the stored theme is exactly 'system' — an unset choice stays slate and does not follow the OS",
  },
];
