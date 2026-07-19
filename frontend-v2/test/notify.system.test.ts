import { describe, it, expect } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createNotificationSystem,
  type NotificationSystem,
} from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";

/**
 * Integration smoke test for the wiring layer (the pure modules have their own
 * focused suites). jsdom has no Notification/PushManager/serviceWorker/indexedDB,
 * so every browser-API path must degrade quietly — this asserts the system
 * constructs, paints the title, forwards attention, and disposes without throwing.
 */
describe("createNotificationSystem (integration smoke)", () => {
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
});
