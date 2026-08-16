import { showToast } from "../store/toast";
import { track } from "../telemetry/track";
import { isCoarsePointer } from "../mobile/pointer";

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
  /** TRUE on a touch device, where the advice to give differs. */
  coarsePointer?: boolean;
  /** usage events (defaults to the app tracker); injectable for tests. */
  track?: (name: string, attrs?: Record<string, unknown>) => void;
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

/**
 * The message shown when the read itself failed.
 *
 * The advice has to match the device. There is a second way into the terminal
 * that needs no permission at all: a NATIVE paste inside the frame fires a
 * `paste` event that term.html already handles. On a desktop that is ⌘/Ctrl-V;
 * on a phone it is a long-press on the terminal and the system Paste item.
 * Naming a keyboard chord to someone holding a phone is a dead end.
 */
function readFailure(err: unknown, coarse: boolean): string {
  const e = err as { name?: string; message?: string } | null;
  const nativePaste = coarse
    ? "Long-press the terminal and choose Paste."
    : "Use ⌘/Ctrl-V in the terminal instead.";
  // "Document is not focused" is worth naming: it is not a decision the user
  // made, and calling it denied access sends them looking for a permission
  // prompt that was never shown.
  if (e?.name === "NotAllowedError" && /not focused/i.test(e.message ?? "")) {
    return coarse
      ? "Couldn't read the clipboard — the page lost focus. Tap the terminal and try again."
      : "Couldn't read the clipboard — the page lost focus. Click the terminal and try again.";
  }
  if (e?.name === "NotAllowedError") {
    return "Clipboard access was blocked by the browser. " + nativePaste;
  }
  return "Couldn't read the clipboard: " + (e?.message || String(err));
}

export async function pasteIntoTerminal(
  deps: PasteIntoTerminalDeps,
): Promise<void> {
  const toast = deps.toast ?? showToast;
  const emit = deps.track ?? track;
  const coarse = deps.coarsePointer ?? isCoarsePointer();
  const clip =
    deps.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

  if (!clip) {
    emit("terminal.paste_failed", { "tl.api": "none", "tl.error": "unavailable" });
    toast(
      coarse
        ? "This browser gives the page no clipboard access. Long-press the terminal and choose Paste."
        : "This browser gives the page no clipboard access. Use ⌘/Ctrl-V in the terminal.",
      "error",
    );
    return;
  }

  /** Deliver whatever the read produced. Shared by both read paths. */
  const deliverText = (text: string): void => {
    if (!text) return;
    emit("terminal.pasted", { "tl.kind": "text" });
    deps.sendPasteText(text);
  };

  // The image-aware path first: it is the only one that can carry a screenshot.
  if (typeof clip.read === "function") {
    try {
      const items = await clip.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          const file = new File([blob], `pasted.${ext}`, { type: imageType });
          emit("terminal.pasted", { "tl.kind": "image" });
          await deps.uploadFiles([file], "picker");
          return;
        }
        if (item.types.includes("text/plain")) {
          deliverText(await blobText(await item.getType("text/plain")));
          return;
        }
      }
      return; // an item of neither kind: nothing to paste, and nothing broke
    } catch (err) {
      // NOT the end of the road. read() and readText() are separately gated —
      // Safari's ClipboardItem read() is the shakier of the two — so a refusal
      // here is no reason to lose a plain-text paste. Falls through.
      if (typeof clip.readText !== "function") {
        fail(err, "read");
        return;
      }
    }
  }

  try {
    deliverText(await clip.readText());
  } catch (err) {
    fail(err, "readText");
  }

  /**
   * One report per attempt, to the user and to telemetry.
   *
   * The telemetry half exists because this failure is a property of the USER's
   * browser: it does not reproduce in the headless Chromium the QA rig drives
   * (measured — the same paste succeeds there), so without a recorded error the
   * next round of diagnosis starts from a description again. Only the error's
   * NAME and which call was refused are recorded — never the message, which can
   * quote clipboard content, and never the content itself.
   */
  function fail(err: unknown, api: "read" | "readText"): void {
    const e = err as { name?: string } | null;
    emit("terminal.paste_failed", {
      "tl.api": api,
      "tl.error": e?.name || "Error",
      "tl.focused": typeof document !== "undefined" ? document.hasFocus() : false,
      "tl.coarse": coarse,
    });
    toast(readFailure(err, coarse), "error");
  }
}
