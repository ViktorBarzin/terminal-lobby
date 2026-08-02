import { createSignal } from "solid-js";
import { track } from "../telemetry/track";

/**
 * Theme controller. The canonical name list + the class/meta applier live in
 * the pre-paint boot script (index.html) as window.__tlThemes / __tlApplyTheme,
 * so the first frame is already themed. This module reuses those globals (as the
 * vanilla app did) and adds a Solid signal so the picker is reactive. A pure-TS
 * fallback applier keeps things working where the boot script didn't run
 * (tests, or a future non-index.html host).
 */

export const THEME_KEY = "tmux-theme";
export const DEFAULT_THEME = "slate";

export const THEMES: readonly string[] =
  (typeof window !== "undefined" && window.__tlThemes) || [
    "carbon",
    "slate",
    "mono",
    "ink",
    "t3-dark",
    "t3-light",
    "catppuccin-mocha",
    "catppuccin-latte",
    "system",
  ];

/** Human labels for the picker. */
export const THEME_LABELS: Record<string, string> = {
  carbon: "Carbon",
  slate: "Slate",
  mono: "Mono",
  ink: "Ink",
  "t3-dark": "T3 Dark",
  "t3-light": "T3 Light",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  system: "System",
};

function storedTheme(): string {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t && THEMES.includes(t) ? t : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Pure-TS fallback for environments without the index.html boot script. */
function fallbackApply(theme: string): void {
  if (typeof document === "undefined" || !document.body) return;
  let t = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  if (t === "system") {
    t =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches
        ? "t3-dark"
        : "t3-light";
  }
  const b = document.body;
  for (const c of Array.from(b.classList)) {
    if (c.startsWith("theme-")) b.classList.remove(c);
  }
  b.classList.add("theme-" + t);
}

function apply(theme: string): void {
  if (typeof window !== "undefined" && window.__tlApplyTheme) {
    window.__tlApplyTheme(theme);
  } else {
    fallbackApply(theme);
  }
}

const [theme, setThemeSignal] = createSignal<string>(storedTheme());
export { theme };

/**
 * Live-switch the theme: persist the choice, re-apply the body class (CSS vars
 * cascade to all chrome + text-mode instantly), and notify any registered live
 * listener (e.g. the terminal view's xterm ITheme sync, once it owns xterm).
 */
export function setTheme(next: string): void {
  track("theme.changed", { "tl.to": next });
  const t = THEMES.includes(next) ? next : DEFAULT_THEME;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode / no storage */
  }
  apply(t);
  setThemeSignal(t);
  if (typeof window !== "undefined" && window.__tlThemeLive) {
    window.__tlThemeLive(t);
  }
}

/** Read the effective xterm ITheme from the live CSS vars (design: the
 * --terminal-ansi-* token layer feeds xterm when the terminal view owns it). */
export function readTerminalTheme(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const cs = getComputedStyle(document.body);
  const v = (k: string) => cs.getPropertyValue(k).trim();
  return {
    background: v("--terminal-bg") || "#0d1117",
    foreground: v("--terminal-fg") || "#e6e8eb",
    cursor: v("--terminal-cursor") || "#4493f8",
    cursorAccent: v("--terminal-cursor-accent") || v("--terminal-bg") || "#0d1117",
    selectionBackground: v("--terminal-selection") || "rgba(68,147,248,0.22)",
    black: v("--terminal-ansi-black") || "#161b22",
    red: v("--terminal-ansi-red") || "#ff7a8e",
    green: v("--terminal-ansi-green") || "#86e795",
    yellow: v("--terminal-ansi-yellow") || "#f4cd72",
    blue: v("--terminal-ansi-blue") || "#89beff",
    magenta: v("--terminal-ansi-magenta") || "#d0b0ff",
    cyan: v("--terminal-ansi-cyan") || "#7ce8ed",
    white: v("--terminal-ansi-white") || "#d2dae6",
    brightBlack: v("--terminal-ansi-bright-black") || "#6e7888",
    brightRed: v("--terminal-ansi-bright-red") || "#ffa8b4",
    brightGreen: v("--terminal-ansi-bright-green") || "#b0f5ba",
    brightYellow: v("--terminal-ansi-bright-yellow") || "#ffe095",
    brightBlue: v("--terminal-ansi-bright-blue") || "#aed2ff",
    brightMagenta: v("--terminal-ansi-bright-magenta") || "#e5cbff",
    brightCyan: v("--terminal-ansi-bright-cyan") || "#a7f4f7",
    brightWhite: v("--terminal-ansi-bright-white") || "#f4f7fc",
  };
}
