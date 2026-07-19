/**
 * CodeMirror 6 EditorView factory (roadmap pillar #6 editor). This module holds
 * ALL the CodeMirror imports and is loaded ONLY via a dynamic import() from
 * <CodeEditor> — so CodeMirror stays out of the initial parse (and out of the
 * test path) and lands behind one lazy boundary. The single-file build (design
 * §2) folds it into the one output index.html; the dynamic import defers its
 * execution, not its bytes.
 *
 * A lean, hand-composed setup (NOT the `codemirror` umbrella / basicSetup) to
 * stay tree-shakeable: line numbers, history, bracket matching, active-line
 * highlight, the standard + history keymaps, tab-indents, and one grammar. No
 * autocomplete / search / lint (the "no heavyweight extras" the task asks for).
 *
 * Theme + syntax colors are mapped to the app's CSS-var tokens (theme.css), so
 * the editor tracks the active theme (light or dark) with zero per-theme code.
 * Chosen over Monaco specifically to keep the single-file build small.
 */
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import type { CmLang } from "../store/editor.logic";

/** Editor chrome mapped to the theme CSS vars — adapts to every app theme. */
const tlTheme = EditorView.theme({
  "&": {
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-page)",
    fontSize: "12.5px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--terminal-selection)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-page)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover-tint)" },
  ".cm-activeLine": { backgroundColor: "var(--hover-tint)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--hover-tint)",
    outline: "1px solid var(--border-strong)",
  },
});

/** Syntax colors mapped to the theme vars (mirrors the hljs mapping in app.css). */
const tlHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--state-awaiting)" },
  { tag: [t.string, t.special(t.string), t.character, t.inserted], color: "var(--success)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.deleted], color: "var(--danger)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--accent)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.definition(t.typeName)], color: "var(--accent)" },
  { tag: [t.attributeName], color: "var(--accent)" },
  { tag: [t.heading], color: "var(--accent)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--danger)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "var(--text-muted)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--text-muted)" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

/** Map a CmLang key to a CodeMirror language extension, or null (plain text). */
function resolveLanguage(lang: CmLang | undefined): Extension | null {
  switch (lang) {
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "css":
      return css();
    case "python":
      return python();
    case "go":
      return go();
    case "yaml":
      return yaml();
    case "shell":
      return StreamLanguage.define(shell);
    default:
      return null;
  }
}

export interface CreateViewOpts {
  parent: HTMLElement;
  doc: string;
  language?: CmLang;
  /** fired on every document change with the full current text. */
  onChange: (text: string) => void;
  /** fired on Mod-s (Cmd/Ctrl-S) inside the editor. */
  onSave?: () => void;
}

/** Build + mount an EditorView. Caller owns its lifecycle (view.destroy()). */
export function createEditorView(opts: CreateViewOpts): EditorView {
  const lang = resolveLanguage(opts.language);
  const saveKeymap = keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        opts.onSave?.();
        return true;
      },
    },
  ]);
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    saveKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxHighlighting(tlHighlight),
    tlTheme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
    }),
    ...(lang ? [lang] : []),
  ];
  return new EditorView({ doc: opts.doc, parent: opts.parent, extensions });
}
