import { Show, createMemo, createSignal, type Component } from "solid-js";
import { SolidMarkdown, type SolidMarkdownComponents } from "solid-markdown";
import type { PluggableList } from "unified";
import { remarkPlugins } from "../lib/markdown-plugins";
import rehypeSanitize from "rehype-sanitize";
import {
  contentUrlFor,
  isPicturePath,
  pictureUrlFor,
  segmentMessage,
  storedDisplayName,
  type Segment,
} from "../lib/attachments";
import { Mermaid } from "./Mermaid";
import { CodeView } from "./CodeView";
import { Picture } from "./Attachment";
import { fileReadUrl } from "../lib/config";
import { basename } from "../store/preview.logic";

/**
 * Assistant markdown renderer (design pillar #2: "full-width assistant markdown
 * with mermaid + inline images", beating T3 which renders neither).
 *   - remark-gfm: tables, task lists, strikethrough, autolinks — gated on the
 *     engine supporting lookbehind, which its autolink extension needs on
 *     every render (see lib/markdown-plugins).
 *   - rehype-sanitize: the transcript can carry arbitrary HTML, so sanitize.
 *   - custom `code`: ```mermaid → <Mermaid>; other fences → <CodeView>, which
 *     lazily highlights them (highlight.js, already in the bundle for the file
 *     preview). An agent transcript is mostly code, and it read as a wall of
 *     grey before this; CodeView renders the plain text first and swaps in the
 *     highlighted markup, so a language it does not know loses nothing.
 *   - custom `pre`: pass-through, so a fence is wrapped exactly once.
 *   - custom `img`: lazy, constrained images that read as their path when they
 *     cannot be loaded, and open the lightbox in the conversation.
 */

/** Minimal hast shape — avoids depending on @types/hast directly. Widened for
 *  rehypeAttachments, which BUILDS nodes as well as reading them. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown> & { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (Array.isArray(node.children)) return node.children.map(hastText).join("");
  return "";
}

function hastLang(node: HastNode | undefined): string {
  const cn = node?.properties?.className;
  const classes: string[] = Array.isArray(cn)
    ? cn.map(String)
    : typeof cn === "string"
      ? cn.split(/\s+/)
      : [];
  const found = classes.find((c) => c.startsWith("language-"));
  return found ? found.slice("language-".length) : "";
}

/**
 * Resolve a markdown image reference.
 *
 * A picture named by its absolute path on disk (`![](/tmp/shot.png)`, which is
 * how Claude writes one) is read through the conversation's own routes, with or
 * without a base. Before 2026-09-24 it was left as written, so the browser
 * asked the lobby ORIGIN for /tmp/shot.png and drew a broken image.
 *
 * A document previewed from DISK is addressed by path, but its <img> resolves
 * against the lobby origin — so `![x](pic.png)` beside the file asked the lobby
 * for /pic.png and 404'd. With a `base` (the file's own directory) a relative
 * reference is read back through the file-api instead.
 *
 * Anything else stays untouched: a full URL, a data:/blob: URI, a
 * protocol-relative `//host/…`, and a root-relative URL under one of the lobby's
 * own routes, which is how a file-api or clipboard URL is written by hand
 * (`isPicturePath` refuses those).
 */
function resolveImageSrc(src: string | undefined, base?: string): string | undefined {
  if (!src) return src;
  if (isPicturePath(src)) return pictureUrlFor(src) ?? src;
  if (!base) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return src;
  return fileReadUrl(`${base.replace(/\/+$/, "")}/${src}`);
}

/**
 * A `![](…)` reference, drawn in place.
 *
 * One that cannot be loaded reads as what it was written as, in the path style
 * the attachments use, never as a broken-image icon. In the conversation it sits
 * in a Picture button, so it is capped at the bubble's 320px and opens the
 * lightbox; in the file preview, which is a document rather than a chat, it
 * stays a bare image at its own size.
 */
