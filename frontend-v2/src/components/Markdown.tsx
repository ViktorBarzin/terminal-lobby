import { type Component } from "solid-js";
import { SolidMarkdown, type SolidMarkdownComponents } from "solid-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Mermaid } from "./Mermaid";

/**
 * Assistant markdown renderer (design pillar #2: "full-width assistant markdown
 * with mermaid + inline images", beating T3 which renders neither).
 *   - remark-gfm: tables, task lists, strikethrough, autolinks.
 *   - rehype-sanitize: the transcript can carry arbitrary HTML, so sanitize.
 *   - custom `code`: ```mermaid → <Mermaid>; other fences → <pre>.
 *   - custom `img`: lazy, constrained inline images.
 */

/** Minimal hast shape — avoids depending on @types/hast directly. */
interface HastNode {
  type?: string;
  value?: string;
  properties?: { className?: unknown };
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

const components: SolidMarkdownComponents = {
  code: (props) => {
    const node = props.node as unknown as HastNode;
    const text = hastText(node).replace(/\n$/, "");
    if (props.inline) return <code class="tl-inline-code">{text}</code>;
    const lang = hastLang(node);
    if (lang === "mermaid") return <Mermaid code={text} />;
    return (
      <pre class="tl-code" data-lang={lang || undefined}>
        <code>{text}</code>
      </pre>
    );
  },
  img: (props) => (
    <img
      class="tl-md-img"
      src={props.src}
      alt={props.alt ?? ""}
      loading="lazy"
    />
  ),
  a: (props) => (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  ),
};

export const Markdown: Component<{ text: string }> = (props) => {
  return (
    <div class="tl-markdown">
      <SolidMarkdown
        children={props.text}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
        renderingStrategy="memo"
      />
    </div>
  );
};
