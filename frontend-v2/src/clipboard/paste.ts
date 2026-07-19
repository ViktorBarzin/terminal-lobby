/**
 * Paste-path image discrimination (feature-inventory Cat.4 "Paste path"). Pure
 * so the image-vs-text decision is unit-tested; the DOM listener that consumes
 * it lives in clipboard/attach.ts.
 */

/** The subset of DataTransferItem the classifier reads (test-friendly). */
export interface PasteItemLike {
  readonly type: string;
  getAsFile(): File | null;
}

/**
 * The first image blob among the paste's clipboard items, or null when the
 * paste carries no usable image. An image paste is intercepted (uploaded, its
 * path typed into the pty); a null result means "text/other" — the listener
 * lets it pass through to the focused field (composer) or the browser default.
 *
 * Robust to the platform quirks the vanilla path handled: an item may advertise
 * an image type but hand back a null file, so we skip to the next candidate
 * rather than treating the whole paste as an image.
 */
export function firstImageBlob(
  items: ArrayLike<PasteItemLike> | null | undefined,
): File | null {
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item.type !== "string") continue;
    if (!item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (blob) return blob;
  }
  return null;
}
