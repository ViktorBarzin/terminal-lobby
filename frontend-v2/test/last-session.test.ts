import { describe, it, expect } from "vitest";
import {
  LAST_SESSION_KEY,
  pickReopen,
  wantsReopen,
  readLastSession,
  writeLastSession,
} from "../src/pwa/last-session";

/**
 * Reopening the installed app lands on the session you left it on.
 *
 * Viktor, 2026-10-01: "every time I open it I go to the composer view". A
 * killed PWA cold-launches at start_url `/`, which carries no session, and no
 * session is the composer. The July fix for this (a coarse-only
 * `tl:last-active:v1` marker) did not survive the move to the SPA.
 */

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const base = {
  remembered: "trip-casia",
  urlSelected: false,
  standalone: true,
  lens: false,
  live: ["issues", "trip-casia"],
};

describe("pickReopen", () => {
  it("reopens the remembered session when the installed app opens on nothing", () => {
    expect(pickReopen(base)).toBe("trip-casia");
  });

  it.each([
    ["the URL already names a session", { urlSelected: true }],
    ["it is a browser tab, not the installed app", { standalone: false }],
    ["the tab is acting as another user", { lens: true }],
    ["nothing was remembered", { remembered: null }],
    ["the session has gone, so attaching would recreate it", { live: ["issues"] }],
    ["the list is empty", { live: [] }],
  ])("stays on the composer when %s", (_why, over) => {
    expect(pickReopen({ ...base, ...over })).toBeNull();
  });
});

describe("last-session storage", () => {
  it("round-trips a session name", () => {
    const s = memoryStorage();
    writeLastSession("issues", s);
    expect(s.dump()).toEqual({ [LAST_SESSION_KEY]: "issues" });
    expect(readLastSession(s)).toBe("issues");
  });

  it("forgets on null, so leaving for the composer is remembered too", () => {
    const s = memoryStorage({ [LAST_SESSION_KEY]: "issues" });
    writeLastSession(null, s);
    expect(readLastSession(s)).toBeNull();
  });

  it.each(["", "has space", "a".repeat(33), "../etc"])(
    "refuses a stored value that is not a session name: %j",
    (bad) => {
      expect(readLastSession(memoryStorage({ [LAST_SESSION_KEY]: bad }))).toBeNull();
    },
  );

  it("survives storage that throws (private mode, blocked site data)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLastSession(broken)).toBeNull();
    expect(() => writeLastSession("issues", broken)).not.toThrow();
    expect(() => writeLastSession(null, broken)).not.toThrow();
  });
});

describe("wantsReopen", () => {
  it("decides before the list is known, from the launch alone", () => {
    const { live: _live, ...launch } = base;
    expect(wantsReopen(launch)).toBe(true);
    expect(wantsReopen({ ...launch, urlSelected: true })).toBe(false);
    expect(wantsReopen({ ...launch, remembered: null })).toBe(false);
  });
});
