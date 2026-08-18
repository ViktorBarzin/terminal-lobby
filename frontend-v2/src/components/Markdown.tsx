import { createMemo, type Component } from "solid-js";
import { SolidMarkdown, type SolidMarkdownComponents } from "solid-markdown";
import type { PluggableList } from "unified";
import { remarkPlugins } from "../lib/markdown-plugins";
import rehypeSanitize from "rehype-sanitize";
import {
  contentUrlFor,
  segmentMessage,
  storedDisplayName,
  type Segment,
} from "../lib/attachments";
import { Mermaid } from "./Mermaid";
import { CodeView } from "./CodeView";
import { fileReadUrl } from "../lib/config";

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
 *   - custom `img`: lazy, constrained inline images.
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
 * Resolve a markdown image reference. A document previewed from DISK is
 * addressed by path, but its <img> resolves against the lobby ORIGIN — so
 * `![x](pic.png)` beside the file asked the lobby for /pic.png and 404'd while
 * the same picture referenced absolutely loaded. With a `base` (the file's own
 * directory) a relative reference is read back through the file-api instead.
 *
 * Anything already addressed stays untouched: a full URL, a data:/blob: URI, a
 * protocol-relative `//host/…`, and a root-relative `/…` — that last one is how
 * a file-api URL is written by hand, so it must pass through even though it
 * cannot be told apart from an absolute filesystem path.
 */
function resolveImageSrc(src: string | undefined, base?: string): string | undefined {
  if (!base || !src) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return src;
  return fileReadUrl(`${base.replace(/\/+$/, "")}/${src}`);
}

/** The `img` renderer, bound to a base directory (or to none — the transcript,
 *  where every src is already absolute). */
const imgFor =
  (base?: string): SolidMarkdownComponents["img"] =>
  (props) => (
    <img
      class="tl-md-img"
      src={resolveImageSrc(props.src, base)}
      alt={props.alt ?? ""}
      loading="lazy"
    />
  );

/**
 * Turn bare absolute paths in Claude's prose into attachments
 * (design 2026-08-17 decision 8): an image renders inline, a document becomes a
 * link to its bytes. Runs AFTER rehype-sanitize in the plugin list, so the nodes
 * it adds are not candidates for stripping.
 *
 * It emits plain `img` and `a` elements rather than a custom tag, so the `img`
 * and `a` overrides below render them with no new mapping — an image gets the
 * same lazy, constrained treatment a `![](…)` reference always got.
 *
 * CODE IS SKIPPED. A path inside a fence or an inline span is sample text — `cp
 * /var/lib/clipboard-store/…/a.png .` is a command to read, not a picture to
 * draw — so `code` and `pre` subtrees are left completely alone. This is the one
 * part of the pass that can quietly ruin a transcript, which is why it has its
 * own tests.
 */
function rehypeAttachments(options: { me: string }) {
  const { me } = options;

  const nodeFor = (seg: Extract<Segment, { kind: "file" }>): HastNode | null => {
    const url = contentUrlFor(seg.path, me);
    if (!url) return null; // not ours to fetch — leave the path as text
    const label = storedDisplayName(seg.name);
    if (seg.fileKind === "image") {
      return {
        type: "element",
        tagName: "img",
        properties: { src: url, alt: label },
        children: [],
      };
    }
    return {
      type: "element",
      tagName: "a",
      properties: { href: url, className: ["tl-attach-chip"] },
      children: [{ type: "text", value: label }],
    };
  };

  const walk = (node: HastNode): void => {
    const children = node.children;
    if (!Array.isArray(children)) return;
    const out: HastNode[] = [];
    let touched = false;
    for (const child of children) {
      if (child.type === "element" && (child.tagName === "code" || child.tagName === "pre")) {
        out.push(child);
        continue;
      }
      if (child.type !== "text" || !child.value) {
        walk(child);
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
        const el = nodeFor(seg);
        if (el) {
          out.push(el);
          touched = true;
        } else {
          out.push({ type: "text", value: seg.path });
        }
      }
      if (segs.some((s) => s.kind === "file")) touched = true;
    }
    if (touched) node.children = out;
  };

  return (tree: HastNode): void => {
    walk(tree);
  };
}

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
  code: (props) => {
    const node = props.node as unknown as HastNode;
    const text = hastText(node).replace(/\n$/, "");
    if (props.inline) return <code class="tl-inline-code">{text}</code>;
    const lang = hastLang(node);
    if (lang === "mermaid") return <Mermaid code={text} />;
    return (
      <div class="tl-code-block" data-lang={lang || undefined}>
        <CodeView code={text} {...(lang ? { language: lang } : {})} />
      </div>
    );
  },
  img: imgFor(),
  a: (props) => (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  ),
};

/**
 * `base` — the directory a RELATIVE image reference resolves against, set only
 * by the file preview (which knows the document's path on disk). It defaults to
 * undefined so the transcript renderer keeps the shared `components` object
 * verbatim and renders byte-identically.
 *
 * `attachAs` — the effective OS user, set by the transcript renderer. Its
 * presence turns a bare absolute path in Claude's prose into an attachment
 * (design 2026-08-17 decision 8): "I wrote the chart to /home/…/plot.png" shows
 * the chart. Left unset by the file preview, whose markdown is a document on
 * disk rather than a conversation.
 */
export const Markdown: Component<{
  text: string;
  base?: string;
  attachAs?: string;
}> = (props) => {
  const comps = createMemo<SolidMarkdownComponents>(() =>
    props.base ? { ...components, img: imgFor(props.base) } : components,
  );
  // Rebuilt only when the user changes, so an ordinary re-render does not
  // re-create the plugin list and make solid-markdown re-parse.
  const rehype = createMemo<PluggableList>(() =>
    props.attachAs
      ? [rehypeSanitize, [rehypeAttachments, { me: props.attachAs }]]
      : [rehypeSanitize],
  );
  return (
    <div class="tl-markdown">
      <SolidMarkdown
        children={props.text}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehype()}
        components={comps()}
        renderingStrategy="memo"
      />
    </div>
  );
};
