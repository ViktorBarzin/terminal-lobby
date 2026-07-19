import { extOf, type RendererKind } from "./preview.logic";

/**
 * Pure, DOM-free logic for the quick-EDIT mode on the file-preview surface
 * (roadmap pillar #6). Keeps the two risky mappings — file-extension -> editor
 * language, and the edit/dirty/save state machine — in a unit-tested module so
 * the store + the CodeMirror wrapper stay thin. No CodeMirror, no Solid, no DOM
 * here (CodeMirror is a heavyweight DOM dependency loaded lazily in the wrapper).
 */

/**
 * A CodeMirror language key. The wrapper (CodeEditor) maps each to a lazily
 * imported `@codemirror/lang-*` extension; `shell` uses a legacy StreamLanguage.
 * `undefined` = no grammar (plain text — the editor still works, just unstyled).
 */
export type CmLang =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "json"
  | "markdown"
  | "html"
  | "css"
  | "python"
  | "go"
  | "yaml"
  | "shell";

/** Extension -> CodeMirror language key. Absent = plain text. */
const CM_LANG_BY_EXT: Record<string, CmLang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  py: "python",
  pyi: "python",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

/**
 * CodeMirror language key for a path (by extension), or undefined for plain
 * text. Distinct from preview.logic's `languageForPath` (highlight.js ids for
 * the READ-only view) — the editor uses real CodeMirror grammars, and tsx/jsx
 * are split out because `@codemirror/lang-javascript` takes them as options.
 */
export function cmLanguageForPath(path: string): CmLang | undefined {
  return CM_LANG_BY_EXT[extOf(path)];
}

/**
 * Whether a loaded file kind can be edited. Text/code/markdown/html are
 * editable (markdown/html edit their RAW source, then preview); images and
 * binaries are not, and there is nothing to edit before a file has loaded.
 */
export function canEdit(kind: RendererKind | null): boolean {
  return kind === "code" || kind === "markdown" || kind === "html";
}

/* ============================================================================
   Edit / dirty / save state machine (pure reducer)

   idle  ── enter ──▶ clean ── change(≠saved) ──▶ dirty
                        ▲                            │
                        │ change(=saved)             │ saveStart
                        └────────────────────────────┤
   dirty ── saveStart ─▶ saving ── saveOk ──▶ clean  │
                              └──── saveFail ──▶ dirty┘
   (any) ── exit ──▶ idle

   `saved` is the last content the server accepted; `draft` is what's in the
   editor now. isDirty/hasUnsavedChanges are derived from the two, so a revert
   back to the saved text correctly clears the dirty flag.
   ========================================================================== */

export type EditPhase = "idle" | "clean" | "dirty" | "saving";

export interface EditState {
  phase: EditPhase;
  /** last-saved content (server-accepted). */
  saved: string;
  /** current editor content. */
  draft: string;
}

export type EditAction =
  | { type: "enter"; text: string }
  | { type: "change"; text: string }
  | { type: "saveStart" }
  /** `text` is the exact content the server accepted (the draft at save time),
   *  which may lag the current draft if the user kept typing mid-round-trip. */
  | { type: "saveOk"; text: string }
  | { type: "saveFail" }
  | { type: "exit" };

export const initialEditState: EditState = {
  phase: "idle",
  saved: "",
  draft: "",
};

/** Pure transition. Unknown actions in a wrong phase are no-ops (return `s`). */
export function editReduce(s: EditState, a: EditAction): EditState {
  switch (a.type) {
    case "enter":
      // Begin editing: seed saved+draft from the loaded content, start clean.
      return { phase: "clean", saved: a.text, draft: a.text };
    case "change": {
      if (s.phase === "idle") return s; // not editing — ignore stray changes
      const phase = a.text === s.saved ? "clean" : "dirty";
      // While a save is in flight we keep the "saving" phase but track the draft
      // (a keystroke during the round-trip must not lose the newer content).
      return { ...s, draft: a.text, phase: s.phase === "saving" ? "saving" : phase };
    }
    case "saveStart":
      // Only a dirty editor has anything to save.
      return s.phase === "dirty" ? { ...s, phase: "saving" } : s;
    case "saveOk": {
      // The content the server accepted becomes the new baseline. If the user
      // kept typing during the round-trip, the draft is ahead of it → dirty
      // again against the fresh baseline; otherwise clean.
      const phase = s.draft === a.text ? "clean" : "dirty";
      return { ...s, saved: a.text, phase };
    }
    case "saveFail":
      // Back to dirty so the user can retry (draft is unchanged).
      return s.phase === "saving" ? { ...s, phase: "dirty" } : s;
    case "exit":
      return initialEditState;
    default:
      return s;
  }
}

/** Whether the editor is open (any non-idle phase). */
export function isEditing(s: EditState): boolean {
  return s.phase !== "idle";
}

/**
 * Whether the draft differs from the last-saved content. True during "saving"
 * too (the round-trip hasn't confirmed yet), so a close mid-save still warns.
 * Drives both the dirty indicator and confirm-before-discard.
 */
export function hasUnsavedChanges(s: EditState): boolean {
  return s.phase !== "idle" && s.draft !== s.saved;
}

/** Dirty = has unsaved edits AND not currently mid-save (button-enable state). */
export function isDirty(s: EditState): boolean {
  return s.phase === "dirty";
}
