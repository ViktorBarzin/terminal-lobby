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
