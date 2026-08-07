import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FileApiError,
  IMAGE_DECODE_MESSAGE,
  imageErrorMessage,
  listDir,
  listErrorMessage,
  readErrorMessage,
  readFile,
} from "../src/lib/file-api";

afterEach(() => vi.unstubAllGlobals());

/** A fetch stub returning a fixed response (mirrors file-api.write.test.ts). */
function stubFetch(
  resp: Partial<Response> & { status: number; ok: boolean },
): void {
  const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", (async () => {
    return { body: { cancel }, ...resp } as unknown as Response;
  }) as typeof fetch);
}

/** A non-OK response carrying file-api's plain-text error body (http.Error
 *  appends the trailing newline, so the stubs keep it). */
function stubError(status: number, body: string): void {
  vi.stubGlobal("fetch", (async () => {
    return {
      ok: false,
      status,
      headers: { get: () => null },
      text: async () => body,
      body: { cancel: async () => {} },
    } as unknown as Response;
  }) as typeof fetch);
}

/** A 200 text/plain response carrying `text`. */
function stubText(text: string, headers: Record<string, string> = {}): void {
  const h: Record<string, string> = { "content-type": "text/plain", ...headers };
  vi.stubGlobal("fetch", (async () => {
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
      text: async () => text,
      body: { cancel: async () => {} },
    } as unknown as Response;
  }) as typeof fetch);
}

