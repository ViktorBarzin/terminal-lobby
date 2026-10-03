import {
  For,
  Show,
  createComputed,
  createMemo,
  createSignal,
  on,
  type Component,
  type JSX,
} from "solid-js";
import {
  contentUrlFor,
  storedDisplayName,
  type AttachmentKind,
  type Segment,
} from "../lib/attachments";
import { promptImageUrl } from "../lib/config";
import {
  openPicture,
  type PictureKind,
  type PictureSet,
  type PictureSource,
} from "../store/picture";
import { FileTextIcon } from "./Icons";

/**
 * Attachments, as the chat draws them
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decisions 2, 4 and 13,
 * revised 2026-09-24).
 *
 * An image is a constrained preview — full bubble width, capped height — because
 * a screenshot you cannot read is not worth putting in the conversation. It
 * opens the lightbox every picture in the view shares, which is one tap to
 * close. A document is a labelled chip, and opens the file preview, which is the
 * overlay this app has for reading a file: markdown, html, code and pdf.
 *
 * Anything unservable falls back to the path text: another user's store file
 * (decision 12), a path the caller cannot read, a file the sweep has taken, or an
 * image the browser cannot decode. That fallback IS the behaviour the view had
 * before this feature, so a failure costs nothing that was there before.
 */

/**
 * One picture, as a control that opens it full size.
 *
 * A button around the image rather than a click on the image itself, because a
 * clickable <img> is a mouse-only control the accessibility rules flag (the
 * 2026-09-16 revision of the August design names them), and a button is in the
 * tab order with Enter and Space for free.
 *
 * `full` is the conversation's size, 320px tall at most (decision 13), for a
 * bubble and for Claude's prose. `thumb` is a tool row's, about 96px tall, so a
 * run of Reads stays a run of rows rather than a gallery.
 *
 * An <img> cannot say WHY it failed, and there is nothing useful to say: what is
 * left is the `fallback`, which is the path or the placeholder where the caller
 * has one, and nothing where the picture was only ever an extra (a tool row
 * keeps its label and its path chip).
 */
/** Every picture button a timeline draws, in `picturesAround`'s order. */
const PICTURE_BUTTONS = ".tl-attach-image, .tl-tool-thumb";

/**
 * The pictures the lightbox can step to from this one: every picture in the
 * same timeline, in the order they are drawn, which is the conversation's
 * order. Scoped to the timeline, so the drill-in's pictures and the session's
 * never mix. Read off the page at the press, so it is the pictures loaded then;
 * one that is not in a timeline (a card's markdown) stands alone.
 */
function picturesAround(button: HTMLElement): PictureSet | undefined {
  const timeline = button.closest(".tl-timeline");
  if (!timeline) return undefined;
  const buttons = Array.from(timeline.querySelectorAll<HTMLElement>(PICTURE_BUTTONS));
  const items = [];
  let index = -1;
  for (const b of buttons) {
    const img = b.querySelector("img");
    const src = img?.getAttribute("src");
    if (!img || !src) continue;
    if (b === button) index = items.length;
    items.push({ src, alt: img.alt });
  }
  return index < 0 ? undefined : { items, index };
}

/**
 * Addresses that failed to load, and when. A row that re-renders mounts its
 * pictures again, and the browser does not cache a failure, so without this
 * every re-render asked again: on 2026-10-03 a phone on a slow line sent 421
 * requests for 34 missing pictures in seven seconds, and the edge banned it for
 * probing. A failure is believed for a minute, long enough to absorb a burst of
 * re-renders, short enough that a picture that turns up is drawn without a
 * reload.
 */
const failedAt = new Map<string, number>();
const RETRY_FAILED_MS = 60_000;

/** Forget every remembered failure. Each test starts from none. */
export function forgetFailedPictures(): void {
  failedAt.clear();
}

function recentlyFailed(src: string): boolean {
  const at = failedAt.get(src);
  if (at === undefined) return false;
  if (Date.now() - at < RETRY_FAILED_MS) return true;
  failedAt.delete(src);
  return false;
}

export const Picture: Component<{
  src: string;
  alt: string;
  size: "full" | "thumb";
  /** where it is drawn, for the one usage event opening it emits. */
  source: PictureSource;
  kind: PictureKind;
  title?: string;
  fallback?: JSX.Element;
}> = (props) => {
  const [broken, setBroken] = createSignal(recentlyFailed(props.src));
  // A new address deserves a fresh try: the effective user arriving turns a
  // store path's null into a URL, and a screenshot is rewritten in place.
  createComputed(
    on(
      () => props.src,
      (src) => setBroken(recentlyFailed(src)),
      { defer: true },
    ),
  );
  const failed = () => {
    failedAt.set(props.src, Date.now());
    setBroken(true);
  };
  return (
    <Show when={!broken()} fallback={props.fallback}>
      <button
        type="button"
        class={props.size === "full" ? "tl-attach-image" : "tl-tool-thumb"}
        title={props.title ?? props.alt}
        aria-label={`Open ${props.alt}`}
        // The press must not move the focus onto this button on its way: the
        // lightbox puts a phone's keyboard away by blurring the field that has
        // it, and gives it back on close, so it has to find that field still
        // focused. The composer's picture chip does the same.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) =>
          openPicture(
            { src: props.src, alt: props.alt },
            props.source,
            props.kind,
            picturesAround(e.currentTarget),
          )
        }
      >
        <img src={props.src} alt={props.alt} loading="lazy" onError={failed} />
      </button>
    </Show>
  );
};

