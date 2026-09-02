import { describe, it, expect, vi } from "vitest";
import { waitingCount, applyAppBadge, type BadgingNavigator } from "../src/notify/appbadge";

/**
 * The PWA icon badge. `waitingCount` is the arithmetic — which sessions are
 * asking for you — and `applyAppBadge` is the paint, which has to stay silent
 * on every browser that cannot draw it.
 */
const s = (name: string, state?: string) => ({ name, state });
const doneIsUnseen = (x: { state?: string }) => x.state === "done";

describe("waitingCount", () => {
  it("counts awaiting input and unseen finished work", () => {
    const list = [s("a", "awaiting"), s("b", "running"), s("c", "done"), s("d", "idle")];
    expect(waitingCount(list, doneIsUnseen)).toBe(2);
  });

  it("does not count a running session — busy is not waiting", () => {
    expect(waitingCount([s("a", "running"), s("b", "running")], doneIsUnseen)).toBe(0);
  });

  it("drops a finished session once it has been seen", () => {
    const list = [s("a", "done"), s("b", "done")];
    expect(waitingCount(list, doneIsUnseen)).toBe(2);
    expect(waitingCount(list, (x) => x.state === "done" && x.name === "a")).toBe(1);
    expect(waitingCount(list, () => false)).toBe(0);
  });

  it("never double-counts: awaiting and unseen-done are disjoint", () => {
    // A predicate that wrongly claims everything is unseen must still not make
    // an awaiting session count twice.
    expect(waitingCount([s("a", "awaiting")], () => true)).toBe(1);
  });

  it("is zero for an empty list", () => {
    expect(waitingCount([], doneIsUnseen)).toBe(0);
  });

  // `owner` is stamped on EVERY session, your own included — it is not a
  // "this one is foreign" flag. The first version of this test supplied
  // `owner: undefined` for own sessions, matching the wrong assumption in the
  // code, so both agreed and the badge shipped pinned at zero.
  it("counts YOUR sessions, which arrive with your own name in owner", () => {
    const list = [
      { name: "a", state: "awaiting", owner: "wizard" },
      { name: "b", state: "done", owner: "wizard" },
    ];
    expect(waitingCount(list, doneIsUnseen, "wizard")).toBe(2);
  });

  it("leaves out a session someone else owns — that is their work", () => {
    const list = [
      { name: "mine", state: "awaiting", owner: "wizard" },
      { name: "theirs", state: "awaiting", owner: "bob" },
      { name: "also-theirs", state: "done", owner: "carol" },
    ];
    expect(waitingCount(list, doneIsUnseen, "wizard")).toBe(1);
  });

  it("counts a session with no owner field at all", () => {
    expect(waitingCount([s("mine", "awaiting")], doneIsUnseen, "wizard")).toBe(1);
  });

  it("excludes nothing when the caller offers no identity", () => {
    const list = [
      { name: "mine", state: "awaiting", owner: "wizard" },
      { name: "theirs", state: "awaiting", owner: "bob" },
    ];
    expect(waitingCount(list, doneIsUnseen)).toBe(2);
  });
});

describe("applyAppBadge", () => {
  it("draws a positive count and clears a zero", () => {
    const nav = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    } as unknown as BadgingNavigator;

    applyAppBadge(3, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);

    applyAppBadge(0, nav);
    expect(nav.clearAppBadge).toHaveBeenCalled();
  });

  it("swallows the rejection a non-installed document gets", async () => {
    const nav = {
      setAppBadge: vi.fn(() => Promise.reject(new Error("not installed"))),
      clearAppBadge: vi.fn(async () => {}),
    } as unknown as BadgingNavigator;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => applyAppBadge(2, nav)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("is a no-op where the Badging API does not exist", () => {
    expect(() => applyAppBadge(5, {} as BadgingNavigator)).not.toThrow();
  });

  it("survives a navigator that throws outright", () => {
    const nav = {
      get setAppBadge(): never {
        throw new Error("blocked");
      },
    } as unknown as BadgingNavigator;
    expect(() => applyAppBadge(1, nav)).not.toThrow();
  });
});

/**
 * Whether the icon could actually be DRAWN.
 *
 * The paint has always been best-effort and silent, which also meant nobody
 * could tell a drawn badge from an absent API. On iOS that is the whole
 * question: the Badging API may not be exposed inside a service worker, and the
 * worker is the only writer while the app is shut — the one case the badge
 * exists for. So every outcome is now reported.
 */
describe("applyAppBadge — reporting the outcome", () => {
  it("reports ok once the paint resolves", async () => {
    const seen: [string, number][] = [];
    const nav = {
      setAppBadge: async () => {},
      clearAppBadge: async () => {},
    } as unknown as BadgingNavigator;
    applyAppBadge(3, nav, (k, n) => seen.push([k, n]));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([["ok", 3]]);
  });

  it("reports unsupported where the API is missing — the iOS worker suspicion", () => {
    const seen: string[] = [];
    applyAppBadge(3, {} as BadgingNavigator, (k) => seen.push(k));
    expect(seen).toEqual(["unsupported"]);
  });

  it("reports failed when the paint rejects — not installed, or permission-gated", async () => {
    const seen: string[] = [];
    const nav = {
      setAppBadge: () => Promise.reject(new Error("not installed")),
      clearAppBadge: async () => {},
    } as unknown as BadgingNavigator;
    applyAppBadge(2, nav, (k) => seen.push(k));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["failed"]);
  });

  it("reports failed when reading the API throws outright", () => {
    // `failed` rather than `unsupported`: something is there and it blew up,
    // which is a different finding from the API being absent.
    const seen: string[] = [];
    const nav = {
      get setAppBadge(): never {
        throw new Error("blocked");
      },
    } as unknown as BadgingNavigator;
    applyAppBadge(1, nav, (k) => seen.push(k));
    expect(seen).toEqual(["failed"]);
  });

  it("still paints without a reporter", () => {
    const calls: number[] = [];
    const nav = {
      setAppBadge: async (n: number) => calls.push(n),
      clearAppBadge: async () => {},
    } as unknown as BadgingNavigator;
    expect(() => applyAppBadge(4, nav)).not.toThrow();
    expect(calls).toEqual([4]);
  });
});