const MarkdownImage: Component<{
  src?: string;
  alt?: string;
  base?: string;
  conversation: boolean;
}> = (props) => {
  const src = createMemo(() => resolveImageSrc(props.src, props.base));
  const [broken, setBroken] = createSignal(false);
  const asText = () => <span class="tl-attach-path">{props.src}</span>;
  return (
    <Show when={src() && !broken()} fallback={asText()}>
      <Show
        when={props.conversation}
        fallback={
          <img
            class="tl-md-img"
            src={src()}
            alt={props.alt ?? ""}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        }
      >
        <Picture
          src={src()!}
          alt={props.alt || basename(props.src ?? "")}
          title={props.src}
          size="full"
          source="prose"
          kind="file"
          fallback={asText()}
        />
      </Show>
    </Show>
  );
};

/**
 * The `img` renderer, bound to a base directory (or to none, the transcript,
 * where a picture is named by its absolute path) and to whether it draws in
 * the conversation.
 *
 * A node carrying `dataPicture` is one `rehypeAttachments` added under a block
 * for a path named in the text. Its src is already a URL, and when it cannot be
 * loaded it simply goes: the path it stands for is still in the text above it.
 */
const imgFor =
  (base: string | undefined, conversation: boolean): SolidMarkdownComponents["img"] =>
  (props) => {
    const node = props.node as unknown as HastNode | undefined;
    const path = node?.properties?.dataPicture;
    if (typeof path === "string") {
      return (
        <Picture
          src={props.src ?? ""}
          alt={props.alt ?? ""}
          title={path}
          size="full"
          source="prose"
          kind="file"
        />
      );
    }
    return (
      <MarkdownImage src={props.src} alt={props.alt} base={base} conversation={conversation} />
    );
  };

/** The blocks a picture is drawn under: the first of these that holds the
 *  path's mention. A table cell resolves to its table, so a picture never lands
 *  in the middle of a grid. */
const PICTURE_ANCHORS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "table"]);

/** Every picture a `![](…)` reference will draw in place, by its path. */
function drawnInPlace(node: HastNode, into: Set<string>): Set<string> {
  for (const child of node.children ?? []) {
    if (child.type !== "element" || child.tagName === "pre") continue;
    const src = child.tagName === "img" ? child.properties?.src : undefined;
    if (typeof src === "string" && isPicturePath(src)) into.add(src);
    drawnInPlace(child, into);
  }
  return into;
}

/**
 * Draw the pictures Claude names in its prose (2026-09-24, revising design
 * 2026-08-17 decision 8), and turn a document it names into a link to its
 * bytes. Runs AFTER rehype-sanitize in the plugin list, so the nodes it adds are
 * not candidates for stripping.
 *
 * An absolute image path keeps its text, wherever it is written: plain, in an
 * inline code span (10 of the 11 image mentions in the census were in
 * backticks), or as a link's target, whose href is pointed at the picture's
 * bytes. The picture is drawn UNDER the block holding its first mention, after
 * a paragraph, a heading or a table and at the end of a list item, one picture
 * per path per message. The text stays because it is also a path somebody may
 * want to copy, and a picture that cannot be read then costs nothing: it goes,
 * and the text is what the view showed before.
 *
 * The pass emits plain `img` elements marked `dataPicture`, which the `img`
 * override renders as a Picture, and plain `a` elements for documents, so it
 * needs no custom tag.
 *
 * FENCED CODE IS SKIPPED. A path inside a fence is sample text — `cp
 * /var/lib/clipboard-store/…/a.png .` in a script is a command to read, not a
 * picture to draw — so `pre` subtrees, fenced and indented, are left alone. An
 * inline span is a different case: it is how Claude writes the name of a file it
 * made, and the span itself is never changed, only followed by the picture. This
 * is the part of the pass that can quietly ruin a transcript, which is why it has
 * its own tests.
 */
