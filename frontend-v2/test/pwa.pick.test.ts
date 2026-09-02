import { describe, it, expect, vi } from "vitest";
import { pickTappedSession, type PendingNotif } from "../src/pwa/register";

/**
 * Which of several outstanding notifications did the user tap?
 *
 * On iOS nothing says. There is no notificationclick for an installed app, and
 * being foregrounded carries no argument. What iOS does do is CLEAR the tapped
 * notification and leave the others, so the record whose banner has gone is the
 * tap.
 *
 * The stash was one slot before this, so each push overwrote the last. Measured
 * on Viktor's phone 2026-09-02: pushes for issues, cache-omages and ux inside
 * 80 s, he tapped one, and the read came back `already` because the slot held
 * `ux` and `ux` was on screen. The tap did nothing, every time, whenever the
 * newest push happened to name the session he was looking at.
 */
const now = 1_000_000;
const rec = (session: string, ageMs: number, tapped = false): PendingNotif => ({
  session,
  ts: now - ageMs,
  tapped,
});

/** `gone` are the sessions whose banner iOS has cleared. */
const shade = (gone: string[]) => async (tag: string) =>
  gone.includes(tag.replace(/^tl-/, "")) ? 0 : 1;

describe("pickTappedSession", () => {
  it("THE BUG: picks the one whose banner is gone, not the newest push", async () => {
    // Viktor's exact shape: three pending, he tapped the oldest.
    const records = [rec("ux", 1_000), rec("cache-omages", 50_000), rec("issues", 80_000)];
    const pick = await pickTappedSession(records, { now, displayed: shade(["issues"]) });
    expect(pick?.session).toBe("issues");
  });

  it("does nothing when every banner is still on screen — an icon launch", async () => {
    const records = [rec("ux", 1_000), rec("issues", 80_000)];
    expect(await pickTappedSession(records, { now, displayed: shade([]) })).toBeNull();
  });

  it("prefers a record the worker saw a real click on", async () => {
    const records = [rec("ux", 1_000), rec("issues", 80_000, true)];
    const pick = await pickTappedSession(records, { now, displayed: shade(["ux"]) });
    expect(pick?.session).toBe("issues");
  });

  it("takes the newest when several banners are gone", async () => {
    const records = [rec("ux", 1_000), rec("issues", 80_000)];
    const pick = await pickTappedSession(records, { now, displayed: shade(["ux", "issues"]) });
    expect(pick?.session).toBe("ux");
  });

  it("ignores anything past the outer window", async () => {
    const records = [rec("issues", 31 * 60 * 1000)];
    expect(await pickTappedSession(records, { now, displayed: shade(["issues"]) })).toBeNull();
  });

  it("ignores a malformed session name", async () => {
    const records = [{ session: "not a name", ts: now - 1000 }] as PendingNotif[];
    expect(await pickTappedSession(records, { now, displayed: shade(["not a name"]) })).toBeNull();
  });

  it("falls back to the newest fresh receipt when the shade cannot be read", async () => {
    const records = [rec("ux", 1_000), rec("issues", 80_000)];
    const pick = await pickTappedSession(records, { now, displayed: async () => null });
    expect(pick?.session).toBe("ux");
  });

  it("returns nothing for an empty store", async () => {
    expect(await pickTappedSession([], { now, displayed: shade([]) })).toBeNull();
  });

  it("survives a shade lookup that throws", async () => {
    const records = [rec("ux", 1_000)];
    const boom = vi.fn(async () => {
      throw new Error("no registration");
    });
    // Unreadable is unreadable: same fallback as a null count.
    expect((await pickTappedSession(records, { now, displayed: boom }))?.session).toBe("ux");
  });

  it("a single pending notification still routes when its banner is gone", async () => {
    const records = [rec("authentik", 5_000)];
    const pick = await pickTappedSession(records, { now, displayed: shade(["authentik"]) });
    expect(pick?.session).toBe("authentik");
  });
});
