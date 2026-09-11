/**
 * Client-side transcript cache — so opening a session you have already read
 * costs the difference, not the window.
 *
 * WHAT IT SAVES. A fresh open replays session-events' window: measured 766,661
 * to 2,098,703 bytes per session, 99.93% of it arriving inside 0.1 s as one
 * backlog dump (233,472 B once gzipped, 24,576 B on the slow tier). Nothing was
 * held between opens — the session store is memory-only — so the same bytes
 * arrived every time. With the events on disk, the stream resumes from the
 * highest id held and sends only what happened since.
 *
 * WHY IT IS SAFE TO RESUME. The protocol already answers "are these ids still
 * yours": the server names the log in its `ready` frame (`epoch`), and the SSE
 * client already resyncs when that name changes or when the server's head is
 * behind the cursor (`foreignLog`). This cache stores the epoch beside the
 * events and hands both to the client, so a rewritten, compacted or restored
 * transcript takes the path that already exists — drop everything, open from the
 * start — rather than rendering ids that mean something else now.
 *
 * WHY THE BACKEND IS INJECTED. jsdom has no IndexedDB, and adding a fake one as
 * a dependency to test our own arithmetic is the wrong trade. The policy here —
 * what to keep, what to evict, where to resume — is pure and tested against an
 * in-memory backend; `indexedDbBackend()` is the thin adapter that puts it on
 * disk, and it is the only part a browser is needed to exercise.
 */
import type { Event } from "../types/events";

/** Newest events kept per session. A turn is a handful of events, so this is
 *  hundreds of turns — far more than anyone scrolls back through in one sitting,
 *  and /earlier still reaches the rest. */
export const MAX_EVENTS_PER_SESSION = 2_000;
/** Sessions kept at once, evicted least-recently-opened first. Viktor runs ~9
 *  live sessions; this leaves room without unbounded growth on a phone, where
 *  the browser evicts whole origins under pressure. */
export const MAX_CACHED_SESSIONS = 12;

export interface CachedTranscript {
  /** Oldest-first, exactly as the store wants them. */
  readonly events: readonly Event[];
  /** Which log these ids belong to — the server's `ready.epoch`. */
  readonly epoch: string;
}

/** One session's slot as the backend holds it. */
export interface CacheRecord extends CachedTranscript {
  readonly session: string;
  /** For eviction: when this session was last opened or written. */
  readonly touchedAt: number;
}

/**
 * The storage this needs, and nothing more. Deliberately tiny: a whole-record
 * read and write per session rather than per-event keys, because a transcript is
 * read all at once and written in batches, and one record is one transaction.
 */
export interface CacheBackend {
  read(session: string): Promise<CacheRecord | null>;
  write(record: CacheRecord): Promise<void>;
  remove(session: string): Promise<void>;
  /**
   * Every session held, for eviction. Order is not guaranteed.
   *
   * Two fields, and an implementation may not read a transcript to answer it:
   * this runs on every save, and the events it would have to deserialise are
   * the largest thing the cache holds. The IndexedDB backend answers it from an
   * index for exactly that reason.
   */
  list(): Promise<ReadonlyArray<{ session: string; touchedAt: number }>>;
  /**
   * Release whatever handle the backend holds. `deleteDatabase` blocks
   * indefinitely on an open connection, so "clear local data" has to be able to
   * let go before it deletes. Reopening is lazy, so a backend closed while the
   * page lives keeps working.
   */
  close(): Promise<void>;
}

/** Keep the newest slice; the oldest fall off the front. */
export function trimToCap(
  events: readonly Event[],
  cap: number = MAX_EVENTS_PER_SESSION,
): readonly Event[] {
  return events.length <= cap ? events : events.slice(events.length - cap);
}

/**
 * Merge what arrived into what was held, by id, oldest first.
 *
 * Ids are unique and monotonic per log, so this is a merge rather than a
 * concatenation: a resume overlaps by design (the server may replay the cursor
 * event itself), and a live event can arrive while a window is still landing.
 */
