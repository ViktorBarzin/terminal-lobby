import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRunAppCommand } from "../src/keybindings/commands";
import type { LobbyStore } from "../src/store/lobby";
import type { PaletteController } from "../src/keybindings/palette-controller";
import type { HelpController } from "../src/components/ShortcutsHelp";

/**
 * frontend/term.html ⟷ frontend-v2 BRIDGE contracts.
 *
 * term.html has no build step and therefore no test harness of its own, and the
 * two ends of its postMessage bridge live in different languages in different
 * files — which is exactly how Ctrl+J came to dead-end: the terminal page
 * swallowed the chord and forwarded a command name (`session.new.shell`) that
 * the v2 dispatcher had no branch for. These tests slice the shipped source and
 * run it, so the contract is checked rather than assumed.
 */

const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
const html = (): string => readFileSync(TERM_HTML, "utf8");

/** The `const NAME = [ … ];` literal, sliced out of the page source. */
function sliceArrayLiteral(src: string, name: string): string {
  const decl = `const ${name} = [`;
  const start = src.indexOf(decl);
  expect(start, `${name} declaration`).toBeGreaterThan(-1);
  const end = src.indexOf("];", start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

/** The source between a pair of `// >>> name` / `// <<< name` sentinels. */
function sliceKernel(src: string, name: string): string {
  const start = src.indexOf(`// >>> ${name}`);
  const end = src.indexOf(`// <<< ${name}`);
  expect(start, `opening ${name} sentinel`).toBeGreaterThan(-1);
  expect(end, `closing ${name} sentinel`).toBeGreaterThan(start);
  return src.slice(start, end);
}

interface AlwaysBinding {
  key: string;
  command: string;
  when?: string;
}

/** term.html's always-on binding table, evaluated for a non-Mac keyboard. */
function alwaysBindings(framed: boolean): AlwaysBinding[] {
  const src = sliceArrayLiteral(html(), "KB_ALWAYS_BINDINGS");
  return runInNewContext(`${src}; KB_ALWAYS_BINDINGS`, {
    IS_MAC: false,
    FRAMED_BY_LOBBY: framed,
  }) as AlwaysBinding[];
}

const jChord = (framed: boolean): AlwaysBinding | undefined =>
  alwaysBindings(framed).find((b) => b.key === "ctrl+j");

const noop = (): void => {};

describe("term.html — the framed Ctrl+J chord reaches the v2 dispatcher", () => {
  it("binds Ctrl+J only while a lobby owns the keys", () => {
    const j = jChord(true);
    expect(j, "an always-on ctrl+j binding").toBeDefined();
    // `lobbyOpen` is `isFramed` in term.html's TERMINAL-mode getContext, so a
    // bare deep-linked ?arg= tab never matches this chord and Ctrl+J stays the
    // LF byte it is in every other terminal.
    expect(j?.when).toBe("lobbyOpen && !galleryOpen");
  });

  it("keeps the scratch-shell-dock meaning when NOT framed", () => {
    // /term.html with no ?arg= is a lobby of its own (lobbyOpen: true, a dock,
    // and a `session.new.shell` branch in its own runAppCommand) and is served
    // to the stable tier from the same shared asset dir. Only the framed
    // meaning may change.
    expect(jChord(false)?.command).toBe("session.new.shell");
  });

  it("forwards a command the lobby dispatcher actually handles", () => {
    const j = jChord(true);
    expect(j?.command).toBe("view.toggle");
    const toggleView = vi.fn(() => true);
    const notify = vi.fn();
    const run = createRunAppCommand({
      store: {
        selected: () => null,
        model: () => [],
        sessions: [],
        select: noop,
        kill: noop,
        rename: noop,
      } as unknown as LobbyStore,
      palette: {
        isOpen: () => false,
        open: noop,
        close: noop,
        toggle: noop,
      } as unknown as PaletteController,
      help: { isOpen: () => false, open: noop, close: noop, toggle: noop } as HelpController,
      toggleSidebar: noop,
      focusNewSession: noop,
      notify,
      openGallery: noop,
      forwardToTerminal: () => false,
      toggleView,
    });

    // Exactly what App.tsx does with a `tl-command` postMessage from the frame.
    run(j?.command ?? "");
    expect(toggleView).toHaveBeenCalledTimes(1);
  });
});

interface FitGuard {
  fit: () => boolean;
  owed: () => boolean;
}

/** term.html's fit guard, wired to a settable box and a counting fit. */
function loadFitGuard(box: { width: number; height: number }): {
  guard: FitGuard;
  fits: () => number;
} {
  let fits = 0;
  const src = sliceKernel(html(), "tl-fit-guard");
  const guard = runInNewContext(
    `${src}; createFitGuard(measure, doFit)`,
    { measure: () => box, doFit: () => void fits++ },
  ) as FitGuard;
  return { guard, fits: () => fits };
}

describe("term.html — a fit is never taken against a zero-size viewport", () => {
  // The v2 lobby keeps this iframe MOUNTED but display:none while its Text view
  // shows (SessionView's .tl-hidden). Fitting xterm against that 0x0 box yields
  // a ~13x7 grid, xterm emits it as a resize, and ttyd's tmux client drags the
  // REAL window — and every other client attached to it — down to 13 columns.
  it("skips the fit while the container has no box, and records one is owed", () => {
    const { guard, fits } = loadFitGuard({ width: 0, height: 0 });
    expect(guard.fit()).toBe(false);
    expect(fits()).toBe(0);
    expect(guard.owed()).toBe(true);
  });

  it("skips on a zero height alone (a collapsed row is still unmeasurable)", () => {
    const { guard, fits } = loadFitGuard({ width: 1180, height: 0 });
    expect(guard.fit()).toBe(false);
    expect(fits()).toBe(0);
  });

  it("fits — and clears the debt — once a real box exists", () => {
    const box = { width: 0, height: 0 };
    const { guard, fits } = loadFitGuard(box);
    guard.fit(); // hidden boot: skipped
    box.width = 1180;
    box.height = 814;
    expect(guard.fit()).toBe(true);
    expect(fits()).toBe(1);
    expect(guard.owed()).toBe(false);
  });

  it("routes EVERY fit through the guard — no bare fitAddon.fit() is left", () => {
    // Five call sites shared one unguarded fitAddon.fit(): the post-open boot
    // fit, the late-font refit, the debounced resize refit, the boot-end fit and
    // the prefs metric swap. Guarding one and leaving four is not a fix, so the
    // invariant is pinned as "the page calls fitAddon.fit() in exactly one
    // place" — inside the guard.
    const sites = html().match(/fitAddon\.fit\(\)/g) ?? [];
    expect(sites).toHaveLength(1);
  });
});

interface FramedChrome {
  FRAMED_CHROME_IDS: string[];
  hideFramedChrome: (doc: unknown, framed: boolean) => string[];
}

/** term.html's framed-chrome kernel + a fake document of the five buttons. */
function loadFramedChrome(): { kernel: FramedChrome; classes: Record<string, string[]> } {
  const src = sliceKernel(html(), "tl-framed-chrome");
  const kernel = runInNewContext(
    `${src}; ({ FRAMED_CHROME_IDS, hideFramedChrome })`,
    {},
  ) as FramedChrome;
  const classes: Record<string, string[]> = {};
  for (const id of kernel.FRAMED_CHROME_IDS) classes[id] = [];
  return { kernel, classes };
}

function fakeDoc(classes: Record<string, string[]>): {
  getElementById: (id: string) => { classList: { add: (c: string) => void } } | null;
} {
  return {
    getElementById: (id) =>
      classes[id]
        ? { classList: { add: (c: string) => void classes[id]!.push(c) } }
        : null,
  };
}

describe("term.html — the in-frame image/font cluster yields to the lobby's own", () => {
  it("hides the whole cluster when the v2 SPA is the frame", () => {
    const { kernel, classes } = loadFramedChrome();
    const hidden = kernel.hideFramedChrome(fakeDoc(classes), true);
    expect(hidden.sort()).toEqual(
      ["font-dec-btn", "font-inc-btn", "gallery-btn", "img-btn", "paste-btn"],
    );
    for (const id of kernel.FRAMED_CHROME_IDS) expect(classes[id]).toContain("hidden");
  });

  it("leaves a STANDALONE /term.html tab its only chrome", () => {
    const { kernel, classes } = loadFramedChrome();
    expect(kernel.hideFramedChrome(fakeDoc(classes), false)).toEqual([]);
    for (const id of kernel.FRAMED_CHROME_IDS) expect(classes[id]).toEqual([]);
  });
});

interface AttentionKernel {
  attentionHidden: () => boolean;
  setViewHidden: (v: boolean) => void;
  rearmHiddenOutput: () => void;
  noteHiddenOutput: () => void;
}

function loadAttentionKernel(): {
  kernel: AttentionKernel;
  doc: { hidden: boolean };
  signalled: string[];
} {
  const doc = { hidden: false };
  const signalled: string[] = [];
  const src = sliceKernel(html(), "tl-attention-kernel");
  const kernel = runInNewContext(
    `${src}; ({ attentionHidden, setViewHidden, rearmHiddenOutput, noteHiddenOutput })`,
    {
      document: doc,
      signalAttention: (kind: string) => signalled.push(kind),
    },
  ) as AttentionKernel;
  return { kernel, doc, signalled };
}

describe("term.html — output attention while the VIEW (not the tab) is hidden", () => {
  it("stays quiet while both the tab and the view are showing", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual([]);
  });

  it("signals once per hidden period when the lobby CSS-hides the view", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true); // the SPA switched to its text view
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });

  it("re-arms when the view comes back, so the next burst signals again", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    kernel.noteHiddenOutput();
    kernel.setViewHidden(false); // back on the Terminal segment
    kernel.noteHiddenOutput(); // visible now — nothing to badge
    kernel.setViewHidden(true);
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("keeps the original tab-hidden behaviour", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    doc.hidden = true;
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
    doc.hidden = false;
    kernel.rearmHiddenOutput();
    doc.hidden = true;
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("stays armed on a tab return while the view is still hidden", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    doc.hidden = true;
    kernel.noteHiddenOutput();
    doc.hidden = false;
    kernel.rearmHiddenOutput(); // visibilitychange fires, but the view is hidden
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });
});

