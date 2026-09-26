import { Show, type Component } from "solid-js";
import { AtIcon, ImageIcon, PaperclipIcon, SlashBoxIcon } from "./Icons";

/**
 * What the pill's `+` opens: the four ways to put something into a message.
 *
 * WHY A TRAY. The composer's bar carried a worded Attach button until
 * 2026-09-24, and the `/` and `@` menus had no button at all: they opened for
 * a reader who already knew to type the trigger. The Quiet line pill has room
 * for one control before the field, and one word cannot name four intakes, so
 * the `+` has an accessible name and a title and these rows carry the words.
 * The test that pinned a visible word on Attach was rewritten on purpose, to
 * pin the words here instead.
 *
 * The rows DO nothing themselves. The file inputs, the caret and the
 * completion menu all belong to PromptField, which renders this and is handed
 * each press back; the inputs stay mounted there while the tray comes and
 * goes, since a picker opened from a row that has just unmounted still has to
 * deliver its files somewhere.
 */
export const PlusTray: Component<{
  /** The field can take files at all (it was given an uploader). */
  canAttach: boolean;
  /** An upload is in flight. */
  attaching: boolean;
  /** `@` completion has a filesystem to list; absent on the new-session screen. */
  paths: boolean;
  /** The footer: where attached files end up. */
  note?: string;
  onFile: () => void;
  onPhoto: () => void;
  onSlash: () => void;
  onAt: () => void;
  ref?: (el: HTMLDivElement) => void;
}> = (props) => {
  /** ↑ and ↓ walk the rows, as they do in every other menu here. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const box = e.currentTarget as HTMLElement;
    const items = Array.from(box.querySelectorAll<HTMLButtonElement>(".tl-tray-item")).filter(
      (b) => b.getAttribute("aria-disabled") !== "true",
    );
    const i = items.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length]!.focus();
  };
  const busy = (): "true" | undefined => (props.attaching ? "true" : undefined);
  return (
    <div
      class="tl-tray"
      role="menu"
      aria-label="Add to the message"
      ref={(el) => props.ref?.(el)}
      onKeyDown={onKeyDown}
    >
      <Show when={props.canAttach}>
        <button
          type="button"
          role="menuitem"
          class="tl-tray-item"
          aria-disabled={busy()}
          onClick={() => {
            if (!props.attaching) props.onFile();
          }}
        >
          <PaperclipIcon />
          <span>{props.attaching ? "Attaching…" : "Attach a file"}</span>
          <span class="tl-tray-kbd tl-tray-kbd-fine">or drop</span>
        </button>
        {/* `capture` is deliberately absent from the input behind this row,
            so iOS offers Photo Library, Take Photo and Choose File rather than
            jumping straight to the camera. */}
        <button
          type="button"
          role="menuitem"
          class="tl-tray-item"
          aria-disabled={busy()}
          onClick={() => {
            if (!props.attaching) props.onPhoto();
          }}
        >
          <ImageIcon />
          <span>Add a photo</span>
          <span class="tl-tray-kbd tl-tray-kbd-fine">or paste</span>
        </button>
        <div class="tl-tray-sep" role="separator" />
      </Show>
      <button type="button" role="menuitem" class="tl-tray-item" onClick={() => props.onSlash()}>
        <SlashBoxIcon />
        <span>Commands and skills</span>
        <span class="tl-tray-kbd">/</span>
      </button>
      <Show when={props.paths}>
        <button type="button" role="menuitem" class="tl-tray-item" onClick={() => props.onAt()}>
          <AtIcon />
          <span>A file path</span>
          <span class="tl-tray-kbd">@</span>
        </button>
      </Show>
      <Show when={props.note}>
        <div class="tl-tray-note">{props.note}</div>
      </Show>
    </div>
  );
};
