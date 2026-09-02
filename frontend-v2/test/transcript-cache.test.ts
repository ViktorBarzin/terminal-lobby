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
import { describe, it, expect } from "vitest";
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
