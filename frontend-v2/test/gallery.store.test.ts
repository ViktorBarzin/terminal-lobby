import { describe, it, expect, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createGalleryStore, type GalleryStore } from "../src/store/gallery";
import type { StoredImage } from "../src/store/gallery.logic";
import { track } from "../src/telemetry/track";

vi.mock("../src/telemetry/track", () => ({ track: vi.fn() }));

const img = (name: string, mtime: number, kind = "pasted"): StoredImage => ({
  name,
  path: "/store/u/s/" + name,
  size: 1,
  mtime,
  kind,
});

/** run body in a reactive root; returns [store, dispose]. */
function withStore(
  deps: Parameters<typeof createGalleryStore>[0],
): [GalleryStore, () => void] {
  let store!: GalleryStore;
  const dispose = createRoot((d) => {
    store = createGalleryStore(deps);
    return d;
  });
  return [store, dispose];
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("gallery store — open + fetch", () => {
  it("open() shows the grid, then fetches + sorts newest-first", async () => {
    const list = [img("a", 100), img("b", 300, "displayed"), img("c", 200)];
    const [g, dispose] = withStore({
      session: () => "sess",
      fetchList: async () => list,
    });
    expect(g.view()).toBe("closed");

    const p = g.open();
    expect(g.view()).toBe("grid");
    expect(g.status()).toBe("loading");

    await p;
    expect(g.status()).toBe("idle");
    expect(g.session()).toBe("sess");
    expect(g.images().map((x) => x.name)).toEqual(["b", "c", "a"]);
    dispose();
  });

  it("open() with no session notifies and stays closed", async () => {
    const notify = vi.fn();
    const [g, dispose] = withStore({
      session: () => null,
      notify,
      fetchList: async () => [],
    });
    await g.open();
    expect(g.view()).toBe("closed");
    expect(notify).toHaveBeenCalledWith("Open a session first", "error");
    dispose();
  });

  it("surfaces a fetch failure as status=error, keeping the grid (note)", async () => {
    const [g, dispose] = withStore({
      session: () => "s",
      fetchList: async () => {
        throw new Error("HTTP 500");
      },
    });
    await g.open();
    expect(g.status()).toBe("error");
    expect(g.error()).toBe("HTTP 500");
    expect(g.view()).toBe("grid");
    dispose();
  });
});

describe("gallery store — lightbox step-back state", () => {
  it("grid → lightbox → grid → closed", async () => {
    const [g, dispose] = withStore({
      session: () => "s",
      fetchList: async () => [img("a", 1), img("b", 2), img("c", 3)],
    });
    await g.open();
    expect(g.view()).toBe("grid");

    g.openLightbox(1);
    expect(g.view()).toBe("lightbox");
    expect(g.lightboxIndex()).toBe(1);

    g.stepBack();
    expect(g.view()).toBe("grid");

    g.stepBack();
    expect(g.view()).toBe("closed");
    dispose();
  });

  it("openLightbox is a no-op out of range or when not on the grid", async () => {
    const [g, dispose] = withStore({
      session: () => "s",
      fetchList: async () => [img("a", 1), img("b", 2)],
    });
    await g.open();
    g.openLightbox(5); // out of range
    expect(g.view()).toBe("grid");

    g.close();
    g.openLightbox(0); // not on the grid
    expect(g.view()).toBe("closed");
    dispose();
  });
});

describe("gallery store — session switch closes it", () => {
  it("closes when the selected session changes out from under it", async () => {
    let setSel!: (v: string | null) => void;
    let g!: GalleryStore;
    const dispose = createRoot((d) => {
      const [sel, s] = createSignal<string | null>("s1");
      setSel = s;
      g = createGalleryStore({
        session: sel,
        fetchList: async () => [img("a", 1)],
      });
      return d;
    });
    await g.open();
    await tick(); // let the session-watch effect settle on s1
    expect(g.view()).toBe("grid");

    setSel("s2");
    await tick(); // effect reacts to the new session
    expect(g.view()).toBe("closed");
    dispose();
  });
});

describe("gallery store — image_opened telemetry fires only on a real open", () => {
  it("does NOT emit gallery.image_opened for a rejected open", async () => {
    vi.mocked(track).mockClear();
    const [g, dispose] = withStore({
      session: () => "s",
      fetchList: async () => [img("a", 1), img("b", 2)],
    });
    await g.open();
    g.openLightbox(5); // out of range → rejected
    g.close();
    g.openLightbox(0); // not on the grid → rejected
    expect(vi.mocked(track)).not.toHaveBeenCalledWith(
      "gallery.image_opened",
      expect.anything(),
    );
    dispose();
  });

  it("emits gallery.image_opened once, with the index, for a valid open", async () => {
    vi.mocked(track).mockClear();
    const [g, dispose] = withStore({
      session: () => "s",
      fetchList: async () => [img("a", 1), img("b", 2)],
    });
    await g.open();
    g.openLightbox(1);
    expect(vi.mocked(track)).toHaveBeenCalledWith("gallery.image_opened", {
      "tl.count": 1,
    });
    dispose();
  });
});
