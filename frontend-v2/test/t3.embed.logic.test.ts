import { describe, it, expect, beforeEach } from "vitest";
import {
  allowedT3Origin,
  defaultT3Origin,
  followTarget,
  frameChords,
  keyInChords,
  loadEnvironmentId,
  parseFrameMessage,
  replayInit,
  saveEnvironmentId,
  t3FrameAllow,
  t3FrameUrl,
  t3Offered,
  t3ThreadId,
  t3ViewOrigin,
} from "../src/t3/embed.logic";
import { parseChord } from "../src/keybindings/chords.logic";
import type { ResolvedBinding } from "../src/keybindings/bindings.logic";

describe("where the T3 view is served", () => {
  // One host for the frame and for T3's own apps (ADR-0045 decision 6), so
  // Settings → T3 apps builds its pairing links from the same origin.
  it("defaults to t3 beside the lobby's own host", () => {
    expect(defaultT3Origin("terminal.viktorbarzin.me")).toBe("https://t3.viktorbarzin.me");
    expect(defaultT3Origin("terminal-dev.viktorbarzin.me")).toBe("https://t3.viktorbarzin.me");
    expect(defaultT3Origin("Terminal.Example.COM")).toBe("https://t3.example.com");
    expect(defaultT3Origin("example.com")).toBe("https://t3.example.com");
  });

  it("has no default on a loopback or bare host, where there is no sibling to name", () => {
    for (const h of ["127.0.0.1", "localhost", "[::1]", "10.0.10.10", "devvm", ""]) {
      expect(defaultT3Origin(h), h).toBeNull();
    }
  });

  it("accepts an override on loopback only, the local check against a dev sidecar", () => {
    expect(allowedT3Origin("http://127.0.0.1:17691")).toBe("http://127.0.0.1:17691");
    expect(allowedT3Origin("http://127.0.0.1:17691/")).toBe("http://127.0.0.1:17691");
    expect(allowedT3Origin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  // The override decides which page the lobby frames AND which page's key
  // messages it replays as lobby commands. A crafted link carrying
  // ?t3view=https://evil.example would otherwise hand that page Alt+Shift+W.
  it("refuses an override anywhere else", () => {
    for (const o of [
      "https://pages.viktorbarzin.me",
      "https://t3-dev.viktorbarzin.me",
      "https://t3.viktorbarzin.me",
      "https://viktorbarzin.me",
      "https://localhost:17691",
      "https://evil.example",
      "https://viktorbarzin.me.evil.example",
      "https://evilviktorbarzin.me",
      "http://t3.viktorbarzin.me",
      "javascript:alert(1)",
      "https://t3.viktorbarzin.me/path?x",
      "http://192.168.1.4:17691",
      "not a url",
      "",
    ]) {
      expect(allowedT3Origin(o), o).toBeNull();
    }
  });

  it("reads ?t3view= when it is allowed, else the default", () => {
    expect(
      t3ViewOrigin({
        hostname: "terminal.viktorbarzin.me",
        search: "?t3view=http://127.0.0.1:17691",
      }),
    ).toBe("http://127.0.0.1:17691");
    expect(
      t3ViewOrigin({
        hostname: "terminal.viktorbarzin.me",
        search: "?t3view=https://evil.example",
      }),
    ).toBe("https://t3.viktorbarzin.me");
    expect(
      t3ViewOrigin({
        hostname: "terminal.viktorbarzin.me",
        search: "?t3view=https://pages.viktorbarzin.me",
      }),
    ).toBe("https://t3.viktorbarzin.me");
    expect(t3ViewOrigin({ hostname: "127.0.0.1", search: "" })).toBeNull();
  });

  it("delegates the clipboard only to the T3 view beside the lobby", () => {
    const lobby = "terminal.viktorbarzin.me";
    expect(t3FrameAllow("https://t3.viktorbarzin.me", lobby)).toBe(
      "clipboard-read; clipboard-write",
    );
    expect(t3FrameAllow("https://t3view.viktorbarzin.me", lobby)).toBeUndefined();
    expect(t3FrameAllow("http://127.0.0.1:17691", lobby)).toBeUndefined();
    expect(t3FrameAllow("http://127.0.0.1:17691", "127.0.0.1")).toBeUndefined();
  });
});

describe("which forwarded keys the lobby replays", () => {
  const sent = [
    { ctrl: false, shift: false, alt: true, meta: false, key: "1", code: "Digit1" },
    { ctrl: true, shift: false, alt: false, meta: false, key: "j" },
    { ctrl: false, shift: false, alt: false, meta: false, key: "escape", passive: true as const },
  ];
  const msg = (o: Partial<Parameters<typeof keyInChords>[0]>) => ({
    type: "tl-key" as const,
    v: 1 as const,
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...o,
  });

  it("replays a key that matches a chord it sent, by key or by code", () => {
    expect(keyInChords(msg({ key: "1", code: "Digit1", altKey: true }), sent)).toBe(true);
    expect(keyInChords(msg({ key: "¡", code: "Digit1", altKey: true }), sent)).toBe(true);
    expect(keyInChords(msg({ key: "J", code: "KeyX", ctrlKey: true }), sent)).toBe(true);
    expect(keyInChords(msg({ key: "Esc", code: "Escape" }), sent)).toBe(true);
  });

  it("drops a key it never asked for, whatever the frame says", () => {
    expect(keyInChords(msg({ key: "W", code: "KeyW", altKey: true, shiftKey: true }), sent)).toBe(
      false,
    );
    expect(keyInChords(msg({ key: "1", code: "Digit1", altKey: true, shiftKey: true }), sent)).toBe(
      false,
    );
    expect(keyInChords(msg({ key: "a", code: "KeyA" }), sent)).toBe(false);
    expect(keyInChords(msg({ key: "1", code: "Digit1", altKey: true }), [])).toBe(false);
  });
});

describe("which thread the frame shows", () => {
  it("is the birth name of one of your own sessions (keepalive keyOf)", () => {
    expect(t3ThreadId("\u0000824smya2cmz5")).toBe("824smya2cmz5");
  });

  it("is nothing for somebody else's session or an empty key", () => {
    expect(t3ThreadId("emo\u0000auth")).toBeNull();
    expect(t3ThreadId("\u0000")).toBeNull();
    expect(t3ThreadId("auth")).toBeNull();
  });

  it("builds T3's own thread route with the embed flag", () => {
    expect(
      t3FrameUrl({
        origin: "https://t3.viktorbarzin.me",
        environmentId: "3f2a-env",
        threadId: "824smya2cmz5",
      }),
    ).toBe("https://t3.viktorbarzin.me/3f2a-env/824smya2cmz5?embed");
  });

  it("escapes a hand-typed session name in the path", () => {
    expect(
      t3FrameUrl({
        origin: "http://127.0.0.1:17691",
        environmentId: "e",
        threadId: "a b/c",
      }),
    ).toBe("http://127.0.0.1:17691/e/a%20b%2Fc?embed");
  });

  it("opens the root while the environment id is not known yet", () => {
    expect(
      t3FrameUrl({
        origin: "https://t3.viktorbarzin.me",
        environmentId: null,
        threadId: "auth",
      }),
    ).toBe("https://t3.viktorbarzin.me/?embed");
  });

  it("opens the root for a preload, which shows no thread yet", () => {
    expect(
      t3FrameUrl({
        origin: "https://t3.viktorbarzin.me",
        environmentId: "3f2a-env",
        threadId: null,
      }),
    ).toBe("https://t3.viktorbarzin.me/?embed");
  });
});

describe("the environment id cache", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the id per T3 origin", () => {
    expect(loadEnvironmentId("https://t3.viktorbarzin.me")).toBeNull();
    saveEnvironmentId("https://t3.viktorbarzin.me", "env-1");
    expect(loadEnvironmentId("https://t3.viktorbarzin.me")).toBe("env-1");
    expect(loadEnvironmentId("http://127.0.0.1:17691")).toBeNull();
  });
});

