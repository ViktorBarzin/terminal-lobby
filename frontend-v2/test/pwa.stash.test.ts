import { describe, it, expect, vi } from "vitest";
import {
  stashIsActionable,
  PENDING_NOTIF_TTL_MS,
  STASH_MAX_AGE_MS,
  type PendingNotif,
} from "../src/pwa/register";

/**
 * The notification-tap stash decision (sw.js ↔ page contract). sw.js writes the
 * record twice over: at push time as a GUESS that the user is about to tap
 * (tapped:false), and from its notificationclick openWindow branch as an actual
 * tap (tapped:true). Boot trusts them differently — and for an old guess it asks
 * whether the banner is still on screen, because iOS clears a notification when
 * it is tapped, which is the only trace of the tap that survives a cold launch.
 */
const rec = (over: Partial<PendingNotif> = {}): PendingNotif => ({
  session: "vpn",
  ts: 1_000_000,
  tapped: false,
  ...over,
});

/** now = record ts + age. */
const at = (age: number) => 1_000_000 + age;

describe("stashIsActionable", () => {
  it("rejects a missing or malformed record", async () => {
    const open = vi.fn();
    expect(await stashIsActionable(null, { now: at(0), openNotifications: open })).toBe(false);
    expect(
      await stashIsActionable(rec({ session: "no spaces allowed" }), {
        now: at(0),
        openNotifications: open,
      }),
    ).toBe(false);
    expect(
      await stashIsActionable({ session: "vpn" } as PendingNotif, {
        now: at(0),
        openNotifications: open,
      }),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a record stamped in the future (clock skew)", async () => {
    expect(
      await stashIsActionable(rec(), { now: at(-5000), openNotifications: async () => 0 }),
    ).toBe(false);
  });

  it("lands a FRESH receipt without asking about banners", async () => {
    const open = vi.fn();
    expect(
      await stashIsActionable(rec(), {
        now: at(PENDING_NOTIF_TTL_MS - 1),
        openNotifications: open,
      }),
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("lands a TAPPED record for the whole outer window, banners irrelevant", async () => {
    const open = vi.fn();
    expect(
      await stashIsActionable(rec({ tapped: true }), {
        now: at(STASH_MAX_AGE_MS - 1),
        openNotifications: open,
      }),
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects anything past the outer window", async () => {
    expect(
      await stashIsActionable(rec({ tapped: true }), {
        now: at(STASH_MAX_AGE_MS + 1),
        openNotifications: async () => 0,
      }),
    ).toBe(false);
  });

  describe("an aged receipt (Viktor's locked-phone tap)", () => {
    const aged = { now: at(PENDING_NOTIF_TTL_MS + 60_000) };

    it("lands it when the banner is GONE — tapped or dismissed", async () => {
      const open = vi.fn(async () => 0);
      expect(await stashIsActionable(rec(), { ...aged, openNotifications: open })).toBe(true);
      expect(open).toHaveBeenCalledWith("tl-vpn");
    });

    it("does NOT land it while the banner is still displayed (a plain icon launch)", async () => {
      expect(
        await stashIsActionable(rec(), { ...aged, openNotifications: async () => 1 }),
      ).toBe(false);
    });

    it("does NOT land it when the banner state is unknowable", async () => {
      expect(
        await stashIsActionable(rec(), { ...aged, openNotifications: async () => null }),
      ).toBe(false);
    });

    it("does NOT land it when the lookup throws", async () => {
      expect(
        await stashIsActionable(rec(), {
          ...aged,
          openNotifications: async () => {
            throw new Error("no registration");
          },
        }),
      ).toBe(false);
    });
  });
});
