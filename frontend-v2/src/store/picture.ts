import { createSignal } from "solid-js";
import { track } from "../telemetry/track";

/**
 * The picture the Text view is showing full size, if any (2026-09-24).
 *
 * Every picture in the conversation opens here: one in a bubble, one Claude
 * named in its prose, a tool row's thumbnail. A module-level signal rather than
 * a store threaded through props, for the reason store/watchmode.ts gives for
 * its own: the pictures are drawn deep inside the timeline, a markdown
 * renderer and the tool rows, and the lightbox is mounted once in App, so one
 * overlay serves every tile of a workspace and none is left behind in a session
 * the lobby keeps mounted but hidden.
 *
 * The composer's own lightbox (PromptField) and the gallery's keep their code.
 * All three share the `.tl-lightbox` class and the rule below about the
 * keyboard.
 */

/** Where the picture was opened from. Reported, with no path. */
export type PictureSource = "bubble" | "prose" | "tool";

/** A picture on disk, or a block the transcript carries (a terminal paste, a
 *  Read of an image), which has no file. */
export type PictureKind = "file" | "block";

export interface OpenPicture {
  src: string;
  alt: string;
}

/**
 * The pictures the open one can step to, in the order they are drawn, and
 * which of them is showing. A picture opened on its own is a set of one.
 */
export interface PictureSet {
  items: readonly OpenPicture[];
  index: number;
}

const [current, setCurrent] = createSignal<PictureSet | null>(null);

/** The picture being looked at full size, or null. */
export const picture = (): OpenPicture | null => {
  const set = current();
  return set ? (set.items[set.index] ?? null) : null;
};

/** Where the open picture sits among the ones it can step to, or null. */
export const pictureSpot = (): { index: number; count: number } | null => {
  const set = current();
  return set ? { index: set.index, count: set.items.length } : null;
};

/**
 * Show the previous (-1) or next (1) picture of the set, stopping at either
 * end rather than wrapping. Stepping reports nothing: `text.picture_opened`
 * counts presses on a picture, and a step is not one.
 */
export function stepPicture(delta: number): void {
  const set = current();
  if (!set) return;
  const index = Math.min(set.items.length - 1, Math.max(0, set.index + delta));
  if (index !== set.index) setCurrent({ items: set.items, index });
}

/** The field that had the keyboard when the picture opened, owed it back. */
let refocus: HTMLTextAreaElement | HTMLInputElement | null = null;

/**
 * Show a picture full size, and put the keyboard away. `among` is the set it
 * can step to, with the index of this picture in it; without it, the picture
 * stands alone.
 *
 * The composer's rule (PromptField, measured on the emulator on 2026-09-16): on
 * a phone the keyboard covers half the screen, which is half of the picture the
 * press asked to see, so a focused field is blurred and remembered. The
 * picture buttons keep the press from moving the focus first (Attachment.tsx),
 * which is what lets this see the field at all.
 */
export function openPicture(
  pic: OpenPicture,
  source: PictureSource,
  kind: PictureKind,
  among?: PictureSet,
): void {
  if (!current()) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    refocus =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    refocus?.blur();
  }
  const set =
    among && among.items[among.index]
      ? among
      : { items: [{ src: pic.src, alt: pic.alt }], index: 0 };
  setCurrent({ items: set.items, index: set.index });
  // Which kind of picture and which surface, never the path or the bytes
  // (ADR-0008). It says whether people open pictures at all, and from where.
  track("text.picture_opened", { "tl.kind": kind, "tl.source": source });
}

/**
 * Close the picture. The field that had the keyboard gets it back, and nothing
 * else is focused: closing a picture over a screen someone was reading must not
 * raise a keyboard they never asked for. A field that has gone from the page in
 * the meantime is not focused either.
 */
export function closePicture(): void {
  if (!current()) return;
  setCurrent(null);
  const field = refocus;
  refocus = null;
  if (field?.isConnected) field.focus();
}
