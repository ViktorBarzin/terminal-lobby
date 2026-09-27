import { Show, type Component } from "solid-js";
import { CameraGlyph, FileGlyph, PhotoGlyph, SlashBoxIcon } from "./Icons";

/**
 * What the composer's `+` opens: Photo library, Camera, File, a rule, then
 * Commands with its `/` keycap (prototype 6-plus).
 *
 * HISTORY. The composer's bar carried a worded Attach button until
 * 2026-09-24, and the `/` and `@` menus had no button at all. The Quiet line
 * put four intakes behind the `+` (a file, a photo, a `/` command, an `@`
 * path) with a footer saying where files end up. The T3 pass (2026-09-27)
 * split the photo row into the library and the camera, dropped the `@` row
 * (typing `@` still opens the path menu) and folded the footer into the `+`'s
 * title. Composer.plus.test.tsx was rewritten on purpose to pin this list.
 *
 * The rows DO nothing themselves. The file inputs, the caret and the
 * completion menu all belong to PromptField, which renders this and is handed
 * each press back; the inputs stay mounted there while the menu comes and
 * goes, since a picker opened from a row that has just unmounted still has to
 * deliver its files somewhere.
 */
export const PlusMenu: Component<{
  /** The field can take files at all (it was given an uploader). */
  canAttach: boolean;
  /** An upload is in flight: the three picker rows wait for it. */
  attaching: boolean;
  onPhoto: () => void;
  onCamera: () => void;
  onFile: () => void;
  onSlash: () => void;
  ref?: (el: HTMLDivElement) => void;
}> = (props) => {
  /** ↑ and ↓ walk the rows, wrapping, as they do in every other menu here. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const box = e.currentTarget as HTMLElement;
    const items = Array.from(box.querySelectorAll<HTMLButtonElement>(".tl-plus-item")).filter(
      (b) => b.getAttribute("aria-disabled") !== "true",
    );
    const i = items.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length]!.focus();
  };
  const busy = (): "true" | undefined => (props.attaching ? "true" : undefined);
  /** A picker row: pressing it while an upload runs does nothing. */
  const pick = (open: () => void) => () => {
    if (!props.attaching) open();
  };
  return (
    <div
      class="tl-plus-menu"
      role="menu"
      aria-label="Add to the message"
      ref={(el) => props.ref?.(el)}
      onKeyDown={onKeyDown}
    >
      <Show when={props.canAttach}>
        <button
          type="button"
          role="menuitem"
          class="tl-plus-item"
          aria-disabled={busy()}
          onClick={pick(props.onPhoto)}
        >
          <PhotoGlyph />
          <span>Photo library</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tl-plus-item"
          aria-disabled={busy()}
          onClick={pick(props.onCamera)}
        >
          <CameraGlyph />
          <span>Camera</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tl-plus-item"
          aria-disabled={busy()}
          onClick={pick(props.onFile)}
        >
          <FileGlyph />
          <span>{props.attaching ? "Attaching…" : "File"}</span>
        </button>
        <div class="tl-plus-sep" role="separator" />
      </Show>
      <button type="button" role="menuitem" class="tl-plus-item" onClick={() => props.onSlash()}>
        <SlashBoxIcon />
        <span>Commands</span>
        <kbd class="tl-plus-kbd">/</kbd>
      </button>
    </div>
  );
};
