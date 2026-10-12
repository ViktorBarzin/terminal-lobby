import { describe, expect, it } from "vitest";

// The embed patch's pure half (patches/embed.patch adds it to the pinned
// apps/web), checked against the contract in EMBED.md. link-t3.sh points
// @t3tools/web at the patched checkout, so this fails to import when the
// patch did not apply.
import {
  embedHost,
  type FrameChord,
  isTextEntry,
  type KeyLike,
  keyMessage,
  parseLobbyMessage,
  readyMessage,
  routeFrameKey,
} from "@t3tools/web/src/embed.logic.ts";

const T3 = { hostname: "t3view.viktorbarzin.me" };
const LOCAL = { hostname: "127.0.0.1" };
const q = (host: string) => `?embed&host=${encodeURIComponent(host)}`;

describe("embedHost", () => {
  it("accepts the lobby on the frame's own domain", () => {
    expect(embedHost(q("https://terminal.viktorbarzin.me"), T3, true)).toBe(
      "https://terminal.viktorbarzin.me",
    );
    expect(embedHost(q("https://terminal-dev.viktorbarzin.me/"), T3, true)).toBe(
      "https://terminal-dev.viktorbarzin.me",
    );
    expect(embedHost(q("https://viktorbarzin.me"), T3, true)).toBe("https://viktorbarzin.me");
  });

  it("runs as upstream when unframed or without the flag", () => {
    expect(embedHost(q("https://terminal.viktorbarzin.me"), T3, false)).toBeNull();
    expect(
      embedHost(`?host=${encodeURIComponent("https://terminal.viktorbarzin.me")}`, T3, true),
    ).toBeNull();
    expect(embedHost("?embed", T3, true)).toBeNull();
  });

  it.each([
    ["another domain", "https://evil.example"],
    ["a look-alike suffix", "https://terminal.notviktorbarzin.me"],
    ["plain http off loopback", "http://terminal.viktorbarzin.me"],
    ["a path", "https://terminal.viktorbarzin.me/x"],
    ["a query", "https://terminal.viktorbarzin.me/?a=1"],
    ["credentials", "https://u:p@terminal.viktorbarzin.me"],
    ["not a URL", "terminal.viktorbarzin.me"],
  ])("refuses %s", (_name, host) => {
    expect(embedHost(q(host), T3, true)).toBeNull();
  });

  it("refuses to treat a bare top-level domain as the frame's domain", () => {
    expect(embedHost(q("https://anything.me"), { hostname: "viktorbarzin.me" }, true)).toBeNull();
  });

  it("allows http on loopback only when the frame is on loopback too", () => {
    expect(embedHost(q("http://127.0.0.1:17792"), LOCAL, true)).toBe("http://127.0.0.1:17792");
    expect(embedHost(q("http://localhost:5173"), { hostname: "localhost" }, true)).toBe(
      "http://localhost:5173",
    );
    expect(embedHost(q("http://127.0.0.1:17792"), T3, true)).toBeNull();
    expect(embedHost(q("http://192.168.1.5"), LOCAL, true)).toBeNull();
  });
});

function key(spec: string, overrides: Partial<KeyLike> = {}): KeyLike {
  const parts = spec.split("+");
  const name = parts.pop() ?? "";
  const mods = new Set(parts);
  const code = /^[a-z]$/.test(name)
    ? `Key${name.toUpperCase()}`
    : /^[0-9]$/.test(name)
      ? `Digit${name}`
      : ({ "[": "BracketLeft", "/": "Slash", escape: "Escape", enter: "Enter" }[name] ?? name);
  const keyName = { escape: "Escape", enter: "Enter" }[name] ?? name;
  return {
    key: mods.has("shift") && /^[a-z]$/.test(keyName) ? keyName.toUpperCase() : keyName,
    code,
    ctrlKey: mods.has("ctrl"),
    altKey: mods.has("alt"),
    shiftKey: mods.has("shift"),
    metaKey: mods.has("meta"),
    repeat: false,
    ...overrides,
  };
}

const chord = (c: Partial<FrameChord> & { key: string }): FrameChord => ({
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...c,
});

// A slice of what the lobby sends today (EMBED.md "Today's list").
const CHORDS: FrameChord[] = [
  chord({ ctrl: true, shift: true, key: "k", code: "KeyK" }),
  chord({ alt: true, key: "1", code: "Digit1" }),
  chord({ alt: true, shift: true, key: "[", code: "BracketLeft" }),
  chord({ alt: true, shift: true, key: "n", code: "KeyN" }),
  chord({ ctrl: true, key: "z", code: "KeyZ", notWhileEditing: true }),
  chord({ ctrl: true, key: "j" }),
  chord({ key: "escape", passive: true }),
];

