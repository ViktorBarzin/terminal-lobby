import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Event } from "../types/events";
import {
  FileApiError,
  listDir as apiListDir,
  readFile as apiReadFile,
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

  /** open the overlay with no file (recent-files / path box). */
  show: () => void;
  /** open the overlay and load `path` (transcript click, recent, explicit). */
  open: (path: string) => Promise<void>;
  /** close the overlay (abandons any in-flight load). */
  close: () => void;
  setMode: (m: PreviewMode) => void;
  toggleMode: () => void;
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
}

export function createPreviewStore(deps: PreviewDeps = {}): PreviewStore {
  const loadFile = deps.loadFile ?? apiReadFile;
  const listDir = deps.listDir ?? apiListDir;

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

  const recentFiles = createMemo<RecentFile[]>(() =>
    extractRecentFiles(deps.events?.() ?? []),
  );
  const modeApplies = createMemo(() => {
    const k = kind();
    return k !== null && kindModeApplies(k);
  });

  // Monotonic tokens guard a stale load/browse resolving after a close or a
  // newer open (last action wins).
  let loadToken = 0;
  let browseToken = 0;

  async function open(target: string): Promise<void> {
    const token = ++loadToken;
    setOpen(true);
    setBrowsing(false);
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
    loadToken++; // abandon any in-flight load
    browseToken++;
    setOpen(false);
    setBrowsing(false);
  }

  function toggleMode(): void {
    setMode((m) => nextMode(m));
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
    show,
    open,
    close,
    setMode,
    toggleMode,
    browse,
    browseUp,
    closeBrowse,
  };
}
