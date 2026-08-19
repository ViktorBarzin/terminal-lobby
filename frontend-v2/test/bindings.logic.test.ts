import { describe, it, expect } from "vitest";
import {
  altLabel,
  commandAllowed,
  KB_ALWAYS_BINDINGS,
  KB_COMMANDS,
  KB_DEFAULT_BINDINGS,
  keyContext,
  matchesAppChord,
  normalizeKeybindings,
  resolveAlways,
  resolveBindings,
  type KeyContext,
  type KeyContextInput,
  type MatchInput,
} from "../src/keybindings/bindings.logic";
import type { ChordEventLike } from "../src/keybindings/chords.logic";
import { buildShortcutGroups } from "../src/components/ShortcutsHelp";

function ev(over: Partial<ChordEventLike>): ChordEventLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    type: "keydown",
    ...over,
  };
}

/** The shell's when-context with a chosen set of overlays open. */
function ctx(over: Partial<KeyContextInput> = {}): KeyContext {
  return keyContext({
    paletteOpen: false,
    helpOpen: false,
    settingsOpen: false,
    skillsOpen: false,
    galleryOpen: false,
    previewOpen: false,
    previewDirty: false,
    ...over,
  });
}

const LOBBY_CTX = ctx();

function input(over: Partial<MatchInput> = {}): MatchInput {
  return {
    enabled: true,
    resolvedDefaults: resolveBindings({}),
    resolvedAlways: resolveAlways(),
    ctx: LOBBY_CTX,
    ...over,
  };
}

describe("normalizeKeybindings", () => {
  it("defaults to enabled with no overrides for garbage/empty input", () => {
    expect(normalizeKeybindings(null)).toEqual({ enabled: true, overrides: {} });
    expect(normalizeKeybindings("nope")).toEqual({ enabled: true, overrides: {} });
    expect(normalizeKeybindings([])).toEqual({ enabled: true, overrides: {} });
  });

  it("honors an explicit {enabled:false} opt-out", () => {
    expect(normalizeKeybindings({ enabled: false }).enabled).toBe(false);
    // any non-false value stays enabled (on-by-default posture)
    expect(normalizeKeybindings({ enabled: "yes" }).enabled).toBe(true);
  });

  it("keeps overrides only for known commands with parseable chords", () => {
    const doc = normalizeKeybindings({
      overrides: {
        "palette.toggle": "ctrl+shift+p", // known + valid
        "session.attach.1": "not a chord", // unparseable -> dropped
        "bogus.command": "ctrl+x", // unknown command -> dropped
        "session.new": "k", // bare key -> unparseable -> dropped
      },
    });
    expect(doc.overrides).toEqual({ "palette.toggle": "ctrl+shift+p" });
  });

  it("every default command is a known override target", () => {
    for (const b of KB_DEFAULT_BINDINGS) expect(KB_COMMANDS.has(b.command)).toBe(true);
  });
});

describe("resolveBindings", () => {
  it("applies an override chord in place of the default", () => {
    const resolved = resolveBindings({ "palette.toggle": "ctrl+shift+p" });
    const pal = resolved.find((b) => b.command === "palette.toggle")!;
    expect(pal.chord).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "p" });
  });

  it("falls back to the default chord when no override is present", () => {
    const resolved = resolveBindings({});
    const pal = resolved.find((b) => b.command === "palette.toggle")!;
    expect(pal.chord).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "k" });
  });
});

describe("the help overlay tells the truth about the always-on layer", () => {
  // The bug this pins: the layer can be switched off in Settings and
  // Alt+Shift+Backspace still kills the attached session. That exemption is
  // deliberate (KB_ALWAYS_BINDINGS) — the copy claiming otherwise was not. Bind
  // the two together so adding an always-on chord without documenting it fails.
  it("marks every KB_ALWAYS_BINDINGS chord as always on in the help", () => {
    const rows = buildShortcutGroups(altLabel(false), false).flatMap(([, r]) => r);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    for (const binding of KB_ALWAYS_BINDINGS) {
      const row = rows.find(([keys]) => keys.some((k) => norm(k) === norm(binding.key)));
      expect(row, `a help row for the always-on chord ${binding.key}`).toBeDefined();
      expect(
        row?.[1].toLowerCase(),
        `the ${binding.key} row must say it survives the Settings toggle`,
      ).toContain("always on");
    }
  });
});

