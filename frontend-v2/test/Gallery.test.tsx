import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createRoot, createSignal, type Accessor } from "solid-js";
import { Gallery } from "../src/components/Gallery";
import type { GalleryStore, GalleryStatus } from "../src/store/gallery";
import type { GalleryView, StoredImage } from "../src/store/gallery.logic";

/**
 * Gallery view tests for the broken-thumbnail fallback.
 *
 * The bug: /upload accepted bytes that are not an image (and a truncated PNG
 * still passes the server's sniff by design), so the store can hold files the
 * browser cannot decode. The gallery drew each one as a 141x141 cell with
 * naturalWidth 0 — a blank tile, indistinguishable from a slow load, with no
 * delete control to clear it. jsdom never loads images, so the load failure is
 * driven the way the browser signals it: an `error` event on the <img>.
 */

const img = (name: string, kind = "pasted"): StoredImage => ({
  name,
  path: `/var/lib/clipboard-store/u/s/${name}`,
  size: 40,
  mtime: 1_700_000_000,
  kind,
});

/**
 * A hand-built store standing in for createGalleryStore: the component is a
 * pure view, and driving it directly keeps these tests about rendering rather
 * than about the fetch machine (gallery.store.test.ts owns that).
 */
function stubStore(
  images: StoredImage[],
  view: GalleryView = "grid",
): { store: GalleryStore; dispose: () => void; setView: (v: GalleryView) => void } {
  let store!: GalleryStore;
  let setView!: (v: GalleryView) => void;
  const dispose = createRoot((d) => {
    const [v, sv] = createSignal<GalleryView>(view);
    const [lightboxIndex, setLightboxIndex] = createSignal(0);
    setView = (next) => sv(next);
    store = {
      view: v,
      images: (() => images) as Accessor<StoredImage[]>,
      status: (() => "idle") as Accessor<GalleryStatus>,
      error: () => null,
      session: () => "qa-vimg3",
      lightboxIndex,
      open: async () => {},
      openLightbox: (i: number) => {
        setLightboxIndex(i);
        sv("lightbox");
      },
      stepBack: () => sv("grid"),
      close: () => sv("closed"),
    };
    return d;
  });
  return { store, dispose, setView };
}

/** Every rendered thumbnail cell, in order. */
const cells = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".tl-gallery-cell"));

/** The i-th thumbnail cell, asserted present. */
function cell(root: HTMLElement, i = 0): HTMLElement {
  const el = cells(root)[i];
  if (!el) throw new Error(`no gallery cell at index ${i}`);
  return el;
}

/** The <img> inside an element, asserted present. */
function imgIn(el: Element): HTMLImageElement {
  const found = el.querySelector("img");
  if (!found) throw new Error("expected an <img> here");
  return found;
}

/** The open lightbox overlay, asserted present. */
function lightbox(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>(".tl-lightbox");
  if (!el) throw new Error("lightbox is not open");
  return el;
}

describe("<Gallery> — a file the browser cannot decode", () => {
  it("replaces a thumbnail that fails to load with a labelled placeholder, not a blank tile", () => {
    const { store, dispose } = stubStore([img("trunc.png"), img("good.png")]);
    const { container } = render(() => <Gallery store={store} />);

    const bad = cell(container, 0);
    const good = cell(container, 1);
    // Before the failure both cells hold an <img>: nothing is pre-judged.
    expect(imgIn(bad)).toBeTruthy();

    fireEvent.error(imgIn(bad));

    // The dead <img> is gone — that element is what measured naturalWidth 0.
    expect(bad.querySelector("img")).toBeNull();
    // ...and the cell is not empty: it names the file that could not be drawn.
    expect(bad.textContent).toContain("trunc.png");
    // The healthy neighbour is untouched.
    expect(good.querySelector("img")).toBeTruthy();

    dispose();
  });

  it("keeps the placeholder cell clickable and marks it for assistive tech", () => {
    const { store, dispose } = stubStore([img("trunc.png")]);
    const { container } = render(() => <Gallery store={store} />);

    const tile = cell(container);
    fireEvent.error(imgIn(tile));

    // Still the same <button>: keyboard focus order and the grid layout hold.
    expect(tile.tagName).toBe("BUTTON");
    // The failure is announced, not just drawn.
    expect(tile.getAttribute("title")).toContain("trunc.png");
    expect(container.querySelector(".tl-gallery-broken")).toBeTruthy();

    dispose();
  });

  it("keeps the 'shown' badge on a broken show-image render", () => {
    // A show-image register can put an unreadable file in the store too; losing
    // the badge would misreport where the file came from.
    const { store, dispose } = stubStore([img("displayed-x.png", "displayed")]);
    const { container } = render(() => <Gallery store={store} />);

    fireEvent.error(imgIn(cell(container)));

    expect(container.querySelector(".tl-gallery-badge")?.textContent).toBe("shown");
    dispose();
  });

  it("falls back in the lightbox too, so a broken tile does not open a blank overlay", () => {
    const { store, dispose } = stubStore([img("trunc.png")]);
    const { container } = render(() => <Gallery store={store} />);

    // Open the lightbox WITHOUT the grid thumbnail having failed first: with
    // loading="lazy" an off-screen thumbnail may never have been fetched, so
    // the lightbox has to discover the failure on its own.
    fireEvent.click(cell(container));
    const overlay = lightbox(container);

    fireEvent.error(imgIn(overlay));

    expect(overlay.querySelector("img")).toBeNull();
    expect(overlay.textContent).toContain("trunc.png");
    dispose();
  });

  it("a thumbnail failure carries over to the lightbox for the same file", () => {
    const { store, dispose } = stubStore([img("trunc.png")]);
    const { container } = render(() => <Gallery store={store} />);

    fireEvent.error(imgIn(cell(container)));
    fireEvent.click(cell(container));

    const overlay = lightbox(container);
    expect(overlay.querySelector("img")).toBeNull();
    expect(overlay.textContent).toContain("trunc.png");
    dispose();
  });

  it("a healthy gallery still renders plain <img> thumbnails", () => {
    // Guard against a fallback that fires unprompted and hides working images.
    const { store, dispose } = stubStore([img("a.png"), img("b.png")]);
    const { container } = render(() => <Gallery store={store} />);

    expect(container.querySelectorAll(".tl-gallery-cell img")).toHaveLength(2);
    expect(container.querySelector(".tl-gallery-broken")).toBeNull();
    dispose();
  });
});
