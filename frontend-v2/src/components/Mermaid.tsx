import { createSignal, onMount, Show, type Component } from "solid-js";

/**
 * Renders a ```mermaid fenced block to SVG. Mermaid is loaded lazily via a
 * dynamic import so it stays out of the test path and the initial parse; the
 * singlefile build (inlineDynamicImports) still folds it into the one output
 * file. On any failure we fall back to showing the raw source, so a bad diagram
 * never blanks the message.
 */

type MermaidModule = typeof import("mermaid")["default"];
let mermaidReady: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => m.default);
  }
  return mermaidReady;
}

function isLightTheme(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const cl = document.body.classList;
  return (
    cl.contains("theme-ink") ||
    cl.contains("theme-t3-light") ||
    cl.contains("theme-catppuccin-latte")
  );
}

let idSeq = 0;

export const Mermaid: Component<{ code: string }> = (props) => {
  const [svg, setSvg] = createSignal<string>("");
  const [failed, setFailed] = createSignal(false);

  onMount(async () => {
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: isLightTheme() ? "default" : "dark",
      });
      const { svg: out } = await mermaid.render(`tl-mmd-${++idSeq}`, props.code);
      setSvg(out);
    } catch {
      setFailed(true);
    }
  });

  return (
    <Show
      when={!failed()}
      fallback={<pre class="tl-code tl-mermaid-fallback">{props.code}</pre>}
    >
      {/* eslint-disable-next-line solid/no-innerhtml */}
      <div class="tl-mermaid" innerHTML={svg()} />
    </Show>
  );
};
