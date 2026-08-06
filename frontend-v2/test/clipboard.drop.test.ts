import { describe, it, expect, vi } from "vitest";
import { uploadField, type UploadOptions } from "../src/clipboard/upload";
import { dragHasFiles } from "../src/clipboard/drop";
import { installImageClipboard } from "../src/clipboard/attach";

describe("uploadField — drop image-vs-file routing", () => {
  it("routes images to the gallery `image` field (per-session store)", () => {
    expect(uploadField("image/png")).toBe("image");
    expect(uploadField("image/jpeg")).toBe("image");
    expect(uploadField("image/gif")).toBe("image");
    expect(uploadField("image/webp")).toBe("image");
    expect(uploadField("image/svg+xml")).toBe("image");
  });

  it("routes everything else to the ephemeral `file` field (/tmp)", () => {
    expect(uploadField("text/plain")).toBe("file");
    expect(uploadField("application/pdf")).toBe("file");
    expect(uploadField("application/octet-stream")).toBe("file");
    expect(uploadField("video/mp4")).toBe("file");
  });

  it("treats missing / empty / pseudo-image types as `file`", () => {
    expect(uploadField(undefined)).toBe("file");
    expect(uploadField(null)).toBe("file");
    expect(uploadField("")).toBe("file");
    expect(uploadField("imagexyz")).toBe("file"); // must be the image/ prefix
  });
});

describe("dragHasFiles — file-bearing drag detection", () => {
  it("true for a DOMStringList-like whose contains('Files') is true", () => {
    const dt = {
      types: { contains: (t: string) => t === "Files" } as unknown as DOMStringList,
    };
    expect(dragHasFiles(dt)).toBe(true);
  });

  it("true for a plain-array types that includes 'Files'", () => {
    expect(dragHasFiles({ types: ["Files", "text/plain"] })).toBe(true);
  });

  it("false for a plain-array types without 'Files' (a dragged element/text)", () => {
    expect(dragHasFiles({ types: ["text/plain", "text/html"] })).toBe(false);
  });

  it("false when the dataTransfer / types is missing", () => {
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
    expect(dragHasFiles({ types: null })).toBe(false);
  });
});

/**
 * Dropped paths are typed at the pty input line and left there, exactly like a
 * paste (see clipboard.paste.test.ts for the measured corruption). The drop path
 * already space-separates paths from EACH OTHER; it must also separate the last
 * one from whatever the user sends next.
 */
describe("installImageClipboard — dropped paths are separated from what follows", () => {
  const STORE = "/var/lib/clipboard-store/wizard/qa-sess";
  const file = (name: string, type: string): File =>
    new File([new Uint8Array([1])], name, { type });

  const dropEvent = (files: File[]): Event => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { files } });
    return e;
  };

  const setup = (): { sent: string[]; dispose: () => void } => {
    const sent: string[] = [];
    const clip = installImageClipboard({
      session: () => "qa-sess",
      sendToPty: (t: string) => {
        sent.push(t);
        return true;
      },
      upload: async (_blob: Blob, opts: UploadOptions) =>
        `${STORE}/${opts.filename ?? "dropped"}`,
      toast: () => 0,
      dismiss: () => {},
    });
    return { sent, dispose: clip.dispose };
  };

  it("emits a single dropped path with a trailing separator", async () => {
    const { sent, dispose } = setup();
    window.dispatchEvent(dropEvent([file("a.png", "image/png")]));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    dispose();
    expect(sent[0]).toBe(`${STORE}/a.png `);
  });

  it("keeps several dropped paths AND the next prompt separate tokens", async () => {
    const { sent, dispose } = setup();
    window.dispatchEvent(
      dropEvent([file("a.png", "image/png"), file("notes.txt", "text/plain")]),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    dispose();
    const line = sent.join("") + "summarise these";
    expect(line).toBe(`${STORE}/a.png ${STORE}/notes.txt summarise these`);
    expect(line).not.toContain(".txtsummarise");
  });
});