/**
 * THE DEAD PATH: the tab going away while the view was ALREADY hidden.
 *
 * The lobby only latches its tab badge for a signal that arrives while the tab
 * is away — a signal sent while you are looking at the tab is dropped on the
 * floor. So when the view-hidden period opened with a frame of output (the
 * attach paint, or the redraw the view switch itself causes) the one-shot was
 * burned on a signal nobody could use, and every later output — including the
 * one that arrives after you tab away — was silent. The bell path always worked,
 * which is what made this look like "output attention is just broken".
 */
describe("term.html — the tab going away RE-ARMS an already-hidden view", () => {
  it("signals again when the tab hides on top of a spent view-hidden shot", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true); // SPA shows its Text view
    kernel.noteHiddenOutput(); // the attach paint — lobby drops it (not away)
    expect(signalled).toEqual(["output"]);

    doc.hidden = true; // the user tabs away
    kernel.rearmHiddenOutput(); // visibilitychange
    kernel.noteHiddenOutput(); // `echo probe` lands in the pty
    expect(signalled).toEqual(["output", "output"]);
  });

  it("is still one signal per away period, not one per output frame", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });

  it("re-arms for the terminal view too (tab hides with the view on screen)", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    doc.hidden = false;
    kernel.rearmHiddenOutput();
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("the visibilitychange listener re-arms on the way OUT as well as back", () => {
    // The handler used to `return` before re-arming whenever the tab was going
    // hidden, so becoming hidden could never open a new period.
    const src = html();
    // term.html has several visibilitychange listeners; this is the attention
    // one — the one that calls rearmHiddenOutput.
    const rearm = src.indexOf("rearmHiddenOutput();\n", src.indexOf("// <<< tl-attention-kernel"));
    expect(rearm, "the attention visibilitychange listener").toBeGreaterThan(-1);
    const start = src.lastIndexOf("document.addEventListener('visibilitychange'", rearm);
    expect(start, "its addEventListener").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n        });", start));
    expect(body).toContain("rearmHiddenOutput();");
    expect(body).toContain("if (document.hidden) return;");
    expect(body.indexOf("rearmHiddenOutput();")).toBeLessThan(
      body.indexOf("if (document.hidden) return;"),
    );
  });
});