export const AttachmentView: Component<{
  path: string;
  name: string;
  kind: AttachmentKind;
  /** the effective OS user, which decides whether a store path is ours to fetch. */
  me: string;
  /** open a DOCUMENT in the file preview overlay. A picture opens the lightbox. */
  onOpen?: (path: string) => void;
  /** the whitespace that ended this path's line, owed back only as text. */
  owed?: string;
}> = (props) => {
  const url = createMemo(() => contentUrlFor(props.path, props.me));
  const label = createMemo(() => storedDisplayName(props.name));
  const asText = () => (
    <>
      <span class="tl-attach-path">{props.path}</span>
      {props.owed ?? ""}
    </>
  );

  return (
    <Show when={url()} fallback={asText()}>
      {(src) => (
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
          <Picture
            src={src()}
            alt={label()}
            title={props.path}
            size="full"
            source="bubble"
            kind="file"
            fallback={asText()}
          />
        </Show>
      )}
    </Show>
  );
};

/** A segment that draws as a block while its picture loads. */
const drawsAsBlock = (seg: Segment | undefined): boolean =>
  !!seg && (seg.kind === "block" || (seg.kind === "file" && seg.fileKind === "image"));

/** One segment to render, and the whitespace after it that it owes back. */
interface Line {
  seg: Segment;
  owed: string;
}

/** What separates a block from the text after it: a line's end with any
 *  spaces before it, or else a run of spaces. */
const AFTER_BLOCK_RE = /^[ \t]*\n|^[ \t]+/;

/**
 * Hand each picture the newline that ended its line.
 *
 * A picture draws as a block, and a block ends its line by itself, so the
 * newline written after it would add a blank line the message never had: a
 * terminal paste is `[Image #1]\n\n` and then the prompt, and the bubble showed
 * two empty lines under the picture. That newline moves onto the picture, which
 * renders it only when it falls back to text, where the line break is needed
 * again. The same goes for the space after a picture Claude Code put at the
 * front of a prompt ("[Image #1] Name this colour"), which left the bubble's
 * words starting with a stray space (deployed review rounds 3 to 5).
 */
function lines(segments: readonly Segment[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    const owed =
      drawsAsBlock(seg) && next?.kind === "text" ? (AFTER_BLOCK_RE.exec(next.text)?.[0] ?? "") : "";
    const prev = out[out.length - 1];
    if (seg.kind === "text" && prev?.owed) {
      out.push({ seg: { kind: "text", text: seg.text.slice(prev.owed.length) }, owed: "" });
      continue;
    }
    out.push({ seg, owed });
  }
  return out;
}

/**
 * One message's segments, each path and each terminal paste drawn where it
 * stands.
 *
 * The text runs are rendered verbatim, whitespace included: the caller styles
 * this with `white-space: pre-wrap`, so a message's own line breaks survive
 * substitution. That is what "replace in place" has to mean for a message whose
 * paths may sit anywhere — at the top for our own sends, mid-sentence for
 * everything the pty typed before the tray existed. The one exception is the
 * newline straight after a picture (see `lines`).
 *
 * A picture pasted into the terminal is read back out of the transcript by the
 * prompt's record uuid, so it needs both `session` and `record`. Without them,
 * and when its bytes cannot be read, it stays the `[Image #N]` the text had.
 */
export const MessageSegments: Component<{
  segments: readonly Segment[];
  me: string;
  /** the session whose transcript holds the prompt's picture blocks. */
  session?: string;
  /** the prompt's user record uuid. */
  record?: string;
  onOpen?: (path: string) => void;
}> = (props) => {
  const shown = createMemo(() => lines(props.segments));
  return (
    <For each={shown()}>
      {({ seg, owed }) => {
        if (seg.kind === "text") return <>{seg.text}</>;
        if (seg.kind === "file") {
          return (
            <AttachmentView
              path={seg.path}
              name={seg.name}
              kind={seg.fileKind}
              me={props.me}
              onOpen={props.onOpen}
              owed={owed}
            />
          );
        }
        const placeholder = () => (
          <>
            <span class="tl-attach-path">{seg.text}</span>
            {owed}
          </>
        );
        return (
          <Show
            when={props.session && props.record ? props.session : undefined}
            fallback={placeholder()}
          >
            {(session) => (
              <Picture
                src={promptImageUrl(session(), props.record ?? "", seg.ref.n)}
                alt={`Pasted image ${seg.ref.paste ?? seg.ref.n + 1}`}
                size="full"
                source="bubble"
                kind="block"
                fallback={placeholder()}
              />
            )}
          </Show>
        );
      }}
    </For>
  );
};