export function mergeEvents(
  held: readonly Event[],
  arrived: readonly Event[],
): readonly Event[] {
  if (arrived.length === 0) return held;
  const byId = new Map<number, Event>();
  for (const e of held) byId.set(e.id, e);
  for (const e of arrived) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Where to resume from, given what is held.
 *
 * The highest id — not one less, and not a few less. The server's replay is
 * exclusive of the cursor and the client dedupes by id anyway, so an overlap
 * buys nothing that `epoch` does not already prove.
 */
export function resumeCursor(events: readonly Event[]): number {
  let max = 0;
  for (const e of events) if (e.id > max) max = e.id;
  return max;
}

/** Which sessions to evict so at most `max` remain, least-recently-touched first. */
export function evictionList(
  entries: ReadonlyArray<{ session: string; touchedAt: number }>,
  keep: string,
  max: number = MAX_CACHED_SESSIONS,
): readonly string[] {
  const others = entries.filter((e) => e.session !== keep);
  if (others.length + 1 <= max) return [];
  const sorted = [...others].sort((a, b) => a.touchedAt - b.touchedAt);
  return sorted.slice(0, others.length + 1 - max).map((e) => e.session);
}

/**
 * A cache over one backend. Every method fails soft: a browser that refuses
 * storage, a quota that is full, a partitioned context — none of them may cost
 * the transcript, which still arrives over the stream exactly as it always did.
 */
export function createTranscriptCache(backend: CacheBackend | null, now: () => number = Date.now) {
  const read = async (session: string): Promise<CachedTranscript | null> => {
    if (!backend) return null;
    try {
      const rec = await backend.read(session);
      if (!rec || rec.events.length === 0 || !rec.epoch) return null;
      return { events: rec.events, epoch: rec.epoch };
    } catch {
      return null;
    }
  };

  const save = async (
    session: string,
    epoch: string,
    events: readonly Event[],
  ): Promise<void> => {
    if (!backend || !epoch || events.length === 0) return;
    try {
      await backend.write({
        session,
        epoch,
        events: trimToCap(events),
        touchedAt: now(),
      });
      const entries = await backend.list();
      for (const victim of evictionList(entries, session)) {
        await backend.remove(victim);
      }
    } catch {
      // A failed write means the next open pays what every open used to pay.
      // Dropping this session's slot keeps a half-written one from being read
      // back as authoritative.
      try {
        await backend.remove(session);
      } catch {
        /* nothing further to try */
      }
    }
  };

  const drop = async (session: string): Promise<void> => {
    if (!backend) return;
    try {
      await backend.remove(session);
    } catch {
      /* a stale slot is corrected by the epoch check on the next open */
    }
  };

  /** Whether anything is actually stored. False where IndexedDB is absent (a
   *  private window, a partitioned context), and the caller then behaves exactly
   *  as it did before this cache existed — including opening its stream
   *  synchronously, with no read to wait for. */
  const enabled = backend !== null;

  return { read, save, drop, enabled };
}

export type TranscriptCache = ReturnType<typeof createTranscriptCache>;

const DB_NAME = "tl-transcripts";
/** v2 adds `by-touchedAt`. A v1 database written by the version that had no
 *  index is upgraded on the next open, where IndexedDB builds the index over
 *  the records already there. No migration, and nothing rewritten. */
const DB_VERSION = 2;
const STORE = "sessions";
/** Eviction's whole read: `touchedAt` as the index key, `session` as the
 *  primary key it carries. */
const TOUCHED_INDEX = "by-touchedAt";

/**
 * The IndexedDB adapter. Returns null wherever IndexedDB is unavailable or
 * refuses to open, which the cache above treats as "no cache" rather than as an
 * error — this is an optimisation, and it is never allowed to be a dependency.
 *
 * Module-private on purpose. Every caller goes through sharedIndexedDbBackend()
 * below, because a second handle on the same database would keep
 * clearLocalData's delete blocked.
 */
function indexedDbBackend(): CacheBackend | null {
  if (typeof indexedDB === "undefined") return null;

  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    let abandoned = false;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        const store = database.objectStoreNames.contains(STORE)
          ? req.transaction?.objectStore(STORE)
          : database.createObjectStore(STORE, { keyPath: "session" });
        if (store && !store.indexNames.contains(TOUCHED_INDEX)) {
          store.createIndex(TOUCHED_INDEX, "touchedAt");
        }
      };
      req.onsuccess = () => {
        // A blocked open was REJECTED, not cancelled: the request stays live
        // and completes if the other connection ever lets go. Nothing is
        // waiting on it by then, and a handle nobody holds is exactly what
        // blocks the next `deleteDatabase`, which close() exists to allow.
        if (abandoned) req.result.close();
        else resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // Another tab holds an older version of this database open, so the
        // upgrade cannot start. Asking for v2 is what makes this reachable in
        // ordinary use: a tab still running the version with no index holds v1
        // until it is closed or reloaded.
        abandoned = true;
        reject(new Error("indexedDB open blocked"));
      };
    });
    // A failed open is not remembered. Memoising the rejected promise would
    // leave this tab with no cache for as long as it lives, including long
    // after whatever blocked the upgrade has gone.
    attempt.catch(() => {
      if (opening === attempt) opening = null;
    });
    opening = attempt;
    return attempt;
  };

  const tx = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const t = database.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      t.onabort = () => reject(t.error);
    });
  };

  return {
    read: (session) =>
      tx<CacheRecord | undefined>("readonly", (s) => s.get(session)).then((r) => r ?? null),
    write: (record) => tx("readwrite", (s) => s.put(record)).then(() => undefined),
    remove: (session) => tx("readwrite", (s) => s.delete(session)).then(() => undefined),
    /**
     * Eviction's read, and the cheapest one IndexedDB offers: a KEY cursor over
     * `by-touchedAt`. Each step carries the index key (touchedAt) and the
     * primary key (session) and materialises no record, so the transcripts stay
     * on disk where they belong.
     *
     * `getAll()` stood here, which deserialised every cached event, up to
     * MAX_EVENTS_PER_SESSION per session across every cached session, on the
     * main thread, on every idle-scheduled save, to read two numbers.
     *
     * Entries now arrive oldest-first rather than in primary-key order.
     * `evictionList` sorts by `touchedAt` itself, and a tie between two equal
     * timestamps resolves by primary key either way, so the victims are the
     * same ones. The conversions are identity: the index key IS `touchedAt` and
     * the primary key IS `session`.
     */
    list: async () => {
      const database = await db();
      return new Promise<ReadonlyArray<{ session: string; touchedAt: number }>>(
        (resolve, reject) => {
          const t = database.transaction(STORE, "readonly");
          const held: { session: string; touchedAt: number }[] = [];
          const req = t.objectStore(STORE).index(TOUCHED_INDEX).openKeyCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(held);
              return;
            }
            held.push({ session: String(cursor.primaryKey), touchedAt: Number(cursor.key) });
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
          t.onabort = () => reject(t.error);
        },
      );
    },
    close: async () => {
      const pending = opening;
      // Dropped BEFORE the await, so a read racing the close reopens rather
      // than picking the handle that is about to go.
      opening = null;
      if (!pending) return;
      try {
        (await pending).close();
      } catch {
        /* an open that never succeeded holds nothing to close */
      }
    },
  };
}

/**
 * The tab's one transcript backend.
 *
 * It is a module singleton because the handle has to be reachable from
 * somewhere other than the session store: `clearLocalData` in device-prefs.ts
 * deletes `tl-transcripts`, and IndexedDB will not delete a database anything
 * still holds open.
 */
let sharedBackend: CacheBackend | null | undefined;

export function sharedIndexedDbBackend(): CacheBackend | null {
  if (sharedBackend === undefined) sharedBackend = indexedDbBackend();
  return sharedBackend;
}

/** Let go of the transcript database, if this tab ever opened it. Deliberately
 *  does NOT create a backend just to close it. */
export async function closeSharedTranscriptDb(): Promise<void> {
  await sharedBackend?.close();
}
