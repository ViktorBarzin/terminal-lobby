/**
 * The device dimension: one random id per browser installation, stamped on
 * every telemetry event.
 *
 * Why it exists. Events are attributed server-side to a USER and to nothing
 * else, and Viktor uses more than one device. Measured over 7 days of
 * notify.stash_read: acted 51, already 11, untapped 156, stale 201, absent 376,
 * with no way to tell which of those reads belonged to the phone that wrote the
 * stash and which to a laptop that never saw the notification. The tap chain
 * spans two contexts (a service worker writes, a page reads) and several
 * devices, so without an id naming the installation the two halves cannot be
 * joined at all. Six fixes were shipped against that blindness.
 *
 * What it is NOT. The id says which browser installation, not who: the user is
 * already known to the intake, which authenticates the caller. Nothing derived
 * from the person, the hardware or the network goes into it — 16 random bytes,
 * minted once. Clearing site data mints a new one, which is correct: that is a
 * different installation as far as any of this app's local state is concerned.
 *
 * Two readers, two stores. The page keeps it in localStorage. A service worker
 * cannot reach localStorage, and the worker is the only context awake for a
 * notification tap on the cold path, so the same id is mirrored into IndexedDB
 * for it (see mirrorDeviceId).
 */

import { lsGet, lsSet } from "../lib/storage";

/** localStorage key. Versioned, so a future format is a new key rather than a
 *  value that has to be sniffed. */
export const DEVICE_ID_KEY = "tl:device:v1";

/**
 * Where the service worker reads the same id.
 *
 * A database of its own, deliberately NOT the worker's `tl-notif`. That one is
 * opened at version 1 by sw.js; adding a store to it would need a version bump,
 * and the worker's open at v1 would then fail outright, taking the tap stash
 * down with it. `tl-badge` set the same precedent: the page writes, the worker
 * reads, and neither has to know the other's schema version.
 */
export const DEVICE_DB = "tl-device";
/** Object store inside DEVICE_DB. */
export const DEVICE_STORE = "meta";
/** Key inside DEVICE_STORE. The value is the id string itself. */
export const DEVICE_ID_RECORD = "id";

/** The attribute name every event carries. */
export const DEVICE_ATTR = "tl.device";

/** The minted shape: 16 random bytes, lowercase hex. Anything else in the store
 *  is replaced rather than trusted, so a value that arrived some other way can
 *  never travel as though this module had produced it. */
const ID_RE = /^[0-9a-f]{32}$/;

/**
 * Memoised for the life of the page.
 *
 * It matters most in the case it looks least useful: Safari with cookies
 * blocked throws on the `localStorage` getter, `lsSet` swallows that, and
 * without a memo every single event would carry a freshly minted id. A series
 * one event long is worse than no dimension at all.
 */
let memo: string | null = null;

function mintId(): string {
  const bytes = new Uint8Array(16);
  // crypto is present in every browser this app supports and in the worker; the
  // fallback is for a test environment or an insecure context, where the id
  // only has to be unique among this user's own devices.
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * This installation's id, minting and persisting one on first ask.
 *
 * Never throws: `lsGet`/`lsSet` already answer null on a store that is absent,
 * blocked or full, and a refused write costs the id its persistence and nothing
 * else — this page life still reports one stable value.
 */
export function deviceId(): string {
  if (memo !== null) return memo;
  const stored = lsGet(DEVICE_ID_KEY);
  if (stored !== null && ID_RE.test(stored)) {
    memo = stored;
    return memo;
  }
  const fresh = mintId();
  lsSet(DEVICE_ID_KEY, fresh);
  memo = fresh;
  return memo;
}

/**
 * Mirror the id into IndexedDB, where the service worker can read it.
 *
 * Called once on boot from track.ts. The page always runs before any push can
 * arrive (it is the page that registers the worker and subscribes), so by the
 * time a notification is tapped the record is there. A worker that finds it
 * missing reports its events without the attribute rather than minting a second
 * id, which would split one device into two series.
 *
 * Best-effort throughout, and it resolves on EVERY path. A transaction can fire
 * `abort` with no preceding `error` under storage pressure, and a promise with
 * no abort handler stays pending forever.
 */
export function mirrorDeviceId(id: string = deviceId()): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DEVICE_DB, 1);
    } catch {
      resolve(); // a browser that refuses IndexedDB outright
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore(DEVICE_STORE);
      } catch {
        /* already there, from a concurrent open */
      }
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      const done = (): void => {
        try {
          db.close();
        } catch {
          /* already closing */
        }
        resolve();
      };
      try {
        const tx = db.transaction(DEVICE_STORE, "readwrite");
        tx.objectStore(DEVICE_STORE).put(id, DEVICE_ID_RECORD);
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        done(); // the store is missing, or the database is closing
      }
    };
  });
}
