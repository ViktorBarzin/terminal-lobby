import { onCleanup, onMount, type Component } from "solid-js";
import type { CmLang } from "../store/editor.logic";

/**
 * CodeMirror 6 editor wrapper (roadmap pillar #6). A thin, UNCONTROLLED Solid
 * host: it captures `initialText` + `language` once at mount, builds the
 * EditorView (CodeMirror owns the document from then on), and reports edits via
 * `onChange` / a save request via `onSave`. CodeMirror is pulled in through a
 * dynamic import so it stays out of the initial bundle parse and the unit-test
 * path — the same lazy pattern as CodeView/Mermaid. The real editor behavior is
 * exercised in the app; the logic (language mapping, dirty/save machine) is
 * unit-tested in editor.logic.ts + the preview store.
 *
 * NOT Monaco: CodeMirror 6 is tree-shakeable and inlines cleanly into the
 * single-file build (design §2).
 */
export const CodeEditor: Component<{
  initialText: string;
  language?: CmLang;
  onChange: (text: string) => void;
  onSave?: () => void;
}> = (props) => {
  let host!: HTMLDivElement;
  let view: { destroy: () => void } | null = null;
  let disposed = false;

  onMount(async () => {
    try {
      const { createEditorView } = await import("./codemirror-view");
      if (disposed) return; // unmounted before the lazy chunk resolved
      view = createEditorView({
        parent: host,
        doc: props.initialText,
        language: props.language,
        onChange: props.onChange,
        onSave: props.onSave,
      });
    } catch {
      if (host) host.textContent = "Editor failed to load.";
    }
  });

  onCleanup(() => {
    disposed = true;
    view?.destroy();
    view = null;
  });

  return <div class="tl-editor" ref={host} />;
};
