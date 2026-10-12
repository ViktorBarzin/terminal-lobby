import { describe, expect, it } from "vitest";

// The embed patch's pure half (patches/embed.patch adds it to the pinned
// apps/web), checked against the contract in EMBED.md. link-t3.sh points
// @t3tools/web at the patched checkout, so this fails to import when the
// patch did not apply.
import {
  embedFlag,
  embedHost,
  type FrameChord,
  isTextEntry,
  type KeyLike,
  keyMessage,
  parentOrigin,
  parseLobbyMessage,
  readyMessage,
  routeFrameKey,
  threadFromLookup,
  threadLookupPath,
  withPlanModeDefault,
} from "@t3tools/web/src/embed.logic.ts";

const T3 = { hostname: "t3view.viktorbarzin.me" };
const LOCAL = { hostname: "127.0.0.1" };
const LOBBY = "https://terminal.viktorbarzin.me";

describe("parentOrigin", () => {
  it("prefers the browser's ancestor origins", () => {
    expect(parentOrigin([LOBBY], "https://elsewhere.example/page")).toBe(LOBBY);
  });

  it("falls back to the referrer's origin where there are no ancestor origins", () => {
    expect(parentOrigin(undefined, `${LOBBY}/s/abc?x=1`)).toBe(LOBBY);
    expect(parentOrigin([], `${LOBBY}/`)).toBe(LOBBY);
  });

  it("knows no parent from an opaque or missing answer", () => {
    expect(parentOrigin(["null"], "")).toBeNull();
    expect(parentOrigin(undefined, "")).toBeNull();
    expect(parentOrigin(undefined, "not a url")).toBeNull();
  });
});

describe("embedHost", () => {
  it("accepts the lobby on the frame's own domain", () => {
    expect(embedHost(true, LOBBY, T3)).toBe(LOBBY);
    expect(embedHost(true, "https://terminal-dev.viktorbarzin.me", T3)).toBe(
      "https://terminal-dev.viktorbarzin.me",
    );
    expect(embedHost(true, "https://viktorbarzin.me", T3)).toBe("https://viktorbarzin.me");
  });

  it("runs as upstream when unframed or without the flag", () => {
    expect(embedHost(true, null, T3)).toBeNull();
    expect(embedHost(false, LOBBY, T3)).toBeNull();
  });

  it.each([
    ["another domain", "https://evil.example"],
    ["a look-alike suffix", "https://terminal.notviktorbarzin.me"],
    ["plain http off loopback", "http://terminal.viktorbarzin.me"],
    ["an opaque origin", "null"],
    ["not a URL", "terminal.viktorbarzin.me"],
  ])("refuses %s", (_name, parent) => {
    expect(embedHost(true, parent, T3)).toBeNull();
  });

  it("refuses to treat a bare top-level domain as the frame's domain", () => {
    expect(embedHost(true, "https://anything.me", { hostname: "viktorbarzin.me" })).toBeNull();
  });

  it("allows http on loopback only when the frame is on loopback too", () => {
    expect(embedHost(true, "http://127.0.0.1:17792", LOCAL)).toBe("http://127.0.0.1:17792");
    expect(embedHost(true, "http://localhost:5173", { hostname: "localhost" })).toBe(
      "http://localhost:5173",
    );
    expect(embedHost(true, "http://127.0.0.1:17792", T3)).toBeNull();
    expect(embedHost(true, "http://192.168.1.5", LOCAL)).toBeNull();
  });
});

describe("embedFlag", () => {
  it("reads the bare flag from the URL", () => {
    expect(embedFlag("?embed", false)).toBe(true);
    expect(embedFlag("?embed=&x=1", false)).toBe(true);
    expect(embedFlag("?x=1", false)).toBe(false);
  });

  it("remembers the flag once T3's own navigation has dropped the query", () => {
    expect(embedFlag("", true)).toBe(true);
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

describe("withPlanModeDefault", () => {
  it("turns plan mode on in the client's settings when the person never chose", () => {
    expect(JSON.parse(withPlanModeDefault(null) ?? "")).toEqual({ planModeEnabled: true });
    expect(JSON.parse(withPlanModeDefault('{"sendShortcut":"enter"}') ?? "")).toEqual({
      sendShortcut: "enter",
      planModeEnabled: true,
    });
  });

  it("leaves a choice the person made, and settings it cannot read", () => {
    expect(withPlanModeDefault('{"planModeEnabled":false}')).toBeNull();
    expect(withPlanModeDefault('{"planModeEnabled":true}')).toBeNull();
    expect(withPlanModeDefault("not json")).toBeNull();
    expect(withPlanModeDefault("[1]")).toBeNull();
  });
});

describe("thread lookup", () => {
  it("asks the sidecar for the thread a lobby key names", () => {
    expect(threadLookupPath("bw8k5gt9v314")).toBe("/.well-known/t3/thread/bw8k5gt9v314");
    expect(threadLookupPath("a/b c")).toBe("/.well-known/t3/thread/a%2Fb%20c");
  });

  it("reads the thread id from the answer, and nothing from anything else", () => {
    expect(threadFromLookup({ threadId: "5992c13c" })).toBe("5992c13c");
    expect(threadFromLookup({ threadId: "" })).toBeNull();
    expect(threadFromLookup({ threadId: 7 })).toBeNull();
    expect(threadFromLookup(null)).toBeNull();
    expect(threadFromLookup("5992c13c")).toBeNull();
  });
});
