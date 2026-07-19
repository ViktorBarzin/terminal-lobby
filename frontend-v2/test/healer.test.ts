import { describe, it, expect, vi } from "vitest";
import {
  BUILD_SUBSTRING,
  STORM_WINDOW_MS,
} from "../src/deploy/healer.logic";
import {
  STORM_KEY,
  createDeployHealer,
  logBuildId,
  type DeployHealerDeps,
} from "../src/deploy/healer";

function resp(ok: boolean, body: string): Response {
  return { ok, text: async () => body } as unknown as Response;
}
const PAGE_A = `<!doctype html><script>console.log("${BUILD_SUBSTRING}","aaaaaaa")</script>`;
const PAGE_B = `<!doctype html><script>console.log("${BUILD_SUBSTRING}","bbbbbbb")</script>`;
const AUTH_WALL = `<!doctype html><title>Sign in</title>`;

interface Harness {
  healer: ReturnType<typeof createDeployHealer>;
  reload: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
  listeners: Map<string, (e: Event) => void>;
  store: Map<string, string>;
  setBody: (body: string) => void;
  setOk: (ok: boolean) => void;
  setAttached: (v: boolean) => void;
  setHidden: (v: boolean) => void;
  setNow: (v: number) => void;
}

function harness(over: Partial<DeployHealerDeps> = {}): Harness {
  let attached = false;
  let hidden = false;
  let nowVal = 1_000_000;
  let body = PAGE_A;
  let ok = true;
  const store = new Map<string, string>();
  const listeners = new Map<string, (e: Event) => void>();
  const reload = vi.fn();
  const fetchImpl = vi.fn(async () => resp(ok, body));
  const target = {
    addEventListener: (t: string, cb: EventListenerOrEventListenerObject) =>
      listeners.set(t, cb as (e: Event) => void),
    removeEventListener: (t: string) => listeners.delete(t),
  };

  const healer = createDeployHealer({
    hasAttachedTerminal: () => attached,
    isHidden: () => hidden,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    selfUrl: () => "/",
    reload,
    now: () => nowVal,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
    doc: target,
    win: target,
    autostart: false,
    log: () => {},
    ...over,
  });

  return {
    healer,
    reload,
    fetchImpl,
    listeners,
    store,
    setBody: (b) => {
      body = b;
    },
    setOk: (v) => {
      ok = v;
    },
    setAttached: (v) => {
      attached = v;
    },
    setHidden: (v) => {
      hidden = v;
    },
    setNow: (v) => {
      nowVal = v;
    },
  };
}