describe("routeFrameKey", () => {
  it("forwards nothing before the first tl-bindings", () => {
    expect(routeFrameKey(key("alt+1"), null, false)).toBe("ignore");
  });

  it.each(["ctrl+shift+k", "alt+1", "alt+shift+[", "alt+shift+n", "ctrl+j"])(
    "claims %s, in a text field or not",
    (spec) => {
      expect(routeFrameKey(key(spec), CHORDS, false)).toBe("claim");
      expect(routeFrameKey(key(spec), CHORDS, true)).toBe("claim");
    },
  );

  it("leaves a notWhileEditing chord to a focused text field", () => {
    expect(routeFrameKey(key("ctrl+z"), CHORDS, false)).toBe("claim");
    expect(routeFrameKey(key("ctrl+z"), CHORDS, true)).toBe("ignore");
  });

  it("marks a passive chord passive, and reads esc as escape", () => {
    expect(routeFrameKey(key("escape"), CHORDS, false)).toBe("passive");
    expect(routeFrameKey(key("escape", { key: "Esc" }), CHORDS, false)).toBe("passive");
  });

  it("matches on code where a modifier changes key", () => {
    // macOS Option+1 is "¡", AZERTY Alt+1 is "&".
    expect(routeFrameKey(key("alt+1", { key: "¡" }), CHORDS, false)).toBe("claim");
    expect(routeFrameKey(key("alt+1", { key: "&" }), CHORDS, false)).toBe("claim");
    // A chord without a code matches on key alone.
    expect(routeFrameKey(key("ctrl+j", { code: "KeyX" }), CHORDS, false)).toBe("claim");
  });

  it("needs all four modifiers to agree", () => {
    for (const spec of [
      "a",
      "1",
      "shift+a",
      "alt+2",
      "ctrl+k",
      "meta+j",
      "ctrl+shift+j",
      "alt+shift+x",
    ]) {
      expect(routeFrameKey(key(spec), CHORDS, false)).toBe("ignore");
    }
  });

  it("follows whatever the latest bindings say", () => {
    const overridden = [chord({ ctrl: true, alt: true, key: "p", code: "KeyP" })];
    expect(routeFrameKey(key("ctrl+alt+p"), overridden, false)).toBe("claim");
    expect(routeFrameKey(key("alt+1"), overridden, false)).toBe("ignore");
  });
});

describe("isTextEntry", () => {
  it.each([
    [{ tagName: "TEXTAREA" }, true],
    [{ tagName: "SELECT" }, true],
    [{ tagName: "INPUT", type: "text" }, true],
    [{ tagName: "INPUT", type: "search" }, true],
    [{ tagName: "INPUT" }, true],
    [{ tagName: "INPUT", type: "checkbox" }, false],
    [{ tagName: "INPUT", type: "radio" }, false],
    [{ tagName: "INPUT", type: "button" }, false],
    [{ tagName: "DIV", isContentEditable: true }, true],
    [{ tagName: "DIV", isContentEditable: false }, false],
    [{ tagName: "BUTTON" }, false],
  ])("%j is %s", (element, want) => {
    expect(isTextEntry(element)).toBe(want);
  });
  it("is false with nothing focused", () => {
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("messages to the lobby", () => {
  it("tl-key copies the KeyboardEvent fields and nothing else", () => {
    const event = { ...key("alt+shift+n"), isTrusted: true, target: null };
    expect(keyMessage(event)).toEqual({
      type: "tl-key",
      v: 1,
      key: "N",
      code: "KeyN",
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      repeat: false,
    });
  });
  it("tl-ready names the environment and the thread", () => {
    expect(readyMessage("env-1", null)).toEqual({
      type: "tl-ready",
      v: 1,
      environmentId: "env-1",
      threadId: null,
    });
  });
});

describe("parseLobbyMessage", () => {
  it("reads tl-bindings", () => {
    expect(parseLobbyMessage({ type: "tl-bindings", v: 1, chords: CHORDS })).toEqual({
      type: "tl-bindings",
      v: 1,
      chords: CHORDS,
    });
  });
  it("reads tl-open", () => {
    expect(parseLobbyMessage({ type: "tl-open", v: 1, threadId: "t-1" })).toEqual({
      type: "tl-open",
      v: 1,
      threadId: "t-1",
    });
  });
  it.each([
    ["another version", { type: "tl-open", v: 2, threadId: "t" }],
    ["an unknown type", { type: "tl-run", v: 1, command: "x" }],
    ["an empty thread", { type: "tl-open", v: 1, threadId: "" }],
    ["chords that are not a list", { type: "tl-bindings", v: 1, chords: {} }],
    [
      "a chord missing a modifier",
      { type: "tl-bindings", v: 1, chords: [{ ctrl: true, key: "k" }] },
    ],
    [
      "a chord with a non-true flag",
      { type: "tl-bindings", v: 1, chords: [{ ...CHORDS[0], passive: false }] },
    ],
    ["a long key", { type: "tl-bindings", v: 1, chords: [{ ...CHORDS[0], key: "k".repeat(33) }] }],
    ["not an object", "tl-open"],
    ["null", null],
  ])("drops %s", (_name, data) => {
    expect(parseLobbyMessage(data)).toBeNull();
  });
});
