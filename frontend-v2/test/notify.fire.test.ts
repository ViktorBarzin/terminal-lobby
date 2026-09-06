import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fireNotification } from "../src/notify/fire";

/**
 * What a banner CALLS a session. The bug (2026-09-06): the notification title
 * was built from the session name, and since ADR-0019 a name is a
 * 12-character id — so a phone showed `k7m2q9x4tp0v needs input` and nothing
 * said which conversation that was. The server's push has always used the
 * title (tmux-api `pushLabel`); this is the page-fired path catching up.
 */

const shown: { title: string; options: NotificationOptions }[] = [];

beforeEach(() => {
  shown.length = 0;
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({
        showNotification: (title: string, options: NotificationOptions) => {
          shown.push({ title, options });
          return Promise.resolve();
        },
      }),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const fire = (label: string, kind: "awaiting" | "done" = "awaiting") =>
  fireNotification("6j0wjvxxf7e5", label, kind, {
    hasRegistration: true,
    onActivate: () => {},
  });

describe("fireNotification", () => {
  it("names the session by its title, not its id", async () => {
    await fire("Restore feature session naming");
    expect(shown[0]!.title).toBe("Restore feature session naming needs input");
  });

  it("says finished on the done edge", async () => {
    await fire("Restore feature session naming", "done");
    expect(shown[0]!.title).toBe("Restore feature session naming finished");
  });

  // The tag and the click payload are ADDRESSES: they route the tap to a
  // session, and two sessions may well share a title.
  it("keeps the name in the tag and the click data", async () => {
    await fire("Models");
    expect(shown[0]!.options.tag).toBe("tl-6j0wjvxxf7e5");
    expect(shown[0]!.options.data).toEqual({ session: "6j0wjvxxf7e5" });
  });
});
