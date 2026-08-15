import { describe, it, expect } from "vitest";
import { pasteIntoTerminal } from "../src/clipboard/paste-into-terminal";

/**
 * Paste-into-terminal.
 *
 * The read MUST happen in the lobby document. It used to be forwarded into the
 * terminal iframe and read there, which fails in every browser that gates the
 * async clipboard on document focus: clicking a button in the lobby focuses the
 * LOBBY, so the frame's read threw
 *   NotAllowedError: Document is not focused.
 * and — because Chrome only prompts when the document is focused — the user was
 * told access was denied for a permission they were never asked for. Measured:
 * parent hasFocus=true and reads fine; frame hasFocus=false and throws, with
 * clipboard-read already granted.
 */

const textItem = (text: string) => ({
  types: ["text/plain"],
  getType: async () => new Blob([text], { type: "text/plain" }),
});
const imageItem = () => ({
  types: ["image/png"],
  getType: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});

function deps(over: Partial<Parameters<typeof pasteIntoTerminal>[0]> = {}) {
  const sent: string[] = [];
  const uploaded: File[][] = [];
  const toasts: { msg: string; kind: string }[] = [];
  return {
    sent,
    uploaded,
    toasts,
    d: {
      clipboard: { read: async () => [textItem("hello")] } as unknown as Clipboard,
      sendPasteText: (t: string) => {
        sent.push(t);
        return true;
      },
      uploadFiles: async (files: File[]) => void uploaded.push(files),
      toast: (msg: string, kind: string) => void toasts.push({ msg, kind }),
      ...over,
    },
  };
}

describe("pasteIntoTerminal — the read happens where the focus is", () => {
  it("sends clipboard text down as a PASTE, not as raw keystrokes", async () => {
    // term.paste() brackets the paste and normalizes \r\n; raw input would let
    // a multiline paste execute line-by-line in a shell.
    const { sent, d } = deps();
    await pasteIntoTerminal(d);
    expect(sent).toEqual(["hello"]);
  });

  it("routes an image on the clipboard through the upload intake instead", async () => {
    const { sent, uploaded, d } = deps({
      clipboard: { read: async () => [imageItem()] } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(uploaded.length).toBe(1);
    expect(uploaded[0]![0]!.type).toBe("image/png");
    expect(sent).toEqual([]);
  });

  it("falls back to readText() where clipboard.read() is unavailable", async () => {
    const { sent, d } = deps({
      clipboard: { readText: async () => "plain" } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(sent).toEqual(["plain"]);
  });

  it("reports the real reason a read failed, rather than a blanket denial", async () => {
    const err = new DOMException("Document is not focused.", "NotAllowedError");
    const { toasts, d } = deps({
      clipboard: {
        read: async () => {
          throw err;
        },
      } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(toasts.length).toBe(1);
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.msg).toMatch(/clipboard/i);
  });

  it("says so plainly when the browser exposes no clipboard at all", async () => {
    const { toasts, sent, d } = deps({ clipboard: undefined });
    await pasteIntoTerminal(d);
    expect(sent).toEqual([]);
    expect(toasts[0]?.kind).toBe("error");
  });

  it("does not paste an empty clipboard", async () => {
    const { sent, d } = deps({
      clipboard: { read: async () => [textItem("")] } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(sent).toEqual([]);
  });
});
