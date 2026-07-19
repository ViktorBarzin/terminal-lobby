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
 */

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

  onMount(async () => {
    try {
      const hljs = await loadHljs();
      const lang = props.language;
      const out =
        lang && hljs.getLanguage(lang)
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
        <pre class="tl-code tl-codeview hljs" data-lang={props.language || undefined}>
          <code>{props.code}</code>
        </pre>
      }
    >
      <pre class="tl-code tl-codeview hljs" data-lang={props.language || undefined}>
        {/* eslint-disable-next-line solid/no-innerhtml */}
        <code innerHTML={markup()} />
      </pre>
    </Show>
  );
};