function rehypeAttachments(options: { me: string }) {
  const { me } = options;

  const chipFor = (seg: Extract<Segment, { kind: "file" }>): HastNode | null => {
    const url = contentUrlFor(seg.path, me);
    if (!url) return null; // not ours to fetch — leave the path as text
    return {
      type: "element",
      tagName: "a",
      properties: { href: url, className: ["tl-attach-chip"] },
      children: [{ type: "text", value: storedDisplayName(seg.name) }],
    };
  };

  return (tree: HastNode): void => {
    const drawn = drawnInPlace(tree, new Set());
    /** Anchor block → the pictures under it, in the order they were named. */
    const under = new Map<HastNode, { parent: HastNode; pictures: HastNode[] }>();

    /** Draw `path` under the nearest anchor in `stack` (outermost first). */
    const queue = (path: string, stack: readonly HastNode[]): void => {
      if (drawn.has(path)) return;
      const url = contentUrlFor(path, me);
      if (!url) return;
      drawn.add(path);
      let at = stack.length - 1;
      while (at > 0 && !PICTURE_ANCHORS.has(stack[at]!.tagName ?? "")) at--;
      // No anchor at all (text straight under the root) puts it at the end.
      const anchor = stack[at]!;
      const parent = at > 0 ? stack[at - 1]! : anchor;
      const slot = under.get(anchor) ?? { parent, pictures: [] };
      slot.pictures.push({
        type: "element",
        tagName: "img",
        properties: { src: url, alt: storedDisplayName(basename(path)), dataPicture: path },
        children: [],
      });
      under.set(anchor, slot);
    };

    const walk = (node: HastNode, stack: readonly HastNode[], inLink: boolean): void => {
      const children = node.children;
      if (!Array.isArray(children)) return;
      const here = [...stack, node];
      const out: HastNode[] = [];
      let touched = false;
      for (const child of children) {
        if (child.type === "element") {
          if (child.tagName === "pre") {
            out.push(child);
            continue;
          }
          if (child.tagName === "code") {
            for (const seg of segmentMessage(hastText(child))) {
              if (seg.kind === "file" && seg.fileKind === "image") queue(seg.path, here);
            }
            out.push(child);
            continue;
          }
          if (child.tagName === "a") {
            const href = child.properties?.href;
            if (typeof href === "string" && isPicturePath(href)) {
              const url = contentUrlFor(href, me);
              if (url) child.properties = { ...child.properties, href: url };
              queue(href, here);
            }
            walk(child, here, true);
            out.push(child);
            continue;
          }
          walk(child, here, inLink);
          out.push(child);
          continue;
        }
        if (child.type !== "text" || !child.value) {
          out.push(child);
          continue;
        }
        const segs = segmentMessage(child.value);
        // One text segment covering the whole value means nothing matched.
        if (segs.length === 1 && segs[0]!.kind === "text") {
          out.push(child);
          continue;
        }
        for (const seg of segs) {
          if (seg.kind === "text") {
            out.push({ type: "text", value: seg.text });
            continue;
          }
          if (seg.fileKind === "image") {
            queue(seg.path, here);
            out.push({ type: "text", value: seg.path });
            continue;
          }
          // A link inside a link is not HTML, so a document named in a link's
          // own text stays text.
          const chip = inLink ? null : chipFor(seg);
          out.push(chip ?? { type: "text", value: seg.path });
          if (chip) touched = true;
        }
      }
      if (touched) node.children = out;
    };
    walk(tree, [], false);

    for (const [anchor, { parent, pictures }] of under) {
      const block: HastNode = {
        type: "element",
        tagName: "div",
        properties: { className: ["tl-md-pictures"] },
        children: pictures,
      };
      if (anchor.tagName === "li" || anchor === parent) {
        anchor.children = [...(anchor.children ?? []), block];
        continue;
      }
      const siblings = parent.children ?? [];
      const at = siblings.indexOf(anchor);
      parent.children = [...siblings.slice(0, at + 1), block, ...siblings.slice(at + 1)];
    }
  };
}

/**
 * Close a code fence the text leaves open, for a reply still being written.
 *
 * CommonMark already runs an unclosed fence to the end of the document, so
 * this changes nothing about what is code. It makes the fence the last thing
 * in the text explicitly, so a block streaming in reads as code from its
 * first line rather than depending on where the parser gives up.
 */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const fence = m[1]!;
    const rest = m[2]!;
    if (open === null) {
      // A backtick fence's info string cannot hold a backtick; that line is
      // inline code, not a fence.
      if (fence[0] === "`" && rest.includes("`")) continue;
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length && rest.trim() === "") {
      open = null;
    }
  }
  return open === null ? text : `${text}\n${open}`;
}

