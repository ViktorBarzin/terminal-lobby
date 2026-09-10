import { describe, it, expect } from "vitest";
import {
  UNDO_CAP,
  UNDO_KEY,
  createUndoStore,
  registerUndoHandler,
  type UndoEntry,
  type UndoHandler,
  type UndoResult,
  type UndoStore,
} from "../src/store/undo";

/**
 * The undo stack itself, with no real action in it. Every case here pushes
 * entries of a made-up `test` kind and asserts on what the HANDLER was asked to
 * do, because that is the whole of the store's job: hold a sequence of plain
 * JSON records and hand the top one to the code that knows how to invert it.
 * The real kinds (kill, retitle, reorder, project, …) land in later batches and
 * each brings its own test of its own inverse.
 *
 * Three things this file is really guarding:
 *
 *   1. An entry is plain JSON. The stack persists to sessionStorage so it
 *      survives the reload deploy/healer.ts performs when a new build lands,
 *      and a closure does not survive JSON.stringify. That is why behaviour
 *      lives in a handler looked up by `kind` and never on the entry.
 *   2. A refusal DROPS its entry. An entry whose precondition no longer holds
 *      must not sit at the top of the stack absorbing every further Cmd+Z.
 *   3. A lens tab (`?as=bob`) has no undo at all and does not so much as read
 *      the key. Switching identity is a navigation in the SAME tab
 *      (lib/act-as.ts), so a stack sitting in sessionStorage there was written
 *      by another identity.
 */

/** A `MinStorage` the test can read back, seeded with a hostile document. */
function fakeStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(UNDO_KEY, seed);
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** How a recorded call names the entry it was handed. */
const label = (e: UndoEntry): string => e.session ?? e.sessions?.join("+") ?? e.kind;

/** A handler that records rather than acts, so a case asserts on the ASK. */
function recorder(calls: string[]): UndoHandler {
  return {
    check: () => null,
    undo: async (e) => {
      calls.push(`undo ${label(e)}`);
    },
    redo: async (e) => {
      calls.push(`redo ${label(e)}`);
    },
  };
}

interface Harness {
  stack: UndoStore;
  /** every handler call in order, as `"undo a"` / `"redo a"`. */
  calls: string[];
  storage: ReturnType<typeof fakeStorage>;
}

function setup(
  over: {
    check?: UndoHandler["check"];
    undo?: UndoHandler["undo"];
    enabled?: boolean;
    seed?: string;
  } = {},
): Harness {
  const calls: string[] = [];
  const storage = fakeStorage(over.seed);
  const handler: UndoHandler = { ...recorder(calls) };
  if (over.check) handler.check = over.check;
  if (over.undo) handler.undo = over.undo;
  const stack = createUndoStore({
    enabled: over.enabled,
    storage,
    now: () => 5_000,
    handlers: new Map([["test", handler]]),
  });
  return { stack, calls, storage };
}

const push = (s: UndoStore, session: string): void => s.push({ kind: "test", session });

/**
 * Press Cmd+Z until the stack is empty. Bounded rather than `while`: an undo
 * that failed to shrink the stack should fail this test, not hang the suite.
 */
async function drain(s: UndoStore): Promise<UndoResult[]> {
  const out: UndoResult[] = [];
  for (let i = 0; i < UNDO_CAP + 10 && s.canUndo(); i++) out.push(await s.undo());
  return out;
}

