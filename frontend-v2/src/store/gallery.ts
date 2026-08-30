import { createEffect, createSignal, type Accessor } from "solid-js";
import { clipboardListUrl } from "../lib/config";
import {
  sortNewestFirst,
  stepBack as stepBackView,
  type GalleryView,
  type StoredImage,
} from "./gallery.logic";
import { track } from "../telemetry/track";
import { fetchWithDeadline } from "../lib/http";

/**
 * The session image-gallery store (feature-inventory Cat.8). Owns the overlay's
 * view machine (closed → grid → lightbox), the per-session image list (fetched
 * fresh on every open — no cache, so a just-pasted image shows), and the
 * lightbox index. The Gallery component is a pure view over this.
 *
 * The list/sort/badge rules and the step-back machine are the pure gallery.logic
 * layer; this wires them to Solid signals + the /clipboard/list fetch.
 */
export type GalleryStatus = "idle" | "loading" | "error";

export interface GalleryStore {
  view: Accessor<GalleryView>;
  images: Accessor<StoredImage[]>;
  status: Accessor<GalleryStatus>;
  error: Accessor<string | null>;
  /** the session the current list belongs to (for building image URLs). */
  session: Accessor<string | null>;
  lightboxIndex: Accessor<number>;
  /** open the grid for the currently-selected session and (re)fetch the list. */
  open: () => Promise<void>;
  /** enlarge the image at grid index i (no-op unless the grid is showing i). */
  openLightbox: (i: number) => void;
  /** step back one view: lightbox → grid → closed. Escape / backdrop click. */
  stepBack: () => void;
  /** close outright (session switch). */
  close: () => void;
}

export interface GalleryDeps {
  /** the currently-selected session, or null when none is attached. */
  session: () => string | null;
  /** injectable list fetcher (defaults to GET /clipboard/list). */
  fetchList?: (session: string) => Promise<StoredImage[]>;
  /** surface "open a session first" etc. */
  notify?: (message: string, kind: "error" | "info") => void;
}

async function defaultFetchList(session: string): Promise<StoredImage[]> {
  const resp = await fetchWithDeadline(clipboardListUrl(session), {
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? (data as StoredImage[]) : [];
}

export function createGalleryStore(deps: GalleryDeps): GalleryStore {
  const fetchList = deps.fetchList ?? defaultFetchList;

  const [view, setView] = createSignal<GalleryView>("closed");
  const [images, setImages] = createSignal<StoredImage[]>([]);
  const [status, setStatus] = createSignal<GalleryStatus>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [session, setSession] = createSignal<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = createSignal(0);

  // A monotonic token guards against a stale fetch resolving after a close or a
  // reopen for a different session (last-open wins).
  let loadToken = 0;

  async function open(): Promise<void> {
    const s = deps.session();
    if (!s) {
      deps.notify?.("Open a session first", "error");
      return;
    }
    const token = ++loadToken;
    setSession(s);
    setImages([]);
    setError(null);
    setStatus("loading");
    setView("grid");
    try {
      const list = await fetchList(s);
      if (token !== loadToken) return; // superseded by a newer open/close
      setImages(sortNewestFirst(list));
      setStatus("idle");
    } catch (err) {
      if (token !== loadToken) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function openLightbox(i: number): void {
    if (view() !== "grid") return;
    if (i < 0 || i >= images().length) return;
    setLightboxIndex(i);
    setView("lightbox");
    // Emit AFTER the guards so a rejected open (not on the grid, or an
    // out-of-range index) does not report a phantom image_opened. (QA finding.)
    track("gallery.image_opened", { "tl.count": i });
  }

  function stepBack(): void {
    setView((v) => stepBackView(v));
  }

  function close(): void {
    loadToken++; // abandon any in-flight fetch
    setView("closed");
  }

  // Switching the selected session out from under an open gallery closes it —
  // its grid belongs to the old session.
  createEffect(() => {
    const cur = deps.session();
    if (view() !== "closed" && cur !== session()) close();
  });

  return {
    view,
    images,
    status,
    error,
    session,
    lightboxIndex,
    open,
    openLightbox,
    stepBack,
    close,
  };
}
