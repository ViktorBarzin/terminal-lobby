import { describe, it, expect, vi } from "vitest";
import {
  BUILD_SUBSTRING,
  MAX_UPDATE_ATTEMPTS,
  RESUME_AWAY_MS,
  STORM_WINDOW_MS,
} from "../src/deploy/healer.logic";
import {
  STORM_KEY,
  UPDATE_KEY,
  createDeployHealer,
  logBuildId,
  type DeployHealerDeps,
} from "../src/deploy/healer";

function resp(ok: boolean, body: string): Response {
  return { ok, text: async () => body } as unknown as Response;
}
/** A served page: `asset` is the update identity, `build` the provenance SHA. */
const page = (asset: string, build = "aaaaaaa"): string =>
  `<!doctype html><html><head><meta name="tl-asset" content="${asset}"></head>` +
  `<body><script>console.log("${BUILD_SUBSTRING}","${build}")</script></body></html>`;
const AUTH_WALL = `<!doctype html><title>Sign in</title>`;
const ASSET_A = "aaaaaaaaaaaa";
const ASSET_B = "bbbbbbbbbbbb";

interface Harness {
  healer: ReturnType<typeof createDeployHealer>;
  reload: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  listeners: Map<string, (e: Event) => void>;
  store: Map<string, string>;
  setBody: (body: string) => void;
  setOk: (ok: boolean) => void;
  setAttached: (v: boolean) => void;
  setHidden: (v: boolean) => void;
  setFocused: (v: boolean) => void;
  setNow: (v: number) => void;
  now: () => number;
  fire: (type: string, ev?: Event) => void;
}

function harness(over: Partial<DeployHealerDeps> = {}): Harness {
  let attached = false;
  let hidden = false;
  let focused = true;
  let nowVal = 1_000_000;
  let body = page(ASSET_A);
  let ok = true;
  const store = new Map<string, string>();
  const listeners = new Map<string, (e: Event) => void>();
  const reload = vi.fn();
  const emit = vi.fn();
  const fetchImpl = vi.fn(async () => resp(ok, body));
  const target = {
    addEventListener: (t: string, cb: EventListenerOrEventListenerObject) =>
      listeners.set(t, cb as (e: Event) => void),
    removeEventListener: (t: string) => listeners.delete(t),
  };

  const healer = createDeployHealer({
    hasAttachedTerminal: () => attached,
    assetId: () => ASSET_A,
    isHidden: () => hidden,
    isFocused: () => focused,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    selfUrl: () => "/",
    reload,
    now: () => nowVal,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    doc: target,
    win: target,
    autostart: false,
    log: () => {},
    emit,
    ...over,
  });

  return {
    healer,
    reload,
    fetchImpl,
    emit,
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
    setFocused: (v) => {
      focused = v;
    },
    setNow: (v) => {
      nowVal = v;
    },
    now: () => nowVal,
    fire: (type, ev) => listeners.get(type)?.(ev ?? new Event(type)),
  };
}

