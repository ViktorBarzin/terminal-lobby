import { describe, it, expect } from "vitest";
import { firstImageBlob, type PasteItemLike } from "../src/clipboard/paste";

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
