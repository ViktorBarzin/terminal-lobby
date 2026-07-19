import { describe, it, expect } from "vitest";
import {
  altLabel,
  KB_COMMANDS,
  KB_DEFAULT_BINDINGS,
  matchesAppChord,
  normalizeKeybindings,
  resolveAlways,
  resolveBindings,
  type MatchInput,
} from "../src/keybindings/bindings.logic";
import type { ChordEventLike } from "../src/keybindings/chords.logic";

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
