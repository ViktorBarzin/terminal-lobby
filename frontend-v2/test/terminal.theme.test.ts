import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TERMINAL_RETHEME_TRIGGERS,
  TERMINAL_THEME_FALLBACK,
  TERMINAL_THEME_RULES,
  TERMINAL_THEME_VARS,
  THEME_LIVE_GLOBAL,
  toXtermTheme,
  xtermThemeFromVars,
  type XtermTheme,
} from "../src/terminal/theme";

/**
 * A reader that answers every custom property with its own name. Every slot
 * then carries the var it came from, so a swapped pair (bright-red into `red`)
 * or a kebab/camel slip reads straight off the failure diff.
 */
const sentinels = (name: string) => name;

/** Slate's declarations, copied from the theme CSS. Slate is the app default. */
const SLATE: Record<string, string> = {
  "--terminal-bg": "#0d1117",
  "--terminal-fg": "#e6e8eb",
  "--terminal-cursor": "#4493f8",
  "--terminal-selection": "rgba(68,147,248,0.22)",
  "--terminal-cursor-accent": "#0d1117",
  "--terminal-ansi-black": "#161b22",
  "--terminal-ansi-red": "#ff7a8e",
  "--terminal-ansi-green": "#86e795",
  "--terminal-ansi-yellow": "#f4cd72",
  "--terminal-ansi-blue": "#89beff",
  "--terminal-ansi-magenta": "#d0b0ff",
  "--terminal-ansi-cyan": "#7ce8ed",
  "--terminal-ansi-white": "#d2dae6",
  "--terminal-ansi-bright-black": "#6e7888",
  "--terminal-ansi-bright-red": "#ffa8b4",
  "--terminal-ansi-bright-green": "#b0f5ba",
  "--terminal-ansi-bright-yellow": "#ffe095",
  "--terminal-ansi-bright-blue": "#aed2ff",
  "--terminal-ansi-bright-magenta": "#e5cbff",
  "--terminal-ansi-bright-cyan": "#a7f4f7",
  "--terminal-ansi-bright-white": "#f4f7fc",
};

/** Catppuccin Latte, a light theme — used where the light path differs. */
const LATTE: Record<string, string> = {
  "--terminal-bg": "#eff1f5",
  "--terminal-fg": "#4c4f69",
  "--terminal-cursor": "#dc8a78",
  "--terminal-selection": "rgba(136,57,239,0.18)",
  "--terminal-cursor-accent": "#eff1f5",
  // The light themes flip the scrollbar tokens as a group on body.
  "--scrollbar-thumb": "rgba(0, 0, 0, 0.15)",
  "--scrollbar-thumb-hover": "rgba(0, 0, 0, 0.25)",
  "--scrollbar-thumb-active": "rgba(0, 0, 0, 0.3)",
};