describe("createUndoStore — order", () => {
  it("undoes the newest action first", async () => {
    const h = setup();
    push(h.stack, "a");
    push(h.stack, "b");
    push(h.stack, "c");
    await drain(h.stack);
    expect(h.calls).toEqual(["undo c", "undo b", "undo a"]);
    expect(h.stack.canUndo()).toBe(false);
  });

  it("has nothing to undo before anything is pushed, and says so silently", async () => {
    const h = setup();
    expect(h.stack.canUndo()).toBe(false);
    // reason null = nothing to say. Cmd+Z on an empty stack is not a refusal to
    // report, it is a key that does nothing, exactly as in a browser.
    expect(await h.stack.undo()).toEqual({ ok: false, reason: null });
    expect(await h.stack.redo()).toEqual({ ok: false, reason: null });
    expect(h.calls).toEqual([]);
  });

  it("hands two presses in the same tick two different entries", async () => {
    // Cmd+Z held down, or pressed twice before the first request settles. The
    // store pops synchronously and only then awaits, so the second press sees a
    // stack that is already one shorter instead of applying the same entry
    // twice, which for a kill would mean two restores.
    const h = setup();
    push(h.stack, "a");
    push(h.stack, "b");
    const both = await Promise.all([h.stack.undo(), h.stack.undo()]);
    expect(both).toEqual([{ ok: true }, { ok: true }]);
    expect(h.calls).toEqual(["undo b", "undo a"]);
    expect(h.stack.canUndo()).toBe(false);
  });

  it(`keeps the newest ${UNDO_CAP} actions and drops the oldest`, async () => {
    const h = setup();
    for (let i = 0; i < UNDO_CAP + 3; i++) push(h.stack, `s${i}`);
    await drain(h.stack);
    expect(h.calls).toHaveLength(UNDO_CAP);
    expect(h.calls[0]).toBe(`undo s${UNDO_CAP + 2}`); // newest first
    expect(h.calls[h.calls.length - 1]).toBe("undo s3"); // s0..s2 fell off
  });
});

describe("createUndoStore — redo", () => {
  it("round-trips an action out and back in", async () => {
    const h = setup();
    push(h.stack, "a");
    expect(await h.stack.undo()).toEqual({ ok: true });
    expect(h.stack.canUndo()).toBe(false);
    expect(h.stack.canRedo()).toBe(true);
    expect(await h.stack.redo()).toEqual({ ok: true });
    expect(h.calls).toEqual(["undo a", "redo a"]);
    // back where it started: the entry is undoable again and there is no redo
    expect(h.stack.canUndo()).toBe(true);
    expect(h.stack.canRedo()).toBe(false);
  });

  it("clears the redo stack as soon as a new action happens", async () => {
    const h = setup();
    push(h.stack, "a");
    await h.stack.undo();
    expect(h.stack.canRedo()).toBe(true);
    push(h.stack, "b");
    expect(h.stack.canRedo()).toBe(false);
    expect(await h.stack.redo()).toEqual({ ok: false, reason: null });
    expect(h.calls).toEqual(["undo a"]);
  });

  it("asks the handler before redoing too", async () => {
    // `check` is asked in BOTH directions: an entry can stop being applicable
    // between the undo and the redo as easily as before the undo.
    let blocked: string | null = null;
    const calls: string[] = [];
    const stack = createUndoStore({
      storage: fakeStorage(),
      now: () => 5_000,
      handlers: new Map([["test", { ...recorder(calls), check: () => blocked }]]),
    });
    push(stack, "a");
    expect(await stack.undo()).toEqual({ ok: true });
    blocked = "the session was killed on another device";
    expect(await stack.redo()).toEqual({ ok: false, reason: blocked });
    expect(calls).toEqual(["undo a"]); // the redo never ran
    expect(stack.canRedo()).toBe(false); // and the refused entry is gone
  });
});

describe("createUndoStore — a refusal drops its entry", () => {
  it("lets the next press reach the entry below", async () => {
    const h = setup({
      check: (e) => (e.session === "b" ? "the order changed on another device" : null),
    });
    push(h.stack, "a");
    push(h.stack, "b");
    expect(await h.stack.undo()).toEqual({
      ok: false,
      reason: "the order changed on another device",
    });
    expect(h.calls).toEqual([]); // b was never applied
    expect(h.stack.canUndo()).toBe(true);
    expect(await h.stack.undo()).toEqual({ ok: true });
    expect(h.calls).toEqual(["undo a"]);
    // a refused entry is gone rather than parked on the redo stack: redoing an
    // action nobody undid would apply it a second time.
    expect(h.stack.canRedo()).toBe(true); // 'a' alone
    expect(h.stack.canUndo()).toBe(false);
  });

  it("drops the entry when the handler itself fails, and hands back the reason", async () => {
    const h = setup({
      undo: async () => {
        throw new Error("the session is already gone");
      },
    });
    push(h.stack, "a");
    expect(await h.stack.undo()).toEqual({ ok: false, reason: "the session is already gone" });
    expect(h.stack.canUndo()).toBe(false);
    expect(h.stack.canRedo()).toBe(false);
  });

  it("refuses an entry of a kind nothing registered, rather than throwing", async () => {
    const h = setup();
    h.stack.push({ kind: "kind.from.an.older.build", session: "a" });
    const r = await h.stack.undo();
    expect(r).toEqual({ ok: false, reason: "that action can no longer be undone" });
    expect(h.stack.canUndo()).toBe(false);
  });

  it("survives a handler whose check throws", async () => {
    const h = setup({
      check: () => {
        throw new Error("read of a layout that is not there");
      },
    });
    push(h.stack, "a");
    expect(await h.stack.undo()).toEqual({
      ok: false,
      reason: "read of a layout that is not there",
    });
    expect(h.stack.canUndo()).toBe(false);
  });
});

