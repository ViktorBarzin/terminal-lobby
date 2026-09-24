import { createSignal } from "solid-js";

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

export interface OpenPicture {
  src: string;
  alt: string;
}

const [current, setCurrent] = createSignal<OpenPicture | null>(null);

/** The picture being looked at full size, or null. */
export const picture = current;

/** The field that had the keyboard when the picture opened, owed it back. */
let refocus: HTMLTextAreaElement | HTMLInputElement | null = null;

/**
 * Show a picture full size, and put the keyboard away.
 *
 * The composer's rule (PromptField, measured on the emulator on 2026-09-16): on
 * a phone the keyboard covers half the screen, which is half of the picture the
 * press asked to see, so a focused field is blurred and remembered. The
 * picture buttons keep the press from moving the focus first (Attachment.tsx),
 * which is what lets this see the field at all.
 */
export function openPicture(pic: OpenPicture): void {
  if (!current()) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    refocus =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    refocus?.blur();
  }
  setCurrent({ src: pic.src, alt: pic.alt });
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