describe("matchesAppChord — gating", () => {
  it("matches an enabled default chord in context (Ctrl+Shift+K -> palette.toggle)", () => {
    const b = matchesAppChord(ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" }), input());
    expect(b?.command).toBe("palette.toggle");
  });

  it("returns null for a default chord when the layer is disabled", () => {
    const b = matchesAppChord(
      ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" }),
      input({ enabled: false }),
    );
    expect(b).toBeNull();
  });

  it("still fires an ALWAYS-on chord when the layer is disabled (Alt+Shift+Backspace)", () => {
    const b = matchesAppChord(
      ev({ altKey: true, shiftKey: true, key: "Backspace", code: "Backspace" }),
      input({ enabled: false }),
    );
    expect(b?.command).toBe("session.kill.current");
  });

  it("gates a chord out when its when-clause is false (dev-flow chord needs lobbyOpen)", () => {
    const notLobby = { ...ctx(), lobbyOpen: false, terminalFocus: true };
    const b = matchesAppChord(
      ev({ altKey: true, shiftKey: true, key: "N", code: "KeyN" }),
      input({ ctx: notLobby }),
    );
    expect(b).toBeNull();
  });

  it("gates ALL chords out while the gallery is open", () => {
    const galleryCtx = ctx({ galleryOpen: true });
    const attach = matchesAppChord(
      ev({ altKey: true, key: "1", code: "Digit1" }),
      input({ ctx: galleryCtx }),
    );
    expect(attach).toBeNull();
    // even the always-on kill honors its !overlayOpen when-clause
    const kill = matchesAppChord(
      ev({ altKey: true, shiftKey: true, key: "Backspace", code: "Backspace" }),
      input({ ctx: galleryCtx, enabled: false }),
    );
    expect(kill).toBeNull();
  });

  /**
   * QA #2/#3/#9/#11: the gallery was not the only overlay that owns the
   * keyboard, but it was the only one the table knew about. With the Settings
   * modal up — aria-modal, Tab trapped, focus inside it — Alt+Shift+N still
   * focused the new-session box BEHIND the dialog and Ctrl+Shift+K still opened
   * the palette OVER it. One flag now covers every overlay, and every lobby
   * chord reads it.
   */
  describe("an overlay that owns the keyboard suppresses the lobby chords", () => {
    const lobbyChords: [string, ChordEventLike][] = [
      ["session.attach.1", ev({ altKey: true, key: "1", code: "Digit1" })],
      ["session.next", ev({ altKey: true, shiftKey: true, key: "}", code: "BracketRight" })],
      ["session.new", ev({ altKey: true, shiftKey: true, key: "N", code: "KeyN" })],
      ["sidebar.toggle", ev({ altKey: true, shiftKey: true, key: "S", code: "KeyS" })],
      ["session.rename.current", ev({ altKey: true, shiftKey: true, key: "R", code: "KeyR" })],
      ["shortcuts.help", ev({ altKey: true, key: "/", code: "Slash" })],
    ];

    for (const overlay of ["settingsOpen", "helpOpen", "galleryOpen"] as const) {
      for (const [command, e] of lobbyChords) {
        // ...except the chord that toggles THIS overlay: see the self-toggle
        // tests below.
        if (overlay === "helpOpen" && command === "shortcuts.help") continue;
        it(`fires ${command} normally, and is inert while ${overlay}`, () => {
          expect(matchesAppChord(e, input())?.command).toBe(command);
          expect(matchesAppChord(e, input({ ctx: ctx({ [overlay]: true }) }))).toBeNull();
        });
      }
    }

    it("keeps the always-on kill chord out of an open overlay too", () => {
      const kill = ev({ altKey: true, shiftKey: true, key: "Backspace", code: "Backspace" });
      expect(matchesAppChord(kill, input({ enabled: false }))?.command).toBe(
        "session.kill.current",
      );
      expect(
        matchesAppChord(kill, input({ ctx: ctx({ settingsOpen: true }), enabled: false })),
      ).toBeNull();
    });

    it("refuses to open the palette OVER a modal", () => {
      const k = ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" });
      expect(matchesAppChord(k, input({ ctx: ctx({ settingsOpen: true }) }))).toBeNull();
    });

    // The overlay-scoped exemption: a chord that TOGGLES an overlay has to
    // survive that overlay being the open one, or it stops being a toggle and
    // Escape is the only way out. It stays refused over every other overlay.
    it("still lets Ctrl+Shift+K close the palette IT opened", () => {
      const k = ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" });
      expect(matchesAppChord(k, input({ ctx: ctx({ paletteOpen: true }) }))?.command).toBe(
        "palette.toggle",
      );
    });

    it("still lets Alt+/ close the shortcuts help IT opened", () => {
      // ...and this one matters on a Mac: the dialog's own "/" exit reads
      // `e.key`, which Option+/ renders as "÷" — the chord is the way out.
      const slash = ev({ altKey: true, key: "÷", code: "Slash" });
      expect(matchesAppChord(slash, input({ ctx: ctx({ helpOpen: true }) }))?.command).toBe(
        "shortcuts.help",
      );
      expect(matchesAppChord(slash, input({ ctx: ctx({ settingsOpen: true }) }))).toBeNull();
    });

    it("leaves the file preview's finer-grained guard alone", () => {
      // The preview overlay is deliberately NOT keyboard-owning: the palette has
      // to be reachable over it (that is where the "unsaved changes" refusal
      // lives), and only the SWITCH chords — the ones that unmount the draft —
      // are gated, on !previewDirty.
      const k = ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" });
      const previewCtx = ctx({ previewOpen: true, previewDirty: true });
      expect(previewCtx.overlayOpen).toBe(false);
      expect(matchesAppChord(k, input({ ctx: previewCtx }))?.command).toBe("palette.toggle");
    });
  });

  // A session switch tears the whole SessionView down, taking the per-session
  // file-preview store — and any unsaved editor draft — with it. The MOUSE path
  // is guarded: clicking another session hits the preview backdrop, which runs
  // the "Discard unsaved changes?" confirm. The keyboard path had no such gate,
  // so Alt+Shift+] threw the draft away without a word.
  describe("a dirty file-preview draft blocks the session-switch chords", () => {
    const dirtyCtx = { ...LOBBY_CTX, previewOpen: true, previewDirty: true };
    const cleanCtx = { ...LOBBY_CTX, previewOpen: true, previewDirty: false };

    const switchChords: [string, ChordEventLike][] = [
      ["session.next", ev({ altKey: true, shiftKey: true, key: "}", code: "BracketRight" })],
      ["session.prev", ev({ altKey: true, shiftKey: true, key: "{", code: "BracketLeft" })],
      ["session.attach.2", ev({ altKey: true, key: "2", code: "Digit2" })],
      [
        "session.next.awaiting",
        ev({ altKey: true, shiftKey: true, key: "Enter", code: "Enter" }),
      ],
    ];

    for (const [command, e] of switchChords) {
      it(`gates ${command} out while the draft is dirty`, () => {
        expect(matchesAppChord(e, input({ ctx: cleanCtx }))?.command).toBe(command);
        expect(matchesAppChord(e, input({ ctx: dirtyCtx }))).toBeNull();
      });
    }

    it("leaves the non-switching chords alone (they do not unmount the draft)", () => {
      expect(
        matchesAppChord(
          ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" }),
          input({ ctx: dirtyCtx }),
        )?.command,
      ).toBe("palette.toggle");
      expect(
        matchesAppChord(
          ev({ altKey: true, shiftKey: true, key: "S", code: "KeyS" }),
          input({ ctx: dirtyCtx }),
        )?.command,
      ).toBe("sidebar.toggle");
    });

    it("every session-switch binding carries the guard", () => {
      const switching = KB_DEFAULT_BINDINGS.filter(
        (b) => /^session\.(attach\.\d+|prev|next)$/.test(b.command) || b.command === "session.next.awaiting",
      );
      expect(switching.length).toBe(13); // 10 attach slots + prev + next + next.awaiting
      for (const b of switching) {
        expect(b.when, `${b.command} must be gated on !previewDirty`).toContain("!previewDirty");
      }
    });
  });

  it("ignores non-keydown events", () => {
    const b = matchesAppChord(
      ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK", type: "keyup" }),
      input(),
    );
    expect(b).toBeNull();
  });

  it("maps Alt+0 to session.attach.10 and Alt+9 to session.attach.9", () => {
    expect(
      matchesAppChord(ev({ altKey: true, key: "0", code: "Digit0" }), input())?.command,
    ).toBe("session.attach.10");
    expect(
      matchesAppChord(ev({ altKey: true, key: "9", code: "Digit9" }), input())?.command,
    ).toBe("session.attach.9");
  });
});

describe("keyContext — one reading of who owns the keyboard", () => {
  it("says nobody owns it while every overlay is closed", () => {
    expect(ctx().overlayOpen).toBe(false);
    expect(ctx().lobbyOpen).toBe(true);
  });

  it.each(["paletteOpen", "helpOpen", "settingsOpen", "galleryOpen"] as const)(
    "reports overlayOpen while %s",
    (flag) => {
      expect(ctx({ [flag]: true }).overlayOpen).toBe(true);
    },
  );

  it("does not count the file preview — it keeps its own !previewDirty guard", () => {
    expect(ctx({ previewOpen: true, previewDirty: true }).overlayOpen).toBe(false);
    expect(ctx({ previewOpen: true, previewDirty: true }).previewDirty).toBe(true);
  });

  it("keeps the palette identifiable, so its own toggle can still close it", () => {
    expect(ctx({ paletteOpen: true }).paletteOpen).toBe(true);
    expect(ctx({ galleryOpen: true }).paletteOpen).toBe(false);
  });
});

/**
 * QA #3: a chord pressed INSIDE the terminal iframe never reaches this window —
 * frontend/term.html matches it against ITS OWN copy of the table, evaluated
 * against the TERMINAL page's context (which knows nothing about the lobby's
 * overlays), and forwards the command NAME up over `tl-command`. The lobby then
 * ran it directly, so every when-clause was simply skipped on that path: with
 * the gallery open and focus in the terminal, Alt+Shift+] switched session and
 * took the gallery with it. Re-checking the clause by command name closes it.
 */
describe("commandAllowed — the guard for a command forwarded up from the iframe", () => {
  it("allows a session switch while nothing owns the keyboard", () => {
    expect(commandAllowed("session.next", ctx())).toBe(true);
  });

  it("refuses one while the gallery is open (the QA repro)", () => {
    expect(commandAllowed("session.next", ctx({ galleryOpen: true }))).toBe(false);
    expect(commandAllowed("session.attach.3", ctx({ galleryOpen: true }))).toBe(false);
  });

  it("refuses one over an unsaved editor draft, like the chord path", () => {
    expect(commandAllowed("session.next", ctx({ previewOpen: true, previewDirty: true }))).toBe(
      false,
    );
  });

  it("refuses the always-on kill forwarded into an open overlay", () => {
    expect(commandAllowed("session.kill.current", ctx())).toBe(true);
    expect(commandAllowed("session.kill.current", ctx({ settingsOpen: true }))).toBe(false);
  });

  it("refuses the forwarded view.toggle while an overlay owns the keyboard", () => {
    // Ctrl/Cmd+J has no row in the v2 table (SessionView owns the lobby half),
    // so its clause lives with the other forwarded-only commands.
    expect(commandAllowed("view.toggle", ctx())).toBe(true);
    expect(commandAllowed("view.toggle", ctx({ paletteOpen: true }))).toBe(false);
  });

  it("leaves a command with no when-clause alone", () => {
    // terminal.paste is routed straight back DOWN to the iframe that sent it.
    expect(commandAllowed("terminal.paste", ctx({ galleryOpen: true }))).toBe(true);
    expect(commandAllowed("nonsense.command", ctx({ settingsOpen: true }))).toBe(true);
  });
});

describe("altLabel", () => {
  it("is Option on Mac, Alt elsewhere", () => {
    expect(altLabel(true)).toBe("Option");
    expect(altLabel(false)).toBe("Alt");
  });
});
