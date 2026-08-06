import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FileApiError,
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
