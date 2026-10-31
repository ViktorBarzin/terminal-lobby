import { describe, it, expect, vi } from "vitest";
import { copyArriving, copyNow, readClipboard } from "../src/clipboard/browser-clipboard";

/**
 * The session browser's clipboard, on the lobby's side. The text a copy
 * produces comes back from the host a round trip after the key or the tap,
 * and Safari only lets a page write the clipboard inside the gesture. So the
 * write starts in the gesture with a ClipboardItem whose blob is still on its
 * way, and falls back to writeText where that is refused or missing.
 */

/** jsdom's Blob has no text(). */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.readAsText(blob);
  });
}

class FakeItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function clip(over: Partial<Clipboard> = {}) {
  const written: string[] = [];
  const c = {
    write: vi.fn(async (items: FakeItem[]) => {
      written.push(await blobText(await items[0]!.items["text/plain"]!));
    }),
    writeText: vi.fn(async (t: string) => void written.push(t)),
    readText: vi.fn(async () => "from the clipboard"),
    ...over,
  };
  return { c: c as unknown as Clipboard, written, raw: c };
}

const Item = FakeItem as unknown as typeof ClipboardItem;

describe("copyArriving", () => {
  it("writes text that arrives after the gesture through one ClipboardItem", async () => {
    const { c, written, raw } = clip();
    let arrive!: (t: string) => void;
    const text = new Promise<string>((r) => (arrive = r));
    const done = copyArriving(text, { clipboard: c, Item });
    // The write is started before the text exists, inside the gesture.
    expect(raw.write).toHaveBeenCalledTimes(1);
    arrive("selected words");
    await expect(done).resolves.toBe("copied");
    expect(written).toEqual(["selected words"]);
    expect(raw.writeText).not.toHaveBeenCalled();
  });

  it("leaves the clipboard alone when nothing was selected", async () => {
    const { c, written } = clip({
      write: vi.fn(async (items: ClipboardItems) => {
        await (items[0] as unknown as FakeItem).items["text/plain"];
      }),
    });
    await expect(copyArriving(Promise.resolve(""), { clipboard: c, Item })).resolves.toBe("empty");
    expect(written).toEqual([]);
  });

  it("falls back to writeText when the ClipboardItem write is refused", async () => {
    const { c, written } = clip({
      write: vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      }),
    });
    await expect(copyArriving(Promise.resolve("words"), { clipboard: c, Item })).resolves.toBe(
      "copied",
    );
    expect(written).toEqual(["words"]);
  });

  it("uses writeText where there is no ClipboardItem", async () => {
    const { c, written, raw } = clip();
    await expect(
      copyArriving(Promise.resolve("words"), { clipboard: c, Item: undefined }),
    ).resolves.toBe("copied");
    expect(raw.write).not.toHaveBeenCalled();
    expect(written).toEqual(["words"]);
  });

  it("reports a refusal when every write is refused", async () => {
    const no = async () => {
      throw new DOMException("no", "NotAllowedError");
    };
    const { c } = clip({ write: vi.fn(no), writeText: vi.fn(no) });
    await expect(copyArriving(Promise.resolve("words"), { clipboard: c, Item })).resolves.toBe(
      "refused",
    );
  });

  it("reports a refusal where the page has no clipboard at all", async () => {
    await expect(copyArriving(Promise.resolve("words"), { clipboard: undefined })).resolves.toBe(
      "refused",
    );
    await expect(copyArriving(Promise.resolve(""), { clipboard: undefined })).resolves.toBe(
      "empty",
    );
  });
});

describe("copyNow", () => {
  it("writes the text, or says it did not land", async () => {
    const { c, written } = clip();
    await expect(copyNow("page text", { clipboard: c })).resolves.toBe(true);
    expect(written).toEqual(["page text"]);
    const refused = clip({
      writeText: vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      }),
    });
    await expect(copyNow("page text", { clipboard: refused.c })).resolves.toBe(false);
    await expect(copyNow("page text", { clipboard: undefined })).resolves.toBe(false);
  });
});

describe("readClipboard", () => {
  it("reads the text, or says it was refused", async () => {
    await expect(readClipboard({ clipboard: clip().c })).resolves.toEqual({
      text: "from the clipboard",
    });
    const refused = clip({
      readText: vi.fn(async () => {
        throw new DOMException("no", "NotAllowedError");
      }),
    });
    await expect(readClipboard({ clipboard: refused.c })).resolves.toEqual({ refused: true });
    await expect(readClipboard({ clipboard: undefined })).resolves.toEqual({ refused: true });
  });
});
