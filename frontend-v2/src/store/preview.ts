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
  byteLength,
  dirname,
  extractRecentFiles,
  isAbsolutePath,
  modeApplies as kindModeApplies,
  nextMode,
  type PreviewMode,
  type RecentFile,
  type RendererKind,
} from "./preview.logic";
import { whoami as apiWhoami } from "../lib/lobby-api";
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
import { track } from "../telemetry/track";

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
  /** whether ⬆ Up can still climb — false at the containment root and at "/". */
  canBrowseUp: Accessor<boolean>;

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
  /** open the browse pane from the best directory we know (the Browse button).
   *  Works with no file loaded — that is the only door in for a session with no
   *  transcript. */
  browseStart: () => Promise<void>;
  /** go to the parent of the current browse dir; inert at the containment root. */
  browseUp: () => Promise<void>;
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
  /** injectable "where does this user's home live" lookup, used only as the
   *  cold-open Browse starting point (defaults to /whoami → HOME_BASE/osUser). */
  homeDir?: () => Promise<string | null>;
  /** surface a save result (defaults to the app-wide toast stack). */
  notify?: (message: string, kind: "success" | "error") => void;
  /** confirm-before-discard (defaults to window.confirm; injected in tests). */
  confirm?: (message: string) => boolean;
}

/**
 * Parent of every user's home, mirroring file-api's `homeBase` (auth.go: the
 * containment root is homeBase/<osUser>). Only ever a STARTING GUESS for the
 * directory picker — the server re-derives and enforces the real root on every
 * request, so a wrong guess degrades to the browse pane's error, never to
 * access the client shouldn't have.
 */
const HOME_BASE = "/home";

/** Default home lookup: ask tmux-api who we are, then mirror file-api's layout. */
async function defaultHomeDir(): Promise<string | null> {
  try {
    const me = await apiWhoami();
    return me.osUser ? `${HOME_BASE}/${me.osUser}` : null;
  } catch {
    return null;
  }
}

export function createPreviewStore(deps: PreviewDeps = {}): PreviewStore {
  const loadFile = deps.loadFile ?? apiReadFile;
  const listDir = deps.listDir ?? apiListDir;
  const writeFile = deps.writeFile ?? apiWriteFile;
  const homeDir = deps.homeDir ?? defaultHomeDir;
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
  // The shallowest directory the server will list — file-api's containment
  // root. The client can't know it up front (nothing reports it), so it is
  // learned: seeded from the home lookup when we use it, otherwise recorded the
  // first time a parent listing comes back 400.
  const [browseFloor, setBrowseFloor] = createSignal<string | null>(null);

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

  const canBrowseUp = createMemo(() => {
    const d = browseDir();
    if (!d) return false;
    if (d === browseFloor()) return false; // at the containment root
    return dirname(d) !== d; // "/" is its own parent — nowhere left to go
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
    track("file.edit_opened", { "tl.kind": kind() });
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
      setSize(byteLength(sent)); // ...and so does the header's size chip
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

  /**
   * The Browse button. Starts from the best directory we already know — the
   * loaded file's, else wherever the pane was last, else the newest file the
   * transcript mentions — and only then asks where home is. That last hop is
   * what makes Browse usable on a plain shell session, which has no loaded file
   * and no transcript to mine.
   */
  async function browseStart(): Promise<void> {
    const p = path();
    if (p) return browse(dirname(p));
    const last = browseDir();
    if (last) return browse(last);
    const recent = recentFiles()[0];
    if (recent) return browse(dirname(recent.path));

    const home = await homeDir();
    if (home) {
      setBrowseFloor(home); // home IS the containment root — Up is inert there
      return browse(home);
    }
    // Nothing to go on. Say so in the pane rather than leaving a dead button.
    setBrowsing(true);
    setBrowseDir(null);
    setBrowseEntries([]);
    setBrowseStatus("error");
    setBrowseError("Couldn't work out where to start — type a path above.");
  }

  /**
   * Climb one level, but never out of the containment root. Unlike browse(),
   * the move is committed only once the listing succeeds: a 400 from the parent
   * IS the server telling us the current directory is the root, so we record
   * the floor and leave the pane exactly where it was. Without this, two clicks
   * put the picker on /home, then /, then the relative "." — each an empty list
   * plus an error, with no entry left to click back into.
   */
  async function browseUp(): Promise<void> {
    const d = browseDir();
    if (!d) return;
    if (d === browseFloor()) return; // already at the root — a no-op, not a probe
    const parent = dirname(d);
    if (parent === d) {
      setBrowseFloor(d); // "/" is its own parent
      return;
    }
    const token = ++browseToken;
    const restore = browseStatus(); // what the pane shows if the climb is refused
    setBrowseStatus("loading");
    try {
      const entries = await listDir(parent);
      if (token !== browseToken) return;
      setBrowseDir(parent);
      setBrowseEntries(entries);
      setBrowseError(null);
      setBrowseStatus("loaded");
    } catch (err) {
      if (token !== browseToken) return;
      if (err instanceof FileApiError && err.status === 400) {
        setBrowseFloor(d);
        setBrowseStatus(restore); // put back exactly what was on screen
        return;
      }
      // A real failure (network, 500, 403) is not a floor — show it, and leave
      // Up enabled so a retry is possible.
      setBrowseError(err instanceof Error ? err.message : String(err));
      setBrowseStatus("error");
    }
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
    canBrowseUp,
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
    browseStart,
    browseUp,
    closeBrowse,
  };
}
