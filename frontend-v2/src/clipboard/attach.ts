import { createSignal, type Accessor } from "solid-js";
import { firstImageBlob } from "./paste";
import { dragHasFiles } from "./drop";
import { lobbyDragActive } from "../dnd/sidebar";
import { uploadBlob, uploadField } from "./upload";
import { showToast, toasts, type ToastKind } from "../store/toast";
import { track } from "../telemetry/track";

/**
 * The DOM glue for the paste path + drop-target (feature-inventory Cat.4 "Paste
 * path", Cat.1 "Drop-target overlay", Cat.8 "Drag-and-drop file upload").
 * Ported from the vanilla frontend/index.html handlers, adapted for the SPA: an
 * uploaded image's path is typed at the pty over the `sendToPty` seam, wired to
 * `window.__tlSendToTerminal`, the bridge the mounted TerminalNative owns,
 * rather than through a local xterm sendInput.
 *
 * Scoped to a mounted SessionView (a session is attached, so there is a pty to
 * send to). The paste listener is on the DOCUMENT and capture-phase, so it sees
 * a paste that landed on the terminal as well as one on the SPA chrome (text
 * mode, gallery, composer), and it runs before TerminalNative's own host
 * listener because it sits higher on the capture path. The split is deliberate,
 * and TerminalNative documents its half beside `onPasteEvent`: an image is this
 * module's, text is the terminal's. Until 2026-09-05 the terminal was a
 * separate document, and a paste inside it was handled entirely by that page's
 * own listeners, out of this module's reach.
 *
 * THE TWO INTAKES ARE ROUTED DIFFERENTLY AND THAT IS THE POINT. Both listen on
 * shared nodes, so both are delivered to every mounted install, and both have
 * to pick one. A paste carries a clipboard and nothing else, so it goes to the
 * install whose pty the keystrokes are already going to (`active`). A drop
 * carries a POINT, so it goes to the tile under it (`tileBox`, and the election
 * below). Gating the drop on focus as well is what put a file dropped on tile B
 * into tile A's session on 2026-09-12.
 */

/**
 * One tile's box in VIEWPORT coordinates — the space `left`/`top`/`right`/
 * `bottom` are measured in by a `DragEvent`'s `clientX`/`clientY`, so a
 * `DOMRect` straight off `getBoundingClientRect()` already is one.
 *
 * Deliberately NOT `store/workspace-tree.ts`'s `Rect`, which is the same four
 * numbers in the workspace CONTAINER's coordinates and carries the session key
 * with it. Sharing that type here would make the two coordinate spaces look
 * interchangeable in the one place where mixing them puts every drop in the
 * wrong tile by the width of the sidebar.
 */