describe("createUndoStore — persistence", () => {
  it("picks the stack up where a reload left it", async () => {
    const first = setup();
    push(first.stack, "a");
    push(first.stack, "b");
    await first.stack.undo(); // 'b' is now redoable
    const calls: string[] = [];
    const second = createUndoStore({
      storage: first.storage,
      now: () => 6_000,
      handlers: new Map([["test", recorder(calls)]]),
    });
    // both halves survived, in order
    expect(second.canUndo()).toBe(true);
    expect(second.canRedo()).toBe(true);
    await second.redo();
    await second.undo();
    expect(calls).toEqual(["redo b", "undo b"]);
  });

  it("stamps each entry from the injected clock", () => {
    const h = setup();
    push(h.stack, "a");
    const doc = JSON.parse(h.storage.map.get(UNDO_KEY) as string);
    expect(doc).toEqual({ undo: [{ kind: "test", session: "a", at: 5_000 }], redo: [] });
  });

  it.each([
    ["a document that is not JSON", "{not json"],
    ["a bare array", "[1,2,3]"],
    ["null", "null"],
    ["stacks that are not arrays", '{"undo":42,"redo":42}'],
    ["an entry with no kind", '{"undo":[{"at":1}],"redo":[]}'],
    ["entries that are not objects", '{"undo":[null,7,"x"],"redo":[]}'],
    ["an entry with no stamp", '{"undo":[{"kind":"test"}],"redo":[]}'],
    ["a session that is not a string", '{"undo":[{"kind":"test","at":1,"session":9}],"redo":[]}'],
    [
      "a sessions list holding a number",
      '{"undo":[{"kind":"test","at":1,"sessions":["a",9]}],"redo":[]}',
    ],
  ])("starts empty on %s", (_what, seed) => {
    // The WHOLE document goes, not just the bad entry. A stack is a sequence of
    // inverses; one with a hole in it is not a shorter stack, it is a wrong one.
    const h = setup({ seed });
    expect(h.stack.canUndo()).toBe(false);
    expect(h.stack.canRedo()).toBe(false);
  });

  it("keeps at most the cap when the stored document holds more", () => {
    const entries = Array.from({ length: UNDO_CAP + 5 }, (_v, i) => ({
      kind: "test",
      at: i,
      session: `s${i}`,
    }));
    const h = setup({ seed: JSON.stringify({ undo: entries, redo: [] }) });
    push(h.stack, "fresh"); // a push is what rewrites the document
    const doc = JSON.parse(h.storage.map.get(UNDO_KEY) as string);
    expect(doc.undo).toHaveLength(UNDO_CAP);
    expect(doc.undo[doc.undo.length - 1]).toEqual({ kind: "test", session: "fresh", at: 5_000 });
  });

  it("works with no storage at all", async () => {
    const none = createUndoStore({
      storage: null,
      now: () => 1,
      handlers: new Map([["test", recorder([])]]),
    });
    push(none, "a");
    expect(none.canUndo()).toBe(true);
    expect(await none.undo()).toEqual({ ok: true });
  });

  it("works with a storage that refuses every read and write", () => {
    const hostile = createUndoStore({
      storage: {
        getItem: () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        },
        removeItem: () => {},
      },
      now: () => 1,
      handlers: new Map([["test", recorder([])]]),
    });
    expect(() => push(hostile, "a")).not.toThrow();
    expect(hostile.canUndo()).toBe(true);
  });

  it("clear() empties both halves and the stored document", async () => {
    const h = setup();
    push(h.stack, "a");
    push(h.stack, "b");
    await h.stack.undo();
    h.stack.clear();
    expect(h.stack.canUndo()).toBe(false);
    expect(h.stack.canRedo()).toBe(false);
    expect(JSON.parse(h.storage.map.get(UNDO_KEY) as string)).toEqual({ undo: [], redo: [] });
  });
});

