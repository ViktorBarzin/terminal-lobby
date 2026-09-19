import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  dropHeld,
  flushHeldWhenAwake,
  heldFor,
  holdForSuspended,
  MAX_HELD_PER_SESSION,
  releaseHeld,
  resetHeld,
} from "../src/store/suspend-queue";

/**
 * What happens to a message typed at a session that is still waking up.
 *
 * A suspended session's pane holds a dead shell. `claude --resume` takes 1.7s
 * on an empty transcript and 3.1s on a 24MB one, and the poll that reports the
 * session live again is 5s behind that — so there is a window of seconds in
 * which the composer is on screen, the frozen scrollback looks like a session,
 * and a prompt posted into it would land in a dead pane and vanish.
 *
 * TEXT is held, never keystrokes. `terminal/held.ts` is the keystroke-level
 * hold and deliberately stays out of this: a raw key replayed into a shell that
 * has moved on is the failure mode this avoids, and a whole message is
 * something a person can see, count and take back.
 */

beforeEach(() => resetHeld());

describe("holdForSuspended", () => {
  it("hands back nothing for a session that has never held anything", () => {
    expect(heldFor("a")).toEqual([]);
  });

  it("keeps what was typed, oldest first", () => {
    holdForSuspended("a", "first");
    holdForSuspended("a", "second");
    expect(heldFor("a")).toEqual(["first", "second"]);
  });

  it("keeps each session's messages to itself", () => {
    holdForSuspended("a", "for a");
    holdForSuspended("b", "for b");
    expect(heldFor("a")).toEqual(["for a"]);
    expect(heldFor("b")).toEqual(["for b"]);
  });

  it("ignores an empty message", () => {
    holdForSuspended("a", "   ");
    expect(heldFor("a")).toEqual([]);
  });

  it("refuses to grow without bound", () => {
    // A queue nobody drains is a queue that replays a wall of prompts into a
    // session that woke up minutes ago. The oldest goes.
    for (let i = 0; i < MAX_HELD_PER_SESSION + 3; i++) holdForSuspended("a", "m" + i);
    const held = heldFor("a");
    expect(held).toHaveLength(MAX_HELD_PER_SESSION);
    expect(held[0]).toBe("m3");
  });
});

describe("releaseHeld", () => {
  it("hands the messages over and forgets them", () => {
    holdForSuspended("a", "one");
    holdForSuspended("a", "two");
    expect(releaseHeld("a")).toEqual(["one", "two"]);
    expect(heldFor("a")).toEqual([]);
    expect(releaseHeld("a")).toEqual([]);
  });
});

describe("dropHeld", () => {
  it("throws away what a killed session will never receive", () => {
    // Called from the lobby store's `sendKill`, after the undo window has
    // closed — the first moment the text is certainly unwanted.
    holdForSuspended("a", "one");
    dropHeld("a");
    expect(heldFor("a")).toEqual([]);
  });
});

describe("flushHeldWhenAwake", () => {
  /** Run `fn` inside a Solid root and dispose it afterwards. */
  const inRoot = async (fn: (dispose: () => void) => Promise<void> | void): Promise<void> => {
    let dispose = () => {};
    const done = createRoot((d) => {
      dispose = d;
      return fn(d);
    });
    await done;
    dispose();
  };

  it("sends what was held, in order, once the session is back", async () => {
    await inRoot(async () => {
      const [suspended, setSuspended] = createSignal(true);
      const sent: string[] = [];
      flushHeldWhenAwake({
        session: () => "a",
        suspended,
        send: async (t) => {
          sent.push(t);
          return true;
        },
      });
      holdForSuspended("a", "one");
      holdForSuspended("a", "two");
      expect(sent).toEqual([]);

      setSuspended(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toEqual(["one", "two"]);
      expect(heldFor("a")).toEqual([]);
    });
  });

  it("sends nothing for a session that was live all along", async () => {
    await inRoot(async () => {
      const [suspended] = createSignal(false);
      const sent: string[] = [];
      flushHeldWhenAwake({
        session: () => "a",
        suspended,
        send: async (t) => {
          sent.push(t);
          return true;
        },
      });
      await Promise.resolve();
      expect(sent).toEqual([]);
    });
  });

  it("keeps what a refused send did not take", async () => {
    // The session is awake but the POST failed. `store.send` has already said
    // so in a toast; nothing here may drop the text on the floor as well.
    await inRoot(async () => {
      const [suspended, setSuspended] = createSignal(true);
      const sent: string[] = [];
      flushHeldWhenAwake({
        session: () => "a",
        suspended,
        send: async (t) => {
          sent.push(t);
          return false;
        },
      });
      holdForSuspended("a", "one");
      holdForSuspended("a", "two");
      setSuspended(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toEqual(["one"]);
      expect(heldFor("a")).toEqual(["one", "two"]);
    });
  });

  it("follows a session that was renamed while it held something", async () => {
    // tmux-api renames a session out from under whoever is holding its name
    // (ADR-0022). Text held under the old one has to travel with it.
    await inRoot(async () => {
      const [name, setName] = createSignal("old");
      const [suspended, setSuspended] = createSignal(true);
      const sent: string[] = [];
      flushHeldWhenAwake({
        session: name,
        suspended,
        send: async (t) => {
          sent.push(t);
          return true;
        },
      });
      holdForSuspended("old", "carried");
      setName("new");
      setSuspended(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toEqual(["carried"]);
      expect(heldFor("old")).toEqual([]);
    });
  });
});
