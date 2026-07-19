import { describe, it, expect, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import {
  clampFontSize,
  coercePrefs,
  composeDoc,
  mergeAdopt,
  applyPatch,
  createPrefsStore,
  PREF_DEFAULTS,
  PREFS_KEY,
  PREFS_DIRTY_KEY,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from "../src/store/prefs";

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
      session: { newCommand: "codex" },
      notify: { onDone: false, onAwaiting: true },
    });
  });
});

describe("composeDoc — write-back preserves unknown keys", () => {
  it("keeps unknown top-level keys AND unknown subkeys of known namespaces", () => {
    const raw = {
      gestures: { keyRepeat: false }, // unknown top-level namespace
      links: { copyChip: true }, // unknown top-level namespace
      session: { reopenLast: false, newCommand: "shell" }, // unknown subkey
      notify: { onDone: true },
    };
    const doc = composeDoc(raw, coercePrefs({ session: { newCommand: "codex" } }));
    // unknown namespaces survive untouched
    expect(doc.gestures).toEqual({ keyRepeat: false });
    expect(doc.links).toEqual({ copyChip: true });
    // unknown subkey preserved, known subkey updated
    expect(doc.session).toEqual({ reopenLast: false, newCommand: "codex" });
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
      expect(doc.gestures).toEqual({ keyRepeat: false }); // not clobbered
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