describe("createDeployHealer — a deploy that did not change the frontend is NOT an update", () => {
  it("THE REGRESSION: different bytes, same asset id → no reload, ever", async () => {
    const h = harness();
    // A backend-only deploy: the git SHA inside the page moved, the frontend did
    // not. Under the old whole-body hash this raised the pill on every client.
    h.setBody(page(ASSET_A, "zzzzzzz"));
    for (let i = 0; i < 10; i++) await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("twenty background/foreground cycles on an unchanged build produce nothing", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    for (let i = 0; i < 20; i++) {
      h.setNow(h.now() + 30_000);
      h.setHidden(true);
      h.fire("visibilitychange");
      h.setNow(h.now() + 30_000);
      h.setHidden(false);
      h.fire("visibilitychange");
    }
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    expect(h.reload).not.toHaveBeenCalled();
    h.healer.dispose();
  });
});

describe("createDeployHealer — applying an update", () => {
  it("reloads immediately when no terminal is attached", async () => {
    const h = harness();
    h.setBody(page(ASSET_B));
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.store.get(STORM_KEY)).toBeTruthy();
  });

  it("detection is idempotent: ten more ticks after a detection reload exactly once", async () => {
    const h = harness();
    h.setBody(page(ASSET_B));
    for (let i = 0; i < 10; i++) await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("DEFERS silently while a terminal is attached on a visible, focused page", async () => {
    const h = harness();
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("never navigates a hidden document — the hide path does NOT reload", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    await h.healer.checkNow(); // deferred
    h.setHidden(true);
    h.fire("visibilitychange");
    await vi.waitFor(() => expect(h.reload).not.toHaveBeenCalled());
    expect(h.reload).not.toHaveBeenCalled();
    h.healer.dispose();
  });

  it("applies on THE NEXT OPEN: hidden ≥5s, then visible → exactly one reload", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    h.setHidden(true);
    h.fire("visibilitychange");
    h.setNow(h.now() + RESUME_AWAY_MS);
    h.setHidden(false);
    h.fire("visibilitychange");
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
    h.healer.dispose();
  });

  it("a momentary flick away (<5s) is not an open — it stays deferred", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    h.setHidden(true);
    h.fire("visibilitychange");
    h.setNow(h.now() + RESUME_AWAY_MS - 1);
    h.setHidden(false);
    h.fire("visibilitychange");
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    expect(h.reload).not.toHaveBeenCalled();
    h.healer.dispose();
  });

  it("a desktop window blur/focus past the grace is an open too (no visibilitychange fires)", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    h.setFocused(false);
    h.fire("blur");
    h.setNow(h.now() + RESUME_AWAY_MS);
    h.setFocused(true);
    h.fire("focus");
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
    h.healer.dispose();
  });

  it("a bfcache restore is always an open", async () => {
    const h = harness({ autostart: true });
    h.setAttached(true);
    h.setBody(page(ASSET_B));
    h.fire("pageshow", Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
    h.healer.dispose();
  });

  it("an auth wall is never read as a new build", async () => {
    const h = harness();
    h.setBody(AUTH_WALL);
    await h.healer.checkNow();
    h.setOk(false);
    await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("skips the self-check entirely while the tab is hidden", async () => {
    const h = harness();
    h.setHidden(true);
    await h.healer.checkNow();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createDeployHealer — confirmation, not fire-and-forget", () => {
  it("records the target it is reloading towards before navigating", async () => {
    const h = harness();
    h.setBody(page(ASSET_B));
    await h.healer.checkNow();
    const rec = JSON.parse(h.store.get(UPDATE_KEY) as string);
    expect(rec.target).toBe(ASSET_B);
    expect(rec.from).toBe(ASSET_A);
    expect(rec.n).toBe(1);
  });

  it("on boot, a landed update clears the record and reports itself once", () => {
    const h = harness({ autostart: false });
    h.store.set(UPDATE_KEY, JSON.stringify({ target: ASSET_A, from: "old000000000", at: 1, n: 1 }));
    h.healer.confirmBoot();
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith("app.reloaded", {
      "tl.reason": "update",
      "tl.from": "old000000000",
      "tl.to": ASSET_A,
    });
    expect(h.store.has(UPDATE_KEY)).toBe(false);
  });

  it("on boot, a reload that did not land keeps the count and stays quiet", () => {
    const h = harness();
    h.store.set(UPDATE_KEY, JSON.stringify({ target: ASSET_B, from: ASSET_A, at: 1, n: 1 }));
    h.healer.confirmBoot();
    expect(h.emit).not.toHaveBeenCalled();
    expect(JSON.parse(h.store.get(UPDATE_KEY) as string).n).toBe(1);
  });

  it("gives up after MAX_UPDATE_ATTEMPTS: reports once, then stops reloading", async () => {
    const h = harness();
    h.store.set(
      UPDATE_KEY,
      JSON.stringify({ target: ASSET_B, from: ASSET_A, at: 1, n: MAX_UPDATE_ATTEMPTS }),
    );
    h.healer.confirmBoot();
    expect(h.emit).toHaveBeenCalledWith("app.update_failed", {
      "tl.to": ASSET_B,
      "tl.count": MAX_UPDATE_ATTEMPTS,
    });

    h.setBody(page(ASSET_B));
    for (let i = 0; i < 5; i++) await h.healer.checkNow();
    expect(h.reload).not.toHaveBeenCalled();
    // and it reports the failure exactly once, not on every boot
    h.healer.confirmBoot();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("a NEWER build resets the attempt count — give-up is per target", async () => {
    const h = harness();
    h.store.set(
      UPDATE_KEY,
      JSON.stringify({ target: ASSET_B, from: ASSET_A, at: 1, n: MAX_UPDATE_ATTEMPTS }),
    );
    h.setBody(page("cccccccccccc"));
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("createDeployHealer — tl-build-stale bridge routing", () => {
  it("routes a terminal's build-stale signal into one check, not a reload", async () => {
    const h = harness();
    h.setBody(page(ASSET_B));
    h.healer.onBuildStale();
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));
  });

  it("ten reconnect signals in a row still produce at most one reload", async () => {
    const h = harness();
    h.setBody(page(ASSET_B));
    for (let i = 0; i < 10; i++) h.healer.onBuildStale();
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalled());
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("createDeployHealer — no update UI exists any more", () => {
  it("exposes no pill state and no manual apply", () => {
    const h = harness();
    const surface = h.healer as unknown as Record<string, unknown>;
    expect(surface.updateReady).toBeUndefined();
    expect(surface.applyUpdate).toBeUndefined();
  });
});

describe("createDeployHealer — storm backstop", () => {
  it("caps auto reloads at one per window, then allows again", async () => {
    const start = 1_000_000;
    const h = harness();
    h.setNow(start);
    h.setBody(page(ASSET_B));
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);

    h.setNow(start + STORM_WINDOW_MS - 1);
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(1);

    h.setNow(start + STORM_WINDOW_MS);
    h.store.delete(UPDATE_KEY); // a fresh attempt at the same target
    await h.healer.checkNow();
    expect(h.reload).toHaveBeenCalledTimes(2);
  });
});

describe("createDeployHealer — autostart wiring", () => {
  it("registers the resume listeners on start and drops them on dispose", async () => {
    const h = harness({ autostart: true });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled());
    expect(h.listeners.has("visibilitychange")).toBe(true);
    expect(h.listeners.has("pageshow")).toBe(true);
    expect(h.listeners.has("focus")).toBe(true);
    expect(h.listeners.has("blur")).toBe(true);
    h.healer.dispose();
    expect(h.listeners.has("visibilitychange")).toBe(false);
    expect(h.listeners.has("focus")).toBe(false);
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