describe("createUndoStore — a lens tab", () => {
  it("accepts nothing, applies nothing, and never touches the key", async () => {
    const h = setup({ enabled: false });
    push(h.stack, "a");
    expect(h.stack.canUndo()).toBe(false);
    expect(await h.stack.undo()).toEqual({ ok: false, reason: null });
    expect(await h.stack.redo()).toEqual({ ok: false, reason: null });
    expect(h.calls).toEqual([]);
    expect(h.storage.map.size).toBe(0);
  });

  it("does not read a stack another identity left in the tab", () => {
    const seed = JSON.stringify({ undo: [{ kind: "test", at: 1, session: "a" }], redo: [] });
    const h = setup({ enabled: false, seed });
    expect(h.stack.canUndo()).toBe(false);
    // and the document is left as it was found, for the tab that owns it
    expect(h.storage.map.get(UNDO_KEY)).toBe(seed);
  });
});

describe("carry", () => {
  it("rewrites the session name an entry holds when a rename lands under it", async () => {
    // A title lands seconds into the first turn and tmux-api RENAMES the session
    // (ADR-0022, store/lobby.ts:455 renamesBetween). An entry still naming the
    // minted name would refuse against a session that is right there.
    const h = setup();
    push(h.stack, "claude");
    h.stack.carry("claude", "claude-2");
    expect(await h.stack.undo()).toEqual({ ok: true });
    expect(h.calls).toEqual(["undo claude-2"]);
  });

  it("rewrites one name inside a list and leaves its neighbours alone", async () => {
    const h = setup();
    h.stack.push({ kind: "test", sessions: ["a", "b", "c"] });
    h.stack.carry("b", "b-2");
    await h.stack.undo();
    expect(h.calls).toEqual(["undo a+b-2+c"]);
  });

  it("rewrites entries on the redo stack too", async () => {
    const h = setup();
    push(h.stack, "claude");
    await h.stack.undo();
    h.stack.carry("claude", "claude-2");
    await h.stack.redo();
    expect(h.calls).toEqual(["undo claude", "redo claude-2"]);
  });

  it("persists the rewrite, so a reload does not bring the old name back", () => {
    const h = setup();
    push(h.stack, "claude");
    h.stack.carry("claude", "claude-2");
    const doc = JSON.parse(h.storage.map.get(UNDO_KEY) as string);
    expect(doc.undo[0].session).toBe("claude-2");
  });

  it("leaves every other entry untouched, and does nothing for a no-op rename", () => {
    const h = setup();
    push(h.stack, "other");
    h.stack.carry("claude", "claude-2");
    h.stack.carry("other", "other"); // same name in and out
    const doc = JSON.parse(h.storage.map.get(UNDO_KEY) as string);
    expect(doc.undo[0].session).toBe("other");
  });
});

describe("registerUndoHandler", () => {
  it("is where a store with no injected registry looks the kind up", async () => {
    // The module registry, which the app wires at boot: the store that owns an
    // action registers its own inverse, so undo.ts imports nothing from
    // store/lobby.ts and the dependency runs one way only.
    const seen: string[] = [];
    registerUndoHandler("test.register", {
      check: () => null,
      undo: async () => {
        seen.push("undo");
      },
      redo: async () => {
        seen.push("redo");
      },
    });
    const stack = createUndoStore({ storage: fakeStorage(), now: () => 1 });
    stack.push({ kind: "test.register" });
    expect(await stack.undo()).toEqual({ ok: true });
    expect(await stack.redo()).toEqual({ ok: true });
    expect(seen).toEqual(["undo", "redo"]);
  });
});
