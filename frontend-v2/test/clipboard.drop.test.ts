import { describe, it, expect } from "vitest";
import { uploadField } from "../src/clipboard/upload";
import { dragHasFiles } from "../src/clipboard/drop";

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
