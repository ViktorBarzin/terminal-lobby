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
  /** Every session held, for eviction. Order is not guaranteed. */
  list(): Promise<ReadonlyArray<{ session: string; touchedAt: number }>>;
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
const DB_VERSION = 1;
const STORE = "sessions";

/**
 * The IndexedDB adapter. Returns null wherever IndexedDB is unavailable or
 * refuses to open, which the cache above treats as "no cache" rather than as an
 * error — this is an optimisation, and it is never allowed to be a dependency.
 */
export function indexedDbBackend(): CacheBackend | null {
  if (typeof indexedDB === "undefined") return null;

  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: "session" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
    return opening;
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
    list: () =>
      tx<CacheRecord[]>("readonly", (s) => s.getAll() as IDBRequest<CacheRecord[]>).then((all) =>
        all.map((r) => ({ session: r.session, touchedAt: r.touchedAt })),
      ),
  };
}
