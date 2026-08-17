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

describe("pasteIntoTerminal — when the browser refuses read()", () => {
  const denied = (msg = "Read permission denied") => {
    const e = new Error(msg);
    e.name = "NotAllowedError";
    return e;
  };

  it("retries with readText() rather than giving up", async () => {
    // Safari's ClipboardItem read() and readText() are separately gated, and
    // read() is the shakier of the two. Refusing the image-aware call is not a
    // reason to lose a plain-text paste.
    let readCalls = 0;
    const { sent, toasts, d } = deps({
      clipboard: {
        read: async () => {
          readCalls++;
          throw denied();
        },
        readText: async () => "rescued",
      } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(readCalls).toBe(1);
    expect(sent).toEqual(["rescued"]);
    expect(toasts).toEqual([]); // it worked; there is nothing to report
  });

  it("reports only once when BOTH calls are refused", async () => {
    const { sent, toasts, d } = deps({
      clipboard: {
        read: async () => {
          throw denied();
        },
        readText: async () => {
          throw denied();
        },
      } as unknown as Clipboard,
    });
    await pasteIntoTerminal(d);
    expect(sent).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("error");
  });

  it("tells a touch user the gesture that actually works on their device", async () => {
    // The async clipboard is not the only way in: a native long-press paste
    // inside the terminal fires a paste event in the frame, which term.html
    // already handles, and needs no permission at all. Naming a keyboard chord
    // to someone holding a phone is a dead end.
    const { toasts, d } = deps({
      clipboard: {
        read: async () => {
          throw denied();
        },
        readText: async () => {
          throw denied();
        },
      } as unknown as Clipboard,
      coarsePointer: true,
    });
    await pasteIntoTerminal(d);
    expect(toasts[0]!.msg).toMatch(/long-press/i);
    expect(toasts[0]!.msg).not.toMatch(/Ctrl-V/);
  });

  it("still names the keyboard chord on a desktop", async () => {
    const { toasts, d } = deps({
      clipboard: {
        read: async () => {
          throw denied();
        },
        readText: async () => {
          throw denied();
        },
      } as unknown as Clipboard,
      coarsePointer: false,
    });
    await pasteIntoTerminal(d);
    expect(toasts[0]!.msg).toMatch(/Ctrl-V/);
  });

  it("records the refusal so a device that cannot be reproduced still reports", async () => {
    // The failure only appears on the user's own browser; without this the
    // next round of diagnosis starts from a description again.
    const events: { name: string; attrs?: Record<string, unknown> }[] = [];
    const { d } = deps({
      clipboard: {
        read: async () => {
          throw denied("Read permission denied");
        },
        readText: async () => {
          throw denied("Read permission denied");
        },
      } as unknown as Clipboard,
      track: (name: string, attrs?: Record<string, unknown>) =>
        void events.push({ name, attrs }),
    });
    await pasteIntoTerminal(d);
    const failed = events.find((e) => e.name === "terminal.paste_failed");
    expect(failed, "a terminal.paste_failed event").toBeTruthy();
    expect(failed!.attrs!["tl.error"]).toBe("NotAllowedError");
    // WHICH call was refused is the whole question on Safari.
    expect(failed!.attrs!["tl.api"]).toBe("readText");
  });

  it("carries no clipboard CONTENT into telemetry", async () => {
    const events: { name: string; attrs?: Record<string, unknown> }[] = [];
    const { d } = deps({
      clipboard: {
        read: async () => {
          throw denied("secret-token-abc123 could not be read");
        },
        readText: async () => {
          throw denied("secret-token-abc123 could not be read");
        },
      } as unknown as Clipboard,
      track: (name: string, attrs?: Record<string, unknown>) =>
        void events.push({ name, attrs }),
    });
    await pasteIntoTerminal(d);
    const failed = events.find((e) => e.name === "terminal.paste_failed")!;
    expect(JSON.stringify(failed.attrs)).not.toContain("secret-token");
  });
});

// --- the refusal names the surface you are looking at ----------------------
// In the text view the terminal is off screen, so "long-press the terminal"
// sends someone to a pane they cannot see.
describe("surface-aware advice", () => {
  const refusing = (): Clipboard =>
    ({
      read: async () => {
        throw Object.assign(new Error("Read permission denied."), {
          name: "NotAllowedError",
        });
      },
      readText: async () => {
        throw Object.assign(new Error("Read permission denied."), {
          name: "NotAllowedError",
        });
      },
    }) as unknown as Clipboard;

  const run = async (surface: "terminal" | "composer", coarse: boolean) => {
    const said: string[] = [];
    await pasteIntoTerminal({
      clipboard: refusing(),
      sendPasteText: () => true,
      uploadFiles: async () => {},
      toast: (m) => said.push(m),
      coarsePointer: coarse,
      surface,
      track: () => {},
    });
    return said.join(" ");
  };

  it("names the message box in the composer, on a phone", async () => {
    const said = await run("composer", true);
    expect(said).toContain("the message box");
    expect(said).not.toContain("terminal");
  });

  it("names the message box in the composer, on a desktop", async () => {
    const said = await run("composer", false);
    expect(said).toContain("the message box");
    expect(said).not.toContain("terminal");
  });

  it("still names the terminal when that is where the paste is going", async () => {
    expect(await run("terminal", true)).toContain("terminal");
    expect(await run("terminal", false)).toContain("terminal");
  });

  it("defaults to the terminal when no surface is given", async () => {
    const said: string[] = [];
    await pasteIntoTerminal({
      clipboard: refusing(),
      sendPasteText: () => true,
      uploadFiles: async () => {},
      toast: (m) => said.push(m),
      coarsePointer: false,
      track: () => {},
    });
    expect(said.join(" ")).toContain("terminal");
  });
});
