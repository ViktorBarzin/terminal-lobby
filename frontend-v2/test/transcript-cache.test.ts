/**
 * The transcript cache: opening a session you have already read should cost the
 * difference, not the window.
 *
 * A fresh open replays session-events' window — measured 766,661 to 2,098,703
 * bytes per session, 99.93% of it inside 0.1 s as one dump — and nothing was
 * held between opens, so the same bytes arrived every time. The risk this has to
 * answer is not size but IDENTITY: ids only mean something within one log, and a
 * transcript can be rewritten. The server names the log in its `ready` frame, so
 * the epoch is stored beside the events and the existing resync path handles the
 * rest.
 *
 * The backend is injected because jsdom has no IndexedDB, and the policy — what
 * to keep, what to evict, where to resume — is what needs testing.
 */
import { describe, it, expect, onTestFinished, vi } from "vitest";
import { createStore, unwrap } from "solid-js/store";
import type { Event } from "../src/types/events";
import {
  MAX_CACHED_SESSIONS,
  MAX_EVENTS_PER_SESSION,
  createTranscriptCache,
  evictionList,
  mergeEvents,
  resumeCursor,
  trimToCap,
  type CacheBackend,
  type CacheRecord,
} from "../src/store/transcript-cache";

const ev = (id: number, body = "x"): Event => ({ session: "s", id, kind: "text", body });

function memoryBackend(): CacheBackend & { records: Map<string, CacheRecord> } {
  const records = new Map<string, CacheRecord>();
  return {
    records,
    read: async (session) => records.get(session) ?? null,
    write: async (record) => void records.set(record.session, record),
    remove: async (session) => void records.delete(session),
    list: async () =>
      [...records.values()].map((r) => ({ session: r.session, touchedAt: r.touchedAt })),
    close: async () => {},
  };
}

/**
 * IndexedDB's one constraint, without IndexedDB: a record is structured-cloned
 * on the way in, and a value that cannot be cloned throws DataCloneError.
 *
 * jsdom has no IndexedDB and fake-indexeddb is not a dependency here, so this
 * is as close to the real backend as a unit test gets — and it is the half that
 * mattered. The in-memory backend above stores anything handed to it, including
 * a Solid store proxy, which is how a cache that never wrote a single record
 * kept a green suite from 2026-08-28 to 2026-09-11.
 */
function cloningBackend(): CacheBackend & { records: Map<string, CacheRecord> } {
  const records = new Map<string, CacheRecord>();
  return {
    records,
    read: async (session) => {
      const rec = records.get(session);
      return rec ? structuredClone(rec) : null;
    },
    write: async (record) => void records.set(record.session, structuredClone(record)),
    remove: async (session) => void records.delete(session),
    list: async () =>
      [...records.values()].map((r) => ({ session: r.session, touchedAt: r.touchedAt })),
    close: async () => {},
  };
}

describe("transcript cache — the arithmetic", () => {
  it("keeps the newest slice at the cap", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_SESSION + 50 }, (_, i) => ev(i + 1));
    const kept = trimToCap(events);
    expect(kept).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(kept[kept.length - 1]!.id).toBe(events[events.length - 1]!.id);
    expect(kept[0]!.id).toBe(51);
  });

  it("merges by id rather than concatenating", () => {
    // A resume overlaps by design, and a live event can land while a window is
    // still arriving.
    const merged = mergeEvents([ev(1), ev(2), ev(3)], [ev(3, "newer"), ev(4)]);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(merged.find((e) => e.id === 3)!.body).toBe("newer");
  });

  it("resumes from the highest id held", () => {
    expect(resumeCursor([ev(4), ev(9), ev(7)])).toBe(9);
    expect(resumeCursor([])).toBe(0);
  });

  it("evicts least-recently-touched, and never the session being opened", () => {
    const entries = Array.from({ length: MAX_CACHED_SESSIONS + 2 }, (_, i) => ({
      session: `s${i}`,
      touchedAt: i, // s0 oldest
    }));
    const victims = evictionList(entries, "s5");
    expect(victims).toContain("s0");
    expect(victims).not.toContain("s5");
    expect(entries.length - victims.length).toBeLessThanOrEqual(MAX_CACHED_SESSIONS);
  });

  it("evicts nothing while there is room", () => {
    expect(evictionList([{ session: "a", touchedAt: 1 }], "b")).toEqual([]);
  });
});