export interface TileBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ImageClipboardDeps {
  /** the attached session name (the upload's per-session store bucket). */
  session: () => string;
  /**
   * TRUE when a paste or drop belongs to the TEXT view's composer rather than to
   * the pty (design 2026-08-17 decision 5).
   *
   * This is the fix for the reported bug. The paste listener below is
   * document-level and CAPTURE-phase, and it preventDefault()s and
   * stopPropagation()s — so it ran before the composer's own handler could, and
   * every pasted image ended up as a path on the terminal's input line, which a
   * text-view reader never sees. When this says the text view owns the gesture,
   * this module declines it entirely and lets it reach the composer.
   *
   * Absent → the pty, which is the behaviour the terminal view keeps unchanged.
   */
  composerOwns?: () => boolean;
  /** send text (an uploaded path) to the pty; true if a terminal received it. */
  sendToPty: (text: string) => boolean;
  /** FALSE while this client only WATCHES the session, which refuses both
   *  intakes. The upload is why it is refused up front rather than left to fail
   *  at the pty: it files the image in that session's gallery — someone else's,
   *  in a tab acting as another user — and only then types the path, so a
   *  refused write would leave a half-done action behind. Absent = enabled. */
  enabled?: () => boolean;
  /**
   * TRUE when this session is the one ON SCREEN. Absent = on screen.
   *
   * Distinct from `enabled`, which is about the session's ROLE (watching), and
   * checked earlier — the listeners below are on the shared document, and every
   * mounted SessionView installs a set. Since 0e94a63 ("keep every session you
   * open mounted") a tab holds one per session it has ever opened, all of them
   * live, so without this a single paste is handled once per open session.
   *
   * That is the "image sometimes pastes in multiple times" report, and
   * "sometimes" was "as many times as you have sessions open": one paste on
   * 2026-08-29 left four byte-identical PNGs in four session directories of the
   * store within 307ms, each upload then typing its own path into the one
   * visible terminal, because `sendToPty` resolves through a global the visible
   * session owns.
   *
   * `e.stopPropagation()` cannot stand in for this. It stops other NODES, not
   * sibling listeners on the same node in the same phase — and even
   * `stopImmediatePropagation` would hand the gesture to whichever listener
   * registered FIRST, which is the oldest session mounted, not the one being
   * looked at.
   */
  active?: () => boolean;
  /**
   * This view's TILE, in viewport coordinates, or null when it is not one — it
   * is off screen, it is a hidden preload, or there is no workspace at all.
   *
   * A DROP HAS COORDINATES AND A PASTE DOES NOT, and that is the whole reason
   * this exists beside {@link active}. `active` is the right gate for a paste:
   * a paste arrives with nothing but a clipboard, so the only sane destination
   * is the pty the keystrokes are already going to. A drop arrives with a
   * point, and the tile under that point is what a person dropping a screenshot
   * on it means. Measured on 2026-09-12 in a four-tile workspace: dragging a
   * file onto tile B while tile A held focus uploaded into A's session
   * directory and typed A's path at A's pty, because the window listener that
   * took it was A's. No `pointerdown` ever reaches B — a file drag from the
   * desktop sends none — so nothing moved focus first, and there is no gesture
   * a person could have made to fix it.
   *
   * NULL IS AN ANSWER AND NOT AN OMISSION. A hidden preload (`.tl-offstage`) is
   * laid out at full size behind whatever is on screen, so a box measured
   * without checking would cover every tile and take every drop. Return null
   * for a view that is not on screen, and return a real box for the ordinary
   * lobby's single visible session too — a box that covers the whole view takes
   * every drop in it, which is exactly what one session on screen does today.
   *
   * When NO mounted view reports a box, the drop path falls back to {@link
   * active} unchanged, byte for byte. That is the path the lobby without a
   * workspace, `NewSessionComposer` and every existing test take.
   */
  tileBox?: () => TileBox | null;
  /**
   * Move focus to THIS view, called when a drop lands in its tile and focus is
   * somewhere else.
   *
   * Part of the fix, not decoration. The uploaded path is typed through
   * {@link sendToPty}, which resolves `window.__tlSendToTerminal` — a handle
   * `lib/ownwhile.ts` gives to the FOCUSED tile and to no other. So routing the
   * upload to tile B without moving focus swaps one wrong outcome for another:
   * the image lands in B's gallery and B's path is typed into A's pty. Focus is
   * moved BEFORE the upload starts, so the handle has been re-bound by the time
   * the path is sent, and it also settles what happens next — the prompt you
   * type after dropping a screenshot goes to the session you dropped it on.
   */
  focusTile?: () => void;
  /** Hand dropped files to the text view's composer (used when composerOwns). */
  onComposerFiles?: (files: File[]) => Promise<unknown>;
  /** seams for tests (default to the live document/window/uploader/toaster). */
  doc?: Document;
  win?: Window;
  upload?: typeof uploadBlob;
  toast?: (message: string, kind: ToastKind, timeoutMs?: number) => number;
  dismiss?: (id: number) => void;
}

export interface ImageClipboard {
  /** true while a file-bearing drag is over the window (raises the overlay). */
  dropActive: Accessor<boolean>;
  /** The drop intake, for callers that obtained files some other way — the
   *  Upload button's file picker. Same uploads, same toasts, same paths typed
   *  at the pty; only the telemetry gesture differs. */
  uploadFiles: (files: File[], via?: "drop" | "picker") => Promise<void>;
  dispose: () => void;
}

