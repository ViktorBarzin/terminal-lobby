import { createEffect, createSignal, on, Show, type Component } from "solid-js";
import { theme } from "../theme/theme";

/**
 * Renders a ```mermaid fenced block to SVG. Mermaid is loaded lazily via a
 * dynamic import so it stays out of the test path and the initial parse; the
 * singlefile build (inlineDynamicImports) still folds it into the one output
 * file. On any failure we fall back to showing the raw source, so a bad diagram
 * never blanks the message.
 *
 * Three things here are not defaults, and each one is a defect this repo has
 * already met on the pages site:
 *
 *   - `suppressErrorRendering`. Without it a fence that fails to parse strands
 *     mermaid's temporary container in <body> — the "Syntax error in text" bomb
 *     graphic — because render() throws on the parse error BEFORE reaching its
 *     own removeTempElements(). In a long-lived SPA the orphans accumulate and
 *     the page really does scroll to them. With it, cleanup runs before the
 *     rethrow and the fallback below is all anyone sees.
 *   - `useMaxWidth: false`, per diagram type, because mermaid has no global
 *     knob for it. The default shrinks each SVG to its container, which on a
 *     390px phone collapsed a six-node flowchart to a measured 355x27px sliver.
 *     Instead a diagram shrinks to fit only down to MIN_SCALE of its natural
 *     width and the container pans past that (see .tl-mermaid in app.css), so
 *     a narrow screen pans a legible diagram rather than squinting at a
 *     squashed one; print fits the page, since paper cannot pan.
 *   - Re-render on theme change. Mermaid BAKES the palette into the SVG at
 *     render time, so a diagram drawn once on mount keeps the old theme's
 *     colours after a switch — #333 on #0d1117 is 1.5:1, which is invisible.
 *     `on(theme, …)` untracks the body so `props.code` stays non-reactive, and
 *     the sequence guard keeps a slower earlier render from overwriting a newer
 *     one.
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

/** Every diagram type we might render, since useMaxWidth is per-type. */
const NO_MAX_WIDTH = { useMaxWidth: false } as const;
const DIAGRAM_CONFIG = {
  flowchart: NO_MAX_WIDTH,
  sequence: NO_MAX_WIDTH,
  gantt: NO_MAX_WIDTH,
  journey: NO_MAX_WIDTH,
  timeline: NO_MAX_WIDTH,
  state: NO_MAX_WIDTH,
  er: NO_MAX_WIDTH,
  class: NO_MAX_WIDTH,
  pie: NO_MAX_WIDTH,
  quadrantChart: NO_MAX_WIDTH,
  mindmap: NO_MAX_WIDTH,
} as const;

let idSeq = 0;

/** How far a diagram may shrink to fit the column before the box pans instead.
 *  Mermaid draws node labels at 16px, so this keeps them at ~10.4px. */
const MIN_SCALE = 0.65;

/** The narrowest a rendered diagram may be drawn, from the width mermaid wrote
 *  on its root <svg> (useMaxWidth:false makes that the natural width). */
function shrinkFloor(svg: string): string | undefined {
  const m = /^<svg\b[^>]*?\swidth="([\d.]+)"/.exec(svg);
  const width = m ? Number(m[1]) : NaN;
  return width > 0 ? `${Math.round(width * MIN_SCALE)}px` : undefined;
}

export const Mermaid: Component<{ code: string }> = (props) => {
  const [svg, setSvg] = createSignal<string>("");
  const [failed, setFailed] = createSignal(false);
  /** Which render is current; a stale one must not paint over a newer one. */
  let generation = 0;

  createEffect(
    on(theme, async () => {
      const mine = ++generation;
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: isLightTheme() ? "default" : "dark",
          ...DIAGRAM_CONFIG,
        });
        const { svg: out } = await mermaid.render(`tl-mmd-${++idSeq}`, props.code);
        if (mine !== generation) return;
        setSvg(out);
        setFailed(false);
      } catch {
        if (mine !== generation) return;
        setFailed(true);
      }
    }),
  );

  return (
    <Show
      when={!failed()}
      fallback={<pre class="tl-code tl-mermaid-fallback">{props.code}</pre>}
    >
      <div
        class="tl-mermaid"
        style={{ "--tl-mmd-floor": shrinkFloor(svg()) }}
        innerHTML={svg()}
      />
    </Show>
  );
};
