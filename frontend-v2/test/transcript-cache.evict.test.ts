/**
 * EVICTION READS TWO NUMBERS, NOT EVERY TRANSCRIPT.
 *
 * `cache.save` ends by asking the backend which sessions are held, so it can
 * drop the least recently touched once there are more than MAX_CACHED_SESSIONS.
 * The IndexedDB backend answered that with `getAll()`: every record in the
 * store, deserialised on the main thread, up to MAX_EVENTS_PER_SESSION events
 * per session across as many sessions as are cached, to read `session` and
 * `touchedAt`. That ran on every idle-scheduled write, which is every time a
 * transcript grows.
 *
 * What is pinned here is the cheap answer and the two things it must not
 * change: the victims are the same ones, and a database written before the
 * index existed still reads back whole.
 *
 * jsdom ships no IndexedDB and this package carries no fake for it, so the fake
 * below IS the fixture: a store, an index, a key cursor, and a count of how
 * many record VALUES it has handed out, which is the number this change is
 * about. It models the one piece of real IndexedDB behaviour the upgrade rests
 * on: an index created inside a versionchange transaction is populated from the
 * records already in the store.
 */
import { describe, it, expect, afterEach, onTestFinished } from "vitest";
import type { Event } from "../src/types/events";
import {
  MAX_CACHED_SESSIONS,
  closeSharedTranscriptDb,
  createTranscriptCache,
  evictionList,
  sharedIndexedDbBackend,
  type CacheBackend,
  type CacheRecord,
} from "../src/store/transcript-cache";

const ev = (id: number): Event => ({ session: "s", id, kind: "text", body: "x" });

const rec = (session: string, touchedAt: number): CacheRecord => ({
  session,
  touchedAt,
  epoch: "epoch-a",
  events: [ev(1), ev(2)],
});

// ---- the fake ------------------------------------------------------------

/** What the fake holds between opens, so a v1 database can meet v2 code. */
interface Disk {
  version: number;
  /** Absent until some version creates the object store, as a real one is. */
  rows?: Map<string, CacheRecord>;
  indexes: Set<string>;
  /** Record values handed out. Eviction must add nothing to this. */
  valuesRead: number;
  /** Every store call, in order, so a test can say `getAll` was not one. */
  ops: string[];
  /** Block the first open, the way another tab holding an older version does. */
  blockFirstOpen: boolean;
}

const emptyDisk = (over: Partial<Disk> = {}): Disk => ({
  version: 0,
  indexes: new Set(),
  valuesRead: 0,
  ops: [],
  blockFirstOpen: false,
  ...over,
});

/** A request that answers once, on the next microtask. */
function once<T>(result: T): IDBRequest<T> {
  const r = { onsuccess: null, onerror: null, result } as unknown as IDBRequest<T> & {
    onsuccess: ((ev: Event_) => void) | null;
  };
  queueMicrotask(() => r.onsuccess?.(new globalThis.Event("success")));
  return r;
}
type Event_ = globalThis.Event;

/** A key cursor: index key and primary key per step, and no record value. */
function keyCursor(
  entries: ReadonlyArray<{ key: number; primaryKey: string }>,
): IDBRequest<IDBCursor | null> {
  const r = { onsuccess: null, onerror: null, result: null } as unknown as {
    onsuccess: ((ev: Event_) => void) | null;
    result: unknown;
  };
  let i = 0;
  const step = (): void => {
    queueMicrotask(() => {
      const entry = entries[i++];
      r.result = entry ? { ...entry, continue: step } : null;
      r.onsuccess?.(new globalThis.Event("success"));
    });
  };
  step();
  return r as unknown as IDBRequest<IDBCursor | null>;
}

/**
 * Install a fake `indexedDB` over `disk` and hand back the shared backend.
 *
 * The backend is a module singleton, so every test in this file installs its
 * fake BEFORE asking for it and the afterEach below closes the handle; the next
 * open then lands on the next test's disk.
 */
