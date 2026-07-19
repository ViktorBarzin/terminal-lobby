/**
 * PURE gallery logic (feature-inventory Cat.8 "Session image gallery overlay" +
 * "Shared lightbox"). DOM-free, unit-tested. The Solid store (gallery.ts) and
 * the Gallery component consume these; keeping the sort/badge/step-back rules
 * here makes them testable without a DOM or the network.
 */

/**
 * One /clipboard/list entry, mirroring the clipboard-upload service's
 * `storedImage` JSON (clipboard-upload/main.go). `kind` is derived server-side
 * from the filename prefix: "displayed" for show-image renders (displayed-*),
 * "pasted" for clipboard pastes/uploads (and legacy names).
 */
export interface StoredImage {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: string;
}

/**
 * Newest-first by mtime (seconds since epoch), descending. The server already
 * sorts this way, but re-sorting client-side is a cheap robustness guard (a
 * future endpoint change, a merged list) and keeps the ordering an explicit,
 * tested property. Stable for equal mtimes (Array.prototype.sort is stable),
 * so same-second pastes keep their server order. Non-mutating.
 */
export function sortNewestFirst(images: readonly StoredImage[]): StoredImage[] {
  return [...images].sort((a, b) => b.mtime - a.mtime);
}

/**
 * The corner badge for a thumbnail, or null for none. show-image renders
 * ("displayed") are badged "shown"; clipboard pastes/uploads carry no badge.
 */
export function badgeLabel(image: StoredImage): string | null {
  return image.kind === "displayed" ? "shown" : null;
}

/**
 * The gallery's three-state view machine. "closed" is the resting state;
 * opening shows the "grid"; a thumbnail click enlarges into the "lightbox".
 */
export type GalleryView = "closed" | "grid" | "lightbox";

/**
 * One step back out of the current view: the lightbox lands back on the grid,
 * the grid closes, and a closed gallery stays closed. This is what Escape and a
 * backdrop/lightbox click both do — the lightbox never jumps straight to
 * closed, it steps back to the grid it was opened from.
 */
export function stepBack(view: GalleryView): GalleryView {
  switch (view) {
    case "lightbox":
      return "grid";
    case "grid":
      return "closed";
    case "closed":
      return "closed";
  }
}
