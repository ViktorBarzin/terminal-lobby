import { describe, it, expect, vi } from "vitest";
import {
  BUILD_SUBSTRING,
  STORM_WINDOW_MS,
  buildLogLine,
  fetchSelf,
  hashPage,
  isBuildStale,
  planReload,
  stormOK,
  type ReloadState,
} from "../src/deploy/healer.logic";

/** A minimal Response stand-in — fetchSelf only reads `.ok` and `.text()`. */
function resp(ok: boolean, body: string): Response {
  return { ok, text: async () => body } as unknown as Response;
}
const withMarker = (s: string): string => `<!doctype html>${BUILD_SUBSTRING} abc123\n${s}`;

describe("hashPage — djb2 stability", () => {
  it("is deterministic (same input → same hash)", () => {
    expect(hashPage("hello world")).toBe(hashPage("hello world"));
  });

  it("prefixes the byte length so different-length pages can never collide", () => {
    expect(hashPage("abc").startsWith("3:")).toBe(true);
    expect(hashPage("")).toBe("0:5381"); // djb2 seed, empty string
  });

  it("changes when the content changes (a one-byte build-id flip is detected)", () => {
    const a = hashPage(withMarker("build=aaaaaaa"));
    const b = hashPage(withMarker("build=aaaaaab"));
    expect(a).not.toBe(b);
  });

  it("pins the exact djb2 output for a known string (regression guard)", () => {
    // djb2 of "terminal-lobby" as unsigned 32-bit, length-prefixed.
    expect(hashPage("terminal-lobby")).toBe("14:4026662630");
  });

  it("stays within unsigned-32-bit range (>>> 0) for long input", () => {
    const big = "x".repeat(100000);
    const [, h] = hashPage(big).split(":");
    const n = Number(h);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("fetchSelf — build-substring gating", () => {
  it("returns the text on 200 WITH the marker", async () => {
    const body = withMarker("<div>lobby</div>");
    const f = vi.fn(async () => resp(true, body)) as unknown as typeof fetch;
    await expect(fetchSelf(f, "/", "no-cache")).resolves.toBe(body);
  });

  it("returns null on 200 WITHOUT the marker (an auth interstitial)", async () => {
    const f = vi.fn(async () => resp(true, "<html>Authentik login</html>")) as unknown as typeof fetch;
    await expect(fetchSelf(f, "/", "no-cache")).resolves.toBeNull();
  });

  it("returns null on a non-200 response (never reads the body as baseline)", async () => {
    const text = vi.fn(async () => withMarker("body"));
    const f = vi.fn(async () => ({ ok: false, text }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchSelf(f, "/", "no-cache")).resolves.toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("passes same-origin credentials + the requested cache mode to fetch", async () => {
    const f = vi.fn(async () => resp(true, withMarker("x"))) as unknown as typeof fetch;
    await fetchSelf(f, "/?a=1", "no-store");
    expect(f).toHaveBeenCalledWith("/?a=1", { cache: "no-store", credentials: "same-origin" });
  });
});

describe("stormOK — 1-per-2-min AUTO-reload window", () => {
  it("allows the first reload (no prior timestamp)", () => {
    expect(stormOK(1_000_000, null)).toBe(true);
    expect(stormOK(1_000_000, 0)).toBe(true);
  });

  it("blocks a second reload inside the window", () => {
    const last = 1_000_000;
    expect(stormOK(last + STORM_WINDOW_MS - 1, last)).toBe(false);
  });

  it("allows again exactly at the window boundary and beyond", () => {
    const last = 1_000_000;
    expect(stormOK(last + STORM_WINDOW_MS, last)).toBe(true);
    expect(stormOK(last + STORM_WINDOW_MS + 1, last)).toBe(true);
  });

  it("honours a custom window", () => {
    expect(stormOK(500, 0, 1000)).toBe(false);
    expect(stormOK(1000, 0, 1000)).toBe(true);
  });
});

describe("planReload — requestTopReload policy branches", () => {
  const base: ReloadState = {
    attached: false,
    hidden: false,
    updatePending: false,
    now: 1_000_000,
    lastReloadAt: null,
  };

  it("no attached terminal → reload immediately (storm allowing)", () => {
    expect(planReload({ ...base, attached: false, hidden: false })).toBe("reload");
  });

  it("hidden tab → reload immediately even with a terminal attached", () => {
    expect(planReload({ ...base, attached: true, hidden: true })).toBe("reload");
  });

  it("attached + visible → defer to the sticky pill (never yank a viewer)", () => {
    expect(planReload({ ...base, attached: true, hidden: false })).toBe("show-pill");
  });

  it("attached + visible with a pill already up → no-op", () => {
    expect(planReload({ ...base, attached: true, hidden: false, updatePending: true })).toBe(
      "pill-pending",
    );
  });

  it("immediate reload is storm-gated (throttled inside the window)", () => {
    const last = 1_000_000;
    expect(
      planReload({ ...base, attached: false, now: last + 1000, lastReloadAt: last }),
    ).toBe("throttled");
    expect(
      planReload({ ...base, attached: false, now: last + STORM_WINDOW_MS, lastReloadAt: last }),
    ).toBe("reload");
  });

  it("the DEFER path is NOT storm-gated — a fresh reload never suppresses the pill", () => {
    const last = 1_000_000;
    expect(
      planReload({ ...base, attached: true, hidden: false, now: last + 1, lastReloadAt: last }),
    ).toBe("show-pill");
  });
});

describe("isBuildStale — tl-build-stale bridge predicate", () => {
  it("accepts the exact build-stale payload", () => {
    expect(isBuildStale({ type: "tl-build-stale" })).toBe(true);
  });

  it("rejects other message types and junk", () => {
    expect(isBuildStale({ type: "tl-command", command: "x" })).toBe(false);
    expect(isBuildStale({ type: "tl-attention" })).toBe(false);
    expect(isBuildStale(null)).toBe(false);
    expect(isBuildStale("tl-build-stale")).toBe(false);
    expect(isBuildStale(undefined)).toBe(false);
  });
});

describe("buildLogLine — marker literal", () => {
  it("embeds the substring fetchSelf validates against", () => {
    const line = buildLogLine("deadbeef");
    expect(line.includes(BUILD_SUBSTRING)).toBe(true);
    expect(line).toBe("terminal-lobby build: deadbeef");
  });
});
