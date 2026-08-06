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