describe("the CSS-var to ITheme mapping", () => {
  it("sends each of the 16 ANSI vars to its own colour slot", () => {
    const t = toXtermTheme(sentinels);
    expect(t.black).toBe("--terminal-ansi-black");
    expect(t.red).toBe("--terminal-ansi-red");
    expect(t.green).toBe("--terminal-ansi-green");
    expect(t.yellow).toBe("--terminal-ansi-yellow");
    expect(t.blue).toBe("--terminal-ansi-blue");
    expect(t.magenta).toBe("--terminal-ansi-magenta");
    expect(t.cyan).toBe("--terminal-ansi-cyan");
    expect(t.white).toBe("--terminal-ansi-white");
    expect(t.brightBlack).toBe("--terminal-ansi-bright-black");
    expect(t.brightRed).toBe("--terminal-ansi-bright-red");
    expect(t.brightGreen).toBe("--terminal-ansi-bright-green");
    expect(t.brightYellow).toBe("--terminal-ansi-bright-yellow");
    expect(t.brightBlue).toBe("--terminal-ansi-bright-blue");
    expect(t.brightMagenta).toBe("--terminal-ansi-bright-magenta");
    expect(t.brightCyan).toBe("--terminal-ansi-bright-cyan");
    expect(t.brightWhite).toBe("--terminal-ansi-bright-white");
  });

  it("sends the five core vars to their own slots", () => {
    const t = toXtermTheme(sentinels);
    expect(t.background).toBe("--terminal-bg");
    expect(t.foreground).toBe("--terminal-fg");
    expect(t.cursor).toBe("--terminal-cursor");
    expect(t.cursorAccent).toBe("--terminal-cursor-accent");
    expect(t.selectionBackground).toBe("--terminal-selection");
  });

  /**
   * xterm reads a key it was not given from its OWN default palette, so a
   * dropped rule does not throw — it just paints the wrong red. Pin the shape
   * so losing a slot fails here instead of on someone's screen.
   */
  it("fills every slot, so none of them falls through to xterm's own palette", () => {
    const t = toXtermTheme(sentinels);
    expect(Object.keys(t).sort()).toEqual(
      [
        "background",
        "black",
        "blue",
        "brightBlack",
        "brightBlue",
        "brightCyan",
        "brightGreen",
        "brightMagenta",
        "brightRed",
        "brightWhite",
        "brightYellow",
        "cursor",
        "cursorAccent",
        "cyan",
        "foreground",
        "green",
        "magenta",
        "red",
        "scrollbarSliderActiveBackground",
        "scrollbarSliderBackground",
        "scrollbarSliderHoverBackground",
        "selectionBackground",
        "white",
        "yellow",
      ].sort(),
    );
    for (const value of Object.values(t)) expect(value).toBeTruthy();
  });

  it("reads a real theme's declarations back unchanged", () => {
    const t = xtermThemeFromVars(SLATE);
    expect(t.background).toBe("#0d1117");
    expect(t.foreground).toBe("#e6e8eb");
    expect(t.cursor).toBe("#4493f8");
    expect(t.selectionBackground).toBe("rgba(68,147,248,0.22)");
    expect(t.red).toBe("#ff7a8e");
    expect(t.brightRed).toBe("#ffa8b4");
  });
});

describe("cursorAccent, the colour painted under the block cursor", () => {
  it("prefers the theme's explicit accent", () => {
    expect(xtermThemeFromVars(LATTE).cursorAccent).toBe("#eff1f5");
  });

  /**
   * The rule that costs the most if it is dropped. cursorAccent has to invert
   * to the terminal's own background; a theme that declares no accent must
   * still land on its --terminal-bg. Collapsing the chain to a single var
   * would paint slate's near-black under the cursor on a light theme, which
   * hides the character the cursor is sitting on.
   */
  it("falls back to the theme's own background, not to the packaged dark one", () => {
    const noAccent = { ...LATTE };
    delete noAccent["--terminal-cursor-accent"];
    expect(xtermThemeFromVars(noAccent).cursorAccent).toBe("#eff1f5");
    expect(xtermThemeFromVars(noAccent).cursorAccent).not.toBe("#0d1117");
  });

  it("reaches the packaged default only when neither var is declared", () => {
    expect(xtermThemeFromVars({}).cursorAccent).toBe("#0d1117");
  });

  /** A blank accent is an absent accent, so the chain must not stop on it. */
  it("steps past a blank accent to the background", () => {
    expect(
      xtermThemeFromVars({ "--terminal-cursor-accent": "   ", "--terminal-bg": "#faf7f2" })
        .cursorAccent,
    ).toBe("#faf7f2");
  });
});

describe("absent and whitespace values", () => {
  /**
   * getPropertyValue hands back the declaration's leading space in some
   * engines (" #0d1117"). Untrimmed it is still truthy, so it would skip the
   * fallback and reach xterm as a colour string it cannot parse.
   */
  it("trims the leading space getPropertyValue leaves on a declaration", () => {
    expect(xtermThemeFromVars({ "--terminal-bg": " #0d1117" }).background).toBe("#0d1117");
    expect(xtermThemeFromVars({ "--terminal-ansi-red": "\n  #ff7a8e\t" }).red).toBe("#ff7a8e");
  });

  it("treats a whitespace-only value as absent and takes the fallback", () => {
    expect(xtermThemeFromVars({ "--terminal-ansi-red": "   " }).red).toBe("#ff7a8e");
  });

  it("treats the empty string an unset property returns as absent", () => {
    expect(xtermThemeFromVars({ "--terminal-fg": "" }).foreground).toBe("#e6e8eb");
  });

  /** A reader wired to something other than getComputedStyle may answer null. */
  it("survives a reader that answers null or undefined", () => {
    expect(toXtermTheme(() => null).foreground).toBe("#e6e8eb");
    expect(toXtermTheme(() => undefined).cursorAccent).toBe("#0d1117");
  });
});