describe("transcript cache — reading and writing", () => {
  it("round-trips events with the epoch they belong to", async () => {
    const backend = memoryBackend();
    const cache = createTranscriptCache(backend, () => 1000);
    await cache.save("main", "epoch-a", [ev(1), ev(2)]);
    expect(await cache.read("main")).toEqual({ events: [ev(1), ev(2)], epoch: "epoch-a" });
  });

  it("refuses to store events with no epoch", async () => {
    // Without the log's name there is no way to tell later whether the ids still
    // mean anything, and rendering ids from another log is worse than refetching.
    const backend = memoryBackend();
    const cache = createTranscriptCache(backend, () => 1);
    await cache.save("main", "", [ev(1)]);
    expect(backend.records.size).toBe(0);
    expect(await cache.read("main")).toBeNull();
  });

  it("reads nothing back from an empty or epoch-less record", async () => {
    const backend = memoryBackend();
    backend.records.set("main", { session: "main", epoch: "", events: [ev(1)], touchedAt: 1 });
    expect(await createTranscriptCache(backend).read("main")).toBeNull();
    backend.records.set("main", { session: "main", epoch: "e", events: [], touchedAt: 1 });
    expect(await createTranscriptCache(backend).read("main")).toBeNull();
  });

  it("drops a session on request", async () => {
    const backend = memoryBackend();
    const cache = createTranscriptCache(backend, () => 1);
    await cache.save("main", "e", [ev(1)]);
    await cache.drop("main");
    expect(await cache.read("main")).toBeNull();
  });

  it("keeps the cap when saving more than it holds", async () => {
    const backend = memoryBackend();
    const cache = createTranscriptCache(backend, () => 1);
    const events = Array.from({ length: MAX_EVENTS_PER_SESSION + 10 }, (_, i) => ev(i + 1));
    await cache.save("main", "e", events);
    expect(backend.records.get("main")!.events).toHaveLength(MAX_EVENTS_PER_SESSION);
  });

  it("is a no-op, not a failure, with no backend at all", async () => {
    // No IndexedDB (a private window, a partitioned context) must cost the
    // optimisation and nothing else.
    const cache = createTranscriptCache(null);
    await expect(cache.save("main", "e", [ev(1)])).resolves.toBeUndefined();
    await expect(cache.read("main")).resolves.toBeNull();
    await expect(cache.drop("main")).resolves.toBeUndefined();
  });

  it("drops the slot when a write fails, rather than leaving half of one", async () => {
    // A full quota mid-write would otherwise leave a record that reads back as
    // authoritative while missing the events that did not fit.
    const backend = memoryBackend();
    const removed: string[] = [];
    const failing: CacheBackend = {
      ...backend,
      write: async () => {
        throw new Error("QuotaExceededError");
      },
      remove: async (s) => void removed.push(s),
    };
    const cache = createTranscriptCache(failing, () => 1);
    await cache.save("main", "e", [ev(1)]);
    expect(removed).toEqual(["main"]);
  });

  it("survives a backend that throws on every call", async () => {
    const hostile: CacheBackend = {
      read: async () => {
        throw new Error("nope");
      },
      write: async () => {
        throw new Error("nope");
      },
      remove: async () => {
        throw new Error("nope");
      },
      list: async () => {
        throw new Error("nope");
      },
      close: async () => {
        throw new Error("nope");
      },
    };
    const cache = createTranscriptCache(hostile);
    await expect(cache.read("main")).resolves.toBeNull();
    await expect(cache.save("main", "e", [ev(1)])).resolves.toBeUndefined();
    await expect(cache.drop("main")).resolves.toBeUndefined();
  });

  it("evicts the oldest session when a new one is saved past the limit", async () => {
    const backend = memoryBackend();
    let clock = 0;
    const cache = createTranscriptCache(backend, () => ++clock);
    for (let i = 0; i < MAX_CACHED_SESSIONS + 3; i++) {
      await cache.save(`s${i}`, "e", [ev(1)]);
    }
    expect(backend.records.size).toBeLessThanOrEqual(MAX_CACHED_SESSIONS);
    expect(backend.records.has("s0")).toBe(false);
    expect(backend.records.has(`s${MAX_CACHED_SESSIONS + 2}`)).toBe(true);
  });
});

