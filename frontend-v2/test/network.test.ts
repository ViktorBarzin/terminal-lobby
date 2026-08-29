import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  NETWORK_MAX_AGE_MS,
  NETWORK_STORAGE_KEY,
  coerceOverrides,
  currentKind,
  currentNetwork,
  effectiveKindOf,
  onNetworkChange,
  parseNetworkInfo,
  readStoredNetwork,
  refreshNetwork,
  resetNetworkState,
  setNetworkOverrides,
  startNetworkWatch,
  writeStoredNetwork,
  type NetworkInfo,
} from "../src/diagnostics/network";

/**
 * Which network this device is on. The browser cannot answer it — Safari ships
 * no Network Information API, and where the API exists it calls a wired desktop
 * "4g" — so the answer comes from the server, and everything here is about the
 * client not making the answer worse: not relabelling traffic from a malformed
 * reply, not asking again while it already knows, and letting a person's own
 * correction win.
 */

const lan: NetworkInfo = {
  net: "lan",
  kind: "wifi",
  label: "Home network",
  cc: "",
  source: "lan",
};
const a1: NetworkInfo = {
  net: "as64501",
  kind: "unknown",
  label: "Example Telecom Ltd",
  cc: "BG",
  source: "asn",
};

function memStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** A fetch that answers /netinfo with `body`, counting the calls. */
function fakeFetch(body: unknown, ok = true) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok, json: async () => body } as Response;
  });
  return { fn, calls };
}

beforeEach(() => {
  resetNetworkState();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the server's answer", () => {
  it("accepts a well-formed reply", () => {
    expect(parseNetworkInfo({ ...a1 })).toEqual(a1);
  });

  it("rejects a reply with no network name, so nothing is relabelled from it", () => {
    expect(parseNetworkInfo({ kind: "cell" })).toBeNull();
    expect(parseNetworkInfo({ net: "", kind: "cell" })).toBeNull();
    expect(parseNetworkInfo(null)).toBeNull();
    expect(parseNetworkInfo("as64501")).toBeNull();
  });

  it("falls back to unknown for a kind it does not recognise", () => {
    expect(parseNetworkInfo({ net: "as1", kind: "satellite" })?.kind).toBe("unknown");
    expect(parseNetworkInfo({ net: "as1" })?.kind).toBe("unknown");
  });

  it("treats an unrecognised source as no answer at all", () => {
    expect(parseNetworkInfo({ net: "as1", source: "guesswork" })?.source).toBe("none");
  });
});

describe("a person's own correction", () => {
  it("wins over the server's guess", () => {
    expect(effectiveKindOf(a1, {})).toBe("unknown");
    expect(effectiveKindOf(a1, { as64501: "cell" })).toBe("cell");
  });

  it("is keyed by network, so it does not follow you onto another one", () => {
    expect(effectiveKindOf(lan, { as64501: "cell" })).toBe("wifi");
  });

  it("is unknown when there is no network yet", () => {
    expect(effectiveKindOf(null, { as64501: "cell" })).toBe("unknown");
  });

  it("drops entries a hand-edited prefs doc could carry", () => {
    expect(
      coerceOverrides({ as1: "cell", as2: "satellite", as3: 7, "": "wifi", as4: "unknown" }),
    ).toEqual({ as1: "cell" });
    expect(coerceOverrides(null)).toEqual({});
    expect(coerceOverrides(["cell"])).toEqual({});
  });
});

describe("remembering the network across tabs", () => {
  it("round-trips through storage", () => {
    const s = memStorage();
    writeStoredNetwork(a1, s);
    expect(readStoredNetwork(s)).toEqual(a1);
  });

  it("returns nothing rather than raising on a corrupt entry", () => {
    const s = memStorage();
    s.setItem(NETWORK_STORAGE_KEY, "{not json");
    expect(readStoredNetwork(s)).toBeNull();
  });

  it("seeds a fresh tab from what this device last saw", () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(a1));
    resetNetworkState();
    // A tab that has not asked the server yet still attributes its first window
    // to the network it was almost certainly still on.
    expect(currentNetwork()?.net).toBe("as64501");
    setNetworkOverrides({ as64501: "cell" });
    expect(currentKind()).toBe("cell");
  });

  it("attributes to unknown when nothing is known yet", () => {
    expect(currentKind()).toBe("unknown");
  });
});

