import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  changedPrefPaths,
  clampFontSize,
  coercePrefs,
  composeDoc,
  mergeAdopt,
  applyPatch,
  createPrefsStore,
  readPersistedPrefs,
  PREF_DEFAULTS,
  PREFS_KEY,
  PREFS_DIRTY_KEY,
  FONT_SIZE_KEY,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from "../src/store/prefs";

/** Every `track()` prefs.ts emits, in order. */
const tracked: { name: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs?: Record<string, unknown>) => void tracked.push({ name, attrs }),
}));
const prefsEvents = (): Record<string, unknown>[] =>
  tracked.filter((e) => e.name === "prefs.changed").map((e) => e.attrs ?? {});

describe("clampFontSize", () => {
  it("clamps to [6,22], rounds, defaults garbage", () => {
    expect(clampFontSize(3)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(30)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(15)).toBe(15);
    expect(clampFontSize(15.6)).toBe(16);
    expect(clampFontSize("abc")).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(undefined)).toBe(FONT_SIZE_DEFAULT);
  });
});

describe("coercePrefs — validate-or-default", () => {
  it("empty doc yields defaults", () => {
    expect(coercePrefs({})).toEqual(PREF_DEFAULTS);
    expect(coercePrefs(null)).toEqual(PREF_DEFAULTS);
    expect(coercePrefs(42)).toEqual(PREF_DEFAULTS);
    expect(coercePrefs([])).toEqual(PREF_DEFAULTS);
  });

  it("invalid known fields fall back to their default", () => {
    const p = coercePrefs({
      fontSize: 100, // out of range
      session: { newCommand: "vim" }, // not whitelisted
      notify: { onDone: "yes" }, // not boolean
    });
    expect(p.fontSize).toBe(FONT_SIZE_DEFAULT);
    expect(p.session.newCommand).toBe("claude");
    expect(p.notify.onDone).toBe(true);
    expect(p.notify.onAwaiting).toBe(true);
  });

  it("valid values pass through; a valid false notify survives", () => {
    const p = coercePrefs({
      fontSize: 18,
      session: { newCommand: "codex" },
      notify: { onDone: false, onAwaiting: true },
    });
    expect(p).toEqual({
      fontSize: 18,
      session: { newCommand: "codex", newProject: "", newModel: "default" },
      notify: { onDone: false, onAwaiting: true },
      // Absent from the input, so these take their defaults. This assertion is
      // exhaustive on purpose: a new pref has to show up here.
      sidebar: { showLastActive: false, order: "created" },
      lineHeight: 1,
      letterSpacing: 0,
      cursorStyle: "block",
      cursorBlink: true,
      fontWeightBold: "700",
      links: { copyChip: true },
      gestures: {
        wheelSmooth: true,
        wheelSpeed: 1,
        scrollSpeedV2: 1,
        scrollMomentum: true,
      },
      input: { tapFocus: "field" },
    });
  });
});

describe("composeDoc — write-back preserves unknown keys", () => {
  it("keeps unknown top-level keys AND unknown subkeys of known namespaces", () => {
    const raw = {
      // PARTLY owned, all three: this SPA types gestures.wheelSmooth/wheelSpeed
      // plus the scroller's two, input.tapFocus, and links.copyChip. The
      // terminal page owns everything else in them.
      input: { bar: "auto" },
      gestures: { keyRepeat: false },
      links: { copyChip: true },
      session: { reopenLast: false, newCommand: "shell" }, // unknown subkey
      notify: { onDone: true },
      thermostat: { setpoint: 21 }, // a wholly unknown namespace
    };
    const doc = composeDoc(raw, coercePrefs({ session: { newCommand: "codex" } }));
    // a wholly unknown namespace survives untouched
    expect(doc.thermostat).toEqual({ setpoint: 21 });
    // in a partly-owned one, the subkeys this SPA does not type survive and the
    // ones it does are materialised at their defaults
    expect(doc.input).toEqual({ bar: "auto", tapFocus: "field" });
    expect(doc.gestures).toEqual({
      keyRepeat: false,
      wheelSmooth: true,
      wheelSpeed: 1,
      scrollSpeedV2: 1,
      scrollMomentum: true,
    });
    expect(doc.links).toEqual({ copyChip: true });
    // unknown subkey preserved, known subkey updated
    expect(doc.session).toEqual({
      reopenLast: false,
      newCommand: "codex",
      newProject: "",
      newModel: "default",
    });
    // known fields written
    expect(doc.fontSize).toBe(FONT_SIZE_DEFAULT);
    expect(doc.notify).toEqual({ onDone: true, onAwaiting: true });
  });
});

