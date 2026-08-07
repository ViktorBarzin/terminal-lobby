import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setTheme,
  theme,
  THEMES,
  THEME_KEY,
  DEFAULT_THEME,
} from "../src/theme/theme";

/** Every `track()` theme.ts emits, in order. */
const tracked: { name: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs?: Record<string, unknown>) => void tracked.push({ name, attrs }),
}));
const themeEvents = (): Record<string, unknown>[] =>
  tracked.filter((e) => e.name === "theme.changed").map((e) => e.attrs ?? {});

// theme.ts is a module singleton reusing the pre-paint boot globals; in tests
// those globals are absent, so setTheme's pure-TS fallback applier runs (adds
// body.theme-* + persists tmux-theme). Reset the relevant state per test.
beforeEach(() => {
  localStorage.clear();
  for (const c of Array.from(document.body.classList)) {
    if (c.startsWith("theme-")) document.body.classList.remove(c);
  }
  delete (window as { __tlThemeLive?: unknown }).__tlThemeLive;
  tracked.length = 0;
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

// theme.changed means the theme changed. Same rule prefs.ts:setPref already
// keeps for prefs.changed, and the one commit e06eccd restored for
// claude.state_changed: a `.changed` event that fires on a no-op is noise in
// the dashboard, and it must carry the value that was APPLIED, not the one the
// caller asked for.
describe("theme.changed telemetry", () => {
  it("records nothing when the active swatch is re-clicked", () => {
    setTheme("mono");
    expect(themeEvents()).toEqual([{ "tl.to": "mono" }]);

    setTheme("mono");
    setTheme("mono");
    setTheme("mono");

    expect(themeEvents()).toEqual([{ "tl.to": "mono" }]);
  });

  it("records exactly one event, carrying the new value, on a real switch", () => {
    setTheme("mono");
    tracked.length = 0;

    setTheme("ink");

    expect(themeEvents()).toEqual([{ "tl.to": "ink" }]);
  });

  it("never records a value it did not apply", () => {
    setTheme("mono");
    tracked.length = 0;

    setTheme("does-not-exist");

    expect(theme()).toBe(DEFAULT_THEME);
    // May emit (mono -> slate IS a change) or not, but never "does-not-exist".
    for (const attrs of themeEvents()) {
      expect(attrs["tl.to"]).toBe(DEFAULT_THEME);
    }
  });

  it("stays silent when a bogus value clamps to the theme already applied", () => {
    setTheme(DEFAULT_THEME);
    tracked.length = 0;

    setTheme("does-not-exist");

    expect(theme()).toBe(DEFAULT_THEME);
    expect(themeEvents()).toEqual([]);
  });

  // A re-click is a no-op for telemetry only — the write-through side effects
  // must still run, so a localStorage wiped by another tab or a listener
  // registered after the last switch is repaired by clicking the active swatch.
  it("still persists and re-pushes to the live listener on a re-click", () => {
    setTheme("ink");
    localStorage.removeItem(THEME_KEY);
    const spy = vi.fn();
    (window as { __tlThemeLive?: (t: string) => void }).__tlThemeLive = spy;

    setTheme("ink");

    expect(localStorage.getItem(THEME_KEY)).toBe("ink");
    expect(spy).toHaveBeenCalledWith("ink");
    expect(document.body.classList.contains("theme-ink")).toBe(true);
  });
});
