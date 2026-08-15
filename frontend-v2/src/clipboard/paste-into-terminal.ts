import { showToast } from "../store/toast";
import { track } from "../telemetry/track";

/**
 * Paste-into-terminal, read in the LOBBY document.
 *
 * The terminal page owns a perfectly good paste routine, and for a standalone
 * /term.html tab it is still the right one. It cannot serve the FRAMED case:
 * the async clipboard is gated on `document.hasFocus()`, and clicking a control
 * in the lobby focuses the LOBBY, so a read performed inside the frame throws
 *
 *   NotAllowedError: Document is not focused.
 *
 * Chrome only shows its clipboard prompt for a focused document, so the user
 * was told access was denied for a permission they had never been asked for.
 * Measured with clipboard-read already granted: the lobby reads fine
 * (hasFocus true), the frame throws (hasFocus false) even though transient
 * activation does reach it.
 *
 * So the lobby reads, and only the RESULT crosses the frame boundary:
 *  - text goes down as `tl-paste`, which the terminal page hands to
 *    `term.paste()` — bracketed paste plus \r\n normalization, so a multiline
 *    paste cannot execute line-by-line in a shell the way raw input would;
 *  - an image goes to the same upload intake the drop and picker paths use, so
 *    it lands in the session store and its path is typed at the prompt.
 */

export interface PasteIntoTerminalDeps {
  /** the clipboard to read (defaults to navigator.clipboard). */
  clipboard?: Clipboard;
  /** hand text to the terminal page's term.paste() over the tl-paste bridge. */
  sendPasteText: (text: string) => boolean;
  /** the shared upload intake, for an image sitting on the clipboard. */
  uploadFiles: (files: File[], via?: "drop" | "picker") => Promise<void>;
  /** surface a failure (defaults to the app toast stack). */
  toast?: (message: string, kind: "error" | "info" | "success") => void;
}

/**
 * A blob's text. `Blob.text()` is missing in older Safari and in jsdom, and a
 * TypeError there would surface to the user as "couldn't read the clipboard" —
 * so fall back to FileReader, which every one of them has.
 */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(fr.error ?? new Error("could not read the clipboard blob"));
    fr.readAsText(blob);
  });
}

/** The message shown when the read itself failed. */
function readFailure(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  // "Document is not focused" is worth naming: it is not a decision the user
  // made, and calling it denied access sends them looking for a permission
  // prompt that was never shown.
  if (e?.name === "NotAllowedError" && /not focused/i.test(e.message ?? "")) {
    return "Couldn't read the clipboard — the page lost focus. Click the terminal and try again.";
  }
  if (e?.name === "NotAllowedError") {
    return "Clipboard access was blocked by the browser. Use ⌘/Ctrl-V in the terminal instead.";
  }
  return "Couldn't read the clipboard: " + (e?.message || String(err));
}

export async function pasteIntoTerminal(
  deps: PasteIntoTerminalDeps,
): Promise<void> {
  const toast = deps.toast ?? showToast;
  const clip =
    deps.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

  if (!clip) {
    toast(
      "This browser gives the page no clipboard access. Use ⌘/Ctrl-V in the terminal.",
      "error",
    );
    return;
  }

  try {
    // read() is the image-aware path; readText() is the fallback for browsers
    // that expose only it.
    if (typeof clip.read === "function") {
      const items = await clip.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          const file = new File([blob], `pasted.${ext}`, { type: imageType });
          track("terminal.pasted", { "tl.kind": "image" });
          await deps.uploadFiles([file], "picker");
          return;
        }
        if (item.types.includes("text/plain")) {
          const text = await blobText(await item.getType("text/plain"));
          if (text) {
            track("terminal.pasted", { "tl.kind": "text" });
            deps.sendPasteText(text);
          }
          return;
        }
      }
      return; // an item of neither kind: nothing to paste, and nothing broke
    }

    const text = await clip.readText();
    if (text) {
      track("terminal.pasted", { "tl.kind": "text" });
      deps.sendPasteText(text);
    }
  } catch (err) {
    toast(readFailure(err), "error");
  }
}
