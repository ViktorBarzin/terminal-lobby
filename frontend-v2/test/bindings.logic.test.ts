import { describe, it, expect } from "vitest";
import {
  altLabel,
  KB_ALWAYS_BINDINGS,
  KB_COMMANDS,
  KB_DEFAULT_BINDINGS,
  matchesAppChord,
  normalizeKeybindings,
  resolveAlways,
  resolveBindings,
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

const LOBBY_CTX = { terminalFocus: false, lobbyOpen: true, galleryOpen: false };

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
    const notLobby = { terminalFocus: true, lobbyOpen: false, galleryOpen: false };
    const b = matchesAppChord(
      ev({ altKey: true, shiftKey: true, key: "N", code: "KeyN" }),
      input({ ctx: notLobby }),
    );
    expect(b).toBeNull();
  });

  it("gates ALL chords out while the gallery is open", () => {
    const galleryCtx = { terminalFocus: true, lobbyOpen: true, galleryOpen: true };
    const attach = matchesAppChord(
      ev({ altKey: true, key: "1", code: "Digit1" }),
      input({ ctx: galleryCtx }),
    );
    expect(attach).toBeNull();
    // even the always-on kill honors its !galleryOpen when-clause
    const kill = matchesAppChord(
      ev({ altKey: true, shiftKey: true, key: "Backspace", code: "Backspace" }),
      input({ ctx: galleryCtx, enabled: false }),
    );
    expect(kill).toBeNull();
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

describe("altLabel", () => {
  it("is Option on Mac, Alt elsewhere", () => {
    expect(altLabel(true)).toBe("Option");
    expect(altLabel(false)).toBe("Alt");
  });
});
