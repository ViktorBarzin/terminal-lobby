import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createWatchMode,
  loadWatch,
  saveWatch,
  resolveWatch,
  WATCH_KEY_PREFIX,
} from "../src/store/watchmode";

/**
 * Auto-join: opening a session someone is already DRIVING comes up watching, so
 * a second device never takes the grid from the first.
 *
 * It needs three states, not two. "I have never said" has to be distinguishable
 * from "I said drive" — otherwise clicking *take control* on a session your
 * desktop is still driving would be undone by the same rule that put you in
 * watch mode, and the button would do nothing.
 */
describe("resolveWatch — an explicit choice beats the automatic one", () => {
  it("never chosen + nobody driving = drive (today's behaviour, unchanged)", () => {
    expect(resolveWatch(undefined, false)).toBe(false);
  });

  it("never chosen + someone driving = watch (the whole point)", () => {
    expect(resolveWatch(undefined, true)).toBe(true);
  });

  it("an explicit choice wins in both directions", () => {
    expect(resolveWatch(true, false)).toBe(true);
    expect(resolveWatch(false, true)).toBe(false);
  });
});

describe("watch storage — three states", () => {
  beforeEach(() => localStorage.clear());

  it("an untouched session reads as no choice, not as a choice to drive", () => {
    expect(loadWatch("foo")).toBeUndefined();
  });

  it("both choices persist and read back", () => {
    saveWatch("foo", true);
    expect(loadWatch("foo")).toBe(true);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBe("ro");
    saveWatch("foo", false);
    expect(loadWatch("foo")).toBe(false);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBe("rw");
  });

  it("clearing a choice returns the session to automatic", () => {
    saveWatch("foo", true);
    saveWatch("foo", undefined);
    expect(loadWatch("foo")).toBeUndefined();
  });

  it("a value written by the two-state version still reads correctly", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "old", "ro");
    expect(loadWatch("old")).toBe(true);
  });

  it("junk reads as no choice, so a damaged key falls back to automatic", () => {
    for (const junk of ["", "yes", "RO", "true", "0"]) {
      localStorage.setItem(WATCH_KEY_PREFIX + "foo", junk);
      expect(loadWatch("foo")).toBeUndefined();
    }
  });
});

/**
 * THE REGRESSION THAT SHIPPED AND HAD TO BE REVERTED.
 *
 * `driven` counts every read-write client, including the one asking. A live
 * dependency on it therefore feeds back on itself: attach read-write -> the next
 * poll reports the session as driven -> the rule flips this client to watch ->
 * the re-attach leaves only a read-only client -> driven goes false -> it flips
 * back. Once per poll, forever, re-navigating the terminal iframe each time.
 *
 * The fix is that joining is a decision made ONCE, when this view takes the
 * session on. What happens to the client set afterwards — including as a direct
 * consequence of our own attach — must not move it.
 */
describe("createWatchMode — the join decision is latched", () => {
  beforeEach(() => localStorage.clear());

  it("does not follow `driven` after the view has taken the session on", () => {
    createRoot((dispose) => {
      const [driven, setDriven] = createSignal(false);
      const [watch] = createWatchMode(() => "main", driven);

      expect(watch()).toBe(false); // nobody driving at join time

      // We attach read-write; the next poll now sees OUR client and says the
      // session is driven. Nothing about this client's own attach may change
      // how this client attached.
      setDriven(true);
      expect(watch()).toBe(false);

      // And the reverse leg, which is what made it oscillate rather than settle.
      setDriven(false);
      expect(watch()).toBe(false);
      dispose();
    });
  });

  it("latches the other way too: joining a driven session stays watching", () => {
    createRoot((dispose) => {
      const [driven, setDriven] = createSignal(true);
      const [watch] = createWatchMode(() => "main", driven);

      expect(watch()).toBe(true); // someone was driving at join time
      setDriven(false); // they left, or we became the only read-only client
      expect(watch()).toBe(true);
      dispose();
    });
  });

  it("re-latches when the view moves to a different session", () => {
    createRoot((dispose) => {
      const [session, setSession] = createSignal("quiet");
      const [driven, setDriven] = createSignal(false);
      const [watch] = createWatchMode(session, driven);
      expect(watch()).toBe(false);

      setDriven(true); // the OTHER session is busy
      setSession("busy"); // ...and we switch to it
      expect(watch()).toBe(true);
      dispose();
    });
  });

  it("an explicit toggle still takes effect immediately", () => {
    createRoot((dispose) => {
      const [driven] = createSignal(false);
      const [watch, set] = createWatchMode(() => "main", driven);
      expect(watch()).toBe(false);
      set(true);
      expect(watch()).toBe(true);
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("ro");
      dispose();
    });
  });

  it("take-control survives the other device continuing to drive", () => {
    createRoot((dispose) => {
      const [driven] = createSignal(true);
      const [watch, set] = createWatchMode(() => "main", driven);
      expect(watch()).toBe(true); // auto-joined as a viewer
      set(false); // take control
      expect(watch()).toBe(false); // and it sticks
      dispose();
    });
  });
});