/**
 * The transcript the session store actually holds is a Solid store, and a store
 * is a Proxy. IndexedDB cannot structured-clone one, so every write threw
 * DataCloneError into `save`'s catch, the slot was dropped, and text opens paid
 * 220 to 660 ms for a cache that had never written a record. Observed live on
 * 2/2 opens on 2026-09-11; see ADR-0026.
 */
describe("transcript cache — a Solid store is what actually gets saved", () => {
  const storeOf = (count: number): readonly Event[] => {
    const [events] = createStore<Event[]>(Array.from({ length: count }, (_, i) => ev(i + 1)));
    return events;
  };

  /** Both sides of the cap: under it the array is passed through, over it the
   *  slice branch runs, and a slice of a store is a plain array of PROXIES. */
  const sizes: ReadonlyArray<[string, number, number]> = [
    ["below the cap", 3, 3],
    ["above the cap", MAX_EVENTS_PER_SESSION + 10, MAX_EVENTS_PER_SESSION],
  ];

  it.each(sizes)("hands the backend a cloneable record, %s", async (_name, count, kept) => {
    const written: CacheRecord[] = [];
    const backend: CacheBackend = {
      ...memoryBackend(),
      write: async (record) => void written.push(record),
    };
    await createTranscriptCache(backend, () => 7).save("main", "e", storeOf(count));

    const record = written[0];
    expect(record).toBeDefined();
    // The assertion the shipped code fails: this is exactly what IndexedDB does
    // to a record before it stores it.
    expect(() => structuredClone(record)).not.toThrow();
    expect(record!.events).toHaveLength(kept);
    expect(record!.events[kept - 1]!.id).toBe(count);
  });

  it.each(sizes)("round-trips through a cloning backend, %s", async (_name, count, kept) => {
    const backend = cloningBackend();
    const cache = createTranscriptCache(backend, () => 7);
    await cache.save("main", "epoch-a", storeOf(count));

    // A throw inside write() lands in save()'s catch, which DROPS the slot — so
    // a record that reads back at all is the whole proof.
    const held = await cache.read("main");
    expect(held?.epoch).toBe("epoch-a");
    expect(held?.events).toHaveLength(kept);
    expect(held?.events[kept - 1]!.id).toBe(count);
  });

  it("is unwrap() that fixes it, not slice()", () => {
    // Measured with vitest on 2026-09-11 and kept as a test because the cheap
    // fix looks like it should work: reading an index of a store returns a
    // proxied ELEMENT, so `slice(0)` is a plain array full of proxies and fails
    // the same way the store itself does.
    const events = storeOf(3);
    expect(() => structuredClone(events)).toThrow();
    expect(() => structuredClone(events.slice(0))).toThrow();
    expect(() => structuredClone(unwrap(events))).not.toThrow();
  });

  it("leaves a plain array alone", () => {
    // Nothing else changes shape: the same call on a non-store transcript is
    // identity, which is what every existing test above is asserting.
    const plain = [ev(1), ev(2)];
    const backend = cloningBackend();
    return createTranscriptCache(backend, () => 7)
      .save("main", "e", plain)
      .then(async () => {
        expect(await backend.read("main")).toEqual({
          session: "main",
          epoch: "e",
          events: plain,
          touchedAt: 7,
        });
      });
  });
});

/**
 * The IndexedDB adapter's schema, which is where eviction's cost lives.
 *
 * `save()` sweeps after every successful write, and a save runs once per idle
 * window for as long as a turn is streaming. At v1 that sweep was `getAll()`,
 * which materialises every CacheRecord — 12 sessions x 2,000 events of them,
 * 18 MB deserialised in 81 to 171 ms on the devvm — to read two scalars per
 * session. It never showed up because it never ran:
 * every write threw DataCloneError on the store proxy first, so the sweep was
 * unreachable until the unwrap above made writes succeed.
 *
 * jsdom has no IndexedDB and fake-indexeddb is not a dependency, so the fake is
 * hand-rolled — which is also what lets it RECORD what the adapter asked for.
 * The assertion that carries the weight here is not what came back; it is that
 * `getAll` was never among the calls.
 */