describe("mergeAdopt — server wins, local + unknown preserved", () => {
  it("server top-level wins; local-only and unknown keys survive; namespaces deep-merge", () => {
    const local = {
      fontSize: 12,
      gestures: { keyRepeat: true },
      session: { newCommand: "claude", reopenLast: false },
      notify: { onDone: true, onAwaiting: true },
    };
    const server = {
      fontSize: 20, // server wins
      session: { newCommand: "codex" }, // subkey wins; local reopenLast kept
      notify: { onDone: false }, // subkey wins; local onAwaiting kept
    };
    const merged = mergeAdopt(local, server);
    expect(merged.fontSize).toBe(20);
    expect(merged.gestures).toEqual({ keyRepeat: true }); // local-only unknown kept
    expect(merged.session).toEqual({ newCommand: "codex", reopenLast: false });
    expect(merged.notify).toEqual({ onDone: false, onAwaiting: true });
  });
});

describe("applyPatch — one-level deep merge", () => {
  it("merges namespaces without dropping sibling subkeys", () => {
    const next = applyPatch(PREF_DEFAULTS, { notify: { onAwaiting: false } });
    expect(next.notify).toEqual({ onDone: true, onAwaiting: false });
    expect(next.session).toEqual(PREF_DEFAULTS.session);
    expect(next.fontSize).toBe(PREF_DEFAULTS.fontSize);
  });
});

describe("changedPrefPaths — dotted path + new value, changes only", () => {
  it("names the leaf that moved, not the namespace it lives in", () => {
    const prev = PREF_DEFAULTS;
    const next = applyPatch(prev, { session: { newCommand: "shell" } });
    expect(changedPrefPaths(prev, next)).toEqual([["session.newCommand", "shell"]]);
  });

  it("reports booleans as their value, never as the sub-key name", () => {
    const prev = applyPatch(PREF_DEFAULTS, { notify: { onAwaiting: false } });
    const next = applyPatch(prev, { notify: { onAwaiting: true } });
    expect(changedPrefPaths(prev, next)).toEqual([["notify.onAwaiting", "true"]]);
  });

  it("is silent when nothing moved, and lists every leaf that did", () => {
    expect(changedPrefPaths(PREF_DEFAULTS, PREF_DEFAULTS)).toEqual([]);
    const next = applyPatch(PREF_DEFAULTS, {
      fontSize: 21,
      notify: { onDone: false },
    });
    expect(changedPrefPaths(PREF_DEFAULTS, next)).toEqual([
      ["fontSize", "21"],
      ["notify.onDone", "false"],
    ]);
  });
});

describe("createPrefsStore — prefs.changed carries the value, not the key name", () => {
  beforeEach(() => {
    localStorage.clear();
    tracked.length = 0;
  });

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("emits the dotted path and the NEW VALUE for a session change", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ session: { newCommand: "shell" } });
      expect(prefsEvents()).toEqual([{ "tl.key": "session.newCommand", "tl.to": "shell" }]);
      store.dispose();
      dispose();
    });
  });

  it("emits the boolean for a notify change (on/off must be knowable)", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ notify: { onAwaiting: false } });
      expect(prefsEvents()).toEqual([{ "tl.key": "notify.onAwaiting", "tl.to": "false" }]);
      store.dispose();
      dispose();
    });
  });

  it("keeps the already-usable fontSize shape", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setFontSize(21);
      expect(prefsEvents()).toEqual([{ "tl.key": "fontSize", "tl.to": "21" }]);
      store.dispose();
      dispose();
    });
  });

  it("emits NOTHING for a write that changes nothing", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ session: { newCommand: PREF_DEFAULTS.session.newCommand } });
      expect(prefsEvents()).toEqual([]);
      store.dispose();
      dispose();
    });
  });
});

