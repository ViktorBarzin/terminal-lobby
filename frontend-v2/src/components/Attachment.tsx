import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import {
  contentUrlFor,
  segmentMessage,
  storedDisplayName,
  type AttachmentKind,
} from "../lib/attachments";
import { FileTextIcon } from "./Icons";

/**
 * Attachments, as the chat draws them
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decisions 2, 4 and 13).
 *
 * An image is a constrained preview — full bubble width, capped height — because
 * a screenshot you cannot read is not worth putting in the conversation. A
 * document is a labelled chip. Both open the file preview on click, which is the
 * overlay this app already has for looking at a file, and which renders images,
 * markdown, html, code and (now) pdf.
 *
 * Anything unservable falls back to the path text: another user's store file
 * (decision 12), a path outside the caller's home, a file the sweep has taken, or
 * an image the browser cannot decode. That fallback IS the behaviour the view had
 * before this feature, so a failure costs nothing that was there before.
 */

export const AttachmentView: Component<{
  path: string;
  name: string;
  kind: AttachmentKind;
  /** the effective OS user, which decides whether a store path is ours to fetch. */
  me: string;
  /** open this path in the file preview overlay. */
  onOpen?: (path: string) => void;
}> = (props) => {
  const url = createMemo(() => contentUrlFor(props.path, props.me));
  // An <img> cannot say WHY it failed, and there is nothing useful to say: the
  // path itself is the most informative thing left, and it is what the user saw
  // before attachments rendered at all.
  const [broken, setBroken] = createSignal(false);
  const label = createMemo(() => storedDisplayName(props.name));

  return (
    <Show when={url() && !broken()} fallback={<span class="tl-attach-path">{props.path}</span>}>
      <Show
        when={props.kind === "image"}
        fallback={
          <button
            type="button"
            class="tl-attach-chip"
            title={props.path}
            onClick={() => props.onOpen?.(props.path)}
          >
            <FileTextIcon />
            <span class="tl-attach-name">{label()}</span>
          </button>
        }
      >
        <button
          type="button"
          class="tl-attach-image"
          title={props.path}
          aria-label={`Open ${label()}`}
          onClick={() => props.onOpen?.(props.path)}
        >
          <img src={url()!} alt={label()} loading="lazy" onError={() => setBroken(true)} />
        </button>
      </Show>
    </Show>
  );
};

/**
 * One message's text with every recognized path replaced where it stands.
 *
 * The text runs are rendered verbatim, whitespace included: the caller styles
 * this with `white-space: pre-wrap`, so a message's own line breaks survive
 * substitution. That is what "replace in place" has to mean for a message whose
 * paths may sit anywhere — at the top for our own sends, mid-sentence for
 * everything the pty typed before the tray existed.
 */
export const MessageSegments: Component<{
  text: string;
  me: string;
  onOpen?: (path: string) => void;
}> = (props) => {
  const segments = createMemo(() => segmentMessage(props.text));
  return (
    <For each={segments()}>
      {(seg) =>
        seg.kind === "text" ? (
          <>{seg.text}</>
        ) : (
          <AttachmentView
            path={seg.path}
            name={seg.name}
            kind={seg.fileKind}
            me={props.me}
            onOpen={props.onOpen}
          />
        )
      }
    </For>
  );
};
