import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Event } from "../types/events";
import {
  FileApiError,
  listDir as apiListDir,
  readFile as apiReadFile,
  writeFile as apiWriteFile,
  type FileEntry,
  type LoadedFile,
} from "../lib/file-api";
import {
  basename,
  dirname,
  extractRecentFiles,
  isAbsolutePath,
  modeApplies as kindModeApplies,
  nextMode,
  type PreviewMode,
  type RecentFile,
  type RendererKind,
} from "./preview.logic";
import {
  canEdit as kindCanEdit,
  cmLanguageForPath,
  editReduce,
  hasUnsavedChanges,
  initialEditState,
  isDirty as stateIsDirty,
  isEditing,
  type CmLang,
  type EditState,
} from "./editor.logic";
import { toasts } from "./toast";

/** Message shown before discarding unsaved edits (close / switch file / exit). */
export const DISCARD_MESSAGE = "Discard unsaved changes?";

/**
 * The file-preview store (roadmap pillar #6). Owns the overlay's open/closed
 * flag, the loaded file (kind + text/size), the raw|rendered toggle, a
 * transcript-derived recent-files list, and an optional directory browse. The
 * FilePreview component is a pure view over this. The file fetch + classify is
 * the pure preview.logic layer + the file-api client; both are injectable so the
 * store is unit-tested without a network.
 */
export type PreviewStatus = "idle" | "loading" | "loaded" | "error";

export interface PreviewStore {
  isOpen: Accessor<boolean>;
  path: Accessor<string | null>;
  name: Accessor<string>;
  status: Accessor<PreviewStatus>;
  kind: Accessor<RendererKind | null>;
  language: Accessor<string | undefined>;
  text: Accessor<string>;
  size: Accessor<number | null>;
  error: Accessor<string | null>;
  mode: Accessor<PreviewMode>;
  /** whether the raw|rendered toggle applies to the loaded kind (md/html). */
  modeApplies: Accessor<boolean>;
  recentFiles: Accessor<RecentFile[]>;
  // directory browse (GET /files/list)
  browsing: Accessor<boolean>;
  browseDir: Accessor<string | null>;
  browseEntries: Accessor<FileEntry[]>;
  browseStatus: Accessor<PreviewStatus>;
  browseError: Accessor<string | null>;

  // ---- quick-edit mode (roadmap pillar #6) --------------------------------
  /** whether the loaded kind can be edited (code/markdown/html, not img/binary). */
  canEdit: Accessor<boolean>;
  /** whether the editor is currently open. */
  editing: Accessor<boolean>;
  /** draft differs from saved AND a save is not in flight (Save-button enable). */
  dirty: Accessor<boolean>;
  /** draft differs from saved, including mid-save (dirty dot + discard prompt). */
  unsaved: Accessor<boolean>;
  /** a save round-trip is in flight. */
  saving: Accessor<boolean>;
  /** current editor content (for the save round-trip / tests). */
  draft: Accessor<string>;
  /** CodeMirror language key for the loaded path, or undefined (plain text). */
  editLanguage: Accessor<CmLang | undefined>;

  /** open the overlay with no file (recent-files / path box). */
  show: () => void;
  /** open the overlay and load `path` (transcript click, recent, explicit).
   *  Prompts before discarding unsaved edits; declining aborts the switch. */
  open: (path: string) => Promise<void>;
  /** close the overlay (abandons any in-flight load). Prompts if there are
   *  unsaved edits; declining keeps the overlay open. */
  close: () => void;
  setMode: (m: PreviewMode) => void;
  toggleMode: () => void;
  /** enter edit mode on the loaded file (no-op if the kind is not editable). */
  beginEdit: () => void;
  /** record the editor's current content (CodeMirror change listener). */
  setDraft: (text: string) => void;
  /** save the draft via POST /files/write; toasts on success/failure. */
  save: () => Promise<void>;
  /** Edit ⇄ View toggle. Leaving a dirty editor prompts before discarding. */
  toggleEdit: () => void;
  /** leave edit mode; prompts if dirty. Returns true if it actually exited. */
  requestExitEdit: () => boolean;
  /** list a directory into the browse pane. */
  browse: (dir: string) => Promise<void>;
  /** go to the parent of the current browse dir. */
  browseUp: () => void;
  /** leave browse mode, back to the loaded file / idle. */
  closeBrowse: () => void;
}