describe("createPrefsStore — live push into the terminal iframe", () => {
  beforeEach(() => {
    localStorage.clear();
    tracked.length = 0;
    delete window.__tlPrefsLive;
  });

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("pushes the new prefs to the attached terminal AFTER persisting them", () => {
    const seen: { fontSize: number; stored: string | null }[] = [];
    window.__tlPrefsLive = (p) => {
      // term.html reads localStorage as the truth, so the write must already be
      // durable by the time it is told to look.
      seen.push({ fontSize: p.fontSize, stored: localStorage.getItem("tl-font-size") });
      return true;
    };
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setFontSize(6);
      expect(seen).toEqual([{ fontSize: 6, stored: "6" }]);
      store.dispose();
      dispose();
    });
  });

  it("pushes an adopted server doc too (the roamed size must land live)", async () => {
    const sizes: number[] = [];
    window.__tlPrefsLive = (p) => {
      sizes.push(p.fontSize);
      return true;
    };
    await createRoot(async (dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({ fontSize: 20 }) });
      await store.bootSync();
      expect(sizes).toEqual([20]);
      store.dispose();
      dispose();
    });
  });

  it("survives a change made with no terminal mounted", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      expect(() => store.setFontSize(12)).not.toThrow();
      store.dispose();
      dispose();
    });
  });
});

describe("createPrefsStore — persistence + local-wins adoption", () => {
  beforeEach(() => localStorage.clear());

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("setPref updates the signal, persists, marks dirty, preserves unknown keys", () => {
    // a pre-existing roamed doc carrying a field this SPA doesn't own
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { keyRepeat: false } }));
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ session: { newCommand: "codex" } });
      expect(store.prefs().session.newCommand).toBe("codex");
      expect(localStorage.getItem(PREFS_DIRTY_KEY)).not.toBeNull();
      const doc = JSON.parse(localStorage.getItem(PREFS_KEY) as string);
      expect(doc.session.newCommand).toBe("codex");
      // keyRepeat is the terminal page's, and survives; the four keys this side
      // types get materialised at their defaults.
      expect(doc.gestures).toEqual({
        keyRepeat: false,
        wheelSmooth: true,
        wheelSpeed: 1,
        scrollSpeedV2: 1,
        scrollMomentum: true,
      });
      store.dispose();
      dispose();
    });
  });

  it("setFontSize clamps before persisting", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setFontSize(999);
      expect(store.prefs().fontSize).toBe(FONT_SIZE_MAX);
      store.setFontSize(1);
      expect(store.prefs().fontSize).toBe(FONT_SIZE_MIN);
      store.dispose();
      dispose();
    });
  });

  it("bootSync adopts the server doc when nothing is locally dirty", async () => {
    await createRoot(async (dispose) => {
      const store = createPrefsStore({
        fetchImpl: async () => okJson({ session: { newCommand: "shell" }, fontSize: 20 }),
      });
      await store.bootSync();
      expect(store.prefs().session.newCommand).toBe("shell");
      expect(store.prefs().fontSize).toBe(20);
      store.dispose();
      dispose();
    });
  });

  it("bootSync does NOT adopt when a local change is unacked (local wins) and PUTs instead", async () => {
    await createRoot(async (dispose) => {
      const calls: { method?: string; body?: string }[] = [];
      const store = createPrefsStore({
        putDebounceMs: 1,
        fetchImpl: async (_url, init) => {
          calls.push({ method: init?.method, body: init?.body as string });
          if (init?.method === "PUT") return okJson({});
          return okJson({ session: { newCommand: "shell" } }); // server says shell
        },
      });
      store.setPref({ session: { newCommand: "codex" } }); // local moves first
      await store.bootSync(); // server offers 'shell' — must be ignored
      expect(store.prefs().session.newCommand).toBe("codex");
      await new Promise((r) => setTimeout(r, 20));
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(put?.body as string).session.newCommand).toBe("codex");
      store.dispose();
      dispose();
    });
  });
});

/**
 * The three keys the native terminal's modules read, through the store rather
 * than against term.html (`prefs.terminal-rows.test.ts` owns the comparison
 * with the page's own tables, including the defaults).
 *
 * There is no settings UI for any of them yet. The reason they are typed anyway
 * is that a key `coercePrefs` drops is a key no component can read, and
 * `terminal/touchscroll.ts` and `terminal/wheel.ts` read all three. The reason
 * to put them through `setPref` and `changedPrefPaths` here, before that UI
 * exists, is that leaving them half-wired is the trap: a pref in the type that
 * `composeDoc` does not write no-ops silently at the store's own equality
 * guard, so the toggle someone adds later would appear to work and persist
 * nothing.
 */