/** A code span or block. `diagrams` false draws a mermaid fence as its source. */
function codeBlock(raw: unknown, inline: boolean, diagrams: boolean) {
  const node = raw as HastNode;
  const text = hastText(node).replace(/\n$/, "");
  if (inline) return <code class="tl-inline-code">{text}</code>;
  const lang = hastLang(node);
  if (lang === "mermaid" && diagrams) return <Mermaid code={text} />;
  // An untagged fence is shown as written: auto-detection coloured prose in
  // one as if it were code (CodeView's PLAIN).
  return (
    <div class="tl-code-block" data-lang={lang || undefined}>
      <CodeView code={text} language={lang && lang !== "mermaid" ? lang : "plaintext"} />
    </div>
  );
}

const streamingCode: SolidMarkdownComponents["code"] = (props) =>
  codeBlock(props.node, props.inline === true, false);

const components: SolidMarkdownComponents = {
  // solid-markdown renders every code block through its own default `pre` and
  // puts the `code` component inside it — but the `code` override below returns
  // the BLOCK itself (a <pre class="tl-code">, or a <div>/<svg> mermaid
  // diagram), so each fence came out double-wrapped: <pre><pre class="tl-code">
  // and <pre><div class="tl-mermaid">. <pre>'s content model is phrasing
  // content, so all three of those nestings are invalid HTML. Pass the child
  // through instead. A code block — fenced or indented — is the only thing that
  // reaches this component: raw HTML never becomes elements here (no
  // rehype-raw), so nothing else can lose its <pre>.
  pre: (props) => <>{props.children}</>,
  code: (props) => codeBlock(props.node, props.inline === true, true),
  img: imgFor(undefined, false),
  // A table gets its own scroller, and the reason is a shape CSS cannot express
  // on one element: the scrollport has to stay the width of the phone while the
  // table is free to be wider. With `display: block; overflow-x: auto` on the
  // table alone it was both, so it took the container's width and squeezed the
  // columns instead of overflowing. Measured on the real stylesheet at 390px,
  // on a five-column table: 221px tall, 3 lines per cell, and an inline code
  // span broken into 3 pieces; with the wrapper, 116px, 1 line, 1 piece.
  table: (props) => (
    <div class="tl-table-scroll">
      <table>{props.children}</table>
    </div>
  ),
  a: (props) => (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  ),
};

/**
 * `base` — the directory a RELATIVE image reference resolves against, set only
 * by the file preview (which knows the document's path on disk). It defaults to
 * undefined so the transcript renderer keeps the shared `components` object.
 *
 * `attachAs` — the effective OS user, set by the transcript renderer. Its
 * presence makes the markdown a conversation: a picture Claude names by its
 * absolute path is drawn (2026-09-24), "I wrote the chart to /home/…/plot.png"
 * shows the chart, and every picture opens the lightbox. It is checked for
 * presence rather than truth because TextView passes "" until whoami answers,
 * and in that window only a store path has to wait: the owner check needs the
 * user, and every other picture does not. Left unset by the file preview, whose
 * markdown is a document on disk rather than a conversation.
 */
export const Markdown: Component<{
  text: string;
  base?: string;
  attachAs?: string;
  /**
   * Still being written (store/stream.ts). An open fence is closed, and a
   * mermaid fence stays its source: a diagram drawn from half its lines fails
   * to parse, or draws and redraws as each line lands.
   */
  streaming?: boolean;
}> = (props) => {
  const conversation = () => props.attachAs !== undefined;
  const comps = createMemo<SolidMarkdownComponents>(() => {
    const base =
      props.base || conversation()
        ? { ...components, img: imgFor(props.base, conversation()) }
        : components;
    return props.streaming ? { ...base, code: streamingCode } : base;
  });
  // Rebuilt only when the user changes, so an ordinary re-render does not
  // re-create the plugin list and make solid-markdown re-parse.
  const rehype = createMemo<PluggableList>(() =>
    props.attachAs !== undefined
      ? [rehypeSanitize, [rehypeAttachments, { me: props.attachAs }]]
      : [rehypeSanitize],
  );
  return (
    <div class="tl-markdown">
      <SolidMarkdown
        children={props.streaming ? closeOpenFence(props.text) : props.text}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehype()}
        components={comps()}
        renderingStrategy="memo"
      />
    </div>
  );
};