// file-api returns 400 for THREE distinct read refusals — "invalid path"
// (outside home), "path must be absolute", and "path is a directory" /
// "not a regular file". The old single sentence claimed the last one for all of
// them, so /etc/passwd and a ../../etc/shadow traversal both read as a
// file-TYPE complaint instead of an out-of-scope one.
describe("readErrorMessage", () => {
  it("400 describes an out-of-scope/unreadable path, not a file type", () => {
    const m = readErrorMessage(400);
    expect(m).not.toMatch(/regular file/i);
    expect(m).toMatch(/outside|home|permission|can't open/i);
  });

  it("keeps the statuses that were already right", () => {
    expect(readErrorMessage(404)).toBe("File not found.");
    expect(readErrorMessage(413)).toMatch(/too large/i);
    expect(readErrorMessage(401)).toMatch(/not authorized/i);
    expect(readErrorMessage(403)).toMatch(/not authorized/i);
    expect(readErrorMessage(500)).toMatch(/HTTP 500/);
  });
});

// Of the four 400 read refusals, exactly ONE is safe to name: file-api answers
// "path is a directory" only after the path already resolved INSIDE the
// containment root, and /files/list will happily list that same directory one
// click away — so saying "folder" discloses nothing Browse doesn't. The other
// three ("invalid path" for out-of-home, "path must be absolute", "not a
// regular file") stay behind the deliberately vague sentence.
describe("readErrorMessage — the directory case is named, the rest stay vague", () => {
  it("a 'path is a directory' body says FOLDER and points at Browse", () => {
    const m = readErrorMessage(400, "path is a directory\n");
    expect(m).toMatch(/is a folder/i);
    expect(m).toMatch(/browse/i);
    expect(m).not.toMatch(/outside your home/i);
  });

  it("an out-of-home 400 keeps the vague sentence (both /etc and /etc/passwd)", () => {
    // Measured against file-api on the devvm: BOTH answer 400 "invalid path".
    expect(readErrorMessage(400, "invalid path\n")).toBe(readErrorMessage(400));
    expect(readErrorMessage(400, "invalid path\n")).toMatch(/outside your home/i);
    // "home folder" is in the vague sentence too — the discriminator is whether
    // the message asserts that THIS path is a folder.
    expect(readErrorMessage(400, "invalid path\n")).not.toMatch(/is a folder/i);
  });

  it("the other in-home 400 bodies stay vague too", () => {
    expect(readErrorMessage(400, "path must be absolute\n")).toBe(readErrorMessage(400));
    expect(readErrorMessage(400, "not a regular file\n")).toBe(readErrorMessage(400));
  });

  it("a body only ever refines 400 — other statuses ignore it", () => {
    expect(readErrorMessage(404, "path is a directory\n")).toBe("File not found.");
    expect(readErrorMessage(413, "path is a directory\n")).toMatch(/too large/i);
  });
});

describe("readFile — reads the 400 body so a directory is reported as one", () => {
  it("a directory answers with the folder message, not the containment one", async () => {
    stubError(400, "path is a directory\n");
    await expect(readFile("/home/u/proj/sub", "sub")).rejects.toMatchObject({
      name: "FileApiError",
      status: 400,
      message: expect.stringMatching(/is a folder/i),
    });
  });

  it("an out-of-home path still gets the deliberately vague message", async () => {
    stubError(400, "invalid path\n");
    await expect(readFile("/etc/passwd", "passwd")).rejects.toMatchObject({
      status: 400,
      message: readErrorMessage(400),
    });
    await expect(readFile("/etc/passwd", "passwd")).rejects.toMatchObject({
      message: expect.not.stringMatching(/is a folder/i),
    });
  });

  it("a 404 is untouched (the body is not consulted)", async () => {
    stubError(404, "not found\n");
    await expect(readFile("/home/u/gone.txt", "gone.txt")).rejects.toMatchObject({
      status: 404,
      message: "File not found.",
    });
  });

  // The message points at Browse, and Browse has to be able to act on it: the
  // store lists dirname(path) unless it knows the path IS the directory.
  it("flags the directory case on the error so Browse can list that path", async () => {
    stubError(400, "path is a directory\n");
    await expect(readFile("/home/u/proj/sub", "sub")).rejects.toMatchObject({
      isDirectory: true,
    });
  });

  it("leaves isDirectory false for every other refusal", async () => {
    stubError(400, "invalid path\n");
    await expect(readFile("/etc/passwd", "passwd")).rejects.toMatchObject({
      isDirectory: false,
    });
    stubError(404, "not found\n");
    await expect(readFile("/home/u/gone.txt", "gone.txt")).rejects.toMatchObject({
      isDirectory: false,
    });
  });
});

// A LISTING that 400s means "not a directory" / outside home / not absolute.
// Reusing the read table told the user their directory was "not a regular
// file", which is wrong on every count.
describe("listErrorMessage", () => {
  it("400 talks about folders/permission, never 'not a regular file'", () => {
    const m = listErrorMessage(400);
    expect(m).not.toMatch(/regular file/i);
    expect(m).toMatch(/folder|directory/i);
  });

  it("404 says the folder is missing, not the file", () => {
    expect(listErrorMessage(404)).toMatch(/folder|directory/i);
  });

  it("401/403 stay an authorization message; unknown statuses carry the code", () => {
    expect(listErrorMessage(403)).toMatch(/not authorized/i);
    expect(listErrorMessage(401)).toMatch(/not authorized/i);
    expect(listErrorMessage(500)).toMatch(/HTTP 500/);
  });
});

describe("listDir — uses the LIST vocabulary, not the read table", () => {
  it("a 400 from GET /files/list never says 'not a regular file'", async () => {
    stubFetch({ ok: false, status: 400 });
    try {
      await listDir("/home");
      throw new Error("expected listDir to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(FileApiError);
      const e = err as FileApiError;
      expect(e.status).toBe(400);
      expect(e.message).toBe(listErrorMessage(400));
      expect(e.message).not.toMatch(/regular file/i);
    }
  });

  it("a 404 from a listing reports a missing folder", async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(listDir("/home/u/gone")).rejects.toMatchObject({
      name: "FileApiError",
      status: 404,
      message: listErrorMessage(404),
    });
  });
});

// An image is classified by NAME and never fetched by readFile — the <img>
// element does the only round-trip — so the 404/413/400 vocabulary above was
// unreachable for images: a missing PNG, a 12MB PNG and a PNG outside the home
// root all read "Couldn't load image.", as if the bytes were corrupt. Measured
// on the devvm: nope.png → 404, huge.png → 413, /etc/ssl/certs/logo.png → 400,
// three identical sentences on screen. The 413 is the one that costs the user
// something: a perfectly readable file over the preview limit, with an
// actionable workaround, reported as damage.
describe("imageErrorMessage — resolves WHY an <img> failed", () => {
  it("says the same thing a text file would for 404 / 413 / 400", async () => {
    stubError(404, "not found\n");
    expect(await imageErrorMessage("/home/u/nope.png")).toBe(readErrorMessage(404));
    stubError(413, "file too large (max 10MB)\n");
    expect(await imageErrorMessage("/home/u/huge.png")).toBe(readErrorMessage(413));
    stubError(400, "invalid path\n");
    expect(await imageErrorMessage("/etc/ssl/certs/logo.png")).toBe(
      readErrorMessage(400),
    );
  });

  it("gives three DISTINCT messages for the three failures", async () => {
    stubError(404, "not found\n");
    const notFound = await imageErrorMessage("/home/u/nope.png");
    stubError(413, "file too large (max 10MB)\n");
    const tooBig = await imageErrorMessage("/home/u/huge.png");
    stubError(400, "invalid path\n");
    const outside = await imageErrorMessage("/etc/ssl/certs/logo.png");
    expect(new Set([notFound, tooBig, outside]).size).toBe(3);
    expect(tooBig).toMatch(/too large/i);
    expect(notFound).toMatch(/not found/i);
  });

  it("names a folder when the server says so (the read table's one exception)", async () => {
    stubError(400, "path is a directory\n");
    expect(await imageErrorMessage("/home/u/pics")).toMatch(/is a folder/i);
  });

  it("falls back to the decode message when the bytes ARE readable", async () => {
    // 200 + an <img> that still failed = a corrupt/unsupported image. That is
    // the one case the generic sentence actually describes.
    stubText("\x89PNG-ish", { "content-type": "image/png" });
    expect(await imageErrorMessage("/home/u/broken.png")).toBe(IMAGE_DECODE_MESSAGE);
  });

  it("falls back to the decode message when the probe itself fails", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    expect(await imageErrorMessage("/home/u/pic.png")).toBe(IMAGE_DECODE_MESSAGE);
  });

  it("costs exactly one request, and drains the body it does not need", async () => {
    const cancel = vi.fn(async () => {});
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => "",
      body: { cancel },
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    await imageErrorMessage("/home/u/nope.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

// The probe is an ERROR-path cost only. The happy path must stay exactly as it
// was: readFile classifies by name and returns without touching the network.
describe("readFile — a name-classified image still costs no request", () => {
  it("returns kind=image without calling fetch at all", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("readFile must not fetch a name-classified image");
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    await expect(readFile("/home/u/pic.png", "pic.png")).resolves.toEqual({
      kind: "image",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The size chip is a byte count. `text.length` is UTF-16 code units, so any
// non-ASCII file was reported short (59 bytes on disk → "45 B" on screen).
describe("readFile — size is a BYTE count", () => {
  it("reports UTF-8 bytes for a non-ASCII text file", async () => {
    const utf8 = "# héllo wörld — ünïcødé ✅\n\nnaïve café résumé\n";
    stubText(utf8);
    const f = await readFile("/home/u/utf8.md", "utf8.md");
    expect(f.text).toBe(utf8);
    expect(f.size).toBe(59);
  });

  it("reports 0 for an empty file (not null, not undefined)", async () => {
    stubText("");
    const f = await readFile("/home/u/empty.txt", "empty.txt");
    expect(f.size).toBe(0);
  });
});
