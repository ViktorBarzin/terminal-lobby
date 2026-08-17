import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { uploadField, type UploadOptions, type UploadResult } from "../src/clipboard/upload";
import { dragHasFiles } from "../src/clipboard/drop";
import { installImageClipboard } from "../src/clipboard/attach";

/** Every `track()` the clipboard subsystem emits, in order (ADR-0006). */
const tracked: { name: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("../src/telemetry/track", () => ({
  track: (name: string, attrs?: Record<string, unknown>) => void tracked.push({ name, attrs }),
}));
const transferEvents = (): { name: string; attrs?: Record<string, unknown> }[] =>
  tracked.filter((e) => e.name.startsWith("image."));

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
      upload: async (_blob: Blob, opts: UploadOptions) => ({
        path: `${STORE}/${opts.filename ?? "dropped"}`,
        stored: true,
      }),
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

/**
 * A drop must be tellable from a paste in the event stream — docs/adr/
 * 0006-usage-telemetry.md:108 attributes "paste/drop" to BOTH lobbies, and the
 * same table's server-side carve-out ("kills, renames, moves, shares, saves and
 * uploads are emitted server-side only") does not cover drop. The vanilla page
 * emits `image.dropped` with the FILE COUNT (frontend/index.html:13563); v2
 * emitted nothing, because the only `track()` in the subsystem sat in the paste
 * path behind a `filename` argument no call site ever passed.
 *
 * Count semantics follow vanilla: the number of files the user dropped, not the
 * number that uploaded successfully — the event records the gesture, so it is
 * emitted up front and a failing upload cannot erase the drop from the stream.
 */
describe("installImageClipboard — a drop is distinguishable from a paste", () => {
  const STORE = "/var/lib/clipboard-store/wizard/qa-sess";
  const file = (name: string, type: string): File =>
    new File([new Uint8Array([1])], name, { type });

  const dropEvent = (files: File[]): Event => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { files } });
    return e;
  };
  const pasteEvent = (f: File): Event => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ type: f.type, getAsFile: () => f }] },
    });
    return e;
  };

  // Torn down in afterEach, not by the test body: a listener that outlives a
  // FAILING test would double every event in the next one and turn one red
  // into a cascade.
  const installed: (() => void)[] = [];
  const setup = (
    upload?: (blob: Blob, opts: UploadOptions) => Promise<UploadResult>,
  ): { sent: string[] } => {
    const sent: string[] = [];
    const clip = installImageClipboard({
      session: () => "qa-sess",
      sendToPty: (t: string) => {
        sent.push(t);
        return true;
      },
      upload:
        upload ??
        (async (_blob: Blob, opts: UploadOptions) => ({
          path: `${STORE}/${opts.filename ?? "pasted.png"}`,
          stored: true,
        })),
      toast: () => 0,
      dismiss: () => {},
    });
    installed.push(clip.dispose);
    return { sent };
  };

  beforeEach(() => {
    tracked.length = 0;
  });
  afterEach(() => {
    installed.splice(0).forEach((d) => d());
  });

  it("emits exactly one image.dropped carrying the file count — never image.pasted", async () => {
    const { sent } = setup();
    window.dispatchEvent(
      dropEvent([
        file("a.png", "image/png"),
        file("b.png", "image/png"),
        file("notes.txt", "text/plain"),
      ]),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(transferEvents()).toEqual([
      { name: "image.dropped", attrs: { "tl.count": 3 } },
    ]);
  });

  it("emits one image.dropped per drop gesture, not one per file", async () => {
    const { sent } = setup();
    window.dispatchEvent(dropEvent([file("a.png", "image/png")]));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    window.dispatchEvent(dropEvent([file("b.png", "image/png")]));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(transferEvents()).toEqual([
      { name: "image.dropped", attrs: { "tl.count": 1 } },
      { name: "image.dropped", attrs: { "tl.count": 1 } },
    ]);
  });

  it("records the drop even when every upload fails", async () => {
    setup(async () => {
      throw new Error("intake down");
    });
    window.dispatchEvent(dropEvent([file("a.png", "image/png")]));
    await vi.waitFor(() =>
      expect(transferEvents()).toEqual([
        { name: "image.dropped", attrs: { "tl.count": 1 } },
      ]),
    );
  });

  it("an empty drop (a dragged element, no files) emits nothing", () => {
    setup();
    window.dispatchEvent(dropEvent([]));
    expect(transferEvents()).toEqual([]);
  });

  it("a paste still emits exactly one image.pasted — never image.dropped", async () => {
    const { sent } = setup();
    document.dispatchEvent(pasteEvent(file("shot.png", "image/png")));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(transferEvents()).toHaveLength(1);
    expect(transferEvents()[0]!.name).toBe("image.pasted");
  });
});