function withFakeIdb(disk: Disk): CacheBackend {
  const rowsOf = (): Map<string, CacheRecord> => {
    if (!disk.rows) disk.rows = new Map();
    return disk.rows;
  };

  const storeFor = (): IDBObjectStore => {
    const store = {
      indexNames: { contains: (n: string) => disk.indexes.has(n) },
      createIndex: (name: string) => {
        // A real index created in a versionchange transaction is built over the
        // records already in the store. That is the whole upgrade story, so the
        // fake has to have it: nothing is re-written, and every old record is
        // visible through the index immediately.
        disk.ops.push(`createIndex:${name}`);
        disk.indexes.add(name);
        return {} as IDBIndex;
      },
      get: (key: string) => {
        disk.ops.push(`get:${key}`);
        disk.valuesRead++;
        return once<CacheRecord | undefined>(rowsOf().get(key));
      },
      getAll: () => {
        disk.ops.push("getAll");
        disk.valuesRead += rowsOf().size;
        return once([...rowsOf().values()]);
      },
      put: (record: CacheRecord) => {
        disk.ops.push(`put:${record.session}`);
        rowsOf().set(record.session, record);
        return once(record.session);
      },
      delete: (key: string) => {
        disk.ops.push(`delete:${key}`);
        rowsOf().delete(key);
        return once(undefined);
      },
      index: (name: string) => {
        if (!disk.indexes.has(name)) throw new Error(`NotFoundError: no index ${name}`);
        return {
          openKeyCursor: () => {
            disk.ops.push(`keyCursor:${name}`);
            // Index order: by key, then by primary key. That is what a real
            // cursor walks, and what decides ties.
            const entries = [...rowsOf().values()]
              .map((r) => ({ key: r.touchedAt, primaryKey: r.session }))
              .sort((a, b) => a.key - b.key || a.primaryKey.localeCompare(b.primaryKey));
            return keyCursor(entries);
          },
        } as unknown as IDBIndex;
      },
    };
    return store as unknown as IDBObjectStore;
  };

  const database = {
    close: () => disk.ops.push("close"),
    objectStoreNames: { contains: () => disk.rows !== undefined },
    createObjectStore: () => {
      disk.ops.push("createObjectStore");
      rowsOf();
      return storeFor();
    },
    transaction: () => ({ objectStore: storeFor, onabort: null, error: null }),
  };

  let blocked = disk.blockFirstOpen;
  const idb = {
    open(_name: string, version: number) {
      const r = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        result: database,
        transaction: { objectStore: storeFor },
      } as unknown as IDBOpenDBRequest & {
        onsuccess: ((ev: Event_) => void) | null;
        onblocked: ((ev: Event_) => void) | null;
        onupgradeneeded: ((ev: Event_) => void) | null;
      };
      queueMicrotask(() => {
        if (blocked) {
          blocked = false;
          disk.ops.push("blocked");
          r.onblocked?.(new globalThis.Event("blocked"));
          return;
        }
        if (version > disk.version) {
          disk.version = version;
          r.onupgradeneeded?.(new globalThis.Event("upgradeneeded"));
        }
        r.onsuccess?.(new globalThis.Event("success"));
      });
      return r;
    },
  };

  const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { value: idb, configurable: true });
  onTestFinished(() => {
    if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  const backend = sharedIndexedDbBackend();
  if (!backend) throw new Error("the fake was installed too late to be seen");
  return backend;
}

afterEach(async () => {
  // Drops the memoised handle, so the next test's fake is what the next open
  // finds. Without this the second test in the file writes to the first's disk.
  await closeSharedTranscriptDb();
});

// ---- the tests -----------------------------------------------------------

describe("eviction reads two fields, not the transcripts", () => {
  it("answers `which sessions are held` without deserialising one record", async () => {
    const disk = emptyDisk();
    const backend = withFakeIdb(disk);
    await backend.write(rec("a", 30));
    await backend.write(rec("b", 10));
    await backend.write(rec("c", 20));

    const before = disk.valuesRead;
    const held = await backend.list();

    expect([...held].sort((x, y) => x.touchedAt - y.touchedAt)).toEqual([
      { session: "b", touchedAt: 10 },
      { session: "c", touchedAt: 20 },
      { session: "a", touchedAt: 30 },
    ]);
    // The measurement this change exists for: the events stayed on disk.
    expect(disk.valuesRead).toBe(before);
    expect(disk.ops).not.toContain("getAll");
  });

  it("picks the same victims a whole-store read picked", async () => {
    // The only thing the index changes is the ORDER the entries arrive in:
    // `getAll` gave primary-key order, a cursor gives touchedAt order. Ties
    // decide whether that can move a victim, so they are what this compares.
    const rows = [
      { session: "a", touchedAt: 5 },
      { session: "b", touchedAt: 5 },
      { session: "c", touchedAt: 1 },
      { session: "d", touchedAt: 9 },
      { session: "e", touchedAt: 1 },
    ];
    const byPrimaryKey = [...rows].sort((x, y) => x.session.localeCompare(y.session));
    const byIndex = [...rows].sort(
      (x, y) => x.touchedAt - y.touchedAt || x.session.localeCompare(y.session),
    );
    for (const max of [1, 2, 3, 4, 5, 6]) {
      expect(evictionList(byIndex, "d", max)).toEqual(evictionList(byPrimaryKey, "d", max));
    }
  });

  it("still holds the cap, and still drops the oldest first", async () => {
    const disk = emptyDisk();
    const backend = withFakeIdb(disk);
    let clock = 0;
    const cache = createTranscriptCache(backend, () => ++clock);
    for (let i = 0; i < MAX_CACHED_SESSIONS + 3; i++) {
      await cache.save(`s${i}`, "epoch-a", [ev(1)]);
    }
    expect(disk.rows?.size).toBeLessThanOrEqual(MAX_CACHED_SESSIONS);
    expect(disk.rows?.has("s0")).toBe(false);
    expect(disk.rows?.has("s1")).toBe(false);
    expect(disk.rows?.has(`s${MAX_CACHED_SESSIONS + 2}`)).toBe(true);
  });
});

describe("a database written before the index existed", () => {
  /** What the old code left on disk: version 1, records, no index. */
  const oldDisk = (): Disk =>
    emptyDisk({
      version: 1,
      rows: new Map(
        Array.from({ length: MAX_CACHED_SESSIONS }, (_, i) => [`old${i}`, rec(`old${i}`, 100 + i)]),
      ),
    });

  it("is upgraded in place, keeping every record it already held", async () => {
    const disk = oldDisk();
    const backend = withFakeIdb(disk);

    const held = await backend.list();
    expect(held).toHaveLength(MAX_CACHED_SESSIONS);
    expect(disk.ops).toContain("createIndex:by-touchedAt");
    // Upgrading must not have rewritten or dropped a transcript.
    expect(await backend.read("old0")).toEqual(rec("old0", 100));
    expect(disk.rows?.size).toBe(MAX_CACHED_SESSIONS);
  });

  it("evicts records it did not write itself", async () => {
    // The failure this rules out: records that predate the index are invisible
    // to the cursor, so the store grows past its cap and nothing is ever
    // dropped.
    const disk = oldDisk();
    const backend = withFakeIdb(disk);
    const cache = createTranscriptCache(backend, () => 9_000);
    await cache.save("fresh", "epoch-a", [ev(1)]);

    expect(disk.rows?.has("old0")).toBe(false); // touchedAt 100, the oldest
    expect(disk.rows?.has("fresh")).toBe(true);
    expect(disk.rows?.size).toBe(MAX_CACHED_SESSIONS);
  });
});

describe("an open that was blocked", () => {
  it("is retried rather than remembered for the life of the tab", async () => {
    // Asking for a new version is what makes `blocked` reachable in ordinary
    // use: another tab still running the old code holds version 1 open. The
    // first attempt fails and must fail soft; what must not happen is the
    // failure being memoised, which would leave the cache dead until reload
    // even after that tab goes away.
    const disk = emptyDisk({ blockFirstOpen: true });
    const backend = withFakeIdb(disk);

    await expect(backend.read("a")).rejects.toThrow(/blocked/);
    await expect(backend.read("a")).resolves.toBeNull();

    await backend.write(rec("a", 1));
    expect(await backend.read("a")).toEqual(rec("a", 1));
  });
});