/**
 * The bytes one or more uploaded paths type at the pty input line: the paths,
 * space-separated, plus a TRAILING space.
 *
 * The path is deliberately left sitting on the input line — that is how a user
 * attaches an image to the prompt they are about to write. Nothing submits it
 * and nothing clears the line, so whatever is written next lands immediately
 * after it: the composer's /prompt inject (session-events pastes into the live
 * line), the mobile bracketed-paste branch, a second image, or the user's own
 * typing. Without the trailing separator those fuse into ONE token and the
 * user's prompt is destroyed — measured on the dev tier as
 * `…/pasted-….pngecho COMPOSER-MARKER`, which ran a garbage command in a shell
 * and submitted an unreadable line to a Claude REPL.
 *
 * A space, not a newline: a newline would SUBMIT the bare path, which is the
 * opposite of leaving it there to be attached. Separate, don't erase.
 */
function ptyPathBytes(paths: string[]): string {
  return paths.join(" ") + " ";
}

/** One mounted install, as the drop election sees it. Identity is the object. */
interface DropClient {
  /** This install's tile, or null when it is not one. See `tileBox`. */
  box: () => TileBox | null;
  /** TRUE for the install whose pty the keystrokes are going to. */
  focused: () => boolean;
}

/**
 * Every mounted install, in mount order.
 *
 * A module-level registry rather than per-instance reasoning, because electing
 * a winner is the one decision an instance CANNOT make alone. The listeners are
 * on the shared window and every mounted `SessionView` installs a set, so a
 * drop is delivered to all of them; four instances each answering "is this
 * point in my box?" independently is fine until the point sits on a seam, where
 * `toRects` gives adjacent tiles a shared boundary and both would answer yes.
 * One election, one winner, and every instance compares it to itself.
 *
 * A `Set` for O(1) removal on dispose, and its insertion order is what breaks a
 * seam tie: the first install to have registered takes it. Every instance sees
 * the same answer for the same event whatever order the browser calls them in,
 * because the election is computed once and cached on the event itself.
 */
const clients = new Set<DropClient>();

/**
 * The election, cached per `DragEvent`.
 *
 * N instances each ask, so the boxes would otherwise be measured N² times per
 * drop — 16 `getBoundingClientRect()` calls in a four-tile workspace, which is
 * affordable but pointless. The stronger reason is determinism: one answer per
 * gesture means no instance can disagree with another because a layout changed
 * between two listener invocations on the same event.
 */
const elections = new WeakMap<Event, DropClient | null>();

/** Closed on all four sides, matching `dnd/tiles.ts`'s own `contains`. Two hit
 *  tests answering the same question at the same pixel should answer it the
 *  same way; a point on a seam is inside both tiles and the election's
 *  registration order decides. */