export interface PreviewDeps {
  /** the session's normalized events, for the recent-files list. */
  events?: () => Event[];
  /** injectable file reader (defaults to the file-api client). */
  loadFile?: (path: string, name: string) => Promise<LoadedFile>;
  /** injectable directory lister (defaults to the file-api client). */
  listDir?: (dir: string, all?: boolean) => Promise<FileEntry[]>;
  /** injectable file writer (defaults to the file-api client). */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** surface a save result (defaults to the app-wide toast stack). */
  notify?: (message: string, kind: "success" | "error") => void;
  /** confirm-before-discard (defaults to window.confirm; injected in tests). */
  confirm?: (message: string) => boolean;
}

export function createPreviewStore(deps: PreviewDeps = {}): PreviewStore {
  const loadFile = deps.loadFile ?? apiReadFile;
  const listDir = deps.listDir ?? apiListDir;
  const writeFile = deps.writeFile ?? apiWriteFile;
  const notify =
    deps.notify ?? ((message, kind) => toasts.push({ kind, message }));
  const confirm =
    deps.confirm ??
    ((message: string) =>
      typeof window !== "undefined" ? window.confirm(message) : true);

  const [isOpen, setOpen] = createSignal(false);
  const [path, setPath] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [status, setStatus] = createSignal<PreviewStatus>("idle");
  const [kind, setKind] = createSignal<RendererKind | null>(null);
  const [language, setLanguage] = createSignal<string | undefined>(undefined);
  const [text, setText] = createSignal("");
  const [size, setSize] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<PreviewMode>("rendered");

  const [browsing, setBrowsing] = createSignal(false);
  const [browseDir, setBrowseDir] = createSignal<string | null>(null);
  const [browseEntries, setBrowseEntries] = createSignal<FileEntry[]>([]);
  const [browseStatus, setBrowseStatus] = createSignal<PreviewStatus>("idle");
  const [browseError, setBrowseError] = createSignal<string | null>(null);

  // ---- quick-edit state (roadmap pillar #6) -------------------------------
  const [editState, setEditState] = createSignal<EditState>(initialEditState);
  const dispatch = (a: Parameters<typeof editReduce>[1]): void => {
    setEditState((s) => editReduce(s, a));
  };

  const recentFiles = createMemo<RecentFile[]>(() =>
    extractRecentFiles(deps.events?.() ?? []),
  );
  const modeApplies = createMemo(() => {
    const k = kind();
    return k !== null && kindModeApplies(k);
  });

  const canEdit = createMemo(() => status() === "loaded" && kindCanEdit(kind()));
  const editing = createMemo(() => isEditing(editState()));
  const dirty = createMemo(() => stateIsDirty(editState()));
  const unsaved = createMemo(() => hasUnsavedChanges(editState()));
  const saving = createMemo(() => editState().phase === "saving");
  const draft = createMemo(() => editState().draft);
  const editLanguage = createMemo<CmLang | undefined>(() => {
    const p = path();
    return p ? cmLanguageForPath(p) : undefined;
  });

  /** Ask before throwing away unsaved edits; true = OK to proceed. */
  function confirmDiscard(): boolean {
    return !unsaved() || confirm(DISCARD_MESSAGE);
  }

  // Monotonic tokens guard a stale load/browse resolving after a close or a
  // newer open (last action wins).
  let loadToken = 0;
  let browseToken = 0;

  async function open(target: string): Promise<void> {
    // Switching files discards the current draft — confirm first (declining
    // keeps the current file + editor intact).
    if (!confirmDiscard()) return;
    const token = ++loadToken;
    setOpen(true);
    setBrowsing(false);
    setEditState(initialEditState);
    setPath(target);
    setName(basename(target));
    setKind(null);
    setLanguage(undefined);
    setText("");
    setSize(null);
    setError(null);
    setMode("rendered");

    if (!isAbsolutePath(target)) {
      setStatus("error");
      setError("Enter an absolute path (starting with /).");
      return;
    }
    setStatus("loading");
    try {
      const f = await loadFile(target, basename(target));
      if (token !== loadToken) return; // superseded
      setKind(f.kind);
      setLanguage(f.language);
      setText(f.text ?? "");
      setSize(f.size ?? null);
      setStatus("loaded");
    } catch (err) {
      if (token !== loadToken) return;
      setError(
        err instanceof FileApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setStatus("error");
    }
  }

  function show(): void {
    setOpen(true);
  }

  function close(): void {
    if (!confirmDiscard()) return; // keep the overlay open on a declined prompt
    loadToken++; // abandon any in-flight load
    browseToken++;
    saveToken++; // abandon any in-flight save resolution
    setOpen(false);
    setBrowsing(false);
    setEditState(initialEditState);
  }

  function toggleMode(): void {
    setMode((m) => nextMode(m));
  }

  // ---- quick-edit actions -------------------------------------------------
  // A monotonic token so a save resolving after the file was switched/closed
  // (or the editor exited) can't clobber the new state (mirrors loadToken).
  let saveToken = 0;

  function beginEdit(): void {
    if (!canEdit()) return;
    dispatch({ type: "enter", text: text() });
  }

  function setDraft(next: string): void {
    dispatch({ type: "change", text: next });
  }

  function requestExitEdit(): boolean {
    if (!editing()) return true;
    if (!confirmDiscard()) return false;
    dispatch({ type: "exit" });
    return true;
  }

  function toggleEdit(): void {
    if (editing()) requestExitEdit();
    else beginEdit();
  }

  async function save(): Promise<void> {
    if (!dirty()) return; // nothing to save (clean, saving, or not editing)
    const p = path();
    if (!p) return;
    const sent = draft();
    const token = ++saveToken;
    dispatch({ type: "saveStart" });
    try {
      await writeFile(p, sent);
      if (token !== saveToken) return; // superseded by a switch/close
      dispatch({ type: "saveOk", text: sent });
      setText(sent); // the read-only view now reflects the saved content
      notify("Saved", "success");
    } catch (err) {
      if (token !== saveToken) return;
      dispatch({ type: "saveFail" });
      const message =
        err instanceof FileApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      notify(message, "error");
    }
  }

  async function browse(dir: string): Promise<void> {
    const token = ++browseToken;
    setBrowsing(true);
    setBrowseDir(dir);
    setBrowseEntries([]);
    setBrowseError(null);
    setBrowseStatus("loading");
    try {
      const entries = await listDir(dir);
      if (token !== browseToken) return;
      setBrowseEntries(entries);
      setBrowseStatus("loaded");
    } catch (err) {
      if (token !== browseToken) return;
      setBrowseError(err instanceof Error ? err.message : String(err));
      setBrowseStatus("error");
    }
  }

  function browseUp(): void {
    const d = browseDir();
    if (d) void browse(dirname(d));
  }

  function closeBrowse(): void {
    browseToken++;
    setBrowsing(false);
  }

  return {
    isOpen,
    path,
    name,
    status,
    kind,
    language,
    text,
    size,
    error,
    mode,
    modeApplies,
    recentFiles,
    browsing,
    browseDir,
    browseEntries,
    browseStatus,
    browseError,
    canEdit,
    editing,
    dirty,
    unsaved,
    saving,
    draft,
    editLanguage,
    show,
    open,
    close,
    setMode,
    toggleMode,
    beginEdit,
    setDraft,
    save,
    toggleEdit,
    requestExitEdit,
    browse,
    browseUp,
    closeBrowse,
  };
}