describe("the native terminal's three prefs — through the store", () => {
  beforeEach(() => localStorage.clear());

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("patches one of them without resetting its namespace", () => {
    const next = applyPatch(PREF_DEFAULTS, { gestures: { scrollSpeedV2: 3 } });
    expect(next.gestures).toEqual({
      wheelSmooth: true,
      wheelSpeed: 1,
      scrollSpeedV2: 3,
      scrollMomentum: true,
    });
    expect(applyPatch(PREF_DEFAULTS, { input: { tapFocus: "terminal" } }).input).toEqual({
      tapFocus: "terminal",
    });
  });

  it("names each as its own dotted path, with the value it moved to", () => {
    const prev = PREF_DEFAULTS;
    expect(
      changedPrefPaths(prev, applyPatch(prev, { gestures: { scrollSpeedV2: 2 } })),
    ).toEqual([["gestures.scrollSpeedV2", "2"]]);
    expect(
      changedPrefPaths(prev, applyPatch(prev, { gestures: { scrollMomentum: false } })),
    ).toEqual([["gestures.scrollMomentum", "false"]]);
    expect(
      changedPrefPaths(prev, applyPatch(prev, { input: { tapFocus: "terminal" } })),
    ).toEqual([["input.tapFocus", "terminal"]]);
  });

  it("actually persists a change to one, rather than no-opping in the signal", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ gestures: { scrollSpeedV2: 2, scrollMomentum: false } });
      expect(store.prefs().gestures.scrollSpeedV2).toBe(2);
      expect(store.prefs().gestures.scrollMomentum).toBe(false);
      const doc = JSON.parse(localStorage.getItem(PREFS_KEY) as string);
      expect(doc.gestures.scrollSpeedV2).toBe(2);
      expect(doc.gestures.scrollMomentum).toBe(false);
      store.dispose();
      dispose();
    });
  });

  it("keeps a value the terminal page set, rather than adopting a default over it", () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ gestures: { scrollSpeedV2: 3, haptics: false } }),
    );
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      expect(store.prefs().gestures.scrollSpeedV2).toBe(3);
      store.setPref({ fontSize: 12 }); // an unrelated write
      const doc = JSON.parse(localStorage.getItem(PREFS_KEY) as string);
      expect(doc.gestures.scrollSpeedV2).toBe(3);
      expect(doc.gestures.haptics).toBe(false);
      store.dispose();
      dispose();
    });
  });
});

/**
 * `readPersistedPrefs` — the live read `terminal/touchscroll.ts` needs on every
 * feed, because term.html re-reads the speed pref inside `feedScroll` and the
 * component that would hold a cached copy is built once at mount.
 */
