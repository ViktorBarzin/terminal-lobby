/**
 * The session browser's clipboard, on the lobby's side.
 *
 * The page lives in the host's headless Chrome, so what a copy produces comes
 * back over the stream a round trip after the key or the tap. Safari lets a
 * page write the clipboard only inside the gesture, and Firefox only shortly
 * after it, so a writeText once the text arrives is refused there. The copy
 * therefore starts its write inside the gesture, with a ClipboardItem whose
 * blob is still on its way, which Safari, Chrome and Firefox all accept. Where
 * that is refused or missing it falls back to writeText, which Chrome allows
 * from a focused document without a gesture.
 */

export type CopyOutcome = "copied" | "empty" | "refused";

export interface BrowserClipboardDeps {
  /** defaults to navigator.clipboard; undefined means the page has none. */
  clipboard?: Clipboard | undefined;
  /** defaults to the global ClipboardItem; undefined means there is none. */
  Item?: typeof ClipboardItem | undefined;
}

function clipboardOf(deps: BrowserClipboardDeps): Clipboard | undefined {
  if ("clipboard" in deps) return deps.clipboard;
  return typeof navigator !== "undefined" ? navigator.clipboard : undefined;
}

function itemOf(deps: BrowserClipboardDeps): typeof ClipboardItem | undefined {
  if ("Item" in deps) return deps.Item;
  return typeof ClipboardItem !== "undefined" ? ClipboardItem : undefined;
}

/**
 * Copies text that is still on its way. Call it inside the gesture, before
 * the first await. Empty text leaves the clipboard as it was.
 */
export async function copyArriving(
  text: Promise<string>,
  deps: BrowserClipboardDeps = {},
): Promise<CopyOutcome> {
  const clip = clipboardOf(deps);
  const Item = itemOf(deps);
  if (clip && Item && typeof clip.write === "function") {
    const blob = text.then((t) => {
      if (!t) throw new Error("nothing to copy");
      return new Blob([t], { type: "text/plain" });
    });
    // A write that fails before reading the blob must not leave it unhandled.
    blob.catch(() => undefined);
    try {
      await clip.write([new Item({ "text/plain": blob })]);
      return "copied";
    } catch {
      // Empty, or refused: told apart below.
    }
  }
  const t = await text.catch(() => "");
  if (!t) return "empty";
  return (await copyNow(t, deps)) ? "copied" : "refused";
}

/** Copies text that is here now. True when it landed. */
export async function copyNow(text: string, deps: BrowserClipboardDeps = {}): Promise<boolean> {
  const clip = clipboardOf(deps);
  if (!clip) return false;
  try {
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Reads the person's clipboard for a paste. Call it inside the gesture. */
export async function readClipboard(
  deps: BrowserClipboardDeps = {},
): Promise<{ text: string } | { refused: true }> {
  const clip = clipboardOf(deps);
  if (!clip || typeof clip.readText !== "function") return { refused: true };
  try {
    return { text: await clip.readText() };
  } catch {
    return { refused: true };
  }
}