describe("messages from the frame", () => {
  it("parses tl-ready", () => {
    expect(
      parseFrameMessage({ type: "tl-ready", v: 1, environmentId: "env-1", threadId: null }),
    ).toEqual({ type: "tl-ready", v: 1, environmentId: "env-1", threadId: null });
    expect(
      parseFrameMessage({ type: "tl-ready", v: 1, environmentId: "env-1", threadId: "auth" }),
    ).toEqual({ type: "tl-ready", v: 1, environmentId: "env-1", threadId: "auth" });
  });

  it("parses tl-key", () => {
    const msg = {
      type: "tl-key",
      v: 1,
      key: "1",
      code: "Digit1",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: true,
      repeat: false,
    };
    expect(parseFrameMessage(msg)).toEqual(msg);
  });

  it("refuses anything malformed, from another version, or with extra power", () => {
    for (const bad of [
      null,
      "tl-key",
      {
        type: "tl-key",
        v: 2,
        key: "1",
        code: "",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        repeat: false,
      },
      {
        type: "tl-key",
        v: 1,
        key: 1,
        code: "",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        repeat: false,
      },
      {
        type: "tl-key",
        v: 1,
        key: "1",
        code: "",
        ctrlKey: "yes",
        metaKey: false,
        shiftKey: false,
        altKey: true,
        repeat: false,
      },
      {
        type: "tl-key",
        v: 1,
        key: "x".repeat(40),
        code: "",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        repeat: false,
      },
      { type: "tl-ready", v: 1, environmentId: "", threadId: null },
      { type: "tl-ready", v: 1, environmentId: 3, threadId: null },
      { type: "tl-run", v: 1, command: "session.kill.current" },
    ]) {
      expect(parseFrameMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("parses tl-route, with the session the sidecar named or none", () => {
    const route = {
      type: "tl-route",
      v: 1,
      threadId: "5992c13c",
      session: { key: "bw8k5gt9v314", name: "say-hi" },
    };
    expect(parseFrameMessage(route)).toEqual(route);
    expect(parseFrameMessage({ type: "tl-route", v: 1, threadId: "x", session: null })).toEqual({
      type: "tl-route",
      v: 1,
      threadId: "x",
      session: null,
    });
    expect(parseFrameMessage({ type: "tl-route", v: 1, threadId: null, session: null })).toEqual({
      type: "tl-route",
      v: 1,
      threadId: null,
      session: null,
    });
  });

  it("refuses a tl-route that is malformed or names more than a session", () => {
    for (const bad of [
      { type: "tl-route", v: 1, threadId: 3, session: null },
      { type: "tl-route", v: 1, threadId: "x" },
      { type: "tl-route", v: 1, threadId: "x", session: { key: "", name: "n" } },
      { type: "tl-route", v: 1, threadId: "x", session: { key: "k", name: 4 } },
      { type: "tl-route", v: 1, threadId: "x", session: { key: "k".repeat(300), name: "n" } },
      { type: "tl-route", v: 1, threadId: "x", session: "say-hi" },
      { type: "tl-route", v: 2, threadId: "x", session: null },
    ]) {
      expect(parseFrameMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("replays a key as a cancelable, bubbling keydown with the same identity", () => {
    expect(
      replayInit({
        type: "tl-key",
        v: 1,
        key: "[",
        code: "BracketLeft",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: true,
        repeat: false,
      }),
    ).toEqual({
      key: "[",
      code: "BracketLeft",
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      altKey: true,
      repeat: false,
      bubbles: true,
      cancelable: true,
    });
  });
});

describe("the chords the frame hands back", () => {
  const rb = (key: string, command: string, when?: string): ResolvedBinding => ({
    command,
    when,
    chord: parseChord(key),
  });

  it("lists every live binding with its physical-key alias", () => {
    const chords = frameChords({
      enabled: true,
      defaults: [
        rb("alt+1", "session.attach.1"),
        rb("alt+shift+[", "session.prev"),
        rb("ctrl+shift+k", "palette.toggle"),
        rb("alt+shift+enter", "session.next.awaiting"),
        rb("alt+/", "shortcuts.help"),
      ],
      always: [rb("alt+shift+backspace", "session.kill.current")],
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
      key: "1",
      code: "Digit1",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: true,
      alt: true,
      meta: false,
      key: "[",
      code: "BracketLeft",
    });
    expect(chords).toContainEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: "k",
      code: "KeyK",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: true,
      alt: true,
      meta: false,
      key: "enter",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
      key: "/",
      code: "Slash",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: true,
      alt: true,
      meta: false,
      key: "backspace",
    });
  });

  it("always includes the dock's Ctrl/Cmd+J and a passive Escape", () => {
    const chords = frameChords({ enabled: true, defaults: [], always: [] });
    expect(chords).toContainEqual({
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
      key: "j",
      code: "KeyJ",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: true,
      key: "j",
      code: "KeyJ",
    });
    expect(chords).toContainEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      key: "escape",
      passive: true,
    });
  });

  // Cmd+Z in T3's composer is the composer's own undo. The lobby's undo row
  // says `!editing`, and the lobby cannot see focus inside the frame, so the
  // frame is told to keep the key while its own focus is in a field.
  it("marks the rows a focused field owns", () => {
    const chords = frameChords({
      enabled: true,
      defaults: [rb("ctrl+z", "edit.undo", "!editing && !overlayOpen && !previewDirty")],
      always: [],
    });
    expect(chords).toContainEqual({
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
      key: "z",
      code: "KeyZ",
      notWhileEditing: true,
    });
  });

  it("hands back only the always-on rows while app shortcuts are off", () => {
    const chords = frameChords({
      enabled: false,
      defaults: [rb("alt+1", "session.attach.1")],
      always: [rb("alt+shift+backspace", "session.kill.current")],
    });
    expect(chords.some((c) => c.key === "1")).toBe(false);
    expect(chords.some((c) => c.key === "backspace")).toBe(true);
  });

  it("skips a row whose override did not parse, and lists a chord once", () => {
    const chords = frameChords({
      enabled: true,
      defaults: [
        { command: "session.new", chord: null },
        rb("ctrl+z", "edit.undo"),
        rb("ctrl+z", "edit.undo"),
      ],
      always: [],
    });
    expect(chords.filter((c) => c.key === "z")).toHaveLength(1);
  });
});

describe("who is offered the T3 view", () => {
  const base = { actingAs: false, foreign: false, tool: "claude" as const };

  it("every user, as themselves, on their own Claude session (ADR-0045 decision 4)", () => {
    expect(t3Offered(base)).toBe(true);
  });

  it("nobody acting as someone else, on someone else's session, or on another tool", () => {
    expect(t3Offered({ ...base, actingAs: true })).toBe(false);
    expect(t3Offered({ ...base, foreign: true })).toBe(false);
    expect(t3Offered({ ...base, tool: "pi" })).toBe(false);
    expect(t3Offered({ ...base, tool: "codex" })).toBe(false);
    expect(t3Offered({ ...base, tool: "shell" })).toBe(false);
    expect(t3Offered({ ...base, tool: undefined })).toBe(false);
  });

  it("is true for exactly one row of the truth table", () => {
    const rows = [false, true].flatMap((actingAs) =>
      [false, true].flatMap((foreign) =>
        (["claude", "pi", "codex", "shell", undefined] as const).map((tool) => ({
          actingAs,
          foreign,
          tool,
        })),
      ),
    );
    expect(rows.filter((r) => t3Offered(r))).toEqual([base]);
  });
});


describe("which lobby session a route in the frame names", () => {
  const sessions = [
    { name: "say-hi", bornAs: "bw8k5gt9v314", tool: "claude" as const, owner: "wizard" },
    { name: "notes", tool: "claude" as const, owner: "wizard" },
    { name: "theirs", bornAs: "k9x", tool: "claude" as const, owner: "emo" },
  ];

  it("finds one of the caller's own sessions by its key, the birth name", () => {
    expect(followTarget(sessions, "wizard", { key: "bw8k5gt9v314", name: "stale" })).toBe("say-hi");
  });

  it("finds a hand-named session by its name", () => {
    expect(followTarget(sessions, "wizard", { key: "notes", name: "notes" })).toBe("notes");
  });

  it("finds nothing for someone else's session or one the list does not have", () => {
    expect(followTarget(sessions, "wizard", { key: "k9x", name: "theirs" })).toBeNull();
    expect(followTarget(sessions, "wizard", { key: "nope", name: "nope" })).toBeNull();
  });
});
