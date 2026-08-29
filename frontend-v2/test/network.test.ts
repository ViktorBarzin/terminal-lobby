import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  NETWORK_STALE_MS,
  NETWORK_STORAGE_KEY,
  currentNetwork,
  currentNetworkId,
  networkIsStale,
  noteNetworkId,
  onNetworkChange,
  parseNetworkInfo,
  readStoredNetwork,
  refreshNetwork,
  resetNetworkState,
  startNetworkWatch,
  writeStoredNetwork,
  type NetworkInfo,
} from "../src/diagnostics/network";
import { NET_UNKNOWN, USAGE_STORAGE_KEY, readStore } from "../src/diagnostics/usage";

/**
 * Which network this device is on. The browser cannot say — Safari ships no
 * Network Information API, where the API exists it calls a wired desktop "4g",
 * and WebRTC host candidates are mDNS-obfuscated — so the answer comes from the
 * server, stamped on responses the app was making anyway.
 *
 * Everything here is about the client not making that answer worse: not
 * attributing bytes to a network it can no longer vouch for, not relabelling
 * from a malformed reply, and not asking again for something it already knows.
 */

const lan: NetworkInfo = { net: "lan", label: "Home network", cc: "", source: "lan" };
const pl: NetworkInfo = { net: "as8374", label: "Polkomtel", cc: "PL", source: "asn" };

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
    expect(parseNetworkInfo({ ...pl })).toEqual(pl);
  });

  it("rejects a reply with no usable id, so nothing is relabelled from it", () => {
    expect(parseNetworkInfo({ label: "Polkomtel" })).toBeNull();
    expect(parseNetworkInfo({ net: "" })).toBeNull();
    expect(parseNetworkInfo({ net: "Not A Net" })).toBeNull();
    expect(parseNetworkInfo(null)).toBeNull();
    expect(parseNetworkInfo("as8374")).toBeNull();
  });

  it("treats an unrecognised source as no answer at all", () => {
    expect(parseNetworkInfo({ net: "as1", source: "guesswork" })?.source).toBe("none");
  });

  it("carries no category, because there is no longer one to carry", () => {
    const parsed = parseNetworkInfo({ ...pl, kind: "cell" }) as unknown as Record<string, unknown>;
    expect(parsed.kind).toBeUndefined();
  });
});

