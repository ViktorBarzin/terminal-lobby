import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setTheme,
  theme,
  THEMES,
  THEME_KEY,
  DEFAULT_THEME,
} from "../src/theme/theme";

// theme.ts is a module singleton reusing the pre-paint boot globals; in tests
// those globals are absent, so setTheme's pure-TS fallback applier runs (adds
// body.theme-* + persists tmux-theme). Reset the relevant state per test.
beforeEach(() => {
  localStorage.clear();
  for (const c of Array.from(document.body.classList)) {
    if (c.startsWith("theme-")) document.body.classList.remove(c);
  }
  delete (window as { __tlThemeLive?: unknown }).__tlThemeLive;
});
afterEach(() => {
  delete (window as { __tlThemeLive?: unknown }).__tlThemeLive;
});

describe("theme apply/persist", () => {
  it("exposes the nine picker choices with 'system' last", () => {
    expect(THEMES).toContain("slate");
    expect(THEMES).toContain("catppuccin-mocha");
    expect(THEMES.length).toBe(9);
    expect(THEMES[THEMES.length - 1]).toBe("system");
    expect(DEFAULT_THEME).toBe("slate");
  });

  it("persists the choice to tmux-theme and applies the body class", () => {
    setTheme("mono");
    expect(localStorage.getItem(THEME_KEY)).toBe("mono");
    expect(document.body.classList.contains("theme-mono")).toBe(true);
    expect(theme()).toBe("mono");
  });

  it("keeps exactly one theme-* class (swaps, never accumulates)", () => {
    setTheme("mono");
    setTheme("ink");
    const themeClasses = Array.from(document.body.classList).filter((c) =>
      c.startsWith("theme-"),
    );
    expect(themeClasses).toEqual(["theme-ink"]);
    expect(theme()).toBe("ink");
  });

  it("falls back to the default for an unknown theme name", () => {
    setTheme("carbon");
    setTheme("does-not-exist");
    expect(localStorage.getItem(THEME_KEY)).toBe(DEFAULT_THEME);
    expect(document.body.classList.contains(`theme-${DEFAULT_THEME}`)).toBe(true);
    expect(theme()).toBe(DEFAULT_THEME);
  });

  it("notifies the live listener (__tlThemeLive) for the terminal bridge", () => {
    const spy = vi.fn();
    (window as { __tlThemeLive?: (t: string) => void }).__tlThemeLive = spy;
    setTheme("ink");
    expect(spy).toHaveBeenCalledWith("ink");
  });
});