function inBox(box: TileBox, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Which install owns a drop at this point, or null when the page has no tiles
 * and the old `active` gate is still the whole rule.
 *
 * `undefined` is never returned: the two answers are "no tiles anywhere, carry
 * on as before" (null) and "the tiles elected someone" (a client). A workspace
 * where the point misses every tile — the gap beside a divider, the sidebar —
 * falls back to the FOCUSED tile, which is where the drop went before this
 * existed. Losing the file because the pointer was three pixels off a boundary
 * would be a worse bug than the one being fixed.
 *
 * A zero-area box is not a tile. A `display: none` slot measures 0x0 in every
 * browser, so without this every hidden kept session would claim the point
 * (0, 0) and a drop in the top-left corner would go to whichever was mounted
 * first.
 */
function electDropClient(event: DragEvent): DropClient | null {
  const cached = elections.get(event);
  if (cached !== undefined) return cached; // a stored `null` is an answer too
  let winner: DropClient | null = null;
  let focused: DropClient | null = null;
  let tiled = false;
  for (const client of clients) {
    const box = client.box();
    if (!box || box.right <= box.left || box.bottom <= box.top) continue;
    tiled = true;
    if (winner === null && inBox(box, event.clientX, event.clientY)) winner = client;
    if (focused === null && client.focused()) focused = client;
  }
  const elected = tiled ? (winner ?? focused) : null;
  elections.set(event, elected);
  return elected;
}

export function installImageClipboard(deps: ImageClipboardDeps): ImageClipboard {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const upload = deps.upload ?? uploadBlob;
  const toast = deps.toast ?? showToast;
  const dismiss = deps.dismiss ?? ((id: number) => toasts.dismiss(id));

  const [dropActive, setDropActive] = createSignal(false);

  /** FALSE for every mounted session but the one on screen — see `active`.
   *  Checked before anything else either intake does, INCLUDING preventDefault:
   *  a hidden session's listener that bailed later would still have consumed
   *  the gesture, leaving the visible session (or the composer) a dead event. */
  const onScreen = (): boolean => deps.active?.() !== false;

  /** This install's entry in the drop election. Its OBJECT IDENTITY is the
   *  whole of what a winner is compared by, so it is minted once here and
   *  never rebuilt — a fresh object per drop would never equal the elected
   *  one and every drop would be declined by everybody. */
  const self: DropClient = {
    box: () => deps.tileBox?.() ?? null,
    focused: onScreen,
  };

  /** TRUE when this client only watches — both intakes stop here and say so,
   *  rather than uploading into a session nothing can be typed into. */
  const refused = (): boolean => {
    if (deps.enabled && !deps.enabled()) {
      toast("Watching this session — nothing is typed into it", "info", 4000);
      return true;
    }
    return false;
  };

  // ---- one PASTED image → its path typed into the pty ----------------------
  // Paste-only: the drop path is uploadDropped, which handles many files of any
  // type. A `filename` parameter here once made this look shared, and its
  // telemetry branched on it — but no caller ever passed one, so the
  // "image.dropped" arm was unreachable and every drop went unrecorded.
  async function uploadImageToPty(blob: Blob): Promise<void> {
    if (refused()) return;
    track("image.pasted", { "tl.count": blob.size });
    const loading = toast("Uploading image…", "loading");
    try {
      const { path } = await upload(blob, {
        session: deps.session(),
        field: "image",
      });
      dismiss(loading);
      deps.sendToPty(ptyPathBytes([path]));
      toast("Pasted: " + path, "success", 4000);
    } catch (err) {
      dismiss(loading);
      toast("Upload failed: " + errText(err), "error", 5000);
    }
  }

  // ---- paste: image items are OURS; text/other passes through -------------
  //
  // This listener owns the image paste in BOTH modes and routes on the mode,
  // rather than declining in text mode and hoping something downstream catches
  // it. Declining was the first attempt and it left a hole: the listener is on
  // the DOCUMENT, so it sees a paste wherever focus is, while the composer's own
  // handler only fires when the textarea has focus — a paste anywhere else in the
  // text view then reached nothing at all. One owner, one decision.
  //
  // Text/other is still passed through untouched, so pasting text into the
  // composer, the path box or any other field behaves natively.
  const onPaste = (e: ClipboardEvent): void => {
    if (!onScreen()) return; // another mounted session's listener; not ours
    const blob = firstImageBlob(e.clipboardData?.items);
    if (!blob) return; // text/other: let the focused field / browser handle it
    e.preventDefault();
    e.stopPropagation();
    const toComposer = deps.onComposerFiles;
    if (deps.composerOwns?.() && toComposer) {
      void toComposer([blob]);
      return;
    }
    void uploadImageToPty(blob);
  };

  // ---- drop: many files, images to the gallery, rest to /tmp --------------
  async function uploadDropped(files: File[], via: "drop" | "picker" = "drop"): Promise<void> {
    if (refused()) return;
    // Up front, and counting the files the GESTURE carried rather than the ones
    // that uploaded: the event records the gesture (ADR-0006 attributes
    // paste/drop to both lobbies), so a failing intake must not erase it from
    // the stream. Same shape the vanilla page emits. `via` keeps a file picked
    // through the Upload button out of the drop counts — same intake, different
    // gesture.
    track(via === "picker" ? "image.uploaded" : "image.dropped", {
      "tl.count": files.length,
    });
    const loading = toast(
      `Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`,
      "loading",
    );
    const paths: string[] = [];
    for (const f of files) {
      try {
        const { path } = await upload(f, {
          session: deps.session(),
          field: uploadField(f.type),
          filename: f.name,
        });
        paths.push(path);
      } catch (err) {
        toast(`Upload failed (${f.name}): ${errText(err)}`, "error", 5000);
      }
    }
    dismiss(loading);
    if (paths.length) {
      // Stored names are sanitized (no spaces/shell specials), so paths are
      // safe to insert verbatim, space-separated — same as the vanilla flow.
      deps.sendToPty(ptyPathBytes(paths));
      toast(`Added ${paths.length} path${paths.length > 1 ? "s" : ""}`, "success", 4000);
    }
  }

  // dragDepth counts nested dragenter/dragleave so the overlay only drops when
  // the cursor truly leaves the window (children fire leave on every crossing).
  let dragDepth = 0;
  /**
   * A session or a project being dragged across the sidebar is not a file drop,
   * and this handler must not touch it.
   *
   * These listeners are on the WINDOW, so they see every drag on the page and
   * run last. Claiming one costs the lobby its own: `dropEffect = "copy"`
   * against a card's `effectAllowed = "move"` resolves to no operation at all,
   * so Chrome refuses the drop and fires `dragleave` + `dragend` instead — the
   * drop line painted and nothing landed, measured 2026-09-06 in a real
   * browser. It started reaching the lobby's drags when the terminal stopped
   * being an iframe on 2026-09-05 and these listeners moved onto the top
   * window with it.
   */
  const ours = (): boolean => lobbyDragActive();
  const onDragEnter = (e: DragEvent): void => {
    if (ours()) return;
    e.preventDefault();
    if (!dragHasFiles(e.dataTransfer)) return;
    dragDepth++;
    setDropActive(true);
  };
  const onDragOver = (e: DragEvent): void => {
    if (ours()) return;
    // UNCONDITIONAL preventDefault — without it the browser falls back to
    // "open the dropped file" (a new tab). The overlay/upload are gated on
    // files, the preventDefault never is.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (): void => {
    if (dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropActive(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (ours()) return;
    // preventDefault stays UNCONDITIONAL (see onDragOver): without it the browser
    // opens the dropped file in a new tab, which is wrong in either view.
    e.preventDefault();
    dragDepth = 0;
    setDropActive(false);
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (!files.length) return;
    // Same duplication as the paste path, one gesture later: every mounted
    // session's listener sees this drop. Gated AFTER the preventDefault above,
    // which is a safety behaviour and costs nothing when several instances do
    // it, and before the upload, which is the part that must happen once.
    //
    // WHICH ONE takes it is the difference between a drop and a paste. A paste
    // has no coordinates, so it goes to the session the keystrokes are going to
    // (`onScreen`, which since 2026-09-12 means the focused TILE). A drop has a
    // point, and the tile under that point is what a person aiming at it meant
    // — see `tileBox`, which carries the measured four-tile case. With no tiles
    // on the page the election declines and this is the line it always was.
    const elected = electDropClient(e);
    if (elected === null) {
      if (!onScreen()) return;
    } else if (elected !== self) {
      return; // the pointer is over another tile; that install has it
    } else if (!onScreen()) {
      // Ours, and we are not the focused tile. Focus moves first so the
      // `window.__tlSendToTerminal` handle this install's `sendToPty` resolves
      // is re-bound to it before the upload finishes and the path is typed.
      deps.focusTile?.();
    }
    // Text view: hand the files to the composer instead of typing paths at the
    // pty. The overlay still raised, because a drop target is the right
    // affordance either way — only the destination differs.
    const toComposer = deps.onComposerFiles;
    if (deps.composerOwns?.() && toComposer) {
      void toComposer(files);
      return;
    }
    void uploadDropped(files);
  };

  clients.add(self);
  doc.addEventListener("paste", onPaste, true);
  win.addEventListener("dragenter", onDragEnter);
  win.addEventListener("dragover", onDragOver);
  win.addEventListener("dragleave", onDragLeave);
  win.addEventListener("drop", onDrop);

  return {
    dropActive,
    uploadFiles: uploadDropped,
    dispose(): void {
      // Out of the election in the same breath as the listeners. An install
      // that kept its entry would keep reporting a box for a slot that has
      // gone, and a drop over where it used to be would elect a winner whose
      // listener is no longer there to take it — the file silently lost.
      clients.delete(self);
      doc.removeEventListener("paste", onPaste, true);
      win.removeEventListener("dragenter", onDragEnter);
      win.removeEventListener("dragover", onDragOver);
      win.removeEventListener("dragleave", onDragLeave);
      win.removeEventListener("drop", onDrop);
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