describe("the id stamped on a response", () => {
  it("is what a window folds under", () => {
    noteNetworkId("as8374");
    expect(currentNetworkId()).toBe("as8374");
    expect(currentNetwork()?.net).toBe("as8374");
  });

  it("ignores a response that carries no stamp, keeping what it has", () => {
    noteNetworkId("as8374");
    noteNetworkId(null);
    noteNetworkId(undefined);
    noteNetworkId("");
    expect(currentNetworkId()).toBe("as8374");
  });

  it("ignores a malformed stamp rather than minting a row from it", () => {
    noteNetworkId("as8374");
    noteNetworkId("../../etc");
    expect(currentNetworkId()).toBe("as8374");
  });

  it("takes the server's explicit unknown, rather than keeping the old network", () => {
    // A request that reached the server without a forwarding header is a
    // definite answer: whatever we were attributing to no longer applies.
    noteNetworkId("as8374");
    noteNetworkId(NET_UNKNOWN);
    expect(currentNetworkId()).toBe(NET_UNKNOWN);
  });

  it("asks for a name the first time it sees a network, and not again", async () => {
    const { fn } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    noteNetworkId("as8374");
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    noteNetworkId("as8374");
    noteNetworkId("as8374");
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not go asking for a name for unknown", async () => {
    const { fn } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    noteNetworkId(NET_UNKNOWN);
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("an answer that has gone stale", () => {
  /**
   * lobby.ts parks the /sessions poll while a tab is hidden, and the byte
   * counter deliberately keeps running. So a backgrounded phone counts bytes
   * while the answer ages — exactly when someone walks out of the house onto
   * cellular. An unattributed row is honest; a quietly wrong one is not.
   */
  it("folds under unknown rather than under the network last seen", () => {
    const t = 1_000_000;
    noteNetworkId("as8374", t);
    expect(currentNetworkId(t + NETWORK_STALE_MS - 1)).toBe("as8374");
    expect(currentNetworkId(t + NETWORK_STALE_MS + 1)).toBe(NET_UNKNOWN);
  });

  it("still names the network on screen, because that is a different question", () => {
    const t = 1_000_000;
    noteNetworkId("as8374", t);
    expect(currentNetwork()?.net).toBe("as8374");
    expect(networkIsStale(t + NETWORK_STALE_MS + 1)).toBe(true);
  });

  it("is stale before any answer at all", () => {
    expect(currentNetworkId()).toBe(NET_UNKNOWN);
    expect(networkIsStale()).toBe(true);
  });

  it("a fresh stamp un-stales it", () => {
    const t = 1_000_000;
    noteNetworkId("as8374", t);
    noteNetworkId("as8374", t + NETWORK_STALE_MS + 1_000);
    expect(currentNetworkId(t + NETWORK_STALE_MS + 1_100)).toBe("as8374");
  });
});

describe("remembering the network across tabs", () => {
  it("round-trips through storage", () => {
    const s = memStorage();
    writeStoredNetwork(pl, s);
    expect(readStoredNetwork(s)).toEqual(pl);
  });

  it("returns nothing rather than raising on a corrupt entry", () => {
    const s = memStorage();
    s.setItem(NETWORK_STORAGE_KEY, "{not json");
    expect(readStoredNetwork(s)).toBeNull();
  });

  it("names the network for a fresh tab, but does not attribute to it yet", () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify(pl));
    resetNetworkState();
    // A stored network says what to DISPLAY. Attribution waits for a live
    // answer, because the tab may have been closed on another continent.
    expect(currentNetwork()?.net).toBe("as8374");
    expect(currentNetworkId()).toBe(NET_UNKNOWN);
  });
});

describe("asking the server directly", () => {
  it("stores the answer and starts attributing to it", async () => {
    const { fn, calls } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    await refreshNetwork({ force: true });
    expect(calls[0]).toContain("/netinfo");
    expect(currentNetworkId()).toBe("as8374");
    expect(readStoredNetwork()?.label).toBe("Polkomtel");
  });

  it("records the name where a later month can still read it", async () => {
    vi.stubGlobal("fetch", fakeFetch({ ...pl }).fn);
    await refreshNetwork({ force: true });
    await Promise.resolve();
    // The directory has to outlive being on the network: a trip is read from
    // somewhere else entirely.
    await vi.waitFor(() => expect(readStore().nets["as8374"]?.label).toBe("Polkomtel"));
    expect(readStore().nets["as8374"]?.cc).toBe("PL");
    expect(localStorage.getItem(USAGE_STORAGE_KEY)).toContain("Polkomtel");
  });

  it("joins an ordinary call to a request already in flight", async () => {
    const { fn } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    await Promise.all([refreshNetwork({ force: true }), refreshNetwork(), refreshNetwork()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lets the newest overlapping answer win, whatever order they arrive in", async () => {
    // The slow first request went over the link the device has just left, so
    // its answer must not land on top of the newer one.
    const replies: NetworkInfo[] = [pl, lan];
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
    resolvers[1]?.();
    resolvers[0]?.();
    await Promise.all([first, second]);
    expect(currentNetwork()?.net).toBe("lan");
  });

  it.each([
    ["the request fails", () => vi.fn(async () => { throw new Error("offline"); })],
    ["the server errors", () => fakeFetch({}, false).fn],
    ["the reply is malformed", () => fakeFetch({ nonsense: true }).fn],
  ])("keeps the last known network when %s", async (_name, broken) => {
    vi.stubGlobal("fetch", fakeFetch({ ...pl }).fn);
    await refreshNetwork({ force: true });
    vi.stubGlobal("fetch", broken());
    await refreshNetwork({ force: true });
    expect(currentNetwork()?.net).toBe("as8374");
  });

  it("tells subscribers when the network changes, and not when it repeats", async () => {
    const seen: (string | undefined)[] = [];
    onNetworkChange((info) => seen.push(info?.net));
    vi.stubGlobal("fetch", fakeFetch({ ...pl }).fn);
    await refreshNetwork({ force: true });
    await refreshNetwork({ force: true });
    expect(seen).toEqual(["as8374"]);

    vi.stubGlobal("fetch", fakeFetch({ ...lan }).fn);
    await refreshNetwork({ force: true });
    expect(seen).toEqual(["as8374", "lan"]);
  });
});

describe("watching for a network change", () => {
  function handlers() {
    const h: Record<string, () => void> = {};
    const on = (k: string, fn: () => void) => void (h[k] = fn);
    const off = (k: string) => void delete h[k];
    return { h, target: { addEventListener: on, removeEventListener: off } };
  }

  it("asks at start and on the events that correlate with a move", async () => {
    const { fn } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    const { h, target } = handlers();
    const doc = { ...target, visibilityState: "visible" as DocumentVisibilityState };

    const stop = startNetworkWatch(target as unknown as Window, doc as unknown as Document);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    // Both matter because the hot path — the /sessions poll — is parked while
    // the tab is hidden, so the first answer after a wake must not wait for it.
    h.online?.();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);

    h.visibilitychange?.();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(3);

    stop();
    expect(Object.keys(h)).toHaveLength(0);
  });

  it("ignores a visibility change to hidden", async () => {
    const { fn } = fakeFetch({ ...pl });
    vi.stubGlobal("fetch", fn);
    const { h, target } = handlers();
    const doc = { ...target, visibilityState: "hidden" as DocumentVisibilityState };
    startNetworkWatch(undefined, doc as unknown as Document);
    await Promise.resolve();
    const before = fn.mock.calls.length;
    h.visibilitychange?.();
    await Promise.resolve();
    expect(fn.mock.calls.length).toBe(before);
  });
});
