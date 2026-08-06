import { createSignal, onMount, Show, type Component } from "solid-js";

/**
 * Read-only syntax-highlighted code view (roadmap pillar #6). highlight.js core
 * + a curated language set is loaded lazily via a dynamic import (cached
 * singleton, mirroring Mermaid) so it stays out of the test path and the initial
 * parse; the singlefile build folds it into the one output file. The raw code is
 * rendered as plain text first (always visible + the fallback), then swapped for
 * highlighted markup on mount. Any failure keeps the plain text — a bad grammar
 * never blanks the view. NOT an editor: no Monaco.
 *
 * Safety: highlight.js HTML-escapes its input and emits ONLY its own
 * `<span class="hljs-*">` markup — source HTML is never passed through — so the
 * injected string carries no user HTML. Same reviewed pattern as Mermaid's SVG.
 *
 * Size guard: highlighting is synchronous, so its cost is a freeze of the whole
 * lobby — no scrolling, no clicks, no stream updates — until it returns. On the
 * deployed build, opening a 9 MB .txt (file-api allows 10 MB and the 413 copy
 * advertises it, so this is a file the app promises to preview) blocked the main
 * thread for 156 s; 1 MB blocked 9.9 s. Past the ceilings below we therefore
 * keep the plain-text render, which is the same thing the view shows first
 * anyway. `highlightAuto` runs every registered grammar and costs ~6x a known
 * one per byte — measured, warm V8: 128 KiB auto 1185 ms vs 236 ms for
 * typescript; 16 KiB auto 172 ms — so it gets the lower ceiling. Both sit near a
 * ~200 ms budget on the worst content measured.
 */
const HIGHLIGHT_MAX_CHARS = 128 * 1024;
const HIGHLIGHT_AUTO_MAX_CHARS = 16 * 1024;

type HljsModule = typeof import("highlight.js/lib/core")["default"];
let hljsReady: Promise<HljsModule> | null = null;

async function loadHljs(): Promise<HljsModule> {
  if (!hljsReady) {
    hljsReady = (async () => {
      const [
        { default: hljs },
        typescript,
        javascript,
        python,
        go,
        rust,
        bash,
        yaml,
        xml,
        json,
        markdown,
        css,
        sql,
        ini,
        dockerfile,
        diff,
        java,
        c,
        cpp,
        ruby,
        php,
      ] = await Promise.all([
        import("highlight.js/lib/core"),
        import("highlight.js/lib/languages/typescript"),
        import("highlight.js/lib/languages/javascript"),
        import("highlight.js/lib/languages/python"),
        import("highlight.js/lib/languages/go"),
        import("highlight.js/lib/languages/rust"),
        import("highlight.js/lib/languages/bash"),
        import("highlight.js/lib/languages/yaml"),
        import("highlight.js/lib/languages/xml"),
        import("highlight.js/lib/languages/json"),
        import("highlight.js/lib/languages/markdown"),
        import("highlight.js/lib/languages/css"),
        import("highlight.js/lib/languages/sql"),
        import("highlight.js/lib/languages/ini"),
        import("highlight.js/lib/languages/dockerfile"),
        import("highlight.js/lib/languages/diff"),
        import("highlight.js/lib/languages/java"),
        import("highlight.js/lib/languages/c"),
        import("highlight.js/lib/languages/cpp"),
        import("highlight.js/lib/languages/ruby"),
        import("highlight.js/lib/languages/php"),
      ]);
      const reg: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
        typescript: typescript.default,
        javascript: javascript.default,
        python: python.default,
        go: go.default,
        rust: rust.default,
        bash: bash.default,
        yaml: yaml.default,
        xml: xml.default,
        json: json.default,
        markdown: markdown.default,
        css: css.default,
        sql: sql.default,
        ini: ini.default,
        dockerfile: dockerfile.default,
        diff: diff.default,
        java: java.default,
        c: c.default,
        cpp: cpp.default,
        ruby: ruby.default,
        php: php.default,
      };
      for (const [n, lang] of Object.entries(reg)) hljs.registerLanguage(n, lang);
      return hljs;
    })();
  }
  return hljsReady;
}

export const CodeView: Component<{ code: string; language?: string }> = (
  props,
) => {
  const [markup, setMarkup] = createSignal<string>("");
  const [ready, setReady] = createSignal(false);
  const [skipped, setSkipped] = createSignal(false);

  onMount(async () => {
    try {
      // Over the larger ceiling nothing can highlight this, so don't even pay
      // for the grammars.
      if (props.code.length > HIGHLIGHT_MAX_CHARS) {
        setSkipped(true);
        return;
      }
      const hljs = await loadHljs();
      const lang = props.language;
      const known = lang ? hljs.getLanguage(lang) : undefined;
      // Auto-detection runs every registered grammar, so it stops sooner.
      if (!known && props.code.length > HIGHLIGHT_AUTO_MAX_CHARS) {
        setSkipped(true);
        return;
      }
      const out =
        known && lang
          ? hljs.highlight(props.code, { language: lang }).value
          : hljs.highlightAuto(props.code).value;
      setMarkup(out);
      setReady(true);
    } catch {
      /* keep the plain-text fallback */
    }
  });

  return (
    <Show
      when={ready()}
      fallback={
        <>
          <Show when={skipped()}>
            <div class="tl-preview-note tl-codeview-skipped">
              Syntax highlighting is off — this file is too large to colour
              without freezing the page.
            </div>
          </Show>
          <pre
            class="tl-code tl-codeview hljs"
            data-lang={props.language || undefined}
            data-highlight={skipped() ? "skipped" : undefined}
          >
            <code>{props.code}</code>
          </pre>
        </>
      }
    >
      <pre class="tl-code tl-codeview hljs" data-lang={props.language || undefined}>
        {/* eslint-disable-next-line solid/no-innerhtml */}
        <code innerHTML={markup()} />
      </pre>
    </Show>
  );
};
