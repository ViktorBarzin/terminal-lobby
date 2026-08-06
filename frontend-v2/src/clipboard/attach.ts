import { createSignal, type Accessor } from "solid-js";
import { firstImageBlob } from "./paste";
import { dragHasFiles } from "./drop";
import { uploadBlob, uploadField } from "./upload";
import { showToast, toasts, type ToastKind } from "../store/toast";
import { track } from "../telemetry/track";

/**
 * The DOM glue for the paste path + drop-target (feature-inventory Cat.4 "Paste
 * path", Cat.1 "Drop-target overlay", Cat.8 "Drag-and-drop file upload").
 * Ported from the vanilla frontend/index.html handlers, adapted for the SPA:
 * the terminal is a cross-document iframe, so an uploaded image's path is sent
 * DOWN to the pty over the tl-input bridge (`sendToPty`, wired to
 * window.__tlSendToTerminal by the mounted TerminalView) instead of a local
 * xterm sendInput.
 *
 * Scoped to a mounted SessionView (a session is attached, so there is a pty to
 * send to). Pastes/drops that land INSIDE the terminal iframe are handled by
 * the ttyd page's own listeners (a separate document); this covers the SPA
 * chrome (text mode, gallery, composer).
 */
export interface ImageClipboardDeps {
  /** the attached session name (the upload's per-session store bucket). */
  session: () => string;
  /** send text (an uploaded path) to the pty; true if a frame received it. */
  sendToPty: (text: string) => boolean;
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

export function installImageClipboard(
  deps: ImageClipboardDeps,
): ImageClipboard {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const upload = deps.upload ?? uploadBlob;
  const toast = deps.toast ?? showToast;
  const dismiss = deps.dismiss ?? ((id: number) => toasts.dismiss(id));

  const [dropActive, setDropActive] = createSignal(false);

  // ---- one uploaded image → its path typed into the pty -------------------
  async function uploadImageToPty(blob: Blob, filename?: string): Promise<void> {
    track(filename ? "image.dropped" : "image.pasted", { "tl.count": blob.size });
    const loading = toast("Uploading image…", "loading");
    try {
      const path = await upload(blob, {
        session: deps.session(),
        field: "image",
        ...(filename ? { filename } : {}),
      });
      dismiss(loading);
      deps.sendToPty(ptyPathBytes([path]));
      toast("Pasted: " + path, "success", 4000);
    } catch (err) {
      dismiss(loading);
      toast("Upload failed: " + errText(err), "error", 5000);
    }
  }

  // ---- paste: image items upload; text/other passes through ---------------
  const onPaste = (e: ClipboardEvent): void => {
    const blob = firstImageBlob(e.clipboardData?.items);
    if (!blob) return; // text/other: let the focused field / browser handle it
    e.preventDefault();
    e.stopPropagation();
    void uploadImageToPty(blob);
  };

  // ---- drop: many files, images to the gallery, rest to /tmp --------------
  async function uploadDropped(files: File[]): Promise<void> {
    const loading = toast(
      `Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`,
      "loading",
    );
    const paths: string[] = [];
    for (const f of files) {
      try {
        const path = await upload(f, {
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
      toast(
        `Added ${paths.length} path${paths.length > 1 ? "s" : ""}`,
        "success",
        4000,
      );
    }
  }

  // dragDepth counts nested dragenter/dragleave so the overlay only drops when
  // the cursor truly leaves the window (children fire leave on every crossing).
  let dragDepth = 0;
  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault();
    if (!dragHasFiles(e.dataTransfer)) return;
    dragDepth++;
    setDropActive(true);
  };
  const onDragOver = (e: DragEvent): void => {
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
    e.preventDefault(); // UNCONDITIONAL (see onDragOver)
    dragDepth = 0;
    setDropActive(false);
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (files.length) void uploadDropped(files);
  };

  doc.addEventListener("paste", onPaste, true);
  win.addEventListener("dragenter", onDragEnter);
  win.addEventListener("dragover", onDragOver);
  win.addEventListener("dragleave", onDragLeave);
  win.addEventListener("drop", onDrop);

  return {
    dropActive,
    dispose(): void {
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
