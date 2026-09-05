import { describe, it, expect, vi } from "vitest";
import {
  ASSET_SUBSTRING,
  BUILD_SUBSTRING,
  MAX_UPDATE_ATTEMPTS,
  RESUME_AWAY_MS,
  STORM_WINDOW_MS,
  buildLogLine,
  fetchSelf,
  parseAssetId,
  planUpdate,
  stormOK,
  type UpdateState,
} from "../src/deploy/healer.logic";

/** A minimal Response stand-in — fetchSelf only reads `.ok` and `.text()`. */
function resp(ok: boolean, body: string): Response {
  return { ok, text: async () => body } as unknown as Response;
}
const withMarker = (s: string): string => `<!doctype html>${BUILD_SUBSTRING} abc123\n${s}`;
/** A served page carrying both stamps, the way a deployed page really looks. */
const page = (asset: string, build = "abc1234"): string =>
  `<!doctype html><html><head><meta name="tl-asset" content="${asset}">` +
  `</head><body><script>const TL_BUILD='${build}';console.log("${BUILD_SUBSTRING}",TL_BUILD)</script></body></html>`;

describe("parseAssetId — the update IDENTITY, read out of the served bytes", () => {
  it("extracts the id from the meta tag", () => {
    expect(parseAssetId(page("abc123def456"))).toBe("abc123def456");
  });

  it("tolerates single quotes, attribute order and extra whitespace", () => {
    expect(parseAssetId(`<meta name='tl-asset' content='deadbeef0000'>`)).toBe("deadbeef0000");
    expect(parseAssetId(`<meta   content="cafe12345678"   name="tl-asset" >`)).toBe("cafe12345678");
  });

  it("returns null when the page carries no identity (an auth interstitial)", () => {
    expect(parseAssetId(`<!doctype html><title>Sign in</title>`)).toBeNull();
    expect(parseAssetId("")).toBeNull();
  });

  it("returns null for an unsubstituted placeholder — a mis-stamped build is NOT an identity", () => {
    expect(parseAssetId(`<meta name="tl-asset" content="__TL_ASSET__">`)).toBeNull();
  });

  it("ignores other meta tags", () => {
    expect(parseAssetId(`<meta name="tl-build" content="abc1234">`)).toBeNull();
  });

  it("exposes the marker literal the stamped page must carry", () => {
    expect(page("abc123def456").includes(ASSET_SUBSTRING)).toBe(true);
  });
});

describe("planUpdate — identity comparison, not byte comparison", () => {
  const base: UpdateState = {
    runningAsset: "aaaaaaaaaaaa",
    servedAsset: "aaaaaaaaaaaa",
    attached: false,
    visible: true,
    justResumed: false,
    attempts: 0,
    now: 1_000_000,
    lastReloadAt: null,
  };

  it("THE REGRESSION: a body that differs but carries the SAME asset id is NOT an update", () => {
    // A backend-only deploy restamps the git SHA inside the page. The bytes
    // change; the frontend the user is running does not. No notification, no
    // reload — this is Viktor's "we don't have that many updates".
    expect(planUpdate({ ...base, servedAsset: "aaaaaaaaaaaa" })).toBe("none");
  });

  it("a changed asset id with no terminal attached reloads immediately", () => {
    expect(planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attached: false })).toBe("reload");
  });

  it("DEFERS (never yanks) while a terminal is attached on a visible, focused page", () => {
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attached: true, justResumed: false }),
    ).toBe("defer");
  });

  it("applies on the NEXT OPEN — a resume edge with a terminal attached reloads", () => {
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attached: true, justResumed: true }),
    ).toBe("reload");
  });

  it("NEVER navigates a hidden document, however stale it is", () => {
    expect(
      planUpdate({
        ...base,
        servedAsset: "bbbbbbbbbbbb",
        attached: false,
        visible: false,
        justResumed: true,
      }),
    ).toBe("defer");
  });

  it("treats an unreadable served page as no information at all", () => {
    expect(planUpdate({ ...base, servedAsset: null })).toBe("none");
  });

  it("never reloads when this document does not know its own identity", () => {
    expect(planUpdate({ ...base, runningAsset: null, servedAsset: "bbbbbbbbbbbb" })).toBe("none");
  });

  it("is storm-gated: a second auto reload inside the window waits", () => {
    const last = 1_000_000;
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", now: last + 1000, lastReloadAt: last }),
    ).toBe("none");
    expect(
      planUpdate({
        ...base,
        servedAsset: "bbbbbbbbbbbb",
        now: last + STORM_WINDOW_MS,
        lastReloadAt: last,
      }),
    ).toBe("reload");
  });

  it("gives up after MAX_UPDATE_ATTEMPTS failed attempts at the same target", () => {
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attempts: MAX_UPDATE_ATTEMPTS }),
    ).toBe("give-up");
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attempts: MAX_UPDATE_ATTEMPTS - 1 }),
    ).toBe("reload");
  });

  it("give-up outranks every other branch (no thrashing, ever)", () => {
    expect(
      planUpdate({
        ...base,
        servedAsset: "bbbbbbbbbbbb",
        attached: true,
        visible: false,
        attempts: MAX_UPDATE_ATTEMPTS,
      }),
    ).toBe("give-up");
  });

  it("honours a custom attempt cap", () => {
    expect(
      planUpdate({ ...base, servedAsset: "bbbbbbbbbbbb", attempts: 1, maxAttempts: 1 }),
    ).toBe("give-up");
  });
});

describe("stormOK — the anti-loop backstop, hardened", () => {
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

  it("without storage, falls back to document uptime so the cap cannot vanish", () => {
    // sessionStorage throwing used to silently REMOVE the cap (last stayed 0 →
    // the gate always opened). With no storage the document must instead have
    // been alive a full window before it may auto-reload.
    const opts = { storageAvailable: false };
    expect(stormOK(1_000_000, null, STORM_WINDOW_MS, { ...opts, uptimeMs: 0 })).toBe(false);
    expect(
      stormOK(1_000_000, null, STORM_WINDOW_MS, { ...opts, uptimeMs: STORM_WINDOW_MS - 1 }),
    ).toBe(false);
    expect(
      stormOK(1_000_000, null, STORM_WINDOW_MS, { ...opts, uptimeMs: STORM_WINDOW_MS }),
    ).toBe(true);
  });

  it("with storage available the uptime brake does not apply", () => {
    expect(
      stormOK(1_000_000, null, STORM_WINDOW_MS, { storageAvailable: true, uptimeMs: 0 }),
    ).toBe(true);
  });
});

describe("resume-edge constant", () => {
  it("counts any app switch of 5s or more as 'the next open'", () => {
    expect(RESUME_AWAY_MS).toBe(5000);
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

  it("returns null on a non-200 response (never reads the body as an identity)", async () => {
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

describe("buildLogLine — marker literal", () => {
  it("embeds the substring fetchSelf validates against", () => {
    const line = buildLogLine("deadbeef");
    expect(line.includes(BUILD_SUBSTRING)).toBe(true);
    expect(line).toBe("terminal-lobby build: deadbeef");
  });
});
