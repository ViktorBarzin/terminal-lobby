import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createNotificationSystem,
  type NotificationSystem,
} from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";
import type { FaviconKind } from "../src/notify/favicon";

// The badger paints a canvas, which jsdom has no backend for — swap it for a
// recorder so the favicon KIND the system asks for is observable. faviconKind
// itself stays real (its own suite covers the precedence).
const h = vi.hoisted(() => ({ kinds: [] as string[] }));
vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return {
    ...actual,
    createFaviconBadger: () => ({
      apply: (k: FaviconKind) => {
        if (k !== h.kinds[h.kinds.length - 1]) h.kinds.push(k);
      },
    }),
  };
});
const faviconNow = (): string => h.kinds[h.kinds.length - 1] ?? "";

/**
 * Integration smoke test for the wiring layer (the pure modules have their own
 * focused suites). jsdom has no Notification/PushManager/serviceWorker/indexedDB,
 * so every browser-API path must degrade quietly — this asserts the system
 * constructs, paints the title, forwards attention, and disposes without throwing.
 */
describe("createNotificationSystem (integration smoke)", () => {
  beforeEach(() => {
    localStorage.clear();
    // A session counts as seen only while the tab is on screen AND focused;
    // jsdom reports no focus, so say the user is looking at the app.
    Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
    h.kinds.length = 0;
  });
  afterEach(() => localStorage.clear());

  it("constructs, paints the tab title, and degrades without a Notification API", () => {
    const [sessions, setSessions] = createSignal<TitleSession[]>([]);
    const [selected] = createSignal<string | null>(null);
    const [loading, setLoading] = createSignal(true);
    const notes: { msg: string; kind: string }[] = [];

    let sys!: NotificationSystem;
    let disposeRoot!: () => void;
    createRoot((d) => {
      disposeRoot = d;
      sys = createNotificationSystem({
        sessions,
        selected,
        osUser: () => "wizard",
        notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
        loading,
        toast: (msg, kind) => notes.push({ msg, kind }),
        onActivateSession: () => {},
      });
    });
    // Effects have flushed now (Solid runs them after createRoot's callback).

    // Bell mode is one of the three known presentations.
    expect(["toggle", "install-hint", "hidden"]).toContain(sys.bellMode);
    // Device readout starts pending (async self-diagnosis).
    expect(sys.deviceState()).toBe("checking");
    // The title/favicon effect painted the base title (no active session).
    expect(document.title).toBe("tmux sessions (wizard)");

    // A poll with an awaiting session updates the tab title badge.
    setLoading(false);
    setSessions([{ name: "worktree", state: "awaiting" }]);
    expect(document.title).toBe("(1●) tmux sessions (wizard)");

    // Forwarding an attention signal must not throw (no favicon link in jsdom).
    expect(() => sys.onFrameAttention("bell", "worktree")).not.toThrow();

    sys.dispose();
    disposeRoot();
  });

  it("badges an unseen finished session in BOTH the title and the favicon, and clears both on a visit", () => {
    const [sessions, setSessions] = createSignal<TitleSession[]>([]);
    const [selected, setSelected] = createSignal<string | null>(null);
    const [loading, setLoading] = createSignal(true);

    let sys!: NotificationSystem;
    let disposeRoot!: () => void;
    createRoot((d) => {
      disposeRoot = d;
      sys = createNotificationSystem({
        sessions,
        selected,
        osUser: () => "wizard",
        notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
        loading,
        toast: () => {},
        onActivateSession: () => {},
      });
    });

    setLoading(false);
    setSessions([{ name: "a", state: "running" }]);
    expect(document.title).toBe("(1⋯) tmux sessions (wizard)");
    expect(faviconNow()).toBe("");

    // The turn finishes while the lobby is on screen but nothing is attached.
    setSessions([{ name: "a", state: "done" }]);
    expect(document.title).toBe("(1✓) tmux sessions (wizard)");
    expect(faviconNow()).toBe("done"); // #14: the favicon badges too

    // Viewing it marks it seen — the badge must CLEAR (#10), title and favicon.
    setSelected("a");
    expect(document.title).toBe("tmux: wizard/a");
    expect(faviconNow()).toBe("");

    // ...and a later poll of the same done session does not re-badge it.
    setSessions([{ name: "a", state: "done", pane_current_command: "zsh" }]);
    expect(document.title).toBe("zsh — a");
    expect(faviconNow()).toBe("");

    sys.dispose();
    disposeRoot();
  });

  it("keeps badging the sessions the user has NOT visited", () => {
    const [sessions, setSessions] = createSignal<TitleSession[]>([]);
    const [selected, setSelected] = createSignal<string | null>(null);
    const [loading, setLoading] = createSignal(true);

    let sys!: NotificationSystem;
    let disposeRoot!: () => void;
    createRoot((d) => {
      disposeRoot = d;
      sys = createNotificationSystem({
        sessions,
        selected,
        osUser: () => "wizard",
        notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
        loading,
        toast: () => {},
        onActivateSession: () => {},
      });
    });

    setLoading(false);
    setSessions([
      { name: "a", state: "running" },
      { name: "b", state: "running" },
    ]);
    setSessions([
      { name: "a", state: "done" },
      { name: "b", state: "done" },
    ]);
    expect(document.title).toBe("(2✓) tmux sessions (wizard)");

    setSelected("a");
    // 'b' is still unseen → the badge counts 1, not 0 and not 2.
    expect(document.title).toBe("(1✓) tmux: wizard/a");
    expect(faviconNow()).toBe("done");

    sys.dispose();
    disposeRoot();
  });
});
