import { describe, it, expect } from "vitest";
import {
  altLabel,
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
    galleryOpen: false,
    previewOpen: false,
    previewDirty: false,
    editing: false,
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

/**
 * Every chord the table binds is enumerated in the help.
 *
 * The bug this pins: the overlay says it lists the shortcuts, and it omitted
 * Alt+Shift+U and Alt+Shift+F. Alt+Shift+F is the ONLY keyboard entry to Find
 * in session, so the one chord nobody could guess was the one not written down.
 *
 * Asserted in one direction on purpose. Five help rows correspond to no binding
 * at all — Alt (hold), Mod+J, "/", "?" and Esc are painted by separate window
 * listeners or by the browser — so a both-ways check would fail on those five
 * every run and teach nothing about an undocumented chord.
 */
describe("the help overlay enumerates every bound chord", () => {
  /**
   * ...with one alias folded in. The table spells the Meta key `meta+`, because
   * that is what `parseChord` calls it (it folds meta/cmd/super into one flag,
   * chords.logic.ts), while the help spells it the way the keyboard in front of
   * the reader does: Cmd on a Mac, Ctrl everywhere else. Folding cmd back to
   * meta is what lets `meta+z` find its `Cmd+Z` row instead of reading as an
   * undocumented chord.
   */
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/(^|\+)cmd\+/g, "$1meta+");

  // The help paints "Alt+1 – Alt+9" as one row rather than nine, so a range
  // stands for each chord between its ends.
  const expand = (key: string): string[] => {
    const m = /^(.+?)(\d)[–-](.+?)(\d)$/.exec(norm(key));
    if (!m) return [norm(key)];
    const [, lowPrefix, low, highPrefix, high] = m;
    if (!lowPrefix || !low || !highPrefix || !high || lowPrefix !== highPrefix) return [norm(key)];
    const [from, to] = [Number(low), Number(high)];
    return Array.from({ length: to - from + 1 }, (_, i) => `${lowPrefix}${from + i}`);
  };

  // Both platform renderings, because a row that names the Meta key writes one
  // label per platform and the table has a row for each: `ctrl+z` is documented
  // by the PC pass and `meta+z` by the Mac one, and neither pass alone can say
  // both are written down.
  const documented = new Set(
    [buildShortcutGroups(altLabel(false), false), buildShortcutGroups(altLabel(true), true)]
      .flat()
      .flatMap(([, rows]) => rows)
      .flatMap(([keys]) => keys.flatMap(expand)),
  );

  it.each(
    [...KB_DEFAULT_BINDINGS, ...KB_ALWAYS_BINDINGS].map((b) => [b.key, b.command] as const),
  )("%s (%s) has a help row", (key) => {
    expect(documented.has(norm(key))).toBe(true);
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

/**
 * Cmd+Z / Ctrl+Z and their Shift halves, and the two clauses they carry.
 *
 * These four rows claim the chord GLOBALLY, the terminal included, so Ctrl+Z
 * deliberately stops reaching the pty as SIGTSTP (test/undo.keys.test.ts walks
 * that chain). That cost is signed off, and the way back is the ⚙ "App
 * shortcuts" switch — which only works because the rows sit in
 * KB_DEFAULT_BINDINGS rather than in the always-on table. The last two cases
 * here are what pin that placement.
 */
describe("the undo chords", () => {
  const chords: [string, string, ChordEventLike][] = [
    ["ctrl+z", "edit.undo", ev({ ctrlKey: true, key: "z", code: "KeyZ" })],
    ["meta+z", "edit.undo", ev({ metaKey: true, key: "z", code: "KeyZ" })],
    ["ctrl+shift+z", "edit.redo", ev({ ctrlKey: true, shiftKey: true, key: "Z", code: "KeyZ" })],
    ["meta+shift+z", "edit.redo", ev({ metaKey: true, shiftKey: true, key: "Z", code: "KeyZ" })],
  ];

  it.each(chords)("%s runs %s", (_key, command, e) => {
    expect(matchesAppChord(e, input())?.command).toBe(command);
  });

  /**
   * The exemption the whole `editing` flag exists for. The engine's listener is
   * capture-phase on `window` (engine.ts init) and CodeMirror's own Mod-z is a
   * bubble-phase handler on its contentDOM, so capture runs FIRST and a match
   * here steals the editor's undo before it is ever asked. Nothing downstream
   * can hand it back, which is why the refusal has to happen at the table.
   */
  it.each(chords)("%s belongs to the focused field, not the lobby", (_key, _command, e) => {
    expect(matchesAppChord(e, input({ ctx: ctx({ editing: true }) }))).toBeNull();
  });

  it.each(chords)("%s is inert behind an overlay", (_key, _command, e) => {
    expect(matchesAppChord(e, input({ ctx: ctx({ settingsOpen: true }) }))).toBeNull();
  });

  it.each(chords)("%s goes off with the App shortcuts switch", (_key, _command, e) => {
    expect(matchesAppChord(e, input({ enabled: false }))).toBeNull();
  });

  it("keeps both commands out of the always-on table", () => {
    // An always-on row would take Ctrl+Z off the pty with no way back, since
    // KB_ALWAYS_BINDINGS bypasses the `enabled` gate by design.
    for (const b of KB_ALWAYS_BINDINGS) {
      expect(b.command).not.toBe("edit.undo");
      expect(b.command).not.toBe("edit.redo");
    }
  });

  it("makes both commands rebindable, like every other default row", () => {
    expect(KB_COMMANDS.has("edit.undo")).toBe(true);
    expect(KB_COMMANDS.has("edit.redo")).toBe(true);
  });

  it("carries both halves of the when-clause on all four rows", () => {
    const rows = KB_DEFAULT_BINDINGS.filter((b) => b.command.startsWith("edit."));
    expect(rows.length).toBe(4);
    for (const b of rows) {
      expect(b.when, `${b.key} must yield to a focused field`).toContain("!editing");
      expect(b.when, `${b.key} must not act behind a dialog`).toContain("!overlayOpen");
    }
  });

  it("never confuses undo with redo — Shift is part of the chord", () => {
    // `eventMatchesChord` compares all four modifiers exactly, so there is no
    // path where a plain Ctrl+Z reaches redo or a Ctrl+Shift+Z reaches undo.
    const plain = ev({ ctrlKey: true, key: "z", code: "KeyZ" });
    const shifted = ev({ ctrlKey: true, shiftKey: true, key: "Z", code: "KeyZ" });
    expect(matchesAppChord(plain, input())?.command).toBe("edit.undo");
    expect(matchesAppChord(shifted, input())?.command).toBe("edit.redo");
    // ...and Ctrl+Alt+Z (AltGr on a few layouts) is neither.
    expect(
      matchesAppChord(ev({ ctrlKey: true, altKey: true, key: "z", code: "KeyZ" }), input()),
    ).toBeNull();
  });

  it("leaves every OTHER chord alone while a field has focus", () => {
    // `editing` is not a second `overlayOpen`: it gates the four rows that a
    // text field has its own meaning for, and nothing else. Typing a session
    // name must not cost you Alt+Shift+S.
    const editingCtx = ctx({ editing: true });
    expect(
      matchesAppChord(ev({ altKey: true, shiftKey: true, key: "S", code: "KeyS" }), input({ ctx: editingCtx }))
        ?.command,
    ).toBe("sidebar.toggle");
    expect(
      matchesAppChord(ev({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" }), input({ ctx: editingCtx }))
        ?.command,
    ).toBe("palette.toggle");
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

  it("carries `editing` through, and does not count a field as an overlay", () => {
    // A focused field owns Cmd+Z and nothing else. Reading it as an overlay
    // would suppress every lobby chord for as long as the new-session name box
    // has the caret in it.
    expect(ctx().editing).toBe(false);
    expect(ctx({ editing: true }).editing).toBe(true);
    expect(ctx({ editing: true }).overlayOpen).toBe(false);
  });
});

/**
 * QA #3: a chord pressed INSIDE the terminal iframe never reached this window —
 * frontend/term.html matched it against ITS OWN copy of the table, evaluated
 * against the TERMINAL page's context (which knew nothing about the lobby's
 * overlays), and forwarded the command NAME up over `tl-command`. The lobby then
 * ran it directly, so every when-clause was simply skipped on that path: with
 * the gallery open and focus in the terminal, Alt+Shift+] switched session and
 * took the gallery with it. Re-checking the clause by command name closes it.
 */
describe("altLabel", () => {
  it("is Option on Mac, Alt elsewhere", () => {
    expect(altLabel(true)).toBe("Option");
    expect(altLabel(false)).toBe("Alt");
  });
});