describe("readPersistedPrefs — the pull the touch scroller needs", () => {
  beforeEach(() => localStorage.clear());

  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("defaults with no doc at all, and never throws on a corrupt one", () => {
    expect(readPersistedPrefs()).toEqual(PREF_DEFAULTS);
    localStorage.setItem(PREFS_KEY, "{not json");
    expect(readPersistedPrefs()).toEqual(PREF_DEFAULTS);
    localStorage.setItem(PREFS_KEY, "[]");
    expect(readPersistedPrefs()).toEqual(PREF_DEFAULTS);
  });

  it("validates like the store, so a junk speed cannot reach the scroller", () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ gestures: { scrollSpeedV2: 7, scrollMomentum: "yes" } }),
    );
    expect(readPersistedPrefs().gestures.scrollSpeedV2).toBe(1);
    expect(readPersistedPrefs().gestures.scrollMomentum).toBe(true);
  });

  it("sees a change written by ANOTHER document, which the signal cannot", () => {
    // term.html is still the shipped terminal on this origin and writes the same
    // doc. Nothing in this store listens for a `storage` event, so reading the
    // signal instead would serve the old speed for the life of the mount.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { scrollSpeedV2: 1 } }));
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      expect(store.prefs().gestures.scrollSpeedV2).toBe(1);
      // the other frame writes the shared doc
      localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { scrollSpeedV2: 3 } }));
      expect(readPersistedPrefs().gestures.scrollSpeedV2).toBe(3);
      expect(store.prefs().gestures.scrollSpeedV2).toBe(1); // the signal is blind
      store.dispose();
      dispose();
    });
  });

  it("returns defaults before any write, because construction persists nothing", () => {
    // `createPrefsStore` composes its raw doc in memory and only persists on a
    // setPref or an adoption, so a first-run device has no `tl:prefs:v1` at all
    // and this read has to answer from PREF_DEFAULTS rather than from a doc.
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      expect(localStorage.getItem(PREFS_KEY)).toBeNull();
      expect(readPersistedPrefs()).toEqual(PREF_DEFAULTS);
      store.dispose();
      dispose();
    });
  });

  it("re-reads on every call, so a feed after a change sees the new speed", () => {
    const seen: number[] = [];
    for (const speed of [1, 1.5, 2, 3]) {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ gestures: { scrollSpeedV2: speed } }));
      seen.push(readPersistedPrefs().gestures.scrollSpeedV2);
    }
    expect(seen).toEqual([1, 1.5, 2, 3]);
  });

  it("is never staler than the store, which persists before it pushes", () => {
    createRoot((dispose) => {
      const store = createPrefsStore({ fetchImpl: async () => okJson({}) });
      store.setPref({ gestures: { scrollMomentum: false } });
      expect(readPersistedPrefs().gestures.scrollMomentum).toBe(false);
      store.dispose();
      dispose();
    });
  });

  it("seeds fontSize from the legacy device key, like term.html's getPrefs", () => {
    // The one part of the read that is not just coercePrefs. Same fallback the
    // store's own boot takes, so the two cannot disagree about the size.
    localStorage.setItem(FONT_SIZE_KEY, "19");
    expect(readPersistedPrefs().fontSize).toBe(19);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ fontSize: 11 }));
    expect(readPersistedPrefs().fontSize).toBe(11); // the doc wins over the key
    localStorage.setItem(PREFS_KEY, JSON.stringify({ fontSize: 99 })); // out of range
    expect(readPersistedPrefs().fontSize).toBe(19);
    localStorage.removeItem(FONT_SIZE_KEY);
    expect(readPersistedPrefs().fontSize).toBe(FONT_SIZE_DEFAULT);
  });
});

/**
 * The composer's two remembered choices, roamed beside `session.newCommand`.
 *
 * Both are about the NEXT session rather than the one on screen, and both
 * follow a person across devices for the same reason the command does: the
 * project they are working in and the model they prefer do not change when
 * they pick up a phone.
 */
describe("the composer's roamed choices", () => {
  it("defaults to no project and the box's own model", () => {
    expect(PREF_DEFAULTS.session.newProject).toBe("");
    expect(PREF_DEFAULTS.session.newModel).toBe("default");
  });

  it("keeps a project name verbatim — a project is named by a person", () => {
    const p = coercePrefs({ session: { newProject: "code", newModel: "sonnet" } });
    expect(p.session.newProject).toBe("code");
    expect(p.session.newModel).toBe("sonnet");
  });

  it("rejects a model it does not offer, rather than sending /model garbage", () => {
    expect(coercePrefs({ session: { newModel: "gpt-5" } }).session.newModel).toBe("default");
    expect(coercePrefs({ session: { newProject: 7 } }).session.newProject).toBe("");
  });

  it("writes both back into the shared doc without dropping unknown subkeys", () => {
    const doc = composeDoc(
      { session: { reopenLast: false } },
      coercePrefs({ session: { newProject: "tripit", newModel: "haiku" } }),
    ) as { session: Record<string, unknown> };
    expect(doc.session.reopenLast).toBe(false);
    expect(doc.session.newProject).toBe("tripit");
    expect(doc.session.newModel).toBe("haiku");
  });

  it("reports each as its own changed path", () => {
    const prev = coercePrefs({});
    expect(
      changedPrefPaths(prev, applyPatch(prev, { session: { newProject: "code" } })),
    ).toEqual([["session.newProject", "code"]]);
    expect(
      changedPrefPaths(prev, applyPatch(prev, { session: { newModel: "opus" } })),
    ).toEqual([["session.newModel", "opus"]]);
  });
});