describe("the scrollbar slider colours", () => {
  /**
   * They read the LOBBY chrome tokens, never a --terminal-* one, and they are
   * live: xterm 6.0's VS Code-derived overlay scrollbar paints from them. On
   * 5.5.0 the keys did not exist in ITheme and were simply never read, which
   * is how a copy of this mapping loses them without anything failing.
   */
  it("reads the lobby chrome tokens rather than any terminal token", () => {
    const t = xtermThemeFromVars(SLATE); // every --terminal-* var set, no scrollbar var
    expect(t.scrollbarSliderBackground).toBe("rgba(255,255,255,0.1)");
    expect(t.scrollbarSliderHoverBackground).toBe("rgba(255,255,255,0.18)");
    expect(t.scrollbarSliderActiveBackground).toBe("rgba(255,255,255,0.22)");

    const fromSentinels = toXtermTheme(sentinels);
    expect(fromSentinels.scrollbarSliderBackground).toBe("--scrollbar-thumb");
    expect(fromSentinels.scrollbarSliderHoverBackground).toBe("--scrollbar-thumb-hover");
    expect(fromSentinels.scrollbarSliderActiveBackground).toBe("--scrollbar-thumb-active");
  });

  it("follows the light themes' group flip to dark-on-light thumbs", () => {
    const t = xtermThemeFromVars(LATTE);
    expect(t.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.15)");
    expect(t.scrollbarSliderHoverBackground).toBe("rgba(0, 0, 0, 0.25)");
    expect(t.scrollbarSliderActiveBackground).toBe("rgba(0, 0, 0, 0.3)");
  });

  /**
   * Three states, three tokens. Pointing all three at --scrollbar-thumb would
   * still look right at rest and lose the hover and drag feedback entirely.
   */
  it("keeps the three slider states on separate tokens", () => {
    const t = xtermThemeFromVars({ "--scrollbar-thumb": "#111" });
    expect(t.scrollbarSliderBackground).toBe("#111");
    expect(t.scrollbarSliderHoverBackground).toBe("rgba(255,255,255,0.18)");
    expect(t.scrollbarSliderActiveBackground).toBe("rgba(255,255,255,0.22)");
  });
});

describe("the module's own shape", () => {
  /** An unthemed document has to render as the app default, not as xterm's. */
  it("falls back to slate for a document with no theme class", () => {
    for (const [name, value] of Object.entries(SLATE)) {
      const rule = TERMINAL_THEME_RULES.find((r) => r.vars[0] === name);
      expect(rule, `no rule reads ${name}`).toBeDefined();
      expect(TERMINAL_THEME_FALLBACK[rule!.key as keyof XtermTheme]).toBe(value);
    }
  });

  /**
   * The component subscribes to these names. --terminal-bg is read by two
   * rules (background, and cursorAccent's second step) and must still be
   * listed once, or a var-diffing caller compares it against itself.
   */
  it("lists every var it reads exactly once", () => {
    const all = TERMINAL_THEME_RULES.flatMap((r) => r.vars);
    expect(all.length).toBe(25); // 24 slots, cursorAccent reading two
    expect(TERMINAL_THEME_VARS.length).toBe(24);
    expect(new Set(TERMINAL_THEME_VARS).size).toBe(TERMINAL_THEME_VARS.length);
    for (const name of all) expect(TERMINAL_THEME_VARS).toContain(name);
  });

  /**
   * The live-retheme path assigns the result straight onto term.options.theme
   * and xterm keeps the reference. Handing out a shared object would let one
   * terminal's mutation reach the next read.
   */
  it("hands out a fresh object per call", () => {
    const first = toXtermTheme(sentinels);
    const second = toXtermTheme(sentinels);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.red = "#000000";
    expect(toXtermTheme(sentinels).red).toBe("--terminal-ansi-red");
    expect(TERMINAL_THEME_FALLBACK.red).toBe("#ff7a8e");
  });
});