describe("createDeployHealer — baseline + stale detection", () => {
  it("does NOT reload when the served bytes are unchanged", async () => {
    const h = harness();
    await h.healer.armBaseline();
    await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("reloads immediately when the bytes change and no terminal is attached", async () => {
    const h = harness();
    h.setAttached(false);
    await h.healer.armBaseline(); // baseline = PAGE_A
    h.setBody(PAGE_B); // a deploy landed
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // the storm timestamp was recorded
    expect(h.store.get(STORM_KEY)).toBeTruthy();
  });

  it("raises the sticky pill (no reload) when a terminal is attached + visible", async () => {
    const h = harness();
    h.setAttached(true);
    h.setHidden(false);
    await h.healer.armBaseline();
    h.setBody(PAGE_B);
    await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.healer.updateReady()).toBe(true);
  });

  it("skips the self-check entirely while the tab is hidden", async () => {
    const h = harness();
    await h.healer.armBaseline();
    h.fetchImpl.mockClear();
    h.setHidden(true);
    await h.healer.checkNow();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createDeployHealer — baseline gating (auth wall never becomes the baseline)", () => {
  it("does not arm from a markerless page and cannot then false-fire", async () => {
    const h = harness();
    h.setBody(AUTH_WALL); // markerless — fetchSelf returns null
    await h.healer.armBaseline();
    // bootHash stayed null; a checkNow re-arms (does NOT reload) even though the
    // real page now differs from the (never-set) baseline.
    h.setBody(PAGE_A);
    await h.healer.checkNow(); // re-arms to PAGE_A
    expect(h.reload).not.toHaveBeenCalled();
    // now a genuine change is detected
    h.setBody(PAGE_B);
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("createDeployHealer — storm throttle window", () => {
  it("caps AUTO reloads at one per window, then allows again after it", async () => {
    const start = 1_000_000;
    const h = harness();
    h.setAttached(false);
    h.setNow(start);
    await h.healer.armBaseline();
    h.setBody(PAGE_B);

    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1); // first fires

    h.setNow(start + STORM_WINDOW_MS - 1);
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1); // inside window → throttled

    h.setNow(start + STORM_WINDOW_MS);
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(2); // window elapsed → fires again
  });
});

describe("createDeployHealer — tl-build-stale bridge routing", () => {
  it("routes a terminal's build-stale signal to an immediate reload when no viewer is active", () => {
    const h = harness();
    h.setAttached(false);
    h.healer.onBuildStale();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("routes a build-stale signal to the sticky pill while a terminal is attached + visible", () => {
    const h = harness();
    h.setAttached(true);
    h.setHidden(false);
    h.healer.onBuildStale();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.healer.updateReady()).toBe(true);
  });

  it("de-dupes a second build-stale signal while the pill is already up", () => {
    const h = harness();
    h.setAttached(true);
    h.healer.onBuildStale();
    h.healer.onBuildStale();
    expect(h.healer.updateReady()).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe("createDeployHealer — the 'Update ready' pill", () => {
  it("applyUpdate reloads immediately and is NEVER storm-gated", () => {
    const start = 1_000_000;
    const h = harness();
    h.setNow(start);
    // Simulate a very recent auto reload so the storm gate WOULD block an auto one.
    h.store.set(STORM_KEY, String(start));
    h.setAttached(true);
    h.healer.onBuildStale(); // pill up
    expect(h.healer.updateReady()).toBe(true);

    h.healer.applyUpdate(); // explicit tap
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.healer.updateReady()).toBe(false);
  });
});

describe("createDeployHealer — deferred fire on hide + resume re-check", () => {
  it("fires a pending update the moment the tab hides (storm allowing) and lowers the pill", () => {
    const start = 1_000_000;
    const h = harness({ autostart: true }); // start() registers the listeners
    h.setNow(start);
    h.setAttached(true);
    h.setHidden(false);
    h.healer.onBuildStale(); // defer → pill up
    expect(h.healer.updateReady()).toBe(true);

    const onVis = h.listeners.get("visibilitychange");
    expect(onVis).toBeTypeOf("function");
    h.setHidden(true);
    onVis?.(new Event("visibilitychange"));
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.healer.updateReady()).toBe(false);
    h.healer.dispose();
  });

  it("a hidden pending update stays deferred while storm-gated", () => {
    const start = 1_000_000;
    const h = harness({ autostart: true });
    h.setNow(start);
    h.store.set(STORM_KEY, String(start)); // an auto reload just happened
    h.setAttached(true);
    h.healer.onBuildStale(); // pill up
    const onVis = h.listeners.get("visibilitychange");
    h.setHidden(true);
    onVis?.(new Event("visibilitychange"));
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.healer.updateReady()).toBe(true); // still armed for the next chance
    h.healer.dispose();
  });

  it("re-checks for a deploy on resume (tab becomes visible)", async () => {
    const h = harness({ autostart: true });
    await h.healer.armBaseline();
    const onVis = h.listeners.get("visibilitychange");
    h.fetchImpl.mockClear();
    h.setHidden(false);
    onVis?.(new Event("visibilitychange"));
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    h.healer.dispose();
  });

  it("registers a pageshow (bfcache) listener that re-checks when persisted", async () => {
    const h = harness({ autostart: true });
    await h.healer.armBaseline();
    const onShow = h.listeners.get("pageshow");
    expect(onShow).toBeTypeOf("function");
    h.fetchImpl.mockClear();
    const ev = Object.assign(new Event("pageshow"), { persisted: true });
    onShow?.(ev);
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    h.healer.dispose();
  });
});

describe("createDeployHealer — autostart wiring", () => {
  it("arms the baseline + registers listeners on start", async () => {
    const h = harness({ autostart: true });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    expect(h.listeners.has("visibilitychange")).toBe(true);
    expect(h.listeners.has("pageshow")).toBe(true);
    h.healer.dispose();
    expect(h.listeners.has("visibilitychange")).toBe(false);
  });
});

describe("logBuildId", () => {
  it("logs the marker substring verbatim + stamps dataset.tlBuild", () => {
    const log = vi.fn();
    const el = { dataset: {} as Record<string, string> };
    const fakeDoc = { documentElement: el } as unknown as Document;
    logBuildId("cafef00d", log, fakeDoc);
    expect(log).toHaveBeenCalledWith(BUILD_SUBSTRING, "cafef00d");
    expect(el.dataset.tlBuild).toBe("cafef00d");
  });
});