describe("asking the server", () => {
  it("stores the answer and reports it as the current kind", async () => {
    const { fn, calls } = fakeFetch({ ...a1, kind: "cell" });
    vi.stubGlobal("fetch", fn);
    await refreshNetwork({ force: true });
    expect(calls[0]).toContain("/netinfo");
    expect(currentNetwork()?.label).toBe("Example Telecom Ltd");
    expect(currentKind()).toBe("cell");
    expect(readStoredNetwork()?.net).toBe("as64501");
  });

  it("does not ask again while the answer is still fresh", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    const t = 1_000_000;
    await refreshNetwork({ now: t });
    await refreshNetwork({ now: t + NETWORK_MAX_AGE_MS - 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    await refreshNetwork({ now: t + NETWORK_MAX_AGE_MS + 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("asks anyway when forced, because coming back online means it changed", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    const t = 1_000_000;
    await refreshNetwork({ now: t });
    await refreshNetwork({ now: t + 1, force: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("joins an ordinary call to a request already in flight", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    await Promise.all([
      refreshNetwork({ force: true }),
      refreshNetwork(),
      refreshNetwork(),
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lets the newest overlapping answer win, whatever order they arrive in", async () => {
    // The slow first request went over the link the device has just left, so
    // its answer must not land on top of the newer one.
    const replies: NetworkInfo[] = [a1, lan];
    let n = 0;
    const resolvers: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = replies[n++];
        await new Promise<void>((r) => resolvers.push(r));
        return { ok: true, json: async () => body } as Response;
      }),
    );
    const first = refreshNetwork({ force: true });
    const second = refreshNetwork({ force: true });
    // Answer the SECOND request first, then the stale one.
    resolvers[1]?.();
    resolvers[0]?.();
    await Promise.all([first, second]);
    expect(currentNetwork()?.net).toBe("lan");
  });

  it("keeps the last known network when the request fails", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    await refreshNetwork({ force: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    // The bytes that failed to reach the server did not cross a different link,
    // so the previous answer is a better attribution than unknown.
    await refreshNetwork({ force: true });
    expect(currentNetwork()?.net).toBe("as64501");
  });

  it("keeps the last known network when the server errors", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    await refreshNetwork({ force: true });
    vi.stubGlobal("fetch", fakeFetch({}, false).fn);
    await refreshNetwork({ force: true });
    expect(currentNetwork()?.net).toBe("as64501");
  });

  it("keeps the last known network when the reply is malformed", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    await refreshNetwork({ force: true });
    vi.stubGlobal("fetch", fakeFetch({ nonsense: true }).fn);
    await refreshNetwork({ force: true });
    expect(currentNetwork()?.net).toBe("as64501");
  });

  it("tells subscribers when the network changes, and not when it repeats", async () => {
    const seen: (string | undefined)[] = [];
    onNetworkChange((info) => seen.push(info?.net));
    vi.stubGlobal("fetch", fakeFetch({ ...a1 }).fn);
    await refreshNetwork({ force: true });
    await refreshNetwork({ force: true });
    expect(seen).toEqual(["as64501"]);

    vi.stubGlobal("fetch", fakeFetch({ ...lan }).fn);
    await refreshNetwork({ force: true });
    expect(seen).toEqual(["as64501", "lan"]);
  });

  it("tells subscribers when a correction changes the kind", () => {
    const seen: string[] = [];
    onNetworkChange(() => seen.push(currentKind()));
    setNetworkOverrides({ as64501: "cell" });
    expect(seen).toEqual(["unknown"]); // no network known yet, but they heard
  });
});

describe("watching for a network change", () => {
  it("asks once at start and again on the events that correlate with a move", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    const handlers: Record<string, () => void> = {};
    const target = {
      addEventListener: (k: string, h: () => void) => void (handlers[k] = h),
      removeEventListener: (k: string) => void delete handlers[k],
    };
    const doc = {
      addEventListener: (k: string, h: () => void) => void (handlers[k] = h),
      removeEventListener: (k: string) => void delete handlers[k],
      visibilityState: "visible" as DocumentVisibilityState,
    };

    const stop = startNetworkWatch(
      target as unknown as Window,
      doc as unknown as Document,
    );
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    // Coming back online is the one moment the network has certainly changed,
    // so it bypasses the freshness window.
    handlers.online?.();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);

    // A tab coming back from a pocket is a hint, not a certainty, so it is
    // throttled — nothing here has aged past the freshness window.
    handlers.visibilitychange?.();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);

    stop();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("ignores a visibility change to hidden", async () => {
    const { fn } = fakeFetch({ ...a1 });
    vi.stubGlobal("fetch", fn);
    const handlers: Record<string, () => void> = {};
    const doc = {
      addEventListener: (k: string, h: () => void) => void (handlers[k] = h),
      removeEventListener: () => {},
      visibilityState: "hidden" as DocumentVisibilityState,
    };
    startNetworkWatch(undefined, doc as unknown as Document);
    await Promise.resolve();
    const before = fn.mock.calls.length;
    handlers.visibilitychange?.();
    await Promise.resolve();
    expect(fn.mock.calls.length).toBe(before);
  });
});
