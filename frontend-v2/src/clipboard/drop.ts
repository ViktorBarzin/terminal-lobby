/**
 * Drag-and-drop file detection (feature-inventory Cat.1 "Drop-target overlay" +
 * Cat.8 "Drag-and-drop file upload"). Pure so file detection is unit-tested;
 * the window listeners + overlay wiring live in clipboard/attach.ts.
 */

/** The subset of DataTransfer the detector reads (types is the only field). */
export interface DataTransferLike {
  readonly types: ReadonlyArray<string> | DOMStringList | null;
}

/**
 * Whether a drag carries files (vs. text/HTML/a dragged element). Only a
 * file-bearing drag raises the drop overlay and triggers an upload; the
 * unconditional dragover/drop preventDefault (which stops the browser from
 * navigating to a dropped file) is the caller's job and runs regardless.
 *
 * dataTransfer.types is a DOMStringList in some browsers and a plain array in
 * others, so both shapes are probed — exactly the vanilla dragHasFiles guard.
 */
export function dragHasFiles(dt: DataTransferLike | null | undefined): boolean {
  const types = dt?.types;
  if (!types) return false;
  const list = types as DOMStringList & ReadonlyArray<string>;
  if (typeof list.contains === "function") return list.contains("Files");
  return Array.prototype.indexOf.call(types, "Files") !== -1;
}
