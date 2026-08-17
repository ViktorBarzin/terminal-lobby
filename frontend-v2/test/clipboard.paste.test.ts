import { describe, it, expect, vi } from "vitest";
import { firstImageBlob, type PasteItemLike } from "../src/clipboard/paste";
import { installImageClipboard } from "../src/clipboard/attach";
import type { UploadOptions } from "../src/clipboard/upload";

const item = (type: string, file: File | null): PasteItemLike => ({
  type,
  getAsFile: () => file,
});
const fakeImage = (type: string): File =>
  new File([new Uint8Array([1, 2, 3])], "x", { type });

describe("firstImageBlob — paste image-vs-text discrimination", () => {
  it("returns the image blob when an image item is present (intercept)", () => {
    const png = fakeImage("image/png");
    const items = [item("text/plain", null), item("image/png", png)];
    expect(firstImageBlob(items)).toBe(png);
  });

  it("returns null for a text-only paste (passes through to the field)", () => {
    const items = [item("text/plain", null), item("text/html", null)];
    expect(firstImageBlob(items)).toBeNull();
  });

  it("returns null when there are no items at all", () => {
    expect(firstImageBlob(null)).toBeNull();
    expect(firstImageBlob(undefined)).toBeNull();
    expect(firstImageBlob([])).toBeNull();
  });

  it("skips an image item whose getAsFile() yields null", () => {
    const jpg = fakeImage("image/jpeg");
    const items = [item("image/png", null), item("image/jpeg", jpg)];
    expect(firstImageBlob(items)).toBe(jpg);
  });

  it("returns the FIRST usable image among several", () => {
    const a = fakeImage("image/png");
    const b = fakeImage("image/gif");
    expect(firstImageBlob([item("image/png", a), item("image/gif", b)])).toBe(a);
  });

  it("does not treat an 'imagexyz' pseudo-type as an image (needs image/ prefix)", () => {
    expect(firstImageBlob([item("imagexyz", fakeImage("imagexyz"))])).toBeNull();
  });
});

/**
 * The uploaded path is TYPED AT THE PTY INPUT LINE and deliberately left there —
 * that is how a user attaches an image to the prompt they are about to write
 * (frontend-v2/README.md:237-238; the drop overlay says so too). It is not
 * submitted, and nothing clears the line afterwards.
 *
 * So whatever arrives next lands on the SAME line, immediately after the path:
 * the composer's /prompt inject (session-events pastes into the live line) and
 * the mobile bracketed-paste branch both append. Without a trailing separator
 * the two fuse into one token and the user's prompt is destroyed. Measured on
 * the deployed dev tier 2026-08-06, plain zsh session qa-l5b:
 *
 *   ╰─$ /var/lib/clipboard-store/wizard/qa-l5b/pasted-…-cd9b5e25.pngecho COMPOSER-MARKER
 *   zsh: no such file or directory: …/pasted-…-cd9b5e25.pngecho
 *
 * The separator is what keeps the path attachable AND the prompt intact.
 */
describe("installImageClipboard — an uploaded path is separated from what follows", () => {
  const PNG = new File([new Uint8Array([1, 2, 3])], "shot.png", {
    type: "image/png",
  });
  const STORE = "/var/lib/clipboard-store/wizard/qa-sess";

  const pasteEvent = (file: File): Event => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ type: file.type, getAsFile: () => file }] },
    });
    return e;
  };

  /** installs the subsystem with a stub uploader; returns the pty writes. */
  const setup = (): { sent: string[]; dispose: () => void } => {
    const sent: string[] = [];
    let n = 0;
    const clip = installImageClipboard({
      session: () => "qa-sess",
      sendToPty: (t: string) => {
        sent.push(t);
        return true;
      },
      upload: async (_blob: Blob, opts: UploadOptions) =>
        `${STORE}/${opts.filename ?? `pasted-${++n}.png`}`,
      toast: () => 0,
      dismiss: () => {},
    });
    return { sent, dispose: clip.dispose };
  };

  /** what the pty input line reads after the writes, then the user's prompt. */
  const lineAfter = (sent: string[], prompt: string): string =>
    sent.join("") + prompt;

  it("emits the path with a trailing separator, not a bare path", async () => {
    const { sent, dispose } = setup();
    document.dispatchEvent(pasteEvent(PNG));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    dispose();
    expect(sent[0]).toBe(`${STORE}/pasted-1.png `);
  });

  it("leaves the next prompt as its own token on the pty line", async () => {
    const { sent, dispose } = setup();
    document.dispatchEvent(pasteEvent(PNG));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    dispose();
    const line = lineAfter(sent, "echo COMPOSER-MARKER");
    expect(line).toBe(`${STORE}/pasted-1.png echo COMPOSER-MARKER`);
    // the measured corruption: the prompt's first word fused into the path
    expect(line).not.toContain(".pngecho");
    expect(line.split(" ")).toContain("echo");
  });

  it("keeps three consecutive pastes three separate tokens", async () => {
    const { sent, dispose } = setup();
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(pasteEvent(PNG));
      await vi.waitFor(() => expect(sent).toHaveLength(i + 1));
    }
    dispose();
    expect(lineAfter(sent, "").trim().split(" ")).toEqual([
      `${STORE}/pasted-1.png`,
      `${STORE}/pasted-2.png`,
      `${STORE}/pasted-3.png`,
    ]);
  });
});

/**
 * Watching a session means nothing is typed into it, so an image paste or drop
 * must not upload either. The upload half is the reason: it files the image in
 * THAT session's gallery (someone else's, in an act-as tab) and only then types
 * the path — so a paste that is allowed to start leaves a half-done action
 * behind when the typing is discarded by a read-only tmux client.
 */
describe("installImageClipboard — refuses while the session is only watched", () => {
  const PNG = new File([new Uint8Array([1, 2, 3])], "shot.png", {
    type: "image/png",
  });

  const pasteEvent = (file: File): Event => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ type: file.type, getAsFile: () => file }] },
    });
    return e;
  };

  const setup = (enabled: () => boolean) => {
    const sent: string[] = [];
    const uploaded: string[] = [];
    const toasts: string[] = [];
    const clip = installImageClipboard({
      session: () => "qa-sess",
      enabled,
      sendToPty: (t: string) => {
        sent.push(t);
        return true;
      },
      upload: async (_blob: Blob, opts: UploadOptions) => {
        uploaded.push(opts.filename ?? "pasted.png");
        return "/store/" + (opts.filename ?? "pasted.png");
      },
      toast: (m: string) => {
        toasts.push(m);
        return 0;
      },
      dismiss: () => {},
    });
    return { sent, uploaded, toasts, clip };
  };

  it("uploads nothing and types nothing on a paste", async () => {
    const { sent, uploaded, toasts, clip } = setup(() => false);
    document.dispatchEvent(pasteEvent(PNG));
    await vi.waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    clip.dispose();
    expect(uploaded).toEqual([]);
    expect(sent).toEqual([]);
    expect(toasts.join(" ")).toMatch(/watch/i);
  });

  it("refuses the drop intake the Upload button shares", async () => {
    const { sent, uploaded, clip } = setup(() => false);
    await clip.uploadFiles([PNG], "picker");
    clip.dispose();
    expect(uploaded).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("leaves an ordinary session alone", async () => {
    const { sent, uploaded, clip } = setup(() => true);
    await clip.uploadFiles([PNG], "picker");
    clip.dispose();
    expect(uploaded).toEqual(["shot.png"]);
    expect(sent).toHaveLength(1);
  });
});