/**
 * The trigger an extraction loses.
 *
 * A theme re-read has two causes, and only one of them involves a person in
 * the app: the picker, and an OS light/dark flip while the stored theme is
 * 'system'. Both arrive through one global, `__tlThemeLive` — the picker from
 * theme.ts, the OS flip from the pre-paint boot script's prefers-color-scheme
 * listener in index.html, which swaps the body class itself and then calls the
 * global instead of reloading the page. It can only reach a terminal that
 * published the global; a component wired for the picker alone leaves an OS
 * flip re-theming the chrome while the terminal keeps the outgoing palette,
 * silently. These tests pin the fact in the one place it survives the port —
 * this module — so it cannot be dropped again.
 *
 * The page half of each check went on 2026-09-05 with `frontend/term.html`,
 * which carried its own copy of that listener (term.html:2004-2008, and the
 * tl-theme branch at :9355-9360) and its own `liveRetheme`. index.html's copy
 * is the only one now, and it is still checked here.
 */
describe("the second re-theme trigger: an OS scheme flip under theme='system'", () => {
  const shell = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const source = readFileSync(resolve(process.cwd(), "src/terminal/theme.ts"), "utf8");

  it("names both callers that can reach the terminal, not just the picker", () => {
    expect(TERMINAL_RETHEME_TRIGGERS.map((t) => t.id)).toEqual([
      "theme-pick",
      "os-scheme-flip",
    ]);
    for (const trigger of TERMINAL_RETHEME_TRIGGERS) {
      expect(trigger.caller).toBeTruthy();
      expect(trigger.when).toBeTruthy();
    }
  });

  /** The name is a wire format: the listener is inline HTML and imports nothing. */
  it("pins the global name the shell calls by hand", () => {
    expect(THEME_LIVE_GLOBAL).toBe("__tlThemeLive");
    expect(shell).toContain(`window.${THEME_LIVE_GLOBAL}("system");`);
  });

  /**
   * The condition, not just the trigger's existence. An unset choice is slate
   * and must NOT follow the OS, so the listener returns early unless the stored
   * value is exactly 'system' — a module that recorded "follows the OS" flatly
   * would have the component re-theme users who never opted in.
   */
  it("fires only when the stored theme is exactly 'system'", () => {
    const osFlip = TERMINAL_RETHEME_TRIGGERS.find((t) => t.id === "os-scheme-flip");
    expect(osFlip?.when).toContain("'system'");
    expect(shell).toContain('if (stored() !== "system") return;');
  });

  /**
   * Ordering: the listener swaps the body class BEFORE calling the global,
   * because the re-read takes whatever is on body at call time. Reversed, the
   * repaint would carry the palette the document is leaving.
   */
  it("swaps the body class before calling the global", () => {
    expect(shell.indexOf('window.__tlApplyTheme("system");')).toBeLessThan(
      shell.indexOf('window.__tlThemeLive("system");'),
    );
  });

  /**
   * Why that ordering matters, in this module's own terms: the mapping is a
   * function of the reader alone. Both callers pass a theme NAME, and this path
   * has no use for it — the page's own `liveRetheme` took no parameter at all.
   */
  it("follows the body, never the theme name its callers pass", () => {
    let vars: Record<string, string> = SLATE;
    const read = (name: string) => vars[name];
    expect(toXtermTheme(read).background).toBe("#0d1117");
    vars = LATTE; // the OS flipped and the boot script swapped the class
    expect(toXtermTheme(read).background).toBe("#eff1f5");
    expect(toXtermTheme(read).scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.15)");
  });

  /**
   * The header is what an integrator actually reads, and it is the only place
   * this fact survives extraction — the module has no DOM to show it in. A
   * two-item list wires the picker and stops, which is exactly the failure.
   */
  it("carries the fact in the header the integrator reads", () => {
    const header = source.slice(0, source.indexOf("export interface XtermTheme"));
    expect(header).not.toContain("Two wiring facts");
    expect(header).toContain("Three wiring facts");
    expect(header).toContain("__tlThemeLive");
    expect(header).toContain("prefers-color-scheme");
    expect(header).toContain("'system'");
  });
});