describe("the IndexedDB adapter — eviction reads the index, not the transcripts", () => {
  const rec = (session: string, touchedAt: number): CacheRecord => ({
    session,
    epoch: "e",
    events: [ev(1), ev(2)],
    touchedAt,
  });

  interface FakeIdb {
    /** Every store or index method the adapter reached for, in order. */
    calls: string[];
    /** What the store holds, so eviction can be checked end to end. */
    records: Map<string, CacheRecord>;
    /** The version asked for on each `open`. */
    opens: number[];
    closes(): number;
    /** Fire what another tab's upgrade fires on this connection. */
    versionChange(): void;
  }

  /** `startAt: 1` is a database written before the index existed. */
  function installFakeIdb(opts: { seed?: readonly CacheRecord[]; startAt?: 0 | 1 } = {}): FakeIdb {
    const records = new Map<string, CacheRecord>();
    for (const r of opts.seed ?? []) records.set(r.session, structuredClone(r));
    const calls: string[] = [];
    const opens: number[] = [];
    const indexes = new Set<string>();
    const state: { version: number; hasStore: boolean; closes: number } = {
      version: opts.startAt ?? 0,
      hasStore: (opts.startAt ?? 0) >= 1,
      closes: 0,
    };

    /** A request that already has its answer; the adapter attaches its handler
     *  before the microtask runs. */
    const settle = <T>(result: T) => {
      const req: { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
        result,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };

    /** Index name -> the key path it was created on, as `createIndex` recorded it. */
    const indexKeyPaths = new Map<string, string>();

    /** Index entries, ascending, exactly as IndexedDB orders them — and with no
     *  record body attached, which is the point of the index. */
    const keyCursor = (indexName: string) => {
      // An index is named independently of the field it is built on, so the
      // cursor reads the KEY PATH that `createIndex` was given, not the index's
      // own name. Reading the name would make every key `undefined` the moment
      // someone renames an index, and the sort below would silently degrade to
      // insertion order while still looking like it worked.
      const keyPath = indexKeyPaths.get(indexName) ?? indexName;
      const entries = [...records.values()]
        .map((r) => ({
          key: (r as unknown as Record<string, number>)[keyPath]!,
          primaryKey: r.session,
        }))
        .sort((a, b) => a.key - b.key);
      const req: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } =
        { result: null, onsuccess: null, onerror: null };
      let i = 0;
      const step = (): void => {
        queueMicrotask(() => {
          const e = entries[i++];
          req.result = e ? { key: e.key, primaryKey: e.primaryKey, continue: step } : null;
          req.onsuccess?.();
        });
      };
      step();
      return req;
    };

    const store = {
      indexNames: { contains: (n: string) => indexes.has(n) },
      createIndex: (name: string, keyPath: string) => {
        calls.push(`createIndex(${name},${keyPath})`);
        indexKeyPaths.set(name, keyPath);
        indexes.add(name);
      },
      get: (session: string) => {
        calls.push("get");
        return settle(records.get(session));
      },
      put: (record: CacheRecord) => {
        calls.push("put");
        records.set(record.session, structuredClone(record));
        return settle(undefined);
      },
      delete: (session: string) => {
        calls.push(`delete(${session})`);
        records.delete(session);
        return settle(undefined);
      },
      getAll: () => {
        calls.push("getAll");
        return settle([...records.values()]);
      },
      index: (name: string) => {
        calls.push(`index(${name})`);
        if (!indexes.has(name)) throw new DOMException(`no index ${name}`, "NotFoundError");
        return { openKeyCursor: () => keyCursor(name) };
      },
    };

    const database = {
      objectStoreNames: { contains: () => state.hasStore },
      createObjectStore: (name: string, o: { keyPath: string }) => {
        calls.push(`createObjectStore(${name},${o.keyPath})`);
        state.hasStore = true;
        return store;
      },
      transaction: () => ({ objectStore: () => store, onabort: null, error: null }),
      close: () => {
        state.closes++;
      },
      onversionchange: null as (() => void) | null,
    };

    const fake = {
      open(_name: string, version: number) {
        opens.push(version);
        const req: {
          result: typeof database;
          transaction: { objectStore: () => typeof store };
          onupgradeneeded: (() => void) | null;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onblocked: (() => void) | null;
        } = {
          result: database,
          transaction: { objectStore: () => store },
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          if (version > state.version) {
            state.version = version;
            req.onupgradeneeded?.();
          }
          req.onsuccess?.();
        });
        return req;
      },
    };

    const prev = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { value: fake, configurable: true });
    onTestFinished(() => {
      if (prev) Object.defineProperty(globalThis, "indexedDB", prev);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    });

    return {
      calls,
      records,
      opens,
      closes: () => state.closes,
      versionChange: () => database.onversionchange?.(),
    };
  }

  /** The backend is a module singleton, so each test needs its own module. */
  async function freshBackend(): Promise<CacheBackend> {
    vi.resetModules();
    const mod = await import("../src/store/transcript-cache");
    const backend = mod.sharedIndexedDbBackend();
    expect(backend).not.toBeNull();
    return backend as CacheBackend;
  }

  it("creates the store with its touchedAt index on a database that never existed", async () => {
    const idb = installFakeIdb();
    await (await freshBackend()).list();
    expect(idb.opens).toEqual([2]);
    expect(idb.calls).toContain("createObjectStore(sessions,session)");
    expect(idb.calls).toContain("createIndex(by-touchedAt,touchedAt)");
  });

  it("adds the index to a v1 database without recreating the store", async () => {
    // The upgrade every existing install takes. The records are what the cache
    // is for, so the one thing it may not do is drop them.
    const idb = installFakeIdb({ startAt: 1, seed: [rec("a", 5), rec("b", 1)] });
    const backend = await freshBackend();
    expect(await backend.list()).toEqual([
      { session: "b", touchedAt: 1 },
      { session: "a", touchedAt: 5 },
    ]);
    expect(idb.calls).toContain("createIndex(by-touchedAt,touchedAt)");
    expect(idb.calls.filter((c) => c.startsWith("createObjectStore"))).toEqual([]);
    expect(idb.records.size).toBe(2);
  });

  it("answers list() from the index, never from getAll()", async () => {
    const idb = installFakeIdb({ seed: [rec("late", 30), rec("early", 10), rec("mid", 20)] });
    const entries = await (await freshBackend()).list();
    expect(entries).toEqual([
      { session: "early", touchedAt: 10 },
      { session: "mid", touchedAt: 20 },
      { session: "late", touchedAt: 30 },
    ]);
    // The finding: `getAll()` deserialises every cached transcript in full to
    // read two scalars per session, on the main thread, after every save.
    expect(idb.calls).toContain("index(by-touchedAt)");
    expect(idb.calls).not.toContain("getAll");
  });

  it("evicts past the cap without reading a single transcript", async () => {
    const seed = Array.from({ length: MAX_CACHED_SESSIONS }, (_, i) => rec(`s${i}`, i + 1));
    const idb = installFakeIdb({ seed });
    const cache = createTranscriptCache(await freshBackend(), () => 9_999);

    await cache.save("fresh", "e", [ev(1)]);

    expect(idb.records.has("fresh")).toBe(true);
    expect(idb.records.has("s0")).toBe(false); // touchedAt 1, the oldest
    expect(idb.records.size).toBe(MAX_CACHED_SESSIONS);
    expect(idb.calls).toContain("delete(s0)");
    expect(idb.calls).not.toContain("getAll");
  });

  it("lets go of its handle when another tab needs a newer version", async () => {
    // An open connection blocks a version change. Holding on would park the
    // upgrading tab on `blocked` and leave this one with the cache off for the
    // rest of its life.
    const idb = installFakeIdb();
    const backend = await freshBackend();
    await backend.list();
    expect(idb.opens).toEqual([2]);

    idb.versionChange();
    expect(idb.closes()).toBe(1);

    await backend.list();
    expect(idb.opens).toEqual([2, 2]);
  });
});
